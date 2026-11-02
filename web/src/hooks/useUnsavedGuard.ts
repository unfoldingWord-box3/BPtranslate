import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { drafts, hasUnsavedDrafts } from "../sync/drafts";

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
export function useUnsavedGuard(panelDirty: boolean): void {
  const [hasDrafts, setHasDrafts] = useState(false);
  useEffect(() => {
    // drafts.subscribe returns its own unsubscribe fn; hand it back as the
    // effect cleanup so the subscription is torn down on unmount (no leak).
    const unsubscribe = drafts.subscribe((all) => setHasDrafts(all.length > 0));
    return unsubscribe;
  }, []);

  // Read through a ref so the listener can stay installed once (stable identity)
  // and always see the latest dirtiness without re-adding on every change.
  // Synced after every commit (no deps), before paint, so the listener never
  // sees a value older than what is on screen.
  const activeRef = useRef(false);
  useLayoutEffect(() => {
    activeRef.current = panelDirty || hasDrafts;
  });

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!activeRef.current && !hasUnsavedDrafts()) return;
      e.preventDefault();
      // Legacy Chrome requires returnValue to be set for the prompt to show.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}
