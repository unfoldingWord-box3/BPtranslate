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
    if (o.status !== "conflict" && o.status !== "pending" && o.status !== "in_flight") continue;
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
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * The ops Keep theirs deletes, given the refused op's id: every op for the
 * same row that is not on the wire. Later saves of the row wait behind the
 * conflict with stale versions (drainPass blocks the target), so dropping
 * only the refused one would let the next of them overwrite the row the user
 * just chose to keep. An op already in flight is left alone, as
 * outbox.drop does. Empty when `opId` is no longer a conflict (another tab
 * resolved it), so a stale click drops nothing.
 */
export function opsDroppedByKeepTheirs<T extends Pick<OutboxOp, "id" | "target" | "status">>(
  ops: readonly T[],
  opId: string,
): T[] {
  const op = ops.find((o) => o.id === opId);
  if (!op || op.status !== "conflict" || op.target.kind !== "row") return [];
  const key = targetKey(op.target);
  return ops.filter((o) => targetKey(o.target) === key && o.status !== "in_flight");
}
