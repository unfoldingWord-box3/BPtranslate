// Translation-preferences history (issue #788): rebuild an earlier version of
// the preferences row from its change history, so an admin can restore it.
//
// Every save writes one history entry with the previous and new value of each
// field it changed (api/src/translationMemory.ts, PUT /prefs). So version N is
// the current row with every newer entry undone, newest first: for each entry
// whose new_version > N, put each changed field's `prev` back.
//
// The caller then PUTs the result with If-Match: current.version; the restore
// is itself saved, and recorded, as a new version. Pure (no imports at
// runtime) so both the web test runner and the API test can load it.

import type { TranslationPrefs, TranslationPrefsInput } from "../sync/api";

export const PREFS_HISTORY_FIELDS = [
  "audience",
  "purpose",
  "register",
  "script_notes",
  "instructions_md",
  "common_issues_md",
  "notes",
] as const;
export type PrefsHistoryField = (typeof PREFS_HISTORY_FIELDS)[number];

export interface PrefsHistoryEntry {
  id: number;
  user_id: number | null;
  username: string | null;
  /** null = saved in the web app; "chat" = saved by the chat assistant. */
  source: string | null;
  action: string;
  prev_version: number;
  new_version: number;
  created_at: number;
  /** null when the stored change could not be read: a rebuild must not cross it. */
  changed: Partial<Record<PrefsHistoryField, { prev: string | null; new: string | null }>> | null;
}

export type RebuildResult =
  | { ok: true; fields: TranslationPrefsInput }
  | { ok: false; reason: "stale" | "gap" | "not_found" };

/**
 * The versions an admin can restore, given the entries loaded so far (newest
 * first) and whether the list is complete: every entry's new_version, plus,
 * once the oldest entry is loaded, the version before it (skipped when 0,
 * which means "never saved"). That last one matters because history only
 * starts when it was turned on: the first recorded save may be the one to undo.
 */
export function restorableVersions(entries: PrefsHistoryEntry[], complete: boolean): number[] {
  const out = entries.map((e) => e.new_version);
  const oldest = entries[entries.length - 1];
  if (complete && oldest && oldest.prev_version > 0) out.push(oldest.prev_version);
  return out;
}

/**
 * Rebuild version `target` from `current` (the row as it stands) and the
 * history entries newest first. Refuses rather than guessing:
 * - "stale": the newest entry is not the current version (a save landed
 *   after the list was read, or the list is out of date);
 * - "gap": two neighbouring entries don't chain (prev_version of one is not
 *   the new_version of the next), or an entry's change could not be read,
 *   so some change in between is unknown;
 * - "not_found": the loaded entries don't reach back to `target`.
 */
export function rebuildPrefsVersion(
  current: Pick<TranslationPrefs, PrefsHistoryField | "version">,
  entriesNewestFirst: PrefsHistoryEntry[],
  target: number,
): RebuildResult {
  const fields = {} as Record<PrefsHistoryField, string | null>;
  for (const f of PREFS_HISTORY_FIELDS) fields[f] = current[f] ?? null;
  if (target === current.version) return { ok: true, fields: fields as TranslationPrefsInput };
  if (target > current.version) return { ok: false, reason: "not_found" };
  const first = entriesNewestFirst[0];
  if (!first || first.new_version !== current.version) return { ok: false, reason: "stale" };
  let at = current.version;
  for (const e of entriesNewestFirst) {
    if (e.new_version !== at || !e.changed) return { ok: false, reason: "gap" };
    for (const [f, v] of Object.entries(e.changed)) {
      if ((PREFS_HISTORY_FIELDS as readonly string[]).includes(f) && v) {
        fields[f as PrefsHistoryField] = v.prev;
      }
    }
    at = e.prev_version;
    if (at === target) return { ok: true, fields: fields as TranslationPrefsInput };
    if (at < target) break;
  }
  return { ok: false, reason: "not_found" };
}
