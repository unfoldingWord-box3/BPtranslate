import { test } from "node:test";
import assert from "node:assert/strict";
import { chapterSpans, currentIndexAt, spanFor, spanIndexOf } from "./verseSpans.ts";

// An expanded index the way buildVerseIndex makes one: every verse a row
// covers points at the SAME row object.
function index(rows) {
  const out = {};
  for (const r of rows) {
    for (let v = r.verse; v <= (r.verse_end ?? r.verse); v++) out[v] = r;
  }
  return out;
}

const singles = (n) => Array.from({ length: n }, (_, i) => ({ verse: i + 1 }));

test("spanFor: a plain verse is its own span", () => {
  assert.deepEqual(spanFor(3, [index(singles(5))]), { start: 3, end: 3 });
});

test("spanFor: grows to cover a bridged row in any lane", () => {
  const src = index(singles(6));
  const lit = index([{ verse: 1 }, { verse: 2, verse_end: 3 }, { verse: 4 }, { verse: 5 }, { verse: 6 }]);
  const sim = index([{ verse: 1 }, { verse: 2 }, { verse: 3, verse_end: 4 }, { verse: 5 }, { verse: 6 }]);
  // 2-3 in the literal lane chains into 3-4 in the simplified lane.
  assert.deepEqual(spanFor(2, [src, lit, sim]), { start: 2, end: 4 });
  assert.deepEqual(spanFor(4, [src, lit, sim]), { start: 2, end: 4 });
});

test("chapterSpans: one span per verse, one section per bridge", () => {
  const src = index(singles(6));
  const lit = index([{ verse: 1 }, { verse: 2, verse_end: 3 }, { verse: 4 }, { verse: 5 }, { verse: 6 }]);
  assert.deepEqual(chapterSpans([1, 2, 3, 4, 5, 6], [src, lit]), [
    { start: 1, end: 1 },
    { start: 2, end: 3 },
    { start: 4, end: 4 },
    { start: 5, end: 5 },
    { start: 6, end: 6 },
  ]);
});

test("chapterSpans: empty chapter gives no spans", () => {
  assert.deepEqual(chapterSpans([], [{}]), []);
});

test("spanIndexOf finds the span holding a bridged verse", () => {
  const spans = [{ start: 1, end: 1 }, { start: 2, end: 3 }, { start: 4, end: 4 }];
  assert.equal(spanIndexOf(spans, 3), 1);
  assert.equal(spanIndexOf(spans, 4), 2);
  assert.equal(spanIndexOf(spans, 9), -1);
});

test("currentIndexAt: last top at or above the anchor line", () => {
  const tops = [-900, -300, 40, 500, 1100];
  assert.equal(currentIndexAt(tops, 100), 2);
  assert.equal(currentIndexAt(tops, 40), 2);
  assert.equal(currentIndexAt(tops, 39), 1);
  assert.equal(currentIndexAt(tops, 5000), 4);
  // Every section below the line: the first one is current.
  assert.equal(currentIndexAt([200, 600], 100), 0);
  assert.equal(currentIndexAt([], 100), 0);
});
