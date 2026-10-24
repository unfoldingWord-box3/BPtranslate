// Tests for refusedSaveHold.ts (issue #637 item 1, trap 6 of the PR #642
// review): when the cached row is rebuilt to the server's copy after a refused
// save, a classic editor must keep showing the refused text instead of
// adopting the server's value (reconcileField would), so the text shows as
// unsaved and Save works again. Discard ends the hold.

import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_HOLD, MAX_WATCHED, holdOnDrop, holdOnResult, holdOnSave, keepsHeldText } from "./refusedSaveHold.ts";

const target = { rowKind: "tq", id: "q-1", book: "ZEC" };
const rowTarget = { kind: "row", ...target };
const patch = { question: "ABC" };
const opFor = (p, extra = {}) => ({ target: rowTarget, action: "patch", patch: p, ...extra });
const fatal = { kind: "fatal", reason: "http 422" };
const locked = { kind: "locked", lockBody: {} };
const ok = { kind: "ok", updated: {} };

test("a refused save holds its text; a field still showing it keeps it", () => {
  for (const result of [fatal, locked]) {
    const s = holdOnResult(holdOnSave(EMPTY_HOLD, patch), opFor(patch), result, target);
    assert.equal(keepsHeldText(s, "question", "ABC"), true);
    assert.equal(keepsHeldText(s, "question", "ABCD"), false, "newer typing is not the held text");
    assert.equal(keepsHeldText(s, "response", "ABC"), false);
    assert.deepEqual(s.sent, []);
  }
});

test("a 200, a 409 or a retry holds nothing; a fatal 404 (row gone) holds nothing", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch);
  assert.equal(keepsHeldText(holdOnResult(sent, opFor(patch), ok, target), "question", "ABC"), false);
  assert.equal(holdOnResult(sent, opFor(patch), { kind: "conflict", current: {} }, target), sent);
  assert.equal(holdOnResult(sent, opFor(patch), { kind: "retry", reason: "x" }, target), sent);
  const gone = holdOnResult(sent, opFor(patch), { kind: "fatal", reason: "http 404" }, target);
  assert.equal(keepsHeldText(gone, "question", "ABC"), false);
});

test("another row's op, or a different patch, does not count", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch);
  assert.equal(holdOnResult(sent, { ...opFor(patch), target: { ...rowTarget, id: "q-2" } }, fatal, target), sent);
  assert.equal(holdOnResult(sent, opFor({ question: "XYZ" }), fatal, target), sent);
});

test("an earlier save refused while a later one is pending is held too", () => {
  let s = holdOnSave(EMPTY_HOLD, { question: "A" });
  s = { ...s, sent: [...s.sent, { response: "B" }] };
  s = holdOnResult(s, opFor({ question: "A" }), fatal, target);
  assert.equal(keepsHeldText(s, "question", "A"), true);
  assert.deepEqual(s.sent, [{ response: "B" }]);
});

test("a new Save ends the hold (it sends the held text the editor still shows)", () => {
  const held = holdOnResult(holdOnSave(EMPTY_HOLD, patch), opFor(patch), fatal, target);
  const next = holdOnSave(held, { question: "ABC" });
  assert.equal(keepsHeldText(next, "question", "ABC"), false);
});

test("a held save retried and landed (200) ends the hold", () => {
  const held = holdOnResult(holdOnSave(EMPTY_HOLD, patch), opFor(patch), fatal, target);
  assert.equal(keepsHeldText(holdOnResult(held, opFor(patch), ok, target), "question", "ABC"), false);
  assert.equal(keepsHeldText(holdOnResult(held, opFor(patch), fatal, target), "question", "ABC"), true);
});

test("Discard of the held save releases it, so the editor can put the row's value back", () => {
  const held = holdOnResult(holdOnSave(EMPTY_HOLD, patch), opFor(patch), fatal, target);
  const { state, released } = holdOnDrop(held, opFor(patch, { status: "failed" }), target);
  assert.deepEqual(released, patch);
  assert.equal(keepsHeldText(state, "question", "ABC"), false);
});

test("keep theirs / Discard of a conflicted save ends its watch and releases nothing", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch);
  const { state, released } = holdOnDrop(sent, opFor(patch, { status: "conflict" }), target);
  assert.equal(released, null);
  assert.deepEqual(state.sent, []);
  // An unrelated drop changes nothing.
  assert.equal(holdOnDrop(sent, opFor({ question: "other" }), target).state, sent);
});

test("only the last MAX_WATCHED saves are watched", () => {
  let s = EMPTY_HOLD;
  for (let i = 0; i < MAX_WATCHED + 5; i++) s = holdOnSave(s, { question: String(i) });
  assert.equal(s.sent.length, MAX_WATCHED);
  assert.deepEqual(s.sent[s.sent.length - 1], { question: String(MAX_WATCHED + 4) });
});
