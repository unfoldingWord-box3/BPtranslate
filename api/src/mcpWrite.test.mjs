// Issue #670 part (a): the chat MCP write tools bpt_edit_row and bpt_approve.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/mcpWrite.test.mjs
//
// The tools run the REAL rows router in-process, behind the REAL auth, CSRF
// and viewer middleware that index.ts mounts, against the REAL migration
// schema. The write goes through chatWriteEnv exactly as index.ts sends it, so
// these tests fail if the chat principal does not survive the middleware, and
// prove an outside request cannot use the same door.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { chapters } from "./chapters.ts";
import { attachAuth, chatConfirmMac, chatWriteEnv, requireCsrf } from "./auth.ts";
import { requireWorkspaceMatch } from "./workspaces.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { dispatch } from "./mcp.ts";

// counter.calls counts D1 round trips (a batch counts once, as on D1), so a
// test can measure what one chat write costs.
function makeDb(sqlite, counter = { calls: 0 }) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      counter.calls++;
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      counter.calls++;
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      counter.calls++;
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const before = counter.calls;
      const out = [];
      for (const s of stmts) out.push(s.run());
      counter.calls = before + 1;
      return out;
    },
  };
}

const BOOK = "TIT";
const EDITOR = "e".repeat(40);
const VIEWER = "v".repeat(40);
// The same reviewer's second chat link (another chat, or a re-link).
const EDITOR2 = "f".repeat(40);

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'reviewer')`).run();
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (10, 910, 'reader')`).run();
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state, trashed_at)
     VALUES (?, ?, 1, ?, ?, ?, 10, 3, ?, ?)`,
  );
  tn.run("ab12", BOOK, 1, "1:1", "draft note", "ai_draft", null);
  tn.run("tr01", BOOK, 2, "1:2", "trashed note", "ai_draft", 500);
  tn.run("en01", BOOK, 3, "1:3", "english note", null, null);
  sqlite.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, translation_state)
     VALUES ('q001', ?, 1, 1, '1:1', 'old q?', 'old a.', 2, 'ai_draft')`,
  ).run(BOOK);

  // The same middleware stack, in the same order, as index.ts.
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireWorkspaceMatch);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/rows", rows);
  app.route("/api/chapters", chapters);

  const d1 = { calls: 0 };
  const env = { DB: makeDb(sqlite, d1), JWT_SIGNING_KEY: "test-signing-key" };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const asJson = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  const sessionFor = (principal) => ({
    workspace: { slug: "default", label: "Default", org: "Org" },
    principal,
    getJson: async (path) => asJson(await app.request(path, {}, env, ctx)),
    // As index.ts sends it.
    send: async (method, path, body, ifMatch) => {
      const headers = { "Content-Type": "application/json" };
      if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
      return asJson(await app.request(path, { method, headers, body: JSON.stringify(body) }, chatWriteEnv(env, principal), ctx));
    },
    packageRefs: async () => ({}),
    sourceNotes: async () => ({ ok: false, reason: "test" }),
    confirmMac: (data) => chatConfirmMac(env, data),
  });
  const sessions = {
    [EDITOR]: sessionFor({ userId: 9, username: "reviewer", role: "editor", linkId: 1 }),
    [VIEWER]: sessionFor({ userId: 10, username: "reader", role: null, linkId: 2 }),
    [EDITOR2]: sessionFor({ userId: 9, username: "reviewer", role: "editor", linkId: 3 }),
  };
  const toolCtx = { session: async (t) => sessions[t] ?? null, claimLink: async () => ({ ok: false }) };
  const call = async (name, args, token = EDITOR) => {
    const reply = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { session_token: token, book: BOOK, ...args } } },
      toolCtx,
    );
    return { isError: reply.result.isError === true, data: JSON.parse(reply.result.content[0].text) };
  };
  const tnRow = (id) => ({ ...sqlite.prepare(`SELECT note, version, translation_state FROM tn_rows WHERE id = ?`).get(id) });
  const log = () => sqlite.prepare(`SELECT kind, row_key, user_id, action, source, prev_version, new_version FROM edit_log ORDER BY id`).all().map((r) => ({ ...r }));
  return { app, env, ctx, call, tnRow, log, sqlite, d1, sessions };
}

test("bpt_edit_row then bpt_approve: saved as the linked user, source chat, version-pinned", async () => {
  const { call, tnRow, log } = fresh();

  const edit = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "corrected note" });
  assert.equal(edit.isError, false, JSON.stringify(edit.data));
  assert.equal(edit.data.status, "applied");
  assert.equal(edit.data.version, 4);
  assert.equal(edit.data.state, "edited", "an edited AI draft needs approving again");
  assert.equal(edit.data.row.note, "corrected note");
  assert.deepEqual(tnRow("ab12"), { note: "corrected note", version: 4, translation_state: "edited" });

  const ok = await call("bpt_approve", { kind: "tn", id: "ab12", version: 4, state: "edited" });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "applied");
  assert.equal(ok.data.version, 4, "approving does not change the version");
  assert.equal(ok.data.state, "validated");
  assert.equal(tnRow("ab12").translation_state, "validated");

  const entries = log();
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { kind: "tn", row_key: "ab12", user_id: 9, action: "update", source: "chat", prev_version: 3, new_version: 4 });
  assert.deepEqual(entries[1], { kind: "tn", row_key: "ab12", user_id: 9, action: "validate", source: "chat", prev_version: 4, new_version: 4 });
});

test("bpt_edit_row on a tq row saves question and response", async () => {
  const { call, sqlite } = fresh();
  const r = await call("bpt_edit_row", { kind: "tq", id: "q001", version: 2, question: "new q?", response: "new a." });
  assert.equal(r.data.status, "applied", JSON.stringify(r.data));
  assert.equal(r.data.version, 3);
  const row = sqlite.prepare(`SELECT question, response, translation_state FROM tq_rows WHERE id = 'q001'`).get();
  assert.deepEqual({ ...row }, { question: "new q?", response: "new a.", translation_state: "edited" });
  const ok = await call("bpt_approve", { kind: "tq", id: "q001", version: 3, state: "edited" });
  assert.equal(ok.data.status, "applied", JSON.stringify(ok.data));
  assert.equal(ok.data.state, "validated");
});

// #703: the chat's own write must read back as source chat, not null.
test("after its own save the chat sees last_edit_source chat (edit and approve, tn and tq)", async () => {
  const { call } = fresh();
  const tnEdit = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "corrected note" });
  assert.equal(tnEdit.data.row.last_edit_source, "chat", JSON.stringify(tnEdit.data));
  const tnOk = await call("bpt_approve", { kind: "tn", id: "ab12", version: 4, state: "edited" });
  assert.equal(tnOk.data.row.last_edit_source, "chat", JSON.stringify(tnOk.data));

  const tqEdit = await call("bpt_edit_row", { kind: "tq", id: "q001", version: 2, question: "new q?" });
  assert.equal(tqEdit.data.row.last_edit_source, "chat", JSON.stringify(tqEdit.data));
  const tqOk = await call("bpt_approve", { kind: "tq", id: "q001", version: 3, state: "edited" });
  assert.equal(tqOk.data.row.last_edit_source, "chat", JSON.stringify(tqOk.data));
});

test("a stale version is a conflict carrying both texts, and nothing changes", async () => {
  const { call, tnRow, log } = fresh();
  // Someone else's edit lands first (here: the chat's own, at version 3 -> 4).
  await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "the other edit" });
  const before = log().length;

  const stale = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "reviewer's edit" });
  assert.equal(stale.isError, false);
  assert.equal(stale.data.status, "conflict");
  assert.deepEqual(stale.data.your_text, { note: "reviewer's edit" });
  assert.equal(stale.data.current.note, "the other edit");
  assert.equal(stale.data.current.version, 4);
  assert.equal(tnRow("ab12").note, "the other edit");

  const staleApprove = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3, state: "ai_draft" });
  assert.equal(staleApprove.data.status, "conflict");
  assert.equal(staleApprove.data.current.version, 4);
  assert.equal(staleApprove.data.your_text, undefined);
  assert.equal(tnRow("ab12").translation_state, "edited", "not approved");
  assert.equal(log().length, before, "no audit entry for either refused write");
});

test("a viewer is refused and nothing is written", async () => {
  const { call, tnRow, log } = fresh();
  const e = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "x" }, VIEWER);
  assert.equal(e.isError, true);
  assert.match(e.data.error, /cannot edit/);
  const a = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3, state: "ai_draft" }, VIEWER);
  assert.equal(a.isError, true);
  assert.deepEqual(tnRow("ab12"), { note: "draft note", version: 3, translation_state: "ai_draft" });
  assert.equal(log().length, 0);
});

test("unknown, trashed and not-a-draft rows get a clean error and no write", async () => {
  const { call, log, sqlite } = fresh();
  const unknown = await call("bpt_edit_row", { kind: "tn", id: "zz99", version: 1, note: "x" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /There is no tn row zz99/);
  const unknownApprove = await call("bpt_approve", { kind: "tq", id: "zz99", version: 1, state: "ai_draft" });
  assert.equal(unknownApprove.isError, true);

  const trashed = await call("bpt_edit_row", { kind: "tn", id: "tr01", version: 3, note: "x" });
  assert.equal(trashed.isError, true);
  assert.match(trashed.data.error, /trash/);
  const trashedApprove = await call("bpt_approve", { kind: "tn", id: "tr01", version: 3, state: "ai_draft" });
  assert.equal(trashedApprove.isError, true);
  assert.equal(sqlite.prepare(`SELECT trashed_at FROM tn_rows WHERE id = 'tr01'`).get().trashed_at, 500, "still trashed");

  const english = await call("bpt_approve", { kind: "tn", id: "en01", version: 3 });
  assert.equal(english.isError, true);
  assert.match(english.data.error, /not a translation draft/);

  const wrongField = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, question: "x" });
  assert.equal(wrongField.isError, true);
  assert.equal(log().length, 0);
});

test("an AI translate run holding the chapter is reported as such, not as a conflict", async () => {
  const { call, sqlite, tnRow } = fresh();
  sqlite.prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at)
     VALUES ('job-1', 9, 'translate', ?, 1, 1, 's', 'running', 1000)`,
  ).run(BOOK);
  const r = await call("bpt_edit_row", { kind: "tn", id: "ab12", version: 3, note: "x" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /AI translate run/);
  assert.equal(tnRow("ab12").note, "draft note");
});

test("the web app's validate call (no If-Match) still works, with source NULL", async () => {
  const { env, ctx, sqlite, tnRow } = fresh();
  // A web request, signed in: stamp the user the way attachAuth would from a
  // cookie by running the rows router behind a stub, as the other route tests do.
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  web.route("/api/rows", rows);
  const res = await web.request(
    `/api/rows/tn/ab12/validate?book=${BOOK}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: 1 }) },
    env,
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(tnRow("ab12").translation_state, "validated");
  assert.equal(sqlite.prepare(`SELECT source FROM edit_log`).get().source, null);
  // Same row shape as a PATCH response (#703): latest_source is present, and
  // NULL here because the web approval is the latest edit_log entry.
  const body = await res.json();
  assert.equal(body.translation_state, "validated");
  assert.ok("latest_source" in body, JSON.stringify(body));
  assert.equal(body.latest_source, null);
});

test("the chat door is closed to outside requests", async () => {
  const { app, env, ctx, tnRow } = fresh();
  const post = (e) =>
    app.request(
      `/api/rows/tn/ab12/validate?book=${BOOK}`,
      { method: "POST", headers: { "content-type": "application/json", "If-Match": "3" }, body: JSON.stringify({ value: 1 }) },
      e,
      ctx,
    );
  const plain = await post(env);
  assert.equal(plain.status, 403);
  assert.equal((await plain.json()).error, "csrf_mismatch");
  // A look-alike principal (say, a configured var) is not one auth.ts made.
  const forged = await post({ ...env, CHAT_PRINCIPAL: { userId: 9, username: "reviewer", role: "editor" } });
  assert.equal(forged.status, 403);
  assert.equal(tnRow("ab12").translation_state, "ai_draft");
});

// ── Issue #701: approve pins the state the reviewer was shown ───────────────
// State flips (approve, un-approve, trash) do not bump `version`, so a version
// pin alone let a chat approve land on a row the web un-approved or trashed
// after the reviewer saw it.

// A signed-in web request as the web app sends it: cookie session, no pins.
function webPost(env, ctx, path, body) {
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  web.route("/api/rows", rows);
  return web.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
    ctx,
  );
}

const conflictLog = (sqlite) =>
  sqlite
    .prepare(`SELECT kind, row_id, action, user_id, expected_version, current_version, fields_json FROM row_conflict_log ORDER BY id`)
    .all()
    .map((r) => ({ ...r }));

test("tn: the web un-approves after the chat showed the row; bpt_approve at the same version is a conflict and changes nothing", async () => {
  const { env, ctx, call, tnRow, log, sqlite } = fresh();
  // The web approves, the chat shows the row (v3, validated), the web un-approves (still v3).
  assert.equal((await webPost(env, ctx, `/api/rows/tn/ab12/validate?book=${BOOK}`, { value: 1 })).status, 200);
  const shown = await call("bpt_get_row", { kind: "tn", id: "ab12" });
  assert.equal(shown.isError, false, JSON.stringify(shown.data));
  assert.equal(shown.data.version, 3);
  assert.equal(shown.data.state, "validated");
  assert.equal((await webPost(env, ctx, `/api/rows/tn/ab12/validate?book=${BOOK}`, { value: 0 })).status, 200);
  assert.deepEqual(tnRow("ab12"), { note: "draft note", version: 3, translation_state: "edited" });
  const before = log().length;

  const r = await call("bpt_approve", { kind: "tn", id: "ab12", version: shown.data.version, state: shown.data.state });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current.version, 3);
  assert.equal(r.data.current.state, "edited");
  assert.match(r.data.message, /current\.state/);
  assert.equal(tnRow("ab12").translation_state, "edited", "not approved");
  assert.equal(log().length, before, "no audit entry for the refused approve");
  assert.deepEqual(conflictLog(sqlite), [
    { kind: "tn", row_id: "ab12", action: "validate", user_id: 9, expected_version: 3, current_version: 3, fields_json: '["translation_state"]' },
  ]);
});

test("tn: an ai_draft shown, then un-approved on the web (now edited), is a conflict", async () => {
  const { env, ctx, call, tnRow } = fresh();
  assert.equal((await webPost(env, ctx, `/api/rows/tn/ab12/validate?book=${BOOK}`, { value: 0 })).status, 200);
  const r = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3, state: "ai_draft" });
  assert.equal(r.data.status, "conflict", JSON.stringify(r.data));
  assert.equal(r.data.current.state, "edited");
  assert.equal(tnRow("ab12").translation_state, "edited");
});

test("tq: a web un-approve after the chat showed the row is a conflict", async () => {
  const { env, ctx, call, sqlite } = fresh();
  assert.equal((await webPost(env, ctx, `/api/rows/tq/q001/validate?book=${BOOK}`, { value: 1 })).status, 200);
  assert.equal((await webPost(env, ctx, `/api/rows/tq/q001/validate?book=${BOOK}`, { value: 0 })).status, 200);
  const r = await call("bpt_approve", { kind: "tq", id: "q001", version: 2, state: "validated" });
  assert.equal(r.data.status, "conflict", JSON.stringify(r.data));
  assert.equal(r.data.current.state, "edited");
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tq_rows WHERE id = 'q001'`).get().translation_state, "edited");
  const logged = conflictLog(sqlite);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, "tq");
  assert.equal(logged[0].action, "validate");
});

test("a trash that lands after the chat read the row: the pinned validate answers conflict, not gone", async () => {
  // writeTarget refuses a row that is already trashed when the tool reads it;
  // this is the route-level guard for a trash between that read and the write.
  const { app, env, ctx, sqlite, log } = fresh();
  const principal = { userId: 9, username: "reviewer", role: "editor", linkId: 1 };
  const res = await app.request(
    `/api/rows/tn/tr01/validate?book=${BOOK}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "If-Match": "3" },
      body: JSON.stringify({ value: 1, expected_state: "ai_draft" }),
    },
    chatWriteEnv(env, principal),
    ctx,
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "version_mismatch");
  assert.equal(body.current.trashed_at, 500);
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tn_rows WHERE id = 'tr01'`).get().translation_state, "ai_draft");
  assert.equal(log().length, 0);
  assert.equal(conflictLog(sqlite).length, 1);
});

test("the pinned happy path still approves and writes one validate audit entry", async () => {
  const { call, tnRow, log, sqlite } = fresh();
  const r = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3, state: "ai_draft" });
  assert.equal(r.data.status, "applied", JSON.stringify(r.data));
  assert.equal(tnRow("ab12").translation_state, "validated");
  assert.deepEqual(log(), [{ kind: "tn", row_key: "ab12", user_id: 9, action: "validate", source: "chat", prev_version: 3, new_version: 3 }]);
  assert.equal(conflictLog(sqlite).length, 0);
});

test("bpt_approve requires the state the reviewer was shown", async () => {
  const { call, tnRow } = fresh();
  const missing = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3 });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /state/);
  const bad = await call("bpt_approve", { kind: "tn", id: "ab12", version: 3, state: "approved" });
  assert.equal(bad.isError, true);
  assert.equal(tnRow("ab12").translation_state, "ai_draft");
});

test("the web app's unpinned validate is unchanged: it still flips a trashed row and logs no conflict", async () => {
  const { env, ctx, sqlite } = fresh();
  const res = await webPost(env, ctx, `/api/rows/tn/tr01/validate?book=${BOOK}`, { value: 1 });
  assert.equal(res.status, 200);
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tn_rows WHERE id = 'tr01'`).get().translation_state, "validated");
  assert.equal(conflictLog(sqlite).length, 0);
});

// ── Issue #670 part (c): bpt_bulk_set_state ─────────────────────────────────
// Moves the approved notes of a verse range back to "needs review" (edited),
// never the other way. A dry run (no confirm_token) changes nothing and
// returns a signed token over the exact id:version list it found; the confirm
// un-approves only those rows, each pinned to its version and to 'validated'.

// Chapter 2 of TIT: one row in each state the range action meets. updated_at
// is set well in the past: it has 1-second resolution, and every state write
// in a test lands in the same second, so a default of now would hide the
// change the confirm checks for.
function seedBulk(sqlite) {
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state, trashed_at, updated_at)
     VALUES (?, ?, 2, ?, ?, ?, 10, ?, ?, ?, 1000)`,
  );
  tn.run("b001", BOOK, 1, "2:1", "approved one", 5, "validated", null);
  tn.run("b002", BOOK, 1, "2:1", "ai draft", 2, "ai_draft", null);
  tn.run("b003", BOOK, 2, "2:2", "edited", 4, "edited", null);
  tn.run("b004", BOOK, 2, "2:2", "approved two", 7, "validated", null);
  tn.run("b005", BOOK, 3, "2:3", "approved but trashed", 1, "validated", 900);
  tn.run("b006", BOOK, 3, "2:3", "english note", 1, null, null);
  tn.run("b007", BOOK, 4, "2:4", "approved, outside the range", 1, "validated", null);
  const tq = sqlite.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, translation_state, updated_at)
     VALUES (?, ?, 2, ?, ?, 'q?', 'a.', ?, ?, 1000)`,
  );
  tq.run("qb01", BOOK, 1, "2:1", 2, "validated");
  tq.run("qb02", BOOK, 1, "2:1", 1, "ai_draft");
}

const RANGE = { kind: "tn", chapter: 2, verse_start: 1, verse_end: 3 };
const states = (sqlite, table = "tn_rows") =>
  Object.fromEntries(
    sqlite.prepare(`SELECT id, translation_state FROM ${table} WHERE chapter = 2 ORDER BY id`).all().map((r) => [r.id, r.translation_state]),
  );
const tnRow2 = (sqlite, id) => ({ ...sqlite.prepare(`SELECT version, translation_state FROM tn_rows WHERE id = ?`).get(id) });
const BEFORE = { b001: "validated", b002: "ai_draft", b003: "edited", b004: "validated", b005: "validated", b006: null, b007: "validated" };

test("bulk dry run changes nothing and reports what would change and what is skipped", async () => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const r = await call("bpt_bulk_set_state", RANGE);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "preview");
  assert.equal(r.data.would_change, 2);
  assert.deepEqual(r.data.rows.map((x) => [x.id, x.version]), [["b001", 5], ["b004", 7]]);
  const skipped = Object.fromEntries(r.data.skipped.map((s) => [s.reason, s.ids]));
  assert.deepEqual(skipped, { ai_draft: ["b002"], edited: ["b003"], trashed: ["b005"], not_a_draft: ["b006"] });
  assert.equal(typeof r.data.confirm_token, "string");
  assert.deepEqual(states(sqlite), BEFORE, "nothing changed");
  assert.equal(log().length, 0);
});

test("bulk confirm un-approves only the validated rows, as the linked user with source chat", async () => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  const r = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "done");
  assert.equal(r.data.applied, 2);
  assert.deepEqual(r.data.applied_ids, ["b001", "b004"]);
  assert.deepEqual(r.data.not_changed, []);
  assert.equal(r.data.remaining, 0);
  assert.deepEqual(states(sqlite), { ...BEFORE, b001: "edited", b004: "edited" });
  const versions = sqlite.prepare(`SELECT id, version FROM tn_rows WHERE id IN ('b001','b004') ORDER BY id`).all().map((x) => x.version);
  assert.deepEqual(versions, [5, 7], "a state flip does not bump the version");
  assert.deepEqual(log(), [
    { kind: "tn", row_key: "b001", user_id: 9, action: "unvalidate", source: "chat", prev_version: 5, new_version: 5 },
    { kind: "tn", row_key: "b004", user_id: 9, action: "unvalidate", source: "chat", prev_version: 7, new_version: 7 },
  ]);
  // tq works the same way.
  const tqDry = await call("bpt_bulk_set_state", { kind: "tq", chapter: 2 });
  assert.equal(tqDry.data.would_change, 1, JSON.stringify(tqDry.data));
  const tq = await call("bpt_bulk_set_state", { kind: "tq", chapter: 2, confirm_token: tqDry.data.confirm_token });
  assert.equal(tq.data.applied, 1, JSON.stringify(tq.data));
  assert.deepEqual(states(sqlite, "tq_rows"), { qb01: "edited", qb02: "ai_draft" });
});

test("a row edited or re-stated between dry run and confirm is not changed; the others still apply", async () => {
  const { env, ctx, call, sqlite } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2 });
  assert.equal(dry.data.would_change, 3, JSON.stringify(dry.data)); // b001, b004, b007
  // After the preview: b001 is edited in the chat (version 5 -> 6) and approved
  // again on the web, so it is validated but at a new version; b004 is
  // un-approved on the web (same version, state edited).
  await call("bpt_edit_row", { kind: "tn", id: "b001", version: 5, note: "changed" });
  assert.equal((await webPost(env, ctx, `/api/rows/tn/b001/validate?book=${BOOK}`, { value: 1 })).status, 200);
  assert.equal((await webPost(env, ctx, `/api/rows/tn/b004/validate?book=${BOOK}`, { value: 0 })).status, 200);

  const r = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2, confirm_token: dry.data.confirm_token });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.applied_ids, ["b007"]);
  const nc = Object.fromEntries(r.data.not_changed.map((x) => [x.id, x]));
  assert.equal(nc.b001.reason, "changed_since_preview");
  assert.equal(nc.b001.current_version, 6);
  assert.equal(nc.b001.current_state, "validated");
  assert.equal(nc.b004.reason, "changed_since_preview");
  assert.equal(nc.b004.current_state, "edited");
  assert.equal(r.data.remaining, 1, "b001 is approved again at a new version: a new preview would include it");
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tn_rows WHERE id = 'b001'`).get().translation_state, "validated", "the newer approval stands");
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tn_rows WHERE id = 'b007'`).get().translation_state, "edited");
});

// Review A1: approve and un-approve never bump the version, so a version pin
// alone cannot tell a re-approval from the row the reviewer agreed to change.
test("replaying a confirm after a web re-approval does not un-approve the row again", async () => {
  const { env, ctx, call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  const first = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.deepEqual(first.data.applied_ids, ["b001", "b004"]);
  // A web reviewer approves b004 again: validated, same version as in the token.
  assert.equal((await webPost(env, ctx, `/api/rows/tn/b004/validate?book=${BOOK}`, { value: 1 })).status, 200);
  const entries = log().length;

  const replay = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.equal(replay.isError, false, JSON.stringify(replay.data));
  assert.equal(replay.data.applied, 0);
  const nc = Object.fromEntries(replay.data.not_changed.map((x) => [x.id, x]));
  assert.equal(nc.b004.reason, "changed_since_preview");
  assert.equal(nc.b004.current_state, "validated");
  assert.equal(sqlite.prepare(`SELECT translation_state FROM tn_rows WHERE id = 'b004'`).get().translation_state, "validated", "the newer approval stands");
  assert.equal(replay.data.remaining, 1);
  assert.equal(log().length, entries, "the replay writes nothing");
});

test("a row un-approved and re-approved on the web between preview and confirm stays approved", async () => {
  const { env, ctx, call, sqlite } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  assert.equal((await webPost(env, ctx, `/api/rows/tn/b001/validate?book=${BOOK}`, { value: 0 })).status, 200);
  assert.equal((await webPost(env, ctx, `/api/rows/tn/b001/validate?book=${BOOK}`, { value: 1 })).status, 200);
  assert.deepEqual(tnRow2(sqlite, "b001"), { version: 5, translation_state: "validated" }, "same version and state as in the preview");

  const r = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.deepEqual(r.data.applied_ids, ["b004"], JSON.stringify(r.data));
  assert.deepEqual(r.data.not_changed.map((x) => [x.id, x.reason]), [["b001", "changed_since_preview"]]);
  assert.equal(tnRow2(sqlite, "b001").translation_state, "validated");
});

test("a plain replay of a confirm applies nothing and says why", async () => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  const entries = log().length;
  const replay = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.equal(replay.data.applied, 0, JSON.stringify(replay.data));
  assert.deepEqual(replay.data.not_changed.map((x) => [x.id, x.reason, x.current_state]), [
    ["b001", "changed_since_preview", "edited"],
    ["b004", "changed_since_preview", "edited"],
  ]);
  assert.match(replay.data.not_changed[0].why, /earlier confirm of this same preview/);
  assert.match(replay.data.message, /earlier confirm of this same preview/);
  assert.equal(log().length, entries);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM row_conflict_log`).get().n, 0, "skipped before the write, so no conflict entries either");
});

// Review A2: the rows are already changed when the closing count runs.
test("a failed closing count still returns what the confirm changed, with remaining null", async () => {
  const { call, sqlite, sessions } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  const s = sessions[EDITOR];
  const realGet = s.getJson;
  let chapterReads = 0;
  s.getJson = async (path) => {
    if (path.startsWith("/api/chapters/") && ++chapterReads === 2) return { status: 500, body: null };
    return realGet(path);
  };
  const r = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  s.getJson = realGet;
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.applied_ids, ["b001", "b004"]);
  assert.equal(r.data.remaining, null);
  assert.match(r.data.message, /could not be read/);
  assert.deepEqual(states(sqlite), { ...BEFORE, b001: "edited", b004: "edited" });
});

test("tampered, expired, other-link and different-argument tokens are refused and change nothing", async (t) => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  const token = dry.data.confirm_token;
  const refused = async (args, tok = EDITOR) => {
    const r = await call("bpt_bulk_set_state", args, tok);
    assert.equal(r.isError, true, JSON.stringify(r.data));
    assert.match(r.data.error, /Nothing was changed/);
    return r.data.error;
  };

  // Tampered: the row list rewritten to add the ai_draft row, the old signature kept.
  const [body, mac] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.r.push(["b002", 2]);
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${mac}`;
  await refused({ ...RANGE, confirm_token: forged });
  await refused({ ...RANGE, confirm_token: `${body}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}` });
  await refused({ ...RANGE, confirm_token: "not-a-token" });

  // Different arguments from the preview.
  await refused({ ...RANGE, verse_end: 4, confirm_token: token });
  await refused({ ...RANGE, kind: "tq", confirm_token: token });
  await refused({ ...RANGE, chapter: 1, confirm_token: token });
  // The same reviewer's other chat link.
  await refused({ ...RANGE, confirm_token: token }, EDITOR2);

  // Expired: ten minutes and a bit later.
  const real = Date.now();
  t.mock.method(Date, "now", () => real + 11 * 60_000);
  assert.match(await refused({ ...RANGE, confirm_token: token }), /expired/);
  t.mock.restoreAll();

  assert.deepEqual(states(sqlite), BEFORE);
  assert.equal(log().length, 0);
  // The genuine token, with the same arguments, still works.
  const ok = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: token });
  assert.equal(ok.data.applied, 2, JSON.stringify(ok.data));
});

test("an omitted verse_end and the same arguments spelled differently are not a mismatch", async () => {
  const { call, sqlite } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2, verse_start: "1" });
  const r = await call("bpt_bulk_set_state", { kind: "tn", chapter: "2", verse_start: 1, confirm_token: dry.data.confirm_token });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.applied, 3);
});

test("a viewer-role link is refused, for the preview and the confirm", async () => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  const v = await call("bpt_bulk_set_state", RANGE, VIEWER);
  assert.equal(v.isError, true);
  assert.match(v.data.error, /cannot edit/);
  const dry = await call("bpt_bulk_set_state", RANGE);
  const c = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token }, VIEWER);
  assert.equal(c.isError, true);
  assert.deepEqual(states(sqlite), BEFORE);
  assert.equal(log().length, 0);
});

test("a range with more approved rows than the cap is refused by the dry run", async () => {
  const { call, sqlite } = fresh();
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state) VALUES (?, ?, 3, ?, ?, 'n', 1, 'validated')`,
  );
  for (let i = 0; i < 51; i++) tn.run(`c${String(i).padStart(3, "0")}`, BOOK, 1 + Math.floor(i / 10), `3:${1 + Math.floor(i / 10)}`);
  const over = await call("bpt_bulk_set_state", { kind: "tn", chapter: 3 });
  assert.equal(over.isError, true, JSON.stringify(over.data));
  assert.match(over.data.error, /51 approved .* at most 50/);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM tn_rows WHERE translation_state = 'validated'`).get().n, 51);
  const narrower = await call("bpt_bulk_set_state", { kind: "tn", chapter: 3, verse_start: 1, verse_end: 5 });
  assert.equal(narrower.data.would_change, 50, JSON.stringify(narrower.data));
});

test("bulk never approves: only unvalidate entries, and no row becomes validated", async () => {
  const { call, sqlite, log } = fresh();
  seedBulk(sqlite);
  // Extra arguments a model might add are not a way to approve.
  const dry = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2, value: 1, state: "validated" });
  const r = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2, value: 1, state: "validated", confirm_token: dry.data.confirm_token });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  for (const [id, s] of Object.entries(states(sqlite))) {
    if (s === "validated") assert.equal(id, "b005", `${id} is validated; only the trashed b005 (skipped) may stay so`);
  }
  assert.ok(log().length > 0);
  assert.ok(log().every((e) => e.action === "unvalidate"), JSON.stringify(log()));
  // A preview with no approved rows offers nothing to confirm.
  const none = await call("bpt_bulk_set_state", { kind: "tn", chapter: 2, verse_start: 1, verse_end: 2 });
  assert.equal(none.data.would_change, 0);
  assert.equal(none.data.confirm_token, undefined);
});

test("a bulk confirm costs a bounded number of D1 calls per row", async () => {
  const { call, sqlite, d1, sessions } = fresh();
  seedBulk(sqlite);
  const dry = await call("bpt_bulk_set_state", RANGE);
  let before = d1.calls;
  await sessions[EDITOR].getJson(`/api/chapters/${BOOK}/2`);
  const chapterRead = d1.calls - before;
  before = d1.calls;
  const r = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: dry.data.confirm_token });
  assert.equal(r.data.applied, 2);
  // The confirm reads the chapter twice: fresh before the writes, and for the
  // closing count.
  const perRow = (d1.calls - before - 2 * chapterRead) / 2;
  console.log(`bulk confirm: ${perRow} D1 calls per row, ${chapterRead} for each of the two chapter reads`);
  // At the 50-row cap, plus one Durable Object broadcast per row, a confirm
  // must stay far under the Worker's ~1000 subrequest budget.
  assert.ok((perRow + 1) * 50 + 2 * chapterRead < 500, `per row ${perRow}, chapter read ${chapterRead}`);
});
