// Canonize resource Hebrew to byte-match the UHB source.
//
// Adapted from Stephen Wunrow's standalone `canonizeHebrew.mjs`. The original
// read `.usfm`/`.tsv` off disk and rewrote them line-by-line; this port keeps
// the matching ALGORITHM (the valuable part) and drops the file I/O — it works
// on the in-memory shapes bible-editor already has: usfm-js `verseObjects` for
// ULT/UST alignment, and a plain quote string for TN/TWL rows. The UHB is read
// from D1 by the caller (see collectSourceWords) and passed
// in as SourceWord[], so this module is pure and unit-testable.
//
// WHY. The UHB stores combining marks in traditional Tanakh order (dagesh before
// vowel); AI-emitted `\zaln-s x-content`, TN quotes, and ZEC/LAM milestones come
// out in NFC order. They're visually identical but fail byte equality, which is
// why every Hebrew↔Hebrew compare currently has to fold to NFC on the fly
// (docs/hebrew-normalization.md). This is "the upstream fix" that doc names:
// rewrite the resource's Hebrew to the UHB's EXACT bytes so downstream storage,
// export, and comparison all see one representation. It complements — does not
// replace — the compare-layer nfc() folds, which stay as a safety net.
//
// MATCHING. For each resource token we look up the UHB word by three
// progressively looser tiers and STOP at the first hit:
//   1. exact      — NFC + joiners removed (only combining-mark ORDER differs)
//   2. stripped   — vowel points / cantillation removed (consonants + order)
//   3. wordJoiner — stripped, then U+2060 removed (quotes routinely drop it)
// A matched UHB word is CONSUMED (found flag) so a second resource token can't
// claim it — this keeps two same-skeleton-but-differently-pointed words mapping
// to distinct UHB words. On a hit we adopt the UHB's exact surface (and lemma,
// for alignment); an unmatched token is LEFT AS-IS — the transform never guesses.

import type { SourceWord } from "./importParsers";

// ── Folds (mirror the three tiers) ──────────────────────────────────────────

// Invisible joiners that carry no linguistic content but break byte equality:
// word joiner (U+2060), ZWJ (U+200D), BOM/ZWNBSP (U+FEFF).
const INVISIBLE_JOINERS = /[⁠‍﻿]/g;
const WORD_JOINER = /⁠/g;
// HEBREW PUNCTUATION MAQAF (U+05BE) — the "hyphen" that joins Hebrew words.
const MAQAF = "־";

// NFC + drop invisible joiners. Two strings that differ ONLY in combining-mark
// order (legacy UHB vs. NFC) fold together here. Strips nothing linguistic.
function canonicalHebrew(text: string): string {
  return text.replace(INVISIBLE_JOINERS, "").normalize("NFC");
}

// Remove Hebrew points (vowels) and accents (cantillation) + the Masora circle,
// leaving consonants. Mirrors the Python/mjs original's ranges exactly.
function stripHebrewMarks(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x0591 && c <= 0x05bd) || // accents + most points
      c === 0x05bf || // rafe
      (c >= 0x05c1 && c <= 0x05c2) || // shin/sin dot
      (c >= 0x05c4 && c <= 0x05c5) || // upper/lower dot
      c === 0x05c7 // qamats qatan
    ) {
      continue;
    }
    out += ch;
  }
  return out.normalize("NFC");
}

// Consonant skeleton with the word-joiner also removed. TN/TQ quotes routinely
// omit the U+2060 the UHB token carries (e.g. ZEC 4:10), so this is the loosest
// tier that still keys on real letters.
function wordJoinerFold(text: string): string {
  return stripHebrewMarks(text).replace(WORD_JOINER, "");
}

// ── Lookup tables ───────────────────────────────────────────────────────────

// One UHB word, ready to be adopted. `found` is consumed as tokens match it.
interface UhbEntry {
  form: string; // UHB surface `\w text` — the exact bytes we adopt
  lemma: string; // UHB lemma — adopted for alignment milestones
  found: boolean;
}

function firstUnused(entries: UhbEntry[] | undefined): UhbEntry | null {
  if (!entries) return null;
  for (const e of entries) if (!e.found) return e;
  return null;
}

function push(map: Map<string, UhbEntry[]>, key: string, entry: UhbEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

// A three-tier lookup keyed by the same fold family. Quotes key on the surface
// alone (see buildShortLookup below).
interface TieredLookup {
  exact: Map<string, UhbEntry[]>;
  stripped: Map<string, UhbEntry[]>;
  joiner: Map<string, UhbEntry[]>;
}

function emptyLookup(): TieredLookup {
  return { exact: new Map(), stripped: new Map(), joiner: new Map() };
}

// TSV quotes have no lemma/morph, so they key on the surface form alone
// (mirrors the original's "short" lookups). Fresh entries → their own `found`
// flags, independent of any alignment lookup.
function buildShortLookup(words: SourceWord[]): TieredLookup {
  const lk = emptyLookup();
  for (const w of words) {
    const e: UhbEntry = { form: w.text, lemma: w.lemma, found: false };
    push(lk.exact, canonicalHebrew(w.text), e);
    push(lk.stripped, stripHebrewMarks(w.text), e);
    push(lk.joiner, wordJoinerFold(w.text), e);
  }
  return lk;
}

// ── Public API ──────────────────────────────────────────────────────────────

// Rewrite each word of a TN/TWL quote to the exact UHB bytes, preserving the
// original separators (space / maqaf). Returns the canonicalized quote, or the
// input unchanged if nothing matched.
//
// `strict` limits matching to the exact tier — use it for verse-RANGE quotes,
// where the looser consonant folds risk grabbing a same-skeleton word from the
// wrong verse (mirrors the original's verse-range guard).
export function canonizeQuote(
  quote: string,
  uhbWords: SourceWord[],
  opts: { strict?: boolean } = {},
): string {
  if (!quote || uhbWords.length === 0) return quote;
  const strict = opts.strict ?? false;
  const lk = buildShortLookup(uhbWords);
  // Split keeping separators: even indices are words, odd indices are the
  // space/maqaf between them. Rebuilding from this array avoids the original's
  // regex-replace-on-Hebrew (which could match the wrong occurrence).
  const tokens = quote.split(new RegExp(`([ ${MAQAF}])`));
  let changed = false;
  for (let i = 0; i < tokens.length; i += 2) {
    const word = tokens[i];
    if (!word) continue;
    let e = firstUnused(lk.exact.get(canonicalHebrew(word)));
    if (!e && !strict) e = firstUnused(lk.stripped.get(stripHebrewMarks(word)));
    if (!e && !strict) e = firstUnused(lk.joiner.get(wordJoinerFold(word)));
    if (e) {
      e.found = true;
      if (word !== e.form) {
        tokens[i] = e.form;
        changed = true;
      }
    }
  }
  return changed ? tokens.join("") : quote;
}
