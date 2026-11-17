// What Rapid check tells the assistant (issue #858), and how a proposal is
// matched back to the notes it was made about. Pure: no React, no network.

import type { AssistantNote } from "../../sync/api.ts";

// Server limits (api/src/assistant, the contract): 1..200 notes, 6000 chars of
// text per note, 200 KB for the whole JSON body.
export const MAX_NOTES = 200;
export const MAX_NOTE_CHARS = 6000;
// UTF-8 bytes, like the server's 200 KB body limit: Arabic and Hebrew take two
// bytes a character. The rest of the body (the chat turns) needs room too.
const MAX_NOTES_JSON_BYTES = 120_000;
const utf8 = new TextEncoder();

/** Notes left out of a request: over the per-note size limit, or past the count/byte budget. */
export interface RapidOmitted {
  tooLong: number;
  tooMany: number;
  tooLongRefs: string[];
  tooManyRefs: string[];
}

export interface RapidAssistantRow {
  id: string;
  chapter: number;
  verse: number;
  quote: string | null;
  note: string | null;
  version: number;
  translation_state?: string | null;
}

/** What a later Apply is checked against: each sent note's version and approval state. */
export interface RapidSnapshot {
  versions: ReadonlyMap<string, number>;
  /** translation_state, null when the row has none. Approving does not bump the version (#860). */
  states: ReadonlyMap<string, string | null>;
}

/**
 * The notes sent with a message, in screen order, plus the version and state each row
 * had at that moment (the snapshot a later Apply is checked against). A note
 * over the server's size limit is left out rather than cut, because the model
 * could then "fix" the part it never saw. When the chapter is too big for one
 * request, unchecked notes at the end of the chapter are left out first.
 * `omitted` says what was left out and why (issue #859), one ref per note, so
 * the panel can tell the user.
 */
export function buildRapidNotes(
  rows: readonly RapidAssistantRow[],
  checked: ReadonlySet<string>,
): { notes: AssistantNote[]; versions: Map<string, number>; states: Map<string, string | null>; omitted: RapidOmitted } {
  const refOf = (r: RapidAssistantRow) => (r.verse === 0 ? `${r.chapter}:intro` : `${r.chapter}:${r.verse}`);
  const tooLongRefs = rows.filter((r) => (r.note ?? "").length > MAX_NOTE_CHARS).map(refOf);
  const all: AssistantNote[] = rows
    .filter((r) => (r.note ?? "").length <= MAX_NOTE_CHARS)
    .map((r) => ({
      id: r.id,
      ref: refOf(r),
      quote: r.quote,
      note: r.note ?? "",
      state: r.translation_state ?? null,
      checked: checked.has(r.id),
    }));
  const keep = new Set<string>();
  let size = 2;
  const fits = (n: AssistantNote) => {
    const add = utf8.encode(JSON.stringify(n)).length + 1;
    if (keep.size >= MAX_NOTES || size + add > MAX_NOTES_JSON_BYTES) return false;
    size += add;
    keep.add(n.id);
    return true;
  };
  for (const n of all) if (n.checked) fits(n);
  for (const n of all) if (!n.checked) fits(n);
  const notes = all.filter((n) => keep.has(n.id));
  // Not a tail slice: a later, smaller note can still fit after a bigger one did not.
  const tooManyRefs = all.filter((n) => !keep.has(n.id)).map((n) => n.ref);
  const version = new Map(rows.map((r) => [r.id, r.version]));
  return {
    notes,
    versions: new Map(notes.map((n) => [n.id, version.get(n.id) as number])),
    states: new Map(notes.map((n) => [n.id, n.state])),
    omitted: { tooLong: tooLongRefs.length, tooMany: tooManyRefs.length, tooLongRefs, tooManyRefs },
  };
}

type SnapRow = { version: number; translation_state?: string | null };

/**
 * How a note differs from the snapshot: `changed` for a new version (someone's
 * edit) or no snapshot entry; `stateChanged` for the same version with another
 * approval state, since approving does not bump the version (#878); null when
 * it is as the assistant saw it.
 */
export function snapshotMismatch(id: string, snap: RapidSnapshot, r: SnapRow): "changed" | "stateChanged" | null {
  if (snap.versions.get(id) !== r.version || !snap.states.has(id)) return "changed";
  if (snap.states.get(id) !== (r.translation_state ?? null)) return "stateChanged";
  return null;
}

/**
 * Split a proposal's Approve or Not needed ids into the rows still as the
 * assistant saw them and the rest, counted by `snapshotMismatch`'s reason; a
 * row no longer on the screen is `missing`, which the result line reports as
 * a failure.
 */
export function stillAsProposed(
  ids: readonly string[],
  snap: RapidSnapshot,
  rowById: ReadonlyMap<string, SnapRow>,
): { ids: string[]; changed: number; stateChanged: number; missing: number } {
  const out: string[] = [];
  let changed = 0;
  let stateChanged = 0;
  let missing = 0;
  for (const id of ids) {
    const r = rowById.get(id);
    const why = r ? snapshotMismatch(id, snap, r) : null;
    if (!r) missing++;
    else if (why === "changed") changed++;
    else if (why === "stateChanged") stateChanged++;
    else out.push(id);
  }
  return { ids: out, changed, stateChanged, missing };
}

/**
 * The Rapid status table after the server refused an assistant edit with
 * state_mismatch (#883 item 1). The table is seeded once per chapter, so a
 * refetch alone leaves the circle showing what this tab saw before: set it
 * from `current`, the row in the 409 body. Approved shows Approved, set aside
 * shows Not needed, anything else clears the mark (as un-approve's 409 does),
 * a Not needed mark included: the note is live on the server (#886 item 4).
 * Returns `prev` itself when nothing changes.
 */
export function statusesAfterRefusal(
  prev: Record<string, "approved" | "skipped">,
  id: string,
  current: { translation_state?: string | null; trashed_at?: number | null } | null | undefined,
): Record<string, "approved" | "skipped"> {
  if (!current || typeof current !== "object") return prev;
  const want = current.trashed_at != null ? "skipped" : current.translation_state === "validated" ? "approved" : undefined;
  if (want !== undefined) return prev[id] === want ? prev : { ...prev, [id]: want };
  if (prev[id] === undefined) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

/**
 * The Rapid status table after an assistant edit saved (#883 review A1). The
 * server's row decides when the response carries it: usually the edit demoted
 * the note to 'edited', but a resend whose first response was lost is a no-op
 * that returns the note as it is now, maybe approved by a colleague since.
 * Without a usable row, the edit takes the note off its mark, like a typed save.
 */
export function statusesAfterEdit(
  prev: Record<string, "approved" | "skipped">,
  id: string,
  updated: { id?: unknown; version?: unknown; translation_state?: string | null; trashed_at?: number | null } | null | undefined,
): Record<string, "approved" | "skipped"> {
  if (updated && updated.id === id && typeof updated.version === "number") return statusesAfterRefusal(prev, id, updated);
  if (prev[id] === undefined) return prev;
  const next = { ...prev };
  delete next[id];
  return next;
}

/**
 * The Rapid status table after the outbox saved an assistant edit, heard by
 * the screen's outbox listener (#886 item 4). That covers a save that lands
 * after Apply stopped waiting, which Apply itself never sees. Only an
 * assistant edit (a patch carrying an expected_state pin) whose saved row is
 * usable and in this chapter changes the table, through statusesAfterEdit;
 * typed saves keep their own handling. Returns `prev` itself otherwise.
 */
export function statusesAfterAssistantSave(
  prev: Record<string, "approved" | "skipped">,
  op: { action: string; expectedState?: string | null; target: { id: string } },
  updated:
    | { id?: unknown; version?: unknown; chapter?: unknown; translation_state?: string | null; trashed_at?: number | null }
    | null
    | undefined,
  chapter: number,
): Record<string, "approved" | "skipped"> {
  if (op.action !== "patch" || op.expectedState === undefined) return prev;
  if (!updated || updated.id !== op.target.id || typeof updated.version !== "number" || updated.chapter !== chapter) return prev;
  return statusesAfterEdit(prev, op.target.id, updated);
}

/**
 * Attach the captured version to each proposed edit. An edit for a note that
 * was not in the snapshot cannot be checked for changes, so it is not applied.
 */
export function editsWithVersions(
  edits: readonly { id: string; note: string }[],
  versions: ReadonlyMap<string, number>,
): { id: string; note: string; version: number }[] {
  return edits.flatMap((e) => {
    const version = versions.get(e.id);
    return version === undefined ? [] : [{ id: e.id, note: e.note, version }];
  });
}
