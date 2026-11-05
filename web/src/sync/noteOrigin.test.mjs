// Tests for noteOrigin.ts (#754 review A1, A2): NoteCard moves the copy its
// unsaved text was typed against only with its own saves, whether it hears the
// save's outbox result or only sees the row move (another tab drained it).

import test from "node:test";
import assert from "node:assert/strict";
import { isNoteCardSaveOf, isOwnSaveLanded } from "./noteOrigin.ts";

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

test("A2: the row one version past the save, showing what it sent, is the save landing", () => {
  const sent = { patch: { note: "mine\\nline two" }, from: 4 };
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine\nline two", quote: "q" }), true);
  assert.equal(isOwnSaveLanded(sent, { version: 5, note: "mine\\nline two" }), true);
});

test("A2: another person's save is not taken for the card's own", () => {
  const sent = { patch: { note: "mine", support_reference: null }, from: 4 };
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
  assert.equal(isOwnSaveLanded({ patch: {}, from: 4 }, { version: 5 }), false);
});
