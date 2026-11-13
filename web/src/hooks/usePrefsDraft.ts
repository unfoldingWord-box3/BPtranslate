import { useCallback, useEffect, useRef, useState } from "react";
import { drafts, onDraftDiscarded, type DraftRecord } from "../sync/drafts";
import { useShowDraftEditors } from "../sync/draftEditors";
import { currentUserId, type TranslationPrefs } from "../sync/api";
import {
  afterPrefsConflict,
  afterPrefsSave,
  hydratePrefsDraft,
  prefsDraftClearable,
  prefsDraftDroppable,
  prefsDraftKey,
  prefsDraftLost,
  prefsSavePayload,
  prefsVersionToSend,
  typedKeys,
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
//
// `canSave` is false for a user whose Save would be refused (not an admin, or
// not a translation project): no draft is written for them, and one they typed
// before (when they could save) is dropped when the editor opens, so the "N
// unsaved" count, the unload prompt and the reminder toast never point at text
// that cannot be saved (#909 gate review H2). Drafts are per workspace, not
// per user, so another user's draft on a shared browser is left alone (#913
// item 5): each draft records who typed it.
export function usePrefsDraft<F extends PrefsFields>(
  section: PrefsDraftSection,
  prefs: TranslationPrefs | null,
  pick: (p: TranslationPrefs) => F,
  canSave: boolean,
) {
  const key = prefsDraftKey(section);
  const [state, setState] = useState<PrefsDraftState<F> | null>(null);
  const stateRef = useRef<PrefsDraftState<F> | null>(null);
  const [stored, setStored] = useState<{ rec: DraftRecord | undefined } | null>(null);
  // The text this tab last wrote under `key`: a clear only deletes a record
  // holding it (or the text being settled to), never another tab's (H5).
  const lastWritten = useRef<F | null>(null);
  // What the boxes showed when the last Save was clicked (toSave), so a change
  // made while that save was in flight survives its 200 (round 2, J2).
  const textAtSave = useRef<F | null>(null);
  // Discarded from the unsaved menu before this editor finished loading: the
  // stored record it read (or is reading) must not come back (#913 item 6).
  const discardedEarly = useRef(false);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  });

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

  // Store typed state as this editor's draft, stamped with who typed it.
  const write = useCallback(
    (s: PrefsDraftState<F>) => {
      lastWritten.current = s.text;
      const owner = currentUserId();
      void drafts.set(
        key,
        { text: s.text, base: s.base, ...(owner != null ? { owner } : {}) },
        s.baseVersion,
        { kind: "prefs", section },
      );
    },
    [key, section],
  );

  // Write the state and keep the store in step: a draft while a box is typed
  // in, none once nothing is.
  const commit = useCallback(
    (next: PrefsDraftState<F>) => {
      stateRef.current = next;
      setState(next);
      if (!canSave) return;
      if (typedKeys(next.text, next.base).length === 0) {
        const own = [next.text, ...(lastWritten.current ? [lastWritten.current] : [])];
        void drafts.clearIf(key, (rec) => prefsDraftClearable(rec.payload, own));
      } else {
        write(next);
      }
    },
    [key, canSave, write],
  );

  // Another tab that restored this editor's draft can delete it (a one-step
  // undo or a save there) while this editor still shows the typing. Write it
  // again, so the "N unsaved" count, the unload warning and a reload still
  // find it (#913 item 1). Only a missing record is rewritten, so two tabs
  // cannot take turns overwriting each other.
  useEffect(() => {
    if (!canSave) return;
    return drafts.subscribe(
      (all) => {
        const s = stateRef.current;
        if (s && prefsDraftLost(s.text, s.base, all.some((d) => d.key === key))) write(s);
      },
      { remote: true },
    );
  }, [key, canSave, write]);

  useEffect(() => {
    if (stateRef.current || !prefs || !stored) return;
    const rec = discardedEarly.current ? undefined : stored.rec;
    const h = hydratePrefsDraft(pick(prefs), prefs.version, canSave ? rec : undefined);
    // Delete only the record that was read, not one written since (by another
    // tab, say). A user who cannot save leaves another user's draft alone.
    if (rec && (h.clearStored || (!canSave && prefsDraftDroppable(rec.payload, currentUserId())))) {
      void drafts.clearIf(key, (r) => r.generation === rec.generation && r.updatedAt === rec.updatedAt);
    } else if (rec && canSave) {
      // The restored record is this editor's own: a later "nothing typed any
      // more" (a save, an undo) clears it even though the merged text shown
      // differs from it (round 2, J1).
      const restored = (rec.payload as { text?: F } | null)?.text;
      if (restored) lastWritten.current = restored;
    }
    const next = { text: h.text, base: h.base, baseVersion: h.baseVersion };
    stateRef.current = next;
    setState(next);
  }, [prefs, stored, key, pick, canSave]);

  // Discarded from the unsaved menu while this editor is open: show the
  // server's text again instead of keeping the thrown-away typing (H7).
  useEffect(
    () =>
      onDraftDiscarded((k) => {
        if (k !== key) return;
        const p = prefsRef.current;
        if (!stateRef.current || !p) {
          // Not loaded yet: the draft must not be restored (#913 item 6).
          discardedEarly.current = true;
          return;
        }
        const fields = pick(p);
        const next = { text: fields, base: fields, baseVersion: p.version };
        stateRef.current = next;
        lastWritten.current = null;
        // A save of the discarded typing may be in flight. Its 200 compares
        // with what the box shows now, so the box settles on the saved text
        // instead of this reset coming back as typing (#913 item 2).
        textAtSave.current = fields;
        setState(next);
      }),
    [key, pick],
  );

  useShowDraftEditors(state ? [key] : []);

  return {
    text: state?.text ?? null,
    dirty: !!state && typedKeys(state.text, state.base).length > 0,
    change: (text: F) => {
      const s = stateRef.current;
      if (s) commit({ ...s, text });
    },
    // The If-Match version and the body for a Save of the current text, or
    // null before the editor has loaded.
    toSave: (): { version: number; fields: F } | null => {
      const s = stateRef.current;
      if (!s || !prefs) return null;
      const server = pick(prefs);
      textAtSave.current = s.text;
      return {
        version: prefsVersionToSend(server, prefs.version, s.text, s.base, s.baseVersion),
        fields: prefsSavePayload(server, s.text, s.base),
      };
    },
    saved: (row: TranslationPrefs) => {
      const s = stateRef.current;
      if (s) commit(afterPrefsSave(s.text, textAtSave.current ?? s.text, pick(row), row.version));
    },
    conflicted: (current: TranslationPrefs) => {
      const s = stateRef.current;
      if (s) commit(afterPrefsConflict(s.text, s.base, pick(current), current.version));
    },
  };
}
