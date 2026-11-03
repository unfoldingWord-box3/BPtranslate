// Tests for the translation-preferences restore helper (issue #788). The API
// side (two saves, restore the first, a third entry is recorded) runs the same
// helper against the real router in api/src/prefsHistory.test.mjs.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/prefsHistory.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import { rebuildPrefsVersion, restorableVersions } from "./prefsHistory.ts";

const EMPTY = {
  audience: null,
  purpose: null,
  register: "default",
  script_notes: null,
  instructions_md: null,
  common_issues_md: null,
  notes: null,
};

const entry = (id, prev_version, changed, extra = {}) => ({
  id,
  user_id: 8,
  username: "boss",
  source: null,
  action: prev_version === 0 ? "create" : "update",
  prev_version,
  new_version: prev_version + 1,
  created_at: 1_700_000_000 + id,
  changed,
  ...extra,
});

// v1: audience A. v2: instructions X (chat). v3: no change. v4: audience B, instructions Y.
const HISTORY = [
  entry(4, 3, { audience: { prev: "A", new: "B" }, instructions_md: { prev: "X", new: "Y" } }),
  entry(3, 2, {}),
  entry(2, 1, { instructions_md: { prev: null, new: "X" } }, { source: "chat" }),
  entry(1, 0, { audience: { prev: null, new: "A" } }),
];
const CURRENT = { ...EMPTY, audience: "B", instructions_md: "Y", version: 4 };

test("rebuilds each earlier version by undoing newer entries, newest first", () => {
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 4), {
    ok: true,
    fields: { ...EMPTY, audience: "B", instructions_md: "Y" },
  });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 3), {
    ok: true,
    fields: { ...EMPTY, audience: "A", instructions_md: "X" },
  });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 2), {
    ok: true,
    fields: { ...EMPTY, audience: "A", instructions_md: "X" },
    // v3 changed nothing, so v2 equals v3.
  });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 1), {
    ok: true,
    fields: { ...EMPTY, audience: "A" },
  });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 0), { ok: true, fields: EMPTY });
});

test("refuses when the newest entry is not the current version (a save landed since the list was read)", () => {
  const newer = { ...CURRENT, version: 5 };
  assert.deepEqual(rebuildPrefsVersion(newer, HISTORY, 2), { ok: false, reason: "stale" });
  assert.deepEqual(rebuildPrefsVersion({ ...CURRENT, version: 3 }, HISTORY, 2), { ok: false, reason: "stale" });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, [], 2), { ok: false, reason: "stale" });
});

test("refuses across a gap in the chain rather than guessing the missing change", () => {
  const gappy = [HISTORY[0], HISTORY[2], HISTORY[3]]; // v3 entry missing
  assert.deepEqual(rebuildPrefsVersion(CURRENT, gappy, 1), { ok: false, reason: "gap" });
});

test("refuses to rebuild across an entry whose change could not be read", () => {
  const unreadable = [HISTORY[0], { ...HISTORY[1], changed: null }, HISTORY[2], HISTORY[3]];
  assert.equal(rebuildPrefsVersion(CURRENT, unreadable, 3).ok, true, "versions newer than it still rebuild");
  assert.deepEqual(rebuildPrefsVersion(CURRENT, unreadable, 2), { ok: false, reason: "gap" });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, unreadable, 1), { ok: false, reason: "gap" });
  // A field change without a usable `prev` is refused too, not restored as undefined.
  const badField = [HISTORY[0], { ...HISTORY[1], changed: { audience: "oops" } }, HISTORY[2], HISTORY[3]];
  assert.deepEqual(rebuildPrefsVersion(CURRENT, badField, 2), { ok: false, reason: "gap" });
});

test("refuses a version the loaded entries don't reach", () => {
  const firstPage = HISTORY.slice(0, 2); // v4, v3
  assert.deepEqual(rebuildPrefsVersion(CURRENT, firstPage, 1), { ok: false, reason: "not_found" });
  assert.deepEqual(rebuildPrefsVersion(CURRENT, HISTORY, 9), { ok: false, reason: "not_found" });
});

test("the version before the oldest recorded save is restorable once the list is complete", () => {
  // History turned on at v7: the first recorded save (v7 -> v8) may be the one to undo.
  const late = [entry(11, 8, { notes: { prev: "n8", new: "n9" } }), entry(10, 7, { purpose: { prev: "P7", new: "P8" } })];
  const cur = { ...EMPTY, purpose: "P8", notes: "n9", version: 9 };
  assert.deepEqual(restorableVersions(late, false), [9, 8]);
  assert.deepEqual(restorableVersions(late, true), [9, 8, 7]);
  assert.deepEqual(rebuildPrefsVersion(cur, late, 7), { ok: true, fields: { ...EMPTY, purpose: "P7", notes: "n8" } });
  // Version 0 ("never saved") is not offered.
  assert.deepEqual(restorableVersions(HISTORY, true), [4, 3, 2, 1]);
});

test("ignores unknown fields in a recorded change", () => {
  const odd = [entry(1, 0, { audience: { prev: null, new: "A" }, assisted_mode: { prev: "0", new: "1" } })];
  const r = rebuildPrefsVersion({ ...EMPTY, audience: "A", version: 1 }, odd, 0);
  assert.deepEqual(r, { ok: true, fields: EMPTY });
});
