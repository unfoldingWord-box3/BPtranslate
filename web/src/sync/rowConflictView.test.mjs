// Tests for web/src/sync/rowConflictView.ts (#892): the compare a classic
// editor shows for a refused save, and the ops "Keep theirs" drops.
import assert from "node:assert/strict";
import { test } from "node:test";
import { opsDroppedByKeepTheirs, rowConflictView } from "./rowConflictView.ts";

const target = { kind: "row", rowKind: "tn", id: "abcd", book: "ZEC" };
const other = { kind: "row", rowKind: "tn", id: "wxyz", book: "ZEC" };
const theirs = { id: "abcd", book: "ZEC", version: 4, note: "Bob's note", quote: "q", updated_at: 1000 };

let n = 0;
function op(fields) {
  n++;
  return {
    id: `op${n}`,
    target,
    action: "patch",
    patch: {},
    status: "pending",
    queuedAt: n,
    seq: n,
    ...fields,
  };
}

test("no conflict for the row: no view", () => {
  assert.equal(rowConflictView([op({ patch: { note: "a" } })], target), null);
  assert.equal(rowConflictView([op({ target: other, status: "conflict", conflictCurrent: theirs })], target), null);
});

test("a conflict shows the server row from the 409 and the fields that differ", () => {
  const c = op({ status: "conflict", patch: { note: "Alice's note", quote: "q" }, conflictCurrent: theirs });
  const v = rowConflictView([c], target);
  assert.equal(v.opId, c.id);
  assert.equal(v.theirsVersion, 4);
  assert.equal(v.theirsUpdatedAt, 1000);
  assert.deepEqual(v.mine, { note: "Alice's note", quote: "q" });
  // quote is the same on both sides, so only the note is compared.
  assert.deepEqual(v.fields, ["note"]);
});

test("later saves waiting behind the conflict are part of mine, in queue order", () => {
  const c = op({ status: "conflict", patch: { note: "first" }, conflictCurrent: theirs });
  const later = op({ patch: { note: "second", support_reference: "rc://x" } });
  const last = op({ patch: { note: "third" } });
  const v = rowConflictView([last, later, c], target);
  assert.equal(v.opId, c.id);
  assert.deepEqual(v.mine, { note: "third", support_reference: "rc://x" });
  assert.deepEqual(v.fields.sort(), ["note", "support_reference"]);
});

test("a 409 without a usable row leaves theirs empty and every field listed", () => {
  const c = op({ status: "conflict", patch: { note: "x" }, conflictCurrent: { version: 3, deleted_at: null } });
  const v = rowConflictView([c], target);
  assert.equal(v.theirs, null);
  assert.equal(v.theirsVersion, null);
  assert.deepEqual(v.fields, ["note"]);
});

test("Keep theirs drops every queued op for the row, not just the refused one", () => {
  const c = op({ status: "conflict", conflictCurrent: theirs });
  const p1 = op({});
  const p2 = op({ status: "failed" });
  const elsewhere = op({ target: other });
  const dropped = opsDroppedByKeepTheirs([c, p1, p2, elsewhere], c.id).map((o) => o.id);
  assert.deepEqual(dropped, [c.id, p1.id, p2.id]);
});

test("Keep theirs leaves an op on the wire alone", () => {
  const c = op({ status: "conflict" });
  const flying = op({ status: "in_flight" });
  assert.deepEqual(opsDroppedByKeepTheirs([c, flying], c.id).map((o) => o.id), [c.id]);
});

test("Keep theirs on an op that is no longer a conflict drops nothing", () => {
  const rearmed = op({ status: "pending" });
  const sibling = op({});
  assert.deepEqual(opsDroppedByKeepTheirs([rearmed, sibling], rearmed.id), []);
  assert.deepEqual(opsDroppedByKeepTheirs([sibling], "gone"), []);
});
