// Issue #880: the row PATCH accepts an optional expected_state that pins the
// note's translation_state, the way /validate's expected_state does (#837).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/rowPatchStatePin.test.mjs
//
// THE BUG. Approving a note does not bump its version, so the PATCH's If-Match
// cannot see an approval. When the Rapid check assistant's Apply saves a
// proposed note text after a colleague approved that note (and this tab has
// not refetched, or the approval lands between the client's check and the
// save), the PATCH succeeds and its edit demotes the newly approved note back
// to 'edited'.
//
// THE FIX. With expected_state in the body, the edit lands only if the note is
// still in that state (checked inside the UPDATE, so an approval racing the
// save is caught too); otherwise 409 state_mismatch with the row as it is now,
// and nothing changes. Without the field, the PATCH behaves exactly as before.
//
// Same harness as trashIfMatch.test.mjs: the REAL Hono router against the
// REAL migration schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";

// `beforeUpdate(sql)` runs just before any UPDATE statement, so a test can
// land a colleague's approval between the route's SELECT and its UPDATE.
function makeDb(sqlite, hooks) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    async run() {
      if (/^\s*UPDATE\s+tn_rows/i.test(sql)) hooks.beforeUpdate?.(sql);
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

const BOOK = "ZEC";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  const ins = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, translation_state)
     VALUES (?, ?, 1, ?, ?, 'note text', 10, 3, 9, ?)`,
  );
  ins.run("draft", BOOK, 1, "1:1", "ai_draft");
  // Approved by a colleague after this tab's proposal saw it as ai_draft:
  // same version (approving does not bump it), different state.
  ins.run("approved", BOOK, 2, "1:2", "validated");
  // A note with no translation state (English root).
  ins.run("plain", BOOK, 3, "1:3", null);
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, updated_by, translation_state)
       VALUES ('q1', ?, 1, 1, '1:1', 'q?', 'a.', 3, 9, 'validated')`,
    )
    .run(BOOK);

  const hooks = {};
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  const env = { DB: makeDb(sqlite, hooks) };
  const pending = [];
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.then === "function") pending.push(p);
    },
    passThroughOnException() {},
  };
  const settle = () => Promise.allSettled(pending.splice(0));
  const patch = (id, ifMatch, body, kind = "tn") =>
    app.request(
      `/api/rows/${kind}/${id}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "If-Match": ifMatch, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  const row = (id) =>
    sqlite.prepare(`SELECT version, note, translation_state FROM tn_rows WHERE id = ?`).get(id);
  const updates = (id) =>
    sqlite.prepare(`SELECT payload_json FROM edit_log WHERE row_key = ? AND action = 'update'`).all(id);
  const conflicts = (id) =>
    sqlite.prepare(`SELECT action, expected_version, current_version FROM row_conflict_log WHERE row_id = ?`).all(id);
  return { patch, row, updates, conflicts, settle, sqlite, hooks };
}

test("a stale expected_state is refused with 409 state_mismatch and the approved note stays approved", async () => {
  const { patch, row, updates, conflicts, settle } = fresh();
  const res = await patch("approved", "3", { note: "assistant text", expected_state: "ai_draft" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "state_mismatch");
  assert.equal(body.current?.id, "approved", "the 409 carries the row as it is now");
  assert.equal(body.current?.translation_state, "validated");
  assert.equal(body.current?.version, 3);
  assert.deepEqual({ ...row("approved") }, { version: 3, note: "note text", translation_state: "validated" });
  assert.equal(updates("approved").length, 0, "a refused edit writes no audit entry");
  await settle();
  assert.deepEqual(
    conflicts("approved").map((r) => ({ ...r })),
    [{ action: "patch", expected_version: 3, current_version: 3 }],
    "the refusal is recorded in row_conflict_log",
  );
});

test("an approval landing between the route's read and its UPDATE is still refused", async () => {
  const { patch, row, updates, sqlite, hooks } = fresh();
  let fired = false;
  hooks.beforeUpdate = () => {
    if (fired) return;
    fired = true;
    sqlite.prepare(`UPDATE tn_rows SET translation_state = 'validated' WHERE id = 'draft'`).run();
  };
  const res = await patch("draft", "3", { note: "assistant text", expected_state: "ai_draft" });
  assert.ok(fired, "the approval was injected before the edit's UPDATE");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "state_mismatch");
  assert.deepEqual({ ...row("draft") }, { version: 3, note: "note text", translation_state: "validated" });
  assert.equal(updates("draft").length, 0);
});

test("a matching expected_state saves the edit (demoting the draft to edited) and is not stored", async () => {
  const { patch, row, updates } = fresh();
  const res = await patch("draft", "3", { note: "assistant text", expected_state: "ai_draft" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.note, "assistant text");
  assert.deepEqual({ ...row("draft") }, { version: 4, note: "assistant text", translation_state: "edited" });
  const log = updates("draft");
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0].payload_json), { note: "assistant text" }, "the pin is not part of the edit");
});

test("without expected_state the PATCH behaves as before: an approved note is edited and demoted", async () => {
  const { patch, row } = fresh();
  const res = await patch("approved", "3", { note: "typed text" });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...row("approved") }, { version: 4, note: "typed text", translation_state: "edited" });
});

test("a stale version with a stale pin is still a plain version_mismatch", async () => {
  const { patch, row } = fresh();
  const res = await patch("approved", "2", { note: "assistant text", expected_state: "ai_draft" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "version_mismatch");
  assert.equal(row("approved").note, "note text");
});

test("an identical text with a stale pin is refused, not a 200 no-op", async () => {
  const { patch, row } = fresh();
  const res = await patch("approved", "3", { note: "note text", expected_state: "ai_draft" });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "state_mismatch");
  assert.equal(row("approved").translation_state, "validated");
});

test("expected_state null pins 'still has no state'", async () => {
  const { patch, row } = fresh();
  const ok = await patch("plain", "3", { note: "new", expected_state: null });
  assert.equal(ok.status, 200);
  assert.equal(row("plain").note, "new");
  const stale = await patch("draft", "3", { note: "new", expected_state: null });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, "state_mismatch");
  assert.equal(row("draft").note, "note text");
});

test("tq rows take the same pin", async () => {
  const { patch, sqlite } = fresh();
  const res = await patch("q1", "3", { question: "new?", expected_state: "ai_draft" }, "tq");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "state_mismatch");
  assert.equal(sqlite.prepare(`SELECT question FROM tq_rows WHERE id = 'q1'`).get().question, "q?");
});

// #883 item 5: trashing does not bump the version, and a content edit
// un-trashes a note, so a pinned (assistant) edit must not revive a note
// someone set aside since the proposal. The assistant is never sent trashed
// notes, so a pin always means "not set aside".
const trashedRow = (sqlite, id) =>
  sqlite.prepare(`SELECT version, note, translation_state, trashed_at FROM tn_rows WHERE id = ?`).get(id);

test("a pinned edit to a note set aside since the proposal is refused and the note stays set aside (#883)", async () => {
  const { patch, sqlite, updates } = fresh();
  sqlite.prepare(`UPDATE tn_rows SET trashed_at = 1700000000 WHERE id = 'draft'`).run();
  const res = await patch("draft", "3", { note: "assistant text", expected_state: "ai_draft" });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "state_mismatch");
  assert.equal(body.current?.trashed_at, 1700000000);
  assert.deepEqual({ ...trashedRow(sqlite, "draft") }, { version: 3, note: "note text", translation_state: "ai_draft", trashed_at: 1700000000 });
  assert.equal(updates("draft").length, 0);
});

test("a set-aside landing between the route's read and its UPDATE is refused too (#883)", async () => {
  const { patch, sqlite, hooks, updates } = fresh();
  let fired = false;
  hooks.beforeUpdate = () => {
    if (fired) return;
    fired = true;
    sqlite.prepare(`UPDATE tn_rows SET trashed_at = 1700000000 WHERE id = 'draft'`).run();
  };
  const res = await patch("draft", "3", { note: "assistant text", expected_state: "ai_draft" });
  assert.ok(fired);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "state_mismatch");
  assert.equal(trashedRow(sqlite, "draft").trashed_at, 1700000000);
  assert.equal(trashedRow(sqlite, "draft").note, "note text");
  assert.equal(updates("draft").length, 0);
});

test("an unpinned (typed) edit to a set-aside note still revives it, as before (#883)", async () => {
  const { patch, sqlite } = fresh();
  sqlite.prepare(`UPDATE tn_rows SET trashed_at = 1700000000 WHERE id = 'draft'`).run();
  const res = await patch("draft", "3", { note: "typed text" });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...trashedRow(sqlite, "draft") }, { version: 4, note: "typed text", translation_state: "edited", trashed_at: null });
});

test("an invalid expected_state is a 400 and nothing changes", async () => {
  const { patch, row } = fresh();
  for (const bad of ["approved", 1, ""]) {
    const res = await patch("draft", "3", { note: "x", expected_state: bad });
    assert.equal(res.status, 400, `expected_state ${JSON.stringify(bad)}`);
  }
  assert.equal(row("draft").note, "note text");
});
