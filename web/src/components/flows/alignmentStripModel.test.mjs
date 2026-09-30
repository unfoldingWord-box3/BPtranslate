// Tests for alignmentStripModel.ts — the read-only ULT alignment strip on the
// flows notes screen (issue #431). Built from the REAL published ZEC files in
// docs/samples (en_ult + UHB), parsed the same way useSourceScripture parses
// the Door43 download, so the group structure under test is the one Door43
// serves, not a hand-built literal. Run from web/:
//   node --experimental-strip-types --no-warnings --test src/components/flows/alignmentStripModel.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSourceUsfm } from "../../lib/sourceUsfm.ts";
import { buildVerseIndex, coveredLaneSlices } from "../../lib/verseRange.ts";
import { recomputeTargetOccurrences } from "../../../../api/src/importParsers.ts";
import { buildAlignmentStrip, litUp, sameFocus } from "./alignmentStripModel.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ult = parseSourceUsfm(
  readFileSync(resolve(repoRoot, "docs/samples/en_ult_38-ZEC.usfm"), "utf8"),
  "ZEC",
  "SOURCE_LIT",
);
const uhb = parseSourceUsfm(
  readFileSync(resolve(repoRoot, "docs/samples/hbo_uhb_38-ZEC.usfm"), "utf8"),
  "ZEC",
  "UHB",
);

function slice(ch, v, quote = null, occurrence = 1) {
  const strip = buildAlignmentStrip(
    [
      {
        verse: v,
        verseObjects: ult[ch][v].content.verseObjects,
        sourceVerseObjects: uhb[ch][v].content.verseObjects,
      },
    ],
    quote,
    occurrence,
  );
  assert.equal(strip.length, 1);
  return strip[0];
}

const wordsOf = (s) => s.lane.prose.filter((t) => t.kind === "word");
const groupOf = (s, text, nth = 1) => {
  const hits = wordsOf(s).filter((t) => t.text === text);
  assert.ok(hits[nth - 1], `English word "${text}" #${nth} present`);
  return hits[nth - 1].groupId;
};
const englishIn = (s, groups) =>
  wordsOf(s)
    .filter((t) => t.groupId && groups.has(t.groupId))
    .map((t) => t.text)
    .join(" ");
const hebrewAt = (s, positions) =>
  [...positions].sort((a, b) => a - b).map((p) => s.words[p].text);

test("ZEC 1:1: each \\zaln-s span is one group, joined to the Hebrew it names", () => {
  const s = slice(1, 1);
  assert.equal(s.words.length, 16);
  // "In the eighth month," sits inside two nested milestones
  // (בַּחֹדֶשׁ + הַשְּׁמִינִי) — one compound group for all four words.
  const month = groupOf(s, "month");
  assert.ok(month);
  for (const w of ["In", "eighth"]) assert.equal(groupOf(s, w), month);
  assert.equal(groupOf(s, "the", 1), month);
  // "in the second year" is a different group.
  assert.notEqual(groupOf(s, "year"), month);
  assert.equal(groupOf(s, "second"), groupOf(s, "year"));
  // "the word of Yahweh came" — three nested milestones, one group.
  const yahweh = groupOf(s, "Yahweh");
  for (const w of ["word", "came"]) assert.equal(groupOf(s, w), yahweh);
  // Two "son of" spans, two different groups (occurrence 1 vs 2 of בֶּן).
  assert.notEqual(groupOf(s, "son", 1), groupOf(s, "son", 2));
  // Every English word in 1:1 is aligned.
  assert.ok(wordsOf(s).every((t) => t.groupId !== null));
  assert.equal(s.alignedPositions.size, 16);
});

test("hover an English word: its group and its Hebrew light up", () => {
  const s = slice(1, 1);
  const lit = litUp(s, 0, { slice: 0, side: "target", groupId: groupOf(s, "month") });
  assert.equal(englishIn(s, lit.groups), "In the eighth month");
  assert.deepEqual(hebrewAt(s, lit.positions), [s.words[0].text, s.words[1].text]);

  const yahweh = litUp(s, 0, { slice: 0, side: "target", groupId: groupOf(s, "Yahweh") });
  assert.equal(englishIn(s, yahweh.groups), "the word of Yahweh came");
  assert.deepEqual([...yahweh.positions].sort((a, b) => a - b), [5, 6, 7]);
});

test("hover a Hebrew word: the whole group lights on both sides", () => {
  const s = slice(1, 1);
  // Position 7 is יְהוָה; its group also renders הָיָה (5) and דְבַר (6).
  const lit = litUp(s, 0, { slice: 0, side: "original", position: 7 });
  assert.equal(englishIn(s, lit.groups), "the word of Yahweh came");
  assert.deepEqual([...lit.positions].sort((a, b) => a - b), [5, 6, 7]);
  // Second בֶּן (12) → the second "son of", not the first.
  const son2 = litUp(s, 0, { slice: 0, side: "original", position: 12 });
  assert.deepEqual([...son2.groups], [groupOf(s, "son", 2)]);
});

test("a supplied English word has no group; an unrendered Hebrew word lights nothing", () => {
  // ZEC 1:10 ULT supplies "These" with no Hebrew behind it.
  const s10 = slice(1, 10);
  assert.equal(groupOf(s10, "These"), null);
  // ZEC 1:16 leaves one אָמַר without an English rendering.
  const s16 = slice(1, 16);
  const hole = s16.words.find((w) => !s16.alignedPositions.has(w.position));
  assert.ok(hole, "ZEC 1:16 has an unrendered original word");
  const lit = litUp(s16, 0, { slice: 0, side: "original", position: hole.position });
  assert.equal(lit.groups.size, 0);
  assert.equal(lit.positions.size, 0);
});

test("the note quote is marked on both sides (the #430 mark survives)", () => {
  // The seeded ZEC 1:1 note quote.
  const s = slice(1, 1, "הָיָ֣ה דְבַר־יְהוָ֗ה אֶל־זְכַרְיָה֙", 1);
  assert.deepEqual([...s.quotedPositions].sort((a, b) => a - b), [5, 6, 7, 8, 9]);
  const marked = wordsOf(s)
    .filter((t) => s.quotedWordIds.has(t.id))
    .map((t) => t.text)
    .join(" ");
  assert.equal(marked, "the word of Yahweh came to Zechariah");
  // No quote → nothing marked.
  const none = slice(1, 1);
  assert.equal(none.quotedPositions.size, 0);
  assert.equal(none.quotedWordIds.size, 0);
});

test("focus is per slice, and tapping the same word again toggles it off", () => {
  const s = slice(1, 1);
  const g = groupOf(s, "month");
  assert.equal(litUp(s, 1, { slice: 0, side: "target", groupId: g }).groups.size, 0);
  assert.equal(litUp(s, 0, null).groups.size, 0);
  assert.ok(sameFocus({ slice: 0, side: "target", groupId: g }, { slice: 0, side: "target", groupId: g }));
  assert.ok(!sameFocus({ slice: 0, side: "original", position: 1 }, { slice: 0, side: "original", position: 2 }));
  assert.ok(!sameFocus({ slice: 0, side: "original", position: 1 }, null));
});

test("a bridged note gets one slice per verse; a verse with no ULT tree is skipped", () => {
  const strip = buildAlignmentStrip(
    [
      { verse: 1, verseObjects: ult[1][1].content.verseObjects, sourceVerseObjects: uhb[1][1].content.verseObjects },
      { verse: 2, verseObjects: null, sourceVerseObjects: uhb[1][2].content.verseObjects },
      { verse: 3, verseObjects: ult[1][3].content.verseObjects, sourceVerseObjects: uhb[1][3].content.verseObjects },
    ],
    null,
    1,
  );
  assert.deepEqual(strip.map((s) => s.verse), [1, 3]);
});

test("a quote on the 2nd occurrence of a repeated Hebrew word marks the 2nd, not the 1st", () => {
  // ZEC 1:1 has בֶּן twice (positions 10 and 12). The raw UHB file stamps no
  // x-occurrence on \w, but the screen never sees it raw: GET /api/chapters
  // renumbers source occurrences by position (api/src/chapters.ts, the
  // "two כָל in ZEC 5:3" comment). Build the source the way it is served.
  const served = structuredClone(uhb[1][1].content.verseObjects);
  recomputeTargetOccurrences(served);
  const [s] = buildAlignmentStrip(
    [{ verse: 1, verseObjects: ult[1][1].content.verseObjects, sourceVerseObjects: served }],
    "בֶּן",
    2,
  );
  assert.deepEqual([...s.quotedPositions], [12]);
  const marked = wordsOf(s).filter((t) => s.quotedWordIds.has(t.id));
  assert.deepEqual(marked.map((t) => t.text), ["son", "of"]);
  assert.equal(marked[0].groupId, groupOf(s, "son", 2), "the second 'son of', not the first");
});

// A published ULT verse bridge (\v 1-2) whose note covers only verse 2. The
// lane hands over the whole bridge as the target but only UHB verse 2 as the
// source, so the bridge's verse-1 "Yahweh" would resolve onto verse 2's
// יְהוָה — lighting a word it does not translate. Hand-built, real USFM syntax.
const BRIDGED_ULT = String.raw`\id ZEC
\c 1
\p
\v 1-2 \zaln-s |x-strong="H1696" x-lemma="דָּבַר" x-morph="He,C:Vpw3ms" x-occurrence="1" x-occurrences="1" x-content="וַיְדַבֵּר"\*\w Then|x-occurrence="1" x-occurrences="1"\w* \w spoke|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-morph="He,Np" x-occurrence="1" x-occurrences="2" x-content="יְהוָה"\*\w Yahweh|x-occurrence="1" x-occurrences="2"\w*\zaln-e\*. \zaln-s |x-strong="H0559" x-lemma="אָמַר" x-morph="He,C:Vqw3ms" x-occurrence="1" x-occurrences="1" x-content="וַיֹּאמֶר"\*\w And|x-occurrence="1" x-occurrences="1"\w* \w said|x-occurrence="1" x-occurrences="1"\w*\zaln-e\* \zaln-s |x-strong="H3068" x-lemma="יְהֹוָה" x-morph="He,Np" x-occurrence="2" x-occurrences="2" x-content="יְהוָה"\*\w Yahweh|x-occurrence="2" x-occurrences="2"\w*\zaln-e\*.
`;
const BRIDGED_UHB = String.raw`\id ZEC
\c 1
\p
\v 1 \w וַיְדַבֵּר|lemma="דָּבַר" strong="c:H1696" x-morph="He,C:Vpw3ms"\w* \w יְהוָה|lemma="יְהֹוָה" strong="H3068" x-morph="He,Np"\w*׃
\v 2 \w וַיֹּאמֶר|lemma="אָמַר" strong="c:H0559" x-morph="He,C:Vqw3ms"\w* \w יְהוָה|lemma="יְהֹוָה" strong="H3068" x-morph="He,Np"\w*׃
`;

test("a bridged ULT verse is not aligned (falls back to the plain lane) rather than lighting wrong words", () => {
  const ultIdx = buildVerseIndex(parseSourceUsfm(BRIDGED_ULT, "ZEC", "SOURCE_LIT")[1]);
  const uhbIdx = buildVerseIndex(parseSourceUsfm(BRIDGED_UHB, "ZEC", "UHB")[1]);
  assert.equal(ultIdx[2].verse_end, 2, "fixture really is a \\v 1-2 bridge");
  for (const covered of [[2], [1, 2]]) {
    const { slices } = coveredLaneSlices(ultIdx, uhbIdx, covered);
    const strip = buildAlignmentStrip(
      slices.map((s) => ({ ...s, verseEnd: ultIdx[s.verse]?.verse_end ?? null })),
      null,
      1,
    );
    assert.equal(strip, null, `covered ${covered}: bridged lane must not be aligned`);
  }
  // A plain (unbridged) slice list still aligns.
  assert.ok(Array.isArray(buildAlignmentStrip([{ verse: 1, verseEnd: null, verseObjects: ult[1][1].content.verseObjects, sourceVerseObjects: uhb[1][1].content.verseObjects }], null, 1)));
});
