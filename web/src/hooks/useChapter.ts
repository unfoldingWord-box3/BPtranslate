// useChapter — pulls the whole chapter payload from the API and provides
// helpers for optimistic local mutations. Listens to outbox results so a
// successful drain refreshes the affected row in place without a full
// re-fetch (cheap and avoids flicker).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type ChapterPayload,
  type TnRow,
  type TqRow,
  type TwlRow,
  type VerseDto,
  type VerseStatus,
  type VerseLaneCheck,
  type CheckLane,
  type LaneCheckState,
} from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";
import { onOutboxResult } from "../sync/outbox";
import { rowWithLivePatches } from "../sync/outboxTargeting";

type Status = "idle" | "loading" | "ready" | "error" | "retrying";

export interface UseChapterReturn {
  status: Status;
  data: ChapterPayload | null;
  error: string | null;
  /** Incremented every failed attempt during the current retry loop. Useful for showing "reconnecting…". */
  retryAttempts: number;
  refetch: () => Promise<void>;
  applyLocalRowPatch: (kind: "tn" | "tq" | "twl", id: string, patch: Partial<TnRow & TqRow & TwlRow>) => void;
  applyLocalRowReplacement: (kind: "tn" | "tq" | "twl", row: TnRow | TqRow | TwlRow) => void;
  applyLocalRowDelete: (kind: "tn" | "tq" | "twl", id: string) => void;
  applyLocalRowInsert: (
    kind: "tn" | "tq" | "twl",
    row: TnRow | TqRow | TwlRow,
    position?: { afterId?: string },
  ) => void;
  applyLocalVerse: (verse: VerseDto) => void;
  applyLocalVerseStatus: (verse: number, done: boolean) => void;
  /** Optimistically add/remove my own stamp on a (verse, lane). */
  applyLocalLaneCheck: (verse: number, lane: CheckLane, userId: number, checked: boolean) => void;
  /** Authoritative: replace a (verse, lane)'s checker set (server result / WS). */
  applyLaneCheckers: (verse: number, lane: CheckLane, checkers: number[]) => void;
  /** Authoritative: replace every check for one lane in the chapter (bulk result). */
  replaceLaneChecksForLane: (lane: CheckLane, checks: VerseLaneCheck[]) => void;
}

export function useChapter(book: string, chapter: number): UseChapterReturn {
  const [status, setStatus] = useState<Status>("idle");
  const [data, setData] = useState<ChapterPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempts, setRetryAttempts] = useState(0);
  const mounted = useRef(true);
  const fetchCtrl = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    // Abort any in-flight retry loop from a previous (book, chapter) before
    // starting a new one — otherwise stale data could land after navigation.
    fetchCtrl.current?.abort();
    const ctrl = new AbortController();
    fetchCtrl.current = ctrl;

    setStatus("loading");
    setError(null);
    setRetryAttempts(0);
    try {
      const payload = await fetchWithRetry(
        (signal) => api.getChapter(book, chapter, signal),
        {
          signal: ctrl.signal,
          onAttempt: (attempts) => {
            if (mounted.current && fetchCtrl.current === ctrl) {
              setStatus("retrying");
              setRetryAttempts(attempts);
            }
          },
        },
      );
      if (!mounted.current || fetchCtrl.current !== ctrl) return;
      setData(payload);
      setStatus("ready");
      setRetryAttempts(0);
    } catch (e) {
      if (!mounted.current || fetchCtrl.current !== ctrl) return;
      if (ctrl.signal.aborted) return;
      setError(e instanceof ApiError ? `HTTP ${e.status}` : String(e));
      setStatus("error");
    }
  }, [book, chapter]);

  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch() marks the chapter loading as it starts the request (the same function backs Retry); the data itself is set after the await.
    void refetch();
    return () => {
      mounted.current = false;
      fetchCtrl.current?.abort();
    };
  }, [refetch]);

  const applyLocalRowPatch = useCallback<UseChapterReturn["applyLocalRowPatch"]>(
    (kind, id, patch) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === id ? { ...r, ...patch } : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowReplacement = useCallback<UseChapterReturn["applyLocalRowReplacement"]>(
    (kind, row) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.map((r) => (r.id === row.id ? row : r));
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowDelete = useCallback<UseChapterReturn["applyLocalRowDelete"]>(
    (kind, id) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        const next = list.filter((r) => r.id !== id);
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalRowInsert = useCallback<UseChapterReturn["applyLocalRowInsert"]>(
    (kind, row, position) => {
      setData((prev) => {
        if (!prev) return prev;
        const list = prev[kind] as Array<TnRow | TqRow | TwlRow>;
        // Skip if a row with this id is already present (e.g. createRow response
        // racing with an outbox replacement).
        if (list.some((r) => r.id === row.id)) return prev;
        let next: Array<TnRow | TqRow | TwlRow>;
        const afterId = position?.afterId;
        if (afterId) {
          const idx = list.findIndex((r) => r.id === afterId);
          if (idx >= 0) {
            next = [...list.slice(0, idx + 1), row, ...list.slice(idx + 1)];
          } else {
            next = [...list, row];
          }
        } else {
          next = [...list, row];
        }
        return { ...prev, [kind]: next } as ChapterPayload;
      });
    },
    [],
  );

  const applyLocalVerse = useCallback<UseChapterReturn["applyLocalVerse"]>(
    (verse) => {
      setData((prev) => {
        if (!prev) return prev;
        const byVersion = prev.verses[verse.bible_version] ?? {};
        const nextVersion = { ...byVersion, [verse.verse]: verse };
        return {
          ...prev,
          verses: { ...prev.verses, [verse.bible_version]: nextVersion },
        };
      });
    },
    [],
  );

  const applyLocalVerseStatus = useCallback<UseChapterReturn["applyLocalVerseStatus"]>(
    (verse, done) => {
      setData((prev) => {
        if (!prev) return prev;
        const existing = prev.verseStatuses.find((s) => s.verse === verse);
        const updated: VerseStatus = {
          book: prev.book,
          chapter: prev.chapter,
          verse,
          done: done ? 1 : 0,
          updated_at: Math.floor(Date.now() / 1000),
        };
        const next = existing
          ? prev.verseStatuses.map((s) => (s.verse === verse ? updated : s))
          : [...prev.verseStatuses, updated];
        return { ...prev, verseStatuses: next };
      });
    },
    [],
  );

  const applyLocalLaneCheck = useCallback<UseChapterReturn["applyLocalLaneCheck"]>(
    (verse, lane, userId, checked) => {
      setData((prev) => {
        if (!prev) return prev;
        const exists = prev.verseLaneChecks.some(
          (c) => c.verse === verse && c.lane === lane && c.checked_by === userId,
        );
        if (checked && exists) return prev;
        if (!checked && !exists) return prev;
        const next = checked
          ? [
              ...prev.verseLaneChecks,
              {
                book: prev.book,
                chapter: prev.chapter,
                verse,
                lane,
                checked_by: userId,
                checked_at: Math.floor(Date.now() / 1000),
              } as VerseLaneCheck,
            ]
          : prev.verseLaneChecks.filter(
              (c) => !(c.verse === verse && c.lane === lane && c.checked_by === userId),
            );
        return { ...prev, verseLaneChecks: next };
      });
    },
    [],
  );

  const applyLaneCheckers = useCallback<UseChapterReturn["applyLaneCheckers"]>(
    (verse, lane, checkers) => {
      setData((prev) => {
        if (!prev) return prev;
        const rest = prev.verseLaneChecks.filter((c) => !(c.verse === verse && c.lane === lane));
        const now = Math.floor(Date.now() / 1000);
        const added: VerseLaneCheck[] = checkers.map((checked_by) => ({
          book: prev.book,
          chapter: prev.chapter,
          verse,
          lane,
          checked_by,
          checked_at: now,
        }));
        return { ...prev, verseLaneChecks: [...rest, ...added] };
      });
    },
    [],
  );

  const replaceLaneChecksForLane = useCallback<UseChapterReturn["replaceLaneChecksForLane"]>(
    (lane, checks) => {
      setData((prev) => {
        if (!prev) return prev;
        const rest = prev.verseLaneChecks.filter((c) => c.lane !== lane);
        return { ...prev, verseLaneChecks: [...rest, ...checks] };
      });
    },
    [],
  );

  // Adopt server-confirmed values when an outbox op succeeds. For a row, the
  // patches of later saves still queued for it stay on top (#620).
  useEffect(() => {
    return onOutboxResult((op, result, queued) => {
      if (result.kind !== "ok") return;
      if (op.target.kind === "row") {
        const u = result.updated as TnRow | TqRow | TwlRow;
        if (u && u.book === book && u.chapter === chapter) {
          applyLocalRowReplacement(op.target.rowKind, rowWithLivePatches(u, op, queued));
        }
        return;
      }
      if (op.target.kind === "verse") {
        const v = result.updated as VerseDto;
        if (v && v.book === book && v.chapter === chapter) {
          applyLocalVerse(v);
        }
        return;
      }
      if (op.target.kind === "verse_status") {
        const s = result.updated as VerseStatus;
        if (s && s.book === book && s.chapter === chapter) {
          applyLocalVerseStatus(s.verse, s.done === 1);
        }
        return;
      }
      if (op.target.kind === "lane_check") {
        const s = result.updated as LaneCheckState;
        if (s && s.book === book && s.chapter === chapter) {
          applyLaneCheckers(s.verse, s.lane, s.checkers);
        }
      }
    });
  }, [book, chapter, applyLocalRowReplacement, applyLocalVerse, applyLocalVerseStatus, applyLaneCheckers]);

  return {
    status,
    data,
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
    applyLocalVerseStatus,
    applyLocalLaneCheck,
    applyLaneCheckers,
    replaceLaneChecksForLane,
  };
}
