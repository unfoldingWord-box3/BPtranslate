// Tests for re-applying this user's waiting saves after another user's live
// update (issue #637 items 4 and 5, follow-up to #620).
//
// The defect: a live "replace" over the WebSocket puts the server's row in
// the cache, which drops this user's saves still waiting in the outbox. With
// save "ABC" held in flight, another user's edit to the question made the
// response field show the old "AB" until "ABC" landed. The fix patches the
// waiting saves back on top once the outbox has been read, unless the cached
// row changed during that read (review finding F4).

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS_SENTINEL, hasQueuedDelete, liveUpdateFollowUp, rowWithQueuedPatches } from "./outboxTargeting.ts";

const target = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC" };
const otherRow = { kind: "row", rowKind: "tq", id: "q-2", book: "ZEC" };

function op(id, patch, extra = {}) {
  return { id, target, action: "patch", patch, expectedVersion: 2, queuedAt: 0, attempts: 0, status: "pending", ...extra };
}

const theirs = { id: "q-1", book: "ZEC", chapter: 1, verse: 1, question: "Q2", response: "AB", version: 3 };

test("item 5: this user's waiting save goes back on top of another user's live update", () => {
  const out = liveUpdateFollowUp(theirs, theirs, target, [
    op("op-2", { response: "ABC" }, { status: "in_flight" }),
    op("op-3", { response: "ABCD" }),
    { ...op("op-x", { response: "other" }), target: otherRow },
  ]);
  assert.deepEqual(out, { t: "patch", patch: { response: "ABCD" } });
});

test("item 5: restored_from_version follows the replayed op on rows that carry it", () => {
  const tn = { ...theirs, restored_from_version: 1 };
  const out = liveUpdateFollowUp(tn, tn, target, [op("op-2", { response: "X" }, { restoredFromVersion: 2 })]);
  assert.deepEqual(out, { t: "patch", patch: { response: "X", restored_from_version: 2 } });
  const plain = liveUpdateFollowUp(tn, tn, target, [op("op-2", { response: "X" })]);
  assert.deepEqual(plain, { t: "patch", patch: { response: "X", restored_from_version: null } });
});

test("nothing to do when no save waits for the row, or only conflicted / blocked ones", () => {
  assert.equal(liveUpdateFollowUp(theirs, theirs, target, []), null);
  for (const extra of [{ status: "conflict" }, { status: "failed", lastError: MAX_ATTEMPTS_SENTINEL }, { status: "failed", lastError: "http 422" }]) {
    assert.equal(liveUpdateFollowUp(theirs, theirs, target, [op("op-2", { response: "X" }, extra)]), null);
  }
});

test("F4: the cached row changed during the outbox read, so older queued values are not written over it", () => {
  const queued = [op("op-2", { response: "ABC" }, { status: "in_flight" })];
  const newer = { ...theirs, response: "XYZ", version: 4 };
  assert.equal(liveUpdateFollowUp(theirs, newer, target, queued), null, "newer row landed");
  assert.equal(liveUpdateFollowUp(theirs, undefined, target, queued), null, "row gone from the cache");
  assert.equal(liveUpdateFollowUp(theirs, theirs, target, null), null, "outbox unreadable");
});

test("item 4: a live update does not bring back a row this user has a waiting delete for", () => {
  const del = { ...op("op-d", undefined), action: "delete" };
  assert.deepEqual(liveUpdateFollowUp(theirs, theirs, target, [del]), { t: "delete" });
  assert.equal(liveUpdateFollowUp(theirs, theirs, otherRow, [del]), null, "another row's delete");
  assert.equal(hasQueuedDelete(target, [{ ...del, status: "failed", lastError: "http 422" }]), false, "refused delete");
});

test("rowWithQueuedPatches keeps the server's version and other fields", () => {
  const out = rowWithQueuedPatches(theirs, target, [op("op-2", { response: "ABC" }, { status: "in_flight" })]);
  assert.equal(out.response, "ABC");
  assert.equal(out.question, "Q2");
  assert.equal(out.version, 3);
  assert.equal(rowWithQueuedPatches(theirs, target, null), theirs);
});
