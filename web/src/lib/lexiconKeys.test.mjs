// Run from web/: node --experimental-strip-types --no-warnings --test src/lib/lexiconKeys.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

import { lexiconKeys, normalizeStrong } from "./lexiconKeys.ts";

test("normalizeStrong: prefix particle, leading zeros and sense letter", () => {
  assert.deepEqual(normalizeStrong("b:H2320"), ["H2320"]);
  assert.deepEqual(normalizeStrong("H2148a"), ["H2148A", "H2148"]);
  assert.deepEqual(normalizeStrong("H0413"), ["H413"]);
  assert.deepEqual(normalizeStrong(""), []);
  assert.deepEqual(normalizeStrong("x"), []);
  // Search keeps matching the exact Strong's-Plus key only.
  assert.deepEqual(normalizeStrong("G42450"), ["G42450"]);
});

test("lexiconKeys (#527): UGNT Strong's-Plus also offers the classic key the lexicon holds", () => {
  // 3JN 1:1 UGNT: ὁ πρεσβύτερος Γαΐῳ.
  assert.deepEqual(lexiconKeys("G42450"), ["G42450", "G4245"]);
  assert.deepEqual(lexiconKeys("G35880"), ["G35880", "G3588"]);
  assert.deepEqual(lexiconKeys("G10500"), ["G10500", "G1050"]);
  // A classic (4-digit) Greek key and every Hebrew key are unchanged.
  assert.deepEqual(lexiconKeys("G4245"), ["G4245"]);
  assert.deepEqual(lexiconKeys("c:H3068"), ["H3068"]);
  assert.deepEqual(lexiconKeys("H2148a"), ["H2148A", "H2148"]);
  assert.deepEqual(lexiconKeys(""), []);
});
