import { useCallback, useEffect, useRef, useState } from "react";
import { drafts, type DraftRecord } from "../sync/drafts";
import { useShowDraftEditors } from "../sync/draftEditors";
import type { TranslationPrefs } from "../sync/api";
import {
  afterPrefsConflict,
  afterPrefsSave,
  hydratePrefsDraft,
  prefsDraftKey,
  prefsVersionToSend,
  sameFields,
  type PrefsDraftSection,
  type PrefsDraftState,
  type PrefsFields,
} from "../sync/prefsDraft";

// Unsaved text of one translation-preferences editor (Brief, Instructions or
// Common issues; #909), kept in the drafts store the way note editors keep
// theirs (CLAUDE.md "Note save semantics"): written on every change, restored
// on mount, cleared once a save lands. So a remount (a history restore, a
// lesson moved into Common issues) or a reload brings the typing back. The
// rules live in sync/prefsDraft.ts.
//
// `text` is null until both the prefs row and the stored draft are read; the
// editor shows its loading state until then, so a late restore cannot replace
// typing. `pick` must be stable (a module-level function).
export function usePrefsDraft<F extends PrefsFields>(
  section: PrefsDraftSection,
  prefs: TranslationPrefs | null,
  pick: (p: TranslationPrefs) => F,
) {
  const key = prefsDraftKey(section);
  const [state, setState] = useState<PrefsDraftState<F> | null>(null);
  const stateRef = useRef<PrefsDraftState<F> | null>(null);
  const [stored, setStored] = useState<{ rec: DraftRecord | undefined } | null>(null);

  useEffect(() => {
    let cancelled = false;
    drafts
      .get(key)
      .catch(() => undefined)
      .then((rec) => {
        if (!cancelled) setStored({ rec });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Write the state and keep the store in step: a draft while the text
  // differs from its base, none once it does not.
  const commit = useCallback(
    (next: PrefsDraftState<F>) => {
      stateRef.current = next;
      setState(next);
      if (sameFields(next.text, next.base)) void drafts.clear(key);
      else void drafts.set(key, { text: next.text, base: next.base }, next.baseVersion, { kind: "prefs", section });
    },
    [key, section],
  );

  useEffect(() => {
    if (stateRef.current || !prefs || !stored) return;
    const h = hydratePrefsDraft(pick(prefs), prefs.version, stored.rec);
    if (h.clearStored) void drafts.clear(key);
    const next = { text: h.text, base: h.base, baseVersion: h.baseVersion };
    stateRef.current = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds once from two async sources (the prefs row and the IndexedDB draft read).
    setState(next);
  }, [prefs, stored, key, pick]);

  useShowDraftEditors(state ? [key] : []);

  return {
    text: state?.text ?? null,
    dirty: !!state && !sameFields(state.text, state.base),
    change: (text: F) => {
      const s = stateRef.current;
      if (s) commit({ ...s, text });
    },
    // The If-Match version for a Save of the current text.
    versionToSend: (): number | null => {
      const s = stateRef.current;
      if (!s || !prefs) return null;
      return prefsVersionToSend(pick(prefs), prefs.version, s.base, s.baseVersion);
    },
    saved: (row: TranslationPrefs) => {
      const s = stateRef.current;
      if (s) commit(afterPrefsSave(s.text, pick(row), row.version));
    },
    conflicted: (current: TranslationPrefs) => {
      const s = stateRef.current;
      if (s) commit(afterPrefsConflict(s.text, s.base, pick(current), current.version));
    },
  };
}
