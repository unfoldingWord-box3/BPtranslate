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

export interface RapidAssistantRow {
  id: string;
  chapter: number;
  verse: number;
  quote: string | null;
  note: string | null;
  version: number;
  translation_state?: string | null;
}

/**
 * The notes sent with a message, in screen order, plus the version each row
 * had at that moment (the snapshot a later Apply is checked against). A note
 * over the server's size limit is left out rather than cut, because the model
 * could then "fix" the part it never saw. When the chapter is too big for one
 * request, unchecked notes at the end of the chapter are left out first.
 */
export function buildRapidNotes(
  rows: readonly RapidAssistantRow[],
  checked: ReadonlySet<string>,
): { notes: AssistantNote[]; versions: Map<string, number> } {
  const all: AssistantNote[] = rows
    .filter((r) => (r.note ?? "").length <= MAX_NOTE_CHARS)
    .map((r) => ({
      id: r.id,
      ref: r.verse === 0 ? `${r.chapter}:intro` : `${r.chapter}:${r.verse}`,
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
  const version = new Map(rows.map((r) => [r.id, r.version]));
  return { notes, versions: new Map(notes.map((n) => [n.id, version.get(n.id) as number])) };
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
