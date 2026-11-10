import test from "node:test";
import assert from "node:assert/strict";
import * as rapid from "./rapidAssistant.ts";
import { MAX_NOTES, MAX_NOTE_CHARS, buildRapidNotes, editsWithVersions, stillAsProposed } from "./rapidAssistant.ts";

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

// Issue #859: the panel tells the user what was left out, so it reports both kinds.
test("buildRapidNotes: nothing left out reports zero of each", () => {
  const { omitted } = buildRapidNotes([row("a"), row("b")], new Set());
  assert.deepEqual(omitted, { tooLong: 0, tooMany: 0, tooLongRefs: [], tooManyRefs: [] });
});

test("buildRapidNotes: an over-long note is counted as too long, with its ref", () => {
  const { omitted } = buildRapidNotes(
    [row("a", { verse: 5, note: "x".repeat(MAX_NOTE_CHARS + 1) }), row("b"), row("c", { verse: 0, note: "z".repeat(MAX_NOTE_CHARS + 50) })],
    new Set(["a"]),
  );
  assert.equal(omitted.tooLong, 2);
  assert.deepEqual(omitted.tooLongRefs, ["2:5", "2:intro"]);
  assert.equal(omitted.tooMany, 0);
});

test("buildRapidNotes: over the note cap, the extra notes are counted as too many", () => {
  const rows = Array.from({ length: MAX_NOTES + 5 }, (_, i) => row("n" + i, { verse: i + 1 }));
  const { notes, omitted } = buildRapidNotes(rows, new Set());
  assert.equal(notes.length, MAX_NOTES);
  assert.equal(omitted.tooMany, 5);
  assert.deepEqual(omitted.tooManyRefs, ["2:201", "2:202", "2:203", "2:204", "2:205"]);
  assert.equal(omitted.tooLong, 0);
});

test("buildRapidNotes: over the byte budget, a checked note is kept and the rest are counted", () => {
  const rows = Array.from({ length: 100 }, (_, i) => row("n" + i, { verse: i + 1, note: "y".repeat(5000) }));
  const { notes, omitted } = buildRapidNotes(rows, new Set(["n99"]));
  assert.ok(notes.some((n) => n.id === "n99"));
  assert.equal(notes.length + omitted.tooMany, 100);
  assert.ok(omitted.tooMany > 0);
  assert.equal(omitted.tooManyRefs.length, omitted.tooMany);
  assert.ok(!omitted.tooManyRefs.includes("2:100"));
  assert.equal(omitted.tooLong, 0);
});

test("buildRapidNotes: captures each sent note's approval state, null when it has none (#860)", () => {
  const rows = [row("a", { translation_state: "validated" }), row("b", { translation_state: undefined }), row("x", { note: "x".repeat(MAX_NOTE_CHARS + 1) })];
  const { states } = buildRapidNotes(rows, new Set());
  assert.equal(states.get("a"), "validated");
  assert.equal(states.get("b"), null);
  assert.equal(states.has("x"), false);
});

test("stillAsProposed: a version change is 'changed', an approval-state change is 'stateChanged' (#878), a row gone from the screen is 'missing' (#860)", () => {
  const snap = {
    versions: new Map([["same", 3], ["nullState", 3], ["moved", 3], ["approved", 3], ["gone", 3]]),
    states: new Map([["same", "ai_draft"], ["nullState", null], ["moved", "ai_draft"], ["approved", "ai_draft"], ["gone", "ai_draft"]]),
  };
  const rowById = new Map([
    ["same", { version: 3, translation_state: "ai_draft" }],
    // A row with no state field matches the null that was sent.
    ["nullState", { version: 3 }],
    ["moved", { version: 4, translation_state: "ai_draft" }],
    // Approving does not bump the version, so only the state shows it.
    ["approved", { version: 3, translation_state: "validated" }],
    ["unsent", { version: 1, translation_state: null }],
  ]);
  const r = stillAsProposed(["same", "nullState", "moved", "approved", "gone", "unsent"], snap, rowById);
  assert.deepEqual(r.ids, ["same", "nullState"]);
  assert.equal(r.changed, 2); // moved, and unsent (nothing to check it against)
  // Approved since the proposal, same version: its own reason, not "changed by someone else, reloaded" (#878).
  assert.equal(r.stateChanged, 1);
  assert.equal(r.missing, 1); // gone
});

test("snapshotMismatch: a new version (or no snapshot entry) is 'changed'; the same version with another approval state is 'stateChanged' (#878)", () => {
  const snap = {
    versions: new Map([["same", 3], ["nullState", 3], ["moved", 3], ["approved", 3], ["both", 3]]),
    states: new Map([["same", "ai_draft"], ["nullState", null], ["moved", "ai_draft"], ["approved", "ai_draft"], ["both", "ai_draft"]]),
  };
  const check = (id, r) => rapid.snapshotMismatch(id, snap, r);
  assert.equal(check("same", { version: 3, translation_state: "ai_draft" }), null);
  assert.equal(check("nullState", { version: 3 }), null);
  assert.equal(check("moved", { version: 4, translation_state: "ai_draft" }), "changed");
  // The edit case: approving does not bump the version, so only the state shows it.
  assert.equal(check("approved", { version: 3, translation_state: "validated" }), "stateChanged");
  // A version change wins: that is someone's edit, and the row is reloaded.
  assert.equal(check("both", { version: 4, translation_state: "validated" }), "changed");
  assert.equal(check("unsent", { version: 3, translation_state: "ai_draft" }), "changed");
});
