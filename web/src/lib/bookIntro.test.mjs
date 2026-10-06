import test from "node:test";
import assert from "node:assert/strict";
import { selectBookIntroRows } from "./bookIntro.ts";

const ch = (chapter) => ({ chapter, verses: 0, tn: 0, tq: 0, twl: 0 });
const summary = { book: "ZEC", chapters: [ch(0), ch(1), ch(2)] };
const row = (id, sort_order) => ({ id, chapter: 0, verse: 0, sort_order });
const ready = (...rows) => ({ kind: "ready", data: { tn: rows } });
const cache = (state) => new Map([[0, state]]);

const base = { mode: "book", chapter: 1, summary, chapters: cache(ready(row("a", 100))) };

test("book mode on the first real chapter shows the chapter-0 rows", () => {
  assert.deepEqual(selectBookIntroRows(base).map((r) => r.id), ["a"]);
});

test("rows keep stored order: sort_order, then id", () => {
  const chapters = cache(ready(row("c", 200), row("b", 100), row("a", 100)));
  assert.deepEqual(selectBookIntroRows({ ...base, chapters }).map((r) => r.id), ["a", "b", "c"]);
});

test("trashed rows sink last, keeping their relative order", () => {
  const t = (id, sort_order) => ({ ...row(id, sort_order), trashed_at: 5 });
  const chapters = cache(ready(t("a", 100), row("b", 200), row("c", 300), t("d", 50)));
  assert.deepEqual(selectBookIntroRows({ ...base, chapters }).map((r) => r.id), ["b", "c", "d", "a"]);
});

test("rows and columns modes show nothing", () => {
  assert.deepEqual(selectBookIntroRows({ ...base, mode: "rows" }), []);
  assert.deepEqual(selectBookIntroRows({ ...base, mode: "columns" }), []);
});

test("only the first real chapter shows it", () => {
  assert.deepEqual(selectBookIntroRows({ ...base, chapter: 2 }), []);
  // Chapter 0 itself is a real destination (TopBar "Intro"): its rows are the
  // active chapter's own, so they must not be listed a second time.
  assert.deepEqual(selectBookIntroRows({ ...base, chapter: 0 }), []);
});

test("first real chapter is the lowest chapter >= 1, not literally 1", () => {
  const s = { book: "X", chapters: [ch(0), ch(3), ch(4)] };
  assert.equal(selectBookIntroRows({ ...base, summary: s, chapter: 3 }).length, 1);
  assert.equal(selectBookIntroRows({ ...base, summary: s, chapter: 1 }).length, 0);
});

test("no summary, no chapter-0 cache entry, or an unready one shows nothing", () => {
  assert.deepEqual(selectBookIntroRows({ ...base, summary: null }), []);
  assert.deepEqual(selectBookIntroRows({ ...base, chapters: undefined }), []);
  assert.deepEqual(selectBookIntroRows({ ...base, chapters: new Map() }), []);
  for (const kind of ["unloaded", "loading", "error"]) {
    assert.deepEqual(selectBookIntroRows({ ...base, chapters: cache({ kind }) }), []);
  }
});

test("a book whose chapter 0 has no notes shows nothing", () => {
  assert.deepEqual(selectBookIntroRows({ ...base, chapters: cache(ready()) }), []);
});
