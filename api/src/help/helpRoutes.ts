// POST /api/help/ask — answers a question about the app from the written guide,
// using the org's own AI key and the light model of its configured provider.
// The per-user daily cap is reserved BEFORE the provider call (helpBudget.ts).
// GET /api/help/status feeds the UI's "show Ask AI?" decision; PUT
// /api/help/settings is the admin on/off switch (off by default, migration 0074).

import { Hono } from "hono";
import type { Env } from "../index";
import { requireAuth, requireAdmin, currentUserId } from "../auth.ts";
import { getAiProviderConfig, resolveDispatchAi } from "../aiProvider.ts";
import { decryptApiKey } from "../aiKeyCrypto.ts";
import { getProviderConfig } from "../translate/providerCatalog.ts";
import {
  buildSystemPrompt,
  costMicros,
  describeProviderError,
  helpAdapterFor,
  HELP_MAX_OUTPUT_TOKENS,
  HELP_TIMEOUT_MS,
  parseAnswer,
  withRouteContext,
  type HelpAdapter,
  type HelpAdapterDeps,
  type HelpMessage,
} from "./helpChat.ts";
import { capMicrosFromEnv, inputTokenBound, nextResetIso, remainingMicros, reserve, settle, utcDay, worstCaseMicros } from "./helpBudget.ts";

type HelpEnv = { Bindings: Env; Variables: { userId?: number; username?: string } };

export type HelpRouteDeps = {
  /** Test seam: replaces the real provider adapter. */
  adapterFor?: (provider: string, xaiBaseUrl: string | undefined) => HelpAdapter | null;
  adapterDeps?: HelpAdapterDeps;
  now?: () => Date;
};

const MAX_MESSAGES = 10;
const MAX_CONTENT = 2000;

type Parsed = { lang: string; route: string; messages: HelpMessage[] };

function parseBody(body: unknown): Parsed | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.lang !== "string" || b.lang.length === 0 || b.lang.length > 16) return "lang must be a string of 1-16 characters";
  if (typeof b.route !== "string" || b.route.length > 64) return "route must be a string of at most 64 characters";
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > MAX_MESSAGES) {
    return `messages must hold 1-${MAX_MESSAGES} items`;
  }
  const messages: HelpMessage[] = [];
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as Record<string, unknown> | null;
    const want = i % 2 === 0 ? "user" : "assistant";
    if (!m || typeof m !== "object" || m.role !== want) return `message ${i + 1} must have role "${want}" (roles alternate, starting with "user")`;
    if (typeof m.content !== "string" || m.content.trim() === "" || m.content.length > MAX_CONTENT) {
      return `message ${i + 1} content must be a non-empty string of at most ${MAX_CONTENT} characters`;
    }
    messages.push({ role: want, content: m.content });
  }
  if (messages[messages.length - 1].role !== "user") return 'the last message must have role "user"';
  return { lang: b.lang, route: b.route, messages };
}

async function helpEnabled(db: D1Database): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT help_chat_enabled FROM ai_provider_config WHERE id = 1").first<{ help_chat_enabled: number }>();
    return r?.help_chat_enabled === 1;
  } catch (e) {
    // Workspace not migrated yet: the assistant is simply off.
    if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) return false;
    throw e;
  }
}

const usdOf = (micros: number) => micros / 1_000_000;

export function makeHelpRoutes(deps: HelpRouteDeps = {}) {
  const app = new Hono<HelpEnv>();
  const now = deps.now ?? (() => new Date());

  app.get("/status", requireAuth, async (c) => {
    const userId = currentUserId(c)!;
    const cap = capMicrosFromEnv(c.env.HELP_CHAT_DAILY_CAP_USD);
    const enabled = await helpEnabled(c.env.DB);
    const ai = resolveDispatchAi(await getAiProviderConfig(c.env.DB), c.env.AI_KEY_WRAPPING_KEY);
    let provider: string | null = null;
    let model: string | null = null;
    if (ai.kind === "configured") {
      provider = ai.provider;
      try {
        model = getProviderConfig(ai.provider).lightModel;
      } catch {
        model = null;
      }
    }
    const left = await remainingMicros(c.env.DB, userId, utcDay(now()), cap);
    return c.json({
      enabled,
      configured: ai.kind === "configured",
      provider,
      model,
      capUsd: usdOf(cap),
      remainingUsd: usdOf(left),
    });
  });

  app.post("/ask", requireAuth, async (c) => {
    const userId = currentUserId(c)!;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ code: "bad_request", detail: "body must be valid JSON" }, 400);
    }
    const parsed = parseBody(raw);
    if (typeof parsed === "string") return c.json({ code: "bad_request", detail: parsed }, 400);

    const db = c.env.DB;
    if (!(await helpEnabled(db))) return c.json({ code: "help_ai_disabled" }, 403);

    const ai = resolveDispatchAi(await getAiProviderConfig(db), c.env.AI_KEY_WRAPPING_KEY);
    if (ai.kind === "none") return c.json({ code: "help_ai_not_configured" }, 409);
    if (ai.kind === "error") return c.json({ code: "help_ai_unavailable", reason: ai.reason }, 409);

    let catalog;
    try {
      catalog = getProviderConfig(ai.provider);
    } catch {
      return c.json({ code: "help_ai_unavailable", reason: "no_light_model" }, 409);
    }
    const adapter = deps.adapterFor
      ? deps.adapterFor(ai.provider, catalog.baseUrl)
      : helpAdapterFor(ai.provider, catalog.baseUrl, deps.adapterDeps);
    if (!catalog.lightModel || !adapter) return c.json({ code: "help_ai_unavailable", reason: "no_light_model" }, 409);

    let apiKey: string;
    try {
      apiKey = await decryptApiKey(c.env.AI_KEY_WRAPPING_KEY!, ai.ciphertext, ai.iv);
    } catch {
      return c.json({ code: "help_ai_unavailable", reason: "key_decrypt_failed" }, 409);
    }

    const { system, articleIds } = buildSystemPrompt(parsed.lang);
    const messages = withRouteContext(parsed.messages, parsed.route);
    const inputTokens = inputTokenBound([system, ...messages.map((m) => m.content)]);
    const cap = capMicrosFromEnv(c.env.HELP_CHAT_DAILY_CAP_USD);
    const when = now();
    const day = utcDay(when);
    const worst = worstCaseMicros(ai.provider, inputTokens, HELP_MAX_OUTPUT_TOKENS);

    if (!(await reserve(db, userId, day, worst, cap))) {
      const left = await remainingMicros(db, userId, day, cap);
      return c.json({ code: "help_budget_exhausted", resetsAt: nextResetIso(when), remainingUsd: usdOf(left) }, 429);
    }

    let actual = 0;
    let settled = false;
    // Idempotent: runs once on whichever path is taken.
    const settleOnce = async () => {
      if (settled) return;
      settled = true;
      try {
        await settle(db, userId, day, worst, actual);
      } catch (e) {
        console.error(`help budget settle failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    try {
      const result = await adapter({ model: catalog.lightModel, system, messages, apiKey, timeoutMs: HELP_TIMEOUT_MS });
      actual = costMicros(ai.provider, result.usage);
      const { answer, articleIds: used } = parseAnswer(result.text, articleIds);
      await settleOnce();
      const left = await remainingMicros(db, userId, day, cap);
      return c.json({ answer, articleIds: used, remainingUsd: usdOf(left), usage: result.usage });
    } catch (err) {
      await settleOnce();
      const d = describeProviderError(err, apiKey);
      console.error(`help ask failed (${ai.provider}, ${d.kind}): ${d.message}`);
      return c.json({ code: "help_ai_failed", kind: d.kind }, 502);
    }
  });

  app.put("/settings", requireAdmin, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_request", detail: "body must be valid JSON" }, 400);
    }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") return c.json({ code: "bad_request", detail: "enabled must be a boolean" }, 400);
    // Does not touch `version`: that is the provider config's If-Match counter.
    await c.env.DB
      .prepare(
        `INSERT INTO ai_provider_config (id, provider, help_chat_enabled) VALUES (1, 'default', ?1)
         ON CONFLICT(id) DO UPDATE SET help_chat_enabled = ?1`,
      )
      .bind(enabled ? 1 : 0)
      .run();
    return c.json({ enabled });
  });

  return app;
}

export const helpRoutes = makeHelpRoutes();
