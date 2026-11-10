import test from "node:test";
import assert from "node:assert/strict";
import { rapidStatusBucket, rapidStatusMatches, withOpenNote, RAPID_STATUS_BUCKETS } from "./rapidStatusFilter.ts";

test("chip statuses group by the label tn shows", () => {
  assert.equal(rapidStatusBucket("aiDraft"), "draft");
  assert.equal(rapidStatusBucket("draft"), "draft");
  assert.equal(rapidStatusBucket("editing"), "unsaved");
  assert.equal(rapidStatusBucket("unsaved"), "unsaved");
  for (const s of ["approved", "skipped", "pending", "aquifer"]) assert.equal(rapidStatusBucket(s), s);
  // Every bucket a status maps to is offered in the menu.
  for (const s of ["editing", "unsaved", "approved", "skipped", "pending", "aquifer", "aiDraft", "draft"]) {
    assert.ok(RAPID_STATUS_BUCKETS.includes(rapidStatusBucket(s)), s);
  }
});

const buckets = ["draft", "approved", "pending", "approved", "skipped", "draft"];
const at = (i) => buckets[i];
const all = buckets.map((_, i) => i);

test("hiding approved keeps every other note, in order", () => {
  assert.deepEqual(rapidStatusMatches(all, at, new Set(["approved"])), [0, 2, 4, 5]);
});

test("'only pending' is every other bucket hidden", () => {
  const hidden = new Set(RAPID_STATUS_BUCKETS.filter((b) => b !== "pending"));
  assert.deepEqual(rapidStatusMatches(all, at, hidden), [2]);
});

test("intersects with the type filter's candidates", () => {
  // The type filter left indices 1, 2 and 5.
  assert.deepEqual(rapidStatusMatches([1, 2, 5], at, new Set(["approved"])), [2, 5]);
});

test("the open note stays in the list, in queue order", () => {
  assert.deepEqual(withOpenNote([0, 2, 4, 5], 3, true), [0, 2, 3, 4, 5]);
  assert.deepEqual(withOpenNote([0, 2], 5, true), [0, 2, 5]);
  assert.deepEqual(withOpenNote([], 1, true), [1]);
});

test("an open note already listed returns the same array", () => {
  const m = [0, 2, 4];
  assert.equal(withOpenNote(m, 2, true), m);
});

test("an open note the type filter hides is not added back", () => {
  const m = [0, 2];
  assert.equal(withOpenNote(m, 3, false), m);
});
