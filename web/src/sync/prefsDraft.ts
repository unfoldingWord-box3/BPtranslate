// Draft rules for the translation-preferences editors (Brief, Instructions,
// Common issues), on the desk Style page and the classic Preferences page
// (issue #909). Pure, so prefsDraft.test.mjs runs it without a browser.
//
// Each editor keeps its unsaved text in the drafts store together with `base`,
// the field values it was typed against, and that row's version. All three
// editors save into one prefs row with one version (#145), so a newer version
// alone says nothing about this editor's fields: a sibling's save bumps it.
// Whether this editor's text is stale is judged by its own fields.

import type { TranslationPrefs } from "./api";

export type PrefsDraftSection = "brief" | "instructions_md" | "common_issues_md";
export type PrefsFields = Record<string, string | null>;

export interface PrefsDraftPayload {
  text: PrefsFields;
  base: PrefsFields;
}

export interface PrefsDraftState<F extends PrefsFields = PrefsFields> {
  text: F;
  base: F;
  baseVersion: number;
}

export function prefsDraftKey(section: PrefsDraftSection): string {
  return `prefs:${section}`;
}

export function sameFields(a: PrefsFields, b: PrefsFields): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!(k in a) || !(k in b) || a[k] !== b[k]) return false;
  return true;
}

// The If-Match version for a Save. `server` is this editor's fields as the
// page last saw them, at `serverVersion`. While they still equal `base`,
// nothing this page knows of changed them, so the current version goes (a
// sibling's save does not conflict). Once they differ, the typed-against
// version goes, so the server answers 409 instead of the text overwriting a
// change made since.
export function prefsVersionToSend(
  server: PrefsFields,
  serverVersion: number,
  base: PrefsFields,
  baseVersion: number,
): number {
  return sameFields(server, base) ? serverVersion : baseVersion;
}

// On mount: a stored draft whose text differs from the server's comes back
// with its own base; one that equals the server's (or is not this editor's
// shape) holds nothing unsaved and is dropped.
export function hydratePrefsDraft<F extends PrefsFields>(
  server: F,
  serverVersion: number,
  stored: { payload: unknown; expectedVersion: number } | undefined,
): PrefsDraftState<F> & { clearStored: boolean } {
  const fresh = { text: server, base: server, baseVersion: serverVersion };
  if (!stored) return { ...fresh, clearStored: false };
  const p = stored.payload as Partial<PrefsDraftPayload> | null;
  const ok =
    !!p &&
    isFields(p.text) &&
    isFields(p.base) &&
    sameKeys(p.text, server) &&
    sameKeys(p.base, server);
  if (!ok || sameFields(p.text as F, server)) return { ...fresh, clearStored: true };
  return { text: p.text as F, base: p.base as F, baseVersion: stored.expectedVersion, clearStored: false };
}

// After a 409 carrying the server's row. Typed text is kept and rebased on
// that row, so the next Save goes through ("save again to apply"). An editor
// with nothing typed takes the server's text, so a second click cannot write
// the stale copy over it.
export function afterPrefsConflict<F extends PrefsFields>(
  text: F,
  base: F,
  current: F,
  currentVersion: number,
): PrefsDraftState<F> {
  const typed = !sameFields(text, base);
  return { text: typed ? text : current, base: current, baseVersion: currentVersion };
}

// After a 200: the saved fields are the new base. `text` is what the editor
// shows now, which may hold typing done while the save was in flight.
export function afterPrefsSave<F extends PrefsFields>(text: F, saved: F, savedVersion: number): PrefsDraftState<F> {
  return { text, base: saved, baseVersion: savedVersion };
}

function isFields(v: unknown): v is PrefsFields {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v).every((x) => x === null || typeof x === "string");
}

function sameKeys(a: PrefsFields, b: PrefsFields): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

// Each editor's fields, as its box shows them. Module-level, so stable for
// usePrefsDraft. Brief sends `notes` back as it was (no box edits it).
export function briefFields(p: TranslationPrefs) {
  return {
    audience: p.audience,
    purpose: p.purpose,
    register: p.register as string,
    script_notes: p.script_notes,
    notes: p.notes,
  };
}
// The markdown boxes show a missing value as "" (and save "" as null).
export const instructionsFields = (p: TranslationPrefs): PrefsFields => ({ instructions_md: p.instructions_md ?? "" });
export const commonIssuesFields = (p: TranslationPrefs): PrefsFields => ({ common_issues_md: p.common_issues_md ?? "" });
