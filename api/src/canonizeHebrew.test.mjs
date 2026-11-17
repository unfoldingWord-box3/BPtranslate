// Unit tests for canonizeHebrew.ts — canonizing resource Hebrew to the exact
// UHB bytes. Run from api/:
//   node --experimental-strip-types --no-warnings src/canonizeHebrew.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { canonizeQuote } from "./canonizeHebrew.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// ── Building blocks ─────────────────────────────────────────────────────────
// A consonant + dagesh + hiriq. The UHB stores marks in traditional Tanakh
// order (dagesh, ccc=21, BEFORE the vowel hiriq, ccc=18); NFC reorders to
// ascending combining class (hiriq before dagesh). The two are byte-distinct
// but visually identical — exactly the drift canonize repairs.
const BET = "ב";
const DAGESH = "ּ";
const HIRIQ = "ִ";
const QAMATS = "ָ";
const WJ = "⁠"; // word joiner

const LEGACY = BET + DAGESH + HIRIQ; // UHB storage order
const NFC = BET + HIRIQ + DAGESH; // AI / NFC order

// Sanity: the two orders fold together under NFC, and NFC is the canonical form.
assert(NFC.normalize("NFC") === NFC, "precondition: NFC form is already canonical");
assert(LEGACY.normalize("NFC") === NFC, "precondition: legacy UHB order folds to the NFC form");
assert(LEGACY !== NFC, "precondition: legacy and NFC bytes genuinely differ");

const w = (text, lemma, morph) => ({ text, strong: "H1", lemma, morph });
// Milestones default to strong "H1" (matching w()); override via attrs.strong.
const zaln = (attrs, children = []) => ({ type: "milestone", tag: "zaln", strong: "H1", ...attrs, children });

// ── canonizeQuote ───────────────────────────────────────────────────────────

// 9. Multi-word quote: each word canonized, the space separator preserved.
{
  const q = NFC + " " + "דבר"; // NFC-order word + bare word
  const uhb = [w(LEGACY, LEGACY, "M"), w("ד" + QAMATS + "ב" + QAMATS + "ר", "L2", "M")];
  const out = canonizeQuote(q, uhb);
  assert(
    out === LEGACY + " " + "ד" + QAMATS + "ב" + QAMATS + "ר",
    "quote: both words canonized, space preserved",
  );
}

// 10. Maqaf separator preserved.
{
  const maqaf = "־";
  const q = NFC + maqaf + NFC;
  const uhb = [w(LEGACY, LEGACY, "M"), w(LEGACY, LEGACY, "M")];
  const out = canonizeQuote(q, uhb);
  assert(out === LEGACY + maqaf + LEGACY, "quote: maqaf separator preserved between canonized words");
}

// 11. Found-flag in quotes: repeated skeleton → distinct UHB words.
{
  const boA = "בֹא";
  const baA = "ב" + QAMATS + "א";
  const bare = "בא";
  const q = bare + " " + bare;
  const uhb = [w(boA, "L", "M"), w(baA, "L", "M")];
  const out = canonizeQuote(q, uhb);
  assert(out === boA + " " + baA, "quote found-flag: two bare words map to two distinct UHB words");
}

// 12. strict mode (verse ranges): only the exact tier fires; a bare word that
//     would need the stripped tier is left untouched.
{
  const dbrBare = "דבר";
  const dbrPointed = "ד" + QAMATS + "ב" + QAMATS + "ר";
  const uhb = [w(dbrPointed, dbrPointed, "M")];
  assert(
    canonizeQuote(dbrBare, uhb, { strict: true }) === dbrBare,
    "strict: stripped-tier match suppressed for verse ranges",
  );
  assert(
    canonizeQuote(dbrBare, uhb) === dbrPointed,
    "non-strict: same input DOES match via the stripped tier",
  );
}

// 13. Unmatched word left as-is; no throw on empty UHB.
{
  const q = NFC;
  assert(canonizeQuote(q, []) === q, "empty UHB: quote returned unchanged");
  assert(canonizeQuote(q, [w("שלום", "L", "M")]) === q, "no match: word left as-is");
}

// 14. Each invisible joiner in the exact-tier fold is exercised independently
//     (pins the INVISIBLE_JOINERS class members — WJ/U+2060 is already covered
//     by cases 5 & 13's absence, ZWJ and BOM are pinned here). A quote word that
//     carries the joiner still matches a clean UHB word and adopts its exact
//     bytes — only possible if canonicalHebrew() strips that codepoint.
{
  const clean = "אב"; // alef bet, no joiner
  const uhb = [w(clean, clean, "M")];
  assert(
    canonizeQuote("א‍ב", uhb) === clean,
    "ZWJ (U+200D) folded at exact tier → adopts clean UHB bytes",
  );
  assert(
    canonizeQuote("א﻿ב", uhb) === clean,
    "BOM/ZWNBSP (U+FEFF) folded at exact tier → adopts clean UHB bytes",
  );
}

console.log("canonizeHebrew.test.mjs: all assertions passed");
