// The assistant's status for the signed-in person (GET /api/assistant/status).
// Fetched on mount and again each time `open` turns true, so an admin's switch
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

  useEffect(() => {
    refresh();
  }, [refresh, open]);

  return { status, refresh };
}

/** The feature is shown only to people who can apply its proposals. */
export const assistantVisible = (s: AssistantStatus | null): s is AssistantStatus => !!s && s.enabled && s.canEdit;
