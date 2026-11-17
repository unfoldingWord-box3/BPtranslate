import { useCallback, useEffect, useRef, useState } from "react";
import { announcePrefsDraft, drafts, onDraftDiscarded, onPrefsDraftElsewhere, type DraftRecord } from "../sync/drafts";
import { useShowDraftEditors } from "../sync/draftEditors";
import { currentUserId, type TranslationPrefs } from "../sync/api";
import {
  afterPrefsConflict,
  afterPrefsSave,
  afterPrefsSavedElsewhere,
  hydratePrefsDraft,
  newestPrefs,
  prefsAfterConflict,
  prefsDiscardMatches,
  prefsDraftClearable,
  prefsDraftDroppable,
  prefsDraftKey,
  prefsDraftLost,
  prefsOwnDraftKey,
  prefsRestorable,
  prefsSavePayload,
  prefsVersionToSend,
  sameFields,
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
// that cannot be saved (#909 gate review H2). Each draft records who typed it
// (#913 item 5) and, since #928, is stored under that person's own key, so on
// a shared browser one admin's typing is neither shown to nor overwritten by
// another. The old shared key is still read for the viewer's own or ownerless
// record, which moves to the viewer's key on their first change; another
// person's record there is left alone.
export function usePrefsDraft<F extends PrefsFields>(
  section: PrefsDraftSection,
  prefs: TranslationPrefs | null,
  pick: (p: TranslationPrefs) => F,
  canSave: boolean,
) {
  const userId = currentUserId();
  const sharedKey = prefsDraftKey(section);
  const key = userId != null ? prefsOwnDraftKey(section, userId) : sharedKey;
  // Signed out (the app does not show these editors then): nothing is stored
  // or restored, so no record can be written without an owner (#928).
  const store = canSave && userId != null;
  const [state, setState] = useState<PrefsDraftState<F> | null>(null);
  const stateRef = useRef<PrefsDraftState<F> | null>(null);
  const [stored, setStored] = useState<{ own: DraftRecord | undefined; shared: DraftRecord | undefined } | null>(
    null,
  );
  // The record under the old shared key that this editor restored (#928):
  // still where it was until this editor first writes, then moved to `key`.
  // While set, that key is this editor's too (discards, the write-back).
  const fromShared = useRef<{ generation?: string; updatedAt: number } | null>(null);
  // The text this tab last wrote under `key`: a clear only deletes a record
  // holding it (or the text being settled to), never another tab's (H5).
  const lastWritten = useRef<F | null>(null);
  // What the boxes showed when the last Save was clicked (toSave), so a change
  // made while that save was in flight survives its 200 (round 2, J2).
  const textAtSave = useRef<F | null>(null);
  // Discarded from the unsaved menu before this editor finished loading: the
  // stored record it read (or is reading) under that key must not come back
  // (#913 item 6).
  const discardedEarly = useRef(new Set<string>());
  // The same, when the discard came from another tab: only a record holding
  // the discarded text is ignored (round 2, B3).
  const discardedElsewhere = useRef(new Map<string, PrefsFields>());
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  });

  useEffect(() => {
    let cancelled = false;
    const get = (k: string) => drafts.get(k).catch(() => undefined);
    void Promise.all([get(key), key === sharedKey ? undefined : get(sharedKey)]).then(([own, shared]) => {
      if (!cancelled) setStored({ own, shared });
    });
    return () => {
      cancelled = true;
    };
  }, [key, sharedKey]);

  // Delete the shared-key record this editor restored, once its text is under
  // `key` (or nothing is typed any more). Only that exact record: another
  // tab's newer one is not this editor's to delete.
  const dropShared = useCallback(() => {
    const old = fromShared.current;
    if (!old) return;
    fromShared.current = null;
    void drafts.clearIf(sharedKey, (r) => r.generation === old.generation && r.updatedAt === old.updatedAt);
  }, [sharedKey]);

  // Store typed state as this editor's draft, stamped with who typed it.
  // `ifAbsent`: only when no record is stored (the write-back below, B4), and
  // only while the box still shows that typing: another tab's discard handled
  // after the write-back started has reset it (#922 item 1).
  const write = useCallback(
    (s: PrefsDraftState<F>, ifAbsent = false) => {
      lastWritten.current = s.text;
      const owner = currentUserId();
      const payload = { text: s.text, base: s.base, ...(owner != null ? { owner } : {}) };
      const meta = { kind: "prefs" as const, section };
      const still = () => {
        const cur = stateRef.current;
        return !!cur && sameFields(cur.text, s.text) && typedKeys(cur.text, cur.base).length > 0;
      };
      const written = ifAbsent
        ? drafts.setIfAbsent(key, payload, s.baseVersion, meta, still)
        : drafts.set(key, payload, s.baseVersion, meta);
      // A restored shared-key record moves here (#928): deleted once a record
      // is stored under `key`, never before, so the typing is always stored.
      if (fromShared.current) {
        void written
          .then(() => drafts.get(key))
          .then((rec) => {
            if (rec) dropShared();
          })
          .catch(() => undefined);
      }
    },
    [key, section, dropShared],
  );

  // Write the state and keep the store in step: a draft while a box is typed
  // in, none once nothing is.
  const commit = useCallback(
    (next: PrefsDraftState<F>) => {
      stateRef.current = next;
      setState(next);
      if (!store) return;
      if (typedKeys(next.text, next.base).length === 0) {
        // Nothing unsaved here any more, whoever deletes the record: another
        // tab's clear can get to it first (a save there of the same text), and
        // this tab's unload guard must not keep warning (review B2).
        drafts.forget(key);
        const own = [next.text, ...(lastWritten.current ? [lastWritten.current] : [])];
        void drafts.clearIf(key, (rec) => prefsDraftClearable(rec.payload, own));
        dropShared();
      } else {
        write(next);
      }
    },
    [key, store, write, dropShared],
  );

  // Another tab that restored this editor's draft can delete it (a one-step
  // undo or a save there) while this editor still shows the typing. Write it
  // again, so the "N unsaved" count, the unload warning and a reload still
  // find it (#913 item 1). Only a missing record is rewritten, and only while
  // it is still missing (one transaction, review B4), so two tabs cannot take
  // turns overwriting each other and newer typing from another tab is kept.
  // A restored shared-key record not yet moved counts as this editor's (#928).
  useEffect(() => {
    if (!store) return;
    return drafts.subscribe(
      (all) => {
        const s = stateRef.current;
        const held = all.some((d) => d.key === key || (!!fromShared.current && d.key === sharedKey));
        if (s && prefsDraftLost(s.text, s.base, held)) write(s, true);
      },
      { remote: true },
    );
  }, [key, sharedKey, store, write]);

  useEffect(() => {
    if (stateRef.current || !prefs || !stored) return;
    // Only the viewer's own (or an ownerless) record; another person's typing
    // is neither shown nor touched (#928).
    const read = prefsRestorable(stored.own, stored.shared, userId);
    const readText = (read?.payload as { text?: PrefsFields } | null | undefined)?.text;
    const thrownText = read && discardedElsewhere.current.get(read.key);
    const thrownAway =
      !!read &&
      (discardedEarly.current.has(read.key) || (!!thrownText && !!readText && sameFields(readText, thrownText)));
    const rec = thrownAway ? undefined : read;
    const h = hydratePrefsDraft(pick(prefs), prefs.version, store ? rec : undefined);
    // Delete only the record that was read, not one written since (by another
    // tab, say). A user who cannot save leaves another user's draft alone.
    if (rec && (h.clearStored || (!canSave && prefsDraftDroppable(rec.payload, userId)))) {
      void drafts.clearIf(rec.key, (r) => r.generation === rec.generation && r.updatedAt === rec.updatedAt);
    } else if (rec && store) {
      // The restored record is this editor's own: a later "nothing typed any
      // more" (a save, an undo) clears it even though the merged text shown
      // differs from it (round 2, J1).
      const restored = (rec.payload as { text?: F } | null)?.text;
      if (restored) lastWritten.current = restored;
      if (rec.key !== key) fromShared.current = { generation: rec.generation, updatedAt: rec.updatedAt };
    }
    const next = { text: h.text, base: h.base, baseVersion: h.baseVersion };
    stateRef.current = next;
    setState(next);
  }, [prefs, stored, key, pick, canSave, store, userId]);

  // Whether a discard of `k` is of this editor's record: its own key, or the
  // shared key while that is where its typing is stored (restored from there
  // and not yet moved, or not loaded yet; #928).
  const mine = useCallback(
    (k: string) => k === key || (k === sharedKey && (!stateRef.current || !!fromShared.current)),
    [key, sharedKey],
  );

  // Discarded from the unsaved menu, in this tab or another one (#913 review
  // A1), while this editor is open: show the server's text again instead of
  // keeping the thrown-away typing (H7). Nothing is written.
  const discarded = useCallback((k: string) => {
    const s = stateRef.current;
    if (!s) {
      // Not loaded yet: the draft must not be restored (#913 item 6).
      discardedEarly.current.add(k);
      return;
    }
    // The server's text as this page knows it; if the prefs row is gone for
    // now, the text the typing started from (review C1).
    const p = prefsRef.current;
    const fields = p ? pick(p) : s.base;
    const next = { text: fields, base: fields, baseVersion: p ? p.version : s.baseVersion };
    stateRef.current = next;
    lastWritten.current = null;
    fromShared.current = null;
    // A save of the discarded typing may be in flight. Its 200 compares
    // with what the box shows now, so the box settles on the saved text
    // instead of this reset coming back as typing (#913 item 2).
    textAtSave.current = fields;
    setState(next);
  }, [pick]);
  useEffect(
    () =>
      onDraftDiscarded((k) => {
        if (mine(k)) discarded(k);
      }),
    [mine, discarded],
  );

  // Another tab discarded this draft (A1) or saved this editor's fields (A2).
  useEffect(
    () =>
      onPrefsDraftElsewhere((m) => {
        if (m.type === "prefs-discard" ? !mine(m.key) : m.key !== key) return;
        const s = stateRef.current;
        if (m.type === "prefs-discard") {
          if (!s) {
            discardedElsewhere.current.set(m.key, m.text);
            return;
          }
          // Only the text thrown away is reset; other typing here stays, and
          // the write-back above stores it once the record is gone (B3).
          if (!prefsDiscardMatches(s.text, s.base, m.text)) return;
          discarded(m.key);
          // This tab no longer holds unsaved typing (B2). If this tab's own
          // write-back got in first, the discarded text is stored again:
          // delete it, and only it (B3).
          drafts.forget(key);
          void drafts.clearIf(key, (rec) => prefsDraftClearable(rec.payload, [m.text]));
          return;
        }
        // Saved: when every box typed here holds the saved text, this editor
        // is clean on the saved row (the page's prefs state takes that row
        // too, useTranslationPrefs).
        // Not newer than the row this page holds: an old message (C3).
        const p = prefsRef.current;
        if (p && m.row.version < p.version) return;
        const next = s && afterPrefsSavedElsewhere(s, pick(m.row as unknown as TranslationPrefs), m.row.version);
        // commit() drops this tab's unsaved mark (B2).
        if (next) commit(next);
      }),
    [key, mine, discarded, commit, pick],
  );

  useShowDraftEditors(state ? (key === sharedKey ? [key] : [key, sharedKey]) : []);

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
      if (!s) return;
      // Posted before this tab's draft is cleared, so another tab showing the
      // saved text is clean before it can see the record gone (#913 A2).
      announcePrefsDraft({ type: "prefs-saved", key, row: row as unknown as Record<string, unknown> & { version: number } });
      // Settle on the newest row this page knows: another tab's newer save
      // may have arrived (and been taken) while this response was on its
      // way. Settling on the older response would show stale boxes and send
      // a stale version next time (#913 review D1).
      const latest = newestPrefs(prefsRef.current, row);
      commit(afterPrefsSave(s.text, textAtSave.current ?? s.text, pick(latest), latest.version));
    },
    // `sent`: the If-Match of the Save that got the 409. A late 409 body
    // older than the row this page holds is not taken, unless the version
    // went down (an admin database restore, #922 item 2; prefsAfterConflict).
    conflicted: (current: TranslationPrefs, sent: number) => {
      const s = stateRef.current;
      const latest = prefsAfterConflict(prefsRef.current, current, sent);
      if (s) commit(afterPrefsConflict(s.text, s.base, pick(latest), latest.version));
    },
  };
}
