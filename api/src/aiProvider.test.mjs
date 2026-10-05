// Unit tests for aiProvider.ts — the per-org AI provider config API (migration
// 0066). Harness mirrors adminUsers.test.mjs: a real Hono app wired the way the
// real app wires it (attachAuth + requireCsrf), jose-signed JWT cookies per
// role, and a REAL node:sqlite database behind a D1-shaped adapter. Real SQLite
// matters here for the same reason it does there — the If-Match CAS is an
// INSERT ... ON CONFLICT DO NOTHING / version-guarded UPDATE pair, and a fake
// statement dispatcher can't exercise either.
//
// The load-bearing assertions are the REDACTION ones: no response body, on any
// path, may contain the plaintext key or its stored ciphertext.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aiProvider.test.mjs

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { aiProvider, getAiProviderConfig, resolveDispatchAi, scrubSecret, PROVIDER_MODELS } from "./aiProvider.ts";

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";
const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const PLAINTEXT_KEY = "sk-ant-api03-notarealkey-000000wxyz";

// ── D1 adapter over node:sqlite (same shape as adminUsers.test.mjs) ──────────

// Inlined 0066_ai_provider.sql. Kept in sync by hand: a drift here shows up as
// a failing CAS or NOT NULL assertion below, not as a silent pass.
function freshDb({ withTable = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, dcs_username TEXT);`);
  if (withTable) {
    db.exec(`
      CREATE TABLE ai_provider_config (
        id             INTEGER PRIMARY KEY CHECK (id = 1),
        provider       TEXT NOT NULL DEFAULT 'default',
        model          TEXT,
        key_ciphertext TEXT,
        key_iv         TEXT,
        key_hint       TEXT,
        version        INTEGER NOT NULL DEFAULT 1,
        updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_by     INTEGER REFERENCES users(id)
      );
    `);
  }
  return db;
}

function makeD1(db) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => bound(sql, params), ...bound(sql, []) };
    },
  };
}

// `wrappingKey` is read with `in` rather than a default parameter so a test can
// pass an EXPLICIT undefined to model the secret being unset.
function baseEnv(db, opts = {}) {
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    AI_KEY_WRAPPING_KEY: "wrappingKey" in opts ? opts.wrappingKey : WRAPPING_KEY,
    DB: makeD1(db),
  };
}

async function makeToken({ sub = "1", role = "admin", username = "ada" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.route("/api/ai-provider", aiProvider);
  return app;
}

const PATH = "/api/ai-provider";

// Fires a request with the auth cookie and (for writes) the CSRF pair wired.
function req(app, env, method, { token, body, ifMatch } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET") {
    cookies.push("be_csrf=tok123");
    headers["x-csrf-token"] = "tok123";
  }
  if (cookies.length) headers.cookie = cookies.join("; ");
  if (ifMatch !== undefined) headers["if-match"] = String(ifMatch);
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(PATH, init, env);
}

const storedRow = (db) => db.prepare("SELECT * FROM ai_provider_config WHERE id = 1").get() ?? null;

const app = buildApp();
const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
const editorTok = await makeToken({ role: "editor", sub: "2", username: "eddie" });

// ── Auth gating ─────────────────────────────────────────────────────────────

await t("GET/PUT/DELETE are admin-only (401 anon, 403 editor)", async () => {
  const env = () => baseEnv(freshDb());
  assert.equal((await req(app, env(), "GET")).status, 401, "GET no cookie → 401");
  assert.equal((await req(app, env(), "GET", { token: editorTok })).status, 403, "GET editor → 403");
  assert.equal(
    (await req(app, env(), "PUT", { token: editorTok, ifMatch: 0, body: { provider: "default" } })).status,
    403,
    "PUT editor → 403",
  );
  assert.equal((await req(app, env(), "DELETE", { token: editorTok, ifMatch: 0 })).status, 403, "DELETE editor → 403");
});

// ── GET on a never-written row ──────────────────────────────────────────────

await t("GET with no row → default shape at version 0 (so the first PUT sends If-Match: 0)", async () => {
  const res = await req(app, baseEnv(freshDb()), "GET", { token: adminTok });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, "default");
  assert.equal(body.model, null);
  assert.equal(body.configured, false);
  assert.equal(body.keyHint, null);
  assert.equal(body.version, 0);
  assert.equal(body.encryptionAvailable, true);
  assert.deepEqual(body.catalog.models.claude, PROVIDER_MODELS.claude, "catalog is served to the client");
  assert.ok(body.catalog.providers.includes("xai"));
});

// ── If-Match CAS ────────────────────────────────────────────────────────────

await t("PUT without If-Match → 428", async () => {
  const res = await req(app, baseEnv(freshDb()), "PUT", { token: adminTok, body: { provider: "default" } });
  assert.equal(res.status, 428);
  assert.equal((await res.json()).error, "if_match_required");
});

await t("DELETE without If-Match → 428", async () => {
  const res = await req(app, baseEnv(freshDb()), "DELETE", { token: adminTok });
  assert.equal(res.status, 428);
});

await t("first write at If-Match 0 → 200 version 1; a wrong If-Match on an absent row → 409", async () => {
  const db = freshDb();
  const env = baseEnv(db);
  const stale = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 3,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(stale.status, 409, "If-Match 3 against no row → 409");
  assert.equal((await stale.json()).current.version, 0);
  assert.equal(storedRow(db), null, "nothing written on the rejected CAS");

  const ok = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.version, 1);
  assert.equal(body.provider, "claude");
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.configured, true);
  assert.equal(storedRow(db).updated_by, 1, "updated_by stamped from the caller's JWT sub");
});

// ── Redaction: the whole point of the write-only design ─────────────────────

await t("REDACTION: neither the plaintext key nor its ciphertext appears in a GET, a PUT, or a 409 body", async () => {
  const db = freshDb();
  const env = baseEnv(db);
  const put = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "openai", model: "gpt-5.6-terra", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(put.status, 200);
  const putText = JSON.stringify(await put.json());

  const row = storedRow(db);
  assert.ok(row.key_ciphertext && row.key_iv, "ciphertext + IV persisted");
  assert.notEqual(row.key_ciphertext, PLAINTEXT_KEY, "the column holds ciphertext, not the key");
  assert.ok(!row.key_ciphertext.includes(PLAINTEXT_KEY));

  const get = await req(app, env, "GET", { token: adminTok });
  const getBody = await get.json();
  const getText = JSON.stringify(getBody);

  // A stale write, to catch the 409 `current` payload too.
  const conflict = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "openai", model: "gpt-5.6-sol", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error, "version_mismatch");
  assert.equal(conflictBody.current.version, 1);
  const conflictText = JSON.stringify(conflictBody);

  for (const [label, text] of [
    ["PUT", putText],
    ["GET", getText],
    ["409", conflictText],
  ]) {
    assert.ok(!text.includes(PLAINTEXT_KEY), `${label} body must not contain the plaintext key`);
    assert.ok(!text.includes(row.key_ciphertext), `${label} body must not contain the stored ciphertext`);
    assert.ok(!text.includes(row.key_iv), `${label} body must not contain the stored IV`);
    assert.ok(!text.includes("key_ciphertext"), `${label} body must not carry raw row column names`);
  }
  assert.equal(getBody.keyHint, PLAINTEXT_KEY.slice(-4), "keyHint is exactly the last 4 characters");
  assert.equal(getBody.keyHint.length, 4);
  assert.equal(getBody.configured, true);
});

// ── Key retention across a model-only edit ─────────────────────────────────

await t("model-only change on the SAME provider keeps the stored ciphertext untouched", async () => {
  const db = freshDb();
  const env = baseEnv(db);
  await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  const before = storedRow(db);

  const res = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 1,
    body: { provider: "claude", model: "claude-opus-5" },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, "claude-opus-5");
  assert.equal(body.version, 2);
  assert.equal(body.configured, true, "still configured — the key was never resent, and never had to be");

  const after = storedRow(db);
  assert.equal(after.key_ciphertext, before.key_ciphertext, "ciphertext preserved verbatim");
  assert.equal(after.key_iv, before.key_iv, "IV preserved (re-encrypting here would need the plaintext)");
  assert.equal(after.key_hint, before.key_hint);
});

await t("changing provider without a new key → 400 api_key_required (a Claude key is useless to Gemini)", async () => {
  const db = freshDb();
  const env = baseEnv(db);
  await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  const before = storedRow(db);
  const res = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 1,
    body: { provider: "gemini", model: "gemini-3.6-flash" },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "api_key_required");
  assert.deepEqual(storedRow(db), before, "rejected write changed nothing");
});

await t("BYO provider on a virgin row without a key → 400 api_key_required", async () => {
  const res = await req(app, baseEnv(freshDb()), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "xai", model: "grok-4.5" },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "api_key_required");
});

// ── Body validation ─────────────────────────────────────────────────────────

await t("validation: unknown model, missing model, unknown provider, extra fields, default+extras", async () => {
  const env = () => baseEnv(freshDb());

  const unknownModel = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "gpt-5.6-terra", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(unknownModel.status, 400);
  assert.equal((await unknownModel.json()).error, "unknown_model", "a model from another provider is rejected");

  const noModel = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(noModel.status, 400);
  assert.equal((await noModel.json()).error, "model_required");

  const badProvider = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "llama", model: "whatever" },
  });
  assert.equal(badProvider.status, 400);
  assert.equal((await badProvider.json()).error, "validation_failed");

  const extra = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "default", surprise: 1 },
  });
  assert.equal(extra.status, 400, "strict() rejects unknown fields");
  assert.equal((await extra.json()).error, "validation_failed");

  const defaultWithModel = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "default", model: "claude-sonnet-5" },
  });
  assert.equal(defaultWithModel.status, 400);
  assert.equal((await defaultWithModel.json()).error, "unexpected_fields");

  const defaultWithKey = await req(app, env(), "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "default", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(defaultWithKey.status, 400);
  assert.equal((await defaultWithKey.json()).error, "unexpected_fields");
});

// ── Clear: PUT default and DELETE share one path ────────────────────────────

for (const [label, clear] of [
  ["PUT provider:default", (env) => req(app, env, "PUT", { token: adminTok, ifMatch: 1, body: { provider: "default" } })],
  ["DELETE", (env) => req(app, env, "DELETE", { token: adminTok, ifMatch: 1 })],
]) {
  await t(`${label} NULLs the key columns, keeps the row, and bumps version`, async () => {
    const db = freshDb();
    const env = baseEnv(db);
    await req(app, env, "PUT", {
      token: adminTok,
      ifMatch: 0,
      body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
    });
    const res = await clear(env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider, "default");
    assert.equal(body.model, null);
    assert.equal(body.configured, false);
    assert.equal(body.keyHint, null);
    assert.equal(body.version, 2, "version stays monotonic across a clear (the row is kept, not deleted)");

    const row = storedRow(db);
    assert.ok(row, "row kept so a concurrent admin's If-Match still resolves");
    assert.equal(row.key_ciphertext, null);
    assert.equal(row.key_iv, null);
    assert.equal(row.key_hint, null);
    assert.equal(row.model, null);
  });
}

await t("a stale DELETE → 409, key left intact", async () => {
  const db = freshDb();
  const env = baseEnv(db);
  await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  const res = await req(app, env, "DELETE", { token: adminTok, ifMatch: 0 });
  assert.equal(res.status, 409);
  assert.ok(storedRow(db).key_ciphertext, "key survives a rejected clear");
});

// ── Encryption unavailable (secret unset / misconfigured) ────────────────────

await t("no wrapping secret → 503 on a PUT carrying a key, encryptionAvailable:false on GET", async () => {
  const db = freshDb();
  const env = baseEnv(db, { wrappingKey: undefined });

  const get = await req(app, env, "GET", { token: adminTok });
  assert.equal((await get.json()).encryptionAvailable, false, "the UI must be able to disable the key field");

  const res = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "ai_key_encryption_unavailable");
  assert.equal(storedRow(db), null, "no half-written row");

  // A key-free write still works — model selection isn't gated on encryption.
  const clear = await req(app, env, "PUT", { token: adminTok, ifMatch: 0, body: { provider: "default" } });
  assert.equal(clear.status, 200);
});

await t("a wrong-length wrapping secret is treated as unavailable, not as a 500", async () => {
  const env = baseEnv(freshDb(), { wrappingKey: Buffer.alloc(16).toString("base64") });
  const res = await req(app, env, "PUT", {
    token: adminTok,
    ifMatch: 0,
    body: { provider: "claude", model: "claude-sonnet-5", apiKey: PLAINTEXT_KEY },
  });
  assert.equal(res.status, 503);
});

// ── Unmigrated workspace DB ─────────────────────────────────────────────────

await t("getAiProviderConfig on a DB without the table → null (unmigrated workspace degrades)", async () => {
  const db = freshDb({ withTable: false });
  assert.equal(await getAiProviderConfig(makeD1(db)), null);
});

await t("getAiProviderConfig rethrows a read error that is NOT a missing table", async () => {
  const boom = {
    prepare() {
      return { first: async () => { throw new Error("D1_ERROR: database is locked"); } };
    },
  };
  await assert.rejects(() => getAiProviderConfig(boom), /database is locked/);
});

await t("GET on an unmigrated workspace still answers with the default shape", async () => {
  const res = await req(app, baseEnv(freshDb({ withTable: false })), "GET", { token: adminTok });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.provider, "default");
  assert.equal(body.version, 0);
});

// ── Pure helpers ────────────────────────────────────────────────────────────

const row = (over) => ({
  id: 1,
  provider: "claude",
  model: "claude-sonnet-5",
  key_ciphertext: "Y2lwaGVy",
  key_iv: "aXZpdml2aXZpdg==",
  key_hint: "wxyz",
  version: 1,
  updated_at: 0,
  updated_by: null,
  ...over,
});

await t("resolveDispatchAi: absent row and provider 'default' are 'not configured', never a shared-subscription fallback (#551)", () => {
  const NOT_CONFIGURED = { kind: "error", reason: "ai_provider_not_configured" };
  assert.deepEqual(resolveDispatchAi(null, WRAPPING_KEY), NOT_CONFIGURED);
  assert.deepEqual(
    resolveDispatchAi(row({ provider: "default", model: null, key_ciphertext: null, key_iv: null }), WRAPPING_KEY),
    NOT_CONFIGURED,
  );
  // A stray key on a default row must not resurrect BYO dispatch.
  assert.deepEqual(resolveDispatchAi(row({ provider: "default" }), WRAPPING_KEY), NOT_CONFIGURED);
  // "Not configured" wins over a missing wrapping key: the actionable fix is "add a key".
  assert.deepEqual(resolveDispatchAi(null, undefined), NOT_CONFIGURED);
});

await t("resolveDispatchAi: a configured row yields the ciphertext for the caller to unwrap", () => {
  assert.deepEqual(resolveDispatchAi(row(), WRAPPING_KEY), {
    kind: "configured",
    provider: "claude",
    model: "claude-sonnet-5",
    ciphertext: "Y2lwaGVy",
    iv: "aXZpdml2aXZpdg==",
  });
});

await t("resolveDispatchAi: BYO configured but unusable → error, never a silent fallback to the shared key", () => {
  assert.deepEqual(resolveDispatchAi(row(), undefined), {
    kind: "error",
    reason: "ai_key_encryption_unavailable",
  });
  assert.deepEqual(resolveDispatchAi(row({ key_ciphertext: null }), WRAPPING_KEY), {
    kind: "error",
    reason: "api_key_missing",
  });
  assert.deepEqual(resolveDispatchAi(row({ key_iv: null }), WRAPPING_KEY), {
    kind: "error",
    reason: "api_key_missing",
  });
});

await t("resolveDispatchAi: BYO configured with no model → error, never dispatch with a null model", () => {
  assert.deepEqual(resolveDispatchAi(row({ model: null }), WRAPPING_KEY), {
    kind: "error",
    reason: "model_missing",
  });
  assert.deepEqual(resolveDispatchAi(row({ model: "" }), WRAPPING_KEY), {
    kind: "error",
    reason: "model_missing",
  });
});

await t("scrubSecret removes an embedded key, every occurrence, and no-ops on an empty secret", () => {
  assert.equal(scrubSecret(`upstream rejected ${PLAINTEXT_KEY}`, PLAINTEXT_KEY), "upstream rejected [redacted]");
  assert.equal(scrubSecret(`${PLAINTEXT_KEY} and ${PLAINTEXT_KEY}`, PLAINTEXT_KEY), "[redacted] and [redacted]");
  assert.equal(scrubSecret("nothing to hide", PLAINTEXT_KEY), "nothing to hide");
  assert.equal(scrubSecret("abc", ""), "abc", "an empty secret must not shred the string");
});

console.log(`aiProvider: ${passed} assertions passed`);
