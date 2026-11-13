// Tests for noteOrigin.ts (#754 review A1, A2): NoteCard moves the copy its
// unsaved text was typed against only with its own saves, whether it hears the
// save's outbox result or only sees the row move (another tab drained it).

import test from "node:test";
import assert from "node:assert/strict";
import { isNoteCardSaveOf, isOwnSaveLanded, isWriteFromOrigin } from "./noteOrigin.ts";

const row = { id: "n-1", book: "ZEC" };
const target = { kind: "row", rowKind: "tn", id: "n-1", book: "ZEC" };
const draftRef = { chapter: 13, verse: 2 };

test("a tN patch of the row with a draftRef is the card's own save", () => {
  assert.equal(isNoteCardSaveOf({ action: "patch", target, draftRef }, row), true);
});

test("A1: other writes to the row are not the card's save", () => {
  // Reorder, verse move, quote build, find/replace, batch: no draftRef.
  assert.equal(isNoteCardSaveOf({ action: "patch", target }, row), false);
  assert.equal(isNoteCardSaveOf({ action: "delete", target, draftRef }, row), false);
  assert.equal(isNoteCardSaveOf({ action: "patch", target: { ...target, id: "n-2" }, draftRef }, row), false);
  assert.equal(isNoteCardSaveOf({ action: "patch", target: { ...target, book: "HAG" }, draftRef }, row), false);
  assert.equal(isNoteCardSaveOf({ action: "patch", target: { ...target, rowKind: "tq" }, draftRef }, row), false);
});

// The copy the save went out against, for the fields the card edits.
const base = { quote: "q", note: "old", support_reference: null };

test("A2: the row one version past the save, showing what it sent, is the save landing", () => {
  const sent = { patch: { note: "mine\\nline two" }, from: 4, base };
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine\nline two", quote: "q" }), true);
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine\\nline two", quote: "q", support_reference: null }), true);
});

test("round 4 item 3: a row that shows the sent field but another change is not the save landing", () => {
  // The save patched the note only; another writer's v5 carries the same note
  // text but a different quote. Taking it for the card's own save would move
  // the copy to v5, and a later quote edit would go out at v5 over their quote.
  const sent = { patch: { note: "mine" }, from: 4, base };
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine", quote: "their quote", support_reference: null }), false);
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine", quote: "q", support_reference: "rc://x" }), false);
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine", quote: "q", support_reference: null }), true);
});

test("A2: another person's save is not taken for the card's own", () => {
  const sent = { patch: { note: "mine", support_reference: null }, from: 4, base };
  // Their text at the version the save would have landed at.
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "theirs", support_reference: null }), false);
  // One field matches, another does not.
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine", support_reference: "rc://x" }), false);
  // Our text, but more writes since (or the save has not landed yet).
  assert.equal(isOwnSaveLanded(sent, { version: 6, note: "mine", support_reference: null }), false);
  assert.equal(isOwnSaveLanded(sent, { version: 4, note: "mine", support_reference: null }), false);
});

test("A2: no save sent, or an empty one, never matches", () => {
  assert.equal(isOwnSaveLanded(null, { version: 5, note: "mine" }), false);
  assert.equal(isOwnSaveLanded({ patch: {}, from: 4, base }, { version: 5, ...base }), false);
});

test("round 4 item 1: any write of the row sent at the copy's version lands on that copy", () => {
  // The server took it at the version the card's text was typed against, so
  // nothing else landed in between: a quote build, find/replace or reorder
  // the translator made, landing on the copy their unsaved text was typed on.
  assert.equal(isWriteFromOrigin({ action: "patch", target, expectedVersion: 3 }, row, 3, 4), true);
  assert.equal(isWriteFromOrigin({ action: "patch", target, draftRef, expectedVersion: 3 }, row, 3, 4), true);
});

test("round 4 item 1: a result whose row is more than one version past the copy does not move it", () => {
  // An edit settled as saved from its 409 (#886 item 1) is announced as a 200
  // with the server's current row, which can carry another person's later
  // write; the op still shows the version it first went out at.
  assert.equal(isWriteFromOrigin({ action: "patch", target, expectedVersion: 3 }, row, 3, 5), false);
  assert.equal(isWriteFromOrigin({ action: "patch", target, expectedVersion: 3 }, row, 3, undefined), false);
});

test("round 4 item 1: a write sent at a newer version than the copy does not move it (review A1)", () => {
  // A reorder sent at the row's current version, which already carries
  // another person's note: the restored draft's Save must still go out old.
  assert.equal(isWriteFromOrigin({ action: "patch", target, expectedVersion: 4 }, row, 3, 5), false);
  assert.equal(isWriteFromOrigin({ action: "delete", target, expectedVersion: 3 }, row, 3, 4), false);
  assert.equal(isWriteFromOrigin({ action: "patch", target: { ...target, id: "n-2" }, expectedVersion: 3 }, row, 3, 4), false);
  assert.equal(isWriteFromOrigin({ action: "patch", target: { ...target, rowKind: "tq" }, expectedVersion: 3 }, row, 3, 4), false);
  assert.equal(isWriteFromOrigin({ action: "patch", target }, row, 3, 4), false);
});
