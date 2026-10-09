// useBook — lazily loads chapters of a book and caches them so the BookView
// can render an entire book as one continuous scroll. The chapter list comes
// from the BookSummary endpoint up-front; each chapter's full payload (verses
// + tn/tq/twl + statuses) loads only when something asks for it (typically
// an IntersectionObserver hooked to chapter sentinels in BookView).
//
// Edits in book mode flow through the same outbox; the verse version used
// for `If-Match` comes from this cache. Server responses are adopted via
// onOutboxResult so the cache stays current alongside useChapter.
//
// Every local change goes through `mutate` (a CacheOp, lib/bookCache.ts). While
// a fetch for that chapter is in flight the op is also recorded and replayed
// onto the response, so a (re)load that lands late never clobbers an
// optimistic edit made after it started (#562).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type BookSummary,
  type ChapterPayload,
  type TnRow,
  type TqRow,
  type TwlRow,
  type VerseDto,
} from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { onOutboxResult } from "../sync/outbox";
import { applyCacheOp, ChapterFetchTracker, type CacheOp } from "../lib/bookCache";

export type ChapterState =
  | { kind: "unloaded" }
  | { kind: "loading" }
  | { kind: "ready"; data: ChapterPayload }
  | { kind: "error"; error: string };

export interface UseBookReturn {
  summary: BookSummary | null;
  summaryStatus: "idle" | "loading" | "ready" | "error";
  chapters: Map<number, ChapterState>;
  /** Load a chapter once; a no-op when it is already ready or loading. */
  loadChapter: (ch: number) => void;
  /** Re-fetch an already-cached chapter in place (keeps showing the old data until the new lands). */
  reloadChapter: (ch: number) => void;
  applyLocalVerse: (verse: VerseDto) => void;
  applyLocalRowPatch: (
    kind: "tn" | "tq" | "twl",
    chapter: number,
    id: string,
    patch: Partial<TnRow & TqRow & TwlRow>,
  ) => void;
  /** Add a row to its chapter's cache (after `afterId` when given). No-op if present. */
  applyLocalRowInsert: (kind: "tn" | "tq" | "twl", row: TnRow | TqRow | TwlRow, position?: { afterId?: string }) => void;
  applyLocalRowDelete: (kind: "tn" | "tq" | "twl", chapter: number, id: string) => void;
}

export function useBook(book: string, enabled: boolean): UseBookReturn {
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [chapters, setChapters] = useState<Map<number, ChapterState>>(new Map());
  // One tracker per (book, enabled). Dropped in the abort effect's cleanup and
  // recreated on first use: cleanups run before any new effect, whereas a
  // child's effect can ask for a chapter of the new book before this hook's
  // reset effect runs.
  const trackerRef = useRef<ChapterFetchTracker | null>(null);
  const getTracker = useCallback(() => (trackerRef.current ??= new ChapterFetchTracker()), []);

  // Reset everything when the book changes or the hook is disabled — the
  // cache is per-book, not global.
  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      setSummaryStatus("idle");
      setChapters(new Map());
      return;
    }
    setSummary(null);
    setSummaryStatus("loading");
    setChapters(new Map());
    const ctrl = new AbortController();
    fetchWithRetry(
      (signal) => api.getBookSummary(book, signal),
      { signal: ctrl.signal },
    )
      .then((s) => {
        if (ctrl.signal.aborted) return;
        setSummary(s);
        setSummaryStatus("ready");
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setSummaryStatus("error");
      });
    return () => {
      ctrl.abort();
    };
  }, [book, enabled]);

  // One AbortController per chapter so a book change can cancel them all.
  const chapterCtrls = useRef<Map<number, AbortController>>(new Map());

  // When the book toggles or `enabled` drops, abort every in-flight chapter
  // load (the effect above already clears the cache).
  useEffect(() => {
    return () => {
      for (const ctrl of chapterCtrls.current.values()) ctrl.abort();
      chapterCtrls.current.clear();
      trackerRef.current = null;
    };
  }, [book, enabled]);

  // Fetch a chapter under `token` and adopt it unless a newer fetch superseded
  // it. A reload aborts the fetch it replaces.
  const fetchChapter = useCallback(
    (ch: number, token: number, reload: boolean) => {
      const tracker = getTracker();
      if (reload) chapterCtrls.current.get(ch)?.abort();
      const ctrl = new AbortController();
      chapterCtrls.current.set(ch, ctrl);
      // Only drop our own controller: a reload that aborted us has already
      // registered its own, and deleting that one would leave a later reload
      // unable to abort it (stale response could land last).
      const release = () => {
        if (chapterCtrls.current.get(ch) === ctrl) chapterCtrls.current.delete(ch);
      };
      fetchWithRetry((signal) => api.getChapter(book, ch, signal), { signal: ctrl.signal })
        .then((data) => {
          release();
          if (ctrl.signal.aborted) return;
          const merged = tracker.land(ch, token, data);
          if (!merged) return;
          setChapters((prev) => new Map(prev).set(ch, { kind: "ready", data: merged }));
        })
        .catch((e) => {
          release();
          const current = tracker.fail(ch, token);
          if (!current || ctrl.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          setChapters((prev) => {
            const cur = prev.get(ch);
            if (reload) {
              // Best effort: a ready cache keeps its previous payload. A reload
              // that superseded a first load leaves it "loading", so let it retry.
              return cur?.kind === "loading" ? new Map(prev).set(ch, { kind: "unloaded" }) : prev;
            }
            return new Map(prev).set(ch, {
              kind: "error",
              error: e instanceof ApiError ? `HTTP ${e.status}` : String(e),
            });
          });
        });
    },
    [book, getTracker],
  );

  const loadChapter = useCallback(
    (ch: number) => {
      if (!enabled) return;
      // Ready or already loading: nothing to do (no refetch, so a cached
      // chapter's optimistic edits stay put).
      const token = getTracker().beginLoad(ch);
      if (token === null) return;
      setChapters((prev) => new Map(prev).set(ch, { kind: "loading" }));
      fetchChapter(ch, token, false);
    },
    [enabled, getTracker, fetchChapter],
  );

  const reloadChapter = useCallback(
    (ch: number) => {
      if (!enabled) return;
      fetchChapter(ch, getTracker().beginReload(ch), true);
    },
    [enabled, getTracker, fetchChapter],
  );

  // Apply a local change to a ready chapter, and record it so a fetch already
  // in flight for that chapter replays it on landing.
  const mutate = useCallback(
    (ch: number, op: CacheOp) => {
      getTracker().record(ch, op);
      setChapters((prev) => {
        const cur = prev.get(ch);
        if (!cur || cur.kind !== "ready") return prev;
        const data = applyCacheOp(cur.data, op);
        return data === cur.data ? prev : new Map(prev).set(ch, { kind: "ready", data });
      });
    },
    [getTracker],
  );

  const applyLocalVerse = useCallback<UseBookReturn["applyLocalVerse"]>(
    (verse) => mutate(verse.chapter, { t: "verse", verse }),
    [mutate],
  );

  // Shell patches the chapter-0 cache on every tn edit; applyCacheOp returns
  // the same payload when the row isn't one of that chapter's, so no churn.
  const applyLocalRowPatch = useCallback<UseBookReturn["applyLocalRowPatch"]>(
    (kind, chapter, id, patch) => mutate(chapter, { t: "patch", kind, id, patch }),
    [mutate],
  );

  const applyLocalRowInsert = useCallback<UseBookReturn["applyLocalRowInsert"]>(
    (kind, row, position) => mutate(row.chapter, { t: "insert", kind, row, afterId: position?.afterId }),
    [mutate],
  );

  const applyLocalRowDelete = useCallback<UseBookReturn["applyLocalRowDelete"]>(
    (kind, chapter, id) => mutate(chapter, { t: "delete", kind, id }),
    [mutate],
  );

  // Adopt outbox results so verses edited via book mode stay coherent with
  // the server. useChapter wires the same listener for the active chapter;
  // duplicate updates are idempotent.
  useEffect(() => {
    if (!enabled) return;
    return onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      if (op.target.kind === "verse") {
        const v = result.updated as VerseDto;
        if (v && v.book === book) applyLocalVerse(v);
        return;
      }
      if (op.target.kind === "row") {
        const u = result.updated as TnRow | TqRow | TwlRow;
        if (!u || u.book !== book) return;
        mutate(u.chapter, { t: "replace", kind: op.target.rowKind, row: u });
      }
    });
  }, [book, enabled, applyLocalVerse, mutate]);

  return {
    summary,
    summaryStatus,
    chapters,
    loadChapter,
    reloadChapter,
    applyLocalVerse,
    applyLocalRowPatch,
    applyLocalRowInsert,
    applyLocalRowDelete,
  };
}
