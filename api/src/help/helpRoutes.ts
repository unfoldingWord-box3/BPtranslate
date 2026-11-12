// POST /api/help/ask — answers a question about the app from the written guide,
// using the org's own AI key and the light model of its configured provider.
// The per-user daily cap is reserved BEFORE the provider call (helpBudget.ts).
// GET /api/help/status feeds the UI's "show Ask AI?" decision; PUT
// /api/help/settings is the admin on/off switch (off by default, migration 0077).

import { Hono } from "hono";
import type { Env } from "../index";
import { requireAuth, requireAdmin, currentUserId } from "../auth.ts";
import { getAiProviderConfig, keyDecrypts, resolveDispatchAi } from "../aiProvider.ts";
import { decryptApiKey } from "../aiKeyCrypto.ts";
import { getProviderConfig } from "../translate/providerCatalog.ts";
import {
  buildSystemPrompt,
  helpAdapterFor,
  maxOutputFor,
  HELP_TIMEOUT_MS,
  parseAnswer,
  withRouteContext,
  type HelpAdapter,
  type HelpAdapterDeps,
  type HelpMessage,
} from "./helpChat.ts";
import { capMicrosFromEnv, inputTokenBound, isMissingSchemaError, nextResetIso, remainingMicros, reserve, utcDay, worstCaseMicros } from "./helpBudget.ts";
import { runCappedCall } from "./cappedCall.ts";

type HelpEnv = { Bindings: Env; Variables: { userId?: number; username?: string } };

export type HelpRouteDeps = {
  /** Test seam: replaces the real provider adapter. */
  adapterFor?: (provider: string, xaiBaseUrl: string | undefined) => HelpAdapter | null;
  adapterDeps?: HelpAdapterDeps;
  now?: () => Date;
};

const MAX_MESSAGES = 10;
// Users type short questions; assistant turns are echoed answers, which run
// longer and are truncated to MAX_ASSISTANT_CONTENT (it also bounds the reservation).
const MAX_USER_CONTENT = 2000;
const MAX_ASSISTANT_CONTENT = 8000;

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
    if (typeof m.content !== "string" || m.content.trim() === "") return `message ${i + 1} content must be a non-empty string`;
    if (want === "user" && m.content.length > MAX_USER_CONTENT) {
      return `message ${i + 1} content must be at most ${MAX_USER_CONTENT} characters`;
    }
    // An earlier answer echoed back can run long (Arabic at full max output):
    // truncate it rather than refuse the follow-up.
    messages.push({ role: want, content: want === "assistant" ? m.content.slice(0, MAX_ASSISTANT_CONTENT) : m.content });
  }
  if (messages[messages.length - 1].role !== "user") return 'the last message must have role "user"';
  return { lang: b.lang, route: b.route, messages };
}

async function helpEnabled(db: D1Database): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT enabled FROM help_chat_settings WHERE id = 1").first<{ enabled: number }>();
    return r?.enabled === 1;
  } catch (e) {
    // Workspace not migrated yet: the assistant is simply off.
    if (isMissingSchemaError(e)) return false;
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
    let left = cap;
    try {
      left = await remainingMicros(c.env.DB, userId, utcDay(now()), cap);
    } catch (e) {
      if (!isMissingSchemaError(e)) throw e;
    }
    // Below the reservation of the shortest possible question, /ask can only 429:
    // report $0 and let the UI disable Ask instead of showing "$0.06 left".
    // A saved key that no longer decrypts (wrapping key rotated) makes every
    // /ask a 409 key_decrypt_failed: report it, and don't offer Ask.
    const keyUsable = ai.kind === "configured" && (await keyDecrypts(ai, c.env.AI_KEY_WRAPPING_KEY));
    let canAsk = false;
    if (enabled && ai.kind === "configured" && keyUsable && model) {
      const { system } = buildSystemPrompt(c.req.query("lang") || "en");
      const minimal = withRouteContext([{ role: "user", content: "?" }], "")[0].content;
      canAsk = left >= worstCaseMicros(ai.provider, inputTokenBound([system, minimal]), maxOutputFor(ai.provider));
      if (!canAsk) left = 0;
    }
    return c.json({
      enabled,
      configured: ai.kind === "configured",
      provider,
      model,
      capUsd: usdOf(cap),
      remainingUsd: usdOf(left),
      canAsk,
      keyUsable,
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
    // No org key (#551 removed the shared-account fallback, so this is an "error" kind now).
    if (ai.kind === "error" && ai.reason === "ai_provider_not_configured") return c.json({ code: "help_ai_not_configured" }, 409);
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
    const worst = worstCaseMicros(ai.provider, inputTokens, maxOutputFor(ai.provider));

    let reserved: boolean;
    try {
      reserved = await reserve(db, userId, day, worst, cap);
    } catch (e) {
      // help_chat_settings exists but help_chat_usage does not: partly migrated.
      if (isMissingSchemaError(e)) return c.json({ code: "help_ai_unavailable", reason: "not_migrated" }, 409);
      throw e;
    }
    if (!reserved) {
      // What is left is below one more question's worst case, so report it as used up.
      return c.json({ code: "help_budget_exhausted", resetsAt: nextResetIso(when), remainingUsd: 0 }, 429);
    }

    // Provider call + settle run inside one promise handed to waitUntil, which
    // keeps the settle running after a client disconnect for as long as the
    // platform allows (~30 s). An unsettled reservation only blocks spend (it
    // never allows more) until UTC midnight. It never rejects.
    const work = (async (): Promise<{ status: 200 | 502; body: Record<string, unknown> }> => {
      const out = await runCappedCall<{ answer: string; articleIds: string[] }>({
        db,
        table: "help_chat_usage",
        userId,
        day,
        capMicros: cap,
        provider: ai.provider,
        adapter,
        request: { model: catalog.lightModel!, system, messages, apiKey, timeoutMs: HELP_TIMEOUT_MS },
        worst,
        labels: { call: "help ask", budget: "help budget" },
        parse: (text) => {
          const p = parseAnswer(text, articleIds);
          return p.answer === "" ? { ok: false, kind: "empty_answer" } : { ok: true, body: p };
        },
      });
      if (!out.ok) return { status: 502, body: { code: "help_ai_failed", kind: out.kind } };
      return { status: 200, body: { answer: out.body.answer, articleIds: out.body.articleIds, remainingUsd: usdOf(out.remainingMicros) } };
    })();
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      // No ExecutionContext (unit tests): awaiting below is all there is.
    }
    const out = await work;
    return c.json(out.body, out.status);
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
    // Own table: nothing here touches ai_provider_config's version counter.
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO help_chat_settings (id, enabled, updated_at, updated_by) VALUES (1, ?1, unixepoch(), ?2)
           ON CONFLICT(id) DO UPDATE SET enabled = ?1, updated_at = unixepoch(), updated_by = ?2`,
        )
        .bind(enabled ? 1 : 0, currentUserId(c) ?? null)
        .run();
    } catch (e) {
      if (isMissingSchemaError(e)) return c.json({ code: "help_ai_unavailable", reason: "not_migrated" }, 409);
      throw e;
    }
    return c.json({ enabled });
  });

  return app;
}

export const helpRoutes = makeHelpRoutes();
