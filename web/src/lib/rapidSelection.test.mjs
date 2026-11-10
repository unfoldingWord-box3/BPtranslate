import test from "node:test";
import assert from "node:assert/strict";
import { carryRapidSelection, NO_RAPID_SELECTION } from "./rapidSelection.ts";

// Rapid check's checked rows (#829, #867): the selection follows the rows on
// screen within one chapter instead of resetting whenever the row set changes.

const sel = (scope, ids, anchor = null) => ({ scope, ids: new Set(ids), anchor });
const ids = (s) => [...s.ids].sort();

test("approved rows leave under 'hide approved'; the skipped row stays checked", () => {
  const before = sel("ZEC:4", ["b", "c", "d"], "b");
  const after = carryRapidSelection(before, "ZEC:4", ["a", "d", "e"]);
  assert.deepEqual(ids(after), ["d"]);
  assert.equal(after.scope, "ZEC:4");
});

test("an unchanged row set returns the same selection object", () => {
  const before = sel("ZEC:4", ["b", "c"], "b");
  assert.equal(carryRapidSelection(before, "ZEC:4", ["a", "b", "c"]), before);
  // Rows added around the checked ones change nothing either.
  assert.equal(carryRapidSelection(before, "ZEC:4", ["a", "b", "x", "c", "y"]), before);
  assert.equal(carryRapidSelection(NO_RAPID_SELECTION, "", []), NO_RAPID_SELECTION);
});

test("a different chapter clears the selection", () => {
  const before = sel("ZEC:4", ["b", "c"], "b");
  const after = carryRapidSelection(before, "ZEC:5", ["b", "c"]);
  assert.deepEqual(ids(after), []);
  assert.equal(after.anchor, null);
  assert.equal(after.scope, "ZEC:5");
  // Settled: the next render returns it unchanged.
  assert.equal(carryRapidSelection(after, "ZEC:5", ["b", "c"]), after);
});

test("no filter: another verse clears it, and coming back does not restore it", () => {
  const v3 = sel("ZEC:4", ["a", "b"], "a");
  const v4 = carryRapidSelection(v3, "ZEC:4", ["x", "y"]);
  assert.deepEqual(ids(v4), []);
  const back = carryRapidSelection(v4, "ZEC:4", ["a", "b"]);
  assert.deepEqual(ids(back), []);
});

test("a row the filter hides comes back unchecked when shown again", () => {
  const before = sel("ZEC:4", ["a", "b"]);
  const hidden = carryRapidSelection(before, "ZEC:4", ["b", "c"]);
  assert.deepEqual(ids(hidden), ["b"]);
  assert.deepEqual(ids(carryRapidSelection(hidden, "ZEC:4", ["a", "b", "c"])), ["b"]);
});

test("Shift+J off a hidden open note keeps the extended rows; its anchor falls back", () => {
  // Shift+J on open note "o" (approved, hidden but listed while open) checked
  // "o" and "p" with "o" as the anchor; moving the cursor drops "o" from the list.
  const before = sel("ZEC:4", ["d", "o", "p"], "o");
  const after = carryRapidSelection(before, "ZEC:4", ["d", "p", "q"]);
  assert.deepEqual(ids(after), ["d", "p"]);
  assert.equal(after.anchor, null);
  // An anchor still on screen is kept.
  const kept = carryRapidSelection(sel("ZEC:4", ["d", "p"], "p"), "ZEC:4", ["p", "q"]);
  assert.equal(kept.anchor, "p");
  assert.deepEqual(ids(kept), ["p"]);
});
