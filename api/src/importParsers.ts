// Pure parsing helpers shared between the inbound AI-pipeline importer
// (api/src/pipelineImport.ts) and the future inbound-from-DCS path. The
// existing one-shot scripts/import-book.mjs is the historical reference;
// these helpers are now the canonical Worker-side source.

import usfm from "usfm-js";
import { isTsMilestone } from "./tsMilestone.ts";

export interface VerseExtract {
  chapter: number;
  verse: number;
  // Inclusive end of a multi-verse block (e.g. `\v 6-9` → verse=6, verseEnd=9).
  // null for singleton verses and the chapter-front pseudo-verse.
  verseEnd: number | null;
  contentJson: string;       // JSON-stringified verseObj suitable for verses.content_json
  plainText: string;
}

// Strip leading / trailing non-letter characters off a `\w` token's text,
// emitting them as adjacent text nodes. Interior content is preserved —
// `\w of the LORD\w*` (a deliberately multi-word target, see the
// Selah / Yahweh cases in docs/usfm-alignment-audit.md) stays one token;
// only the outer punctuation comes off. Without this, source USFM that
// writes `\w "What\w*` (punctuation inside the marker) produces draggable
// alignment chips labelled `"What`, `seeing?"`, etc. — see PR #47.
//
// `\w`-internal apostrophes / hyphens are NOT stripped (the algorithm
// only trims from the outside), so `don't`, `hello-world`, `LORD’s`
// stay one token.
//
// Walks recursively into children (zaln-s milestones, \qs wrappers).
// Returns a new verseObjects array; the input is left untouched so
// caller-held references stay valid.
export function normalizeWordPunctuation(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  return verseObjects.flatMap((n) => normalizeNode(n));
}

function normalizeNode(node: unknown): unknown[] {
  if (!node || typeof node !== "object") return [node];
  const o = node as Record<string, unknown>;
  if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
    const text = o["text"];
    const split = splitWordPunctuation(text);
    if (split.leading === "" && split.trailing === "") return [node];
    const out: unknown[] = [];
    if (split.leading) out.push({ type: "text", text: split.leading });
    if (split.core) out.push({ ...o, text: split.core });
    // A `\w` containing only punctuation (split.core === "") is treated
    // as plain text — the bare token had no semantic word content to
    // align anyway.
    if (split.trailing) out.push({ type: "text", text: split.trailing });
    return out;
  }
  if (Array.isArray(o["children"])) {
    return [{ ...o, children: (o["children"] as unknown[]).flatMap((c) => normalizeNode(c)) }];
  }
  return [node];
}

// Letters / marks / numbers count as "core" word content. Numbers
// matter because the UST writes literal counts (`\w 30\w*`, `\w 15\w*`)
// for measurements — treating them as punctuation would demote the
// digit tokens to plain text and break alignment to the source.
const LETTER_RE = /[\p{L}\p{M}\p{N}]/u;

function splitWordPunctuation(text: string): { leading: string; core: string; trailing: string } {
  const first = text.search(LETTER_RE);
  if (first < 0) return { leading: text, core: "", trailing: "" };
  let last = first;
  for (let i = text.length - 1; i >= first; i--) {
    if (LETTER_RE.test(text[i])) {
      last = i;
      break;
    }
  }
  return {
    leading: text.slice(0, first),
    core: text.slice(first, last + 1),
    trailing: text.slice(last + 1),
  };
}

// ─── De-glue AI-introduced punctuation-spanning word tokens ──────────────
//
// The AI/tC aligner sometimes emits a single `\w` that swallowed boundary
// punctuation AND the next clause's first word, nested inside the PREVIOUS
// source word's `\zaln-s` — e.g. `\w out”—the\w*` (aligned to הוֹצֵאתִיהָ in
// ZEC 5:4) or `\w Armies—“and\w*`. normalizeWordPunctuation deliberately
// can't touch these (both ends are letters, so its outer-strip is a no-op,
// and interior content is preserved to keep legit multi-word targets like
// `\w of the LORD\w*` intact). This is the sibling defect to the malformed
// `x-occurrence` handled by effectiveOccurrence() in web/src/lib/alignment.ts.
//
// We split such a token on its interior boundary punctuation and lift every
// fragment out of its `\zaln-s`, so the words fall into the word bank as
// UNALIGNED for a human to re-align (matching gatewayEdit); the rest of each
// group keeps its alignment. Runs at import (extractVersesForRange) so
// AI-drafted and DCS content lands clean; the one-time cleanup script in
// scripts/normalize-verse-punctuation.mjs imports this same function. The
// lift / strip helpers below mirror the originals in web/src/lib/replace.ts —
// keep them in sync.

// Boundary punctuation that marks a clause break when it sits INSIDE a `\w`
// flanked by word content: double quotes (straight + curly), guillemets, and
// em / en dashes. NOT apostrophes / hyphens (intra-word: don't, hello-world)
// and NOT spaces (legit multi-word targets). A run of these is a split point.
const BOUNDARY_RUN_RE = /["“”«»—–]+/g;
const WORD_CONTENT_RE = /[\p{L}\p{M}]/u;

// Split a `\w` text into [word][punct-run][word]… segments, each emitted as a
// node marked `__edited` so liftEditedOutOfZaln pops it out of the enclosing
// `\zaln-s`. Returns null when the token is not glued (fewer than two
// letter-bearing word segments) so callers leave it untouched — dash/quote
// runs between digit-only segments (number ranges like "1914–1918") yield <2
// letter-bearing segments → null. Marking the punct text `__edited` too avoids
// leaving a degenerate punctuation-only milestone between the lifted words.
function splitGluedNode(node: Record<string, unknown>): unknown[] | null {
  const text = String(node["text"] ?? "");
  const segments: Array<{ word: boolean; text: string }> = [];
  let last = 0;
  const re = new RegExp(BOUNDARY_RUN_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ word: true, text: text.slice(last, m.index) });
    segments.push({ word: false, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ word: true, text: text.slice(last) });
  const letterSegs = segments.filter((s) => s.word && WORD_CONTENT_RE.test(s.text));
  if (letterSegs.length < 2) return null;
  const out: unknown[] = [];
  for (const s of segments) {
    if (s.text === "") continue;
    if (s.word && WORD_CONTENT_RE.test(s.text)) {
      out.push({ ...node, text: s.text, __edited: true });
    } else {
      out.push({ type: "text", text: s.text, __edited: true });
    }
  }
  return out;
}

// Walk the tree, replacing each glued `\w` with its split fragments. Reports
// whether anything split so the caller can skip the lift / recompute passes on
// clean verses (no occurrence churn there).
function markGluedSplits(verseObjects: unknown[]): { result: unknown[]; didSplit: boolean } {
  let didSplit = false;
  const walk = (nodes: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const node of nodes) {
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
          const split = splitGluedNode(o);
          if (split) {
            didSplit = true;
            out.push(...split);
            continue;
          }
        } else if (Array.isArray(o["children"])) {
          out.push({ ...o, children: walk(o["children"] as unknown[]) });
          continue;
        }
      }
      out.push(node);
    }
    return out;
  };
  return { result: walk(verseObjects), didSplit };
}

// Lift any node marked `__edited` out of every enclosing `\zaln-s` ancestor:
// the marked node becomes a bare (unaligned) sibling at the milestone's old
// position, the milestone splitting into pre/post halves around it. Mirror of
// web/src/lib/replace.ts:liftEditedOutOfZaln — keep in sync.
function liftEditedOutOfZaln(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    const o = node as Record<string, unknown>;
    if (o["__edited"]) {
      const { __edited: _drop, ...rest } = o as Record<string, unknown> & { __edited?: unknown };
      (rest as Record<string, unknown>)["__lifted"] = true;
      out.push(rest);
      continue;
    }
    if (Array.isArray(o["children"])) {
      const processed = liftEditedOutOfZaln(o["children"] as unknown[]);
      if (o["tag"] === "zaln") {
        let segment: unknown[] = [];
        const flush = () => {
          if (segment.length > 0) {
            out.push({ ...o, children: segment });
            segment = [];
          }
        };
        for (const child of processed) {
          if (child && typeof child === "object" && (child as Record<string, unknown>)["__lifted"]) {
            flush();
            out.push(child);
          } else {
            segment.push(child);
          }
        }
        flush();
      } else {
        out.push({ ...o, children: processed });
      }
    } else {
      out.push(node);
    }
  }
  return out;
}

// Strip leftover `__lifted` markers from a fully-processed tree. Mirror of
// web/src/lib/replace.ts:stripLiftedMarkers — keep in sync.
function stripLiftedMarkers(nodes: unknown[]): unknown[] {
  return nodes.map((n) => {
    if (!n || typeof n !== "object") return n;
    const { __lifted: _drop, ...rest } = n as Record<string, unknown> & { __lifted?: unknown };
    if (Array.isArray((rest as Record<string, unknown>)["children"])) {
      (rest as Record<string, unknown>)["children"] = stripLiftedMarkers(
        (rest as Record<string, unknown>)["children"] as unknown[],
      );
    }
    return rest;
  });
}

// Renumber every target `\w`'s occurrence / occurrences across the verse in
// document order. A split creates a fresh instance of an existing word (e.g. a
// 7th "the"); without this the freed token keeps the glued token's bogus 1/1
// and collides with the real occurrences on export / re-alignment. Source
// `\zaln-s` x-occurrence attributes live on the milestone, not on `\w`, so
// they're never touched here.
//
// Also used as a defensive normalizer on the verse read/write boundaries
// (chapters.ts, verses.ts, pipelineImport.ts): malformed AI/imported alignment
// can stamp every `\w` `occurrences="1"` and collide `(text, occurrence)` pairs
// (e.g. two "is" both occurrence=2), which breaks every feature that keys words
// by `${text}|${occurrence}` (note-quote highlight, chip colors, quote builder).
// Recomputing from document position makes the keys unique and correct. A no-op
// on already-correct verses, so round-trip fidelity on clean data is preserved.
// Mutates `verseObjects` in place and returns it.
export function recomputeTargetOccurrences(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const words: Array<Record<string, unknown>> = [];
  const collect = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        words.push(o);
      } else if (Array.isArray(o["children"])) {
        collect(o["children"] as unknown[]);
      }
    }
  };
  collect(verseObjects);
  const totals = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const running = new Map<string, number>();
  for (const w of words) {
    const key = String(w["text"]);
    const n = (running.get(key) ?? 0) + 1;
    running.set(key, n);
    w["occurrence"] = String(n);
    w["occurrences"] = String(totals.get(key) ?? 1);
  }
  return verseObjects;
}

// ─── Heal U+FFFD replacement chars in alignment source attributes ────────────
//
// The AI aligner has emitted `\zaln-s` milestones whose source-language
// attributes (x-content = the displayed Hebrew/Greek surface form, x-lemma,
// x-morph) carry one or more U+FFFD REPLACEMENT CHARACTERs where a multi-byte
// Hebrew vowel / cantillation mark / consonant was mangled during generation
// (a UTF-8 round-trip bug upstream). The garbled text round-tripped out to
// door43 master and flows back in through the nightly reimport, so it shows up
// in the aligner as a broken word (e.g. HOS 8:4 UST "gold": וּזְה❖❖בָם).
//
// We repair it WITHOUT touching alignment structure: only the corrupt attribute
// STRING is rewritten, reconstructed from the parallel original-language source
// word (UHB / UGNT). No node is added, removed, reordered, or re-nested and no
// `\w` occurrence is renumbered, so an edit here can never unalign a word — the
// invariant the whole save engine protects. plain_text is unaffected too (it
// concatenates node `.text`, never these milestone attributes).
//
// Matching is conservative: a corrupt attribute is repaired only when exactly
// ONE distinct clean source value (a) shares the milestone's Strong's number and
// (b) has the corrupt value's surviving (non-FFFD) characters as an in-order
// subsequence. Anything ambiguous or unmatched is LEFT AS-IS (and reported), so
// the heal never guesses. A no-op on clean verses — gate callers on a cheap
// string `.includes("�")` so the source lookup only runs when needed.

const REPLACEMENT_CHAR = "�";

// One source-language `\w` token, for matching a corrupt milestone attribute
// back to its clean original-language form.
export interface SourceWord {
  text: string;
  strong: string;
  lemma: string;
  morph: string;
}

// Which clean SourceWord field repairs each corrupt milestone attribute.
const ATTR_TO_SOURCE_FIELD: Record<string, keyof SourceWord> = {
  content: "text", // x-content — the displayed surface form
  lemma: "lemma",
  morph: "morph",
};

export function hasReplacementChar(s: unknown): boolean {
  return typeof s === "string" && s.includes(REPLACEMENT_CHAR);
}

// True iff `corrupt` with its U+FFFD removed is an in-order subsequence of
// `clean` — i.e. the surviving characters all appear, in sequence, in the clean
// value. The mangled bytes only ever DROP content (a vowel/mark/letter became
// FFFD), so a correct reconstruction must contain every surviving character.
function survivingIsSubsequence(corrupt: string, clean: string): boolean {
  let i = 0;
  const surviving = [...corrupt].filter((ch) => ch !== REPLACEMENT_CHAR);
  for (const ch of clean) {
    if (i < surviving.length && ch === surviving[i]) i++;
  }
  return i === surviving.length;
}

// Collect every source-language `\w` token in document order, for use as the
// repair reference. Source `\w` carry strong/lemma/morph but (per import) no
// x-occurrence — matching is by Strong's + surviving-character subsequence.
export function collectSourceWords(verseObjects: unknown[]): SourceWord[] {
  const out: SourceWord[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string") {
        out.push({
          text: o["text"] as string,
          strong: typeof o["strong"] === "string" ? (o["strong"] as string) : "",
          lemma: typeof o["lemma"] === "string" ? (o["lemma"] as string) : "",
          morph: typeof o["morph"] === "string" ? (o["morph"] as string) : "",
        });
      } else if (Array.isArray(o["children"])) {
        walk(o["children"] as unknown[]);
      }
    }
  };
  walk(verseObjects);
  return out;
}

export interface HealReport {
  repaired: Array<{ attr: string; strong: string; from: string; to: string }>;
  unrepaired: Array<{ attr: string; strong: string; value: string }>;
}

// Resolve the single unambiguous clean value for one corrupt attribute, or null.
function resolveRepair(
  corrupt: string,
  strong: string,
  sourceField: keyof SourceWord,
  sourceWords: SourceWord[],
): string | null {
  if (!strong || strong.includes(REPLACEMENT_CHAR)) return null;
  const distinct = new Set<string>();
  for (const w of sourceWords) {
    if (w.strong !== strong) continue;
    const clean = w[sourceField];
    if (!clean || clean.includes(REPLACEMENT_CHAR)) continue;
    if (survivingIsSubsequence(corrupt, clean)) distinct.add(clean);
  }
  return distinct.size === 1 ? [...distinct][0] : null;
}

// Repair U+FFFD in `\zaln-s` source attributes (x-content / x-lemma / x-morph)
// in place, reconstructing from `sourceWords`. Returns what was (and wasn't)
// repaired. Mutates `verseObjects`. Structure-preserving by construction — it
// only reassigns string attribute values on existing milestone nodes.
export function healReplacementChars(
  verseObjects: unknown[],
  sourceWords: SourceWord[],
): HealReport {
  const report: HealReport = { repaired: [], unrepaired: [] };
  if (!Array.isArray(verseObjects)) return report;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const strong = typeof o["strong"] === "string" ? (o["strong"] as string) : "";
      for (const attr of Object.keys(ATTR_TO_SOURCE_FIELD)) {
        const val = o[attr];
        if (!hasReplacementChar(val)) continue;
        const fixed = resolveRepair(val as string, strong, ATTR_TO_SOURCE_FIELD[attr], sourceWords);
        if (fixed === null) {
          report.unrepaired.push({ attr, strong, value: val as string });
        } else {
          report.repaired.push({ attr, strong, from: val as string, to: fixed });
          o[attr] = fixed;
        }
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(verseObjects);
  return report;
}

// ─── Curl straight quotes on the AI-pipeline ingest path (verse text AND ──────
// ─── note/question/response prose) ───────────────────────────────────────────
//
// bp-assistant's ULT/UST verse drafts have written STRAIGHT ' and " into
// content_json (JER 32/33, NUM 26:53, en_ult + en_ust, 2026 June–July prod
// forensics) — DCS master's USFM ends up with straight quotes, and the export
// path never fixes them because tsvFormat.ts's educateQuotes only runs over
// tn/tq TSV cells, not verse USFM. Every other entry point curls at ingest —
// client-side keystroke/paste interception (web/src/lib/curlyQuotes.ts) and
// the tn/tq TSV export (tsvFormat.ts educateQuotes, left untouched — it stays
// the export-time normalizer for human-typed content) — this closes the gap
// for the AI-pipeline's OWN ingest of both verse text (curlifyVerseObjects,
// called from pipelineImport.ts's applyVerseUpdate) and note/question/response
// prose (curlifyText, called from tnPayload/tqPayload). The two calls share
// this exact same contextual rule (curlifyChar/isOpeningQuoteContext) so an
// AI-drafted note is never curled differently than AI-drafted verse text in
// the same run — a real divergence existed here when note prose went through
// tsvFormat.ts's educateQuotes instead (that function's opening-context class
// omits `/`, curlifyChar's includes it, matching web/src/lib/curlyQuotes.ts).
//
// Deliberately NOT wired into extractVersesForRange above: that function also
// serves the nightly DCS reimport (bookReimport.ts) and the bootstrap import
// (bookImport.ts), and this fix must stay scoped to the AI-pipeline write path
// only — existing D1 data and the master reimport are out of scope here.
//
// Mirrors curlyFor/isOpeningContext in web/src/lib/curlyQuotes.ts (duplicated
// for the same cross-bundle reason as extractPlainText above — keep in sync): a
// quote is "opening" when the preceding character is missing, whitespace, or
// another opener-ish punctuation mark; otherwise it's closing, which is also
// how ' doubles as a contextual apostrophe (don't → don't).
const CURLY_LDQUO = "“"; // “
const CURLY_RDQUO = "”"; // ”
const CURLY_LSQUO = "‘"; // ‘
const CURLY_RSQUO = "’"; // ’

function isOpeningQuoteContext(prev: string | undefined, prevPrev?: string | undefined): boolean {
  if (!prev) return true;
  if (/\s/.test(prev)) return true;
  // The two-character literal `\n` escape is unfoldingWord's TSV line-break
  // convention (note/question/response prose — a TSV cell can't hold a real
  // newline): a quote right after it starts a new line, so it opens. Needs the
  // char BEFORE prev — a lone trailing "n" (e.g. "in\"…") stays closing.
  if (prev === "n" && prevPrev === "\\") return true;
  return /[(\[{<\-–—/“‘]/.test(prev);
}

// Curl one straight quote character. `prevCurled` is the last CURLED
// character emitted before it (drives the opening/closing context rule).
// `prevRaw` is the last RAW (pre-curl) character (drives the adjacency
// override below). Two of the SAME straight quote character sitting directly
// back-to-back — nothing else between them — can never both resolve to the
// same side via the plain context rule alone: `""` naively curls to `““`
// (the second quote sees the just-emitted “ as an "opener-ish" prev char and
// opens again), and `"a""b"` naively curls to `“a””b”` (the 3rd quote sees
// the just-emitted ” as ordinary, non-opener context and closes again
// instead of opening the next quoted word). When `prevRaw` is the identical
// straight quote, force strict alternation instead of consulting context:
// `""` → `“”` (an empty quoted phrase), `"a""b"` → `“a”“b”` (two
// back-to-back quoted words).
// `prevCurled2` is the curled character emitted before `prevCurled` — needed
// only so isOpeningQuoteContext can recognize the two-character literal `\n`
// escape ("\\" then "n") as an opening context.
function curlifyChar(
  ch: '"' | "'",
  prevRaw: string | undefined,
  prevCurled: string | undefined,
  prevCurled2?: string | undefined,
): string {
  if (prevRaw === ch) {
    if (ch === '"') return prevCurled === CURLY_LDQUO ? CURLY_RDQUO : CURLY_LDQUO;
    return prevCurled === CURLY_LSQUO ? CURLY_RSQUO : CURLY_LSQUO;
  }
  if (ch === '"') return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LDQUO : CURLY_RDQUO;
  return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LSQUO : CURLY_RSQUO;
}

// Curl every straight quote in one text string, threading in the last
// character emitted (curled) and seen (raw) before it — from a preceding
// sibling/ancestor node in a verse tree walk, or `undefined`/`undefined` for a
// standalone string (see curlifyText below) — so a quote right at a node
// boundary still sees real context in both senses curlifyChar needs. Returns
// the (possibly unchanged) text plus whether anything changed, so the caller
// can skip a write on a clean string.
function curlifyTextWithContext(
  text: string,
  prevCurled: string | undefined,
  prevRaw: string | undefined,
): { text: string; changed: boolean } {
  let out = "";
  let changed = false;
  let curled = prevCurled;
  // Char before `curled` — threaded so the literal `\n` escape (two chars) is
  // visible as an opening context. Starts unknown at a node/string boundary,
  // which only means a `\n` SPLIT across two nodes isn't recognized — verse
  // trees never carry the escape (it's TSV-prose-only), so nothing is lost.
  let curled2: string | undefined = undefined;
  let raw = prevRaw;
  for (const ch of text) {
    if (ch === '"' || ch === "'") {
      const curly = curlifyChar(ch, raw, curled, curled2);
      out += curly;
      if (curly !== ch) changed = true;
      curled2 = curled;
      curled = curly;
    } else {
      out += ch;
      curled2 = curled;
      curled = ch;
    }
    raw = ch;
  }
  return { text: out, changed };
}

// Curl straight quotes in a standalone string with no surrounding tree — the
// entry point for AI-drafted note/question/response PROSE (pipelineImport.ts
// tnPayload/tqPayload). Starts with no incoming context (a note is its own
// document, unlike a verse's tree walk), and shares curlifyChar/
// isOpeningQuoteContext with curlifyVerseObjects below so the two ingest
// paths can never disagree on how a given straight quote curls. No-op
// (identity) on text with no straight quotes.
export function curlifyText(text: string): string {
  if (!text || !/['"]/.test(text)) return text;
  return curlifyTextWithContext(text, undefined, undefined).text;
}

// Mutates `verseObjects` in place (like healReplacementChars /
// canonizeAlignmentSource); returns whether anything changed.
//
// Touches ONLY a node's own `.text` string, walked in document order across
// the whole tree (target `\w` words, plain text, and a marker's own parked
// leading text — see "usfm-js parks leading punctuation on the marker's
// `text`" in STATE.md) — EXCEPT `\zaln-s` milestone nodes (type "milestone",
// tag "zaln" — the file's standard test elsewhere, e.g. isZalnNode /
// nodeIsMilestone in highlight.ts), whose own attributes (content/lemma/
// morph/strong — the Hebrew/Greek surface form) are source-owned and never
// touched, even defensively if one ever carried a `.text` key. Milestone
// CHILDREN (the aligned target words) are walked normally. No node is added,
// removed, reordered, or re-nested, no `\w` occurrence changes, and no
// attribute is ever assigned — so this can never unalign a word, alter a word
// count, or touch Hebrew/Greek. No-op (identity) on a verse with no straight
// quotes, the common case.
export function curlifyVerseObjects(verseObjects: unknown[]): boolean {
  if (!Array.isArray(verseObjects)) return false;
  let changed = false;
  let prevCurled: string | undefined;
  let prevRaw: string | undefined;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      const isSourceMilestone = o["type"] === "milestone" && o["tag"] === "zaln";
      const text = o["text"];
      if (!isSourceMilestone && typeof text === "string" && text.length > 0) {
        if (/['"]/.test(text)) {
          const result = curlifyTextWithContext(text, prevCurled, prevRaw);
          if (result.changed) {
            o["text"] = result.text;
            changed = true;
          }
          prevCurled = result.text[result.text.length - 1];
        } else {
          prevCurled = text[text.length - 1];
        }
        prevRaw = text[text.length - 1];
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(verseObjects);
  return changed;
}

// ─── Reconcile source-owned `\zaln-s` attributes from master ─────────────────
//
// The `\zaln-s` milestone carries original-language (UHB/UGNT) attributes —
// x-content (the Hebrew/Greek surface form), x-lemma, x-morph, x-strong. These
// are copied from the source at alignment time and are SOURCE-owned: the
// translator owns the target `\w` words inside the milestone and the grouping,
// NOT the spelling/pointing/morphology of the original-language word. So a
// curated fix to the source spelling on master (e.g. "Fixing unicode in Numbers
// 20–22" — combining marks reordered into UHB-legacy order in x-lemma/x-content)
// must propagate down to D1 even on a verse a translator has edited; otherwise
// the nightly export re-renders D1's stale source bytes back onto master and
// silently REVERTS the fix (the freshness gate can't catch it — its watermark is
// per-file but the reimport's skip is per-verse, so the watermark advances past
// the un-synced edited verse). This is the verse analogue of the TWL-PSA /
// Hebrew-NFC clobber class.
//
// Conservative, structure-preserving, never-guess — same discipline as
// healReplacementChars:
//   - Match a target milestone to master ONLY by source identity:
//     strong | occurrence | occurrences. That key is stable across a translator
//     edit (the source word is the same Hebrew) and across regrouping, so it
//     survives an edited target; it does NOT rely on position.
//   - x-strong is the match KEY, so a matched milestone already agrees on strong
//     (a milestone master re-pointed to a different strong simply won't match and
//     is left alone — re-pointing is a different, out-of-scope class).
//   - Adopt master's value for content/lemma/morph ONLY when master carries a
//     SINGLE distinct value for that (key, attr). If master is ambiguous (the same
//     source key appears with conflicting values — malformed/AI data) and the
//     target disagrees, leave it as-is and REPORT it (divergent) rather than guess.
//   - Target words + grouping + every other node are untouched, so nothing can
//     unalign. Mutates `targetVerseObjects` in place (only existing string attrs
//     on existing milestone nodes are reassigned), mirroring healReplacementChars.
// No-op (identity, empty report) on a verse whose source attrs already match
// master — the steady-state case.

// Source-owned milestone attributes copied from master (x-strong is the match
// key, so it's excluded from the value copy — a matched milestone agrees on it).
const SOURCE_OWNED_MILESTONE_ATTRS = ["content", "lemma", "morph"] as const;

// Source-word identity of a `\zaln-s` milestone: strong | occurrence |
// occurrences. null when strong is absent (un-keyable — never matched).
function milestoneSourceKey(o: Record<string, unknown>): string | null {
  const strong = o["strong"];
  if (typeof strong !== "string" || strong === "") return null;
  return `${strong}|${String(o["occurrence"] ?? "")}|${String(o["occurrences"] ?? "")}`;
}

// True when a milestone's x-content spans a cross-word GLUE joiner — maqqef
// (U+05BE), minus (U+2212), or a hyphen/dash. That is the AI-aligner defect:
// two original-language words glued into one source token (e.g. AMO UST
// "אֶת־הַדָּבָר"). Such a master value must NOT be adopted onto a target — doing
// so would RE-GLUE a verse already reformed in D1 (or re-corrupt a split), which
// is exactly what undid the first Amos backfill. Excludes the zero-width joiners
// (U+2060/U+200D) that legitimately sit INSIDE one UHB word.
function contentSpansGlueJoiner(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? -1;
    if (cp === 0x05be || cp === 0x002d || (cp >= 0x2010 && cp <= 0x2015) || cp === 0x2212) return true;
  }
  return false;
}

export interface SourceAttrReconcileReport {
  // (key, attr) pairs whose target value was updated to match master.
  reconciled: Array<{ key: string; attr: string; from: string; to: string }>;
  // (key, attr) pairs where master diverges from the target but the master value
  // was AMBIGUOUS (>1 distinct value for that key) — left as-is, surfaced so the
  // residual potential clobber is visible rather than silent.
  divergent: Array<{ key: string; attr: string }>;
}

export function reconcileSourceAttrsFromMaster(
  targetVerseObjects: unknown[],
  masterVerseObjects: unknown[],
): SourceAttrReconcileReport {
  const report: SourceAttrReconcileReport = { reconciled: [], divergent: [] };
  if (!Array.isArray(targetVerseObjects) || !Array.isArray(masterVerseObjects)) return report;

  // master: key → attr → set of distinct values seen on master for that key.
  const masterByKey = new Map<string, Map<string, Set<string>>>();
  const collectMaster = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        const key = milestoneSourceKey(o);
        // Never offer a glue-joined master milestone's attrs as adoptable values:
        // its x-content is the AI defect, and adopting it would re-glue a verse
        // that D1 already reformed (see project_maqqef_glued_alignment_reform —
        // this is what reverted the first Amos backfill mid-export).
        const mContent = o["content"];
        const glued = typeof mContent === "string" && contentSpansGlueJoiner(mContent);
        if (key !== null && !glued) {
          let attrs = masterByKey.get(key);
          if (!attrs) masterByKey.set(key, (attrs = new Map()));
          for (const a of SOURCE_OWNED_MILESTONE_ATTRS) {
            const val = o[a];
            if (typeof val !== "string") continue;
            let set = attrs.get(a);
            if (!set) attrs.set(a, (set = new Set()));
            set.add(val);
          }
        }
      }
      if (Array.isArray(o["children"])) collectMaster(o["children"] as unknown[]);
    }
  };
  collectMaster(masterVerseObjects);

  // Count how many TARGET milestones share each source key. >1 means the target
  // is ambiguous for that key — a symptom of upstream strong-shift, e.g. AMO 3:1
  // where the reform's הדבר and a pre-existing mislabeled הזה both key
  // d:H1697|1|1. Master's single value can't be safely assigned to one of them,
  // so we adopt NOTHING for that key (never guess) — without this, the reconcile
  // clobbers a reformed split back onto the wrong word and re-corrupts the verse.
  const targetKeyCount = new Map<string, number>();
  const countTargetKeys = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        const key = milestoneSourceKey(o);
        if (key !== null) targetKeyCount.set(key, (targetKeyCount.get(key) ?? 0) + 1);
      }
      if (Array.isArray(o["children"])) countTargetKeys(o["children"] as unknown[]);
    }
  };
  countTargetKeys(targetVerseObjects);

  const applyTarget = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "milestone" && o["tag"] === "zaln") {
        const key = milestoneSourceKey(o);
        const attrs = key !== null ? masterByKey.get(key) : undefined;
        const targetAmbiguous = key !== null && (targetKeyCount.get(key) ?? 0) > 1;
        if (key !== null && attrs) {
          for (const a of SOURCE_OWNED_MILESTONE_ATTRS) {
            const set = attrs.get(a);
            if (!set || set.size === 0) continue;
            const cur = typeof o[a] === "string" ? (o[a] as string) : "";
            if (targetAmbiguous || set.size > 1) {
              // Ambiguous on the TARGET (duplicate source key) or on MASTER (>1
              // distinct value) — never guess. Flag only when the target value
              // actually disagrees with master, so the residual is visible.
              if (!set.has(cur)) report.divergent.push({ key, attr: a });
              continue;
            }
            const only = [...set][0];
            if (only !== cur) {
              report.reconciled.push({ key, attr: a, from: cur, to: only });
              o[a] = only;
            }
          }
        }
      }
      if (Array.isArray(o["children"])) applyTarget(o["children"] as unknown[]);
    }
  };
  applyTarget(targetVerseObjects);
  return report;
}

// Split AI-glued `\w` tokens and drop their fragments to unaligned. No-op when
// nothing is glued — clean verses (and Hebrew / Greek source text, which has
// no Latin boundary punctuation) pass through untouched, no occurrence churn.
export function splitGluedAlignmentWords(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const { result, didSplit } = markGluedSplits(verseObjects);
  if (!didSplit) return verseObjects;
  const lifted = stripLiftedMarkers(liftEditedOutOfZaln(result));
  // Clone before the in-place occurrence renumber so we never mutate caller
  // state (cloneVerseObjects pattern from web/src/lib/replace.ts).
  return recomputeTargetOccurrences(JSON.parse(JSON.stringify(lifted)) as unknown[]);
}

// ─── Strip AI-mangled orphan alignment end-markers ("-e" junk) ───────────────
//
// The AI aligner has emitted EXCESS `\zaln-e\*` end-milestones (more closes than
// opens) and bare "-e" fragments — the mangled tail of a `\zaln-e\*` it failed to
// write cleanly. Seen in MIC 6:10 UST master:
//   \w others\w*\zaln-e\* -e -e -e -e -e -e -e -e?
// usfm-js parks these as two junk shapes, NEITHER of which is ever legitimate:
//   (a) a NODE whose own `tag` IS the end-marker — `{tag:"zaln-e\\*", content:"-e "}`.
//       A real alignment is `{tag:"zaln", type:"milestone", …, endTag:"zaln-e\\*"}`;
//       the close only ever lives in `endTag`, never as a node `tag`, so any node
//       tagged `zaln-e…` is orphan junk. Dropped (its leaked `content` is "-e"
//       garbage; any non-junk remainder is kept as a text node, just in case).
//   (b) a TEXT node carrying standalone "-e" tokens — `"-e -e -e?…"`. It can also
//       hold legitimate trailing punctuation (the verse's "?"), so we strip the
//       tokens IN PLACE rather than dropping the node.
//
// We only ever touch bare `type:"text"` separator nodes and orphan-tagged nodes —
// never `\w` words (type:"word") — so real translated text is never altered; an
// un-`\zaln-s` clause just falls through as unaligned `\w` for the editor to
// re-align. No-op (identity) on clean verses, the common case, so no churn.
// Mirrors splitGluedAlignmentWords / dropDoubledLeadingMarkers: absorb the AI
// defect at import so the nightly reimport of a still-corrupt master can't
// re-inject it and a fresh AI apply lands clean.

// Remove standalone "-e" tokens (bounded left by start/whitespace, right by
// whitespace / closing punctuation / end) and tidy the whitespace they leave.
// The boundaries keep real words safe: "re-entry" (no boundary before "-e") and
// any "-e" mid-word never match.
function stripDashETokens(s: string): string {
  return s
    .replace(/(?:^|(?<=\s))-e(?=\s|[.,?!;:”’")\]]|$)/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/ +([.,?!;:?])/g, "$1");
}

export function stripOrphanAlignmentMarkers(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const clean = (nodes: unknown[]): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    for (const node of nodes) {
      const o = node as Record<string, unknown> | null;
      // (a) orphan end-milestone node — never legitimate.
      if (o && typeof o["tag"] === "string" && (o["tag"] as string).startsWith("zaln-e")) {
        changed = true;
        const leaked = typeof o["content"] === "string" ? stripDashETokens(o["content"] as string) : "";
        if (leaked.trim() !== "") out.push({ type: "text", text: leaked });
        continue;
      }
      // (b) bare text node carrying "-e" junk — strip in place, keep punctuation.
      if (o && o["type"] === "text" && typeof o["text"] === "string") {
        const stripped = stripDashETokens(o["text"] as string);
        if (stripped !== o["text"]) {
          changed = true;
          if (stripped !== "") out.push({ ...o, text: stripped });
          continue;
        }
      }
      // Recurse into children (milestone wrappers) — junk could nest if the AI
      // mangled a close mid-milestone.
      if (o && Array.isArray(o["children"])) {
        const kids = clean(o["children"] as unknown[]);
        if (kids !== o["children"]) {
          changed = true;
          out.push({ ...o, children: kids });
          continue;
        }
      }
      out.push(node);
    }
    return changed ? out : nodes;
  };
  return clean(verseObjects);
}

// ─── Collapse a doubled source token in one alignment compound ───────────────
//
// A DISTINCT AI/edit defect: a single `\zaln-s` compound whose nested chain wraps
// the SAME source token twice — two milestones with identical (NFC x-content,
// x-occurrence). A card can never legitimately reference one UHB/UGNT word twice,
// so the pair is an artifact that renders the Hebrew doubled (JER 31:33 UST/ULT
// `אֶת אֶת בֵּית`: a spurious outer `H0853 "אֶת"` over the real `H0854 "אֶת" › H1004b`).
// When a milestone has, anywhere in its own subtree, a nested milestone with the
// same key, DROP THE OUTER one (splice its children up a level) — the surviving
// inner milestone is the more specific one (correct strong for the known shape).
//
// Keyed on x-content+x-occurrence, NOT x-strong: the spurious outer often carries
// a wrong strong but the same surface, so a strong-inclusive key would miss it.
// Genuine Hebrew repetition (שָׁלוֹם שָׁלוֹם) is untouched — those tokens carry
// distinct x-occurrence → distinct keys. No-op (identity) on clean verses.
// Mirrors the web reform (web/src/lib/alignment.ts dropDuplicateSourceMilestones);
// absorb the defect at AI import so it never lands in D1, matching the
// splitGluedAlignmentWords / stripOrphanAlignmentMarkers family.
function zalnDedupKey(node: Record<string, unknown>): string | null {
  const content = node["content"];
  if (typeof content !== "string" || content === "") return null;
  return `${content.normalize("NFC")}|${String(node["occurrence"] ?? "1")}`;
}
function isZalnNode(n: Record<string, unknown> | null): boolean {
  return !!n && n["type"] === "milestone" && n["tag"] === "zaln";
}
function subtreeHasZalnKey(nodes: unknown[], key: string): boolean {
  for (const n of nodes ?? []) {
    const o = n as Record<string, unknown> | null;
    if (!o || typeof o !== "object") continue;
    if (isZalnNode(o) && zalnDedupKey(o) === key) return true;
    if (Array.isArray(o["children"]) && subtreeHasZalnKey(o["children"] as unknown[], key)) return true;
  }
  return false;
}
export function dropDuplicateSourceMilestones(verseObjects: unknown[]): unknown[] {
  if (!Array.isArray(verseObjects)) return verseObjects;
  const transform = (nodes: unknown[]): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (o && isZalnNode(o)) {
        const origKids = (o["children"] as unknown[] | undefined) ?? [];
        const kids = transform(origKids);
        const key = zalnDedupKey(o);
        if (key !== null && subtreeHasZalnKey(kids, key)) {
          out.push(...kids); // outer duplicate — unwrap, keep the inner subtree
          changed = true;
          continue;
        }
        if (kids !== origKids) { out.push({ ...o, children: kids }); changed = true; }
        else out.push(node);
        continue;
      }
      if (o && Array.isArray(o["children"])) {
        const kids = transform(o["children"] as unknown[]);
        if (kids !== o["children"]) { out.push({ ...o, children: kids }); changed = true; }
        else out.push(node);
        continue;
      }
      out.push(node);
    }
    return changed ? out : nodes;
  };
  return transform(verseObjects);
}

// ─── Collapse doubled leading poetry / paragraph markers ─────────────────────
//
// unfoldingWord ULT/UST USFM puts a verse's leading in-flow marker BEFORE its
// `\v` (`\q1 \v 17 \zaln-s …`), so usfm-js parks that marker as a TRAILING node
// on the PREVIOUS verse. When the AI emits a DOUBLED marker — `\q1 \v 17 \q1 …`
// — the importer faithfully splits it into a trailing `\q1` on verse 16 PLUS a
// LEADING `\q1` stored as the first node of verse 17; on export both re-emit
// (`\q1 \v 17 \q1` again) and a uW checker has to hand-remove the extra. The
// interactive editor never creates these (drifted markers render as read-only
// bands and never enter the saved text) — the defect is purely AI-output
// faithfully imported, so we absorb it here, mirroring splitGluedAlignmentWords.
//
// Mirror of isInFlowMarker in web/src/lib/usfm.ts — keep in sync. usfm-js stores
// poetry markers (\q1, \q2, \qa, …) as {type:"quote", tag} and plain-paragraph
// markers (\p, \m, \nb, \b, …) as {type:"paragraph", tag}. A `\ts\*` chunk
// milestone counts too, in every node shape usfm-js has produced for it
// (isTsMilestone): 3.5.0 emits {tag:"ts\\*"}, which a legacy-only check missed.
function isInFlowMarker(node: unknown): boolean {
  const o = node as Record<string, unknown> | null;
  if (!o) return false;
  const t = o["type"];
  if ((t === "paragraph" || t === "quote") && typeof o["tag"] === "string") return true;
  if (isTsMilestone(o)) return true;
  return false;
}

function markerTag(node: unknown): unknown {
  return (node as Record<string, unknown> | null)?.["tag"];
}

// Normalised text fused onto a marker node, for the heading-vs-body test below.
function markerText(node: unknown): string {
  const t = (node as Record<string, unknown> | null)?.["text"];
  return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
}

// The run of in-flow markers at the END of a verse's objects, in document order
// (oldest-first). Skips trailing whitespace-only text so an empty `\n` node
// between the last word and the marker doesn't hide it. Mirror of
// extractTrailingMarkers in web/src/lib/usfm.ts.
function trailingMarkerRun(verseObjects: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = verseObjects.length - 1; i >= 0; i--) {
    const node = verseObjects[i];
    if (isInFlowMarker(node)) {
      out.unshift(node);
      continue;
    }
    const o = node as Record<string, unknown> | null;
    const txt = typeof o?.["text"] === "string" ? (o["text"] as string) : null;
    if (txt !== null && /^[\s​]*$/.test(txt)) continue;
    break;
  }
  return out;
}

// Drop the leading in-flow marker(s) of verse N when they duplicate the trailing
// marker run of verse N-1 — the `\qX(trailing N-1) + \qX(leading N)` doubling.
// `prev` is the (already-normalised) verseObjects of the immediately preceding
// verse in the SAME chapter, or null for the first verse / chapter-front, which
// never de-dup: their leading marker may be the only legitimate copy (chapter
// fronts open with a real `\p` / `\q1`). Returns `curr` unchanged (identity)
// when nothing matches; otherwise a trimmed copy. Neither input is mutated.
//
// A verse can stack several leading markers (`\qa LETTER` + `\q1`); we de-dup
// each that lines up, in order, against the tail of N-1's trailing run.
//
// usfm-js fuses text that follows a marker on the same line onto the marker
// node's `text`. When we drop a leading marker we KEEP that text as a plain text
// node if it is verse body (the AI bare-text shape `\q1 \v 17 \q1 In the
// beginning`), and DROP it only when it just repeats the matching trailing
// marker's own text (the acrostic letter on `\qa ALEPH`, which already rides on
// verse N-1) — so the letter is never doubled into the verse body.
export function dropDoubledLeadingMarkers(prev: unknown[] | null, curr: unknown[]): unknown[] {
  if (!prev || !Array.isArray(curr) || curr.length === 0) return curr;
  const trailing = trailingMarkerRun(prev);
  if (trailing.length === 0) return curr;
  let leadCount = 0;
  while (leadCount < curr.length && isInFlowMarker(curr[leadCount])) leadCount++;
  if (leadCount === 0) return curr;
  // Largest k where the last k trailing tags equal curr's first k leading tags —
  // the verbatim doubled run. Search from the longest candidate down so the
  // maximal de-dup wins; a leading marker that doesn't line up is left alone.
  let k = 0;
  for (let cand = Math.min(trailing.length, leadCount); cand >= 1; cand--) {
    let match = true;
    for (let i = 0; i < cand; i++) {
      if (markerTag(trailing[trailing.length - cand + i]) !== markerTag(curr[i])) {
        match = false;
        break;
      }
    }
    if (match) {
      k = cand;
      break;
    }
  }
  if (k === 0) return curr;
  const out: unknown[] = [];
  for (let i = 0; i < k; i++) {
    const lead = curr[i] as Record<string, unknown>;
    const text = typeof lead["text"] === "string" ? (lead["text"] as string) : "";
    const trail = trailing[trailing.length - k + i];
    if (text !== "" && markerText(lead) !== markerText(trail)) {
      out.push({ type: "text", text });
    }
  }
  for (let i = k; i < curr.length; i++) out.push(curr[i]);
  return out;
}

// Walk verse-objects and concatenate all text. Same shape and behaviour
// as the client-side `extractPlainText` in web/src/lib/usfm.ts — kept
// duplicated because the Worker bundle and the web bundle are built
// separately and cross-package imports are non-trivial. Any change
// here must be mirrored there.
//   { type: 'text', text: '...' }
//   { type: 'word', text: '...', occurrence, ... }
//   { type: 'milestone', tag: 'zaln-s', children: [...] }
//   { type: 'paragraph', tag: 'p' }
//
// Exported so pipelineImport.ts's applyVerseUpdate can RE-derive plain_text
// from the FINAL, self-healed verseObjects tree (after curlifyVerseObjects
// and the other AI-ingest heals run) instead of trusting the AI-supplied
// payload.plain_text verbatim — a mutation pass that rewrites `.text` (or
// drops/rewrites a node) makes any UN-recomputed plain_text stale, which
// breaks FindReplaceOverlay / source search (both match on plain_text) and,
// worse, makes the next nightly bookReimport compare master's freshly-
// extracted text against this stale value, see a false diff, and spuriously
// re-seed the verse (resetting updated_by) every night.
export function extractPlainText(verseObj: unknown): string {
  const parts: string[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos || []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as { text?: unknown; children?: unknown[]; tag?: unknown };
      // In-flow line markers are word separators — mirror of extractPlainText in
      // web/src/lib/usfm.ts (keep in sync). A no-op for clean imported USFM (a
      // marker is always followed by whitespace there), but guards against fusing
      // words across a marker that abuts them with no whitespace node. `\qs`
      // (Selah) is a content wrapper, not a break — recurse it normally.
      if (isInFlowMarker(vo) && v.tag !== "qs") {
        parts.push(" ");
        if (typeof v.text === "string") parts.push(v.text);
        continue;
      }
      if (typeof v.text === "string") parts.push(v.text);
      if (Array.isArray(v.children)) walk(v.children);
    }
  };
  const top = verseObj as { verseObjects?: unknown[] };
  walk(top.verseObjects ?? []);
  return parts.join("").replace(/\s+/g, " ").trim();
}

// Whole-book USFM headers (\id, \h, \toc*, \mt1, …) as the usfm-js
// `headers` array. Stashed in book_usfm_meta so the nightly export can
// emit them verbatim instead of synthesizing a minimum set.
export function extractUsfmHeaders(rawUsfm: string): unknown[] | null {
  const json = usfm.toJSON(rawUsfm);
  return Array.isArray(json.headers) && json.headers.length > 0 ? json.headers : null;
}

// Extract every verse in [startChapter, endChapter] from a whole-book USFM
// blob. Verse keys can be numeric ("3"), hyphenated ranges ("12-13" — kept
// as a single row with verse=12, verseEnd=13 so export round-trips `\v 12-13`),
// or the "front" pseudo-verse (where usfm-js puts a chapter-level `\d` Psalm
// title — stored as verse 0). Book-level `intro` keys are still skipped.
// Defense-in-depth for the "no space after a \q marker" hazard. usfm-js reads a
// marker tag greedily as `[a-z0-9]+`, so a NUMBERED line/poetry marker glued to
// a following letter — `\q2because` (no space, e.g. AI- or legacy-tool-authored
// USFM) — parses to a garbage marker `{tag:"q2because", content:"…"}`: the word
// is swallowed into the tag, destroying both the word and the line break. Insert
// the missing space BEFORE parsing so the marker and word survive.
//
// Scoped to markers whose valid form ENDS IN A DIGIT (`\q1`–`\q4`, `\qm1`–`\qm3`,
// `\pi1`–`\pi3`): a letter immediately after the digit is unambiguously invalid,
// so a space is always the right repair. Bare `\q`/`\p`/`\m`/`\qm` + letter is
// deliberately left alone — it can't be told apart from a longer valid marker
// (`\qa`, `\qac`, `\qm`, `\pi`, `\pc`, `\mi`, …) by a regex. Identity no-op on
// clean USFM (every real numbered marker is followed by a space, `\`, or `*`).
const GLUED_NUMBERED_MARKER_RE = /(\\(?:q[1-4]|qm[1-3]|pi[1-3]))(?=[A-Za-z])/g;
export function sanitizeMarkerSpacing(rawUsfm: string): string {
  return rawUsfm.replace(GLUED_NUMBERED_MARKER_RE, "$1 ");
}

// Companion pre-parse repair for a STRAY BACKSLASH inside a `\w` attribute
// section. USFM 3 attributes are plain `key="value"` pairs — a backslash is
// never legal between the `|` and the closing `\w*`. Master carries instances
// of the invalid shape (en_ust/24-JER.usfm, JER 30:3 / 30:10 / 31:7 / 31:10):
//
//   \w Judah.”|\x-occurrence="1" x-occurrences="1"\w*
//                ^ spurious backslash
//
// usfm-js reads that `\x` as a MARKER OPENER, so the whole attribute section
// parses out of the word into a junk sibling node
// `{tag:"x", content:"-occurrence=\"1\" x-occurrences=\"1\""}` and the word
// itself loses its occurrence attributes. Rendering that tree back out (the
// nightly export) emits the junk node as a REAL cross-reference —
// `\w Judah|x-occurrence="1" x-occurrences="1"\w*.”\x -occurrence="1" x-occurrences="1"\x*`
// — which is how four invalid `\x` markers were written to en_ust master by
// the 2026-06-18 and 2026-06-25 exports (issue #481). Nothing renders from
// them, so they accumulate silently.
//
// Repair before parsing, so the attributes land on the word where they belong
// and no junk node is ever created. Same principle as the malformed-alignment
// normalizers above: a malformed input is normalized on ingest, never
// re-emitted in a new malformed shape.
//
// The match is bounded on both ends by the word's own markers (`\w ` … `\w*`)
// and cannot cross a neighbouring word marker or a line break, so a legitimate
// `\w`, `\zaln-s`, `\f` or `\x` outside the attribute section is unreachable.
// Identity no-op on clean USFM (a valid attribute section holds no backslash).
const WORD_ATTR_SECTION_RE = /(\\w [^\\|\n]*\|)((?:[^\\\n]|\\(?!w[ *]))*)(\\w\*)/g;
export function sanitizeWordAttributes(rawUsfm: string): string {
  return rawUsfm.replace(WORD_ATTR_SECTION_RE, (whole, open: string, attrs: string, close: string) =>
    attrs.includes("\\") ? `${open}${attrs.replace(/\\/g, "")}${close}` : whole,
  );
}

export function extractVersesForRange(
  rawUsfm: string,
  startChapter: number,
  endChapter: number,
): VerseExtract[] {
  const json = usfm.toJSON(sanitizeWordAttributes(sanitizeMarkerSpacing(rawUsfm)));
  const out: VerseExtract[] = [];
  const chapters = json.chapters ?? {};
  for (const chapterKey of Object.keys(chapters)) {
    const chNum = parseInt(chapterKey, 10);
    if (!Number.isFinite(chNum)) continue;
    if (chNum < startChapter || chNum > endChapter) continue;
    const chapterObj = chapters[chapterKey] as Record<string, unknown>;

    // Resolve verse keys to document order (chapter-front, then verses ascending)
    // before the cross-verse marker de-dup walks the chapter. JS object-key order
    // floats "front" and hyphenated ranges ("8-9") past the integer keys, which
    // would pair a verse with the wrong predecessor. Each row is keyed by
    // chapter+verse downstream, so the emit order itself is immaterial.
    const entries: Array<{ vNum: number; vEnd: number | null; verseObj: { verseObjects?: unknown[] } }> = [];
    for (const verseKey of Object.keys(chapterObj)) {
      let vNum: number;
      let vEnd: number | null = null;
      if (verseKey === "front") {
        // Chapter-front pseudo-verse — Psalm titles (\d), descriptive
        // titles, etc. Store as verse 0 so the chapter view's "intro"
        // row picks them up.
        vNum = 0;
      } else {
        const m = verseKey.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) continue;
        vNum = parseInt(m[1], 10);
        if (m[2]) {
          const end = parseInt(m[2], 10);
          // Inverted ranges (e.g. "9-8") are nonsense — collapse to singleton.
          vEnd = end > vNum ? end : null;
        }
      }
      if (!Number.isFinite(vNum)) continue;
      entries.push({ vNum, vEnd, verseObj: chapterObj[verseKey] as { verseObjects?: unknown[] } });
    }
    entries.sort((a, b) => a.vNum - b.vNum);

    // Trailing markers of verse N-1 are what verse N's leading copy duplicates.
    // Chapter-front (verse 0) never seeds this — its trailing markers legitimately
    // lead verse 1, whose copy we must keep — so it leaves prev null.
    let prevVerseObjects: unknown[] | null = null;
    for (const { vNum, vEnd, verseObj } of entries) {
      // Strip outer punctuation, de-glue any AI-introduced punctuation-spanning
      // `\w` (the freed words fall out to unaligned), then drop any leading marker
      // that merely doubles the previous verse's trailing one.
      let verseObjects = stripOrphanAlignmentMarkers(
        splitGluedAlignmentWords(normalizeWordPunctuation(verseObj.verseObjects ?? [])),
      );
      verseObjects = dropDoubledLeadingMarkers(prevVerseObjects, verseObjects);
      prevVerseObjects = vNum >= 1 ? verseObjects : null;
      const normalized = { ...verseObj, verseObjects };
      out.push({
        chapter: chNum,
        verse: vNum,
        verseEnd: vEnd,
        contentJson: JSON.stringify(normalized),
        plainText: extractPlainText(normalized),
      });
    }
  }
  return out;
}

// 'front:intro' -> [0, 0]
// '1:intro'     -> [1, 0]
// '1:1'         -> [1, 1]
// '1:1-3'       -> [1, 1] (range collapses to first verse for indexing)
export function refParts(refRaw: string | null | undefined): [number, number] {
  if (!refRaw) return [0, 0];
  const [ch, vs] = refRaw.split(":");
  const chNum = ch === "front" ? 0 : parseInt(ch, 10) || 0;
  const vsNum =
    !vs || vs === "intro" ? 0 : parseInt(vs.split("-")[0], 10) || 0;
  return [chNum, vsNum];
}

// Same-chapter verse numbers a tn/tq ref_raw covers. Server-side twin of
// web/src/lib/verseRange.ts `noteCoveredVerses` — keep the two in sync. Expands
// contiguous ranges ("1:2-3"), unions comma segments ("1:2,4"), always includes
// the leading verse, and skips intro/front/cross-chapter/malformed segments.
// The expansion is bounded (a malformed range can't blow up the loop). Used to
// reopen checkoff lanes on every verse a bridged note renders under, mirroring
// the display filter.
const COVERED_VERSES_CAP = 400;
export function coveredVersesFromRef(
  refRaw: string | null | undefined,
  leadingVerse: number,
): number[] {
  const covered = new Set<number>([leadingVerse]);
  if (refRaw) {
    const colon = refRaw.indexOf(":");
    const versePart = colon >= 0 ? refRaw.slice(colon + 1) : refRaw;
    for (const rawSeg of versePart.split(",")) {
      const seg = rawSeg.trim();
      if (!seg || seg.includes(":") || !/\d/.test(seg)) continue;
      const dash = seg.indexOf("-");
      if (dash < 0) {
        const n = parseInt(seg, 10);
        if (Number.isFinite(n)) covered.add(n);
        continue;
      }
      const a = parseInt(seg.slice(0, dash), 10);
      const b = parseInt(seg.slice(dash + 1), 10);
      if (!Number.isFinite(a)) continue;
      if (!Number.isFinite(b) || b < a) {
        covered.add(a);
        continue;
      }
      const end = Math.min(b, a + COVERED_VERSES_CAP);
      for (let v = a; v <= end; v++) covered.add(v);
    }
  }
  return [...covered].sort((x, y) => x - y);
}

// Allocator for the canonical sort_order scheme: a per-verse ordinal, where
// sort_order = (1-based position within a chapter:verse) * 100, assigned in
// DCS file order. Call the returned fn once per row in file order.
//
// Single source of truth shared by every write path — bookImport (bootstrap),
// bookReimport (merge reimport), and scripts/backfill-sortorder.mjs — so all
// agree. Because the editor's read/export sort is (chapter, verse, sort_order),
// only the within-verse order matters, so the ordinal resets per verse: an
// upstream insert renumbers just that verse (minimal churn), and an unchanged
// file reproduces identical values (a reimport is then a no-op). The AI
// pipeline (pipelineImport) uses the same per-verse stepping, seeded past any
// kept/edited survivors. Keep the *100 step in sync with pickSortOrder /
// reorderSequential in web Shell.tsx, which slot user edits between these.
export function makeVerseSortOrder(): (chapter: number, verse: number) => number {
  const counter = new Map<number, number>();
  return (chapter, verse) => {
    const key = chapter * 100000 + verse;
    const n = (counter.get(key) ?? 0) + 1;
    counter.set(key, n);
    return n * 100;
  };
}

// ─── Collapse double spaces in AI-generated TN note text ─────────────────────
//
// bp-assistant frequently emits TN notes with a DOUBLE space after sentence
// punctuation (".  Alternate translation:", "**understanding**,  could"). DCS
// maintainers normalize these to a single space on the en_tn master branch, so
// the verbatim double-space copy in D1 diverges from master and every nightly
// export pushes a whitespace-only change to the `-be-` branch — churn that has
// already produced a real merge conflict (ISA, 2026-06-18). We collapse it at AI
// ingest (pipelineImport tnPayload) so new notes match the normalized form.
//
// Conservative by construction — it touches ONLY interior runs of 2+ ASCII
// spaces flanked by non-space content. It must NOT disturb:
//   • the literal `\n` escape TN notes use for line breaks (split on it, rejoin),
//   • leading indentation (markdown list nesting / code) — preserved per line,
//   • trailing space (markdown hard break) — preserved per line,
//   • markdown table alignment — any line containing `|` is left verbatim.
// A no-op on notes without a double space (cheap `.includes("  ")` gate), so
// already-clean notes and the reimport-from-master path round-trip untouched.

// One logical line of a TN note (between literal `\n` escapes).
function collapseInteriorSpaces(line: string): string {
  if (line.includes("|")) return line; // markdown table row — padding is alignment
  const m = line.match(/^( *)(.*?)( *)$/);
  if (!m) return line;
  const [, lead, core, trail] = m;
  if (core === "") return line; // whitespace-only line — leave it untouched
  return lead + core.replace(/ {2,}/g, " ") + trail;
}

export function normalizeNoteWhitespace(note: string): string {
  if (typeof note !== "string" || !note.includes("  ")) return note;
  // TN line breaks are the literal two-char escape "\n" (backslash-n), never a
  // real newline (a TSV cell can't hold one) — split on it so each logical line
  // is evaluated for leading indentation / table rows independently, then rejoin
  // verbatim so the escape sequences are preserved.
  return note.split("\\n").map(collapseInteriorSpaces).join("\\n");
}

// Flag interior double spaces that may MASK a dropped word, for human review
// during the one-time cleanup. During the ISA pass, "**understanding**,  could
// express" turned out to be missing "you" ("**understanding**, you could
// express") — the double space sat where the word should have been. A double
// space after a sentence terminator (".  ", "?”  ", "!)  ") is the well-known
// benign typographic convention and is NOT flagged; anything else (comma,
// semicolon, colon, a word char, markdown emphasis) is suspicious. Reports
// context only — never auto-edits content. Mirrors normalizeNoteWhitespace's
// per-line / table handling so the two agree on what counts as an interior run.
const SUSPECT_RUN_RE = /(\S)( {2,})(?=\S)/g;
const BENIGN_BEFORE_RE = /[.?!][)\]"'”’»]*$/;

export function findSuspiciousDoubleSpaces(note: string): string[] {
  if (typeof note !== "string" || !note.includes("  ")) return [];
  const out: string[] = [];
  for (const line of note.split("\\n")) {
    if (line.includes("|")) continue;
    const re = new RegExp(SUSPECT_RUN_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const before = line.slice(0, m.index + 1); // through the char before the run
      if (BENIGN_BEFORE_RE.test(before)) continue;
      const start = Math.max(0, m.index - 25);
      const end = Math.min(line.length, m.index + m[0].length + 25);
      out.push((start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : ""));
    }
  }
  return out;
}

export interface ParsedTsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

// Naive split-by-tab parser matching scripts/import-book.mjs. The
// unfoldingWord TSVs don't quote tabs inside cells, so this is sufficient.
export function parseTsv(raw: string): ParsedTsv {
  // Strip a leading UTF-8 BOM (﻿). Without this, the first header becomes
  // "﻿Reference"/"﻿ID", so every row lookup by the real header name
  // (e.g. r["ID"]) is undefined and the entire import is silently skipped.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = cells[i] ?? "";
    });
    return o;
  });
  return { headers, rows };
}
