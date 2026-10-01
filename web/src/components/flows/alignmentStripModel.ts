// Read-only ULT alignment strip for the flows notes screen (issue #431).
//
// A translator with little Greek/Hebrew reads a note whose quote is in the
// original language. With the English ULT lane on (#430) she still cannot see
// WHICH English words render WHICH original words. The published en_ult USFM
// already carries the `\zaln-s` milestones, and the chapter payload already
// carries the UHB/UGNT verse, so this module only JOINS the two with the verse
// fidelity overview's model (VerseSpineModel: collectOriginalWords + buildLane)
// and answers "what lights up when this word is focused?".
//
// Pure derivation, no React, so the node test runner can pin it against the
// real ZEC fixtures. Nothing here writes: the strip is display-only.

import { findTargetHighlights } from "../../lib/highlight.ts";
import {
  anchorPositions,
  buildLane,
  collectOriginalWords,
  type LaneModel,
  type OriginalWord,
} from "./VerseSpineModel.ts";

/** One verse of the lane, as coveredLaneSlices produces it. */
export interface StripSliceInput {
  verse: number;
  /** The lane row's `verse_end` — set (> verse) when the ULT row is a bridge. */
  verseEnd?: number | null;
  verseObjects: unknown[] | null | undefined;
  sourceVerseObjects?: unknown[] | null;
}

export interface AlignmentStripSlice {
  verse: number;
  /** Original-language words in document order (position = index). */
  words: OriginalWord[];
  /** The English lane joined onto `words`. Group ids are local to this slice. */
  lane: LaneModel;
  /** Original words at least one English group renders; the rest render muted. */
  alignedPositions: Set<number>;
  /** Original words inside the note's quote. */
  quotedPositions: Set<number>;
  /** English word ids the note's quote maps to (the #430 lane's <mark>). */
  quotedWordIds: Set<string>;
}

/**
 * Build one strip slice per covered verse. A bridged note (#341) gets one
 * slice per verse because occurrence numbers and alignment groups are per
 * verse; the caller separates the slices with verse markers.
 *
 * Returns null — "show the plain lane instead" — when any ULT row is a USFM
 * verse bridge (`\v 6-9`). The lane then hands over the whole bridge as the
 * target but only the covered UHB/UGNT verses as the source, and the bridge's
 * `x-occurrence` numbering does not line up with a per-verse source walk, so
 * milestones from another verse would resolve onto the wrong original word.
 * Lighting nothing is honest; lighting the wrong word is not.
 */
export function buildAlignmentStrip(
  slices: readonly StripSliceInput[],
  quote: string | null | undefined,
  occurrence: number | null | undefined,
): AlignmentStripSlice[] | null {
  if (slices.some((s) => s.verseEnd != null && s.verseEnd > s.verse)) return null;
  const out: AlignmentStripSlice[] = [];
  for (const slice of slices) {
    const target = Array.isArray(slice.verseObjects) ? slice.verseObjects : null;
    if (!target || target.length === 0) continue;
    const source = Array.isArray(slice.sourceVerseObjects) ? slice.sourceVerseObjects : null;
    const words = collectOriginalWords(source);
    const lane = buildLane("SOURCE_LIT", target, source, words);

    const alignedPositions = new Set<number>(lane.byPosition.keys());
    const quotedPositions = new Set<number>(anchorPositions(source, words, quote, occurrence));
    const quotedWordIds = new Set<string>();
    if (quote) {
      // Same resolver the plain lane's <mark> uses (flowLaneSegments), keyed
      // by the English token's `text|occurrence`.
      const keys = findTargetHighlights(target, quote, occurrence ?? 1, source ?? undefined);
      for (const tok of lane.prose) {
        if (tok.kind === "word" && keys.has(`${tok.text}|${tok.occurrence}`)) quotedWordIds.add(tok.id);
      }
    }
    out.push({ verse: slice.verse, words, lane, alignedPositions, quotedPositions, quotedWordIds });
  }
  return out;
}

/**
 * The Strong's numbers to prefetch for the lexicon popover (#432): every
 * original word's raw `strong` across all of the note's slices, once each, in
 * document order. Handing useLexicon the whole set at mount is what makes the
 * popover instant and keeps it to one batched /api/lexicon call per note.
 * Words without a Strong's are skipped; the popover shows lemma/morph alone.
 */
export function stripStrongs(slices: readonly AlignmentStripSlice[]): string[] {
  const seen = new Set<string>();
  for (const slice of slices) {
    for (const w of slice.words) if (w.strong) seen.add(w.strong);
  }
  return [...seen];
}

/**
 * What the reader is pointing at: an English word's group, or one original
 * word by position. Supplied English words (no group) are never a focus —
 * there is nothing behind them to light.
 */
export type StripFocus =
  | { slice: number; side: "target"; groupId: string }
  | { slice: number; side: "original"; position: number }
  | null;

export interface LitUp {
  /** English groups to highlight (every word in the group lights). */
  groups: Set<string>;
  /** Original-word positions to highlight. */
  positions: Set<number>;
}

const NOTHING: LitUp = { groups: new Set(), positions: new Set() };

/**
 * The words that light on both sides for a focus in slice `index`.
 *
 *   English word  → its whole group, plus every original word the group renders.
 *   Original word → every group rendering it, plus all original words those
 *                   groups render (a compound like בַּחֹדֶשׁ הַשְּׁמִינִי lights as
 *                   one unit). An original word nothing renders lights nothing.
 */
export function litUp(slice: AlignmentStripSlice, index: number, focus: StripFocus): LitUp {
  if (!focus || focus.slice !== index) return NOTHING;
  const { lane } = slice;
  if (focus.side === "target") {
    const positions = lane.positionsByGroup.get(focus.groupId);
    if (!positions) return NOTHING;
    return { groups: new Set([focus.groupId]), positions: new Set(positions) };
  }
  const renderings = lane.byPosition.get(focus.position) ?? [];
  if (renderings.length === 0) return NOTHING;
  const groups = new Set<string>();
  const positions = new Set<number>();
  for (const r of renderings) {
    groups.add(r.groupId);
    for (const p of r.positions) positions.add(p);
  }
  return { groups, positions };
}

/** Tap toggles: tapping the focused word again clears it (#269's tap path). */
export function sameFocus(a: StripFocus, b: StripFocus): boolean {
  if (!a || !b || a.slice !== b.slice || a.side !== b.side) return false;
  return a.side === "target"
    ? a.groupId === (b as { groupId: string }).groupId
    : a.position === (b as { position: number }).position;
}
