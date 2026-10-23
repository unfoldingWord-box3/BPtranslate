// Tests for rowWithLivePatches (outboxTargeting.ts), issue #620.
//
// The defect: a Save applies its patch to the cached row at once. When the
// server confirms an earlier save, the cache took the server's copy of the
// row as-is, so a later save still in the outbox vanished from the screen:
// save "AB", save "ABC", the 200 for "AB" lands, and the field showed "AB"
// until the second save's 200. The fix re-applies the patches of the row's
// still-live later ops on top of the confirmed row.

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS_SENTINEL, rowWithLivePatches } from "./outboxTargeting.ts";

const target = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC" };
const otherRow = { kind: "row", rowKind: "tq", id: "q-2", book: "ZEC" };

function op(id, patch, extra = {}) {
  return { id, target, action: "patch", patch, expectedVersion: 1, queuedAt: 0, attempts: 0, status: "pending", ...extra };
}

const done = op("op-1", { response: "AB" });
const server = { id: "q-1", book: "ZEC", chapter: 1, verse: 1, question: "Q", response: "AB", version: 2 };

test("a later pending save for the row is re-applied on top of the confirmed row", () => {
  const out = rowWithLivePatches(server, done, [op("op-2", { response: "ABC" })]);
  assert.equal(out.response, "ABC");
  assert.equal(out.version, 2, "the server's version is kept");
  assert.equal(out.question, "Q");
});

test("an in-flight, conflicted or max-attempts-blocked later op is live too", () => {
  for (const extra of [
    { status: "in_flight" },
    { status: "conflict" },
    { status: "failed", lastError: MAX_ATTEMPTS_SENTINEL },
  ]) {
    const out = rowWithLivePatches(server, done, [op("op-2", { response: "ABC" }, extra)]);
    assert.equal(out.response, "ABC", JSON.stringify(extra));
  }
});

test("a fatally failed op is not live and is not re-applied", () => {
  const out = rowWithLivePatches(server, done, [op("op-2", { response: "ABC" }, { status: "failed", lastError: "http 400" })]);
  assert.equal(out, server);
});

test("with no live later op the server row is returned unchanged", () => {
  assert.equal(rowWithLivePatches(server, done, []), server);
});

test("the confirmed op itself is never re-applied (an ok whose local delete failed)", () => {
  const stillThere = op("op-1", { response: "stale" });
  assert.equal(rowWithLivePatches(server, done, [stillThere]), server);
});

test("ops for other rows are ignored", () => {
  const out = rowWithLivePatches(server, done, [op("op-2", { response: "X" }, { target: otherRow })]);
  assert.equal(out, server);
});

test("several live ops apply in queue order, later fields winning", () => {
  const out = rowWithLivePatches(server, done, [
    op("op-2", { response: "ABC", question: "Q2" }),
    op("op-3", { response: "ABCD" }),
  ]);
  assert.equal(out.response, "ABCD");
  assert.equal(out.question, "Q2");
});

test("a live delete is not spread onto the row as a patch", () => {
  const out = rowWithLivePatches(server, done, [op("op-2", {}, { action: "delete" })]);
  assert.equal(out, server);
});

test("an unreadable outbox (null) leaves the server row as-is", () => {
  assert.equal(rowWithLivePatches(server, done, null), server);
});
