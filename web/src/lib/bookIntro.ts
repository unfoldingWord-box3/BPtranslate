import type { BookSummary, ChapterPayload, TnRow } from "../sync/api";
import { realChapterNumbers } from "./bookSummary.ts";

/**
 * The book introduction is the tN row 'front:intro', stored as chapter 0 (see
 * bookSummary.ts). Shell's useChapter holds ONE chapter, so in book mode those
 * rows are read from useBook's chapter-0 cache and shown in the notes column
 * just before the first real chapter's own intro note.
 *
 * Returns [] (the notes column is then exactly as before) unless: scripture mode
 * is "book", the active chapter is the first real chapter, useChapter's data is
 * that chapter's (`shownChapter`), and chapter 0 has finished loading. Rows keep
 * the stored order (sort_order, then id).
 *
 * The `shownChapter` gate (#567): useChapter keeps the prior chapter's data
 * until the new one loads, so coming from the chapter-0 view its notes ARE the
 * intro rows, and listing the cache's copy too showed each intro card twice.
 */
/**
 * The chapter-0 room a book-mode tab also listens to (#562): on the first real
 * chapter it shows the book introduction, whose row edits and AI-apply hints
 * are broadcast to room (book, 0) only. Null when no extra room is needed.
 */
export function introRoomChapter(args: {
  mode: string;
  chapter: number;
  summary: BookSummary | null | undefined;
}): 0 | null {
  if (args.mode !== "book") return null;
  if (!args.summary?.chapters.some((c) => c.chapter === 0)) return null;
  if (args.chapter !== realChapterNumbers(args.summary)[0]) return null;
  return 0;
}

/**
 * True when the tab has just started listening to the intro room. Events sent
 * there while it wasn't listening were missed, so the cached chapter 0 must be
 * refetched (useBook replays local edits onto the response).
 */
export function introRoomJoined(prev: number | null, next: number | null): boolean {
  return prev === null && next !== null;
}

/**
 * Whether the chapter-refresh action should also reload useBook's chapter 0:
 * when the tab listens to the intro room or holds chapter 0 at all — even with
 * no intro notes yet, since the AI run may have just written the first ones.
 */
export function refreshReloadsIntro(args: {
  introRoom: number | null;
  front: { kind: string } | undefined;
}): boolean {
  return args.introRoom !== null || args.front?.kind === "ready";
}

export function selectBookIntroRows(args: {
  mode: string;
  chapter: number;
  /** The chapter useChapter's data currently holds (undefined before any load). */
  shownChapter: number | undefined;
  summary: BookSummary | null | undefined;
  chapters: ReadonlyMap<number, { kind: string; data?: ChapterPayload }> | undefined;
}): TnRow[] {
  if (args.mode !== "book") return [];
  if (args.chapter !== realChapterNumbers(args.summary)[0]) return [];
  if (args.shownChapter !== args.chapter) return [];
  const front = args.chapters?.get(0);
  if (!front || front.kind !== "ready" || !front.data) return [];
  // Trashed rows sink last, like sortBySortOrder (resourcePanelShared.tsx).
  return [...front.data.tn].sort(
    (a, b) =>
      (a.trashed_at != null ? 1 : 0) - (b.trashed_at != null ? 1 : 0) ||
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}
