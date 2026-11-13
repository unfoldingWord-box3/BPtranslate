import assert from "node:assert";
import {
  afterPrefsConflict,
  afterPrefsSave,
  hydratePrefsDraft,
  prefsDraftClearable,
  prefsDraftKey,
  prefsSavePayload,
  prefsVersionToSend,
  sameFields,
  typedKeys,
} from "./prefsDraft.ts";
import { prefsConflictRow } from "./prefsConflict.ts";

// Issue #909: the Style page's Brief / Instructions / Common issues editors
// keep their typing in the drafts store, with the field values and the prefs
// version the text was typed against. All three share one prefs version
// (#145), so whether a save is stale is judged per field, not by version, and
// within Brief per box: only the boxes typed in are the editor's own.

const start = { common_issues_md: "start" };
const fromB = { common_issues_md: "from B" };
const typed = { common_issues_md: "start TYPED" };

// ── keys ───────────────────────────────────────────────────────────────────
assert.strictEqual(prefsDraftKey("common_issues_md"), "prefs:common_issues_md");
assert.notStrictEqual(prefsDraftKey("brief"), prefsDraftKey("instructions_md"));

// ── sameFields / typedKeys ─────────────────────────────────────────────────
assert.ok(sameFields({ a: "x", b: null }, { a: "x", b: null }));
assert.ok(!sameFields({ a: "x" }, { a: "y" }));
assert.ok(!sameFields({ a: null }, { a: "" }));
assert.deepStrictEqual(typedKeys({ a: "x", b: "2" }, { a: "x", b: "1" }), ["b"]);
assert.deepStrictEqual(typedKeys(start, start), []);

// ── prefsVersionToSend ─────────────────────────────────────────────────────
// This page's own Brief save moved the version from 5 to 6, but Common issues
// is still what the text was typed against: send 6, no self-conflict (#145).
assert.strictEqual(prefsVersionToSend(start, 6, typed, start, 5), 6);
// Another admin changed Common issues and this page learned of it: send the
// typed-against version so the server answers 409.
assert.strictEqual(prefsVersionToSend(fromB, 7, typed, start, 5), 5);
// Nothing typed but the box is stale: 409 too, so the stale copy is not saved.
assert.strictEqual(prefsVersionToSend(fromB, 7, start, start, 5), 5);
// Nothing learned yet: the server's own version check catches a newer row.
assert.strictEqual(prefsVersionToSend(start, 5, typed, start, 5), 5);

// Brief, per box (gate review H1): typed in Audience only; another admin
// changed Purpose. Audience is unchanged on the server, so no conflict…
const brief0 = { audience: "A0", purpose: "P0", register: "default", script_notes: null, notes: "N0" };
const briefTyped = { ...brief0, audience: "A0 typed" };
const briefServer = { ...brief0, purpose: "P1 from B", notes: "N1 from chat" };
assert.strictEqual(prefsVersionToSend(briefServer, 9, briefTyped, brief0, 5), 9);
// …and the save sends the server's Purpose and notes, not the stale copies.
assert.deepStrictEqual(prefsSavePayload(briefServer, briefTyped, brief0), {
  ...briefServer,
  audience: "A0 typed",
});
// A box typed in that the server changed too: conflict.
assert.strictEqual(prefsVersionToSend({ ...briefServer, audience: "A1" }, 9, briefTyped, brief0, 5), 5);
// Nothing typed: the shown text is sent (and 409s above when stale).
assert.deepStrictEqual(prefsSavePayload(fromB, start, start), start);

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
assert.deepStrictEqual(
  hydratePrefsDraft(fromB, 7, { payload: { text: typed, base: start }, expectedVersion: 5 }),
  { text: typed, base: start, baseVersion: 5, clearStored: false },
);
// A stored draft that equals the server text holds nothing unsaved: dropped.
assert.deepStrictEqual(
  hydratePrefsDraft(typed, 8, { payload: { text: typed, base: start }, expectedVersion: 5 }),
  { text: typed, base: typed, baseVersion: 8, clearStored: true },
);
// Brief: only the typed box comes back; Purpose and notes come from the server.
assert.deepStrictEqual(
  hydratePrefsDraft(briefServer, 9, { payload: { text: briefTyped, base: brief0 }, expectedVersion: 5 }),
  {
    text: { ...briefServer, audience: "A0 typed" },
    base: { ...briefServer, audience: "A0" },
    baseVersion: 5,
    clearStored: false,
  },
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
// Brief: the typed box is kept, every other box takes the server's value, so
// "save again" cannot send the stale Purpose or notes.
assert.deepStrictEqual(afterPrefsConflict(briefTyped, brief0, briefServer, 9), {
  text: { ...briefServer, audience: "A0 typed" },
  base: briefServer,
  baseVersion: 9,
});

// ── afterPrefsSave(textNow, textAtSave, saved, version) ────────────────────
// Saved what is shown: clean.
assert.deepStrictEqual(afterPrefsSave(typed, typed, typed, 8), { text: typed, base: typed, baseVersion: 8 });
// Typing went on while the save was in flight: kept, against the saved base.
const more = { common_issues_md: "start TYPED more" };
assert.deepStrictEqual(afterPrefsSave(more, typed, typed, 8), { text: more, base: typed, baseVersion: 8 });
// Round 2 J2: the box was put back (A1 → A0) while the save of A1 was in
// flight. The undo is kept as typing against the saved A1, not dropped.
assert.deepStrictEqual(afterPrefsSave({ a: "A0" }, { a: "A1" }, { a: "A1" }, 8), {
  text: { a: "A0" },
  base: { a: "A1" },
  baseVersion: 8,
});
// Brief: a stale untyped box takes the saved (server) value, so it does not
// turn into "typed" text holding the old value.
const savedBrief = { ...briefServer, audience: "A0 typed" };
assert.deepStrictEqual(afterPrefsSave(briefTyped, briefTyped, savedBrief, 10), {
  text: savedBrief,
  base: savedBrief,
  baseVersion: 10,
});

// ── prefsDraftClearable (gate review H5) ───────────────────────────────────
// A clear is fenced by content: only a record this tab wrote (or one holding
// exactly the text being settled) is deleted, never another tab's newer text.
assert.ok(prefsDraftClearable({ text: typed, base: start }, [typed]));
assert.ok(!prefsDraftClearable({ text: { common_issues_md: "tab B" }, base: start }, [typed, start]));
assert.ok(!prefsDraftClearable({ content: 1 }, [typed]));

// ── prefsConflictRow (gate review H3) ──────────────────────────────────────
const row = { version: 4, error: undefined };
const body = { error: "version_mismatch", current: { version: 3 } };
assert.deepStrictEqual(await prefsConflictRow(body, async () => row), { version: 3 });
// A 409 body without `current`: the row is fetched, so the editor can rebase.
assert.deepStrictEqual(await prefsConflictRow({ error: "version_mismatch" }, async () => row), row);
// The fetch failing gives null (the caller falls back to a plain refetch).
assert.strictEqual(
  await prefsConflictRow({}, async () => {
    throw new Error("offline");
  }),
  null,
);

console.log("prefsDraft: all assertions passed.");
