// Pure FIFO-ordering rules for the outbox drain: which ops share a target,
// and which of them are allowed to block their target or receive a freshly
// confirmed version. Split out of outbox.ts so these can be unit-tested
// directly (outboxTargeting.test.mjs) without needing IndexedDB or api.ts —
// api.ts's ApiError uses a TS parameter-property constructor that Node's
// `--experimental-strip-types` loader cannot erase, so outbox.ts itself can
// never be `import()`ed from a plain Node test script.
//
// See upstream issue #487: a `failed` op that will auto-revive (max-attempts
// sentinel) did not block its target, so a younger sibling op for the same
// row/verse could land first; threadVersionToSiblings then handed the
// stale failed op the fresh version, so reviveMaxAttemptsFailed (focus /
// online / auth-refresh) re-armed it with a clean If-Match and silently
// reverted the newer, already-landed content. The two predicates below are
// the fix: block on it (isMaxAttemptsBlocked) and exclude it from silent
// version-threading (eligibleForVersionThread) so it re-arms through the
// normal 409/autoheal path instead, where classifyRowPatchConflict can tell
// a genuine conflict from a spurious one.
//
// The manual path is protected by queue position, not by these predicates:
// outbox.ts's retry() flips a max-attempts-failed op's status to "pending",
// which alone makes isMaxAttemptsBlocked stop applying to it. retry()
// deliberately leaves queuedAt/seq untouched, so plain FIFO order keeps the
// retried op draining ahead of any sibling that queued while it sat failed —
// exactly as if it had never failed. Do NOT "freshen" queuedAt/seq in
// retry(): that would sort the retried op *behind* the younger sibling, the
// sibling would land first, and eligibleForVersionThread (which allows any
// pending op) would thread its fresh version straight into the retried op —
// which then lands cleanly on top of the newer content. See the Retry
// section of outboxTargeting.test.mjs.

import type { OpTarget, OutboxOp, OutboxResult } from "./outbox.ts";

/** `lastError` stamped on an op that ran out of retries (see outbox.ts's
 * MAX_ATTEMPTS). Single-sourced here so drainPass, reviveMaxAttemptsFailed,
 * and these predicates can never drift apart on the spelling. */
export const MAX_ATTEMPTS_SENTINEL = "max_attempts_exceeded";

/** True iff a failed op's lastError marks it as one the outbox itself will
 * re-send later (reviveMaxAttemptsFailed on focus/online/auth-refresh) —
 * as opposed to a fatal refusal that only a user's Retry can resurrect. */
export function willRetryOnItsOwn(lastError: string | undefined): boolean {
  return lastError === MAX_ATTEMPTS_SENTINEL;
}

// Two ops belong to the same target iff they touch the same row/verse. A
// conflict on one of them must not block ops to *other* targets — but it
// must keep blocking siblings, since the user's expectedVersion is stale
// for them too.
export function targetKey(t: OpTarget): string {
  if (t.kind === "row") return `row:${t.rowKind}:${t.book}:${t.id}`;
  if (t.kind === "verse_status") return `vstatus:${t.book}:${t.chapter}:${t.verse}`;
  if (t.kind === "lane_check") return `lanecheck:${t.book}:${t.chapter}:${t.verse}:${t.lane}`;
  return `verse:${t.book}:${t.chapter}:${t.verse}:${t.bibleVersion}`;
}

/** The subset of an OutboxOp these predicates actually need to read. */
export type TargetingOp = Pick<OutboxOp, "status" | "lastError">;

// A `failed` op whose lastError is the max-attempts sentinel WILL auto-revive
// (reviveMaxAttemptsFailed, triggered by focus/online/authRefresh) and
// re-dispatch with its **original, possibly stale** expectedVersion. Until
// then it must block its target the same way an unresolved `conflict` does —
// otherwise a younger sibling op for the same row/verse can leapfrog it,
// land first, and then this op auto-revives on top of that newer content
// with a clean If-Match and silently reverts it (upstream #487). Fatal
// (non-revivable) refusals — including quarantined lane-freeze recovery
// copies — never auto-revive, so they must NOT block: that would freeze the
// target on an op nothing will ever re-send.
export function isMaxAttemptsBlocked(o: TargetingOp): boolean {
  return o.status === "failed" && willRetryOnItsOwn(o.lastError);
}

// Which pending/failed siblings are safe to hand a freshly-confirmed version
// to in threadVersionToSiblings. A max-attempts-failed op is EXCLUDED: handing
// it the fresh version is exactly the bug in upstream #487 — it lets a stale,
// already-superseded patch re-arm with a clean If-Match on revival instead of
// re-arming through the normal 409/autoheal path, where classifyRowPatchConflict
// can tell a genuine conflict from a safe one. It stays on its original
// (blocked, per isMaxAttemptsBlocked) expectedVersion until it revives and
// finds out for itself. Fatal failed ops keep being threaded as before — they
// never auto-revive, so this carve-out doesn't apply, and threading keeps a
// user-initiated Retry from failing on a version that's needlessly stale.
export function eligibleForVersionThread(o: TargetingOp): boolean {
  if (o.status === "pending") return true;
  if (o.status === "failed") return !willRetryOnItsOwn(o.lastError);
  return false;
}

// Whether drainPass should notify onOutboxResult listeners for this outcome.
// The persist block (the IndexedDB delete/put that finalizes the op) can
// itself throw; when it does, the catch re-arms the op as `pending` for the
// next pass, but drainPass used to call listeners with the original result
// regardless. For a `locked` result several listeners (Shell's pipeline
// toast, and drafts.ts's verse-base pin release) treat the result as a
// terminal exit — released state, dismissed UI — for an op that is in fact
// still queued and will retry (issue #570). `ok` still announces even on a
// persist failure: the server DID apply the change, so cache-updating
// listeners (useChapter/useBook/Shell) should adopt it regardless of
// whether the local delete of the now-redundant outbox entry succeeded.
export function shouldAnnounceResult(kind: OutboxResult["kind"], persisted: boolean): boolean {
  if (persisted) return true;
  return kind !== "locked";
}

// Whether an op is still live: pending, in flight, conflicted, or failed but
// due to re-send on its own (isMaxAttemptsBlocked). A fatal failed op never
// re-sends, so it is not live. The same set draftSaveState.ts's
// liveRowOpHoldsDraft uses for "a live later op for this row" (#618).
export function isLiveOp(o: TargetingOp): boolean {
  return (
    o.status === "pending" ||
    o.status === "in_flight" ||
    o.status === "conflict" ||
    isMaxAttemptsBlocked(o)
  );
}

// Whether an op is about to land on its own: pending or in flight. Narrower
// than isLiveOp on purpose. A conflicted or max-attempts-blocked op still
// holds its row draft, but it is not about to reach the server, so its value
// must not be shown as part of a confirmed row (rowWithLivePatches).
export function isReplayableOp(o: TargetingOp): boolean {
  return o.status === "pending" || o.status === "in_flight";
}

// The row the cache should hold once the server confirms `done` (#620).
// A Save patches the cached row at once (applyLocalRowPatch), so a later save
// still in the outbox is already on screen. Taking the server's row as-is
// would hide it until its own 200: save "AB", save "ABC", the 200 for "AB"
// shows "AB", and typing from there could drop the "C". So the patches of the
// row's pending or in-flight later ops (isReplayableOp) are re-applied, in
// queue order, on top of the server row; the server's version and every other
// field are kept. Each replayed op also sets restored_from_version the way
// Shell's local apply and the server do: the op's restoredFromVersion for a
// "switch to v{N}" revert, null for a normal edit (only on rows that carry the
// field). Deletes are not patches and are skipped. `queued` is the outbox as
// read after `done` was removed (it is excluded by id anyway); null or
// undefined (unread or unreadable) falls back to the server row, as before
// this fix. Returns `row` itself when nothing applies.
//
// Known gaps (#637 items 2 and 3, left as they are): `queued` is read once,
// before the listeners run, so a save whose outbox write commits after that
// read is missing from it until its own result arrives (a window of a few
// milliseconds). And the outbox is shared by every tab of the workspace, so a
// save waiting in another tab is re-applied here too; it is about to land
// from that tab's drain anyway, so this is the same optimistic display, just
// for a save typed elsewhere.
export function rowWithLivePatches<R extends object>(
  row: R,
  done: Pick<OutboxOp, "id" | "target">,
  queued: OutboxOp[] | null | undefined,
): R {
  return rowWithQueuedPatches(row, done.target, queued, done.id);
}

// rowWithLivePatches without a settled op: re-apply the row's pending or
// in-flight saves on top of a server row that arrived some other way (a live
// update from another user, #637 item 5). `excludeId` skips one op by id.
export function rowWithQueuedPatches<R extends object>(
  row: R,
  target: OpTarget,
  queued: OutboxOp[] | null | undefined,
  excludeId?: string,
): R {
  if (!queued) return row;
  const key = targetKey(target);
  let out = row;
  for (const o of queued) {
    if (o.id === excludeId || o.action !== "patch" || !isReplayableOp(o)) continue;
    if (targetKey(o.target) !== key) continue;
    if (!o.patch || typeof o.patch !== "object") continue;
    out = { ...out, ...o.patch };
    if ("restored_from_version" in out) {
      out = { ...out, restored_from_version: o.restoredFromVersion ?? null };
    }
  }
  return out;
}

// Whether a drain result ends a save without the server applying it (#637):
// `fatal` (refused for good; the op stays in the failed list until Retry or
// Discard) and `locked` (dropped while an AI pipeline holds the chapter).
// `conflict` is not one: the op is held for the user to resolve, and keep
// mine re-sends it. `retry` re-sends on its own.
export function unappliedResult(kind: OutboxResult["kind"]): boolean {
  return kind === "fatal" || kind === "locked";
}

// The row the cache should hold after a row save ended without being applied
// or was discarded (#637 item 1). A Save patches the cached row at once, so
// without this the unsaved value stays on screen, and becomes the editors'
// saved baseline, until a refetch. Rebuilt as the last row the server
// confirmed (`confirmed`, recorded by the cache hook) plus the row's saves
// still about to land, the same rule rowWithLivePatches uses after a 200.
// Returns null to leave the cache alone: the row is not cached, no confirmed
// row was recorded, the outbox could not be read, or the cached row carries a
// different server version than `confirmed` (it came from a path that did not
// record it, and rebuilding would roll it back).
export function rowAfterUnappliedOp<R extends { version?: unknown }>(
  cached: R | undefined,
  confirmed: R | undefined,
  target: OpTarget,
  queued: OutboxOp[] | null | undefined,
): R | null {
  if (!cached || !confirmed || !queued) return null;
  if (cached.version !== confirmed.version) return null;
  return rowWithQueuedPatches(confirmed, target, queued);
}

// Whether the outbox holds a delete for this row that is about to land
// (#637 item 4). A row removed from the cache by a waiting delete must not be
// put back by a live update for it.
export function hasQueuedDelete(target: OpTarget, queued: OutboxOp[] | null | undefined): boolean {
  if (!queued) return false;
  const key = targetKey(target);
  return queued.some((o) => o.action === "delete" && isReplayableOp(o) && targetKey(o.target) === key);
}
