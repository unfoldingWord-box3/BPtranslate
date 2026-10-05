// Per-organization AI provider config (migration 0066): which model drafts this
// org's AI output, and this org's own API key. Translate jobs run on this key
// or not at all (#551): there is no shared unfoldingWord account to fall back
// to, so usage bills to the org.
//
// The key is write-only across the API boundary. It arrives once in a PUT body,
// is encrypted immediately (aiKeyCrypto.ts), and only ever leaves as a 4-char
// hint. Nothing here serializes a row directly — `publicShape` is the single
// serializer, so ciphertext and IV have no reachable path into a response.
//
// Catalog constants, the row reader, and the dispatch resolver live in this
// module (not pipelines.ts) because pipelines.ts's extensionless imports don't
// resolve under the node strip-types test runner — same split as
// translateOptions.ts. Hence the .ts-suffixed imports below.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAdmin, currentUserId } from "./auth.ts";
import { parseIfMatch } from "./translationMemoryLib.ts";
import { wrappingKeyAvailable, encryptApiKey } from "./aiKeyCrypto.ts";

// 'default' = no org key configured (what Clear leaves behind); translate jobs
// refuse to run in that state (#551). The rest are bring-your-own-key
// providers. Served to the client so the picker can't drift from the server's
// validation.
export const AI_PROVIDERS = ["default", "claude", "openai", "gemini", "xai"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

// Allowed models per BYO provider; first entry is what the UI suggests. A model
// outside this list is rejected rather than passed through — an unknown model id
// fails at dispatch time, far from the admin who typed it.
export const PROVIDER_MODELS: Record<Exclude<AiProvider, "default">, readonly string[]> = {
  claude: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
  openai: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
  gemini: ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro-preview"],
  xai: ["grok-4.5", "grok-4.3"],
};

export type AiProviderRow = {
  id: number;
  provider: string;
  model: string | null;
  key_ciphertext: string | null;
  key_iv: string | null;
  key_hint: string | null;
  version: number;
  updated_at: number;
  updated_by: number | null;
};

const SELECT_ROW = `SELECT id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at, updated_by
                      FROM ai_provider_config WHERE id = 1`;

// Read the singleton. An unmigrated workspace DB degrades to "no provider
// configured" (same as provider='default') instead of 500ing every AI dispatch —
// same narrow table-missing tolerance as getBookSourceRanges. Any other read
// error rethrows so a real failure isn't silently read as "no key configured".
export async function getAiProviderConfig(db: D1Database): Promise<AiProviderRow | null> {
  try {
    return (await db.prepare(SELECT_ROW).first<AiProviderRow>()) ?? null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      console.warn("ai_provider_config missing (workspace not migrated); treating as no AI key configured");
      return null;
    }
    throw e;
  }
}

// What dispatch should do with the stored config. There is no third "use the
// shared account" outcome: that fallback was removed in #551, so every AI run
// for an org bills to the org's own key.
//   error      — the job must not run. Either no key is configured at all
//                (`ai_provider_not_configured`: row absent or provider=default),
//                or a BYO provider is configured but unusable. The caller fails
//                loudly; it never falls back to another account.
//   configured — decrypt `ciphertext`/`iv` and call `provider` with `model`
export type DispatchAi =
  | {
      kind: "error";
      reason: "ai_provider_not_configured" | "ai_key_encryption_unavailable" | "api_key_missing" | "model_missing";
    }
  | { kind: "configured"; provider: string; model: string | null; ciphertext: string; iv: string };

export function resolveDispatchAi(row: AiProviderRow | null, wrappingKeySecret: string | undefined): DispatchAi {
  if (!row || row.provider === "default") return { kind: "error", reason: "ai_provider_not_configured" };
  if (!row.key_ciphertext || !row.key_iv) return { kind: "error", reason: "api_key_missing" };
  if (!row.model) return { kind: "error", reason: "model_missing" };
  if (!wrappingKeyAvailable(wrappingKeySecret)) return { kind: "error", reason: "ai_key_encryption_unavailable" };
  return {
    kind: "configured",
    provider: row.provider,
    model: row.model,
    ciphertext: row.key_ciphertext,
    iv: row.key_iv,
  };
}

// Last-resort redaction for text that may have had a decrypted key interpolated
// into it (an upstream provider echoing the key back in an error body, say).
// Belt to the braces of never logging plaintext in the first place.
export function scrubSecret(text: string, secret: string): string {
  if (!secret) return text; // split("") would explode the string into characters
  return text.split(secret).join("[redacted]");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type AiProviderEnv = { Bindings: Env; Variables: { userId?: number; username?: string } };

export const aiProvider = new Hono<AiProviderEnv>();

const CATALOG = { providers: AI_PROVIDERS, models: PROVIDER_MODELS };

// THE single serializer for this table. Field-by-field on purpose — spreading
// the row here is how key_ciphertext / key_iv would reach a client.
function publicShape(row: AiProviderRow | null, encryptionAvailable: boolean) {
  return {
    provider: row?.provider ?? "default",
    model: row?.model ?? null,
    // "an org key is stored and in force" — a default-provider row never counts,
    // even in the impossible case of leftover key columns.
    configured: !!row && row.provider !== "default" && !!row.key_ciphertext,
    keyHint: row?.key_hint ?? null,
    // version 0 = never written, so the client's first PUT sends If-Match: 0.
    version: row?.version ?? 0,
    encryptionAvailable,
    catalog: CATALOG,
  };
}

aiProvider.get("/", requireAdmin, async (c) => {
  const row = await getAiProviderConfig(c.env.DB);
  return c.json(publicShape(row, wrappingKeyAvailable(c.env.AI_KEY_WRAPPING_KEY)));
});

const PutBody = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    model: z.string().min(1).max(100).optional(),
    // Plaintext lives in this field and nowhere else. Bounds are sanity limits:
    // no real provider key is under 8 or over 512 chars.
    apiKey: z.string().min(8).max(512).optional(),
  })
  .strict();

type KeyCols = { ciphertext: string | null; iv: string | null; hint: string | null };

const NO_KEY: KeyCols = { ciphertext: null, iv: null, hint: null };

// Shared CAS write for PUT and DELETE. Mechanics copied from
// translationMemory.ts's PUT /prefs: first write is INSERT ... ON CONFLICT DO
// NOTHING (so a lost race reports the winner as a 409 rather than clobbering
// it), thereafter UPDATE guarded on the expected version. Deliberately does NOT
// queue a context export — provider config is not part of the context pack.
// Reads degrade a missing table to "no provider" (getAiProviderConfig), so a
// write on an unmigrated workspace DB would otherwise reach the INSERT below and
// surface as an opaque 500. An admin configuring a provider deserves the real
// cause: the workspace DB is behind on migrations.
function notMigrated(e: unknown): boolean {
  return /no such table/i.test(e instanceof Error ? e.message : String(e));
}

async function applyWrite(
  c: Context<AiProviderEnv>,
  existing: AiProviderRow | null,
  expected: number,
  provider: AiProvider,
  model: string | null,
  key: KeyCols,
) {
  try {
    return await applyWriteInner(c, existing, expected, provider, model, key);
  } catch (e) {
    if (notMigrated(e)) {
      console.warn("ai_provider_config missing (workspace not migrated); write rejected");
      return c.json({ error: "ai_provider_not_migrated" }, 503);
    }
    throw e;
  }
}

async function applyWriteInner(
  c: Context<AiProviderEnv>,
  existing: AiProviderRow | null,
  expected: number,
  provider: AiProvider,
  model: string | null,
  key: KeyCols,
) {
  const encryptionAvailable = wrappingKeyAvailable(c.env.AI_KEY_WRAPPING_KEY);
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);

  if (!existing) {
    if (expected !== 0) return c.json({ error: "version_mismatch", current: publicShape(null, encryptionAvailable) }, 409);
    const ins = await c.env.DB.prepare(
      `INSERT INTO ai_provider_config
         (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(provider, model, key.ciphertext, key.iv, key.hint, now, userId ?? null)
      .run();
    if (!ins.meta.changes) {
      const winner = await c.env.DB.prepare(SELECT_ROW).first<AiProviderRow>();
      return c.json({ error: "version_mismatch", current: publicShape(winner ?? null, encryptionAvailable) }, 409);
    }
    const row = await c.env.DB.prepare(SELECT_ROW).first<AiProviderRow>();
    return c.json(publicShape(row ?? null, encryptionAvailable));
  }

  const res = await c.env.DB.prepare(
    `UPDATE ai_provider_config
        SET provider = ?1, model = ?2, key_ciphertext = ?3, key_iv = ?4, key_hint = ?5,
            version = version + 1, updated_at = ?6, updated_by = ?7
      WHERE id = 1 AND version = ?8`,
  )
    .bind(provider, model, key.ciphertext, key.iv, key.hint, now, userId ?? null, expected)
    .run();
  if (!res.meta.changes) {
    return c.json({ error: "version_mismatch", current: publicShape(existing, encryptionAvailable) }, 409);
  }
  const row = await c.env.DB.prepare(SELECT_ROW).first<AiProviderRow>();
  return c.json(publicShape(row ?? null, encryptionAvailable));
}

aiProvider.put("/", requireAdmin, async (c) => {
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const { provider, model, apiKey } = parsed.data;

  // provider='default' IS the Clear action: no model, no key, so translate jobs
  // stop until a new key is entered (#551). A model or key alongside it is a
  // confused client, not a partial intent to honor.
  if (provider === "default") {
    if (model !== undefined || apiKey !== undefined) return c.json({ error: "unexpected_fields" }, 400);
    const existing = await getAiProviderConfig(c.env.DB);
    return applyWrite(c, existing, expected, "default", null, NO_KEY);
  }

  if (model === undefined) return c.json({ error: "model_required" }, 400);
  if (!PROVIDER_MODELS[provider].includes(model)) {
    return c.json({ error: "unknown_model", models: PROVIDER_MODELS[provider] }, 400);
  }

  const existing = await getAiProviderConfig(c.env.DB);
  let key: KeyCols;
  if (apiKey !== undefined) {
    if (!wrappingKeyAvailable(c.env.AI_KEY_WRAPPING_KEY)) {
      return c.json({ error: "ai_key_encryption_unavailable" }, 503);
    }
    const { ciphertextB64, ivB64 } = await encryptApiKey(c.env.AI_KEY_WRAPPING_KEY!, apiKey);
    key = { ciphertext: ciphertextB64, iv: ivB64, hint: apiKey.slice(-4) };
  } else if (existing?.key_ciphertext && existing.provider === provider) {
    // Model-only edit: keep the stored key untouched (it never left the server,
    // so the client can't resend it). Requiring the SAME provider is the point —
    // an OpenAI key is meaningless to Gemini, and silently carrying it over
    // would leave the org "configured" with a credential that can't work.
    key = { ciphertext: existing.key_ciphertext, iv: existing.key_iv, hint: existing.key_hint };
  } else {
    return c.json({ error: "api_key_required" }, 400);
  }

  return applyWrite(c, existing, expected, provider, model, key);
});

// DELETE = PUT provider:'default'. Keeps the row so `version` stays monotonic.
aiProvider.delete("/", requireAdmin, async (c) => {
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  const existing = await getAiProviderConfig(c.env.DB);
  return applyWrite(c, existing, expected, "default", null, NO_KEY);
});
