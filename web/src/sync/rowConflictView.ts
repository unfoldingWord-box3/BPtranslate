// What the classic editors show for a row whose queued save the server refused
// with a version conflict, and what "Keep theirs" throws away (#892).
//
// The 409 carries the other person's whole row (api/src/rows.ts answers
// version_mismatch with `SELECT *`), and drainPass keeps it on the op as
// `conflictCurrent`, so the compare needs no extra request and survives a
// reload with the op in IndexedDB.
//
// Pure, so rowConflictView.test.mjs can run it under node without IndexedDB.

import type { OutboxOp, RowTarget } from "./outbox.ts";
import { targetKey } from "./outboxTargeting.ts";

type ViewOp = Pick<OutboxOp, "id" | "target" | "action" | "patch" | "status" | "conflictCurrent" | "queuedAt" | "seq">;

export interface RowConflictView {
  /** The op the server refused; Keep mine and Keep theirs act on it. */
  opId: string;
  /**
   * What Keep mine would save: every queued patch for the row (the refused
   * one and any saved after it, waiting behind it), merged in queue order.
   */
  mine: Record<string, unknown>;
  /** The server's row from the 409, or null when the 409 carried none. */
  theirs: Record<string, unknown> | null;
  /** That row's version, the one Keep mine re-sends against. */
  theirsVersion: number | null;
  theirsUpdatedAt: number | null;
  /** Fields to compare: those in `mine` that differ from `theirs` (all of them if none do). */
  fields: string[];
  /** A save of the row is on the wire (review L2): Keep theirs waits for it to settle. */
  sending: boolean;
}

/** Whether Keep theirs can run now: their row is known and no save of the row is on the wire. */
export function canKeepTheirs(view: Pick<RowConflictView, "theirs" | "sending">): boolean {
  return view.theirs != null && !view.sending;
}

function inQueueOrder<T extends Pick<OutboxOp, "queuedAt" | "seq">>(ops: T[]): T[] {
  return [...ops].sort((a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0));
}

function asRow(v: unknown, target: RowTarget): Record<string, unknown> | null {
  const r = v as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object" || r.id !== target.id || typeof r.version !== "number") return null;
  return r;
}

/** The conflict to show for `target`, or null when no patch for it is in conflict. */
export function rowConflictView(ops: readonly ViewOp[], target: RowTarget): RowConflictView | null {
  const key = targetKey(target);
  const forRow = inQueueOrder(ops.filter((o) => targetKey(o.target) === key));
  const conflict = forRow.find((o) => o.status === "conflict" && o.action === "patch");
  if (!conflict) return null;
  const mine: Record<string, unknown> = {};
  for (const o of forRow) {
    if (o.action !== "patch") continue;
    if (o.status !== "conflict" && o.status !== "pending") continue;
    Object.assign(mine, o.patch);
  }
  const theirs = asRow(conflict.conflictCurrent, target);
  const keys = Object.keys(mine);
  const differ = theirs ? keys.filter((k) => !sameValue(mine[k], theirs[k])) : keys;
  return {
    opId: conflict.id,
    mine,
    theirs,
    theirsVersion: theirs ? (theirs.version as number) : null,
    theirsUpdatedAt: theirs && typeof theirs.updated_at === "number" ? theirs.updated_at : null,
    fields: differ.length > 0 ? differ : keys,
    sending: forRow.some((o) => o.status === "in_flight"),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

// Display form for comparing an editor value with the server's: TSV "\n"
// escapes and real newlines compare equal, and null equals "".
function shown(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v.replace(/\\n/g, "\n") : String(v);
}

/**
 * The view with "Mine" set to what Keep theirs would throw away (#892 review
 * K1): the editor's current values, which can hold typing made after the
 * refused save that no queued patch carries. `editor` is the card's fields as
 * they stand; `dirty` names those that differ from the card's own baseline.
 * A field is shown when it is queued or dirty and its editor value differs
 * from theirs, so a field the user never touched is not offered as "mine".
 * Only a dirty field takes the editor's value; a queued one the editor shows
 * unchanged keeps the queued text.
 */
export function withEditorValues(
  view: RowConflictView,
  editor: Record<string, unknown>,
  dirty: readonly string[],
): RowConflictView {
  const mine = { ...view.mine };
  const keys = [...new Set([...Object.keys(view.mine), ...dirty])];
  // A field the editor shows unchanged keeps its queued text: the tQ table,
  // for one, adopts the other person's value on screen when their write
  // arrives, while the queued patch still holds this browser's.
  const changed = new Set(dirty);
  for (const k of keys) if (changed.has(k) && k in editor) mine[k] = editor[k];
  const theirs = view.theirs;
  const differ = theirs ? keys.filter((k) => shown(mine[k]) !== shown(theirs[k])) : keys;
  return { ...view, mine, fields: differ.length > 0 ? differ : view.fields };
}

/**
 * What Keep theirs may touch once its outbox drop has finished (review P1).
 * The drop is awaited, and the user can type meanwhile: only fields still
 * showing what they showed at the click take their text, and the draft is
 * cleared only when no field changed since the click.
 */
export function keepTheirsPlan<K extends string>(
  atClick: Record<K, unknown>,
  now: Record<K, unknown>,
): { overwrite: K[]; clearDraft: boolean } {
  const keys = Object.keys(atClick) as K[];
  const overwrite = keys.filter((k) => now[k] === atClick[k]);
  return { overwrite, clearDraft: overwrite.length === keys.length };
}

/**
 * Whether "Mine" as shown (withEditorValues) holds text the queued saves do
 * not (review M1): typing after the refused save. Keep mine then queues the
 * editor's values as one more save behind the re-armed ones, so it saves
 * exactly what Mine shows; that save lands last.
 */
export function editorAddsToMine(
  view: RowConflictView,
  editor: Record<string, unknown>,
  dirty: readonly string[],
): boolean {
  return dirty.some((k) => k in editor && shown(editor[k]) !== shown(view.mine[k]));
}

/**
 * The ops Keep theirs deletes, given the refused op's id: the refused patch
 * and the patches of the same row queued behind it. Those wait with stale
 * versions (drainPass blocks the target), so dropping only the refused one
 * would let the next of them overwrite the row the user just chose to keep.
 * Left alone: a failed op (its text is not in the compare; the failed-save
 * recovery UI owns it) and a delete (review K2, K3). Empty when `opId` is no
 * longer a conflict (another tab resolved it), so a stale click drops
 * nothing, and empty while any op of the row is on the wire (review L2): it
 * could land over theirs, so Keep theirs waits for it to settle.
 */
export function opsDroppedByKeepTheirs<T extends Pick<OutboxOp, "id" | "target" | "status" | "action">>(
  ops: readonly T[],
  opId: string,
): T[] {
  const op = ops.find((o) => o.id === opId);
  if (!op || op.status !== "conflict" || op.target.kind !== "row") return [];
  const key = targetKey(op.target);
  if (ops.some((o) => targetKey(o.target) === key && o.status === "in_flight")) return [];
  return ops.filter(
    (o) =>
      targetKey(o.target) === key &&
      o.action === "patch" &&
      (o.status === "conflict" || o.status === "pending"),
  );
}
