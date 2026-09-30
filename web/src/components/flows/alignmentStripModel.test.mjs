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
