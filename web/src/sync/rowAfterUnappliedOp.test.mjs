// Tests for the cache rebuild after a row save ends without reaching the
// server (issue #637, follow-up to #620).
//
// The defect: a Save patches the cached row at once. When that save is then
// refused for good (a fatal 4xx), dropped because the chapter is locked by an
// AI pipeline, or discarded by the user, nothing put the cached row back, so
// the unsaved text stayed on screen as if it were saved: save "AB", save
// "ABC", the 200 for "AB" lands, the "ABC" save fails with a 422, and the
// field still showed "ABC". The fix rebuilds the row from the last row the
// server confirmed plus the row's saves still about to land.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS_SENTINEL,
  hasQueuedDelete,
  rowAfterUnappliedOp,
  rowWithQueuedPatches,
  unappliedResult,
} from "./outboxTargeting.ts";

const target = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC" };
const otherRow = { kind: "row", rowKind: "tq", id: "q-2", book: "ZEC" };

function op(id, patch, extra = {}) {
  return { id, target, action: "patch", patch, expectedVersion: 2, queuedAt: 0, attempts: 0, status: "pending", ...extra };
}

const confirmed = { id: "q-1", book: "ZEC", chapter: 1, verse: 1, question: "Q", response: "AB", version: 2 };
const cached = { ...confirmed, response: "ABC" };

test("a fatally refused later save is taken off the cached row", () => {
  const failed = op("op-2", { response: "ABC" }, { status: "failed", lastError: "http 422" });
  const out = rowAfterUnappliedOp(cached, confirmed, target, [failed]);
  assert.equal(out.response, "AB");
  assert.equal(out.version, 2);
});

test("a save dropped as locked, or discarded, leaves the server's row", () => {
  assert.equal(rowAfterUnappliedOp(cached, confirmed, target, []).response, "AB");
});

test("a third save still waiting stays on top of the rebuilt row", () => {
  const out = rowAfterUnappliedOp(cached, confirmed, target, [
    op("op-2", { response: "ABC" }, { status: "failed", lastError: "http 422" }),
    op("op-3", { response: "ABCD" }),
    { ...op("op-x", { response: "other" }), target: otherRow },
  ]);
  assert.equal(out.response, "ABCD");
});

test("a conflicted or retry-blocked save is not re-applied", () => {
  for (const extra of [{ status: "conflict" }, { status: "failed", lastError: MAX_ATTEMPTS_SENTINEL }]) {
    assert.equal(rowAfterUnappliedOp(cached, confirmed, target, [op("op-3", { response: "X" }, extra)]).response, "AB");
  }
});

test("no rebuild when the cache holds a server row we never recorded, or the outbox could not be read", () => {
  assert.equal(rowAfterUnappliedOp({ ...cached, version: 3 }, confirmed, target, []), null, "newer cached version");
  assert.equal(rowAfterUnappliedOp(cached, undefined, target, []), null, "no confirmed row");
  assert.equal(rowAfterUnappliedOp(undefined, confirmed, target, []), null, "row not in the cache");
  assert.equal(rowAfterUnappliedOp(cached, confirmed, target, null), null, "outbox unreadable");
});

test("unappliedResult: fatal and locked end a save without applying it; ok, conflict and retry do not", () => {
  assert.equal(unappliedResult("fatal"), true);
  assert.equal(unappliedResult("locked"), true);
  assert.equal(unappliedResult("ok"), false);
  assert.equal(unappliedResult("conflict"), false);
  assert.equal(unappliedResult("retry"), false);
});

test("a live update from another user keeps this user's waiting saves on top (item 5)", () => {
  const theirs = { ...confirmed, question: "Q2", version: 3 };
  const out = rowWithQueuedPatches(theirs, target, [op("op-2", { response: "ABC" }, { status: "in_flight" })]);
  assert.equal(out.response, "ABC");
  assert.equal(out.question, "Q2");
  assert.equal(out.version, 3);
  assert.equal(rowWithQueuedPatches(theirs, target, null), theirs);
});

test("hasQueuedDelete: a waiting delete for the row, not another row's (item 4)", () => {
  const del = { ...op("op-d", {}), action: "delete" };
  assert.equal(hasQueuedDelete(target, [del]), true);
  assert.equal(hasQueuedDelete(otherRow, [del]), false);
  assert.equal(hasQueuedDelete(target, [{ ...del, status: "failed", lastError: "http 422" }]), false);
  assert.equal(hasQueuedDelete(target, null), false);
});
