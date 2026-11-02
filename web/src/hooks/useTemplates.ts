import { useCallback, useEffect, useState } from "react";
import { api, type TemplateUnitMeta } from "../sync/api";

// Rail list of note-template units (metadata only — source_md/target_md are
// excluded server-side for weight). Mirrors useArticles: `enabled === false`
// yields an empty, non-loading result so the caller can gate on the
// translation-project check without conditionally calling the hook.
export function useTemplates(enabled: boolean): {
  units: TemplateUnitMeta[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const [units, setUnits] = useState<TemplateUnitMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to idle when the hook is disabled. Deriving the empty value in render instead would show the old result for a render when it is re-enabled, before the refetch marks it loading.
      setUnits([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTemplates()
      .then((res) => {
        if (cancelled) return;
        setUnits(res.units);
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

  return { units, loading, error, refetch };
}
