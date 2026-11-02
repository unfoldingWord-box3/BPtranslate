// Tests for refusedSaveHold.ts (issue #637 item 1, trap 6 of the PR #642
// review): when the cached row is rebuilt to the server's copy after a refused
// save, a classic editor must keep showing the refused text instead of
// adopting the server's value (reconcileField would), so the text shows as
// unsaved and Save works again. Discard ends the hold, and so does the server
// moving on (review A3).

import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_HOLD,
  MAX_WATCHED,
  holdDecision,
  holdOnDraftDiscard,
  holdOnDrop,
  holdOnResult,
  holdOnRowVersion,
  holdOnSave,
} from "./refusedSaveHold.ts";

const target = { rowKind: "tq", id: "q-1", book: "ZEC" };
const rowTarget = { kind: "row", ...target };
const patch = { question: "ABC" };
const opFor = (p, extra = {}) => ({ target: rowTarget, action: "patch", patch: p, ...extra });
const fatal = { kind: "fatal", reason: "http 422" };
const locked = { kind: "locked", lockBody: {} };
const ok = { kind: "ok", updated: {} };
const keeps = (s, field, local) => holdDecision(s, [], field, local) === "keep";
// A save sent at row version 2, then refused.
const heldAt2 = () => holdOnResult(holdOnSave(EMPTY_HOLD, patch, 2), opFor(patch), fatal, target);

test("a refused save holds its text; a field still showing it keeps it", () => {
  for (const result of [fatal, locked]) {
    const s = holdOnResult(holdOnSave(EMPTY_HOLD, patch, 2), opFor(patch), result, target);
    assert.equal(keeps(s, "question", "ABC"), true);
    assert.equal(keeps(s, "question", "ABCD"), false, "newer typing is not the held text");
    assert.equal(keeps(s, "response", "ABC"), false);
    assert.deepEqual(s.sent, []);
  }
});

test("a 200, a 409 or a retry holds nothing; a fatal 404 (row gone) holds nothing", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch, 2);
  assert.equal(keeps(holdOnResult(sent, opFor(patch), ok, target), "question", "ABC"), false);
  assert.equal(holdOnResult(sent, opFor(patch), { kind: "conflict", current: {} }, target), sent);
  assert.equal(holdOnResult(sent, opFor(patch), { kind: "retry", reason: "x" }, target), sent);
  assert.equal(keeps(holdOnResult(sent, opFor(patch), { kind: "fatal", reason: "http 404" }, target), "question", "ABC"), false);
});

test("another row's op, or a different patch, does not count", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch, 2);
  assert.equal(holdOnResult(sent, { ...opFor(patch), target: { ...rowTarget, id: "q-2" } }, fatal, target), sent);
  assert.equal(holdOnResult(sent, opFor({ question: "XYZ" }), fatal, target), sent);
});

test("an earlier save refused while a later one is pending is held too", () => {
  let s = holdOnSave(EMPTY_HOLD, { question: "A" }, 2);
  s = holdOnSave(s, { response: "B" }, 2);
  s = holdOnResult(s, opFor({ question: "A" }), fatal, target);
  assert.equal(keeps(s, "question", "A"), true);
  assert.equal(s.sent.length, 1);
});

test("review A5: a new Save ends the hold only for the fields it sends", () => {
  // 422 on the question; before the rebuild arrives the user saves the
  // response alone (the question still equals the optimistic row).
  const s = holdOnSave(heldAt2(), { response: "R" }, 2);
  assert.equal(keeps(s, "question", "ABC"), true, "the question is still held");
  // A save that sends the question ends its hold.
  assert.equal(keeps(holdOnSave(heldAt2(), { question: "ABC" }, 2), "question", "ABC"), false);
});

test("review A3: the hold ends once the row moves past the version the save was sent at", () => {
  const s = heldAt2();
  const same = holdOnRowVersion(s, 2);
  assert.equal(same.state, s, "the rebuild to the server's copy keeps the version: still held");
  assert.deepEqual(same.released, []);
  const moved = holdOnRowVersion(s, 3);
  assert.equal(keeps(moved.state, "question", "ABC"), false);
  assert.deepEqual(moved.released, [patch]);
  // A field still showing the released text adopts the newer server value (as
  // on main); other text follows reconcileField.
  assert.equal(holdDecision(moved.state, moved.released, "question", "ABC"), "adopt");
  assert.equal(holdDecision(moved.state, moved.released, "question", "typed later"), "reconcile");
});

test("review A3/A5: this editor's own later save landing does not end the hold", () => {
  // 422 on the question (sent at v2), then the response saved alone at v2 and
  // landed at v3 with nobody else's write between: the question stays held.
  let s = holdOnSave(heldAt2(), { response: "R" }, 2);
  s = holdOnResult(s, opFor({ response: "R" }), { kind: "ok", updated: { version: 3 } }, target);
  const after = holdOnRowVersion(s, 3);
  assert.equal(keeps(after.state, "question", "ABC"), true);
  // Landed further on (someone else wrote between): the server moved on.
  let t = holdOnSave(heldAt2(), { response: "R" }, 2);
  t = holdOnResult(t, opFor({ response: "R" }), { kind: "ok", updated: { version: 5 } }, target);
  assert.equal(keeps(holdOnRowVersion(t, 5).state, "question", "ABC"), false);
});

test("round 2 B2: the hold takes the version the op was actually sent at", () => {
  // A 409 auto-heal re-armed the save at v3 (the Save clicked at v2), then it
  // was refused. The rebuild reads v3: the hold must stay.
  const healed = holdOnResult(holdOnSave(EMPTY_HOLD, patch, 2), opFor(patch, { expectedVersion: 3 }), fatal, target);
  assert.equal(keeps(holdOnRowVersion(healed, 3).state, "question", "ABC"), true);
  assert.equal(keeps(holdOnRowVersion(healed, 4).state, "question", "ABC"), false);
  // Quick double save: the first landed v2 -> v3, and the outbox threaded v3
  // to the second (clicked at v2), which was then refused.
  let s = holdOnSave(EMPTY_HOLD, { question: "AB" }, 2);
  s = holdOnSave(s, patch, 2);
  s = holdOnResult(s, opFor({ question: "AB" }, { expectedVersion: 2 }), { kind: "ok", updated: { version: 3 } }, target);
  s = holdOnResult(s, opFor(patch, { expectedVersion: 3 }), fatal, target);
  assert.equal(keeps(holdOnRowVersion(s, 3).state, "question", "ABC"), true);
});

test("round 2 B2: this editor's own save landing one version on follows the version it was sent at", () => {
  // The held save was sent at v3 (healed); the response save threaded to v3
  // lands at v4: nobody else wrote, so the hold follows to v4.
  let s = holdOnResult(holdOnSave(EMPTY_HOLD, patch, 2), opFor(patch, { expectedVersion: 3 }), fatal, target);
  s = holdOnSave(s, { response: "R" }, 2);
  s = holdOnResult(s, opFor({ response: "R" }, { expectedVersion: 3 }), { kind: "ok", updated: { version: 4 } }, target);
  assert.equal(keeps(holdOnRowVersion(s, 4).state, "question", "ABC"), true);
});

test("round 2 B3: discarding the row's draft while its save is still pending stops a later refusal from holding", () => {
  const pending = holdOnSave(EMPTY_HOLD, patch, 2);
  const { state } = holdOnDraftDiscard(pending);
  assert.deepEqual(state.sent, []);
  assert.equal(keeps(holdOnResult(state, opFor(patch), fatal, target), "question", "ABC"), false);
});

test("review A3: discarding the row's draft from the unsaved list ends every hold", () => {
  const { state, released } = holdOnDraftDiscard(heldAt2());
  assert.equal(keeps(state, "question", "ABC"), false);
  assert.deepEqual(released, [patch]);
  assert.deepEqual(holdOnDraftDiscard(EMPTY_HOLD).released, []);
});

test("a held save retried and landed (200) ends the hold", () => {
  assert.equal(keeps(holdOnResult(heldAt2(), opFor(patch), ok, target), "question", "ABC"), false);
  assert.equal(keeps(holdOnResult(heldAt2(), opFor(patch), fatal, target), "question", "ABC"), true);
});

test("Discard of the held save releases what is still held", () => {
  const { state, released } = holdOnDrop(heldAt2(), opFor(patch, { status: "failed" }), target);
  assert.deepEqual(released, patch);
  assert.equal(keeps(state, "question", "ABC"), false);
  // After a later save took over one field, the discard matches the original
  // op but releases only the field still held.
  const two = holdOnResult(holdOnSave(EMPTY_HOLD, { question: "Q", response: "R" }, 2), opFor({ question: "Q", response: "R" }), fatal, target);
  const partly = holdOnSave(two, { response: "R2" }, 2);
  assert.deepEqual(holdOnDrop(partly, opFor({ question: "Q", response: "R" }), target).released, { question: "Q" });
});

test("keep theirs / Discard of a conflicted save ends its watch and releases nothing", () => {
  const sent = holdOnSave(EMPTY_HOLD, patch, 2);
  const { state, released } = holdOnDrop(sent, opFor(patch, { status: "conflict" }), target);
  assert.equal(released, null);
  assert.deepEqual(state.sent, []);
  assert.equal(holdOnDrop(sent, opFor({ question: "other" }), target).state, sent);
});

test("only the last MAX_WATCHED saves are watched", () => {
  let s = EMPTY_HOLD;
  for (let i = 0; i < MAX_WATCHED + 5; i++) s = holdOnSave(s, { question: String(i) }, 2);
  assert.equal(s.sent.length, MAX_WATCHED);
  assert.deepEqual(s.sent[s.sent.length - 1].patch, { question: String(MAX_WATCHED + 4) });
});
