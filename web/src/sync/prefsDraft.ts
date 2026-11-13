// Draft rules for the translation-preferences editors (Brief, Instructions,
// Common issues), on the desk Style page and the classic Preferences page
// (issue #909). Pure, so prefsDraft.test.mjs runs it without a browser.
//
// Each editor keeps its unsaved text in the drafts store together with `base`,
// the field values it was typed against, and that row's version. All three
// editors save into one prefs row with one version (#145), so a newer version
// alone says nothing about this editor's fields: a sibling's save bumps it.
// Whether this editor's text is stale is judged by its own fields, and within
// Brief box by box: a box is "typed" when its text differs from its base, and
// only typed boxes are the editor's own. Every other box (and the hidden
// `notes`) takes the server's value whenever the editor learns it, so a
// remount or a "save again" never brings back a stale copy of a box nobody
// typed in (#909 gate review H1).

import type { TranslationPrefs } from "./api";

export type PrefsDraftSection = "brief" | "instructions_md" | "common_issues_md";
export type PrefsFields = Record<string, string | null>;

export interface PrefsDraftPayload {
  text: PrefsFields;
  base: PrefsFields;
  // The id of the user who typed it (#913 item 5). Absent on drafts written
  // before it was recorded.
  owner?: number;
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

// The boxes typed in: text differs from the value it was typed against.
export function typedKeys(text: PrefsFields, base: PrefsFields): string[] {
  return Object.keys(text).filter((k) => text[k] !== base[k]);
}

// The If-Match version for a Save. `server` is this editor's fields as the
// page last saw them, at `serverVersion`. While every typed box (every box,
// when none is typed) still has its base value there, nothing this page knows
// of changed it, so the current version goes (a sibling's save does not
// conflict). Otherwise the typed-against version goes, so the server answers
// 409 instead of the text overwriting a change made since.
export function prefsVersionToSend(
  server: PrefsFields,
  serverVersion: number,
  text: PrefsFields,
  base: PrefsFields,
  baseVersion: number,
): number {
  const typed = typedKeys(text, base);
  const keys = typed.length ? typed : Object.keys(base);
  return keys.every((k) => server[k] === base[k]) ? serverVersion : baseVersion;
}

// What a Save sends: the typed boxes, and the server's value for every other
// field (the PUT always carries Brief's whole field set). With nothing typed,
// the shown text, which prefsVersionToSend makes a 409 when it is stale.
export function prefsSavePayload<F extends PrefsFields>(server: F, text: F, base: F): F {
  const typed = typedKeys(text, base);
  if (!typed.length) return text;
  const out = { ...server };
  for (const k of typed) (out as PrefsFields)[k] = text[k];
  return out;
}

// Keep the typed boxes of `text` (against `base`); every other box takes
// `server`'s value as text and base.
function mergeTyped<F extends PrefsFields>(text: F, base: F, server: F): { text: F; base: F; typed: string[] } {
  const typed = typedKeys(text, base).filter((k) => text[k] !== server[k]);
  const t = { ...server };
  const b = { ...server };
  for (const k of typed) {
    (t as PrefsFields)[k] = text[k];
    (b as PrefsFields)[k] = base[k];
  }
  return { text: t, base: b, typed };
}

// On mount: a stored draft's typed boxes come back with their own base; every
// other box shows the server's value. A draft with no typed box left (or not
// this editor's shape) holds nothing unsaved and is dropped.
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
  if (!ok) return { ...fresh, clearStored: true };
  const m = mergeTyped(p.text as F, p.base as F, server);
  if (!m.typed.length) return { ...fresh, clearStored: true };
  return { text: m.text, base: m.base, baseVersion: stored.expectedVersion, clearStored: false };
}

// After a 409 carrying the server's row. Typed boxes are kept and rebased on
// that row, so the next Save goes through ("save again to apply"); every other
// box takes the server's value, so a second click cannot write a stale copy.
export function afterPrefsConflict<F extends PrefsFields>(
  text: F,
  base: F,
  current: F,
  currentVersion: number,
): PrefsDraftState<F> {
  const out = { ...current };
  for (const k of typedKeys(text, base)) (out as PrefsFields)[k] = text[k];
  return { text: out, base: current, baseVersion: currentVersion };
}

// After a 200: the saved fields are the new base. `textAtSave` is what the
// boxes showed when Save was clicked. A box changed since then (typing, or an
// undo, while the save was in flight) keeps what it shows now, as typing
// against the saved value; every other box shows the saved value (round 2,
// J2: comparing with the old base instead lost an undo made in flight).
export function afterPrefsSave<F extends PrefsFields>(
  textNow: F,
  textAtSave: F,
  saved: F,
  savedVersion: number,
): PrefsDraftState<F> {
  const out = { ...saved };
  for (const k of typedKeys(textNow, textAtSave)) (out as PrefsFields)[k] = textNow[k];
  return { text: out, base: saved, baseVersion: savedVersion };
}

// Whether a stored prefs draft may be deleted by this tab: only when it holds
// one of `texts` (what this tab last wrote, or what it is settling to). The
// store is shared by every tab of the workspace, so another tab's newer typing
// under the same key is never cleared (#909 gate review H5).
export function prefsDraftClearable(payload: unknown, texts: PrefsFields[]): boolean {
  const p = payload as Partial<PrefsDraftPayload> | null;
  if (!p || !isFields(p.text)) return false;
  return texts.some((t) => sameFields(p.text as PrefsFields, t));
}

// Whether this editor's draft has gone from the store while the editor still
// shows typed text: another tab that restored it deleted it (a one-step undo
// or a save there, #913 item 1). The editor then writes it again, so the
// "N unsaved" count, the unload warning and a reload still find the typing
// this tab is showing.
export function prefsDraftLost(text: PrefsFields, base: PrefsFields, stored: boolean): boolean {
  return !stored && typedKeys(text, base).length > 0;
}

// Whether a user who cannot save may delete a stored prefs draft when the
// editor opens (#909 gate review H2): only one they typed themselves, before
// they lost the right to save. The store is per workspace, not per user, so on
// a shared browser it can hold an admin's typing, which is left alone, as is a
// draft with no author recorded (#913 item 5).
export function prefsDraftDroppable(payload: unknown, userId: number | null): boolean {
  const p = payload as Partial<PrefsDraftPayload> | null;
  return userId != null && !!p && p.owner === userId;
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
