import type { BookSummary, ChapterPayload, TnRow } from "../sync/api";
import { realChapterNumbers } from "./bookSummary.ts";

/**
 * The book introduction is the tN row 'front:intro', stored as chapter 0 (see
 * bookSummary.ts). Shell's useChapter holds ONE chapter, so in book mode those
 * rows are read from useBook's chapter-0 cache and shown in the notes column
 * just before the first real chapter's own intro note.
 *
 * Returns [] (the notes column is then exactly as before) unless: scripture mode
 * is "book", the active chapter is the first real chapter, and chapter 0 has
 * finished loading. Rows keep the stored order (sort_order, then id).
 */
export function selectBookIntroRows(args: {
  mode: string;
  chapter: number;
  summary: BookSummary | null | undefined;
  chapters: ReadonlyMap<number, { kind: string; data?: ChapterPayload }> | undefined;
}): TnRow[] {
  if (args.mode !== "book") return [];
  if (args.chapter !== realChapterNumbers(args.summary)[0]) return [];
  const front = args.chapters?.get(0);
  if (!front || front.kind !== "ready" || !front.data) return [];
  return [...front.data.tn].sort(
    (a, b) =>
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}
