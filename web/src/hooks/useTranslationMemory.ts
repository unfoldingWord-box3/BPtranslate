import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Term,
  type TranslationPrefs,
  type TranslationExample,
  type ContextExportStatus,
} from "../sync/api";
import { onPrefsDraftElsewhere } from "../sync/drafts";
import { newestPrefs, prefsAfterConflict } from "../sync/prefsDraft";

// Preferences singleton (brief + instructions + register + assisted flag).
// `enabled === false` yields an idle result so the caller can gate on the
// translation-project check without conditionally calling the hook.
export function useTranslationPrefs(enabled: boolean): {
  prefs: TranslationPrefs | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
  apply: (p: TranslationPrefs) => void;
  applyConflict: (p: TranslationPrefs, sent: number) => void;
} {
  const [prefs, setPrefs] = useState<TranslationPrefs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  // The newest row seen while enabled, including one another tab's save sent
  // before the first load landed. Every row goes through take(), so the page
  // never moves to an older version (#913 review round 3, C1).
  const newest = useRef<TranslationPrefs | null>(null);
  const take = useCallback((p: TranslationPrefs) => {
    newest.current = newestPrefs(newest.current, p);
    setPrefs(newest.current);
  }, []);
  // Adopt a prefs object we already have in hand (a PUT response, or the
  // `current` row from a 409 conflict body) without a round-trip refetch.
  const apply = take;
  // The `current` row of a 409 for a Save sent with If-Match `sent`: taken
  // even when older than the row held if the version went down (an admin
  // database restore), else as take() would (prefsAfterConflict, #922 item 2).
  const applyConflict = useCallback((p: TranslationPrefs, sent: number) => {
    newest.current = prefsAfterConflict(newest.current, p, sent);
    setPrefs(newest.current);
  }, []);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to idle when the hook is disabled. Deriving the empty value in render instead would show the old result for a render when it is re-enabled, before the refetch marks it loading.
      setPrefs(null);
      setError(null);
      setLoading(false);
      newest.current = null;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTranslationPrefs()
      .then((res) => {
        if (cancelled) return;
        take(res.prefs);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey, take]);

  // Another tab of this workspace saved Brief, Instructions or Common issues:
  // take the row its save returned, as that tab did, so this page never pairs
  // the new version with an older row (#913 review B1). An older row (a
  // message overtaken by a newer save or fetch) is ignored, and one that
  // arrives before the first load is kept over that load's older row (C1).
  useEffect(() => {
    if (!enabled) return;
    return onPrefsDraftElsewhere((m) => {
      if (m.type === "prefs-saved") take(m.row as unknown as TranslationPrefs);
    });
  }, [enabled, take]);

  return { prefs, loading, error, refetch, apply, applyConflict };
}

/** Latest context-pack export status — gates the assisted-mode toggle. */
export function useContextExportStatus(enabled: boolean): {
  status: ContextExportStatus | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [status, setStatus] = useState<ContextExportStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to idle when the hook is disabled. Deriving the empty value in render instead would show the old result for a render when it is re-enabled, before the refetch marks it loading.
      setStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContextExportStatus()
      .then((res) => {
        if (cancelled) return;
        setStatus(res);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, reloadKey]);

  return { status, loading, error, refetch };
}

// Terminology list, filterable by status / free-text query.
export function useTerms(
  enabled: boolean,
  opts: { status?: string; q?: string },
): { terms: Term[]; loading: boolean; error: Error | null; refetch: () => void } {
  const [terms, setTerms] = useState<Term[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  const { status, q } = opts;

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to idle when the hook is disabled. Deriving the empty value in render instead would show the old result for a render when it is re-enabled, before the refetch marks it loading.
      setTerms([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTerms({ status, q })
      .then((res) => {
        if (cancelled) return;
        setTerms(res.terms);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, status, q, reloadKey]);

  return { terms, loading, error, refetch };
}

// Validated-examples browse (read-only). resource + optional filters.
export function useExamples(
  enabled: boolean,
  opts: { resource: "tn" | "tq"; supportReference?: string; q?: string; limit?: number },
): { examples: TranslationExample[]; loading: boolean; error: Error | null; refetch: () => void } {
  const [examples, setExamples] = useState<TranslationExample[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);
  const { resource, supportReference, q, limit } = opts;

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to idle when the hook is disabled. Deriving the empty value in render instead would show the old result for a render when it is re-enabled, before the refetch marks it loading.
      setExamples([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getExamples({ resource, supportReference, q, limit })
      .then((res) => {
        if (cancelled) return;
        setExamples(res.examples);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, resource, supportReference, q, limit, reloadKey]);

  return { examples, loading, error, refetch };
}
