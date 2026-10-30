// Smoke test for importParsers.ts against docs/samples/. Run from api/:
//   node --experimental-strip-types --no-warnings src/importParsers.test.mjs
//
// Asserts that the parser produces non-empty output and that filtered ranges
// behave correctly. Not a test framework; failures exit non-zero.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractVersesForRange,
  normalizeWordPunctuation,
  splitGluedAlignmentWords,
  recomputeTargetOccurrences,
  dropDoubledLeadingMarkers,
  stripOrphanAlignmentMarkers,
  parseTsv,
  refParts,
  coveredVersesFromRef,
  makeVerseSortOrder,
  collectSourceWords,
  healReplacementChars,
  reconcileSourceAttrsFromMaster,
  hasReplacementChar,
  normalizeNoteWhitespace,
  findSuspiciousDoubleSpaces,
  sanitizeMarkerSpacing,
  sanitizeWordAttributes,
  dropDuplicateSourceMilestones,
  curlifyVerseObjects,
  curlifyText,
  extractPlainText,
} from "./importParsers.ts";
import usfm from "usfm-js";

// Collect target `\w` words with their alignment status (inside a `\zaln-s`?).
function collectWords(nodes, inZaln, acc) {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== "object") continue;
    if (n.type === "word" && n.tag === "w") {
      acc.push({ text: n.text, occurrence: n.occurrence, occurrences: n.occurrences, aligned: inZaln });
    } else if (Array.isArray(n.children)) {
      collectWords(n.children, inZaln || n.tag === "zaln", acc);
    }
  }
  return acc;
}

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../../docs/samples");

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- USFM: ULT ZEC chapter 3 ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const ch3 = extractVersesForRange(raw, 3, 3);
  assert(ch3.length > 0, `extractVersesForRange ULT ZEC 3 yields verses (got ${ch3.length})`);
  assert(
    ch3.every((v) => v.chapter === 3),
    `every extracted verse has chapter=3`,
  );
  const v1 = ch3.find((v) => v.verse === 1);
  assert(v1, `ZEC 3:1 exists`);
  assert(typeof v1.contentJson === "string" && v1.contentJson.length > 50, `ZEC 3:1 has non-trivial content_json`);
  assert(typeof v1.plainText === "string" && v1.plainText.length > 0, `ZEC 3:1 has plain text`);
  console.log(`  ZEC 3 ULT verse count: ${ch3.length}`);
  console.log(`  ZEC 3:1 ULT plain: ${v1.plainText.slice(0, 80)}…`);
}

// --- USFM: chapter outside range returns 0 ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const noMatch = extractVersesForRange(raw, 99, 99);
  assert(noMatch.length === 0, `out-of-range chapter yields no verses`);
}

// --- USFM: multi-verse block (\v 8-9 in UST ISA 7) preserves the range ---
{
  const raw = readFileSync(resolve(samples, "en_ust_23-ISA.usfm"), "utf8");
  const ch7 = extractVersesForRange(raw, 7, 7);
  const block = ch7.find((v) => v.verse === 8);
  assert(block, `UST ISA 7:8 verse row exists`);
  assert(block.verseEnd === 9, `UST ISA 7:8 carries verseEnd=9 (got ${block.verseEnd})`);
  const singleton = ch7.find((v) => v.verse === 1);
  assert(singleton && singleton.verseEnd === null, `UST ISA 7:1 is singleton (verseEnd null)`);
  // No row at verse=9 — the 8-9 block owns that slot.
  const nine = ch7.find((v) => v.verse === 9);
  assert(!nine, `UST ISA 7:9 has no standalone row (consumed by 8-9 block)`);
  console.log(`  UST ISA 7:8-9 plain: ${block.plainText.slice(0, 80)}…`);
}

// --- USFM: inverted range collapses to singleton ---
{
  const synthetic = "\\id TST\n\\c 1\n\\v 1 first\n\\v 9-8 inverted\n\\v 10 tenth\n";
  const out = extractVersesForRange(synthetic, 1, 1);
  const inv = out.find((v) => v.verse === 9);
  assert(inv, `inverted range row exists at start`);
  assert(inv.verseEnd === null, `inverted range "9-8" collapses to singleton (verseEnd null)`);
}

// --- USFM: plain singleton has verseEnd=null ---
{
  const synthetic = "\\id TST\n\\c 1\n\\v 7 plain content\n";
  const out = extractVersesForRange(synthetic, 1, 1);
  const v7 = out.find((v) => v.verse === 7);
  assert(v7, `singleton verse 7 row exists`);
  assert(v7.verseEnd === null, `singleton has verseEnd null`);
}

// --- TSV: TN ZEC ---
{
  const raw = readFileSync(resolve(samples, "en_tn_tn_ZEC.tsv"), "utf8");
  const { headers, rows } = parseTsv(raw);
  assert(headers.includes("Reference"), `TN TSV has Reference header`);
  assert(headers.includes("ID"), `TN TSV has ID header`);
  assert(headers.includes("Note"), `TN TSV has Note header`);
  const ch3 = rows.filter((r) => {
    const [ch] = refParts(r["Reference"]);
    return ch === 3;
  });
  assert(ch3.length > 0, `TN ZEC 3 has rows (got ${ch3.length})`);
  console.log(`  ZEC 3 TN row count: ${ch3.length}`);
  console.log(`  ZEC 3 TN first row: ${JSON.stringify(ch3[0]).slice(0, 120)}…`);
}

// --- TSV: TQ ZEC ---
{
  const raw = readFileSync(resolve(samples, "en_tq_tq_ZEC.tsv"), "utf8");
  const { headers, rows } = parseTsv(raw);
  assert(headers.includes("Question"), `TQ TSV has Question header`);
  const ch3 = rows.filter((r) => {
    const [ch] = refParts(r["Reference"]);
    return ch === 3;
  });
  assert(ch3.length > 0, `TQ ZEC 3 has rows (got ${ch3.length})`);
  console.log(`  ZEC 3 TQ row count: ${ch3.length}`);
}

// --- refParts edge cases ---
{
  assert(JSON.stringify(refParts("3:1")) === JSON.stringify([3, 1]), "refParts 3:1");
  assert(JSON.stringify(refParts("front:intro")) === JSON.stringify([0, 0]), "refParts front:intro");
  assert(JSON.stringify(refParts("1:intro")) === JSON.stringify([1, 0]), "refParts 1:intro");
  assert(JSON.stringify(refParts("1:1-3")) === JSON.stringify([1, 1]), "refParts 1:1-3");
  assert(JSON.stringify(refParts(null)) === JSON.stringify([0, 0]), "refParts null");
}

// --- coveredVersesFromRef (server twin of web noteCoveredVerses) ---
{
  const cv = (ref, lead) => JSON.stringify(coveredVersesFromRef(ref, lead));
  assert(cv("1:2", 2) === "[2]", "coveredVersesFromRef singleton");
  assert(cv("1:2-3", 2) === "[2,3]", "coveredVersesFromRef bridge 2-3");
  assert(cv("1:2,4", 2) === "[2,4]", "coveredVersesFromRef comma list");
  assert(cv("1:2-3,5", 2) === "[2,3,5]", "coveredVersesFromRef range+comma");
  assert(cv("1:2-2:3", 2) === "[2]", "coveredVersesFromRef cross-chapter → leading only");
  assert(cv(null, 5) === "[5]", "coveredVersesFromRef null → leading");
  // Malformed huge range is bounded (no runaway loop).
  assert(coveredVersesFromRef("1:1-1000000000", 1).length <= 402, "coveredVersesFromRef bounds huge range");
}

// --- normalizeWordPunctuation: strip leading/trailing punct off `\w` text ---
{
  // bare `\w "What\w*` at top level
  const input = [
    { type: "word", tag: "w", text: '"What', occurrence: "1", occurrences: "1" },
  ];
  const out = normalizeWordPunctuation(input);
  assert(out.length === 2, `"\\w \\"What\\w*" splits into 2 nodes (got ${out.length})`);
  assert(out[0].type === "text" && out[0].text === '"', `leading quote becomes text node`);
  assert(out[1].type === "word" && out[1].text === "What", `core text is "What"`);
}
{
  // trailing punctuation: `\w seeing?"\w*`
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: 'seeing?"', occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 2, `"\\w seeing?\\"\\w*" splits into 2 nodes`);
  assert(out[0].type === "word" && out[0].text === "seeing", `core text is "seeing"`);
  assert(out[1].type === "text" && out[1].text === '?"', `trailing ?\\" becomes text node`);
}
{
  // multi-word `\w` content stays intact
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "of the LORD", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1, `multi-word \\w stays one node`);
  assert(out[0].text === "of the LORD", `multi-word \\w content preserved`);
}
{
  // intra-word apostrophe / hyphen — leave alone
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "don't", occurrence: "1", occurrences: "1" },
    { type: "word", tag: "w", text: "hello-world", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 2 && out[0].text === "don't" && out[1].text === "hello-world", `apostrophe / hyphen stay intra-word`);
}
{
  // descends into milestone children (the real bug pattern)
  const out = normalizeWordPunctuation([
    {
      type: "milestone",
      tag: "zaln",
      strong: "H1",
      content: "א",
      children: [
        { type: "word", tag: "w", text: '"What', occurrence: "1", occurrences: "1" },
      ],
      endTag: "zaln-e\\*",
    },
  ]);
  assert(out.length === 1 && out[0].type === "milestone", `milestone preserved at top level`);
  const kids = out[0].children;
  assert(kids.length === 2, `milestone child \\w "What\\w* splits into 2 children`);
  assert(kids[0].type === "text" && kids[0].text === '"', `inner leading quote becomes text`);
  assert(kids[1].type === "word" && kids[1].text === "What", `inner core is "What"`);
}
{
  // all-punctuation `\w` collapses to plain text
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: '"', occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1 && out[0].type === "text" && out[0].text === '"', `all-punctuation \\w becomes text`);
}
{
  // numeric `\w 30\w*` (UST uses these for measurements) — preserve as one token
  const out = normalizeWordPunctuation([
    { type: "word", tag: "w", text: "30", occurrence: "1", occurrences: "1" },
  ]);
  assert(out.length === 1 && out[0].type === "word" && out[0].text === "30", `numeric \\w stays one token`);
}

// --- splitGluedAlignmentWords: de-glue AI punctuation-spanning `\w` tokens ---
{
  // (a) glued token inside a zaln → fragments fall out to unaligned, the
  // preceding aligned word stays put, punctuation rides as a text node.
  const out = splitGluedAlignmentWords([
    {
      type: "milestone", tag: "zaln", strong: "H1", content: "הוֹצֵאתִיהָ",
      children: [
        { type: "word", tag: "w", text: "it", occurrence: "1", occurrences: "1" },
        { type: "text", text: " " },
        { type: "word", tag: "w", text: "out”—the", occurrence: "1", occurrences: "1" },
      ],
    },
  ]);
  const words = collectWords(out, false, []);
  assert(!words.some((w) => w.text === "out”—the"), `glued "out”—the" is no longer a single \\w token`);
  const wOut = words.find((w) => w.text === "out");
  const wThe = words.find((w) => w.text === "the");
  const wIt = words.find((w) => w.text === "it");
  assert(wOut && wOut.aligned === false, `"out" falls out to unaligned`);
  assert(wThe && wThe.aligned === false, `"the" falls out to unaligned`);
  assert(wIt && wIt.aligned === true, `preceding "it" stays aligned`);
  assert(out.some((n) => n.type === "text" && n.text === "”—"), `punctuation "”—" rides as a top-level text node`);
}
{
  // (b) occurrence recompute: the freed "the" plus an existing "the" resolve to
  // a consistent 1/2 + 2/2 (the glued token carried a bogus 1/1).
  const out = splitGluedAlignmentWords([
    { type: "milestone", tag: "zaln", strong: "H1", content: "א",
      children: [{ type: "word", tag: "w", text: "out”—the", occurrence: "1", occurrences: "1" }] },
    { type: "text", text: " " },
    { type: "milestone", tag: "zaln", strong: "H2", content: "ב",
      children: [{ type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "1" }] },
  ]);
  const thes = collectWords(out, false, []).filter((w) => w.text === "the");
  assert(thes.length === 2, `two "the" tokens after split (got ${thes.length})`);
  assert(thes.every((w) => w.occurrences === "2"), `both "the" share occurrences="2"`);
  assert(
    JSON.stringify(thes.map((w) => w.occurrence).sort()) === JSON.stringify(["1", "2"]),
    `"the" occurrences numbered 1 and 2`,
  );
}
{
  // (c) negatives — never split; clean input returns the SAME array (no-op).
  const multi = [{ type: "word", tag: "w", text: "of the LORD", occurrence: "1", occurrences: "1" }];
  assert(splitGluedAlignmentWords(multi) === multi, `multi-word "of the LORD" untouched (identity)`);
  const intra = [
    { type: "word", tag: "w", text: "don't", occurrence: "1", occurrences: "1" },
    { type: "word", tag: "w", text: "hello-world", occurrence: "1", occurrences: "1" },
  ];
  assert(splitGluedAlignmentWords(intra) === intra, `apostrophe / hyphen words untouched`);
  const range = [{ type: "word", tag: "w", text: "1914–1918", occurrence: "1", occurrences: "1" }];
  assert(splitGluedAlignmentWords(range) === range, `number range "1914–1918" untouched (dash between digits)`);
}

// --- integration: real ZEC 5:4 through extractVersesForRange ---
{
  const raw = readFileSync(resolve(samples, "en_ult_38-ZEC.usfm"), "utf8");
  const v4 = extractVersesForRange(raw, 5, 5).find((v) => v.verse === 4);
  assert(v4, "ZEC 5:4 ULT exists");
  const words = collectWords(JSON.parse(v4.contentJson).verseObjects, false, []);
  assert(
    !words.some((w) => w.text === "out”—the" || w.text === "Armies—“and"),
    `ZEC 5:4 glued tokens out”—the / Armies—“and are split`,
  );
  assert(words.some((w) => w.text === "out" && !w.aligned), `ZEC 5:4 "out" fell out to unaligned`);
  assert(words.some((w) => w.text === "Armies" && !w.aligned), `ZEC 5:4 "Armies" fell out to unaligned`);
  assert(words.some((w) => w.text === "the" && !w.aligned), `ZEC 5:4 freed "the" is unaligned`);
  assert(words.some((w) => w.text === "and" && !w.aligned), `ZEC 5:4 freed "and" is unaligned`);
  const thes = words.filter((w) => w.text === "the");
  assert(new Set(thes.map((w) => w.occurrences)).size === 1, `all "the" agree on the occurrences total`);
  assert(new Set(thes.map((w) => w.occurrence)).size === thes.length, `"the" occurrence numbers are unique`);
  assert(v4.plainText.includes("out”—the"), `plain_text still reads "out”—the" (split is text-invariant)`);
  console.log(`  ZEC 5:4 ULT words: ${words.length}; out/Armies unaligned, "the"×${thes.length} renumbered`);
}

// --- recomputeTargetOccurrences: heal malformed / colliding occurrence data ---
// Reproduces the real ZEC 5:3 production corruption: every `occurrences="1"`
// and a colliding (text, occurrence) pair — two "is" both stamped
// occurrence="2" — which made one highlight key match two physical words and
// hid duplicates from the colors filter. Target `\w` are nested inside
// `\zaln-s` milestones (the ULT/UST shape).
{
  const vos = [
    {
      type: "milestone", tag: "zaln", content: "זֹאת", occurrence: "1", occurrences: "1",
      children: [
        { type: "word", tag: "w", text: "This", occurrence: "1", occurrences: "1" },
        { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
      ],
    },
    { type: "text", text: " " },
    {
      type: "milestone", tag: "zaln", content: "הַגֹּנֵב", occurrence: "1", occurrences: "1",
      children: [
        { type: "word", tag: "w", text: "who", occurrence: "1", occurrences: "1" },
        { type: "word", tag: "w", text: "is", occurrence: "2", occurrences: "1" },
        { type: "word", tag: "w", text: "stealing", occurrence: "1", occurrences: "1" },
      ],
    },
  ];
  const ret = recomputeTargetOccurrences(vos);
  assert(ret === vos, `recompute mutates in place and returns the same array`);
  const words = collectWords(vos, false, []);
  const ises = words.filter((w) => w.text === "is");
  assert(ises.length === 2, `two "is" tokens collected`);
  assert(ises.every((w) => w.occurrences === "2"), `both "is" now occurrences="2" (was the bogus "1")`);
  assert(
    JSON.stringify(ises.map((w) => w.occurrence)) === JSON.stringify(["1", "2"]),
    `colliding "is" renumbered 1,2 in document order`,
  );
  const stealing = words.find((w) => w.text === "stealing");
  assert(stealing.occurrence === "1" && stealing.occurrences === "1", `singleton "stealing" is 1/1`);
  // The fix must NOT touch the source `\zaln-s` milestone occurrence.
  assert(vos[0].occurrence === "1" && vos[2].occurrence === "1", `source milestone occurrence untouched`);
}
{
  // Clean, already-correct input → values unchanged (no-op / round-trip safe).
  const vos = [
    { type: "word", tag: "w", text: "the", occurrence: "1", occurrences: "2" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "the", occurrence: "2", occurrences: "2" },
    { type: "word", tag: "w", text: "earth", occurrence: "1", occurrences: "1" },
  ];
  recomputeTargetOccurrences(vos);
  const words = collectWords(vos, false, []);
  const thes = words.filter((w) => w.text === "the");
  assert(
    JSON.stringify(thes.map((w) => `${w.occurrence}/${w.occurrences}`)) === JSON.stringify(["1/2", "2/2"]),
    `clean "the" 1/2,2/2 unchanged (no-op)`,
  );
  const earth = words.find((w) => w.text === "earth");
  assert(earth.occurrence === "1" && earth.occurrences === "1", `clean singleton unchanged`);
}
{
  // Source UHB shape: bare `\w` (no \zaln-s) with NO occurrence attribute —
  // usfm-js leaves it undefined on import, so the two כָל in ZEC 5:3 would
  // both default to `כָל|1` and a single note quote highlights both. The read
  // boundary recomputes them by position. Mirrors the verse parsed live above.
  const vos = [
    { type: "word", tag: "w", text: "כָל" },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הָאָרֶץ" },
    { type: "text", text: " " },
    { type: "word", tag: "w", text: "כָל" },
    { type: "text", text: "־" },
    { type: "word", tag: "w", text: "הַגֹּנֵב" },
  ];
  recomputeTargetOccurrences(vos);
  const words = collectWords(vos, false, []);
  const kols = words.filter((w) => w.text === "כָל");
  assert(
    JSON.stringify(kols.map((w) => `${w.occurrence}/${w.occurrences}`)) === JSON.stringify(["1/2", "2/2"]),
    `undefined-occurrence source כָל numbered 1/2,2/2 (was both undefined→1)`,
  );
}
{
  // Non-array / empty input is tolerated (defensive guard for the read/write
  // boundaries that pass `parsed.verseObjects` of unknown shape).
  assert(recomputeTargetOccurrences(undefined) === undefined, `undefined passes through`);
  const empty = [];
  assert(recomputeTargetOccurrences(empty) === empty, `empty array is a no-op`);
}

// ── dropDoubledLeadingMarkers: direct unit tests for the matching / text logic ─
function isInFlow(n) {
  return !!n && (n.type === "quote" || n.type === "paragraph");
}
{
  // No predecessor (verse 1 / chapter-front) → identity, even if curr leads with
  // a marker: that marker may be the only copy.
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(null, curr) === curr, `null prev → identity`);
}
{
  // Prev ends with no in-flow marker → nothing to double → identity.
  const prev = [{ type: "text", text: "done." }];
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(prev, curr) === curr, `no trailing marker on prev → identity`);
}
{
  // Different tag (prev trails \p, curr leads \q1) → NOT a double → identity.
  const prev = [{ type: "text", text: "done." }, { tag: "p", type: "paragraph" }];
  const curr = [{ tag: "q1", type: "quote" }, { type: "text", text: "x" }];
  assert(dropDoubledLeadingMarkers(prev, curr) === curr, `mismatched tag → identity (no false positive)`);
}
{
  // Bare doubled \q1 (the real ULT/UST shape — content rides in a following
  // milestone): drop the leading marker cleanly, keep everything after.
  const prev = [{ type: "text", text: "sixteen" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [
    { tag: "q1", type: "quote", nextChar: " " },
    { type: "milestone", tag: "zaln", children: [{ tag: "w", type: "word", text: "Workers" }] },
  ];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out !== curr, `bare double → trimmed copy (not identity)`);
  assert(!isInFlow(out[0]), `bare double: leading \\q1 dropped`);
  assert(out.length === 1 && out[0].type === "milestone", `bare double: milestone content preserved`);
}
{
  // Doubled \q1 with fused verse BODY text (the AI bare-text shape): drop the
  // marker but KEEP the body as a plain text node — no data loss.
  const prev = [{ type: "text", text: "sixteen" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [{ tag: "q1", type: "quote", text: "In the beginning" }];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.length === 1 && out[0].type === "text" && out[0].text === "In the beginning",
    `fused body text preserved as text node when marker dropped`);
  assert(!isInFlow(out[0]), `fused-body case: no leading marker remains`);
}
{
  // Stacked \qa LETTER + \q1 doubled: both markers de-dup, in order. The acrostic
  // letter on \qa repeats the trailing \qa's own text, so it is DROPPED (already
  // on verse N-1) and never doubled into the body; the \q1's fused body survives.
  const prev = [
    { type: "text", text: "third" },
    { tag: "qa", type: "quote", text: "BET\n" },
    { tag: "q1", type: "quote", nextChar: " " },
  ];
  const curr = [
    { tag: "qa", type: "quote", text: "BET " },
    { tag: "q1", type: "quote", text: "fourth" },
  ];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.every((n) => !isInFlow(n)), `stacked: both \\qa and \\q1 leading markers dropped`);
  assert(!out.some((n) => n.type === "text" && /BET/.test(n.text)), `stacked: acrostic letter NOT doubled into body`);
  assert(out.some((n) => n.type === "text" && n.text === "fourth"), `stacked: \\q1 body "fourth" preserved`);
}

// ── extractVersesForRange: end-to-end collapse of doubled in-flow markers ──────
function firstVo(extract) {
  const vos = JSON.parse(extract.contentJson).verseObjects;
  return (vos && vos[0]) || null;
}
function lastSignificantVo(extract) {
  const vos = JSON.parse(extract.contentJson).verseObjects ?? [];
  for (let i = vos.length - 1; i >= 0; i--) {
    const o = vos[i];
    const t = typeof o?.text === "string" ? o.text : null;
    if (t !== null && /^\s*$/.test(t)) continue;
    return o;
  }
  return null;
}
function quoteCount(extract, tag) {
  const vos = JSON.parse(extract.contentJson).verseObjects ?? [];
  return vos.filter((n) => n.type === "quote" && (tag == null || n.tag === tag)).length;
}
{
  // (a) `\q1 \v 17 \q1` → the trailing \q1 stays on v16 (single copy), the
  // leading doubled \q1 is removed from v17; verse body is preserved.
  const raw = "\\id TST\n\\c 1\n\\v 16 sixteen content\n\\q1 \\v 17 \\q1 seventeen content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v16 = out.find((v) => v.verse === 16);
  const v17 = out.find((v) => v.verse === 17);
  assert(v16 && v17, `(a) v16 + v17 extracted`);
  const last16 = lastSignificantVo(v16);
  assert(isInFlow(last16) && last16.tag === "q1", `(a) v16 ends with its trailing \\q1`);
  assert(quoteCount(v16, "q1") === 1, `(a) v16 carries exactly one \\q1 (not doubled)`);
  assert(!isInFlow(firstVo(v17)), `(a) v17 no longer leads with a doubled \\q1`);
  assert(quoteCount(v17, "q1") === 0, `(a) v17 has no leading \\q1 marker`);
  assert(v17.plainText.includes("seventeen content"), `(a) v17 verse body preserved`);
}
{
  // (b) Legit single `\q1 \v 17` (the marker trails v16 only) is untouched.
  const raw = "\\id TST\n\\c 1\n\\v 16 sixteen content\n\\q1 \\v 17 seventeen content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v16 = out.find((v) => v.verse === 16);
  const v17 = out.find((v) => v.verse === 17);
  const last16 = lastSignificantVo(v16);
  assert(isInFlow(last16) && last16.tag === "q1", `(b) v16 keeps its single trailing \\q1`);
  assert(quoteCount(v16, "q1") === 1, `(b) v16 still has exactly one \\q1`);
  assert(!isInFlow(firstVo(v17)), `(b) legit single: v17 leads with content, not a marker`);
  assert(v17.plainText.includes("seventeen content"), `(b) v17 body intact`);
}
{
  // (c) Chapter-front holds the first \q1 copy; verse 1's leading \q1 must NEVER
  // be dropped (front is not a predecessor — the copy could be the only one).
  const raw = "\\id TST\n\\c 1\n\\q1 \\v 1 \\q1 first line\n\\v 2 second\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v1 = out.find((v) => v.verse === 1);
  assert(v1, `(c) v1 extracted`);
  const first1 = firstVo(v1);
  assert(isInFlow(first1) && first1.tag === "q1", `(c) verse 1 leading \\q1 preserved`);
  assert(v1.plainText.includes("first line"), `(c) verse 1 body intact`);
}
{
  // (d) Stacked `\qa LETTER` + `\q1` doubled → both de-dup; the acrostic letter
  // is not duplicated into v4's body, and v4's body text survives.
  const raw = "\\id TST\n\\c 1\n\\v 3 third\n\\qa BET\n\\q1 \\v 4 \\qa BET \\q1 fourth content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v3 = out.find((v) => v.verse === 3);
  const v4 = out.find((v) => v.verse === 4);
  assert(v3 && v4, `(d) v3 + v4 extracted`);
  assert(quoteCount(v3) === 2, `(d) v3 keeps both trailing markers (\\qa + \\q1)`);
  assert(!isInFlow(firstVo(v4)), `(d) v4 no longer leads with a marker`);
  assert(quoteCount(v4) === 0, `(d) v4 has no leading \\qa / \\q1`);
  assert(!/BET/.test(v4.plainText), `(d) acrostic letter not doubled into v4 body`);
  assert(v4.plainText.includes("fourth content"), `(d) v4 body preserved`);
}

// ── Real-data validation: en_ust ISA carries live upstream doubled-\q1 anomalies
// at 19:9 and 54:3 (leading \q1 in storage duplicating 19:8 / 54:2's trailing
// \q1). The importer must collapse them while keeping the prior verse's copy and
// losing no verse content. (65:16 is clean in this snapshot — single marker.)
{
  const raw = readFileSync(resolve(samples, "en_ust_23-ISA.usfm"), "utf8");
  for (const [ch, prevV, anomV] of [[19, 8, 9], [54, 2, 3]]) {
    const chOut = extractVersesForRange(raw, ch, ch);
    const prev = chOut.find((v) => v.verse === prevV);
    const anom = chOut.find((v) => v.verse === anomV);
    assert(prev && anom, `ISA ${ch}: verses ${prevV} + ${anomV} extracted`);
    const lastPrev = lastSignificantVo(prev);
    assert(isInFlow(lastPrev) && lastPrev.tag === "q1", `ISA ${ch}:${prevV} keeps its trailing \\q1`);
    assert(!isInFlow(firstVo(anom)), `ISA ${ch}:${anomV} no longer leads with a doubled \\q1`);
    assert(firstVo(anom).type === "milestone", `ISA ${ch}:${anomV} content (\\zaln-s) intact after de-dup`);
    assert(anom.plainText.length > 0, `ISA ${ch}:${anomV} retains verse text`);
    console.log(`  ISA ${ch}:${anomV} doubled \\q1 collapsed; ${prevV} trailing \\q1 kept`);
  }
}

// --- makeVerseSortOrder: per-verse ordinal allocator ---
// This is the single source of truth for sort_order across bootstrap import,
// merge reimport, and the backfill script. The export/read sort is
// (chapter, verse, sort_order), so the contract is: stable per-verse stepping
// in call (= file) order, resetting per (chapter, verse).
{
  const next = makeVerseSortOrder();
  // Two notes in 1:1, one in 1:2, back to a third in 1:1 (out-of-order source
  // row), then chapter 2. Each verse counts independently from 100.
  assert(next(1, 1) === 100, `1:1 #1 -> 100`);
  assert(next(1, 1) === 200, `1:1 #2 -> 200`);
  assert(next(1, 2) === 100, `1:2 #1 -> 100 (new verse resets)`);
  assert(next(1, 1) === 300, `1:1 #3 -> 300 (continues 1:1's run)`);
  assert(next(2, 1) === 100, `2:1 #1 -> 100 (new chapter resets)`);
  assert(next(0, 0) === 100, `front:intro (0:0) -> 100`);
}
{
  // Determinism: the same file order yields identical values on a fresh run —
  // this is what makes an unchanged reimport a no-op (no sort_order churn).
  const refs = [[1, 1], [1, 1], [1, 2], [2, 3], [2, 3], [2, 3]];
  const a = makeVerseSortOrder();
  const b = makeVerseSortOrder();
  const seqA = refs.map(([c, v]) => a(c, v));
  const seqB = refs.map(([c, v]) => b(c, v));
  assert(
    JSON.stringify(seqA) === JSON.stringify(seqB),
    `identical inputs -> identical sort_orders (${seqA.join(",")})`,
  );
  assert(
    JSON.stringify(seqA) === JSON.stringify([100, 200, 100, 100, 200, 300]),
    `expected per-verse stepping (${seqA.join(",")})`,
  );
}

// --- healReplacementChars: AI-mangled U+FFFD in alignment source attrs --------
//
// Fixtures are built from real prod corruption (HOS 8:4, HOS 9:4, JER 5:21),
// codepoint by codepoint, so the test never depends on copy-paste of combining
// marks. `cp(...)` builds a string from Unicode code points; 0xFFFD is the
// U+FFFD REPLACEMENT CHARACTER the generator leaves behind.
const cp = (...nums) => String.fromCodePoint(...nums);
const FFFD = 0xfffd;

// A `\zaln-s` milestone wrapping one target `\w`, mirroring the usfm-js shape.
const zaln = (attrs, targetText) => ({
  tag: "zaln",
  type: "milestone",
  ...attrs,
  children: [{ text: targetText, tag: "w", type: "word", occurrence: "1", occurrences: "1" }],
  endTag: "zaln-e\\*",
});

{
  // HOS 8:4 UST "gold": x-content lost its qamats (U+05B8) → two U+FFFD.
  const clean = cp(0x05d5, 0x05bc, 0x2060, 0x05d6, 0x05b0, 0x05d4, 0x05b8, 0x05d1, 0x05b8, 0x0597, 0x2060, 0x05dd);
  const corrupt = cp(0x05d5, 0x05bc, 0x2060, 0x05d6, 0x05b0, 0x05d4, FFFD, FFFD, 0x05d1, 0x05b8, 0x0597, 0x2060, 0x05dd);
  const vo = [zaln({ strong: "c:H2091", lemma: "זָהָב", content: corrupt }, "gold")];
  const before = structuredClone(vo);
  const srcWords = [{ text: clean, strong: "c:H2091", lemma: "זָהָב", morph: "He,C:Ncmsc:Sp3mp" }];
  const report = healReplacementChars(vo, srcWords);
  assert(report.repaired.length === 1 && report.unrepaired.length === 0, `HOS 8:4 content: one repair, no flags`);
  assert(vo[0].content === clean, `HOS 8:4 content reconstructed to clean UHB surface form`);
  assert(!hasReplacementChar(vo[0].content), `HOS 8:4 content has no residual U+FFFD`);
  // Structure preservation: copy the repaired field onto the pre-heal clone and
  // the trees must be byte-identical — proving ONLY the attribute string changed.
  before[0].content = vo[0].content;
  assert(JSON.stringify(before) === JSON.stringify(vo), `HOS 8:4 heal changed nothing but x-content (no unalignment)`);
}

{
  // HOS 9:4 UST: corruption in x-lemma (invisible in the aligner, but bad data).
  const cleanLemma = cp(0x05d0, 0x05b8, 0x05d5, 0x05b6, 0x05df); // אָוֶן
  const corruptLemma = cp(0x05d0, 0x05b8, 0x05d5, 0x05b6, FFFD, FFFD);
  const vo = [zaln({ strong: "H0205", content: cp(0x05d0, 0x05d5, 0x05df), lemma: corruptLemma }, "wickedness")];
  const srcWords = [{ text: cp(0x05d0, 0x05d5, 0x05df), strong: "H0205", lemma: cleanLemma, morph: "He,Ncmpa" }];
  const report = healReplacementChars(vo, srcWords);
  assert(report.repaired.length === 1 && vo[0].lemma === cleanLemma, `HOS 9:4 x-lemma reconstructed`);
}

{
  // JER 5:21 UST: two source words share Strong's H8085 (שִׁמְעוּ / יִשְׁמָֽעוּ).
  // The surviving characters must disambiguate to the yod-initial form.
  const corrupt = cp(0x05d9, 0x05b4, 0x05e9, 0x05c1, 0x05b0, 0x05de, 0x05b8, 0x05bd, 0x05e2, 0x05d5, FFFD, FFFD);
  const right = cp(0x05d9, 0x05b4, 0x05e9, 0x05c1, 0x05b0, 0x05de, 0x05b8, 0x05bd, 0x05e2, 0x05d5, 0x05bc);
  const wrong = cp(0x05e9, 0x05c1, 0x05b4, 0x05de, 0x05b0, 0x05e2, 0x05d5, 0x05bc);
  const vo = [zaln({ strong: "H8085", content: corrupt }, "hear")];
  const srcWords = [
    { text: wrong, strong: "H8085", lemma: "שָׁמַע", morph: "He,Vqv2mp" },
    { text: right, strong: "H8085", lemma: "שָׁמַע", morph: "He,Vqi3mp" },
  ];
  const report = healReplacementChars(vo, srcWords);
  assert(vo[0].content === right, `JER 5:21 disambiguated to the subsequence-matching source word`);
  assert(report.repaired.length === 1, `JER 5:21 one repair`);
}

{
  // Ambiguity bail: surviving chars match two DIFFERENT source values → leave it.
  const corrupt = cp(0x05d0, FFFD); // aleph + FFFD
  const vo = [zaln({ strong: "H9999", content: corrupt }, "x")];
  const srcWords = [
    { text: cp(0x05d0, 0x05d1), strong: "H9999", lemma: "", morph: "" },
    { text: cp(0x05d0, 0x05d2), strong: "H9999", lemma: "", morph: "" },
  ];
  const report = healReplacementChars(vo, srcWords);
  assert(report.repaired.length === 0 && report.unrepaired.length === 1, `ambiguous match is left unrepaired (no guess)`);
  assert(vo[0].content === corrupt, `ambiguous content is untouched`);
}

{
  // No-op on clean input: zero repairs, zero flags, identical bytes.
  const vo = [zaln({ strong: "c:H2091", content: cp(0x05d6, 0x05b8, 0x05d4, 0x05b8, 0x05d1) }, "gold")];
  const before = JSON.stringify(vo);
  const report = healReplacementChars(vo, [{ text: cp(0x05d6, 0x05b8, 0x05d4, 0x05b8, 0x05d1), strong: "c:H2091", lemma: "", morph: "" }]);
  assert(report.repaired.length === 0 && report.unrepaired.length === 0, `clean verse: no-op`);
  assert(JSON.stringify(vo) === before, `clean verse: byte-identical after heal`);
}

{
  // collectSourceWords pulls \w tokens (incl. nested in milestones) with attrs.
  const vo = [
    { tag: "zaln", type: "milestone", strong: "H1", children: [{ tag: "w", type: "word", text: "אב", strong: "H1", lemma: "אָב", morph: "He,Ncmsa" }] },
    { tag: "w", type: "word", text: "גם", strong: "H1571", lemma: "גַּם", morph: "He,D" },
  ];
  const got = collectSourceWords(vo);
  assert(got.length === 2, `collectSourceWords found both \\w (incl. nested)`);
  assert(got[0].strong === "H1" && got[0].text === "אב", `nested source word collected with strong`);
}

// --- reconcileSourceAttrsFromMaster: source-owned \zaln attrs on edited verses
//
// The NUM 20–22 incident: a curated combining-mark fix to en_ult's x-content /
// x-lemma (reordered into UHB-legacy consonant-dagesh-vowel order) was reverted
// by the nightly export because the verses were updated_by != null, so the
// pre-export reimport skipped them and the export re-rendered D1's stale bytes.
// This reconcile pulls the source-owned attrs (NOT the translator's target text /
// grouping) down from master so the fix survives. Conservative + structure-
// preserving — mirrors healReplacementChars' discipline.
//
// A `\zaln-s` milestone carrying x-content / x-lemma / x-morph + the source
// occurrence keys, wrapping one target `\w`.
const zalnMs = (attrs, targetText) => ({
  tag: "zaln",
  type: "milestone",
  occurrence: "1",
  occurrences: "1",
  ...attrs,
  children: [{ text: targetText, tag: "w", type: "word", occurrence: "1", occurrences: "1" }],
  endTag: "zaln-e\\*",
});

{
  // The NUM case, codepoint-exact. Master holds the UHB-legacy order
  // (consonant-dagesh-vowel); D1 reverted to NFC (consonant-vowel-dagesh) AND the
  // translator edited the English target. Reconcile must adopt master's source
  // spelling on x-content + x-lemma while leaving the edited English in place.
  const legacy = cp(0x05d1, 0x05bc, 0x05b8); // ב + dagesh + qamats  (master fix)
  const nfc = cp(0x05d1, 0x05b8, 0x05bc); // ב + qamats + dagesh  (D1, reverted)
  const legacyLemma = cp(0x05d1, 0x05bc, 0x05b8, 0x05df);
  const nfcLemma = cp(0x05d1, 0x05b8, 0x05bc, 0x05df);
  const d1 = [zalnMs({ strong: "H1", content: nfc, lemma: nfcLemma, morph: "He,Ncmsa" }, "in the land EDITED")];
  const master = [zalnMs({ strong: "H1", content: legacy, lemma: legacyLemma, morph: "He,Ncmsa" }, "in the land")];
  const before = structuredClone(d1);
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 2, `NUM: x-content + x-lemma reconciled (got ${report.reconciled.length})`);
  assert(report.divergent.length === 0, `NUM: no divergence`);
  assert(d1[0].content === legacy, `NUM: x-content adopts master's UHB-legacy combining-mark order`);
  assert(d1[0].lemma === legacyLemma, `NUM: x-lemma adopts master's order`);
  assert(d1[0].children[0].text === "in the land EDITED", `translator's edited English target preserved`);
  // Structure preservation: copy only the reconciled attrs onto the pre-clone and
  // the trees must be byte-identical — proving nothing else (target/grouping)
  // moved, so nothing can unalign.
  before[0].content = d1[0].content;
  before[0].lemma = d1[0].lemma;
  assert(JSON.stringify(before) === JSON.stringify(d1), `NUM: only source attrs changed (no unalignment)`);
}

{
  // Already in sync: no-op, byte-identical.
  const v = [zalnMs({ strong: "H1", content: cp(0x05d1, 0x05bc, 0x05b8), lemma: "x", morph: "m" }, "word")];
  const master = structuredClone(v);
  const before = JSON.stringify(v);
  const report = reconcileSourceAttrsFromMaster(v, master);
  assert(report.reconciled.length === 0 && report.divergent.length === 0, `in-sync verse: no-op`);
  assert(JSON.stringify(v) === before, `in-sync verse: byte-identical`);
}

{
  // Re-pointed source (master changed x-strong) is OUT OF SCOPE: strong is the
  // match key, so a milestone master re-pointed to a different strong simply
  // doesn't match and is left untouched (never guessed).
  const d1 = [zalnMs({ strong: "H1", content: "aaa", lemma: "", morph: "" }, "w")];
  const master = [zalnMs({ strong: "H2", content: "bbb", lemma: "", morph: "" }, "w")];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 0 && report.divergent.length === 0, `re-pointed strong: no match`);
  assert(d1[0].content === "aaa", `re-pointed milestone untouched (strong is identity key)`);
}

{
  // Occurrence keys keep two same-Strong source words distinct: each reconciles
  // to ITS OWN master match, no cross-contamination.
  const d1 = [
    zalnMs({ strong: "H7", occurrence: "1", occurrences: "2", content: "old1", lemma: "", morph: "" }, "a"),
    zalnMs({ strong: "H7", occurrence: "2", occurrences: "2", content: "old2", lemma: "", morph: "" }, "b"),
  ];
  const master = [
    zalnMs({ strong: "H7", occurrence: "1", occurrences: "2", content: "new1", lemma: "", morph: "" }, "a"),
    zalnMs({ strong: "H7", occurrence: "2", occurrences: "2", content: "new2", lemma: "", morph: "" }, "b"),
  ];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 2, `both occurrences reconciled independently`);
  assert(d1[0].content === "new1" && d1[1].content === "new2", `occurrence key prevents cross-contamination`);
}

{
  // Ambiguous master key (same strong|occ|occs with CONFLICTING x-content —
  // malformed/AI data) is NEVER guessed: left as-is and flagged divergent.
  const d1 = [zalnMs({ strong: "H9", content: "x", lemma: "", morph: "" }, "w")];
  const master = [
    zalnMs({ strong: "H9", content: "a", lemma: "", morph: "" }, "w1"),
    zalnMs({ strong: "H9", content: "b", lemma: "", morph: "" }, "w2"),
  ];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 0, `ambiguous master key: nothing applied`);
  assert(report.divergent.some((d) => d.attr === "content"), `ambiguous divergence is flagged, not silent`);
  assert(d1[0].content === "x", `ambiguous content left untouched`);
}

{
  // Nested compound alignment (one English phrase → two Hebrew words): BOTH
  // milestone levels reconcile, and the target word nested under them survives.
  const inner = (strong, content, txt) => ({
    tag: "zaln", type: "milestone", strong, occurrence: "1", occurrences: "1",
    content, lemma: "", morph: "",
    children: [{ tag: "w", type: "word", text: txt, occurrence: "1", occurrences: "1" }],
    endTag: "zaln-e\\*",
  });
  const d1 = [{
    tag: "zaln", type: "milestone", strong: "H1", occurrence: "1", occurrences: "1",
    content: "o1", lemma: "", morph: "",
    children: [inner("H2", "i1", "x")], endTag: "zaln-e\\*",
  }];
  const master = [{
    tag: "zaln", type: "milestone", strong: "H1", occurrence: "1", occurrences: "1",
    content: "O1", lemma: "", morph: "",
    children: [inner("H2", "I1", "x")], endTag: "zaln-e\\*",
  }];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 2, `nested compound: both milestone levels reconciled`);
  assert(d1[0].content === "O1" && d1[0].children[0].content === "I1", `outer + inner source attrs adopted`);
  assert(d1[0].children[0].children[0].text === "x", `target word under nested milestones preserved`);
}

{
  // GLUE GUARD: a master milestone whose x-content spans a maqqef/minus (the
  // AI-aligner defect) must NOT be adopted onto a verse D1 already reformed —
  // otherwise the reconcile re-glues the split (this is what reverted the first
  // Amos backfill). Master AMO 3:1 "אֶת־הַדָּבָר" (H0853, glued); D1 reformed to
  // "אֶת". Reconcile must leave D1's "אֶת" alone.
  const MAQQEF = "־";
  const d1 = [zalnMs({ strong: "H0853", content: "אֶת", lemma: "אֵת", morph: "He,To" }, "to")];
  const master = [zalnMs({ strong: "H0853", content: `אֶת${MAQQEF}הַדָּבָר`, lemma: "אֵת", morph: "He,To" }, "to")];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 0, `glued master content is NOT adopted (no re-glue)`);
  assert(d1[0].content === "אֶת", `D1's reformed "אֶת" survives the reconcile`);
  // And a CLEAN master milestone still reconciles normally (guard is narrow).
  const d1b = [zalnMs({ strong: "H1", content: "old", lemma: "", morph: "" }, "w")];
  const masterb = [zalnMs({ strong: "H1", content: "new", lemma: "", morph: "" }, "w")];
  reconcileSourceAttrsFromMaster(d1b, masterb);
  assert(d1b[0].content === "new", `clean (non-glued) master value still adopted`);
}

{
  // TARGET-AMBIGUITY GUARD: the AMO 3:1 shape after the backfill. The reform
  // split the glued את־הדבר into את(H0853) + הדבר(d:H1697), but the verse ALSO
  // carries a pre-existing strong-shifted milestone הזה mislabeled d:H1697 — so
  // the target now has TWO d:H1697|1|1 milestones. Master (still glued) carries a
  // single non-glued d:H1697 = "הזה". Without the guard, the reconcile adopts
  // "הזה" onto BOTH, clobbering the reformed "הדבר". The guard must leave both as-is.
  const d1 = [
    zalnMs({ strong: "H0853", content: "אֶת", lemma: "אֵת", morph: "He,To" }, "to"),
    zalnMs({ strong: "d:H1697", content: "הַדָּבָר", lemma: "דָּבָר", morph: "He,Td:Ncmsa" }, "message"),
    zalnMs({ strong: "d:H1697", content: "הַזֶּה", lemma: "זֶה", morph: "He,Td:Ncmsa" }, "this"),
  ];
  const master = [
    zalnMs({ strong: "H0853", content: "אֶת־הַדָּבָר", lemma: "אֵת", morph: "He,To" }, "to"), // glued → guard #1 skips
    zalnMs({ strong: "d:H1697", content: "הַזֶּה", lemma: "זֶה", morph: "He,Td:Ncmsa" }, "this"),
  ];
  const report = reconcileSourceAttrsFromMaster(d1, master);
  assert(report.reconciled.length === 0, `target-ambiguous d:H1697 → nothing adopted (got ${report.reconciled.length})`);
  assert(d1[1].content === "הַדָּבָר", `reformed "הַדָּבָר" survives (not clobbered to "הַזֶּה")`);
  assert(d1[2].content === "הַזֶּה", `the pre-existing "הַזֶּה" is unchanged`);
}

// --- normalizeNoteWhitespace: collapse bp-assistant double spaces ------------
// The two real artifacts from the ISA cleanup are the canonical cases.
{
  const a = "...state the meaning plainly.  Alternate translation: [...]";
  assert(
    normalizeNoteWhitespace(a) === "...state the meaning plainly. Alternate translation: [...]",
    `double space after a period collapses`,
  );
  const b = "for the idea of **understanding**,  could express";
  assert(
    normalizeNoteWhitespace(b) === "for the idea of **understanding**, could express",
    `double space after a comma collapses`,
  );
}
{
  // Runs of 3+ spaces collapse to one; multiple runs in a line all collapse.
  assert(normalizeNoteWhitespace("a.   b") === "a. b", `triple space collapses to one`);
  assert(normalizeNoteWhitespace("a.  b.  c") === "a. b. c", `multiple interior runs all collapse`);
}
{
  // No-op when there is no double space (cheap gate) and on non-strings.
  const clean = "a single-spaced note. No change here.";
  assert(normalizeNoteWhitespace(clean) === clean, `single-spaced note unchanged (no-op)`);
  assert(normalizeNoteWhitespace("don't  worry") === "don't worry", `apostrophe word unaffected by collapse`);
  assert(normalizeNoteWhitespace(null) === null, `null passes through`);
  assert(normalizeNoteWhitespace(undefined) === undefined, `undefined passes through`);
}
{
  // The literal `\n` line-break escape is preserved exactly, and leading
  // indentation after it (markdown list nesting) is NOT collapsed.
  const note = "First para with a.  double space.\\n\\n  - nested item kept";
  const out = normalizeNoteWhitespace(note);
  assert(out === "First para with a. double space.\\n\\n  - nested item kept", `\\n preserved; leading indent kept; interior collapsed`);
  assert(out.includes("\\n\\n"), `blank-line \\n\\n survives`);
  assert(out.includes("\\n  - nested"), `2-space list indentation after \\n preserved`);
}
{
  // Markdown table rows (lines containing `|`) keep their alignment padding.
  const table = "intro.  collapse me\\n| Head  | Val |\\n| ---  | --- |";
  const out = normalizeNoteWhitespace(table);
  assert(out.startsWith("intro. collapse me"), `prose line before a table still collapses`);
  assert(out.includes("| Head  | Val |"), `table row padding preserved`);
  assert(out.includes("| ---  | --- |"), `table separator padding preserved`);
}
{
  // Trailing whitespace (potential markdown hard break) is left alone; a
  // whitespace-only line is not doubled by the lead/trail split.
  assert(normalizeNoteWhitespace("text  \\nmore") === "text  \\nmore", `trailing double space before \\n preserved`);
  assert(normalizeNoteWhitespace("a\\n   \\nb") === "a\\n   \\nb", `whitespace-only line left intact (not doubled)`);
}

// --- findSuspiciousDoubleSpaces: flag possible dropped words ------------------
{
  // The comma case masked a dropped "you" — flag it.
  const susp = findSuspiciousDoubleSpaces("for the idea of **understanding**,  could express");
  assert(susp.length === 1, `comma double space flagged as suspicious (got ${susp.length})`);
  assert(/understanding/.test(susp[0]), `suspicious context includes the surrounding text`);
}
{
  // The period case is the benign typographic convention — NOT flagged.
  const susp = findSuspiciousDoubleSpaces("...state the meaning plainly.  Alternate translation: [...]");
  assert(susp.length === 0, `double space after a period is not flagged (benign)`);
  // Sentence terminator wrapped in a closing quote is also benign.
  assert(findSuspiciousDoubleSpaces('end of quote.”  Next sentence').length === 0, `."  after closing quote is benign`);
  assert(findSuspiciousDoubleSpaces("ask?  Then go").length === 0, `?  after a question mark is benign`);
}
{
  // No double space, table rows, and leading indentation never flag.
  assert(findSuspiciousDoubleSpaces("clean note.").length === 0, `clean note → no suspects`);
  assert(findSuspiciousDoubleSpaces("| a  | b |").length === 0, `table padding not flagged`);
  assert(findSuspiciousDoubleSpaces("text\\n  indented").length === 0, `leading indentation not flagged`);
}

// --- stripOrphanAlignmentMarkers: AI-mangled "-e" / orphan \zaln-e junk -------
// MIC 6:10 UST master: `\w others\w*\zaln-e\* -e -e -e -e -e -e -e -e?` — usfm-js
// parks the junk as (a) a node tagged `zaln-e\*` with leaked content, and
// (b) a text node of standalone "-e" tokens that also carries the real "?".
{
  // (a) orphan end-milestone node is dropped, its "-e" content discarded.
  const out = stripOrphanAlignmentMarkers([
    { tag: "w", type: "word", text: "others" },
    { tag: "zaln-e\\*", content: "-e " },
    { type: "text", text: "\\n" },
  ]);
  assert(!out.some((n) => typeof n.tag === "string" && n.tag.startsWith("zaln-e")), `orphan zaln-e node dropped`);
  assert(out.some((n) => n.tag === "w" && n.text === "others"), `real \\w word kept`);
}
{
  // (b) "-e" run stripped IN PLACE, trailing "?" preserved.
  const out = stripOrphanAlignmentMarkers([{ type: "text", text: "-e -e -e -e -e -e -e -e?\\n" }]);
  assert(out.length === 1 && out[0].text === "?\\n", `dash-e run stripped, "?" kept (got ${JSON.stringify(out[0]?.text)})`);
}
{
  // A text node that is ONLY "-e" junk collapses to a single separator space —
  // kept (not dropped) so two real words on either side don't merge.
  const out = stripOrphanAlignmentMarkers([{ type: "text", text: "-e -e" }]);
  assert(out.length === 1 && out[0].text === " ", `pure "-e" junk collapses to one space (got ${JSON.stringify(out[0]?.text)})`);
  // A node that strips to truly empty IS dropped.
  assert(stripOrphanAlignmentMarkers([{ type: "text", text: "-e" }]).length === 0, `"-e" alone (no space) dropped`);
}
{
  // Boundary safety: real words are never touched.
  assert(stripOrphanAlignmentMarkers([{ type: "text", text: "re-entry here" }])[0].text === "re-entry here", `hyphenated "re-entry" untouched`);
  // "-e" mid-text between real words: token removed, single space kept.
  assert(stripOrphanAlignmentMarkers([{ type: "text", text: "word -e word2" }])[0].text === "word word2", `interior "-e" token removed, spacing tidy`);
  // A \w word is never altered (only bare text + orphan-tag nodes are).
  const w = [{ tag: "w", type: "word", text: "-east" }];
  assert(stripOrphanAlignmentMarkers(w) === w, `\\w word node left untouched (identity)`);
}
{
  // No-op identity on a clean verse — no churn through the import pipeline.
  const clean = [
    { tag: "zaln", type: "milestone", content: "X", children: [{ tag: "w", type: "word", text: "hello" }], endTag: "zaln-e\\*" },
    { type: "text", text: " " },
    { tag: "w", type: "word", text: "world" },
  ];
  assert(stripOrphanAlignmentMarkers(clean) === clean, `clean verse returns the same array reference (identity)`);
}

// --- sanitizeMarkerSpacing: auto-space a numbered marker glued to a word ---
{
  // Baseline: prove usfm-js corrupts a glued numbered marker (the hazard).
  const glued = "\\id MIC\n\\c 7\n\\q1 \\v 9 first line\n\\q2because we sinned\n";
  const badVo = usfm.toJSON(glued).chapters["7"]["9"].verseObjects;
  const badTag = badVo.find((n) => typeof n.tag === "string" && n.tag.startsWith("q2"))?.tag;
  assert(badTag === "q2because", `usfm-js swallows the glued word into the tag (got tag=${JSON.stringify(badTag)})`);

  // sanitizeMarkerSpacing inserts the missing space → marker + word both survive.
  const fixed = usfm.toJSON(sanitizeMarkerSpacing(glued)).chapters["7"]["9"].verseObjects;
  const marker = fixed.find((n) => n.tag === "q2" && n.type === "quote");
  assert(!!marker, `\\q2 parses as a real quote marker after sanitize`);
  const text = fixed.map((n) => n.text ?? "").join("");
  assert(text.includes("because we sinned"), `the word "because" survives as text (got ${JSON.stringify(text)})`);

  // extractVersesForRange (the shared import chokepoint) recovers the word.
  const verses = extractVersesForRange(glued, 7, 7);
  const v9 = verses.find((v) => v.verse === 9);
  const plain = JSON.stringify(v9?.content_json ?? v9);
  assert(/because/.test(plain), `extractVersesForRange keeps "because" (not lost to a tag)`);
}
{
  // Identity / safety: clean USFM and VALID markers are never touched.
  assert(sanitizeMarkerSpacing("\\q2 word") === "\\q2 word", `\\q2 + space is unchanged`);
  assert(sanitizeMarkerSpacing("\\q2\\zaln-s |x\\*") === "\\q2\\zaln-s |x\\*", `\\q2 before \\zaln (backslash) is unchanged`);
  // Bare/acrostic markers that legitimately carry letters must NOT be split.
  assert(sanitizeMarkerSpacing("\\qa ALEPH") === "\\qa ALEPH", `\\qa acrostic marker is left alone`);
  assert(sanitizeMarkerSpacing("\\qm text") === "\\qm text", `\\qm (no digit) is left alone`);
  // Only the numbered-marker-glued-to-letter shape is repaired.
  assert(sanitizeMarkerSpacing("\\q3word") === "\\q3 word", `\\q3word → "\\q3 word"`);
  assert(sanitizeMarkerSpacing("\\pi2word") === "\\pi2 word", `\\pi2word → "\\pi2 word"`);
  assert(sanitizeMarkerSpacing("\\qm1word") === "\\qm1 word", `\\qm1word → "\\qm1 word"`);
}

// --- sanitizeWordAttributes: a stray `\` in a \w attribute section (#481) ---
// The exact malformed line from en_ust/24-JER.usfm master (JER 30:3). Without
// the repair, usfm-js reads the `\x` after the `|` as a MARKER OPENER, so the
// attribute section leaves the word as a junk `{tag:"x"}` node — which the
// nightly export then wrote back to master as a real `\x … \x*` cross-reference.
{
  const malformed =
    '\\id JER\n\\c 30\n\\p\n\\v 3 \\zaln-s |x-strong="H3063" x-lemma="l" x-morph="He" ' +
    'x-occurrence="1" x-occurrences="1" x-content="Judah"\\*' +
    '\\w Judah.”|\\x-occurrence="1" x-occurrences="1"\\w*\\zaln-e\\*\n';

  // Baseline: prove the hazard is real in usfm-js (this is what we're fixing).
  const badChildren = usfm.toJSON(malformed).chapters["30"]["3"].verseObjects[0].children;
  const junk = badChildren.find((n) => n.tag === "x");
  assert(!!junk, `usfm-js turns the stray backslash into a junk \\x node (the hazard)`);
  assert(junk.content === '-occurrence="1" x-occurrences="1"', `junk node carries the attribute residue as content`);

  // Repaired: the attributes land on the word, and no \x node is created.
  const repaired = sanitizeWordAttributes(malformed);
  assert(
    repaired.includes('\\w Judah.”|x-occurrence="1" x-occurrences="1"\\w*'),
    `stray backslash stripped from the attribute section (got ${JSON.stringify(repaired.split("\n")[3])})`,
  );
  const goodChildren = usfm.toJSON(repaired).chapters["30"]["3"].verseObjects[0].children;
  assert(!goodChildren.some((n) => n.tag === "x"), `no junk \\x node after the repair`);
  const word = goodChildren.find((n) => n.tag === "w");
  assert(word?.occurrence === "1" && word?.occurrences === "1", `the word keeps its real occurrence attributes`);

  // The shared import chokepoint applies it: no \x anywhere in the stored row,
  // and the trapped punctuation still splits out of the word as plain text.
  const v3 = extractVersesForRange(malformed, 30, 30).find((v) => v.verse === 3);
  const stored = JSON.parse(v3.contentJson);
  const kids = stored.verseObjects[0].children;
  assert(!/"tag"\s*:\s*"x"/.test(v3.contentJson), `stored content_json holds no \\x node`);
  assert(kids.some((n) => n.tag === "w" && n.text === "Judah"), `\\w Judah survives as a word`);
  assert(kids.some((n) => n.type === "text" && n.text === ".”"), `trailing .” splits out as plain text`);
}
{
  // Identity / safety: valid attribute sections and neighbouring markers are
  // never touched, and the repair cannot reach outside one word marker.
  const clean = '\\w Judah|x-occurrence="1" x-occurrences="1"\\w*';
  assert(sanitizeWordAttributes(clean) === clean, `a clean \\w attribute section is unchanged`);
  const noAttrs = "\\w Judah\\w*";
  assert(sanitizeWordAttributes(noAttrs) === noAttrs, `a \\w with no attribute section is unchanged`);
  const milestone = '\\zaln-s |x-strong="H3063"\\*\\w a\\w*\\zaln-e\\*';
  assert(sanitizeWordAttributes(milestone) === milestone, `\\zaln-s / \\zaln-e milestones are unchanged`);
  const xref = "\\w word\\w* \\x + \\xo 1:1 \\xt Isa 2:2\\x*";
  assert(sanitizeWordAttributes(xref) === xref, `a REAL \\x cross-reference outside a word is unchanged`);
  // Two words on one line: only the malformed one is repaired, and the repair
  // stops at that word's own `\w*` rather than swallowing the next word.
  const twoWords =
    '\\w one|\\x-occurrence="1"\\w* \\w two|x-occurrence="1"\\w*';
  assert(
    sanitizeWordAttributes(twoWords) === '\\w one|x-occurrence="1"\\w* \\w two|x-occurrence="1"\\w*',
    `only the malformed word is repaired (got ${JSON.stringify(sanitizeWordAttributes(twoWords))})`,
  );
  // An unterminated `\w` must not let the repair run onto a later line.
  const unterminated = '\\w one|\\x-occurrence="1"\n\\w two|x-occurrence="1"\\w*';
  assert(sanitizeWordAttributes(unterminated) === unterminated, `repair never crosses a line break`);
}

// --- TSV: leading UTF-8 BOM must not corrupt the header row ---
// Regression: without the BOM strip, headers[0] becomes "﻿ID", so every
// r["ID"] lookup is undefined and the entire import is silently skipped (0
// usable rows) even though parseTsv reports rows.
{
  const body =
    "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
    "1:1\tabcd\t\t\tword\t1\tA note\n";
  const withBom = "﻿" + body;
  const plain = parseTsv(body);
  const bommed = parseTsv(withBom);
  assert(bommed.headers[0] === "Reference", `BOM is stripped from the first header (got ${JSON.stringify(bommed.headers[0])})`);
  assert(!bommed.headers[0].includes("﻿"), `no BOM survives on any header`);
  assert(bommed.rows.length === plain.rows.length, `BOM file yields the same row count as a clean file`);
  assert(bommed.rows[0]["ID"] === "abcd", `lookup by real header name works on a BOM file (got ${JSON.stringify(bommed.rows[0]["ID"])})`);
  assert(bommed.rows[0]["Reference"] === "1:1", `Reference resolves on a BOM file`);
}

// --- dropDuplicateSourceMilestones: doubled source token in one compound ------
// JER 31:33 UST/ULT `אֶת אֶת בֵּית` — a spurious outer H0853 "אֶת" over the real
// nested H0854 "אֶת" › H1004b "בֵּית"; the card wraps אֶת twice → renders doubled.
{
  const doubled = [
    {
      tag: "zaln", type: "milestone", strong: "H0853", occurrence: "1", occurrences: "1", content: "אֶת",
      children: [{
        tag: "zaln", type: "milestone", strong: "H0854", occurrence: "1", occurrences: "1", content: "אֶת",
        children: [{
          tag: "zaln", type: "milestone", strong: "H1004b", occurrence: "1", occurrences: "1", content: "בֵּית",
          children: [{ tag: "w", type: "word", text: "with" }],
          endTag: "zaln-e\\*",
        }],
        endTag: "zaln-e\\*",
      }],
      endTag: "zaln-e\\*",
    },
  ];
  const out = dropDuplicateSourceMilestones(doubled);
  const strongs = [];
  const walk = (ns) => { for (const n of ns ?? []) { if (n?.tag === "zaln") strongs.push(n.strong); if (n?.children) walk(n.children); } };
  walk(out);
  assert(strongs.length === 2, `doubled אֶת collapsed to 2 milestones (got ${strongs.length}: ${strongs.join(",")})`);
  assert(strongs.includes("H0854") && !strongs.includes("H0853"), `keeps inner H0854, drops spurious outer H0853`);
  // Target word preserved.
  let words = [];
  const collectW = (ns) => { for (const n of ns ?? []) { if (n?.tag === "w") words.push(n.text); if (n?.children) collectW(n.children); } };
  collectW(out);
  assert(words.join(" ") === "with", `target word preserved`);
}
{
  // No-op identity: a clean compound (distinct source tokens) is untouched.
  const clean = [{
    tag: "zaln", type: "milestone", strong: "H0854", occurrence: "1", occurrences: "1", content: "אֶת",
    children: [{
      tag: "zaln", type: "milestone", strong: "H1004b", occurrence: "1", occurrences: "1", content: "בֵּית",
      children: [{ tag: "w", type: "word", text: "with" }],
      endTag: "zaln-e\\*",
    }],
    endTag: "zaln-e\\*",
  }];
  assert(dropDuplicateSourceMilestones(clean) === clean, `clean compound returns same array reference (identity)`);
  // Genuine repetition (distinct occurrences) is NOT collapsed.
  const rep = [{
    tag: "zaln", type: "milestone", strong: "H7965", occurrence: "1", occurrences: "2", content: "שָׁלוֹם",
    children: [{
      tag: "zaln", type: "milestone", strong: "H7965", occurrence: "2", occurrences: "2", content: "שָׁלוֹם",
      children: [{ tag: "w", type: "word", text: "peace" }],
      endTag: "zaln-e\\*",
    }],
    endTag: "zaln-e\\*",
  }];
  assert(dropDuplicateSourceMilestones(rep) === rep, `genuine שלום שלום (distinct occ) left untouched (identity)`);
}

// ─── curlifyVerseObjects (AI-pipeline verse-ingest quote curling) ───────────
// Regression coverage for the JER 32/33 / NUM 26:53 prod incident: bp-assistant
// wrote straight ' / " into ULT/UST verse content_json. See the module comment
// above curlifyVerseObjects in importParsers.ts.

function countNodes(nodes) {
  let n = 0;
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    n += 1;
    if (Array.isArray(node.children)) n += countNodes(node.children);
  }
  return n;
}

// A JER 33:20-shaped verse: a straight opening quote before a `\zaln-s`-wrapped
// "Thus", then "says", then a second `\zaln-s`-wrapped "Yahweh". Mirrors the
// real defect — the AI wrote the straight `"` as a bare leading text node, not
// inside the `\w` itself (normalizeWordPunctuation already strips outer
// punctuation off `\w` tokens by the time this stage runs).
{
  const verseObjects = [
    { type: "text", text: '"' },
    {
      type: "milestone",
      tag: "zaln",
      strong: "H0559",
      content: "אָמַר",
      lemma: "אָמַר",
      morph: "He,Vqp3ms",
      occurrence: "1",
      occurrences: "1",
      children: [{ type: "word", tag: "w", text: "Thus", occurrence: "1", occurrences: "1" }],
    },
    { type: "text", text: " says " },
    {
      type: "milestone",
      tag: "zaln",
      strong: "H3068",
      content: "יְהוָה",
      lemma: "יְהוָה",
      morph: "Np",
      occurrence: "1",
      occurrences: "1",
      children: [{ type: "word", tag: "w", text: "Yahweh", occurrence: "1", occurrences: "1" }],
    },
    { type: "text", text: "," },
  ];
  const before = JSON.parse(JSON.stringify(verseObjects));
  const nodeCountBefore = countNodes(verseObjects);

  const changed = curlifyVerseObjects(verseObjects);

  assert(changed === true, "JER 33:20-shaped verse: reports a change");
  assert(verseObjects[0].text === "“", `leading straight quote curls to an opening “ (got ${JSON.stringify(verseObjects[0].text)})`);
  assert(verseObjects[2].text === " says ", "unrelated text node untouched");
  assert(verseObjects[4].text === ",", "trailing punctuation text node untouched");

  // x-content / x-lemma / x-morph / x-strong / occurrence(s) are byte-identical —
  // the hard constraint: source-language attributes are never touched.
  for (const key of ["content", "lemma", "morph", "strong", "occurrence", "occurrences"]) {
    assert(
      verseObjects[1][key] === before[1][key] && verseObjects[3][key] === before[3][key],
      `milestone attribute "${key}" is byte-identical before/after`,
    );
  }
  // Target `\w` word text/occurrence untouched (no quotes in them).
  assert(verseObjects[1].children[0].text === "Thus", "target word text untouched when it holds no quotes");
  assert(verseObjects[3].children[0].text === "Yahweh", "target word text untouched when it holds no quotes");
  assert(
    verseObjects[1].children[0].occurrence === before[1].children[0].occurrence &&
      verseObjects[3].children[0].occurrence === before[3].children[0].occurrence,
    "target word occurrence untouched",
  );
  // Structure-preserving: same node count (no node added/removed/reordered).
  assert(countNodes(verseObjects) === nodeCountBefore, "node count unchanged (no split/merge/reorder)");
}

// Apostrophe / possessive: a straight `'` inside a target `\w` word, flanked by
// letters, curls to the closing/apostrophe curly quote (’), never the opener.
{
  const verseObjects = [
    { type: "text", text: "the " },
    { type: "word", tag: "w", text: "LORD's", occurrence: "1", occurrences: "1" },
    { type: "text", text: " temple" },
  ];
  const changed = curlifyVerseObjects(verseObjects);
  assert(changed === true, "possessive apostrophe: reports a change");
  assert(verseObjects[1].text === "LORD’s", `possessive apostrophe curls (got ${JSON.stringify(verseObjects[1].text)})`);
}

// Already-curly verse: a no-op. Byte-identical JSON before/after, reports no
// change, and mutates nothing (the hard "no-op on clean output" requirement).
{
  const verseObjects = [
    { type: "text", text: "“Thus says " },
    {
      type: "milestone",
      tag: "zaln",
      strong: "H3068",
      content: "יְהוָה",
      lemma: "יְהוָה",
      morph: "Np",
      occurrence: "1",
      occurrences: "1",
      children: [{ type: "word", tag: "w", text: "Yahweh’s", occurrence: "1", occurrences: "1" }],
    },
    { type: "text", text: ",” he said." },
  ];
  const before = JSON.stringify(verseObjects);
  const changed = curlifyVerseObjects(verseObjects);
  assert(changed === false, "already-curly verse: reports no change");
  assert(JSON.stringify(verseObjects) === before, "already-curly verse: byte-identical after the pass");
}

// A verse with no straight quotes at all — a no-op on non-quote content too
// (plain prose, no ' or " anywhere).
{
  const verseObjects = [
    { type: "text", text: "In the beginning " },
    { type: "word", tag: "w", text: "God", occurrence: "1", occurrences: "1" },
    { type: "text", text: " created the heavens." },
  ];
  const before = JSON.stringify(verseObjects);
  const changed = curlifyVerseObjects(verseObjects);
  assert(changed === false, "no-quote verse: reports no change");
  assert(JSON.stringify(verseObjects) === before, "no-quote verse: byte-identical after the pass");
}

// Ordering regression (found in independent review): curling can make two
// `\w` nodes' text byte-identical — one already curly ("LORD’s"), one
// AI-written straight ("LORD's") — and recomputeTargetOccurrences keys
// uniqueness on exact text. pipelineImport.ts's applyVerseUpdate MUST run
// curlifyVerseObjects BEFORE recomputeTargetOccurrences, or the two words
// would keep the DISTINCT occurrence numbers stamped while their text still
// differed, colliding once curling unifies the text (both "LORD’s" at,
// wrongly, occurrence 1 of 1 — the exact `${text}|${occurrence}` collision
// recomputeTargetOccurrences exists to prevent). This test locks in the
// correct order.
{
  const verseObjects = [
    { type: "word", tag: "w", text: "LORD’s", occurrence: "0", occurrences: "0" }, // already curly
    { type: "text", text: " house and " },
    { type: "word", tag: "w", text: "LORD's", occurrence: "0", occurrences: "0" }, // AI-written straight
  ];
  curlifyVerseObjects(verseObjects); // must run first
  recomputeTargetOccurrences(verseObjects);

  assert(verseObjects[0].text === "LORD’s", "ordering regression: first word curls/stays curly");
  assert(verseObjects[2].text === "LORD’s", "ordering regression: second word curls to match");
  assert(
    verseObjects[0].occurrence !== verseObjects[2].occurrence,
    `ordering regression: two now-identical words get DISTINCT occurrence numbers, not a collision ` +
      `(got ${verseObjects[0].occurrence} and ${verseObjects[2].occurrence})`,
  );
  assert(
    verseObjects[0].occurrences === "2" && verseObjects[2].occurrences === "2",
    `ordering regression: both words recognize there are 2 total occurrences (got ${verseObjects[0].occurrences}, ${verseObjects[2].occurrences})`,
  );
}

// ─── Adjacent same-type quote alternation (independent review finding) ──────
// Two of the SAME straight quote character sitting directly back-to-back
// (nothing between them) must alternate open/close rather than both resolving
// to the same side via the plain context rule. Verified against curlifyText
// (the standalone-string entry point note/question/response prose uses) since
// it's simpler to assert on than a verseObjects tree, but the underlying rule
// (curlifyChar) is shared with curlifyVerseObjects — see the module comment.
{
  assert(curlifyText('""') === "“”", `adjacent double quotes curl to an open+close pair, not two opens (got ${JSON.stringify(curlifyText('""'))})`);
  assert(curlifyText("''") === "‘’", `adjacent single quotes curl to an open+close pair, not two opens (got ${JSON.stringify(curlifyText("''"))})`);
  assert(
    curlifyText('he said ""') === "he said “”",
    `'he said ""' — an empty quoted phrase after a space still alternates (got ${JSON.stringify(curlifyText('he said ""'))})`,
  );
  assert(
    curlifyText('"a""b"') === "“a”“b”",
    `'"a""b"' — two back-to-back quoted words, not open+close+close+close (got ${JSON.stringify(curlifyText('"a""b"'))})`,
  );
  assert(
    curlifyText('"""') === "“”“",
    `three adjacent quotes alternate open/close/open (got ${JSON.stringify(curlifyText('"""'))})`,
  );
  // Apostrophe/open-single (no prev -> opens), then " with prev=‘ (opener-class char) -> opens too — the
  // adjacency override is per-type and does not fire across DIFFERENT quote characters.
  assert(
    curlifyText(`'"`) === "‘“",
    `adjacency override is per-type: a double quote right after a single quote is unaffected (got ${JSON.stringify(curlifyText(`'"`))})`,
  );
}

// ─── curlifyText (standalone string entry point) ────────────────────────────
{
  assert(curlifyText("plain prose") === "plain prose", "curlifyText: no-op on text with no straight quotes");
  assert(curlifyText("“already” curly") === "“already” curly", "curlifyText: no-op on already-curly text");
  assert(curlifyText("") === "", "curlifyText: no-op on empty string");
  assert(curlifyText('say "hi" now') === "say “hi” now", `curlifyText: curls a simple quoted phrase (got ${JSON.stringify(curlifyText('say "hi" now'))})`);
  assert(curlifyText("LORD's house") === "LORD’s house", `curlifyText: curls a possessive apostrophe (got ${JSON.stringify(curlifyText("LORD's house"))})`);

  // The two-char literal `\n` escape (unfoldingWord's TSV line-break
  // convention in note/question/response prose) is an OPENING context.
  // Regression: isOpeningQuoteContext only looked one character back, saw the
  // "n", and curled the quote closing (”/’).
  assert(
    curlifyText('He said:\\n"Go to the land."') === "He said:\\n“Go to the land.”",
    `curlifyText: double quote after a literal \\n escape opens (got ${JSON.stringify(curlifyText('He said:\\n"Go to the land."'))})`,
  );
  assert(
    curlifyText("He said:\\n'Go to the land.'") === "He said:\\n‘Go to the land.’",
    `curlifyText: single quote after a literal \\n escape opens (got ${JSON.stringify(curlifyText("He said:\\n'Go to the land.'"))})`,
  );
  // Guard against over-reach: a word merely ending in "n" (no backslash before
  // it) must still read as a closing context.
  assert(
    curlifyText('the "land in" question') === "the “land in” question",
    `curlifyText: a plain trailing n is still a closing context (got ${JSON.stringify(curlifyText('the "land in" question'))})`,
  );
}

// ─── extractPlainText (exported for pipelineImport.ts's plain_text re-derive) ─
{
  assert(
    extractPlainText({
      verseObjects: [
        { type: "text", text: "In the beginning " },
        { type: "word", tag: "w", text: "God", occurrence: "1", occurrences: "1" },
        { type: "text", text: " created." },
      ],
    }) === "In the beginning God created.",
    "extractPlainText: concatenates text/word nodes",
  );
  assert(
    extractPlainText({
      verseObjects: [
        {
          type: "milestone",
          tag: "zaln",
          content: "אָמַר",
          children: [{ type: "word", tag: "w", text: "said", occurrence: "1", occurrences: "1" }],
        },
      ],
    }) === "said",
    "extractPlainText: descends into milestone children",
  );
}
{
  // Drives the plain_text re-derive fix directly: extractPlainText on the
  // FINAL curled tree must reflect the curled character, not the original.
  const verseObjects = [
    { type: "text", text: '"' },
    { type: "word", tag: "w", text: "Thus", occurrence: "1", occurrences: "1" },
    { type: "text", text: " says." },
  ];
  curlifyVerseObjects(verseObjects);
  const plain = extractPlainText({ verseObjects });
  assert(plain === "“Thus says.", `extractPlainText reflects a curled tree (got ${JSON.stringify(plain)})`);
}

// ─── #684: `\ts\*` in the usfm-js 3.5.0 shape is an in-flow marker on import ───
// usfm-js 3.5.0 emits `\ts\*` as {tag:"ts\\*"} (no type, no content). The import
// parser only knew the legacy {tag:"ts", content:"\\*"}, so a doubled chunk marker
// was never absorbed and a marker abutting words fused them in plain_text.
{
  // End-to-end through real usfm-js output: `\ts\* \v 17 \ts\*` → v16 keeps its
  // trailing marker, v17's doubled leading copy is absorbed, body preserved.
  const raw = "\\id TST\n\\c 1\n\\v 16 sixteen content.\n\\ts\\*\n\\v 17 \\ts\\*\n\\q1 seventeen content\n";
  const out = extractVersesForRange(raw, 1, 1);
  const v16 = out.find((v) => v.verse === 16);
  const v17 = out.find((v) => v.verse === 17);
  assert(v16 && v17, `#684 e2e: v16 + v17 extracted`);
  assert(lastSignificantVo(v16)?.tag === "ts\\*", `#684 e2e: v16 keeps its trailing \\ts\\* (3.5.0 shape)`);
  assert(firstVo(v17)?.tag !== "ts\\*", `#684 e2e: v17's doubled leading \\ts\\* is absorbed (got ${v17.contentJson})`);
  assert(v17.plainText === "seventeen content", `#684 e2e: v17 body preserved (got ${JSON.stringify(v17.plainText)})`);
}
{
  // Direct: prev trails a 3.5.0-shape ts, curr leads with one → curr's copy dropped.
  const prev = [{ type: "text", text: "done.\n" }, { tag: "ts\\*", nextChar: "\n" }];
  const curr = [{ tag: "ts\\*", nextChar: "\n" }, { type: "text", text: "next" }];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.length === 1 && out[0].text === "next", `#684: doubled 3.5.0-shape \\ts\\* absorbed (got ${JSON.stringify(out)})`);
}
{
  // Non-regression: the real uW trailing run `\ts\* \q1` (ts now counts as part of
  // the run) still tail-aligns against a doubled leading \q1 — exactly the \q1 is
  // dropped, nothing else.
  const prev = [{ type: "text", text: "done.\n\n" }, { tag: "ts\\*", nextChar: "\n" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [{ tag: "q1", type: "quote", nextChar: " " }, { type: "text", text: "next" }];
  const out = dropDoubledLeadingMarkers(prev, curr);
  assert(out.length === 1 && out[0].text === "next", `#684: trailing \\ts\\* \\q1 still de-dups a leading \\q1 (got ${JSON.stringify(out)})`);
}
{
  // A leading \ts\* that does NOT double the previous trailing run is kept.
  const prev = [{ type: "text", text: "done.\n" }, { tag: "q1", type: "quote", nextChar: " " }];
  const curr = [{ tag: "ts\\*", nextChar: "\n" }, { type: "text", text: "next" }];
  assert(dropDoubledLeadingMarkers(prev, curr) === curr, `#684: non-matching leading \\ts\\* left alone`);
}
{
  // plain_text: a \ts\* (any shape) is a word separator, like \p / \q1.
  for (const ts of [{ tag: "ts\\*" }, { tag: "ts*" }, { tag: "ts", content: "\\*" }]) {
    const plain = extractPlainText({ verseObjects: [{ type: "text", text: "end" }, ts, { type: "text", text: "start" }] });
    assert(plain === "end start", `#684: ${JSON.stringify(ts)} separates words in plain_text (got ${JSON.stringify(plain)})`);
  }
}

console.log("\nAll parser smoke checks passed.");
