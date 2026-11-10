// Rapid check's checked rows (#829): which notes are checked, and where a
// Shift range starts. The selection belongs to one chapter (`scope`) and only
// ever holds rows that are on screen. When the row set changes inside the
// chapter (the status filter hides a just-approved note, the open note moves
// off a hidden status, another user's change arrives), the checks on rows that
// are still shown are kept and the rest are dropped for good, so a hidden note
// is never acted on and never comes back checked. Without a filter the list
// is one verse, so another verse's rows share none of the checked ones and
// the selection empties.

export interface RapidSelection {
  scope: string;
  ids: ReadonlySet<string>;
  /** Where a Shift range starts; null falls back to the open note. */
  anchor: string | null;
}

export const NO_RAPID_SELECTION: RapidSelection = { scope: "", ids: new Set(), anchor: null };

/**
 * The selection carried onto the rows now on screen. Returns `prev` itself
 * when nothing changes, so a caller can apply it during render without looping.
 */
export function carryRapidSelection(prev: RapidSelection, scope: string, rowIds: readonly string[]): RapidSelection {
  if (prev.scope !== scope) return { scope, ids: new Set(), anchor: null };
  if (prev.ids.size === 0 && prev.anchor === null) return prev;
  const shown = new Set(rowIds);
  const ids = [...prev.ids].filter((id) => shown.has(id));
  const anchor = prev.anchor != null && shown.has(prev.anchor) ? prev.anchor : null;
  if (ids.length === prev.ids.size && anchor === prev.anchor) return prev;
  return { scope, ids: new Set(ids), anchor };
}
