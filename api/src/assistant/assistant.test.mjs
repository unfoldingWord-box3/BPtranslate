// Tests for the editing assistant (issue #858): reply sanitizing, route gates,
// budget independence from the help assistant, truncation, adapter request shape.
// Real node:sqlite behind a D1-shaped adapter (pattern from help.test.mjs);
// provider adapters are stubbed.
//
//   node --experimental-strip-types --no-warnings --test src/assistant/assistant.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "../auth.ts";
import { encryptApiKey } from "../aiKeyCrypto.ts";
import { blockViewerWrites } from "../viewerGuard.ts";
import { makeAssistantRoutes } from "./assistantRoutes.ts";
import { makeHelpRoutes } from "../help/helpRoutes.ts";
import { parseActions, buildAssistantSystemPrompt, withScreenContext } from "./assistantChat.ts";
import { makeGeminiHelpAdapter, buildHelpGeminiRequest, makeChatCompletionsHelpAdapter, makeClaudeHelpAdapter } from "../help/helpChat.ts";

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const API_KEY = "sk-ant-api03-notarealkey-000000wxyz";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ai_provider_config (
      id INTEGER PRIMARY KEY CHECK (id = 1), provider TEXT NOT NULL DEFAULT 'default', model TEXT,
      key_ciphertext TEXT, key_iv TEXT, key_hint TEXT, version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_by INTEGER);
  `);
  for (const f of ["0077_help_chat.sql", "0084_assistant_chat.sql"]) {
    db.exec(readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8")); // the real migrations
  }
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
  return new SignJWT({ username: "u" + sub, role, ws: "default" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub).setIssuer("bible-editor")
    .setIssuedAt(now).setExpirationTime(now + 3600).sign(KEY);
}

const NOTES = [
  { id: "n1", ref: "1:1", quote: "word", note: "Old text one\\n\\nSecond para", state: "ai_draft", checked: true },
  { id: "n2", ref: "1:2", quote: null, note: "Old text two", state: null, checked: false },
];
const reply = (o) => JSON.stringify({ reply: "Done.", edits: [], approve: [], not_needed: [], ...o });
const USAGE = { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 };

async function setup({ provider = "claude", enabled = true, adapter, cap } = {}) {
  const db = freshDb();
  if (provider) {
    const enc = await encryptApiKey(WRAPPING_KEY, API_KEY);
    db.prepare("INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv) VALUES (1, ?, ?, ?, ?)")
      .run(provider, "claude-sonnet-5", enc.ciphertextB64, enc.ivB64);
  }
  if (enabled) db.prepare("INSERT INTO assistant_chat_settings (id, enabled) VALUES (1, 1)").run();
  db.prepare("INSERT INTO help_chat_settings (id, enabled) VALUES (1, 1)").run();
  const calls = [];
  const stub = adapter ?? (async (req) => {
    calls.push(req);
    return { text: reply({ edits: [{ id: "n1", note: "New text one" }] }), usage: USAGE, truncated: false };
  });
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("/api/*", blockViewerWrites);
  app.use("*", requireCsrf);
  app.route("/api/assistant", makeAssistantRoutes({ adapterFor: () => stub }));
  app.route("/api/help", makeHelpRoutes({ adapterFor: () => stub }));
  const env = {
    JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: "bible-editor", DCS_BASE_URL: "https://git.door43.org",
    AI_KEY_WRAPPING_KEY: WRAPPING_KEY, DB: makeD1(db), ...(cap ? { ASSISTANT_DAILY_CAP_USD: cap } : {}),
  };
  const send = async (method, path, { role = "editor", sub = "1", body, raw } = {}) => {
    const tok = await token(role, sub);
    const headers = { cookie: `be_access=${tok}; be_csrf=c1`, "x-csrf-token": "c1" };
    const init = { method, headers };
    if (raw !== undefined) { headers["content-type"] = "application/json"; init.body = raw; }
    else if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
    return app.request(path, init, env, { waitUntil() {}, passThroughOnException() {} });
  };
  return { db, send, calls };
}

const chat = (over = {}) => ({
  lang: "en", screen: "rapid_check",
  context: { book: "ZEC", chapter: 1, notes: NOTES },
  messages: [{ role: "user", content: "Shorten the checked notes" }],
  ...over,
});
const usageRow = (db, table) => db.prepare(`SELECT * FROM ${table}`).get();

// ---------------------------------------------------------------- parseActions

const ctx = { book: "ZEC", chapter: 1, notes: NOTES };

test("parseActions: unknown id dropped, unchanged edit dropped, dedupe (last wins)", () => {
  const r = parseActions(reply({
    edits: [
      { id: "zzz", note: "x" },
      { id: "n1", note: NOTES[0].note }, // unchanged
      { id: "n2", note: "first" },
      { id: "n2", note: "second" },
    ],
    approve: ["n1", "n1", "nope"],
  }), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.actions.edits, [{ id: "n2", note: "second" }]);
  assert.deepEqual(r.actions.approve, ["n1"]);
});

test("parseActions: an edit later reverted to the sent text is dropped", () => {
  const r = parseActions(reply({ edits: [{ id: "n1", note: "x" }, { id: "n1", note: NOTES[0].note }] }), ctx);
  assert.deepEqual(r.actions.edits, []);
});

test("parseActions: a real line break is stored as the two characters \\n", () => {
  const multi = { ...ctx, notes: [{ ...NOTES[0], id: "m1", note: "line one\\nline two" }] };
  // Same text with a real line break: not an edit.
  assert.deepEqual(parseActions(reply({ edits: [{ id: "m1", note: "line one\nline two" }] }), multi).actions.edits, []);
  // A real change keeps the stored convention.
  assert.deepEqual(parseActions(reply({ edits: [{ id: "m1", note: "line 1\r\nline two" }] }), multi).actions.edits, [{ id: "m1", note: "line 1\\nline two" }]);
});

test("parseActions: a proposed note over the note size limit is dropped", () => {
  const r = parseActions(reply({ edits: [{ id: "n1", note: "x".repeat(6001) }, { id: "n2", note: "fine" }] }), ctx);
  assert.deepEqual(r.actions.edits, [{ id: "n2", note: "fine" }]);
});

test("parseActions: an id in both approve and not_needed is dropped from both", () => {
  const r = parseActions(reply({ approve: ["n1", "n2"], not_needed: ["n1"] }), ctx);
  assert.deepEqual(r.actions.approve, ["n2"]);
  assert.deepEqual(r.actions.notNeeded, []);
});

test("parseActions: fenced JSON accepted; prose and empty are failures", () => {
  assert.equal(parseActions("```json\n" + reply({}) + "\n```", ctx).ok, true);
  assert.equal(parseActions("```\n" + reply({}) + "\n```", ctx).ok, true);
  assert.deepEqual(parseActions("Sure! I changed the notes.", ctx), { ok: false, kind: "unparseable" });
  assert.deepEqual(parseActions("[1,2]", ctx), { ok: false, kind: "unparseable" });
  assert.deepEqual(parseActions("", ctx), { ok: false, kind: "empty_answer" });
  assert.deepEqual(parseActions(JSON.stringify({ reply: "  ", edits: [] }), ctx), { ok: false, kind: "empty_answer" });
});

test("parseActions: text before or after a fence, or prose around a bare object, still parses (#860)", () => {
  const body = reply({ approve: ["n1"] });
  for (const text of [
    "Here you go:\n```json\n" + body + "\n```",
    "```json\n" + body + "\n```\nLet me know if you want more.",
    "Sure.\n```\n" + body + "\n```\nDone.",
    "Here: " + body + " Hope that helps.",
  ]) {
    const r = parseActions(text, ctx);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.actions.approve, ["n1"], text);
  }
  // Braces that are not JSON, or an array, are still failures.
  assert.deepEqual(parseActions("I {think} so {maybe}", ctx), { ok: false, kind: "unparseable" });
  assert.deepEqual(parseActions("```json\n{ not json }\n```", ctx), { ok: false, kind: "unparseable" });
  assert.deepEqual(parseActions('Result: [1, {"reply": "x"}]', ctx), { ok: false, kind: "unparseable" });
});

test("parseActions: a sent note stored with a real line break is not an edit when returned unchanged (#863)", () => {
  // Legacy rows can hold a real line break instead of the two characters \n.
  const legacy = { ...ctx, notes: [{ ...NOTES[0], id: "m1", note: "line one\nline two" }] };
  // Returned with a real line break, or with the stored \n: not an edit.
  assert.deepEqual(parseActions(reply({ edits: [{ id: "m1", note: "line one\nline two" }] }), legacy).actions.edits, []);
  assert.deepEqual(parseActions(reply({ edits: [{ id: "m1", note: "line one\\nline two" }] }), legacy).actions.edits, []);
  // A real change still comes back as an edit, in the stored convention.
  assert.deepEqual(parseActions(reply({ edits: [{ id: "m1", note: "line 1\nline two" }] }), legacy).actions.edits, [{ id: "m1", note: "line 1\\nline two" }]);
});

test("parseActions: malformed action fields are ignored, not fatal", () => {
  const r = parseActions(JSON.stringify({ reply: "ok", edits: "x", approve: [1, null, "n2"], not_needed: {} }), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.actions, { edits: [], approve: ["n2"], notNeeded: [] });
});

test("system prompt is request-independent; screen data goes in the last user turn", () => {
  assert.equal(buildAssistantSystemPrompt("en"), buildAssistantSystemPrompt("en"));
  assert.ok(!buildAssistantSystemPrompt("en").includes("Old text one"));
  const out = withScreenContext([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], ctx);
  assert.equal(out[0].content, "a");
  assert.ok(out[2].content.includes('"id":"n1"') && out[2].content.endsWith("\n\nc"));
});

// ---------------------------------------------------------------------- routes

test("chat: success returns sanitized actions and remainingUsd; settles the real cost", async () => {
  const { send, db, calls } = await setup();
  const res = await send("POST", "/api/assistant/chat", { body: chat() });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.reply, "Done.");
  assert.deepEqual(j.actions, { edits: [{ id: "n1", note: "New text one" }], approve: [], notNeeded: [] });
  assert.equal(calls[0].maxOutputTokens, 8192);
  assert.equal(calls[0].json, true);
  assert.equal(calls[0].timeoutMs, 120_000);
  const row = usageRow(db, "assistant_chat_usage");
  assert.deepEqual({ spent: row.spent_micros, reserved: row.reserved_micros, calls: row.calls }, { spent: 1000 + 500, reserved: 0, calls: 1 });
  assert.equal(j.remainingUsd, (7_000_000 - 1_500) / 1e6);
});

test("chat: 403 when the admin switch is off", async () => {
  const { send, calls } = await setup({ enabled: false });
  const res = await send("POST", "/api/assistant/chat", { body: chat() });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "assistant_disabled");
  assert.equal(calls.length, 0);
});

test("chat: a viewer is refused", async () => {
  const { send, calls } = await setup();
  assert.equal((await send("POST", "/api/assistant/chat", { role: "viewer", body: chat() })).status, 403);
  assert.equal(calls.length, 0);
});

test("chat: bad screen, bad alternation, bad notes, oversize body -> 400", async () => {
  const { send, calls } = await setup();
  const bad = async (body, raw) => {
    const r = await send("POST", "/api/assistant/chat", raw !== undefined ? { raw } : { body });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "bad_request");
  };
  await bad(chat({ screen: "other" }));
  await bad(chat({ messages: [{ role: "assistant", content: "hi" }] }));
  await bad(chat({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }));
  await bad(chat({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] })); // must end with user
  await bad(chat({ messages: [{ role: "user", content: "x".repeat(2001) }] }));
  await bad(chat({ context: { book: "ZEC", chapter: 1, notes: [] } }));
  await bad(chat({ context: { book: "ZEC", chapter: 1, notes: [{ ...NOTES[0], note: "x".repeat(6001) }] } }));
  await bad(chat({ context: { book: "ZEC", chapter: 1, notes: [NOTES[0], NOTES[0]] } })); // duplicate id
  await bad(undefined, "{not json");
  await bad(undefined, JSON.stringify(chat({ lang: "x".repeat(210 * 1024) }))); // over 200 KB
  assert.equal(calls.length, 0);
});

test("chat: 429 when the cap is used, no provider call", async () => {
  const { send, calls } = await setup({ cap: "0.001" });
  const res = await send("POST", "/api/assistant/chat", { body: chat() });
  assert.equal(res.status, 429);
  const j = await res.json();
  assert.equal(j.code, "assistant_budget_exhausted");
  assert.equal(j.remainingUsd, 0);
  assert.equal(calls.length, 0);
});

test("chat: truncated -> 502 truncated, real cost settled, never partial actions", async () => {
  const { send, db } = await setup({
    adapter: async () => ({ text: reply({ edits: [{ id: "n1", note: "partial" }] }), usage: USAGE, truncated: true }),
  });
  const res = await send("POST", "/api/assistant/chat", { body: chat() });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { code: "assistant_failed", kind: "truncated" });
  const row = usageRow(db, "assistant_chat_usage");
  assert.deepEqual({ spent: row.spent_micros, reserved: row.reserved_micros, calls: row.calls }, { spent: 1500, reserved: 0, calls: 0 });
});

test("chat: unparseable and empty replies -> 502 with the kind, cost settled", async () => {
  for (const [text, kind] of [["I changed it.", "unparseable"], ["", "empty_answer"]]) {
    const { send, db } = await setup({ adapter: async () => ({ text, usage: USAGE, truncated: false }) });
    const res = await send("POST", "/api/assistant/chat", { body: chat() });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { code: "assistant_failed", kind });
    assert.equal(usageRow(db, "assistant_chat_usage").spent_micros, 1500);
  }
});

test("help and assistant budgets are independent", async () => {
  const { send, db } = await setup();
  await send("POST", "/api/assistant/chat", { body: chat() });
  const h = await (await send("POST", "/api/help/ask", { body: { lang: "en", route: "notes", messages: [{ role: "user", content: "hi" }] } })).json();
  // the stub's reply is the assistant JSON: help still answers from its own table
  assert.ok(typeof h.remainingUsd === "number");
  assert.equal(h.remainingUsd, (2_000_000 - 1_500) / 1e6); // help cap $2, only its own spend
  assert.equal(usageRow(db, "assistant_chat_usage").spent_micros, 1500);
  assert.equal(usageRow(db, "help_chat_usage").spent_micros, 1500);
  // exhausting the assistant leaves help usable
  db.prepare("UPDATE assistant_chat_usage SET spent_micros = 7000000").run();
  assert.equal((await send("POST", "/api/assistant/chat", { body: chat() })).status, 429);
  assert.equal((await send("POST", "/api/help/ask", { body: { lang: "en", route: "notes", messages: [{ role: "user", content: "hi" }] } })).status, 200);
});

test("status: contract shape, canEdit by role, settings toggle", async () => {
  const { send } = await setup({ enabled: false });
  const s = await (await send("GET", "/api/assistant/status")).json();
  assert.deepEqual(Object.keys(s).sort(), ["canAsk", "canEdit", "capUsd", "configured", "enabled", "keyUsable", "model", "provider", "remainingUsd"]);
  assert.equal(s.enabled, false);
  assert.equal(s.canAsk, false);
  assert.equal(s.canEdit, true);
  assert.equal(s.capUsd, 7);
  assert.equal((await (await send("GET", "/api/assistant/status", { role: "viewer" })).json()).canEdit, false);
  assert.equal((await send("PUT", "/api/assistant/settings", { role: "editor", body: { enabled: true } })).status, 403);
  assert.equal((await send("PUT", "/api/assistant/settings", { role: "admin", body: { enabled: "yes" } })).status, 400);
  assert.deepEqual(await (await send("PUT", "/api/assistant/settings", { role: "admin", body: { enabled: true } })).json(), { enabled: true });
  const s2 = await (await send("GET", "/api/assistant/status")).json();
  assert.equal(s2.enabled, true);
  assert.equal(s2.canAsk, true);
});

// -------------------------------------------------------------------- adapters

test("gemini: json sets responseMimeType and the 16384 cap; help's request is unchanged", async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200 });
  };
  const adapter = makeGeminiHelpAdapter(fetchImpl);
  const base = { model: "gemini-3-flash", system: "S", messages: [{ role: "user", content: "q" }], apiKey: "k", timeoutMs: 1000 };
  const r = await adapter({ ...base, maxOutputTokens: 16384, json: true });
  assert.equal(sent.generationConfig.responseMimeType, "application/json");
  assert.equal(sent.generationConfig.maxOutputTokens, 16384);
  assert.equal(r.truncated, true);
  await adapter(base);
  assert.equal("responseMimeType" in sent.generationConfig, false);
  assert.equal(sent.generationConfig.maxOutputTokens, 2048);
  assert.deepEqual(buildHelpGeminiRequest("gemini-3-flash", "S", base.messages), {
    systemInstruction: { parts: [{ text: "S" }] },
    contents: [{ role: "user", parts: [{ text: "q" }] }],
    generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "low" } },
  });
});

test("openai json -> response_format; xai prompt-only; length -> truncated; claude max_tokens -> truncated", async () => {
  const seen = {};
  const mk = (provider) => makeChatCompletionsHelpAdapter(provider, "https://x/v1", async (u, init) => {
    seen[provider] = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  });
  const req = { model: "m", system: "S", messages: [{ role: "user", content: "q" }], apiKey: "k", timeoutMs: 1000, maxOutputTokens: 16384, json: true };
  assert.equal((await mk("openai")(req)).truncated, true);
  assert.deepEqual(seen.openai.response_format, { type: "json_object" });
  assert.equal(seen.openai.max_completion_tokens, 16384);
  await mk("xai")(req);
  assert.equal("response_format" in seen.xai, false);
  assert.equal(seen.xai.max_tokens, 16384);
  let params;
  const claude = makeClaudeHelpAdapter(() => ({ messages: { create: async (p) => { params = p; return { content: [{ type: "text", text: "{}" }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } }; } } }));
  const r = await claude({ model: "m", system: "S", messages: [{ role: "user", content: "q" }], apiKey: "k", timeoutMs: 1, maxOutputTokens: 8192 });
  assert.equal(params.max_tokens, 8192);
  assert.equal(r.truncated, true);
});
