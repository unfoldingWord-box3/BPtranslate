// bookRollup.test.mjs — executable node:sqlite test for the book-level
// approval/validation rollup served by GET /api/chapters/:book (issue #104).
//
// It runs the REAL statements (imported from bookRollupSql.ts, which is why
// they live in their own dependency-free module) against a seeded in-memory
// SQLite, so the assertions cover the actual SQL, not a paraphrase of it.
//
// What it pins down:
//   * every translation_state lands in the right bucket (validated / ai_draft
//     / edited / NULL→NoState), per chapter;
//   * trashed and deleted rows are excluded — from the buckets AND from the
//     totals, identically;
//   * the four state buckets sum EXACTLY to the chapter's tn / tq total, which
//     is the property that makes "n of N approved" honest (#238 denominator);
//   * versesDone counts verse_statuses.done only, and never the phantom
//     verse 0;
//   * a book with no rows yields no rows (no fabricated zeros).
//
// Run: node --experimental-strip-types --no-warnings --test src/bookRollup.test.mjs

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";

import { BOOK_REVIEW_ROLLUP_SQL, BOOK_SUMMARY_COUNTS_SQL } from "./bookRollupSql.ts";

// Only the columns the two statements touch. The real schema has many more;
// including them here would just couple this test to unrelated migrations.
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE verses (
      book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
      bible_version TEXT NOT NULL, source_generation INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tn_rows (
      id TEXT, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER,
      translation_state TEXT, deleted_at INTEGER, trashed_at INTEGER
    );
    CREATE TABLE tq_rows (
      id TEXT, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER,
      translation_state TEXT, deleted_at INTEGER
    );
    CREATE TABLE twl_rows (
      id TEXT, book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER,
      deleted_at INTEGER
    );
    CREATE TABLE verse_statuses (
      book TEXT NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

const addVerse = (db, book, chapter, verse, bv = "ULT", gen = 1) =>
  db.prepare(`INSERT INTO verses (book, chapter, verse, bible_version, source_generation) VALUES (?,?,?,?,?)`)
    .run(book, chapter, verse, bv, gen);

const addTn = (db, book, chapter, state, { deleted = null, trashed = null } = {}) =>
  db.prepare(`INSERT INTO tn_rows (book, chapter, verse, translation_state, deleted_at, trashed_at) VALUES (?,?,1,?,?,?)`)
    .run(book, chapter, state, deleted, trashed);

const addTq = (db, book, chapter, state, { deleted = null } = {}) =>
  db.prepare(`INSERT INTO tq_rows (book, chapter, verse, translation_state, deleted_at) VALUES (?,?,1,?,?)`)
    .run(book, chapter, state, deleted);

const addStatus = (db, book, chapter, verse, done) =>
  db.prepare(`INSERT INTO verse_statuses (book, chapter, verse, done) VALUES (?,?,?,?)`)
    .run(book, chapter, verse, done ? 1 : 0);

const rollup = (db, book) => {
  const byChapter = new Map();
  for (const r of db.prepare(BOOK_REVIEW_ROLLUP_SQL).all(book)) byChapter.set(r.chapter, r);
  return byChapter;
};
const counts = (db, book, gen = 1) => {
  const byChapter = new Map();
  for (const r of db.prepare(BOOK_SUMMARY_COUNTS_SQL).all(book, gen)) byChapter.set(r.chapter, r);
  return byChapter;
};

test("tn rows bucket by translation_state, per chapter", () => {
  const db = makeDb();
  addTn(db, "ZEC", 1, "validated");
  addTn(db, "ZEC", 1, "validated");
  addTn(db, "ZEC", 1, "ai_draft");
  addTn(db, "ZEC", 1, "edited");
  addTn(db, "ZEC", 1, null); // never touched by the translate pipeline
  addTn(db, "ZEC", 2, "ai_draft");

  const r = rollup(db, "ZEC");
  assert.equal(r.get(1).tnValidated, 2);
  assert.equal(r.get(1).tnAiDraft, 1);
  assert.equal(r.get(1).tnEdited, 1);
  assert.equal(r.get(1).tnNoState, 1);
  assert.equal(r.get(2).tnAiDraft, 1);
  assert.equal(r.get(2).tnValidated, 0, "chapter 2 has no validated notes");
});

test("tq rows bucket by translation_state, independently of tn", () => {
  const db = makeDb();
  addTn(db, "ZEC", 1, "validated");
  addTq(db, "ZEC", 1, "validated");
  addTq(db, "ZEC", 1, "edited");
  addTq(db, "ZEC", 1, null);

  const r = rollup(db, "ZEC").get(1);
  assert.equal(r.tqValidated, 1);
  assert.equal(r.tqEdited, 1);
  assert.equal(r.tqAiDraft, 0);
  assert.equal(r.tqNoState, 1);
  assert.equal(r.tnValidated, 1, "tn bucket is not polluted by tq rows");
  assert.equal(r.tqEdited + r.tqValidated + r.tqAiDraft + r.tqNoState, 3);
});

test("trashed and deleted rows are excluded from the buckets", () => {
  const db = makeDb();
  addTn(db, "ZEC", 1, "validated");
  addTn(db, "ZEC", 1, "validated", { trashed: 1700000000 });
  addTn(db, "ZEC", 1, "validated", { deleted: 1700000000 });
  addTn(db, "ZEC", 1, "ai_draft", { trashed: 1700000000 });
  addTq(db, "ZEC", 1, "validated");
  addTq(db, "ZEC", 1, "validated", { deleted: 1700000000 });

  const r = rollup(db, "ZEC").get(1);
  assert.equal(r.tnValidated, 1, "trashed + deleted validated notes are not counted");
  assert.equal(r.tnAiDraft, 0, "a trashed draft is not counted");
  assert.equal(r.tqValidated, 1, "a deleted question is not counted");
});

test("state buckets sum exactly to the tn / tq totals the same endpoint reports", () => {
  const db = makeDb();
  // Chapter 0 (book front matter) participates too — the endpoint reports it
  // and the client filters it, so the invariant must hold there as well.
  for (const chapter of [0, 1, 2]) {
    addTn(db, "ZEC", chapter, "validated");
    addTn(db, "ZEC", chapter, "ai_draft");
    addTn(db, "ZEC", chapter, "edited");
    addTn(db, "ZEC", chapter, null);
    addTn(db, "ZEC", chapter, "validated", { trashed: 1 });
    addTn(db, "ZEC", chapter, null, { deleted: 1 });
    addTq(db, "ZEC", chapter, "validated");
    addTq(db, "ZEC", chapter, null);
    addTq(db, "ZEC", chapter, "ai_draft", { deleted: 1 });
    addVerse(db, "ZEC", chapter, 1);
  }
  const c = counts(db, "ZEC");
  const r = rollup(db, "ZEC");
  for (const chapter of [0, 1, 2]) {
    const cc = c.get(chapter);
    const rr = r.get(chapter);
    assert.equal(cc.tn, 4, `chapter ${chapter}: 4 live notes`);
    assert.equal(cc.tq, 2, `chapter ${chapter}: 2 live questions`);
    assert.equal(
      rr.tnValidated + rr.tnAiDraft + rr.tnEdited + rr.tnNoState,
      cc.tn,
      `chapter ${chapter}: tn buckets sum to the tn total`,
    );
    assert.equal(
      rr.tqValidated + rr.tqAiDraft + rr.tqEdited + rr.tqNoState,
      cc.tq,
      `chapter ${chapter}: tq buckets sum to the tq total`,
    );
  }
});

test("an unrecognised translation_state falls into the NoState bucket, keeping the sum exact", () => {
  // No code path writes a fourth state today; this pins the behaviour so a
  // future one can never silently vanish from the denominator.
  const db = makeDb();
  addTn(db, "ZEC", 1, "some_future_state");
  addTn(db, "ZEC", 1, "validated");
  const r = rollup(db, "ZEC").get(1);
  const c = counts(db, "ZEC").get(1);
  assert.equal(r.tnNoState, 1);
  assert.equal(r.tnValidated + r.tnAiDraft + r.tnEdited + r.tnNoState, c.tn);
});

test("versesDone counts done verse statuses only, never verse 0", () => {
  const db = makeDb();
  addStatus(db, "ZEC", 1, 1, true);
  addStatus(db, "ZEC", 1, 2, true);
  addStatus(db, "ZEC", 1, 3, false);
  addStatus(db, "ZEC", 0, 0, true); // phantom verse 0 (#230)
  addStatus(db, "ZEC", 2, 1, false);

  const r = rollup(db, "ZEC");
  assert.equal(r.get(1).versesDone, 2);
  // The rollup emits a row only for chapters with at least one contributing
  // row; the route merges it against the count query's chapter list and
  // defaults the missing ones to 0 (chapters.ts), so a chapter whose only
  // status is not-done, or is the phantom verse 0, still reports 0 — never
  // "unknown" and never omitted from the response.
  assert.equal(r.get(0), undefined, "chapter 0's only status is verse 0 — contributes nothing");
  assert.equal(r.get(2), undefined, "a not-done status contributes nothing");
});

test("rows from other books never leak into a book's rollup", () => {
  const db = makeDb();
  addTn(db, "ZEC", 1, "validated");
  addTn(db, "OBA", 1, "validated");
  addTq(db, "OBA", 1, "validated");
  addStatus(db, "OBA", 1, 1, true);

  const r = rollup(db, "ZEC").get(1);
  assert.equal(r.tnValidated, 1);
  assert.equal(r.tqValidated, 0);
  assert.equal(r.versesDone, 0);
});

test("a book with no rows yields no chapters (absence, not fabricated zeros)", () => {
  const db = makeDb();
  assert.equal(rollup(db, "ZEC").size, 0);
  assert.equal(counts(db, "ZEC").size, 0);
});
