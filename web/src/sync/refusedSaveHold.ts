// Keep a refused save's text on screen when the cached row is rebuilt (issue
// #637 item 1). The classic row editors (QuestionsTable, QuestionCard,
// WordsTable, NoteCard with no session open) adopt a field's new row value
// whenever the user has not edited it since the last one (reconcileField). A
// Save patches the cached row with the typed text, so once the server refuses
// that save and the row is rebuilt to the server's copy, the field would adopt
// the server's value and the typed text would leave the screen (the data loss
// that sank PR #642). The editor remembers the patches it sent; when one of
// those ops is refused or dropped as "locked" it holds the sent values, and a
// field still showing a held value is not replaced by the row's. Against the
// rebuilt row the field then shows as unsaved, so Save is enabled again; the
// drafts store keeps the same text (refusedRowDraft.ts). Discarding the failed
// op ends its hold, and the editor puts the row's value back in each field
// still showing the discarded text.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (refusedSaveHold.test.mjs).

import type { OutboxOp, OutboxResult } from "./outbox.ts";
import { isPendingRowSave, rowSaveEnded } from "./draftSaveState.ts";
import { rebuildsAfterResult } from "./outboxTargeting.ts";

export type Fields = Record<string, unknown>;
export interface HoldState {
  /** Patches this editor's Saves sent, while their ops can still land. */
  sent: Fields[];
  /** Patches the server refused, while the user has not discarded them. */
  held: Fields[];
}
export interface HoldTarget {
  rowKind: string;
  id: string;
  book: string;
}

export const EMPTY_HOLD: HoldState = { sent: [], held: [] };

type ResultOp = Pick<OutboxOp, "target" | "patch"> & Partial<Pick<OutboxOp, "action">>;

// A Save. Its patch is watched. Held refusals end: the editor diffs against
// the rebuilt row, so this save sends every held text the editor still shows.
// Only the last MAX_WATCHED saves are watched: results reach only the tab that
// drains, so in a tab that does not, nothing would ever end a watch.
export const MAX_WATCHED = 20;
export function holdOnSave(state: HoldState, patch: Fields): HoldState {
  return { sent: [...state.sent, patch].slice(-MAX_WATCHED), held: [] };
}

// An outbox result. Only an op that sent one of this editor's patches counts
// (matched by content, isPendingRowSave). A 200 ends its watch; a refusal that
// rebuilds the row (rebuildsAfterResult) moves it to the held list; a 409 or a
// retry keeps watching. Returns `state` itself when nothing changes.
export function holdOnResult(state: HoldState, op: ResultOp, result: OutboxResult, target: HoldTarget): HoldState {
  if (!rowSaveEnded(result)) return state;
  const i = state.sent.findIndex((p) => isPendingRowSave(p, op, target));
  if (i < 0) {
    // A held save the user retried (Retry in the status bar) that landed: its
    // text is on the server now, so the hold ends.
    const h = result.kind === "ok" ? state.held.findIndex((p) => isPendingRowSave(p, op, target)) : -1;
    return h < 0 ? state : { sent: state.sent, held: state.held.filter((_, j) => j !== h) };
  }
  const sent = state.sent.filter((_, j) => j !== i);
  return { sent, held: rebuildsAfterResult(result) ? [...state.held, state.sent[i]] : state.held };
}

// An op the user dropped from the outbox (Discard of a failed save, keep
// theirs or Discard of a conflict). It ends that op's watch and hold. The held
// patch it ends is returned, so the editor can put the row's value back in
// each field still showing it. Returns `state` itself when nothing changes.
export function holdOnDrop(
  state: HoldState,
  op: ResultOp,
  target: HoldTarget,
): { state: HoldState; released: Fields | null } {
  const s = state.sent.findIndex((p) => isPendingRowSave(p, op, target));
  const h = state.held.findIndex((p) => isPendingRowSave(p, op, target));
  if (s < 0 && h < 0) return { state, released: null };
  return {
    state: {
      sent: s < 0 ? state.sent : state.sent.filter((_, j) => j !== s),
      held: h < 0 ? state.held : state.held.filter((_, j) => j !== h),
    },
    released: h < 0 ? null : state.held[h],
  };
}

// Whether a field showing `local` keeps it instead of adopting the row's new
// value: it still shows text a refused save sent. `local` is in the form the
// editor's Save sends.
export function keepsHeldText(state: HoldState, field: string, local: unknown): boolean {
  return state.held.some((p) => field in p && p[field] === local);
}
