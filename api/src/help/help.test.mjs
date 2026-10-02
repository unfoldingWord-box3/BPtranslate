// Tests for the help assistant: budget cap, cost math, routes, secrecy, viewer
// allowlist, prompt cache-stability. Real node:sqlite behind a D1-shaped adapter
// (pattern from aiProvider.test.mjs); provider adapters are stubbed.
//
//   node --experimental-strip-types --no-warnings --test src/help/help.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "../auth.ts";
import { encryptApiKey } from "../aiKeyCrypto.ts";
import { blockViewerWrites } from "../viewerGuard.ts";
import { makeHelpRoutes } from "./helpRoutes.ts";
import { reserve, settle, remainingMicros, worstCaseMicros, inputTokenBound, capMicrosFromEnv, utcDay, nextResetIso } from "./helpBudget.ts";
import { costMicros, buildSystemPrompt, parseAnswer, makeClaudeHelpAdapter, makeChatCompletionsHelpAdapter, makeGeminiHelpAdapter, articleIdsOf } from "./helpChat.ts";
import { HELP_KB } from "./helpKb.generated.ts";
import { buildKb, serializeKb, loadGuide } from "../../../scripts/build-help.mjs";

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const API_KEY = "sk-ant-api03-notarealkey-000000wxyz";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  const mig = readFileSync(new URL("../../migrations/0074_help_chat.sql", import.meta.url), "utf8");
  db.exec(`
    CREATE TABLE ai_provider_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL DEFAULT 'default', model TEXT,
      key_ciphertext TEXT, key_iv TEXT, key_hint TEXT, version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_by INTEGER);
  `);
  db.exec(mig); // the real migration, so the tests can't drift from it
  return db;
}

function makeD1(db) {
  const bound = (sql, params) => ({
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return { prepare: (sql) => ({ bind: (...p) => bound(sql, p), ...bound(sql, []) }) };
}

async function token(role, sub = "1") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: "u" + sub, role })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuer("bible-editor")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(KEY);
}

async function setup({ provider = "claude", enabled = true, wrappingKey = WRAPPING_KEY, adapter, key = API_KEY, cap } = {}) {
  const db = freshDb();
  if (provider) {
    const enc = await encryptApiKey(WRAPPING_KEY, key);
    db.prepare("INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, help_chat_enabled) VALUES (1, ?, ?, ?, ?, ?)")
      .run(provider, provider === "default" ? null : "claude-sonnet-5", provider === "default" ? null : enc.ciphertextB64, provider === "default" ? null : enc.ivB64, enabled ? 1 : 0);
  } else if (enabled) {
    db.prepare("INSERT INTO ai_provider_config (id, provider, help_chat_enabled) VALUES (1, 'default', 1)").run();
  }
  const calls = [];
  const stub = adapter ?? (async (req) => {
    calls.push(req);
    return { text: "Open Notes.\nSOURCES: notes, bogus", usage: { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 } };
  });
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("/api/*", blockViewerWrites);
  app.use("*", requireCsrf);
  app.route("/api/help", makeHelpRoutes({ adapterFor: () => stub }));
  const env = {
    JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: "bible-editor", DCS_BASE_URL: "https://git.door43.org",
    AI_KEY_WRAPPING_KEY: wrappingKey, DB: makeD1(db), ...(cap ? { HELP_CHAT_DAILY_CAP_USD: cap } : {}),
  };
  const send = async (method, path, { role = "editor", sub = "1", body } = {}) => {
    const tok = await token(role, sub);
    const headers = { cookie: `be_access=${tok}; be_csrf=c1`, "x-csrf-token": "c1" };
    const init = { method, headers };
    if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return app.request(path, init, env);
  };
  return { db, send, calls, env };
}

const ask = (over = {}) => ({ lang: "en", route: "notes", messages: [{ role: "user", content: "How do I save a note?" }], ...over });
const NOW = new Date("2026-10-02T12:00:00Z");

test("(a) concurrent reservations never exceed the cap", async () => {
  const d1 = makeD1(freshDb());
  const day = utcDay(NOW);
  const results = await Promise.all(Array.from({ length: 50 }, () => reserve(d1, 7, day, 30_000, 1_000_000)));
  assert.equal(results.filter(Boolean).length, 33); // floor(1_000_000 / 30_000)
  assert.deepEqual(results.slice(0, 33).every(Boolean), true);
  assert.equal(results.slice(33).some(Boolean), false);
  assert.equal(await remainingMicros(d1, 7, day, 1_000_000), 1_000_000 - 33 * 30_000);
  // another user and another day have their own budget
  assert.equal(await reserve(d1, 8, day, 30_000, 1_000_000), true);
  assert.equal(await reserve(d1, 7, "2026-10-03", 30_000, 1_000_000), true);
});

test("(b) settle releases the reservation and records the actual cost", async () => {
  const db = freshDb();
  const d1 = makeD1(db);
  assert.equal(await reserve(d1, 1, "2026-10-02", 40_000, 100_000), true);
  await settle(d1, 1, "2026-10-02", 40_000, 1_234);
  const row = db.prepare("SELECT * FROM help_chat_usage").get();
  assert.deepEqual({ ...row }, { user_id: 1, day: "2026-10-02", spent_micros: 1_234, reserved_micros: 0, calls: 1 });
  await reserve(d1, 1, "2026-10-02", 10_000, 100_000);
  await settle(d1, 1, "2026-10-02", 10_000, 0); // provider threw
  assert.equal(await remainingMicros(d1, 1, "2026-10-02", 100_000), 100_000 - 1_234);
});

test("route: reserved before the call, reconciled after, remainingUsd returned", async () => {
  const { send, db, calls } = await setup();
  const res = await send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.answer, "Open Notes.");
  assert.deepEqual(j.articleIds, ["notes"]); // "bogus" dropped
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-haiku-4-5");
  const row = db.prepare("SELECT * FROM help_chat_usage").get();
  assert.equal(row.reserved_micros, 0);
  assert.equal(row.spent_micros, 1000 * 1 + 100 * 5); // claude: $1 in, $5 out
  assert.equal(row.calls, 1);
  assert.equal(j.remainingUsd, (2_000_000 - 1_500) / 1e6);
});

test("route: budget exhausted -> 429 and no provider call", async () => {
  const { send, calls } = await setup({ cap: "0.01" });
  const res = await send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.code, "help_budget_exhausted");
  assert.equal(j.resetsAt, nextResetIso());
  assert.equal(calls.length, 0);
});

test("route: provider failure releases the reservation", async () => {
  const { send, db } = await setup({ adapter: async () => { throw Object.assign(new Error("boom"), { status: 503 }); } });
  const res = await send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { code: "help_ai_failed", kind: "provider_overloaded" });
  const row = db.prepare("SELECT * FROM help_chat_usage").get();
  assert.equal(row.reserved_micros, 0);
  assert.equal(row.spent_micros, 0);
});

test("(c) claude cost math prices cache write and read tokens", () => {
  const u = { inputTokens: 1234, outputTokens: 321, cacheWriteTokens: 20_000, cacheReadTokens: 30_000 };
  // 1234*1 + 20000*1.25 + 30000*0.10 + 321*5 = 1234 + 25000 + 3000 + 1605 = 30839
  assert.equal(costMicros("claude", u), 30_839);
  // other providers: every input token at the full input price
  assert.equal(costMicros("gemini", { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }), 750 + 375);
  assert.equal(costMicros("openai", { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }), 200 + 120);
  assert.equal(costMicros("xai", { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 }), 1250 + 250);
});

test("worst case uses cache-write rate for claude and covers max output", () => {
  assert.equal(worstCaseMicros("claude", 1000, 1024), Math.ceil((1000 * 125 + 1024 * 500) / 100));
  assert.equal(worstCaseMicros("gemini", 1000, 1024), Math.ceil((1000 * 75 + 1024 * 375) / 100));
  // One token per UTF-8 byte: Arabic letters are 2 bytes each, so the bound
  // never falls under a real token count.
  assert.equal(inputTokenBound(["abc"]), 3 + 20);
  assert.equal(inputTokenBound(["سلام", "hi"]), 8 + 20 + 2 + 20);
});

test("cap env parsing falls back to $2", () => {
  assert.equal(capMicrosFromEnv(undefined), 2_000_000);
  assert.equal(capMicrosFromEnv("abc"), 2_000_000);
  assert.equal(capMicrosFromEnv("-1"), 2_000_000);
  assert.equal(capMicrosFromEnv("0.5"), 500_000);
});

test("(d) config states: not configured, unavailable, disabled", async () => {
  let s = await setup({ provider: "default" });
  let res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "help_ai_not_configured");

  s = await setup({ provider: null });
  res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "help_ai_not_configured");

  s = await setup({ wrappingKey: "" });
  res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { code: "help_ai_unavailable", reason: "ai_key_encryption_unavailable" });

  s = await setup();
  s.db.prepare("UPDATE ai_provider_config SET key_ciphertext = NULL, key_iv = NULL").run();
  res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.deepEqual(await res.json(), { code: "help_ai_unavailable", reason: "api_key_missing" });

  s = await setup();
  s.db.prepare("UPDATE ai_provider_config SET key_ciphertext = 'AAAA'").run();
  res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.deepEqual(await res.json(), { code: "help_ai_unavailable", reason: "key_decrypt_failed" });

  s = await setup({ enabled: false });
  res = await s.send("POST", "/api/help/ask", { body: ask() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "help_ai_disabled");
  assert.equal(s.calls.length, 0);
});

test("(e) request limits -> 400", async () => {
  const { send } = await setup();
  const m = (role, content = "hi") => ({ role, content });
  const bad = [
    ask({ lang: "x".repeat(17) }),
    ask({ route: "r".repeat(65) }),
    ask({ messages: [] }),
    ask({ messages: Array.from({ length: 11 }, (_, i) => m(i % 2 ? "assistant" : "user")) }),
    ask({ messages: [m("assistant")] }),
    ask({ messages: [m("user"), m("user")] }),
    ask({ messages: [m("user"), m("assistant")] }), // must end with user
    ask({ messages: [m("user", "")] }),
    ask({ messages: [m("user", "   ")] }),
    ask({ messages: [m("user", "x".repeat(2001))] }),
    ask({ messages: [{ role: "user", content: 5 }] }),
  ];
  for (const body of bad) {
    const res = await send("POST", "/api/help/ask", { body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await res.json()).code, "bad_request");
  }
  const ok = await send("POST", "/api/help/ask", { body: ask({ messages: Array.from({ length: 9 }, (_, i) => m(i % 2 ? "assistant" : "user")), route: "r".repeat(64) }) });
  assert.equal(ok.status, 200);
});

test("(f) an error that echoes the API key leaks no key text", async () => {
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    const { send } = await setup({ adapter: async () => { throw Object.assign(new Error(`invalid key ${API_KEY} rejected`), { status: 401 }); } });
    const res = await send("POST", "/api/help/ask", { body: ask() });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.ok(!text.includes(API_KEY) && !text.includes("notarealkey"));
    assert.ok(logs.length > 0);
    assert.ok(!logs.join("\n").includes("notarealkey"));
    assert.equal(JSON.parse(text).kind, "invalid_key");
  } finally {
    console.error = orig;
  }
});

test("(g) viewer may POST /api/help/ask; other viewer writes still 403", async () => {
  const { send, calls } = await setup();
  const ok = await send("POST", "/api/help/ask", { role: "viewer", body: ask() });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  const put = await send("PUT", "/api/help/settings", { role: "viewer", body: { enabled: false } });
  assert.equal(put.status, 403);
  assert.equal((await put.json()).reason, "viewer_read_only");
});

test("settings: admin toggles, editor refused, row created when absent", async () => {
  const { send, db } = await setup({ provider: null, enabled: false });
  assert.equal((await send("PUT", "/api/help/settings", { role: "editor", body: { enabled: true } })).status, 403);
  assert.equal((await send("PUT", "/api/help/settings", { role: "admin", body: { enabled: "yes" } })).status, 400);
  const res = await send("PUT", "/api/help/settings", { role: "admin", body: { enabled: true } });
  assert.deepEqual(await res.json(), { enabled: true });
  assert.equal(db.prepare("SELECT provider, help_chat_enabled FROM ai_provider_config").get().help_chat_enabled, 1);
  assert.equal((await send("PUT", "/api/help/settings", { role: "admin", body: { enabled: false } })).status, 200);
  assert.equal(db.prepare("SELECT help_chat_enabled FROM ai_provider_config").get().help_chat_enabled, 0);
});

test("status reports enabled/configured/model/cap", async () => {
  const { send } = await setup();
  const j = await (await send("GET", "/api/help/status")).json();
  assert.deepEqual(j, { enabled: true, configured: true, provider: "claude", model: "claude-haiku-4-5", capUsd: 2, remainingUsd: 2 });
  const d = await (await (await setup({ provider: "default" })).send("GET", "/api/help/status")).json();
  assert.equal(d.configured, false);
});

test("system prompt is route-independent; route goes in the user turn", async () => {
  const { send, calls } = await setup();
  await send("POST", "/api/help/ask", { body: ask({ route: "alignment-screen-xyz" }) });
  await send("POST", "/api/help/ask", { body: ask({ route: "admin/team" }) });
  assert.equal(calls[0].system, calls[1].system);
  assert.ok(!calls[0].system.includes("alignment-screen-xyz"));
  assert.ok(calls[0].messages.at(-1).content.includes("alignment-screen-xyz"));
  assert.equal(calls[0].system, buildSystemPrompt("en").system);
  assert.ok(buildSystemPrompt("zz").system.includes(HELP_KB.en.slice(0, 200))); // unknown lang -> en guide
  assert.ok(buildSystemPrompt("ar").system.includes("Arabic"));
});

test("parseAnswer strips SOURCES and keeps only known ids", () => {
  const ids = articleIdsOf(HELP_KB.en);
  assert.ok(ids.has("notes"));
  assert.deepEqual(parseAnswer("Do X.\n\nSOURCES: notes, nope, notes", ids), { answer: "Do X.", articleIds: ["notes"] });
  assert.deepEqual(parseAnswer("Not covered.\nSOURCES: none", ids), { answer: "Not covered.", articleIds: [] });
  assert.deepEqual(parseAnswer("no line", ids), { answer: "no line", articleIds: [] });
});

test("claude adapter request shape and usage mapping", async () => {
  let params;
  const adapter = makeClaudeHelpAdapter(() => ({ messages: { create: async (p) => { params = p; return { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 } }; } } }));
  const r = await adapter({ model: "claude-haiku-4-5", system: "SYS", messages: [{ role: "user", content: "q" }], apiKey: "k", timeoutMs: 1 });
  assert.equal(params.max_tokens, 1024);
  assert.deepEqual(params.system, [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
  assert.equal("thinking" in params, false);
  assert.deepEqual(r, { text: "hi", usage: { inputTokens: 5, outputTokens: 6, cacheWriteTokens: 7, cacheReadTokens: 8 } });
});

test("gemini and chat-completions adapter request shapes", async () => {
  let seen;
  const fakeFetch = (reply) => async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify(reply), { status: 200 }); };
  const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }];
  const g = await makeGeminiHelpAdapter(fakeFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 3 } }))({ model: "gemini-3.8-flash", system: "S", messages: msgs, apiKey: "k", timeoutMs: 1000 });
  assert.deepEqual(seen.body.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.deepEqual(seen.body.generationConfig, { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } });
  assert.equal(seen.init.headers["x-goog-api-key"], "k");
  assert.equal(g.usage.outputTokens, 7);

  const o = await makeChatCompletionsHelpAdapter("openai", "https://api.openai.com/v1", fakeFetch({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }))({ model: "gpt-5.6-luna", system: "S", messages: msgs, apiKey: "k", timeoutMs: 1000 });
  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen.body.messages[0].role, "system");
  assert.equal(seen.body.max_completion_tokens, 1024);
  assert.equal(seen.body.reasoning_effort, "low");
  assert.deepEqual(o.usage, { inputTokens: 9, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0 });

  await makeChatCompletionsHelpAdapter("xai", "https://api.x.ai/v1", fakeFetch({ choices: [{ message: { content: "ok" } }], usage: {} }))({ model: "grok-4.3", system: "S", messages: msgs, apiKey: "k", timeoutMs: 1000 });
  assert.equal("reasoning_effort" in seen.body, false);
  assert.equal(seen.url, "https://api.x.ai/v1/chat/completions");
});

test("(h) committed HELP_KB matches the guide (buildKb)", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const kb = buildKb(loadGuide(root));
  const committed = readFileSync(new URL("./helpKb.generated.ts", import.meta.url), "utf8");
  assert.equal(committed, serializeKb(kb));
  assert.deepEqual(Object.keys(kb).sort(), Object.keys(HELP_KB).sort());
  for (const lang of Object.keys(kb)) assert.ok(!/!\[[^\]]*\]\(/.test(kb[lang]), `${lang} has image syntax`);
  // image lines removed, article blocks present
  assert.ok(kb.en.startsWith('<article id="'));
  assert.ok(kb.en.trimEnd().endsWith("</article>"));
});
