// Per-token highlight rendering for the flows scripture lanes.
//
// The flows notes/questions screens show a read-only ULT/UST lane with the
// active note's quote highlighted. They used to do that by flattening the
// matched target words into ONE space-joined string (extractTargetSelectionText)
// and running `plain_text.indexOf(selection)` — a contiguous-substring search.
// That is wrong in four ways (issue #323): a quote whose target words scatter
// (routine — the GL freely permutes and interleaves source words) highlights
// NOTHING; `occurrence > 1` highlights the FIRST substring hit; `occurrence: -1`
// highlights one instance instead of all; and a repeated word deduped out of the
// joined string never matched at all.
//
// This module does what the classic surfaces do (ScriptureColumn via
// renderHighlightedHTML): mark PER TOKEN, keyed on `text|occurrence` from
// findTargetHighlights. Instead of emitting HTML it returns plain segments so
// the React lane can map them to <mark> elements with its own sx styling and
// leave direction handling (`dir="auto"`) untouched.
//
// The text itself is rendered from the verse tree, NOT from `plain_text` —
// that's the only way to know which characters belong to which `\w` token. The
// tree walk is a deliberate mirror of `extractPlainText` in lib/usfm.ts (same
// node rules, same in-flow-marker separator, same whitespace collapse and trim),
// so the concatenated segments reproduce `plain_text` character for character.
// Any change to extractPlainText must be mirrored here — the flowHighlight test
// suite pins the equality against a real aligned verse.

import { findTargetHighlights, type HighlightKey } from "./highlight.ts";
import { isCharacterWrapper, isInFlowMarker } from "./usfm.ts";
import { verseBoundaryText } from "./verseRange.ts";

// A run of lane text.
export interface FlowTextSegment {
  kind: "text";
  text: string;
  // True for the runs that belong to the active quote — the lane wraps these
  // in <mark>. Whitespace BETWEEN two marked words is marked too, so a
  // contiguous phrase renders as one continuous highlight instead of a row of
  // separately-padded word chips.
  marked: boolean;
}

// The boundary between two verses in a multi-verse lane (#351/#387). It is
// styled, non-content UI chrome — a superscript verse number — NOT scripture:
// emitting it as a plain text run rendered the literal `¦<n>` in the Latin
// scripture stack inside RTL text and a screen reader announced it as part of
// the verse. `text` keeps the plain-text form (`verseBoundaryText`) so the
// concatenated segment stream still reproduces the joined plain text (and so any
// string-only fallback consumer degrades sensibly); the styled consumers switch
// on `kind` and render chrome from `verse` instead.
export interface FlowVerseMarkerSegment {
  kind: "verseMarker";
  verse: number;
  text: string;
  marked: false;
}

export type FlowSegment = FlowTextSegment | FlowVerseMarkerSegment;

type Part = { text: string; marked: boolean };

function isWordNode(v: Record<string, unknown>): boolean {
  return v["type"] === "word" && v["tag"] === "w";
}

// Walk the verse tree in document order, mirroring extractPlainText (lib/usfm.ts)
// node-for-node, and tag each `\w` token's text with whether its
// `text|occurrence` key is in the highlight set. Everything else (text nodes,
// marker-parked punctuation, character wrappers) contributes unmarked text.
function collectParts(verseObjects: unknown[], highlights: Set<HighlightKey>): Part[] {
  const parts: Part[] = [];
  const walk = (vos: unknown[]): void => {
    for (const vo of vos ?? []) {
      if (!vo || typeof vo !== "object") continue;
      const v = vo as Record<string, unknown>;
      // An in-flow line marker (\p, \q1, …) is a word separator that carries no
      // content of its own, but usfm-js can park leading punctuation on it.
      // Same treatment as extractPlainText: emit a space, then the parked text.
      if (isInFlowMarker(vo) && !isCharacterWrapper(vo)) {
        parts.push({ text: " ", marked: false });
        if (typeof v["text"] === "string") parts.push({ text: v["text"], marked: false });
        continue;
      }
      if (typeof v["text"] === "string") {
        let marked = false;
        if (isWordNode(v)) {
          const occ = parseInt(String(v["occurrence"] ?? "1"), 10) || 1;
          marked = highlights.has(`${v["text"]}|${occ}`);
        }
        parts.push({ text: v["text"], marked });
      }
      if (Array.isArray(v["children"])) walk(v["children"] as unknown[]);
    }
  };
  walk(verseObjects);
  return parts;
}

// Apply extractPlainText's tail normalization — `.replace(/\s+/g, " ").trim()` —
// to the tagged char stream, then group equal-flag runs into segments. Doing it
// per character is what keeps the marked/unmarked boundaries correct across a
// collapse (a "\n" inside a text node, or the space an in-flow marker emits).
function toSegments(parts: Part[]): FlowSegment[] {
  const chars: string[] = [];
  const flags: boolean[] = [];
  for (const part of parts) {
    for (const ch of part.text) {
      if (/\s/.test(ch)) {
        // Collapse a whitespace run to a single space (never marked — a mark
        // that starts or ends on whitespace shows as stray padding).
        if (chars.length > 0 && chars[chars.length - 1] === " ") continue;
        chars.push(" ");
        flags.push(false);
      } else {
        chars.push(ch);
        flags.push(part.marked);
      }
    }
  }

  let start = 0;
  let end = chars.length;
  while (start < end && chars[start] === " ") start++;
  while (end > start && chars[end - 1] === " ") end--;

  // Re-mark the single space between two marked words so a contiguous phrase is
  // ONE <mark>. Runs are already collapsed to one space, so a neighbour test is
  // enough. Punctuation between marked words stays unmarked — it belongs to no
  // token, matching how the classic per-token renderer paints it.
  for (let i = start + 1; i < end - 1; i++) {
    if (chars[i] === " " && flags[i - 1] && flags[i + 1]) flags[i] = true;
  }

  const out: FlowTextSegment[] = [];
  for (let i = start; i < end; i++) {
    const last = out[out.length - 1];
    if (last && last.marked === flags[i]) last.text += chars[i];
    else out.push({ kind: "text", text: chars[i], marked: flags[i] });
  }
  return out;
}

// Segments for one scripture lane. `plainText` is the stored `plain_text` used
// as the unhighlighted fallback: no quote, no alignment tree, or a quote that
// doesn't resolve in this lane all render exactly what the lane rendered before
// this module existed. `sourceVerseObjects` is the OL (UHB/UGNT) verse — pass it
// whenever it's loaded so findTargetHighlights can OL-anchor the match; without
// it the highlighter degrades to GL-only matching (see highlight.ts).
export function flowLaneSegments(
  verseObjects: unknown[] | null | undefined,
  plainText: string | null | undefined,
  quote: string | null | undefined,
  occurrence: number | null | undefined,
  sourceVerseObjects?: unknown[] | null,
): FlowSegment[] {
  const fallback: FlowSegment[] = plainText ? [{ kind: "text", text: plainText, marked: false }] : [];
  if (!quote || !Array.isArray(verseObjects) || verseObjects.length === 0) return fallback;
  const highlights = findTargetHighlights(
    verseObjects,
    quote,
    occurrence ?? 1,
    Array.isArray(sourceVerseObjects) ? sourceVerseObjects : undefined,
  );
  if (highlights.size === 0) return fallback;
  const segments = toSegments(collectParts(verseObjects, highlights));
  // A highlight set that resolves to no rendered token (the keys came from a
  // subtree the plain-text walk doesn't reach) must not silently blank the lane.
  if (segments.length === 0 || !segments.some((s) => s.marked)) return fallback;
  return segments;
}

// One verse's slice of a lane: its tree, its stored plain text, and the OL verse
// to anchor against. Structurally what `coveredLaneSlices` (lib/verseRange)
// returns. `verse` is the verse this slice's text begins at — it labels the
// boundary marker between slices.
export interface FlowLaneSlice {
  verse: number;
  verseObjects: unknown[] | null | undefined;
  plainText: string | null | undefined;
  sourceVerseObjects?: unknown[] | null;
}

// Segments for a lane that spans several verses — a note whose `ref_raw` bridges
// verses (issue #341). Each verse is highlighted SEPARATELY and the segments are
// joined by an unmarked verse-boundary marker (`verseBoundaryText`): a bare
// space let a discontinuous ref like "13:26,28" read as one sentence with verse
// 27 silently elided (#351).
//
// Highlighting one concatenated tree instead is wrong: a highlight key is
// `${text}|${occurrence}` and occurrence numbers are counted per verse, so two
// distinct tokens that share a surface form across the verse boundary land under
// one key and BOTH get marked (#344 review — the per-token precision guarantee
// of #323 silently stopped holding across a combined span).
//
// Named trade-off: a quote whose OL occurrence numbering straddles the boundary
// (occurrence 2 whose first instance sits in the earlier verse) now resolves per
// verse, since each verse's tree carries only its own occurrence counts.
//
// A single slice takes the plain `flowLaneSegments` path unchanged, so the common
// singleton note is byte-identical.
export function flowLaneSegmentsAcross(
  slices: readonly FlowLaneSlice[],
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): FlowSegment[] {
  if (slices.length === 0) return [];
  if (slices.length === 1) {
    const only = slices[0];
    return flowLaneSegments(
      only.verseObjects,
      only.plainText,
      quote,
      occurrence,
      only.sourceVerseObjects,
    );
  }
  const out: FlowSegment[] = [];
  for (const slice of slices) {
    const segments = flowLaneSegments(
      slice.verseObjects,
      slice.plainText,
      quote,
      occurrence,
      slice.sourceVerseObjects,
    );
    if (segments.length === 0) continue;
    if (out.length > 0)
      out.push({
        kind: "verseMarker",
        verse: slice.verse,
        text: verseBoundaryText(slice.verse),
        marked: false,
      });
    out.push(...segments);
  }
  return out;
}

// One note's quote, as a lane marks it.
export interface FlowQuote {
  quote: string | null | undefined;
  occurrence: number | null | undefined;
}

// Segments for a lane with SEVERAL quotes marked at once. Rapid check's
// type-filter mode draws each verse group's lanes once, with the quote of
// every listed note in that verse marked (mockup board C, design PR #825).
// Each quote resolves on its own through findTargetHighlights; the token sets
// are unioned, so two quotes that share a token mark it once. Per verse like
// flowLaneSegmentsAcross (occurrence numbers are per verse), with the same
// fallbacks: no quote that resolves leaves the slice as its plain text.
// flowLaneSegments / flowLaneSegmentsAcross are left as they are.
export function flowLaneSegmentsForQuotes(
  slices: readonly FlowLaneSlice[],
  quotes: readonly FlowQuote[],
): FlowSegment[] {
  const out: FlowSegment[] = [];
  for (const slice of slices) {
    const fallback: FlowSegment[] = slice.plainText
      ? [{ kind: "text", text: slice.plainText, marked: false }]
      : [];
    let segments = fallback;
    const vos = slice.verseObjects;
    if (Array.isArray(vos) && vos.length > 0) {
      const union = new Set<HighlightKey>();
      for (const q of quotes) {
        if (!q.quote) continue;
        const keys = findTargetHighlights(
          vos,
          q.quote,
          q.occurrence ?? 1,
          Array.isArray(slice.sourceVerseObjects) ? slice.sourceVerseObjects : undefined,
        );
        for (const k of keys) union.add(k);
      }
      if (union.size > 0) {
        const marked = toSegments(collectParts(vos, union));
        if (marked.length > 0 && marked.some((s) => s.marked)) segments = marked;
      }
    }
    if (segments.length === 0) continue;
    if (out.length > 0)
      out.push({
        kind: "verseMarker",
        verse: slice.verse,
        text: verseBoundaryText(slice.verse),
        marked: false,
      });
    out.push(...segments);
  }
  return out;
}
