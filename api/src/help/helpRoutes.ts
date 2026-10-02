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
import { scrubSecrets } from "../translate/llm.ts";
import { getProviderConfig } from "../translate/providerCatalog.ts";
import {
  buildSystemPrompt,
  costMicros,
  describeProviderError,
  helpAdapterFor,
  maxOutputFor,
  HELP_TIMEOUT_MS,
  parseAnswer,
  withRouteContext,
  type HelpAdapter,
  type HelpAdapterDeps,
  type HelpMessage,
  type HelpUsage,
} from "./helpChat.ts";
import { capMicrosFromEnv, inputTokenBound, isMissingSchemaError, nextResetIso, remainingMicros, reserve, settle, utcDay, worstCaseMicros } from "./helpBudget.ts";

type HelpEnv = { Bindings: Env; Variables: { userId?: number; username?: string } };

export type HelpRouteDeps = {
  /** Test seam: replaces the real provider adapter. */
  adapterFor?: (provider: string, xaiBaseUrl: string | undefined) => HelpAdapter | null;
  adapterDeps?: HelpAdapterDeps;
  now?: () => Date;
};

const MAX_MESSAGES = 10;
// Users type short questions; assistant turns are echoed answers, which run longer.
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
    const max = want === "user" ? MAX_USER_CONTENT : MAX_ASSISTANT_CONTENT;
    if (typeof m.content !== "string" || m.content.trim() === "" || m.content.length > max) {
      return `message ${i + 1} content must be a non-empty string of at most ${max} characters`;
    }
    messages.push({ role: want, content: m.content });
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

/**
 * Charge for a failed provider call. Usage attached to the error (a billed 200
 * we could not use) settles the real cost. A 4xx other than 408 is a rejection
 * that did not bill. Anything else (timeout, network, 5xx, unparseable 200) may
 * have billed, so it is charged the full reservation.
 */
function failureCost(provider: string, err: unknown, worst: number): number {
  const u = (err as { usage?: HelpUsage } | null)?.usage;
  if (u && typeof u.inputTokens === "number" && typeof u.outputTokens === "number") return costMicros(provider, u);
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status <= 499 && status !== 408) return 0;
  return worst;
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
    const worst = worstCaseMicros(ai.provider, inputTokens, maxOutputFor(ai.provider));

    if (!(await reserve(db, userId, day, worst, cap))) {
      const left = await remainingMicros(db, userId, day, cap);
      return c.json({ code: "help_budget_exhausted", resetsAt: nextResetIso(when), remainingUsd: usdOf(left) }, 429);
    }

    // Provider call + settle run inside one promise handed to waitUntil, so a
    // client disconnect cannot cancel the settle. It never rejects.
    const work = (async (): Promise<{ status: 200 | 502; body: Record<string, unknown> }> => {
      let actual = worst;
      let answered = false;
      let outcome: { status: 200 | 502; body: Record<string, unknown> };
      let failure: { kind: string; message: string } | null = null;
      try {
        const result = await adapter({ model: catalog.lightModel!, system, messages, apiKey, timeoutMs: HELP_TIMEOUT_MS });
        const u = result.usage;
        if (u.inputTokens + u.outputTokens + u.cacheWriteTokens + u.cacheReadTokens === 0) {
          console.warn(`help ask (${ai.provider}): provider reported no usage; charging the worst case`);
          actual = worst;
        } else {
          actual = costMicros(ai.provider, u);
        }
        const { answer, articleIds: used } = parseAnswer(result.text, articleIds);
        console.log(`help ask ok (${ai.provider}): in=${u.inputTokens} out=${u.outputTokens} cacheW=${u.cacheWriteTokens} cacheR=${u.cacheReadTokens} micros=${actual}`);
        if (answer === "") {
          failure = { kind: "empty_answer", message: "provider returned an empty answer" };
          outcome = { status: 502, body: { code: "help_ai_failed", kind: "empty_answer" } };
        } else {
          answered = true;
          outcome = { status: 200, body: { answer, articleIds: used } };
        }
      } catch (err) {
        actual = failureCost(ai.provider, err, worst);
        failure = describeProviderError(err, apiKey);
        outcome = { status: 502, body: { code: "help_ai_failed", kind: failure.kind } };
      }
      let settled = false;
      let settleErr: unknown;
      for (let attempt = 0; attempt < 3 && !settled; attempt++) {
        try {
          await settle(db, userId, day, worst, actual, answered);
          settled = true;
        } catch (e) {
          settleErr = e;
        }
      }
      if (!settled) {
        const m = scrubSecrets(settleErr instanceof Error ? settleErr.message : String(settleErr), [apiKey]).slice(0, 300);
        console.error(`help budget settle failed after 3 attempts (user ${userId}, ${day}, reserved ${worst}, actual ${actual}): ${m}`);
      }
      if (failure) console.error(`help ask failed (${ai.provider}, ${failure.kind}): ${failure.message}`);
      if (outcome.status === 200) {
        try {
          outcome.body.remainingUsd = usdOf(await remainingMicros(db, userId, day, cap));
        } catch {
          outcome.body.remainingUsd = 0;
        }
      }
      return outcome;
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
