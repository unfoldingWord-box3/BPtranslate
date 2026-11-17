// Tests for web/src/sync/rowConflictView.ts (#892): the compare a classic
// editor shows for a refused save, and the ops "Keep theirs" drops.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canKeepTheirs, editorAddsToMine, opsDroppedByKeepTheirs, rowConflictView, withEditorValues } from "./rowConflictView.ts";

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

test("Keep theirs drops the refused save and the saves queued behind it, not just the refused one", () => {
  const c = op({ status: "conflict", conflictCurrent: theirs });
  const p1 = op({});
  const p2 = op({});
  const elsewhere = op({ target: other });
  const dropped = opsDroppedByKeepTheirs([c, p1, p2, elsewhere], c.id).map((o) => o.id);
  assert.deepEqual(dropped, [c.id, p1.id, p2.id]);
});

test("Keep theirs leaves a failed save and a queued delete of the row alone (review K2, K3)", () => {
  const c = op({ status: "conflict", conflictCurrent: theirs });
  const failed = op({ status: "failed" });
  const del = op({ action: "delete" });
  assert.deepEqual(opsDroppedByKeepTheirs([c, failed, del], c.id).map((o) => o.id), [c.id]);
});

test("Mine shows the editor's text, including typing after the refused save (review K1)", () => {
  const c = op({ status: "conflict", patch: { note: "Alice's note" }, conflictCurrent: theirs });
  const v = withEditorValues(rowConflictView([c], target), { note: "Alice's note and more", quote: "q", support_reference: null }, ["note"]);
  assert.equal(v.mine.note, "Alice's note and more");
  assert.deepEqual(v.fields, ["note"]);
});

test("Mine adds a field typed after the refused save, and skips one never touched", () => {
  const c = op({ status: "conflict", patch: { note: "Alice's note" }, conflictCurrent: theirs });
  // quote: never touched, still the old value; Bob's row has the same "q".
  // support_reference: typed after the save, dirty, differs from theirs.
  const v = withEditorValues(
    rowConflictView([c], target),
    { note: "Alice's note", quote: "old quote", support_reference: "rc://new" },
    ["note", "support_reference"],
  );
  assert.deepEqual(v.fields.sort(), ["note", "support_reference"]);
  assert.equal(v.mine.support_reference, "rc://new");
});

test("a queued field the editor shows unchanged keeps the queued text", () => {
  // The tQ table puts Bob's text on screen when his write arrives; the queued
  // patch still holds Alice's, which is what Keep mine would send.
  const c = op({ status: "conflict", patch: { note: "Alice's note" }, conflictCurrent: theirs });
  const v = withEditorValues(rowConflictView([c], target), { note: "Bob's note" }, []);
  assert.equal(v.mine.note, "Alice's note");
  assert.deepEqual(v.fields, ["note"]);
});

test("Mine compares newlines in display form", () => {
  const c = op({ status: "conflict", patch: { note: "a\\nb" }, conflictCurrent: { ...theirs, note: "a\\nb" } });
  const v = withEditorValues(rowConflictView([c], target), { note: "a\nb" }, ["note"]);
  // Same text on both sides: falls back to the queued fields rather than none.
  assert.deepEqual(v.fields, ["note"]);
});

test("Keep theirs drops nothing while a save of the row is on the wire (review L2)", () => {
  const c = op({ status: "conflict" });
  const flying = op({ status: "in_flight" });
  const p = op({});
  assert.deepEqual(opsDroppedByKeepTheirs([c, flying, p], c.id), []);
  // An op of another row on the wire does not hold this one up.
  const elsewhere = op({ target: other, status: "in_flight" });
  assert.deepEqual(opsDroppedByKeepTheirs([c, elsewhere], c.id).map((o) => o.id), [c.id]);
});

test("Keep theirs is available only with their row known and nothing of the row on the wire", () => {
  const c = op({ status: "conflict", patch: { note: "a" }, conflictCurrent: theirs });
  const v = rowConflictView([c], target);
  assert.equal(v.sending, false);
  assert.equal(canKeepTheirs(v), true);
  const sending = rowConflictView([c, op({ status: "in_flight", patch: { note: "b" } })], target);
  assert.equal(sending.sending, true);
  assert.equal(canKeepTheirs(sending), false);
  const noRow = rowConflictView([op({ status: "conflict", patch: { note: "a" } })], target);
  assert.equal(canKeepTheirs(noRow), false);
});

test("Keep theirs on an op that is no longer a conflict drops nothing", () => {
  const rearmed = op({ status: "pending" });
  const sibling = op({});
  assert.deepEqual(opsDroppedByKeepTheirs([rearmed, sibling], rearmed.id), []);
  assert.deepEqual(opsDroppedByKeepTheirs([sibling], "gone"), []);
});

test("Keep mine queues the editor's text only when it adds to the queued saves (review M1)", () => {
  const c = op({ status: "conflict", patch: { note: "a\\nb" }, conflictCurrent: theirs });
  const v = rowConflictView([c], target);
  // Same text as queued (display form): nothing more to save.
  assert.equal(editorAddsToMine(v, { note: "a\nb" }, ["note"]), false);
  // Typed more after the refused save.
  assert.equal(editorAddsToMine(v, { note: "a\nb and more" }, ["note"]), true);
  // A field typed in that no queued save carries.
  assert.equal(editorAddsToMine(v, { note: "a\nb", quote: "new quote" }, ["note", "quote"]), true);
  // An unchanged field the editor shows differently is not the user's typing.
  assert.equal(editorAddsToMine(v, { note: "Bob's note" }, []), false);
});
