import type { BookSummary } from "../sync/api";

/**
 * GET /api/books/:book groups rows by chapter, and book front matter lands in
 * chapter 0: `refParts` in api/src/importParsers.ts maps a 'front:intro' tn ref
 * to chapter 0, so every book imported with book-intro notes gets a chapter-0
 * entry (verified against GET /api/chapters/ZEC: ids 0-14 for a 14-chapter
 * book). Counting that entry as a chapter reported OBA — a one-chapter book —
 * as "2 chapter(s) loaded", and fed chapter 0 into chapter navigation, the
 * re-pull default range, and whole-book AI translate.
 *
 * Anything that COUNTS chapters, or lists them for a chapter-scoped screen,
 * goes through these. Two deliberate exceptions, because chapter 0 is a real
 * destination there and filtering it broke both once already:
 *   • TopBar's chapter selector / prev-next — renders chapter 0 as "Intro".
 *   • Shell's book-mode chapter list — BookView has a chapter-0 "front" block.
 * Row totals (notes/questions) are deliberately NOT filtered here — intro notes
 * are real notes; only screens that can't open chapter 0 exclude them.
 */
export function realChapters(summary: BookSummary | null | undefined): BookSummary["chapters"] {
  return (summary?.chapters ?? []).filter((c) => c.chapter >= 1);
}

/** Real chapter numbers, ascending. */
export function realChapterNumbers(summary: BookSummary | null | undefined): number[] {
  return realChapters(summary)
    .map((c) => c.chapter)
    .sort((a, b) => a - b);
}

/**
 * The first real chapter after `chapter`, or null when there is none: the
 * book's last chapter, or a summary not loaded (or failed), so a caller never
 * offers a chapter it can't confirm exists.
 */
export function nextRealChapter(summary: BookSummary | null | undefined, chapter: number): number | null {
  return realChapterNumbers(summary).find((c) => c > chapter) ?? null;
}
