// useBookLint — fetches the DCS-validation lint summary for a book so the
// TopBar can surface "issues to clean up" that need a human decision. The
// backend (GET /api/books/:book/lint) buckets each issue into "flag" (content
// problems a translator must resolve) and "escalate" (integrity, footnotes);
// we expose the flag list + both counts. Book-level, so it fetches once per
// book change — not per chapter — and offers a refetch for on-demand refresh.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BookLintIssue, type BookLintReport } from "../sync/api";
import { fetchWithRetry } from "../sync/fetchWithRetry";

export interface UseBookLintReturn {
  status: "idle" | "loading" | "ready" | "error";
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  refetch: () => void;
}

export function useBookLint(book: string, enabled: boolean): UseBookLintReturn {
  const [report, setReport] = useState<BookLintReport | null>(null);
  const [status, setStatus] = useState<UseBookLintReturn["status"]>("idle");
  const fetchCtrl = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (!enabled) return;
    fetchCtrl.current?.abort();
    const ctrl = new AbortController();
    fetchCtrl.current = ctrl;
    setStatus("loading");
    fetchWithRetry((signal) => api.getBookLint(book, signal), { signal: ctrl.signal })
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setReport(r);
        setStatus("ready");
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setStatus("error");
      });
  }, [book, enabled]);

  // Refetch on book change (and reset when disabled) — lint is per-book.
  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lint is per-book: the report is cleared on a book change or when disabled, in the same effect that starts the fetch, so the previous book's flags never show against the new book.
      setReport(null);
      setStatus("idle");
      return;
    }
    setReport(null);
    load();
    return () => {
      fetchCtrl.current?.abort();
    };
  }, [book, enabled, load]);

  // Only the flag bucket needs a human decision; escalate (footnotes) is a
  // secondary count. Recompute the list from the report so the dropdown and the
  // badge can never disagree, but trust the server's flagCount as the source.
  const flagIssues = (report?.issues ?? []).filter((i) => i.bucket === "flag");

  return {
    status,
    flagIssues,
    flagCount: report?.flagCount ?? flagIssues.length,
    escalateCount: report?.escalateCount ?? 0,
    refetch: load,
  };
}
