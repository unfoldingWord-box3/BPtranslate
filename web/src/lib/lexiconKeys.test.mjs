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

test("lexiconKeys (#527): UGNT Strong's-Plus maps to the classic key the lexicon holds, and only that", () => {
  // 3JN 1:1 UGNT: ὁ πρεσβύτερος Γαΐῳ.
  assert.deepEqual(lexiconKeys("G42450"), ["G4245"]);
  assert.deepEqual(lexiconKeys("G35880"), ["G3588"]);
  assert.deepEqual(lexiconKeys("G10500"), ["G1050"]);
  // Zero-padded Strong's-Plus (3JN UGNT): ἀκούω G01910 is classic G191, NOT
  // G1910 (a different word) — the zero-stripped form must never be offered.
  assert.deepEqual(lexiconKeys("G01910"), ["G191"]);
  assert.deepEqual(lexiconKeys("G00800"), ["G80"]);
  assert.deepEqual(lexiconKeys("G00010"), ["G1"]);
  assert.ok(!lexiconKeys("G01910").includes("G1910"));
  // A classic (4-digit) Greek key and every Hebrew key are unchanged.
  assert.deepEqual(lexiconKeys("G4245"), ["G4245"]);
  assert.deepEqual(lexiconKeys("c:H3068"), ["H3068"]);
  assert.deepEqual(lexiconKeys("H2148a"), ["H2148A", "H2148"]);
  assert.deepEqual(lexiconKeys(""), []);
});
