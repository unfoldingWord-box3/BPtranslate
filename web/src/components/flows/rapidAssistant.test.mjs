import test from "node:test";
import assert from "node:assert/strict";
import { MAX_NOTES, MAX_NOTE_CHARS, buildRapidNotes, editsWithVersions } from "./rapidAssistant.ts";

const row = (id, o = {}) => ({ id, chapter: 2, verse: 3, quote: "q", note: "text " + id, version: 7, translation_state: "ai_draft", ...o });

test("buildRapidNotes: ref, state, checked flag, stored text as-is, screen order", () => {
  const { notes } = buildRapidNotes([row("a", { verse: 0, note: "line\\none", translation_state: null }), row("b")], new Set(["b"]));
  assert.deepEqual(notes.map((n) => n.ref), ["2:intro", "2:3"]);
  assert.equal(notes[0].note, "line\\none");
  assert.equal(notes[0].state, null);
  assert.deepEqual(notes.map((n) => n.checked), [false, true]);
});

test("buildRapidNotes: versions are captured per sent note", () => {
  const { versions } = buildRapidNotes([row("a", { version: 4 }), row("b", { version: 9 })], new Set());
  assert.equal(versions.get("a"), 4);
  assert.equal(versions.get("b"), 9);
});

test("buildRapidNotes: a note over the size limit is left out, not cut", () => {
  const { notes, versions } = buildRapidNotes([row("a", { note: "x".repeat(MAX_NOTE_CHARS + 1) }), row("b")], new Set());
  assert.deepEqual(notes.map((n) => n.id), ["b"]);
  assert.equal(versions.has("a"), false);
});

test("buildRapidNotes: over the note cap, checked notes stay and order is kept", () => {
  const rows = Array.from({ length: MAX_NOTES + 5 }, (_, i) => row("n" + i));
  const last = "n" + (MAX_NOTES + 4);
  const { notes } = buildRapidNotes(rows, new Set([last]));
  assert.equal(notes.length, MAX_NOTES);
  assert.equal(notes[notes.length - 1].id, last);
  assert.deepEqual(notes.slice(0, 3).map((n) => n.id), ["n0", "n1", "n2"]);
});

test("buildRapidNotes: stays under the body budget", () => {
  const rows = Array.from({ length: 100 }, (_, i) => row("n" + i, { note: "y".repeat(5000) }));
  const { notes } = buildRapidNotes(rows, new Set());
  assert.ok(JSON.stringify(notes).length < 180_000);
  assert.ok(notes.length > 0 && notes.length < 100);
});

test("editsWithVersions: attaches the captured version, drops unknown ids", () => {
  const out = editsWithVersions([{ id: "a", note: "x" }, { id: "z", note: "y" }], new Map([["a", 4]]));
  assert.deepEqual(out, [{ id: "a", note: "x", version: 4 }]);
});

test("buildRapidNotes: the budget counts UTF-8 bytes, so Arabic fits the server's 200 KB body", () => {
  // 100 Arabic notes of 1500 characters: ~150k characters but ~300 KB of UTF-8.
  const rows = Array.from({ length: 100 }, (_, i) => row("n" + i, { note: "ب".repeat(1500) }));
  const { notes } = buildRapidNotes(rows, new Set());
  assert.ok(new TextEncoder().encode(JSON.stringify(notes)).length <= 120_000);
  assert.ok(notes.length > 0 && notes.length < 100);
});
