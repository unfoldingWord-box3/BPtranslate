// Issue #837: Not needed (POST /api/rows/tn/:id/trash) accepts an optional
// If-Match pinning the version the person was shown.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/trashIfMatch.test.mjs
//
// THE BUG. /trash took no precondition, so "Not needed" could set aside a
// note a colleague edited a moment earlier, and the person clicking never saw
// that edit. Rapid check's bulk Not needed re-reads the chapter first, which
// narrows the gap to the time between that read and the trash request; the
// single-note button had no check at all.
//
// THE FIX. With If-Match, the trash lands only if the row is still at that
// version; otherwise 409 version_mismatch with the row as it is now, and no
// trash and no audit entry. Without the header, the route behaves as before.
//
// Same harness as chapterLockApproveTrash.test.mjs: the REAL Hono router
// against the REAL migration schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";

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
  // A note the translate pipeline never touched: /trash works on these too,
  // so a stale pin must still be a 409, not a 404.
  ins.run("plain", BOOK, 2, "1:2", null);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const trash = (id, ifMatch) =>
    app.request(
      `/api/rows/tn/${id}/trash?book=${BOOK}`,
      { method: "POST", headers: ifMatch === undefined ? {} : { "If-Match": ifMatch } },
      env,
      ctx,
    );
  const row = (id) => sqlite.prepare(`SELECT version, trashed_at FROM tn_rows WHERE id = ?`).get(id);
  const trashLog = (id) =>
    sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE row_key = ? AND action = 'trash'`).get(id).n;
  const conflicts = (id) =>
    sqlite.prepare(`SELECT action, expected_version, current_version FROM row_conflict_log WHERE row_id = ?`).all(id);
  return { trash, row, trashLog, conflicts, sqlite };
}

test("a stale If-Match is refused with 409 version_mismatch and the note is not set aside", async () => {
  const { trash, row, trashLog, conflicts } = fresh();
  const res = await trash("draft", "2");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "version_mismatch");
  assert.equal(body.current?.id, "draft", "the 409 carries the row as it is now");
  assert.equal(body.current?.version, 3);
  assert.equal(body.current?.trashed_at, null);
  assert.equal(row("draft").trashed_at, null, "the note was not trashed");
  assert.equal(trashLog("draft"), 0, "a refused trash writes no audit entry");
  assert.deepEqual(
    conflicts("draft").map((r) => ({ ...r })),
    [{ action: "trash", expected_version: 2, current_version: 3 }],
    "the refusal is recorded in row_conflict_log as a trash",
  );
});

test("a stale If-Match on a note with no translation state is still a 409, not a 404", async () => {
  const { trash, row } = fresh();
  const res = await trash("plain", "7");
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "version_mismatch");
  assert.equal(row("plain").trashed_at, null);
});

test("a matching If-Match sets the note aside", async () => {
  const { trash, row, trashLog } = fresh();
  for (const header of ["3", '"3"']) {
    const id = header === "3" ? "draft" : "plain";
    const res = await trash(id, header);
    assert.equal(res.status, 200, `If-Match: ${header}`);
    const body = await res.json();
    assert.notEqual(body.trashed_at, null);
    assert.equal(body.version, 3, "trash does not bump the version");
    assert.notEqual(row(id).trashed_at, null);
    assert.equal(trashLog(id), 1);
  }
});

test("no If-Match keeps today's behavior: the note is set aside", async () => {
  const { trash, row, trashLog } = fresh();
  const res = await trash("draft");
  assert.equal(res.status, 200);
  assert.notEqual(row("draft").trashed_at, null);
  assert.equal(trashLog("draft"), 1);
});

test("a malformed If-Match is a 400, as on /validate, and nothing changes", async () => {
  const { trash, row } = fresh();
  const res = await trash("draft", "abc");
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_if_match");
  assert.equal(row("draft").trashed_at, null);
});

test("an unknown note is still a 404 with or without If-Match", async () => {
  const { trash } = fresh();
  assert.equal((await trash("nope", "3")).status, 404);
  assert.equal((await trash("nope")).status, 404);
});
