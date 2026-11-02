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
import { wouldAutoHeal } from "./rowConflict.ts";

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
// this fix. Returns `row` itself when nothing applies. `queued` also carries
// this tab's ops whose outbox write has not committed yet (withUncommittedOps,
// #637 item 2).
//
// Known gap (#637 item 3, left as it is): the outbox is shared by every tab of
// the workspace, so a save waiting in another tab is re-applied here too; it
// is about to land from that tab's drain anyway, so this is the same
// optimistic display, just for a save typed elsewhere. The uncommitted-write
// merge covers this tab only: another tab's save whose write is still in
// progress can still be missing from the read for a moment.
export function rowWithLivePatches<R extends object>(
  row: R,
  done: Pick<OutboxOp, "id" | "target">,
  queued: OutboxOp[] | null | undefined,
): R {
  return rowWithQueuedPatches(row, done.target, queued, done.id);
}

// The outbox as read, plus this tab's ops whose IndexedDB write has not
// committed yet (#637 item 2). A Save patches the cached row and starts its
// outbox write in the same tick, so a read that runs before the write commits
// leaves that op out, and a listener rebuilding the row from the read would
// drop the save from the screen until its own 200. Ops are deduped by id (the
// listed copy wins, as it may carry a newer status) and kept in queue order,
// queuedAt then seq, as listAll sorts. A null read stays null.
export function withUncommittedOps(
  listed: OutboxOp[] | null,
  uncommitted: Iterable<OutboxOp>,
): OutboxOp[] | null {
  if (!listed) return listed;
  const ids = new Set(listed.map((o) => o.id));
  const extra = [...uncommitted].filter((o) => !ids.has(o.id));
  if (extra.length === 0) return listed;
  return [...listed, ...extra].sort(
    (a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0),
  );
}

// rowWithLivePatches without a settled op: re-apply the row's pending or
// in-flight saves on top of a server row that arrived some other way (a live
// update from another user, #637 item 5). `excludeId` skips one op by id;
// `keep`, when given, must also accept an op (judged against the row built so
// far) for it to be re-applied.
export function rowWithQueuedPatches<R extends object>(
  row: R,
  target: OpTarget,
  queued: OutboxOp[] | null | undefined,
  excludeId?: string,
  keep?: (o: OutboxOp, soFar: R) => boolean,
): R {
  if (!queued) return row;
  const key = targetKey(target);
  let out = row;
  for (const o of queued) {
    if (o.id === excludeId || o.action !== "patch" || !isReplayableOp(o)) continue;
    if (targetKey(o.target) !== key) continue;
    if (!o.patch || typeof o.patch !== "object") continue;
    if (keep && !keep(o, out)) continue;
    out = { ...out, ...o.patch };
    if ("restored_from_version" in out) {
      out = { ...out, restored_from_version: o.restoredFromVersion ?? null };
    }
  }
  return out;
}

// Whether the outbox holds a delete for this row that is about to land
// (#637 item 4). A row removed from the cache by a waiting delete must not be
// put back by a live update for it.
export function hasQueuedDelete(target: OpTarget, queued: OutboxOp[] | null | undefined): boolean {
  if (!queued) return false;
  const key = targetKey(target);
  return queued.some((o) => o.action === "delete" && isReplayableOp(o) && targetKey(o.target) === key);
}

// What to do once the outbox has been read after another user's live update
// (WebSocket "insert" or "replace") put the server's row in the cache (#637).
// That row drops this user's saves still waiting in the outbox, so their
// fields are patched back on top (item 5, the same rule rowWithLivePatches
// uses after a 200), and a row a waiting delete had removed is taken back out
// (item 4). Only ops that will land on top of this server row count: a
// patch sent at its version, or one the outbox's own 409 rule would auto-heal
// (wouldAutoHeal), each judged against the server row plus the waiting saves
// kept before it (a chained AB→ABC, ABC→ABCD lands whole once the first
// threads its version to the second); a delete only when sent at its version
// (deletes never auto-heal). An op about to hit a genuine conflict is left
// off, so the cache shows the other user's value rather than ours stamped
// with their version (a later save from there would overwrite theirs with no
// 409). Null when the outbox could not be read or nothing waits for the row.
// The caller applies the result only if the cached row is still at the
// broadcast row's version (rowAtVersion in lib/bookCache.ts, checked inside
// the state updater): the read is async, and if something newer landed
// meanwhile the queued values may be older than its fields (review F4).
export type LiveUpdateFollowUp = { t: "delete" } | { t: "patch"; patch: Record<string, unknown> };
export function liveUpdateFollowUp(
  server: { version: number },
  target: OpTarget,
  queued: OutboxOp[] | null | undefined,
): LiveUpdateFollowUp | null {
  if (!queued) return null;
  const atVersion = (o: OutboxOp) => o.expectedVersion === server.version;
  if (hasQueuedDelete(target, queued.filter(atVersion))) return { t: "delete" };
  // Rebuilt on the full server row so each op is judged against what is
  // there once the saves kept before it have landed; only the kept saves'
  // fields go in the patch.
  const full = server as Record<string, unknown>;
  const keys = new Set<string>();
  const row = rowWithQueuedPatches(full, target, queued, undefined, (o, soFar) => {
    const lands = atVersion(o) || wouldAutoHeal(o, soFar);
    if (lands) for (const k of Object.keys(o.patch ?? {})) keys.add(k);
    return lands;
  });
  // No waiting save, or only ones with an empty patch: nothing to put back.
  if (keys.size === 0) return null;
  const patch: Record<string, unknown> = {};
  for (const k of keys) patch[k] = row[k];
  // rowWithQueuedPatches sets restored_from_version per replayed op on rows
  // that carry the field.
  if ("restored_from_version" in row) patch.restored_from_version = row.restored_from_version;
  return { t: "patch", patch };
}

// ---------- rebuild after a row op that never lands (#637 item 1) ----------
//
// A Save patches the cached row at once (Shell's enqueueRow; a row delete
// removes it at once). When the server never applies the op, nothing used to
// take that back: the unsaved value stayed in the cache, on screen and as the
// classic editors' saved baseline, until a refetch. rowRebuild.ts now reads
// the row from the server after such an op, and the cache hooks (useChapter,
// useBook) put it back with these helpers. Reading the server's row, rather
// than keeping a "last confirmed" copy in each hook, means no such copy can go
// stale: same-version server changes (preserve/hint, the review-state sweep)
// and rows from a book-view fetch are simply part of what the server returns.

// A counter per row (keyed by targetKey) that rowRebuild.ts bumps on every
// outbox result or drop for the row and when a rebuild starts. A rebuild's
// server read is applied only if the row's counter is still the one it got at
// its start (review round 2, B1): otherwise something newer happened to the
// row while the read was in flight (a later delete that landed, another
// rebuild), and the older read must not overwrite it.
// Only results that change or settle the server's row move the counter
// (round 3, C1): "ok", "fatal" and "locked" (and a drop, counted by
// rowRebuild.ts). A "retry" or a "conflict" leaves the server row as it was,
// so a sibling op's network retry or 409 must not make a refused op's rebuild
// stale: nothing would schedule it again.
export function bumpsRowGeneration(result: OutboxResult): boolean {
  return result.kind === "ok" || result.kind === "fatal" || result.kind === "locked";
}

export class RowGenerations {
  private readonly gens = new Map<string, number>();
  bump(key: string): number {
    const n = (this.gens.get(key) ?? 0) + 1;
    this.gens.set(key, n);
    return n;
  }
  isCurrent(key: string, gen: number): boolean {
    return this.gens.get(key) === gen;
  }
}

// Whether a drain result ends a row op without the server applying it, so the
// cached row is rebuilt: "fatal" (refused for good) or "locked" (dropped while
// an AI pipeline holds the chapter). Not a fatal 404: the row is gone. Not a
// "conflict": it waits for the user (keep mine re-sends it; keep theirs and
// Discard reach rowRebuild.ts as an outbox drop). Not "retry": it re-sends.
export function rebuildsAfterResult(result: OutboxResult): boolean {
  if (result.kind === "locked") return true;
  return result.kind === "fatal" && result.reason !== "http 404";
}

// The row the cache should hold after a row op ended without landing: the
// server's row as just read, plus the row's saves still waiting that will land
// on top of it (liveUpdateFollowUp's rule: sent at the server's version, or one
// the outbox's 409 rule would auto-heal, judged against the row built so far).
// After a "locked" drop no waiting save is re-applied: the chapter is locked,
// so each one will be dropped the same way. Null when the outbox could not be
// read (a waiting save cannot be ruled out) or a delete for the row is waiting
// (the row stays removed).
export function rebuiltRow<R extends { version: number }>(
  server: R,
  target: OpTarget,
  queued: OutboxOp[] | null | undefined,
  cause: "fatal" | "locked" | "drop",
): R | null {
  if (!queued) return null;
  if (hasQueuedDelete(target, queued)) return null;
  if (cause === "locked") return server;
  return rowWithQueuedPatches(
    server,
    target,
    queued,
    undefined,
    (o, soFar) => o.expectedVersion === server.version || wouldAutoHeal(o, soFar),
  );
}

// How to put `rebuilt` into a cache that holds `cached` for the row. A row the
// cache no longer has is inserted back only when `mayInsert`: the op that never
// landed was itself this row's delete (refused or discarded), and the row was
// read from the server just now. A row missing after any other op is missing
// because something deleted it (a later delete of this user's, another user's),
// so it stays out (review A2). A cached row at a newer version than the server
// row read is left alone: something newer landed meanwhile (the guard
// liveUpdateFollowUp's caller applies, review F4 of #642).
export type RowRebuildAction<R> = { t: "replace"; row: R } | { t: "insert"; row: R } | null;
export function rowRebuildAction<R extends { version: number }>(
  cached: R | undefined,
  rebuilt: R | null,
  mayInsert: boolean,
): RowRebuildAction<R> {
  if (!rebuilt) return null;
  if (!cached) return mayInsert ? { t: "insert", row: rebuilt } : null;
  if (cached.version > rebuilt.version) return null;
  return { t: "replace", row: rebuilt };
}
