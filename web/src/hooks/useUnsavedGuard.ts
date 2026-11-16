import { useEffect, useLayoutEffect, useRef } from "react";
import { countsAsUnsaved, drafts, hasUnsavedDrafts, type DraftRecord } from "../sync/drafts";

// Warn before a full-page unload (reload — including the "App update available"
// chip's programmatic reload — tab close, or external navigation) when unsaved
// work would be lost. In-app navigation is already gated (runWithDirtyGate /
// requestDualAction in Shell); this covers the paths that tear the page down
// without ever routing through React.
//
// This is the safety net that was missing when a version-bump reload silently
// dropped a chapter of alignment work: alignment drags live only in React state
// until an explicit save, so a reload mid-alignment loses them with no trace.
// Text / note / row drafts persist in IndexedDB and survive the reload, but a
// translator who reloads past them still has to notice and re-save, so we warn
// for those too.
//
// beforeunload cannot run async work (no flushing IndexedDB from here) — the
// spec only lets us ask the browser to show its generic "Leave site? Changes
// you made may not be saved" confirm. That prompt is the guard; the user
// cancels, saves through the normal UI, then reloads.
//
// Two draft signals, both needed: the async `hasDrafts` subscription catches
// drafts persisted in a PRIOR session (present in IndexedDB before any set()
// this session), while the synchronous hasUnsavedDrafts() catches a draft the
// current session just wrote but whose subscription round-trip hasn't landed —
// the exact commit-window a quick reload would otherwise slip through.
//
// Style typing this user cannot save (another person's on a shared browser)
// does not count (#920, countsAsUnsaved). The list is kept and judged when the
// page unloads, since the signed-in user can change while it stays the same.
export function useUnsavedGuard(panelDirty: boolean): void {
  // A ref, not state: nothing renders from the list, so a draft write must
  // not re-render the screen that mounts this guard.
  const draftsRef = useRef<DraftRecord[]>([]);
  useEffect(() => {
    // drafts.subscribe returns its own unsubscribe fn; hand it back as the
    // effect cleanup so the subscription is torn down on unmount (no leak).
    const unsubscribe = drafts.subscribe((all) => {
      draftsRef.current = all;
    });
    return unsubscribe;
  }, []);

  // Read through a ref so the listener can stay installed once (stable identity)
  // and always see the latest dirtiness without re-adding on every change.
  // Synced after every commit (no deps), before paint, so the listener never
  // sees a value older than what is on screen.
  const activeRef = useRef(false);
  useLayoutEffect(() => {
    activeRef.current = panelDirty;
  });

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!activeRef.current && !draftsRef.current.some(countsAsUnsaved) && !hasUnsavedDrafts()) return;
      e.preventDefault();
      // Legacy Chrome requires returnValue to be set for the prompt to show.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
