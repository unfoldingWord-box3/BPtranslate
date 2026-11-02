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
import { templates } from "./templates.ts";
import { articles } from "./articles.ts";
import { projectConfig } from "./projectConfigRoutes.ts";
import { attachAuth, chatConfirmMac, chatWriteEnv, requireCsrf } from "./auth.ts";
import { requireWorkspaceMatch } from "./workspaces.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { dispatch } from "./mcp.ts";
import { GET_ROW_BYTE_BUDGET, missingPlaceholders, templatePlaceholders } from "./mcpTools.ts";

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

// getProjectConfig caches per WORKSPACE_SLUG, so each fresh() gets its own.
let slugCounter = 0;

const SPEAKER_SRC =
  "SPEAKER is leaving out some of the words that in many languages a sentence would need in order to be complete. You can supply these words from the context if that would be clearer in your language. Alternate translation: [text]";
const METAPHOR_SRC = "David is speaking of Yahweh as if he were a high **rock** ... Alternate translation: [Yahweh is like a rock to me]";

function fresh({ preset = "ar-bsoj" } = {}) {
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
  tn.run("el01", BOOK, 4, "1:4", "ellipsis note", "ai_draft", null);
  sqlite.prepare(`UPDATE tn_rows SET support_reference = 'rc://*/ta/man/translate/figs-ellipsis' WHERE id = 'el01'`).run();
  sqlite.prepare(`INSERT INTO template_sync_state (id, last_synced_at, last_result_json) VALUES (1, unixepoch(), '{}')`).run();
  sqlite.prepare(`INSERT INTO project_config (id, preset, updated_at) VALUES (1, ?, unixepoch())`).run(preset);
  const unit = sqlite.prepare(
    `INSERT INTO template_units (template_id, support_ref, sheet_order, type, source_md, source_hash, origin, target_md, translation_state, version)
     VALUES (?, ?, ?, ?, ?, 'h', ?, ?, ?, ?)`,
  );
  unit.run("figs-ellipsis-01", "figs-ellipsis", 10, "", SPEAKER_SRC, "sheet", null, null, 1);
  unit.run("figs-ellipsis-02", "figs-ellipsis", 11, "second", "Second wording. [text]", "sheet", "second target [text]", "validated", 2);
  unit.run("builtin-ellipsis", "figs-ellipsis", 1, null, "Built-in wording", "builtin", null, null, 1);
  unit.run("figs-metaphor-02", "figs-metaphor", 12, "", METAPHOR_SRC, "sheet", null, null, 1);
  sqlite.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, translation_state)
     VALUES ('q001', ?, 1, 1, '1:1', 'old q?', 'old a.', 2, 'ai_draft')`,
  ).run(BOOK);
  // tW / tA article parts (#670 part d): an AI-drafted tW article, and a tA
  // article whose body is approved and whose title has no translation yet.
  const art = sqlite.prepare(
    `INSERT INTO article_units (resource, path, article_id, part, source_md, target_md, translation_state, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  art.run("tw", "bible/kt/god.md", "kt/god", "body", "# God\n\nGod is the one true God.", "# الله\n\nمسودة", "ai_draft", 1);
  art.run("ta", "translate/figs-aside/01.md", "translate/figs-aside", "body", "An aside is a short pause.", "الاستطراد وقفة قصيرة.", "validated", 3);
  art.run("ta", "translate/figs-aside/title.md", "translate/figs-aside", "title", "Asides", null, null, 1);

  // The same middleware stack, in the same order, as index.ts.
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireWorkspaceMatch);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/rows", rows);
  app.route("/api/chapters", chapters);
  app.route("/api/templates", templates);
  app.route("/api/articles", articles);
  app.route("/api/project-config", projectConfig);

  // Records each context export the routes queue (#707).
  const queued = [];
  const EXPORT_WORKFLOW = {
    async create(opts) {
      queued.push(opts);
      return { id: opts.id };
    },
  };
  const d1 = { calls: 0 };
  const env = { DB: makeDb(sqlite, d1), JWT_SIGNING_KEY: "test-signing-key", WORKSPACE_SLUG: `t${++slugCounter}`, EXPORT_WORKFLOW };
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
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
      return asJson(
        await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, chatWriteEnv(env, principal), ctx),
      );
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
  const tpl = (id) => ({ ...sqlite.prepare(`SELECT target_md, translation_state, version FROM template_units WHERE template_id = ?`).get(id) });
  const tplLog = () =>
    sqlite
      .prepare(`SELECT row_key, user_id, action, source FROM edit_log WHERE kind = 'template' ORDER BY id`)
      .all()
      .map((r) => ({ ...r }));
  const article = (resource, path) => ({
    ...sqlite.prepare(`SELECT target_md, translation_state, version FROM article_units WHERE resource = ? AND path = ?`).get(resource, path),
  });
  const artLog = () =>
    sqlite
      .prepare(`SELECT kind, row_key, user_id, action, source, prev_version, new_version FROM edit_log WHERE kind IN ('tw', 'ta') ORDER BY id`)
      .all()
      .map((r) => ({ ...r }));
  return { app, env, ctx, call, tnRow, log, sqlite, d1, sessions, tpl, tplLog, queued, article, artLog };
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

// ── Issue #702: chat tools that update note templates ───────────────────────

const NEW_WORDING = "Kelmat maḥdhūfa. Alternate translation: [text] SPEAKER";

test("bpt_templates_for_row: candidates in export order, drafts fed by the first approved sheet one", async () => {
  const { call } = fresh();
  const r = await call("bpt_templates_for_row", { id: "el01" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.support_reference, "figs-ellipsis");
  assert.ok(r.data.note);
  assert.deepEqual(r.data.templates.map((t) => t.template_id), ["builtin-ellipsis", "figs-ellipsis-01", "figs-ellipsis-02"]);
  // Drafts read the first approved sheet template: -02 today, since -01 has no wording yet.
  assert.deepEqual(r.data.templates.map((t) => t.feeds_drafts), [false, false, true]);
  const t1 = r.data.templates[1];
  assert.equal(t1.target_md, null);
  assert.equal(t1.state, null);
  assert.equal(t1.version, 1);
  assert.deepEqual(t1.placeholders, ["SPEAKER", "[text]"]);
  assert.equal(t1.pre_draft_json, undefined);
});

test("templatePlaceholders: slots versus example text", () => {
  const m = templatePlaceholders(METAPHOR_SRC);
  assert.deepEqual(m.placeholders, []);
  assert.deepEqual(m.examples, ["**rock**", "[Yahweh is like a rock to me]"]);
  const r = templatePlaceholders("ULT and UST show **text** then [idiomatic_example_text] and WORD1, WORDS, [passed away], [word2], [Name2]");
  assert.deepEqual(r.placeholders, ["**text**", "[idiomatic_example_text]", "WORD1", "WORDS", "[word2]", "[Name2]"]);
  for (const want of ["**text**", "[idiomatic_example_text]", "WORD1", "[word2]", "[Name2]"]) assert.ok(r.placeholders.includes(want), want);
  assert.ok(!r.placeholders.includes("ULT") && !r.placeholders.includes("UST"));
  assert.deepEqual(r.examples, ["[passed away]"]);
  // Arabic joins "and" to the next word: وSPEAKER still keeps the slot.
  assert.deepEqual(missingPlaceholders(["SPEAKER", "[text]"], "قال وSPEAKER [text]"), []);
  assert.deepEqual(missingPlaceholders(["SPEAKER"], "SPEAKERS"), ["SPEAKER"]);
});

test("edit then approve a template: applied, version-pinned, audited as chat", async () => {
  const { call, tpl, tplLog } = fresh();
  const edit = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING });
  assert.equal(edit.isError, false, JSON.stringify(edit.data));
  assert.equal(edit.data.status, "applied");
  assert.equal(edit.data.version, 2);
  assert.equal(edit.data.state, "edited");
  assert.equal(edit.data.template.target_md, NEW_WORDING);
  const ok = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 2, state: "edited" });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "applied");
  assert.equal(ok.data.version, 2);
  assert.equal(ok.data.state, "validated");
  assert.deepEqual(tpl("figs-ellipsis-01"), { target_md: NEW_WORDING, translation_state: "validated", version: 2 });
  assert.deepEqual(tplLog(), [
    { row_key: "figs-ellipsis-01", user_id: 9, action: "update", source: "chat" },
    { row_key: "figs-ellipsis-01", user_id: 9, action: "validate", source: "chat" },
  ]);
  // Approved wording above -02 now takes its place for drafts.
  const after = await call("bpt_templates_for_row", { id: "el01" });
  assert.deepEqual(after.data.templates.map((t) => t.feeds_drafts), [false, true, false]);
});

test("template: a stale version is a conflict and changes nothing", async () => {
  const { call, tpl, tplLog } = fresh();
  await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING });
  const before = tplLog().length;
  const stale = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: "SPEAKER [text] other" });
  assert.equal(stale.isError, false);
  assert.equal(stale.data.status, "conflict");
  assert.equal(stale.data.your_text, "SPEAKER [text] other");
  assert.equal(stale.data.current.target_md, NEW_WORDING);
  assert.equal(stale.data.current.version, 2);
  assert.deepEqual(tpl("figs-ellipsis-01"), { target_md: NEW_WORDING, translation_state: "edited", version: 2 });

  const staleApprove = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 1, state: "edited" });
  assert.equal(staleApprove.data.status, "conflict", JSON.stringify(staleApprove.data));
  assert.equal(staleApprove.data.your_text, undefined);
  assert.equal(staleApprove.data.current.version, 2);
  assert.equal(tpl("figs-ellipsis-01").translation_state, "edited");
  assert.equal(tplLog().length, before, "no audit entry for either refused write");
});

test("template edit: a dropped placeholder or empty text is refused and nothing is written", async () => {
  const { call, tpl, tplLog } = fresh();
  const dropped = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: "SPEAKERS only, no slot" });
  assert.equal(dropped.isError, true);
  assert.match(dropped.data.error, /\[text\]/);
  assert.match(dropped.data.error, /SPEAKER/);
  for (const text of ["", "   \n"]) {
    const empty = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text });
    assert.equal(empty.isError, true);
    assert.match(empty.data.error, /text is required/);
  }
  assert.deepEqual(tpl("figs-ellipsis-01"), { target_md: null, translation_state: null, version: 1 });
  assert.equal(tplLog().length, 0);
});

test("template tools: a viewer is refused and nothing is written", async () => {
  const { call, tpl, tplLog } = fresh();
  const a = await call("bpt_templates_for_row", { id: "el01" }, VIEWER);
  const b = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING }, VIEWER);
  const c = await call("bpt_approve_template", { template_id: "figs-ellipsis-02", version: 2, state: "validated" }, VIEWER);
  for (const r of [a, b, c]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /cannot edit/);
  }
  assert.deepEqual(tpl("figs-ellipsis-01"), { target_md: null, translation_state: null, version: 1 });
  assert.equal(tplLog().length, 0);
});

test("template tools: an authoring project is refused", async () => {
  const { call, tplLog } = fresh({ preset: "en-unfoldingword" });
  const a = await call("bpt_templates_for_row", { id: "el01" });
  assert.equal(a.isError, true);
  assert.match(a.data.error, /authoring mode/);
  const b = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING });
  assert.equal(b.isError, true);
  assert.match(b.data.error, /authoring mode/);
  assert.equal(tplLog().length, 0);
});

test("template approve: nothing to approve before any wording is saved", async () => {
  const { call, tpl, tplLog } = fresh();
  const r = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 1, state: "edited" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /nothing to approve/);
  assert.deepEqual(tpl("figs-ellipsis-01"), { target_md: null, translation_state: null, version: 1 });
  assert.equal(tplLog().length, 0);
});

test("bpt_templates_for_row: a tn row with no support reference is a clean error", async () => {
  const { call } = fresh();
  const r = await call("bpt_templates_for_row", { id: "ab12" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /no support reference/);
});

test("the web app's template validate and patch (no pins) are unchanged: source NULL", async () => {
  const { env, ctx, tpl, tplLog } = fresh();
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  web.route("/api/templates", templates);
  const post = (path, method, body, headers = {}) =>
    web.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env, ctx);

  const v = await post("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
  assert.equal(v.status, 200);
  assert.equal(tpl("figs-ellipsis-02").translation_state, "edited");
  const p = await post("/api/templates/unit?id=figs-ellipsis-01", "PATCH", { target_md: "web text SPEAKER [text]" }, { "If-Match": "1" });
  assert.equal(p.status, 200);
  assert.deepEqual(tplLog(), [
    { row_key: "figs-ellipsis-02", user_id: 9, action: "unvalidate", source: null },
    { row_key: "figs-ellipsis-01", user_id: 9, action: "update", source: null },
  ]);
});

test("template validate: an unparseable If-Match is a 400", async () => {
  const { app, env, ctx, tpl } = fresh();
  const principal = { userId: 9, username: "reviewer", role: "editor", linkId: 1 };
  const res = await app.request(
    "/api/templates/unit/validate?id=figs-ellipsis-02",
    { method: "POST", headers: { "content-type": "application/json", "If-Match": "abc" }, body: JSON.stringify({ value: 1 }) },
    chatWriteEnv(env, principal),
    ctx,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_if_match");
  assert.equal(tpl("figs-ellipsis-02").translation_state, "validated");
});

// #702 review: bracketed caps slots, free-text ids, stale edits, size.
test("templatePlaceholders: a bracketed or bold caps slot keeps its brackets", () => {
  const r = templatePlaceholders("Here [SPEAKER] uses **WORD**. Alternate translation: [ALT]");
  assert.deepEqual(r.placeholders, ["[SPEAKER]", "SPEAKER", "**WORD**", "WORD", "[ALT]", "ALT"]);
  assert.deepEqual(missingPlaceholders(r.placeholders, "SPEAKER WORD ALT"), ["[SPEAKER]", "**WORD**", "[ALT]"]);
});

test("template edit: a stale version with a dropped slot is a conflict, not a placeholder error; free-text ids work", async () => {
  const { call, sqlite, tpl } = fresh();
  sqlite.prepare(
    `INSERT INTO template_units (template_id, support_ref, sheet_order, type, source_md, source_hash, origin, version)
     VALUES ('This could mean-01', 'translate-tcm', 1, '', 'This could mean: (1) [text]', 'h', 'sheet', 1)`,
  ).run();
  const ok = await call("bpt_edit_template", { template_id: "This could mean-01", version: 1, text: "Two meanings: (1) [text]" });
  assert.equal(ok.data.status, "applied", JSON.stringify(ok.data));
  const stale = await call("bpt_edit_template", { template_id: "This could mean-01", version: 1, text: "no slot" });
  assert.equal(stale.isError, false, JSON.stringify(stale.data));
  assert.equal(stale.data.status, "conflict");
  assert.equal(tpl("This could mean-01").target_md, "Two meanings: (1) [text]");
});

test("bpt_templates_for_row: ten long translated variants leave out their English, and too much is refused", async () => {
  const { call, sqlite } = fresh();
  const ins = sqlite.prepare(
    `INSERT INTO template_units (template_id, support_ref, sheet_order, type, source_md, source_hash, origin, target_md, translation_state, version)
     VALUES (?, 'figs-ellipsis', ?, '', ?, 'h', 'sheet', ?, 'edited', 2)`,
  );
  for (let i = 0; i < 10; i++) ins.run(`big-${i}`, 100 + i, "SPEAKER ".repeat(150) + "[text]", "ك".repeat(900) + " SPEAKER [text]");
  const r = await call("bpt_templates_for_row", { id: "el01" });
  assert.equal(r.isError, false, JSON.stringify(r.data).slice(0, 300));
  const big = r.data.templates.filter((t) => t.template_id.startsWith("big-"));
  assert.equal(big.length, 10);
  assert.ok(big.every((t) => t.source_md === null && t.source_left_out === true && t.placeholders.includes("[text]")));
  sqlite.prepare(`UPDATE template_units SET target_md = ? WHERE template_id LIKE 'big-%'`).run("ك".repeat(3000) + " SPEAKER [text]");
  const tooBig = await call("bpt_templates_for_row", { id: "el01" });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.data.error, /too long/);
});

// ── Issue #707: approving a template queues the context export ──────────────

function assertOneContextExport(queued, env) {
  assert.equal(queued.length, 1, JSON.stringify(queued));
  assert.ok(queued[0].id.startsWith(`context-save-${env.WORKSPACE_SLUG}-`), queued[0].id);
  assert.deepEqual(queued[0].params, { contextOnly: true, workspace: env.WORKSPACE_SLUG, queued: true });
}

function webTemplates(env, ctx) {
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  web.route("/api/templates", templates);
  return (path, method, body, headers = {}) =>
    web.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env, ctx);
}

test("#707: a chat template approve queues one context export; the edit before it queues none", async () => {
  const { call, env, queued } = fresh();
  const edit = await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING });
  assert.equal(edit.data.status, "applied", JSON.stringify(edit.data));
  assert.equal(queued.length, 0);
  const ok = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 2, state: "edited" });
  assert.equal(ok.data.status, "applied", JSON.stringify(ok.data));
  assertOneContextExport(queued, env);
});

test("#707: a web approve and a web un-approve each queue one context export; a web PATCH queues none", async () => {
  const { env, ctx, queued, tpl } = fresh();
  const post = webTemplates(env, ctx);
  const p = await post("/api/templates/unit?id=figs-ellipsis-01", "PATCH", { target_md: "web text SPEAKER [text]" }, { "If-Match": "1" });
  assert.equal(p.status, 200);
  assert.equal(queued.length, 0);
  const un = await post("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
  assert.equal(un.status, 200);
  assert.equal(tpl("figs-ellipsis-02").translation_state, "edited");
  assertOneContextExport(queued, env);
  queued.length = 0;
  const ap = await post("/api/templates/unit/validate?id=figs-ellipsis-01", "POST", { value: 1 });
  assert.equal(ap.status, 200);
  assert.equal(tpl("figs-ellipsis-01").translation_state, "validated");
  assertOneContextExport(queued, env);
});

test("#707: a stale (409) or untranslated (404) approve queues nothing", async () => {
  const { call, env, ctx, queued } = fresh();
  const stale = await call("bpt_approve_template", { template_id: "figs-ellipsis-02", version: 1, state: "validated" });
  assert.equal(stale.data.status, "conflict", JSON.stringify(stale.data));
  const none = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 1, state: "edited" });
  assert.equal(none.isError, true, JSON.stringify(none.data));
  const post = webTemplates(env, ctx);
  const missing = await post("/api/templates/unit/validate?id=figs-ellipsis-01", "POST", { value: 1 });
  assert.equal(missing.status, 404);
  assert.equal(queued.length, 0);
});

test("#707: a queue that rejects or throws still leaves the approve at 200 and validated", async () => {
  for (const create of [
    async () => {
      throw new Error("instance already exists");
    },
    () => {
      throw new Error("binding unavailable");
    },
  ]) {
    const { env, ctx, tpl } = fresh();
    env.EXPORT_WORKFLOW.create = create;
    const post = webTemplates(env, ctx);
    await post("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
    const r = await post("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 1 });
    assert.equal(r.status, 200);
    assert.equal(tpl("figs-ellipsis-02").translation_state, "validated");
  }
});

// ── Issue #708: template approve pins the state the reviewer was shown ──────
// Template state flips (approve, un-approve) do not bump `version`, so a
// version pin alone let a chat approve land on a template the web un-approved
// after the reviewer saw it (the #701 gap, for templates).

// A chat (pinned) validate call straight to the route, as the tool sends it.
async function chatTemplateValidate(app, env, ctx, id, body, ifMatch) {
  const principal = { userId: 9, username: "reviewer", role: "editor", linkId: 1 };
  const headers = { "content-type": "application/json" };
  if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
  const res = await app.request(
    `/api/templates/unit/validate?id=${id}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    chatWriteEnv(env, principal),
    ctx,
  );
  return { status: res.status, body: await res.json() };
}

test("#708: the web un-approves after the chat showed the template; bpt_approve_template at the same version is a conflict and changes nothing", async () => {
  const { env, ctx, call, tpl, tplLog, queued } = fresh();
  // The chat shows -02 (v2, validated), then the web un-approves it (still v2).
  const shown = await call("bpt_templates_for_row", { id: "el01" });
  const t = shown.data.templates.find((x) => x.template_id === "figs-ellipsis-02");
  assert.deepEqual({ version: t.version, state: t.state }, { version: 2, state: "validated" });
  const un = await webTemplates(env, ctx)("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
  assert.equal(un.status, 200);
  assert.deepEqual(tpl("figs-ellipsis-02"), { target_md: "second target [text]", translation_state: "edited", version: 2 });
  const logBefore = tplLog().length;
  queued.length = 0;

  const r = await call("bpt_approve_template", { template_id: "figs-ellipsis-02", version: t.version, state: t.state });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current.version, 2);
  assert.equal(r.data.current.state, "edited");
  assert.match(r.data.message, /current\.state/);
  assert.equal(tpl("figs-ellipsis-02").translation_state, "edited", "not approved");
  assert.equal(tplLog().length, logBefore, "no audit entry for the refused approve");
  assert.equal(queued.length, 0, "no context export for the refused approve");
});

test("#708: a pinned validate whose state moved (version unchanged) answers 409 with current, and writes nothing", async () => {
  const { app, env, ctx, tpl, tplLog, queued } = fresh();
  await webTemplates(env, ctx)("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
  const logBefore = tplLog().length;
  queued.length = 0;
  for (const ifMatch of [2, undefined]) {
    const r = await chatTemplateValidate(app, env, ctx, "figs-ellipsis-02", { value: 1, expected_state: "validated" }, ifMatch);
    assert.equal(r.status, 409, `If-Match ${ifMatch}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "version_mismatch");
    assert.equal(r.body.current.translation_state, "edited");
    assert.equal(r.body.current.version, 2);
  }
  assert.equal(tpl("figs-ellipsis-02").translation_state, "edited");
  assert.equal(tplLog().length, logBefore);
  assert.equal(queued.length, 0);
});

test("#708: a pinned validate whose state still matches applies and writes one validate audit entry", async () => {
  const { app, env, ctx, tpl, tplLog, queued } = fresh();
  await webTemplates(env, ctx)("/api/templates/unit/validate?id=figs-ellipsis-02", "POST", { value: 0 });
  const logBefore = tplLog().length;
  queued.length = 0;
  const r = await chatTemplateValidate(app, env, ctx, "figs-ellipsis-02", { value: 1, expected_state: "edited" }, 2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.translation_state, "validated");
  assert.deepEqual(tpl("figs-ellipsis-02"), { target_md: "second target [text]", translation_state: "validated", version: 2 });
  assert.deepEqual(tplLog().slice(logBefore), [{ row_key: "figs-ellipsis-02", user_id: 9, action: "validate", source: "chat" }]);
  assertOneContextExport(queued, env);
});

test("#708: an expected_state outside the state set is a 400 and changes nothing", async () => {
  const { app, env, ctx, tpl, tplLog } = fresh();
  const r = await chatTemplateValidate(app, env, ctx, "figs-ellipsis-02", { value: 0, expected_state: "approved" }, 2);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "validation_failed");
  assert.equal(tpl("figs-ellipsis-02").translation_state, "validated");
  assert.equal(tplLog().length, 0);
});

test("#708: bpt_approve_template requires the state the reviewer was shown", async () => {
  const { call, tpl, tplLog } = fresh();
  await call("bpt_edit_template", { template_id: "figs-ellipsis-01", version: 1, text: NEW_WORDING });
  const before = tplLog().length;
  const missing = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 2 });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /state is required/);
  const bad = await call("bpt_approve_template", { template_id: "figs-ellipsis-01", version: 2, state: "approved" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /state is required/);
  assert.equal(tpl("figs-ellipsis-01").translation_state, "edited");
  assert.equal(tplLog().length, before);
});

// ── Issue #670 part (d): tW / tA articles from chat ─────────────────────────
// The same three steps as the template tools: read an article's parts with
// their version and state, save a part's wording pinned by If-Match, approve
// a part pinned to the version AND state the reviewer was shown.

const GOD = "bible/kt/god.md";
const ASIDE = "translate/figs-aside/01.md";
const ASIDE_TITLE = "translate/figs-aside/title.md";

function webArticles(env, ctx) {
  const web = new Hono();
  web.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  web.route("/api/articles", articles);
  return (path, method, body, headers = {}) =>
    web.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, env, ctx);
}

// A chat (pinned) article validate straight to the route, as the tool sends it.
async function chatArticleValidate(app, env, ctx, resource, path, body, ifMatch) {
  const principal = { userId: 9, username: "reviewer", role: "editor", linkId: 1 };
  const headers = { "content-type": "application/json" };
  if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
  const res = await app.request(
    `/api/articles/${resource}/unit/validate?path=${encodeURIComponent(path)}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    chatWriteEnv(env, principal),
    ctx,
  );
  return { status: res.status, body: await res.json() };
}

test("bpt_get_article: a tW article by link or id, a tA article by support reference, each part with version and state", async () => {
  const { call } = fresh();
  for (const ref of ["rc://*/tw/dict/bible/kt/god", "kt/god"]) {
    const r = await call("bpt_get_article", { resource: "tw", article: ref });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.article_id, "kt/god");
    assert.deepEqual(r.data.parts, [
      { path: GOD, part: "body", source_md: "# God\n\nGod is the one true God.", target_md: "# الله\n\nمسودة", state: "ai_draft", version: 1 },
    ]);
  }
  const ta = await call("bpt_get_article", { resource: "ta", article: "rc://*/ta/man/translate/figs-aside" });
  assert.equal(ta.isError, false, JSON.stringify(ta.data));
  assert.equal(ta.data.article_id, "translate/figs-aside");
  // sub-title.md is not loaded, so it is not listed.
  assert.deepEqual(ta.data.parts.map((p) => [p.part, p.path, p.state, p.version]), [
    ["body", ASIDE, "validated", 3],
    ["title", ASIDE_TITLE, null, 1],
  ]);
  const bare = await call("bpt_get_article", { resource: "ta", article: "figs-aside" });
  assert.deepEqual(bare.data.parts.map((p) => p.path), [ASIDE, ASIDE_TITLE]);
});

test("bpt_get_article: an unknown or unparseable article is a clean error", async () => {
  const { call } = fresh();
  const missing = await call("bpt_get_article", { resource: "tw", article: "kt/grace" });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /not loaded/);
  const noCat = await call("bpt_get_article", { resource: "tw", article: "god" });
  assert.equal(noCat.isError, true);
  assert.match(noCat.data.error, /not a tW article/);
  const badRes = await call("bpt_get_article", { resource: "tn", article: "kt/god" });
  assert.equal(badRes.isError, true);
  assert.match(badRes.data.error, /resource/);
});

test("article: edit then approve a part, as the linked user, source chat, version-pinned", async () => {
  const { call, article, artLog } = fresh();
  const edit = await call("bpt_edit_article", { resource: "tw", path: GOD, version: 1, text: "# الله\n\nالنص المصحح" });
  assert.equal(edit.isError, false, JSON.stringify(edit.data));
  assert.equal(edit.data.status, "applied");
  assert.equal(edit.data.version, 2);
  assert.equal(edit.data.state, "edited", "an edited AI draft needs approving again");
  assert.equal(edit.data.part.target_md, "# الله\n\nالنص المصحح");
  const ok = await call("bpt_approve_article", { resource: "tw", path: GOD, version: 2, state: "edited" });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "applied");
  assert.equal(ok.data.version, 2, "approving does not change the version");
  assert.equal(ok.data.state, "validated");
  assert.deepEqual(article("tw", GOD), { target_md: "# الله\n\nالنص المصحح", translation_state: "validated", version: 2 });
  assert.deepEqual(artLog(), [
    { kind: "tw", row_key: GOD, user_id: 9, action: "update", source: "chat", prev_version: 1, new_version: 2 },
    { kind: "tw", row_key: GOD, user_id: 9, action: "validate", source: "chat", prev_version: 2, new_version: 2 },
  ]);
});

test("article race: a web save lands after the chat showed the part; the chat edit is a conflict with both texts and changes nothing", async () => {
  const { env, ctx, call, article, artLog } = fresh();
  const shown = await call("bpt_get_article", { resource: "tw", article: "kt/god" });
  const part = shown.data.parts[0];
  assert.equal(part.version, 1);
  const web = await webArticles(env, ctx)(`/api/articles/tw/unit?path=${encodeURIComponent(GOD)}`, "PATCH", { target_md: "web text" }, { "If-Match": "1" });
  assert.equal(web.status, 200);

  const r = await call("bpt_edit_article", { resource: "tw", path: GOD, version: part.version, text: "chat text" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.your_text, "chat text");
  assert.equal(r.data.current.target_md, "web text");
  assert.equal(r.data.current.version, 2);
  assert.equal(r.data.current.state, "edited");
  assert.deepEqual(article("tw", GOD), { target_md: "web text", translation_state: "edited", version: 2 });
  assert.deepEqual(artLog(), [{ kind: "tw", row_key: GOD, user_id: 9, action: "update", source: null, prev_version: 1, new_version: 2 }]);
});

test("article: a stale-version approve is a conflict and changes nothing", async () => {
  const { call, article, artLog } = fresh();
  await call("bpt_edit_article", { resource: "tw", path: GOD, version: 1, text: "new text" });
  const before = artLog().length;
  const stale = await call("bpt_approve_article", { resource: "tw", path: GOD, version: 1, state: "edited" });
  assert.equal(stale.isError, false, JSON.stringify(stale.data));
  assert.equal(stale.data.status, "conflict");
  assert.equal(stale.data.your_text, undefined);
  assert.equal(stale.data.current.version, 2);
  assert.equal(article("tw", GOD).translation_state, "edited");
  assert.equal(artLog().length, before);
});

test("article: the web un-approves after the chat showed the part; bpt_approve_article at the same version is a conflict and changes nothing", async () => {
  const { env, ctx, call, article, artLog } = fresh();
  const shown = await call("bpt_get_article", { resource: "ta", article: "figs-aside" });
  const body = shown.data.parts.find((p) => p.part === "body");
  assert.deepEqual({ version: body.version, state: body.state }, { version: 3, state: "validated" });
  const un = await webArticles(env, ctx)(`/api/articles/ta/unit/validate?path=${encodeURIComponent(ASIDE)}`, "POST", { value: 0 });
  assert.equal(un.status, 200);
  assert.deepEqual(article("ta", ASIDE), { target_md: "الاستطراد وقفة قصيرة.", translation_state: "edited", version: 3 });
  const before = artLog().length;

  const r = await call("bpt_approve_article", { resource: "ta", path: ASIDE, version: body.version, state: body.state });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.status, "conflict");
  assert.equal(r.data.current.version, 3);
  assert.equal(r.data.current.state, "edited");
  assert.match(r.data.message, /current\.state/);
  assert.equal(article("ta", ASIDE).translation_state, "edited", "not approved");
  assert.equal(artLog().length, before, "no audit entry for the refused approve");
});

test("article validate: a pinned miss is a 409 with current and writes nothing; a pinned match applies with one chat audit entry", async () => {
  const { app, env, ctx, article, artLog } = fresh();
  await webArticles(env, ctx)(`/api/articles/ta/unit/validate?path=${encodeURIComponent(ASIDE)}`, "POST", { value: 0 });
  const before = artLog().length;
  for (const [body, ifMatch] of [
    [{ value: 1, expected_state: "validated" }, 3],
    [{ value: 1, expected_state: "validated" }, undefined],
    [{ value: 1, expected_state: "edited" }, 2],
    [{ value: 1 }, 2],
  ]) {
    const r = await chatArticleValidate(app, env, ctx, "ta", ASIDE, body, ifMatch);
    assert.equal(r.status, 409, `${JSON.stringify(body)} If-Match ${ifMatch}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "version_mismatch");
    assert.equal(r.body.current.translation_state, "edited");
    assert.equal(r.body.current.version, 3);
  }
  assert.equal(article("ta", ASIDE).translation_state, "edited");
  assert.equal(artLog().length, before);

  const ok = await chatArticleValidate(app, env, ctx, "ta", ASIDE, { value: 1, expected_state: "edited" }, 3);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.translation_state, "validated");
  assert.deepEqual(artLog().slice(before), [
    { kind: "ta", row_key: ASIDE, user_id: 9, action: "validate", source: "chat", prev_version: 3, new_version: 3 },
  ]);
});

test("article validate: a bad expected_state or If-Match is a 400 and changes nothing", async () => {
  const { app, env, ctx, article, artLog } = fresh();
  const badState = await chatArticleValidate(app, env, ctx, "ta", ASIDE, { value: 0, expected_state: "approved" }, 3);
  assert.equal(badState.status, 400);
  assert.equal(badState.body.error, "validation_failed");
  const badIfMatch = await chatArticleValidate(app, env, ctx, "ta", ASIDE, { value: 0 }, "abc");
  assert.equal(badIfMatch.status, 400);
  assert.equal(badIfMatch.body.error, "invalid_if_match");
  assert.equal(article("ta", ASIDE).translation_state, "validated");
  assert.equal(artLog().length, 0);
});

test("bpt_approve_article requires the state the reviewer was shown", async () => {
  const { call, article, artLog } = fresh();
  const missing = await call("bpt_approve_article", { resource: "tw", path: GOD, version: 1 });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /state is required/);
  const bad = await call("bpt_approve_article", { resource: "tw", path: GOD, version: 1, state: "approved" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /state is required/);
  assert.equal(article("tw", GOD).translation_state, "ai_draft");
  assert.equal(artLog().length, 0);
});

test("article tools: viewers, authoring projects, unknown parts, untranslated parts and empty text are refused; nothing is written", async () => {
  const { call, article, artLog } = fresh();
  for (const r of [
    await call("bpt_get_article", { resource: "tw", article: "kt/god" }, VIEWER),
    await call("bpt_edit_article", { resource: "tw", path: GOD, version: 1, text: "x" }, VIEWER),
    await call("bpt_approve_article", { resource: "tw", path: GOD, version: 1, state: "ai_draft" }, VIEWER),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /cannot edit/);
  }
  const unknown = await call("bpt_edit_article", { resource: "tw", path: "bible/kt/grace.md", version: 1, text: "x" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.data.error, /no tW article part/);
  const untranslated = await call("bpt_approve_article", { resource: "ta", path: ASIDE_TITLE, version: 1, state: "edited" });
  assert.equal(untranslated.isError, true);
  assert.match(untranslated.data.error, /nothing to approve/);
  for (const text of ["", "  \n"]) {
    const empty = await call("bpt_edit_article", { resource: "ta", path: ASIDE_TITLE, version: 1, text });
    assert.equal(empty.isError, true);
    assert.match(empty.data.error, /text is required/);
  }
  const badPath = await call("bpt_edit_article", { resource: "tw", path: "bible/kt/god", version: 1, text: "x" });
  assert.equal(badPath.isError, true);
  assert.match(badPath.data.error, /path/);
  assert.deepEqual(article("tw", GOD), { target_md: "# الله\n\nمسودة", translation_state: "ai_draft", version: 1 });
  assert.deepEqual(article("ta", ASIDE_TITLE), { target_md: null, translation_state: null, version: 1 });
  assert.equal(artLog().length, 0);

  const authoring = fresh({ preset: "en-unfoldingword" });
  for (const r of [
    await authoring.call("bpt_get_article", { resource: "tw", article: "kt/god" }),
    await authoring.call("bpt_edit_article", { resource: "tw", path: GOD, version: 1, text: "x" }),
    await authoring.call("bpt_approve_article", { resource: "tw", path: GOD, version: 1, state: "ai_draft" }),
  ]) {
    assert.equal(r.isError, true);
    assert.match(r.data.error, /authoring mode/);
  }
  assert.equal(authoring.artLog().length, 0);
});

test("the web app's article validate and patch (no pins) are unchanged: source NULL", async () => {
  const { env, ctx, article, artLog } = fresh();
  const post = webArticles(env, ctx);
  const v = await post(`/api/articles/ta/unit/validate?path=${encodeURIComponent(ASIDE)}`, "POST", { value: 0 });
  assert.equal(v.status, 200);
  assert.equal(article("ta", ASIDE).translation_state, "edited");
  const p = await post(`/api/articles/tw/unit?path=${encodeURIComponent(GOD)}`, "PATCH", { target_md: "web text" }, { "If-Match": "1" });
  assert.equal(p.status, 200);
  const a = await post(`/api/articles/tw/unit/validate?path=${encodeURIComponent(GOD)}`, "POST", { value: 1 });
  assert.equal(a.status, 200);
  assert.deepEqual(artLog(), [
    { kind: "ta", row_key: ASIDE, user_id: 9, action: "unvalidate", source: null, prev_version: 3, new_version: 3 },
    { kind: "tw", row_key: GOD, user_id: 9, action: "update", source: null, prev_version: 1, new_version: 2 },
    { kind: "tw", row_key: GOD, user_id: 9, action: "validate", source: null, prev_version: 2, new_version: 2 },
  ]);
});

test("bpt_get_article: a long translated article leaves out its English, and too much is refused", async () => {
  const { call, sqlite } = fresh();
  sqlite.prepare(`UPDATE article_units SET source_md = ?, target_md = ? WHERE path = ?`).run("An aside. ".repeat(1500), "ك".repeat(7000), ASIDE);
  const r = await call("bpt_get_article", { resource: "ta", article: "figs-aside" });
  assert.equal(r.isError, false, JSON.stringify(r.data).slice(0, 300));
  const [body, title] = r.data.parts;
  assert.equal(body.source_md, null);
  assert.equal(body.source_left_out, true);
  assert.equal(title.source_md, "Asides", "an untranslated part keeps its English");
  sqlite.prepare(`UPDATE article_units SET target_md = ? WHERE path = ?`).run("ك".repeat(16000), ASIDE);
  const tooBig = await call("bpt_get_article", { resource: "ta", article: "figs-aside" });
  assert.equal(tooBig.isError, true);
  assert.match(tooBig.data.error, /too long/);
});

// #670 part (d) review: write results fit the chat's cap, and never carry raw columns.
const resultBytes = (data) => Buffer.byteLength(JSON.stringify(data), "utf8");
const RAW_COLUMNS = ["pre_draft_json", "draft_meta_json", "source_sha", "updated_by", "updated_at", "deleted_at", "latest_source", "resource", "article_id"];
function assertProjected(part) {
  for (const k of RAW_COLUMNS) assert.equal(part[k], undefined, `${k} must not reach chat`);
  assert.equal(part.source_md, undefined, "write results leave out the English the reviewer already read");
}

test("article write results on a long tA part stay under the chat cap and carry only the projected part", async () => {
  const { call, sqlite, env, ctx } = fresh();
  sqlite.prepare(`UPDATE article_units SET source_md = ?, target_md = ?, pre_draft_json = '{"target_md":"old"}' WHERE path = ?`)
    .run("An aside. ".repeat(1500), "ك".repeat(7000), ASIDE);

  const edit = await call("bpt_edit_article", { resource: "ta", path: ASIDE, version: 3, text: "ل".repeat(7000) });
  assert.equal(edit.data.status, "applied", JSON.stringify(edit.data).slice(0, 300));
  assert.ok(resultBytes(edit.data) < GET_ROW_BYTE_BUDGET, `applied ${resultBytes(edit.data)}`);
  assertProjected(edit.data.part);
  assert.equal(edit.data.part.target_md, "ل".repeat(7000));

  // The web saves a long part, then the chat edits at the old version with long text.
  const web = webArticles(env, ctx);
  const p = await web(`/api/articles/ta/unit?path=${encodeURIComponent(ASIDE)}`, "PATCH", { target_md: "و".repeat(9000) }, { "If-Match": "4" });
  assert.equal(p.status, 200);
  const stale = await call("bpt_edit_article", { resource: "ta", path: ASIDE, version: 4, text: "م".repeat(9000) });
  assert.equal(stale.data.status, "conflict", JSON.stringify(stale.data).slice(0, 300));
  assert.ok(resultBytes(stale.data) < GET_ROW_BYTE_BUDGET, `conflict ${resultBytes(stale.data)}`);
  assertProjected(stale.data.current);
  assert.equal(stale.data.your_text, undefined, "the reviewer's own long text is left out first");
  assert.equal(stale.data.your_text_left_out, true);
  assert.equal(stale.data.current.target_md, "و".repeat(9000));
  assert.deepEqual([stale.data.current.version, stale.data.current.state], [5, "edited"]);

  // Current wording alone past the cap: only version and state, and a pointer to bpt_get_article.
  const p2 = await web(`/api/articles/ta/unit?path=${encodeURIComponent(ASIDE)}`, "PATCH", { target_md: "و".repeat(16000) }, { "If-Match": "5" });
  assert.equal(p2.status, 200);
  const huge = await call("bpt_edit_article", { resource: "ta", path: ASIDE, version: 5, text: "x" });
  assert.equal(huge.data.status, "conflict");
  assert.ok(resultBytes(huge.data) < GET_ROW_BYTE_BUDGET, `huge conflict ${resultBytes(huge.data)}`);
  assert.equal(huge.data.current.target_md, undefined);
  assert.equal(huge.data.current.target_left_out, true);
  assert.deepEqual([huge.data.current.version, huge.data.current.state], [6, "edited"]);
  assert.match(huge.data.message, /bpt_get_article/);

  // Approve: a stale pre-check conflict, a route 409 and an applied result all fit.
  const staleApprove = await call("bpt_approve_article", { resource: "ta", path: ASIDE, version: 5, state: "edited" });
  assert.equal(staleApprove.data.status, "conflict");
  assert.ok(resultBytes(staleApprove.data) < GET_ROW_BYTE_BUDGET);
  const ok = await call("bpt_approve_article", { resource: "ta", path: ASIDE, version: 6, state: "edited" });
  assert.equal(ok.data.status, "applied", JSON.stringify(ok.data).slice(0, 300));
  assert.ok(resultBytes(ok.data) < GET_ROW_BYTE_BUDGET, `approve ${resultBytes(ok.data)}`);
  assert.equal(ok.data.part.target_left_out, true);
  assert.deepEqual([ok.data.version, ok.data.state, ok.data.part.state], [6, "validated", "validated"]);
});

test("article approve: a route 409 carries only the projected part (no raw columns)", async () => {
  const { call, env, ctx, sqlite } = fresh();
  sqlite.prepare(`UPDATE article_units SET pre_draft_json = '{"target_md":"old"}', draft_meta_json = '{}' WHERE path = ?`).run(ASIDE);
  await webArticles(env, ctx)(`/api/articles/ta/unit/validate?path=${encodeURIComponent(ASIDE)}`, "POST", { value: 0 });
  const r = await call("bpt_approve_article", { resource: "ta", path: ASIDE, version: 3, state: "validated" });
  assert.equal(r.data.status, "conflict");
  assertProjected(r.data.current);
  assert.deepEqual(Object.keys(r.data.current).sort(), ["part", "path", "state", "target_md", "version"]);
});

test("article approve: a part whose translation is cleared between the check and the write says nothing to approve, not gone", async () => {
  const { call, sessions, sqlite, article, artLog } = fresh();
  const session = sessions[EDITOR];
  const send = session.send;
  session.send = async (method, path, body, ifMatch) => {
    if (method === "POST" && path.includes("/unit/validate")) {
      sqlite.prepare(`UPDATE article_units SET translation_state = NULL, target_md = NULL WHERE path = ?`).run(GOD);
    }
    return send(method, path, body, ifMatch);
  };
  const r = await call("bpt_approve_article", { resource: "tw", path: GOD, version: 1, state: "ai_draft" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /nothing to approve/);
  assert.doesNotMatch(r.data.error, /There is no/);
  assert.equal(article("tw", GOD).translation_state, null);
  assert.equal(artLog().length, 0);
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

test("a web un-approve and re-approve after the confirm read the rows, before that row's write, stays approved", async () => {
  // The confirm reads the chapter once, then writes row by row. The web flip
  // lands in that gap, so only the validate route's own updated_at pin can
  // see it: version and state are back to what the preview saw.
  for (const kind of ["tn", "tq"]) {
    const { env, ctx, call, sqlite, sessions, log } = fresh();
    seedBulk(sqlite);
    const table = kind === "tn" ? "tn_rows" : "tq_rows";
    const id = kind === "tn" ? "b001" : "qb01";
    const range = { ...RANGE, kind };
    const dry = await call("bpt_bulk_set_state", range);
    assert.ok(dry.data.confirm_token, JSON.stringify(dry.data));

    const session = sessions[EDITOR];
    const send = session.send;
    session.send = async (method, path, body, ifMatch) => {
      if (path.startsWith(`/api/rows/${kind}/${id}/validate`)) {
        assert.equal((await webPost(env, ctx, `/api/rows/${kind}/${id}/validate?book=${BOOK}`, { value: 0 })).status, 200);
        assert.equal((await webPost(env, ctx, `/api/rows/${kind}/${id}/validate?book=${BOOK}`, { value: 1 })).status, 200);
      }
      return send(method, path, body, ifMatch);
    };
    const logBefore = log().length;
    const r = await call("bpt_bulk_set_state", { ...range, confirm_token: dry.data.confirm_token });
    session.send = send;

    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.ok(!r.data.applied_ids.includes(id), JSON.stringify(r.data));
    const miss = r.data.not_changed.find((x) => x.id === id);
    assert.equal(miss?.reason, "changed_since_preview", JSON.stringify(r.data));
    assert.equal(miss.current_state, "validated");
    const row = sqlite.prepare(`SELECT translation_state FROM ${table} WHERE id = ?`).get(id);
    assert.equal(row.translation_state, "validated", `${kind}: the web re-approval is kept`);
    // Only the web's two flips for this row; no chat unvalidate entry for it.
    assert.deepEqual(
      log().slice(logBefore).filter((e) => e.row_key === id).map((e) => [e.action, e.source]),
      [["unvalidate", null], ["validate", null]],
    );
  }
});

test("validate with expected_updated_at: a moved updated_at is a 409 with current and changes nothing; a match applies", async () => {
  const { app, env, ctx, sqlite, log } = fresh();
  seedBulk(sqlite);
  const principal = { userId: 9, username: "reviewer", role: "editor", linkId: 1 };
  const post = (body) =>
    app.request(
      `/api/rows/tn/b001/validate?book=${BOOK}`,
      { method: "POST", headers: { "content-type": "application/json", "If-Match": "5" }, body: JSON.stringify(body) },
      chatWriteEnv(env, principal),
      ctx,
    );
  const stale = await post({ value: 0, expected_state: "validated", expected_updated_at: 999 });
  assert.equal(stale.status, 409);
  const sb = await stale.json();
  assert.equal(sb.error, "version_mismatch");
  assert.equal(sb.current.updated_at, 1000);
  assert.equal(tnRow2(sqlite, "b001").translation_state, "validated");
  assert.equal(log().length, 0);
  assert.equal(conflictLog(sqlite).length, 1);

  const bad = await post({ value: 0, expected_state: "validated", expected_updated_at: "soon" });
  assert.equal(bad.status, 400);

  const ok = await post({ value: 0, expected_state: "validated", expected_updated_at: 1000 });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(tnRow2(sqlite, "b001").translation_state, "edited");
  assert.deepEqual(log().map((e) => [e.row_key, e.action, e.source]), [["b001", "unvalidate", "chat"]]);
});

test("with no signing key the preview is a clear refusal and reads nothing", async () => {
  const { env, call, sqlite, d1 } = fresh();
  seedBulk(sqlite);
  delete env.JWT_SIGNING_KEY;
  const before = d1.calls;
  const r = await call("bpt_bulk_set_state", RANGE);
  assert.equal(r.isError, true, JSON.stringify(r.data));
  assert.match(r.data.error, /not set up on this server/);
  assert.match(r.data.error, /Nothing was changed/);
  assert.equal(d1.calls, before, "no chapter read before the refusal");
  assert.deepEqual(states(sqlite), BEFORE);
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

// Codex C1: updated_at has 1-second resolution, so a row written in the
// preview's own second could be flipped twice later that second and still
// match. The preview leaves such rows out of the token.
test("the preview leaves out an approved row written in its own second, and keeps one a second older", async (t) => {
  const { call, sqlite } = fresh();
  const nowSec = 2_000_000_000;
  t.mock.method(Date, "now", () => nowSec * 1000 + 500);
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state, updated_at) VALUES (?, ?, 4, 1, '4:1', 'n', 1, 'validated', ?)`,
  );
  tn.run("jn01", BOOK, nowSec);
  tn.run("jn02", BOOK, nowSec - 1);
  tn.run("jn03", BOOK, nowSec + 5); // a clock that wrote it ran ahead
  const r = await call("bpt_bulk_set_state", { kind: "tn", chapter: 4 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.would_change, 1);
  assert.deepEqual(r.data.rows.map((x) => x.id), ["jn02"]);
  assert.deepEqual(r.data.skipped, [
    { reason: "changed_just_now", why: r.data.skipped[0].why, count: 2, ids: ["jn01", "jn03"] },
  ]);
  assert.match(r.data.skipped[0].why, /preview again/);
  const payload = JSON.parse(Buffer.from(r.data.confirm_token.split(".")[0], "base64url").toString("utf8"));
  assert.deepEqual(payload.r.map((x) => x[0]), ["jn02"], "only the older row is in the token");
});

// Codex C2: BT Servant drops a result over 32 KB, token and all.
test("the preview lists at most 20 ids per skip reason, with the full count", async () => {
  const { call, sqlite } = fresh();
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state, updated_at) VALUES (?, ?, 5, 1, '5:1', 'n', 1, ?, 1000)`,
  );
  for (let i = 0; i < 25; i++) tn.run(`d${String(i).padStart(3, "0")}`, BOOK, "ai_draft");
  tn.run("v001", BOOK, "validated");
  const r = await call("bpt_bulk_set_state", { kind: "tn", chapter: 5 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  const ai = r.data.skipped.find((s) => s.reason === "ai_draft");
  assert.equal(ai.count, 25);
  assert.equal(ai.ids.length, 20);
  assert.equal(ai.ids[0], "d000");
  assert.equal(ai.more_ids_not_listed, 5);
  assert.equal(typeof r.data.confirm_token, "string");
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
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state, updated_at) VALUES (?, ?, 3, ?, ?, 'n', 1, 'validated', 1000)`,
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
