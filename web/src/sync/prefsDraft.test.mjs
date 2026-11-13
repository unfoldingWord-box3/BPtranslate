import assert from "node:assert";
import {
  afterPrefsConflict,
  afterPrefsSave,
  hydratePrefsDraft,
  prefsDraftKey,
  prefsVersionToSend,
  sameFields,
} from "./prefsDraft.ts";

// Issue #909: the Style page's Brief / Instructions / Common issues editors
// keep their typing in the drafts store, with the field values and the prefs
// version the text was typed against. All three share one prefs version
// (#145), so whether a save is stale is judged per field, not by version.

const start = { common_issues_md: "start" };
const fromB = { common_issues_md: "from B" };

// ── keys ───────────────────────────────────────────────────────────────────
assert.strictEqual(prefsDraftKey("common_issues_md"), "prefs:common_issues_md");
assert.notStrictEqual(prefsDraftKey("brief"), prefsDraftKey("instructions_md"));

// ── sameFields ─────────────────────────────────────────────────────────────
assert.ok(sameFields({ a: "x", b: null }, { a: "x", b: null }));
assert.ok(!sameFields({ a: "x" }, { a: "y" }));
assert.ok(!sameFields({ a: null }, { a: "" }));

// ── prefsVersionToSend ─────────────────────────────────────────────────────
// This page's own Brief save moved the version from 5 to 6, but Common issues
// is still what the text was typed against: send 6, no self-conflict (#145).
assert.strictEqual(prefsVersionToSend(start, 6, start, 5), 6);
// Another admin changed Common issues and this page learned of it (its Brief
// save brought the new row in): send the typed-against version so the
// server answers 409 instead of the stale text overwriting theirs.
assert.strictEqual(prefsVersionToSend(fromB, 7, start, 5), 5);
// Nothing learned yet: the current version is the typed-against one, and the
// server's own version check catches a newer row.
assert.strictEqual(prefsVersionToSend(start, 5, start, 5), 5);

// ── hydratePrefsDraft ──────────────────────────────────────────────────────
// No stored draft: seed from the server.
assert.deepStrictEqual(hydratePrefsDraft(start, 5, undefined), {
  text: start,
  base: start,
  baseVersion: 5,
  clearStored: false,
});
// A stored draft whose text differs: the typing comes back with the base it
// was typed against (a remount after a restore or a lesson move, or a reload).
const typed = { common_issues_md: "start TYPED" };
assert.deepStrictEqual(
  hydratePrefsDraft(fromB, 7, { payload: { text: typed, base: start }, expectedVersion: 5 }),
  { text: typed, base: start, baseVersion: 5, clearStored: false },
);
// A stored draft that equals the server text holds nothing unsaved: dropped.
assert.deepStrictEqual(
  hydratePrefsDraft(typed, 8, { payload: { text: typed, base: start }, expectedVersion: 5 }),
  { text: typed, base: typed, baseVersion: 8, clearStored: true },
);
// A malformed record (no text) is ignored and dropped.
assert.deepStrictEqual(hydratePrefsDraft(start, 5, { payload: { content: 1 }, expectedVersion: 1 }), {
  text: start,
  base: start,
  baseVersion: 5,
  clearStored: true,
});
// A record for other fields than this editor's is ignored and dropped.
assert.strictEqual(
  hydratePrefsDraft(start, 5, { payload: { text: { x: "1" }, base: { x: "0" } }, expectedVersion: 1 }).clearStored,
  true,
);

// ── afterPrefsConflict ─────────────────────────────────────────────────────
// Typed: the text is kept and rebased on the server row, so the next Save
// goes through (the existing "save again to apply" conflict handling).
assert.deepStrictEqual(afterPrefsConflict(typed, start, fromB, 7), { text: typed, base: fromB, baseVersion: 7 });
// Nothing typed: the box takes the server text, so a second click cannot
// write the stale copy over it.
assert.deepStrictEqual(afterPrefsConflict(start, start, fromB, 7), { text: fromB, base: fromB, baseVersion: 7 });

// ── afterPrefsSave ─────────────────────────────────────────────────────────
// Saved what is shown: clean.
assert.deepStrictEqual(afterPrefsSave(typed, typed, 8), { text: typed, base: typed, baseVersion: 8 });
// Typing went on while the save was in flight: kept, against the saved base.
const more = { common_issues_md: "start TYPED more" };
assert.deepStrictEqual(afterPrefsSave(more, typed, 8), { text: more, base: typed, baseVersion: 8 });

console.log("prefsDraft: all assertions passed.");
