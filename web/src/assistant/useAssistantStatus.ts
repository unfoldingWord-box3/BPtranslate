// The assistant's status for the signed-in person (GET /api/assistant/status).
// Fetched on mount, on a language change, and again each time `open` turns
// true (not when it turns false), so an admin's switch
// or a spent budget shows up without a reload. A failed fetch keeps the last
// known status (null before the first success, which hides the feature).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AssistantStatus } from "../sync/api";

export function useAssistantStatus(lang: string, open: boolean) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    api
      .getAssistantStatus(lang)
      .then((s) => {
        if (alive.current) setStatus(s);
      })
      .catch(() => {
        /* keep the last known status */
      });
  }, [lang]);

  // On mount (the closed button needs the status to show at all), on a
  // language change, and each time the panel opens; closing learns nothing
  // new, so it does not fetch (#860). The ref also keeps a panel that mounts
  // already open to one fetch.
  const fetchedFor = useRef<typeof refresh | null>(null);
  useEffect(() => {
    if (!open && fetchedFor.current === refresh) return;
    fetchedFor.current = refresh;
    refresh();
  }, [refresh, open]);

  return { status, refresh };
}

/** The feature is shown only to people who can apply its proposals. */
export const assistantVisible = (s: AssistantStatus | null): s is AssistantStatus => !!s && s.enabled && s.canEdit;
