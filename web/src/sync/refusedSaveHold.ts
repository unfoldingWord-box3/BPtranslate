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
// drafts store keeps the same text (refusedRowDraft.ts).
//
// A hold ends, field by field, when:
//   * a later Save sends that field (it carries what the editor shows now);
//   * the held save is retried and lands;
//   * the user discards the held save, or the row's draft (the editor then
//     puts the row's value back in each field still showing the held text);
//   * the cached row moves past the version the save was sent at (review A3):
//     another user's save or an AI apply after a "locked" drop. The editor then
//     adopts the newer server value where it still shows the held text, as on
//     main, and the drafts store keeps the user's text as a refused draft, so
//     no newer server text is overwritten without a 409.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (refusedSaveHold.test.mjs).

import type { OutboxOp, OutboxResult } from "./outbox.ts";
import { isPendingRowSave, rowSaveEnded } from "./draftSaveState.ts";
import { rebuildsAfterResult } from "./outboxTargeting.ts";

export type Fields = Record<string, unknown>;
/** One Save: the patch as sent (matched against outbox ops) and the row version it was sent at. */
export interface SentSave {
  patch: Fields;
  version: number;
}
/** A refused Save: `fields` is the part of its patch still held. */
export interface HeldSave extends SentSave {
  fields: Fields;
}
export interface HoldState {
  /** Saves whose ops can still land. */
  sent: SentSave[];
  /** Refused saves with fields still held. */
  held: HeldSave[];
}
export interface HoldTarget {
  rowKind: string;
  id: string;
  book: string;
}

export const EMPTY_HOLD: HoldState = { sent: [], held: [] };

type ResultOp = Pick<OutboxOp, "target" | "patch"> & Partial<Pick<OutboxOp, "action">>;

// The held list with `fields` removed from every entry (entries left empty go).
function withoutFields(held: HeldSave[], fields: Iterable<string>): HeldSave[] {
  const drop = new Set(fields);
  const out: HeldSave[] = [];
  for (const h of held) {
    const rest: Fields = {};
    for (const [k, v] of Object.entries(h.fields)) if (!drop.has(k)) rest[k] = v;
    if (Object.keys(rest).length > 0) out.push({ ...h, fields: rest });
  }
  return out;
}

// A Save of `patch` at row version `version`. Its patch is watched, and the
// fields it sends are no longer held (review A5): it sends what the editor
// shows now. Fields it does not send stay held until their own outcome.
// Only the last MAX_WATCHED saves are watched: results reach only the tab that
// drains, so in a tab that does not, nothing would ever end a watch.
export const MAX_WATCHED = 20;
export function holdOnSave(state: HoldState, patch: Fields, version: number): HoldState {
  return {
    sent: [...state.sent, { patch, version }].slice(-MAX_WATCHED),
    held: withoutFields(state.held, Object.keys(patch)),
  };
}

// An outbox result. Only an op that sent one of this editor's patches counts
// (matched by content, isPendingRowSave). A 200 ends its watch; a refusal that
// rebuilds the row (rebuildsAfterResult) moves it to the held list; a 409 or a
// retry keeps watching. A held save the user retried (Retry in the status bar)
// that lands ends its hold. Returns `state` itself when nothing changes.
export function holdOnResult(state: HoldState, op: ResultOp, result: OutboxResult, target: HoldTarget): HoldState {
  if (!rowSaveEnded(result)) return state;
  const i = state.sent.findIndex((s) => isPendingRowSave(s.patch, op, target));
  if (i < 0) {
    const h = result.kind === "ok" ? state.held.findIndex((s) => isPendingRowSave(s.patch, op, target)) : -1;
    return h < 0 ? state : { sent: state.sent, held: state.held.filter((_, j) => j !== h) };
  }
  const sent = state.sent.filter((_, j) => j !== i);
  if (result.kind === "ok") {
    // This editor's own save moved the row one version on, with nobody
    // else's write between (it was sent at version v and landed at v+1): the
    // server did not move past the held text, so the holds follow the row's
    // new version instead of ending in holdOnRowVersion.
    const landed = (result.updated as { version?: unknown } | null | undefined)?.version;
    const from = state.sent[i].version;
    if (typeof landed !== "number" || landed !== from + 1) return { sent, held: state.held };
    return { sent, held: state.held.map((h) => (h.version === from ? { ...h, version: landed } : h)) };
  }
  if (!rebuildsAfterResult(result)) return { sent, held: state.held };
  const s = state.sent[i];
  return { sent, held: [...state.held, { ...s, fields: { ...s.patch } }] };
}

// An op the user dropped from the outbox (Discard of a failed save, keep
// theirs or Discard of a conflict). It ends that op's watch and hold. The
// fields still held for it are returned, so the editor can put the row's value
// back in each field still showing them. Returns `state` itself when nothing
// changes.
export function holdOnDrop(
  state: HoldState,
  op: ResultOp,
  target: HoldTarget,
): { state: HoldState; released: Fields | null } {
  const s = state.sent.findIndex((x) => isPendingRowSave(x.patch, op, target));
  const h = state.held.findIndex((x) => isPendingRowSave(x.patch, op, target));
  if (s < 0 && h < 0) return { state, released: null };
  return {
    state: {
      sent: s < 0 ? state.sent : state.sent.filter((_, j) => j !== s),
      held: h < 0 ? state.held : state.held.filter((_, j) => j !== h),
    },
    released: h < 0 ? null : state.held[h].fields,
  };
}

// The user discarded the row's draft (the unsaved list's Discard): every hold
// ends, and the held fields are returned so the editor can put the row's value
// back where they still show.
export function holdOnDraftDiscard(state: HoldState): { state: HoldState; released: Fields[] } {
  if (state.held.length === 0) return { state, released: [] };
  return { state: { sent: state.sent, held: [] }, released: state.held.map((h) => h.fields) };
}

// The cached row is at `version`. Holds of saves sent at an older version end:
// the server moved on (review A3). Their fields are returned for holdDecision.
export function holdOnRowVersion(state: HoldState, version: number): { state: HoldState; released: Fields[] } {
  const ended = state.held.filter((h) => version > h.version);
  if (ended.length === 0) return { state, released: [] };
  return {
    state: { sent: state.sent, held: state.held.filter((h) => version <= h.version) },
    released: ended.map((h) => h.fields),
  };
}

// What a field showing `local` does when the row changes: "keep" it (it still
// shows the text of a held refused save), "adopt" the row's new value (it shows
// the text of a hold that just ended because the server moved on, so it is not
// the user's newer typing: as on main, the server's value shows and the drafts
// store keeps the text), or "reconcile" as usual. `local` is in the form the
// editor's Save sends; `released` is what holdOnRowVersion just returned.
export function holdDecision(
  state: HoldState,
  released: Fields[],
  field: string,
  local: unknown,
): "keep" | "adopt" | "reconcile" {
  if (state.held.some((h) => field in h.fields && h.fields[field] === local)) return "keep";
  if (released.some((f) => field in f && f[field] === local)) return "adopt";
  return "reconcile";
}
