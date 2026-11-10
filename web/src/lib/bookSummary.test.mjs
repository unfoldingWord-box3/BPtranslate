import test from "node:test";
import assert from "node:assert/strict";
import { nextRealChapter, realChapters, realChapterNumbers } from "./bookSummary.ts";

const row = (chapter, tn = 0) => ({ chapter, verses: 0, tn, tq: 0, twl: 0 });

test("realChapters drops the chapter-0 front-matter entry", () => {
  // OBA: one real chapter plus book-intro notes -> must count as 1, not 2.
  const oba = { book: "OBA", chapters: [row(0, 8), row(1, 146)] };
  assert.equal(realChapters(oba).length, 1);
  assert.deepEqual(realChapterNumbers(oba), [1]);
});

test("realChapters keeps every real chapter", () => {
  const zec = { book: "ZEC", chapters: [row(0), ...Array.from({ length: 14 }, (_, i) => row(i + 1))] };
  assert.equal(realChapters(zec).length, 14);
  assert.deepEqual(realChapterNumbers(zec).slice(0, 3), [1, 2, 3]);
});

test("realChapterNumbers sorts and tolerates a missing summary", () => {
  assert.deepEqual(realChapterNumbers({ book: "X", chapters: [row(3), row(0), row(1)] }), [1, 3]);
  assert.deepEqual(realChapterNumbers(null), []);
  assert.deepEqual(realChapters(undefined), []);
});

test("nextRealChapter gives the chapter after this one, or null at the end", () => {
  const zec = { book: "ZEC", chapters: [row(0), ...Array.from({ length: 14 }, (_, i) => row(i + 1))] };
  assert.equal(nextRealChapter(zec, 1), 2);
  assert.equal(nextRealChapter(zec, 13), 14);
  // Last chapter: nothing to continue to.
  assert.equal(nextRealChapter(zec, 14), null);
  // A gap in what was imported skips to the next chapter that exists.
  assert.equal(nextRealChapter({ book: "PSA", chapters: [row(119), row(121), row(0)] }, 119), 121);
  // Unknown (loading or failed) summary: no next chapter is offered.
  assert.equal(nextRealChapter(null, 1), null);
  assert.equal(nextRealChapter(undefined, 1), null);
});
