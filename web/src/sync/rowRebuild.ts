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
// cannot be read falls back to the server row its 409 carried. When the row
// cannot be read otherwise (offline, a 404, an error), the cache is left as it
// is, as before this fix.
//
// Only this tab hears the outbox's results (the tab that drains), so another
// open tab keeps showing its own optimistic value (#637 item 3, out of scope).

import { api, type TnRow, type TqRow, type TwlRow } from "./api";
import { onOutboxDrop, onOutboxResult, outbox, type OutboxOp, type RowTarget } from "./outbox";
import { rebuildsAfterResult } from "./outboxTargeting";

export type AnyRow = TnRow | TqRow | TwlRow;
export type RebuildCause = "fatal" | "locked" | "drop";
type Listener = (target: RowTarget, server: AnyRow, queued: OutboxOp[] | null, cause: RebuildCause) => void;

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

async function rebuild(op: OutboxOp, cause: RebuildCause) {
  if (op.target.kind !== "row" || listeners.size === 0) return;
  const target = op.target;
  let server: AnyRow | null = null;
  try {
    const row = await api.getRow(target.rowKind, target.id, target.book);
    if (isServerRow(row, target)) server = row;
  } catch {
    /* fall back below */
  }
  if (!server && cause === "drop" && isServerRow(op.conflictCurrent, target)) {
    server = op.conflictCurrent;
  }
  if (!server) return;
  // Read after the row, so a save that lands meanwhile is either in the row
  // (and gone from the outbox) or still waiting here; a newer cached row
  // than this one is left alone by rowRebuildAction.
  let queued: OutboxOp[] | null;
  try {
    queued = await outbox.listWithUncommitted();
  } catch {
    queued = null;
  }
  for (const l of listeners) {
    try {
      l(target, server, queued, cause);
    } catch (e) {
      console.warn("row rebuild listener failed", e);
    }
  }
}

onOutboxResult((op, result) => {
  if (op.target.kind !== "row" || !rebuildsAfterResult(result)) return;
  void rebuild(op, result.kind === "locked" ? "locked" : "fatal");
});

onOutboxDrop((op) => {
  if (op.target.kind !== "row") return;
  void rebuild(op, "drop");
});
