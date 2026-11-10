// Verse spans for the verse view: which stretch of verses one screen (or one
// section of the scrolling list) shows. Pure functions, so the bridging rules
// are tested without a browser (verseSpans.test.mjs).

import type { VerseDto } from "../../sync/api";

export interface VerseSpan {
  start: number;
  end: number;
}

// The distinct rows of one lane's expanded index that overlap [start, end], in
// verse order. `buildVerseIndex` maps every verse a row covers to the SAME DTO
// reference, so identity de-duplication is exact — a `\v 15-16` row appears
// once, not twice.
export function rowsOverlapping(
  index: Record<number, VerseDto>,
  start: number,
  end: number,
): VerseDto[] {
  const out: VerseDto[] = [];
  for (let v = start; v <= end; v++) {
    const dto = index[v];
    if (dto && !out.includes(dto)) out.push(dto);
  }
  return out;
}

// A bridged row (`\v 15-16`) covers MORE than the routed verse, and the join
// the verse view rests on only holds when every lane describes the SAME
// stretch of text: matching a two-verse English row against one verse of
// Hebrew mis-counts every `x-occurrence` and invents "not rendered" holes.
// So the span starts at the verse and grows until no lane's row crosses an
// edge. AlignScreen does the same thing for its one target lane (buildSlice +
// concatSourceRange); here three lanes can each bridge differently, so the
// span is their union. The guard bounds the loop; two passes suffice in
// practice.
export function spanFor(verse: number, indexes: Record<number, VerseDto>[]): VerseSpan {
  let start = verse;
  let end = verse;
  for (let guard = 0; guard < 8; guard++) {
    let s = start;
    let e = end;
    for (const index of indexes) {
      for (const dto of rowsOverlapping(index, start, end)) {
        s = Math.min(s, dto.verse);
        e = Math.max(e, dto.verse_end ?? dto.verse);
      }
    }
    if (s === start && e === end) break;
    start = s;
    end = e;
  }
  return { start, end };
}

// Every span of a chapter, in order, for the scrolling list: each verse lands
// in exactly one span, so a bridged 15-16 row is one section, not two.
export function chapterSpans(verseNums: number[], indexes: Record<number, VerseDto>[]): VerseSpan[] {
  const out: VerseSpan[] = [];
  for (const n of verseNums) {
    const last = out[out.length - 1];
    if (last && n <= last.end) continue;
    out.push(spanFor(n, indexes));
  }
  return out;
}

// Index of the span holding `verse`, or -1.
export function spanIndexOf(spans: VerseSpan[], verse: number): number {
  return spans.findIndex((s) => verse >= s.start && verse <= s.end);
}

// Which section is "current" while scrolling: the last one whose top edge is
// at or above the anchor line. `tops` are the sections' top edges in list
// order (ascending). Returns 0 when every top is below the line, so the first
// section counts as current at the very top of the list.
export function currentIndexAt(tops: number[], anchor: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= anchor) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
