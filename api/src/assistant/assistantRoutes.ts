// POST /api/assistant/chat — the editing assistant (issue #858). One model call
// per user message returns a reply plus PROPOSED actions on the notes on screen;
// the server never writes notes, the browser previews and applies them.
// Same org AI key, light model and reserve-then-settle budget as the help
// assistant, with its own table, cap (ASSISTANT_DAILY_CAP_USD, default $7) and
// admin switch (migration 0084). GET /status feeds the UI; PUT /settings is
// the admin on/off switch (off by default).

import { Hono } from "hono";
import type { Env } from "../index";
import { requireAuth, requireAdmin, requireEditor, currentUserId } from "../auth.ts";
import { getAiProviderConfig, keyDecrypts, resolveDispatchAi } from "../aiProvider.ts";
import { decryptApiKey } from "../aiKeyCrypto.ts";
import { getProviderConfig } from "../translate/providerCatalog.ts";
import { helpAdapterFor, type HelpAdapter, type HelpAdapterDeps, type HelpMessage } from "../help/helpChat.ts";
import { capMicrosFromEnv, inputTokenBound, isMissingSchemaError, nextResetIso, remainingMicros, reserve, utcDay, worstCaseMicros } from "../help/helpBudget.ts";
import { runCappedCall } from "../help/cappedCall.ts";
import {
  assistantMaxOutputFor,
  ASSISTANT_TIMEOUT_MS,
  buildAssistantSystemPrompt,
  parseActions,
  withScreenContext,
  type AssistantActions,
  type AssistantContext,
  type AssistantNote,
} from "./assistantChat.ts";

type AssistantEnv = { Bindings: Env; Variables: { userId?: number; username?: string; role?: string } };

export type AssistantRouteDeps = {
  /** Test seam: replaces the real provider adapter. */
  adapterFor?: (provider: string, xaiBaseUrl: string | undefined) => HelpAdapter | null;
  adapterDeps?: HelpAdapterDeps;
  now?: () => Date;
};

const DEFAULT_CAP_USD = 7;
const MAX_MESSAGES = 10;
const MAX_USER_CONTENT = 2000;
const MAX_ASSISTANT_CONTENT = 8000;
const MAX_NOTES = 200;
const MAX_NOTE_CHARS = 6000;
const MAX_BODY_BYTES = 200 * 1024;

type Parsed = { lang: string; context: AssistantContext; messages: HelpMessage[] };

const optString = (v: unknown): v is string | null => v === null || typeof v === "string";

function parseNotes(raw: unknown): AssistantNote[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_NOTES) return `context.notes must hold 1-${MAX_NOTES} items`;
  const notes: AssistantNote[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i] as Record<string, unknown> | null;
    const at = `context.notes[${i}]`;
    if (!n || typeof n !== "object") return `${at} must be an object`;
    if (typeof n.id !== "string" || n.id === "" || n.id.length > 128) return `${at}.id must be a string of 1-128 characters`;
    if (ids.has(n.id)) return `${at}.id is a duplicate`;
    ids.add(n.id);
    if (typeof n.ref !== "string" || n.ref.length > 64) return `${at}.ref must be a string of at most 64 characters`;
    if (!optString(n.quote)) return `${at}.quote must be a string or null`;
    if (typeof n.note !== "string" || n.note.length > MAX_NOTE_CHARS) return `${at}.note must be a string of at most ${MAX_NOTE_CHARS} characters`;
    if (!optString(n.state)) return `${at}.state must be a string or null`;
    if (typeof n.checked !== "boolean") return `${at}.checked must be a boolean`;
    notes.push({
      id: n.id,
      ref: n.ref,
      // The quote is source-language text of a few words; bound it like a note.
      quote: n.quote === null ? null : n.quote.slice(0, MAX_NOTE_CHARS),
      note: n.note,
      state: n.state === null ? null : n.state.slice(0, 64),
      checked: n.checked,
    });
  }
  return notes;
}

function parseBody(body: unknown): Parsed | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.lang !== "string" || b.lang.length === 0 || b.lang.length > 16) return "lang must be a string of 1-16 characters";
  if (b.screen !== "rapid_check") return 'screen must be "rapid_check"';
  const ctx = b.context as Record<string, unknown> | null;
  if (!ctx || typeof ctx !== "object") return "context must be an object";
  if (typeof ctx.book !== "string" || ctx.book.length === 0 || ctx.book.length > 16) return "context.book must be a string of 1-16 characters";
  if (typeof ctx.chapter !== "number" || !Number.isInteger(ctx.chapter) || ctx.chapter < 0 || ctx.chapter > 999) return "context.chapter must be an integer";
  const notes = parseNotes(ctx.notes);
  if (typeof notes === "string") return notes;
  if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > MAX_MESSAGES) {
    return `messages must hold 1-${MAX_MESSAGES} items`;
  }
  const messages: HelpMessage[] = [];
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as Record<string, unknown> | null;
    const want = i % 2 === 0 ? "user" : "assistant";
    if (!m || typeof m !== "object" || m.role !== want) return `message ${i + 1} must have role "${want}" (roles alternate, starting with "user")`;
    if (typeof m.content !== "string" || m.content.trim() === "") return `message ${i + 1} content must be a non-empty string`;
    if (want === "user" && m.content.length > MAX_USER_CONTENT) return `message ${i + 1} content must be at most ${MAX_USER_CONTENT} characters`;
    messages.push({ role: want, content: want === "assistant" ? m.content.slice(0, MAX_ASSISTANT_CONTENT) : m.content });
  }
  if (messages[messages.length - 1].role !== "user") return 'the last message must have role "user"';
  return { lang: b.lang, context: { book: ctx.book, chapter: ctx.chapter, notes }, messages };
}

async function assistantEnabled(db: D1Database): Promise<boolean> {
  try {
    const r = await db.prepare("SELECT enabled FROM assistant_chat_settings WHERE id = 1").first<{ enabled: number }>();
    return r?.enabled === 1;
  } catch (e) {
    // Workspace not migrated yet: the assistant is simply off.
    if (isMissingSchemaError(e)) return false;
    throw e;
  }
}

const usdOf = (micros: number) => micros / 1_000_000;
const capOf = (env: Env) => capMicrosFromEnv(env.ASSISTANT_DAILY_CAP_USD, DEFAULT_CAP_USD);

/** What /chat reserves for a call with this many input tokens. */
const worstFor = (provider: string, inputTokens: number) =>
  worstCaseMicros(provider, inputTokens, assistantMaxOutputFor(provider));

/**
 * Input-token bound for the largest request /chat accepts (issue #864): the
 * system prompt, up to MAX_MESSAGES message texts, and at most MAX_BODY_BYTES
 * of text inside them, since the notes and messages are carried in a body of
 * at most that size and its JSON keys and escapes only add to it. The
 * screen-data wrapper is counted on top, so for any body the app sends this is
 * a few hundred tokens high. (A hand-built body whose quote or state is cut
 * mid-emoji grows by 2 bytes per cut field and could pass it by a fraction of
 * a cent; /chat still enforces the cap.)
 */
function largestRequestTokens(lang: string): number {
  const wrapper = withScreenContext([{ role: "user", content: "" }], { book: "", chapter: 0, notes: [] })[0].content;
  const texts = [buildAssistantSystemPrompt(lang), wrapper, ...Array<string>(MAX_MESSAGES - 1).fill("")];
  return inputTokenBound(texts) + MAX_BODY_BYTES;
}

export function makeAssistantRoutes(deps: AssistantRouteDeps = {}) {
  const app = new Hono<AssistantEnv>();
  const now = deps.now ?? (() => new Date());

  app.get("/status", requireAuth, async (c) => {
    const userId = currentUserId(c)!;
    const cap = capOf(c.env);
    const enabled = await assistantEnabled(c.env.DB);
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
      left = await remainingMicros(c.env.DB, userId, utcDay(now()), cap, "assistant_chat_usage");
    } catch (e) {
      if (!isMissingSchemaError(e)) throw e;
    }
    const keyUsable = ai.kind === "configured" && (await keyDecrypts(ai, c.env.AI_KEY_WRAPPING_KEY));
    let canAsk = false;
    if (enabled && ai.kind === "configured" && keyUsable && model) {
      // Send stays on only while the money left covers the largest request
      // /chat accepts (a full chapter), so it never offers a send that comes
      // back 429 (#864). Below that, report $0. Up to that amount of the day
      // goes unused on a small request (option A on the issue).
      canAsk = left >= worstFor(ai.provider, largestRequestTokens(c.req.query("lang") || "en"));
      if (!canAsk) left = 0;
    }
    const role = c.get("role");
    return c.json({
      enabled,
      configured: ai.kind === "configured",
      keyUsable,
      provider,
      model,
      capUsd: usdOf(cap),
      remainingUsd: usdOf(left),
      canAsk,
      canEdit: role === "editor" || role === "admin",
    });
  });

  app.post("/chat", requireEditor, async (c) => {
    const userId = currentUserId(c)!;
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return c.json({ code: "bad_request", detail: `body must be at most ${MAX_BODY_BYTES / 1024} KB` }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return c.json({ code: "bad_request", detail: "body must be valid JSON" }, 400);
    }
    const parsed = parseBody(raw);
    if (typeof parsed === "string") return c.json({ code: "bad_request", detail: parsed }, 400);

    const db = c.env.DB;
    if (!(await assistantEnabled(db))) return c.json({ code: "assistant_disabled" }, 403);

    const ai = resolveDispatchAi(await getAiProviderConfig(db), c.env.AI_KEY_WRAPPING_KEY);
    if (ai.kind === "error" && ai.reason === "ai_provider_not_configured") return c.json({ code: "assistant_not_configured" }, 409);
    if (ai.kind === "error") return c.json({ code: "assistant_unavailable", reason: ai.reason }, 409);

    let catalog;
    try {
      catalog = getProviderConfig(ai.provider);
    } catch {
      return c.json({ code: "assistant_unavailable", reason: "no_light_model" }, 409);
    }
    const adapter = deps.adapterFor
      ? deps.adapterFor(ai.provider, catalog.baseUrl)
      : helpAdapterFor(ai.provider, catalog.baseUrl, deps.adapterDeps);
    if (!catalog.lightModel || !adapter) return c.json({ code: "assistant_unavailable", reason: "no_light_model" }, 409);

    let apiKey: string;
    try {
      apiKey = await decryptApiKey(c.env.AI_KEY_WRAPPING_KEY!, ai.ciphertext, ai.iv);
    } catch {
      return c.json({ code: "assistant_unavailable", reason: "key_decrypt_failed" }, 409);
    }

    const system = buildAssistantSystemPrompt(parsed.lang);
    const messages = withScreenContext(parsed.messages, parsed.context);
    const maxOutput = assistantMaxOutputFor(ai.provider);
    const inputTokens = inputTokenBound([system, ...messages.map((m) => m.content)]);
    const cap = capOf(c.env);
    const when = now();
    const day = utcDay(when);
    const worst = worstFor(ai.provider, inputTokens);

    let reserved: boolean;
    try {
      reserved = await reserve(db, userId, day, worst, cap, "assistant_chat_usage");
    } catch (e) {
      if (isMissingSchemaError(e)) return c.json({ code: "assistant_unavailable", reason: "not_migrated" }, 409);
      throw e;
    }
    if (!reserved) {
      return c.json({ code: "assistant_budget_exhausted", resetsAt: nextResetIso(when), remainingUsd: 0 }, 429);
    }

    // Provider call + settle in one promise handed to waitUntil, as help does:
    // an unsettled reservation only blocks spend, until UTC midnight.
    const work = (async (): Promise<{ status: 200 | 502; body: Record<string, unknown> }> => {
      const out = await runCappedCall<{ reply: string; actions: AssistantActions }>({
        db,
        table: "assistant_chat_usage",
        userId,
        day,
        capMicros: cap,
        provider: ai.provider,
        adapter,
        request: { model: catalog.lightModel!, system, messages, apiKey, timeoutMs: ASSISTANT_TIMEOUT_MS, maxOutputTokens: maxOutput, json: true },
        worst,
        labels: { call: "assistant chat", budget: "assistant budget" },
        parse: (replyText, truncated) => {
          // Charged at real cost, but a cut-off action list is never returned.
          if (truncated) return { ok: false, kind: "truncated" };
          const p = parseActions(replyText, parsed.context);
          return p.ok ? { ok: true, body: { reply: p.reply, actions: p.actions } } : { ok: false, kind: p.kind };
        },
      });
      if (!out.ok) return { status: 502, body: { code: "assistant_failed", kind: out.kind } };
      return { status: 200, body: { reply: out.body.reply, actions: out.body.actions, remainingUsd: usdOf(out.remainingMicros) } };
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
    try {
      await c.env.DB
        .prepare(
          `INSERT INTO assistant_chat_settings (id, enabled, updated_at, updated_by) VALUES (1, ?1, unixepoch(), ?2)
           ON CONFLICT(id) DO UPDATE SET enabled = ?1, updated_at = unixepoch(), updated_by = ?2`,
        )
        .bind(enabled ? 1 : 0, currentUserId(c) ?? null)
        .run();
    } catch (e) {
      if (isMissingSchemaError(e)) return c.json({ code: "assistant_unavailable", reason: "not_migrated" }, 409);
      throw e;
    }
    return c.json({ enabled });
  });

  return app;
}

export const assistantRoutes = makeAssistantRoutes();
