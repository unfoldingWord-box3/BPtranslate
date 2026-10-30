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
import { attachAuth, chatWriteEnv, requireCsrf } from "./auth.ts";
import { requireWorkspaceMatch } from "./workspaces.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { dispatch } from "./mcp.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

const BOOK = "TIT";
const EDITOR = "e".repeat(40);
const VIEWER = "v".repeat(40);

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

  const env = { DB: makeDb(sqlite) };
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
  });
  const sessions = {
    [EDITOR]: sessionFor({ userId: 9, username: "reviewer", role: "editor", linkId: 1 }),
    [VIEWER]: sessionFor({ userId: 10, username: "reader", role: null, linkId: 2 }),
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
  return { app, env, ctx, call, tnRow, log, sqlite };
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
