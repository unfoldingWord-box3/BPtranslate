// Rapid check's status filter: which notes the list shows, by the status its
// chip shows.
//
// The options are grouped by the chip's label, not by FlowChipStatus: tn labels
// both "aiDraft" and "draft" "Draft", so one option per status would list two
// identical entries. A note's status changes while the translator works on it
// (approve, edit, type), which a type filter never has to handle, so the open
// note always stays in the list. Otherwise approving it under "hide approved",
// or typing in it under "only drafts", would pull it out from under the cursor.

import type { FlowChipStatus } from "./flowStatusChip.ts";

export type RapidStatusBucket = "draft" | "aquifer" | "unsaved" | "pending" | "approved" | "skipped";

/** Menu order: roughly the order a note moves through. */
export const RAPID_STATUS_BUCKETS: readonly RapidStatusBucket[] = [
  "draft",
  "aquifer",
  "unsaved",
  "pending",
  "approved",
  "skipped",
];

/**
 * Whether the menu offers a status. Every status is offered even with no
 * notes yet, so "hide approved" can be set before anything is approved.
 * Aquifer import is the exception: most projects never have one. A hidden
 * status that is not offered hides nothing, so it does not count as a filter.
 */
export function rapidStatusOffered(b: RapidStatusBucket, counts: ReadonlyMap<RapidStatusBucket, number>): boolean {
  return b !== "aquifer" || (counts.get(b) ?? 0) > 0;
}

/** The menu option a chip status belongs to. */
export function rapidStatusBucket(status: FlowChipStatus): RapidStatusBucket {
  switch (status) {
    case "editing":
    case "unsaved":
      return "unsaved";
    case "aiDraft":
    case "draft":
      return "draft";
    default:
      return status;
  }
}

/** Indices from `candidates` (ascending) whose bucket is not hidden. */
export function rapidStatusMatches(
  candidates: readonly number[],
  bucketAt: (idx: number) => RapidStatusBucket,
  hidden: ReadonlySet<RapidStatusBucket>,
): number[] {
  return candidates.filter((i) => !hidden.has(bucketAt(i)));
}

/**
 * The visible list: the matches plus the open note, in queue order. Returns
 * `matches` itself when the open note is already in it, so moving between
 * visible notes does not rebuild everything that depends on the list.
 * `cursorAllowed` is false when another filter (the type filter) hides the
 * open note; then it is not added back.
 */
export function withOpenNote(matches: number[], cursor: number, cursorAllowed: boolean): number[] {
  if (!cursorAllowed || matches.includes(cursor)) return matches;
  const at = matches.findIndex((i) => i > cursor);
  return at < 0 ? [...matches, cursor] : [...matches.slice(0, at), cursor, ...matches.slice(at)];
}
