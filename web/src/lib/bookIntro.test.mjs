import test from "node:test";
import assert from "node:assert/strict";
import { selectBookIntroRows } from "./bookIntro.ts";

const ch = (chapter) => ({ chapter, verses: 0, tn: 0, tq: 0, twl: 0 });
const summary = { book: "ZEC", chapters: [ch(0), ch(1), ch(2)] };
const row = (id, sort_order) => ({ id, chapter: 0, verse: 0, sort_order });
const ready = (...rows) => ({ kind: "ready", data: { tn: rows } });
const cache = (state) => new Map([[0, state]]);

const base = { mode: "book", chapter: 1, shownChapter: 1, summary, chapters: cache(ready(row("a", 100))) };

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

// #567: going from the chapter-0 view to chapter 1, useChapter still holds
// chapter 0 (whose notes ARE the intro rows) until chapter 1 loads, so listing
// the cache's copy as well showed every intro card twice for a few seconds.
test("nothing while the open chapter's data is still another chapter's", () => {
  assert.deepEqual(selectBookIntroRows({ ...base, shownChapter: 0 }), []);
  assert.deepEqual(selectBookIntroRows({ ...base, shownChapter: 2 }), []);
  assert.deepEqual(selectBookIntroRows({ ...base, shownChapter: undefined }), []);
});

// #562 review B1: Refresh after an AI apply must reload chapter 0 even when it
// has no intro notes yet (the run may have just written the first ones).
test("refreshReloadsIntro: whenever the intro room is open or chapter 0 is cached", async () => {
  const { refreshReloadsIntro } = await import("./bookIntro.ts");
  assert.equal(refreshReloadsIntro({ introRoom: 0, front: ready() }), true, "ready with zero rows");
  assert.equal(refreshReloadsIntro({ introRoom: 0, front: undefined }), true);
  assert.equal(refreshReloadsIntro({ introRoom: null, front: ready(row("a", 1)) }), true);
  assert.equal(refreshReloadsIntro({ introRoom: null, front: { kind: "loading" } }), false);
  assert.equal(refreshReloadsIntro({ introRoom: null, front: undefined }), false);
});

// #562 item 1: book mode on the first real chapter also listens to the
// chapter-0 room, so intro edits and intro-only AI hints reach this tab.
test("introRoomChapter: book mode on the first real chapter of a book with a front", async () => {
  const { introRoomChapter } = await import("./bookIntro.ts");
  assert.equal(introRoomChapter({ mode: "book", chapter: 1, summary }), 0);
  assert.equal(introRoomChapter({ mode: "rows", chapter: 1, summary }), null);
  assert.equal(introRoomChapter({ mode: "book", chapter: 2, summary }), null);
  // Already in the chapter-0 room as the open chapter.
  assert.equal(introRoomChapter({ mode: "book", chapter: 0, summary }), null);
  assert.equal(introRoomChapter({ mode: "book", chapter: 1, summary: { book: "ZEC", chapters: [ch(1), ch(2)] } }), null);
  assert.equal(introRoomChapter({ mode: "book", chapter: 1, summary: null }), null);
});
