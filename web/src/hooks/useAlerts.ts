import { useCallback, useEffect, useState } from "react";
import { dismissAlert, fetchAlerts, type SystemAlert } from "../sync/api";

// Banner alerts for the current user. Fetches on mount (gated by auth-ready
// so we don't fire a 401 before the cookie is set) and refetches when the
// tab becomes visible — covers the "left it open for a day" case where a
// nightly run may have failed or recovered while the user was away.
//
// No polling: alerts only change at the next nightly run, and a reload
// covers that. Add SSE/WS later if real-time becomes worth the wire.
export function useAlerts(authReady: boolean): {
  alerts: SystemAlert[];
  dismiss: (id: number) => Promise<void>;
} {
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await fetchAlerts();
      setAlerts(list);
    } catch {
      // Banner is non-critical — swallow rather than blocking the app.
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() only sets state after its await resolves; the rule cannot see past the call.
    void refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [authReady, refresh]);

  const dismiss = useCallback(
    async (id: number) => {
      // Optimistic remove; refetch to reconcile if the server disagrees.
      setAlerts((prev) => prev.filter((a) => a.id !== id));
      try {
        await dismissAlert(id);
      } catch {
        void refresh();
      }
    },
    [refresh],
  );

  return { alerts, dismiss };
}
