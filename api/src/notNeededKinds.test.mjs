// Tests for "Note kinds marked Not needed" (issue #158 part A,
// api/src/notNeededKinds.ts): on the suggestion inbox page, the tN note kinds
// (support_reference) editors keep marking Not needed, with a Dismiss.
//
// The routes run against the REAL schema (every file in api/migrations applied
// in order to node:sqlite), through the suggestionInbox app exactly as
// index.ts mounts it, so the route-order trap (GET /:book swallowing
// /not-needed-kinds) is covered too. Rows are marked the way the app marks
// them: setTnTrashed's UPDATE + 'trash' edit_log entry, and the nightly
// finalize's exact two statements (api/src/index.ts).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/notNeededKinds.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { suggestionInbox } from "./suggestionInbox.ts";
import { NOT_NEEDED_WINDOW_DAYS, MARKED_ROWS_SQL } from "./notNeededKinds.ts";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const YOU = "rc://*/ta/man/translate/figs-yousingular";
const YOU_ID = "figs-yousingular";

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
  return { prepare: (sql) => mk(sql, []), async batch(stmts) { return stmts.map((s) => s.run()); } };
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'boss')`).run();

  const app = new Hono();
  let role = "admin";
  app.use("*", async (c, next) => {
    c.set("userId", 1);
    c.set("role", role);
    await next();
  });
  app.route("/api/suggestion-inbox", suggestionInbox);
  const env = { DB: makeDb(sqlite) };
  const call = async (method, path, body) => {
    const res = await app.request(
      `/api/suggestion-inbox${path}`,
      { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let seq = 0;
  // A tN row of the given kind.
  const note = ({ book = "ZEC", chapter, kind = YOU }) => {
    const id = `n${String(++seq).padStart(3, "0")}`;
    sqlite
      .prepare(
        `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, support_reference, note, version)
         VALUES (?, ?, ?, 1, ?, ?, 'x', 1)`,
      )
      .run(id, book, chapter, `${chapter}:1`, kind);
    return { id, book };
  };
  // setTnTrashed: the row's trashed_at, then its 'trash' / 'untrash' entry.
  const mark = (row, trashed, at) => {
    sqlite.prepare(`UPDATE tn_rows SET trashed_at = ? WHERE id = ? AND book = ?`).run(trashed ? at : null, row.id, row.book);
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, created_at)
         VALUES ('tn', ?, ?, 1, 1, 1, ?, ?)`,
      )
      .run(row.id, row.book, trashed ? "trash" : "untrash", at);
  };
  // The nightly finalize, verbatim from api/src/index.ts.
  const finalize = () => {
    sqlite.exec(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
       SELECT 'tn', id, book, NULL, version, version, 'delete', 'nightly_finalize'
         FROM tn_rows WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
    );
    sqlite.exec(
      `UPDATE tn_rows SET deleted_at = trashed_at, trashed_at = NULL
        WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
    );
  };
  // n notes of a kind, marked Not needed `daysAgo` days ago, spread over the chapters.
  const marked = (n, chapters, { kind = YOU, book = "ZEC", daysAgo = 1 } = {}) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const row = note({ book, chapter: chapters[i % chapters.length], kind });
      mark(row, true, NOW - daysAgo * DAY);
      rows.push(row);
    }
    return rows;
  };
  return { sqlite, call, note, mark, finalize, marked, setRole: (r) => (role = r) };
}

const kinds = async (h) => {
  const r = await h.call("GET", "/not-needed-kinds");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.kinds;
};

test("the window is the issue's 30 days", () => {
  assert.equal(NOT_NEEDED_WINDOW_DAYS, 30);
});

test("10 notes of one kind marked Not needed across 3 chapters → one card; GET /:book does not swallow the route", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3]);
  const r = await h.call("GET", "/not-needed-kinds");
  assert.equal(r.status, 200);
  assert.equal(r.body.windowDays, 30);
  assert.equal(r.body.minNotes, 10);
  assert.equal(r.body.minChapters, 3);
  assert.equal(r.body.notMigrated, false);
  assert.deepEqual(r.body.kinds, [{ kind: YOU_ID, notes: 10, chapters: 3, books: ["ZEC"] }]);
});

test("9 notes, or 10 notes in only 2 chapters → no card", async () => {
  const a = fixture();
  a.marked(9, [1, 2, 3]);
  assert.deepEqual(await kinds(a), []);
  const b = fixture();
  b.marked(10, [1, 2]);
  assert.deepEqual(await kinds(b), []);
});

test("chapters are counted per book: chapter 1 of three books is 3 chapters", async () => {
  const h = fixture();
  h.marked(4, [1], { book: "ZEC" });
  h.marked(3, [1], { book: "LUK" });
  h.marked(3, [1], { book: "MAT" });
  assert.deepEqual(await kinds(h), [{ kind: YOU_ID, notes: 10, chapters: 3, books: ["ZEC", "MAT", "LUK"] }]);
});

test("a note finalized by the nightly export still counts", async () => {
  const h = fixture();
  h.marked(9, [1, 2, 3]);
  const last = h.marked(1, [4])[0];
  // Finalize everything marked so far, as the nightly tick does.
  h.finalize();
  const row = h.sqlite.prepare(`SELECT trashed_at, deleted_at FROM tn_rows WHERE id = ?`).get(last.id);
  assert.equal(row.trashed_at, null);
  assert.notEqual(row.deleted_at, null);
  assert.deepEqual(await kinds(h), [{ kind: YOU_ID, notes: 10, chapters: 4, books: ["ZEC"] }]);
});

test("a note restored after being marked does not count; marked again, it counts once", async () => {
  const h = fixture();
  h.marked(9, [1, 2, 3]);
  const row = h.marked(1, [3])[0];
  h.mark(row, false, NOW - DAY / 2);
  assert.deepEqual(await kinds(h), []);
  // Marked Not needed again: one note, two 'trash' entries → still 10.
  h.mark(row, true, NOW - DAY / 4);
  assert.deepEqual(await kinds(h), [{ kind: YOU_ID, notes: 10, chapters: 3, books: ["ZEC"] }]);
});

test("a mark older than 30 days does not count", async () => {
  const h = fixture();
  h.marked(9, [1, 2, 3]);
  h.marked(1, [3], { daysAgo: 31 });
  assert.deepEqual(await kinds(h), []);
});

test("a deleted note that was never finalized from Not needed does not count", async () => {
  const h = fixture();
  h.marked(9, [1, 2, 3]);
  const row = h.note({ chapter: 3 });
  h.mark(row, true, NOW - DAY);
  // Deleted another way (the delete route keeps no nightly_finalize entry).
  h.sqlite.prepare(`UPDATE tn_rows SET deleted_at = ? WHERE id = ?`).run(NOW, row.id);
  assert.deepEqual(await kinds(h), []);
});

test("full rc:// links and bare ids are one kind; empty kinds are never listed", async () => {
  const h = fixture();
  h.marked(5, [1, 2, 3]);
  h.marked(5, [1, 2, 3], { kind: YOU_ID });
  h.marked(10, [1, 2, 3], { kind: "" });
  h.marked(10, [1, 2, 3], { kind: null });
  assert.deepEqual(await kinds(h), [{ kind: YOU_ID, notes: 10, chapters: 3, books: ["ZEC"] }]);
});

test("cards are ordered by how many notes, most first", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3], { kind: "rc://*/ta/man/translate/figs-exclusive" });
  h.marked(12, [1, 2, 3]);
  assert.deepEqual((await kinds(h)).map((k) => [k.kind, k.notes]), [[YOU_ID, 12], ["figs-exclusive", 10]]);
});

test("dismiss hides the kind for good; dismissing a kind not shown → 404, nothing stored", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3]);
  const stray = await h.call("POST", "/not-needed-kinds/dismiss", { kind: "figs-exclusive" });
  assert.equal(stray.status, 404);
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM not_needed_kind_dismissals`).get().n, 0);

  const ok = await h.call("POST", "/not-needed-kinds/dismiss", { kind: YOU_ID });
  assert.equal(ok.status, 200);
  const stored = h.sqlite.prepare(`SELECT support_reference, dismissed_by FROM not_needed_kind_dismissals`).all();
  assert.deepEqual(stored.map((r) => ({ ...r })), [{ support_reference: YOU_ID, dismissed_by: 1 }]);
  assert.deepEqual(await kinds(h), []);
  // More marks later do not bring it back.
  h.marked(5, [4]);
  assert.deepEqual(await kinds(h), []);
  // Dismissed already, so not shown: 404 again.
  assert.equal((await h.call("POST", "/not-needed-kinds/dismiss", { kind: YOU_ID })).status, 404);
});

test("dismiss refuses a malformed body", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3]);
  for (const body of [{}, { kind: 3 }, { kind: YOU_ID, extra: 1 }]) {
    assert.equal((await h.call("POST", "/not-needed-kinds/dismiss", body)).status, 400, JSON.stringify(body));
  }
});

test("an editor gets 403 on both routes", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3]);
  h.setRole("editor");
  assert.equal((await h.call("GET", "/not-needed-kinds")).status, 403);
  assert.equal((await h.call("POST", "/not-needed-kinds/dismiss", { kind: YOU_ID })).status, 403);
});

test("without migration 0089 the list still shows and Dismiss answers 503", async () => {
  const h = fixture();
  h.marked(10, [1, 2, 3]);
  h.sqlite.exec(`DROP TABLE not_needed_kind_dismissals`);
  const r = await h.call("GET", "/not-needed-kinds");
  assert.equal(r.status, 200);
  assert.equal(r.body.notMigrated, true);
  assert.equal(r.body.kinds.length, 1);
  assert.equal((await h.call("POST", "/not-needed-kinds/dismiss", { kind: YOU_ID })).status, 503);
});

test("the query reads edit_log by time (edit_log_recent), not every tN edit ever (edit_log_row_by_book)", () => {
  const h = fixture();
  const plan = h.sqlite.prepare(`EXPLAIN QUERY PLAN ${MARKED_ROWS_SQL}`).all(NOW - 30 * DAY).map((r) => r.detail);
  assert.ok(plan.some((d) => /SEARCH e USING INDEX edit_log_recent \(created_at>\?\)/.test(d)), plan.join("\n"));
  // Only the marks scan (alias e); the per-row EXISTS lookup (alias f) may use edit_log_row_by_book.
  assert.ok(!plan.some((d) => /^(SEARCH|SCAN) e\b.*edit_log_row_by_book/.test(d)), plan.join("\n"));
});
