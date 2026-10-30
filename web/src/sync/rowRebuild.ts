// Rebuild the cached row after a row op that never lands (issue #637 item 1).
//
// A Save patches the cached row at once, and a row delete removes it at once.
// When the server refuses the op for good (fatal), the outbox drops it because
// an AI pipeline holds the chapter (locked), or the user discards it (Discard
// of a failed save, keep theirs or Discard of a conflict), nothing else takes
// that back: the cache kept the unsaved value until a refetch. Here the row is
// read from the server again, the outbox is read after that, and every
// subscriber (useChapter, useBook) gets both to rebuild its cached row with
// rebuiltRow / rowRebuildAction (outboxTargeting.ts), which keep the row's
// saves still waiting on top and skip a cache that already holds a newer row.
//
// The text the user typed is not lost by this: the drafts store keeps a
// refused save's text (refusedRowDraft.ts, #647) and the classic editors keep
// showing it as unsaved (refusedSaveHold.ts). A dropped conflict whose row
// cannot be read (offline, an error) falls back to the server row its 409
// carried, which may replace a cached row but never puts a missing one back.
// A 404 (the row is gone) leaves the cache alone, and so does any other
// failure to read the row, as before this fix. Only the row's own delete,
// refused or discarded, may put a missing row back, and only from a fresh
// read (rowRebuildAction's `mayInsert`, review A1/A2).
//
// Only this tab hears the outbox's results (the tab that drains), so another
// open tab keeps showing its own optimistic value (#637 item 3, out of scope).

import { api, ApiError, type TnRow, type TqRow, type TwlRow } from "./api";
import { onOutboxDrop, onOutboxResult, outbox, type OutboxOp, type RowTarget } from "./outbox";
import { RowGenerations, bumpsRowGeneration, rebuildsAfterResult, targetKey } from "./outboxTargeting";

export type AnyRow = TnRow | TqRow | TwlRow;
export type RebuildCause = "fatal" | "locked" | "drop";
export interface RowRebuild {
  target: RowTarget;
  server: AnyRow;
  queued: OutboxOp[] | null;
  cause: RebuildCause;
  /** The op was the row's own delete and `server` was read just now: a missing row may go back. */
  mayInsert: boolean;
}
type Listener = (r: RowRebuild) => void;

const listeners = new Set<Listener>();

/** Subscribe to rows re-read after an op that never landed. */
export function onRowRebuild(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function isServerRow(v: unknown, target: RowTarget): v is AnyRow {
  const r = v as { id?: unknown; book?: unknown; version?: unknown; chapter?: unknown } | null;
  return (
    !!r &&
    r.id === target.id &&
    r.book === target.book &&
    typeof r.version === "number" &&
    typeof r.chapter === "number"
  );
}

// Per-row counter (review round 2, B1): every outbox result that changes or
// settles the server row (bumpsRowGeneration: ok, fatal, locked; not a retry
// or a 409, round 3 C1) or drop for a row bumps it, and so does each rebuild's
// start. A rebuild hands its read on only
// if the counter has not moved since it started, so a read that was in flight
// while something newer happened to the row (a later delete that landed,
// another rebuild for the row) is dropped instead of overwriting it.
const generations = new RowGenerations();

async function rebuild(op: OutboxOp, cause: RebuildCause) {
  if (op.target.kind !== "row" || listeners.size === 0) return;
  const target = op.target;
  const key = targetKey(target);
  const gen = generations.bump(key);
  let server: AnyRow | null = null;
  let read = false;
  try {
    const row = await api.getRow(target.rowKind, target.id, target.book);
    if (isServerRow(row, target)) {
      server = row;
      read = true;
    }
  } catch (e) {
    // The row is gone: nothing to put back, and no older copy may stand in.
    if (e instanceof ApiError && e.status === 404) return;
  }
  if (!server && cause === "drop" && isServerRow(op.conflictCurrent, target)) {
    server = op.conflictCurrent;
  }
  if (!server) return;
  const mayInsert = read && op.action === "delete";
  // Read after the row, so a save that lands meanwhile is either in the row
  // (and gone from the outbox) or still waiting here; a newer cached row
  // than this one is left alone by rowRebuildAction.
  let queued: OutboxOp[] | null;
  try {
    queued = await outbox.listWithUncommitted();
  } catch {
    queued = null;
  }
  if (!generations.isCurrent(key, gen)) return;
  for (const l of listeners) {
    try {
      l({ target, server, queued, cause, mayInsert });
    } catch (e) {
      console.warn("row rebuild listener failed", e);
    }
  }
}

onOutboxResult((op, result) => {
  if (op.target.kind !== "row") return;
  if (bumpsRowGeneration(result)) generations.bump(targetKey(op.target));
  if (!rebuildsAfterResult(result)) return;
  void rebuild(op, result.kind === "locked" ? "locked" : "fatal");
});

onOutboxDrop((op) => {
  if (op.target.kind !== "row") return;
  generations.bump(targetKey(op.target));
  void rebuild(op, "drop");
});
