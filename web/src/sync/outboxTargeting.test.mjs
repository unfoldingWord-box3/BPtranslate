// Tests for web/src/sync/outboxTargeting.ts — the FIFO-ordering rules that
// fix upstream issue #487 ("Outbox FIFO inversion: a max-attempts-failed op
// can be auto-revived and silently overwrite a newer landed edit on the same
// target").
//
// The defect: a `failed` op did not block its target, so a younger sibling
// op for the same row/verse could leapfrog it and land first.
// threadVersionToSiblings then handed the stale failed op the fresh
// confirmed version, so when reviveMaxAttemptsFailed re-armed it (on focus /
// online / auth-refresh) the OLDER patch landed with a clean If-Match — no
// 409, no autoheal check — silently reverting the newer content. Both ops
// reported "ok"; nothing surfaced to the user.
//
// This module can't be exercised end-to-end without a browser (IndexedDB,
// window focus/online events), so these tests construct the exact op
// snapshots drainPass and threadVersionToSiblings would see at each step of
// the failure scenario from the issue, and assert the two predicates that
// fix it: isMaxAttemptsBlocked (drainPass's `blocked` set) and
// eligibleForVersionThread (threadVersionToSiblings's sibling filter).

import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS_SENTINEL,
  eligibleForVersionThread,
  isMaxAttemptsBlocked,
  shouldAnnounceResult,
  targetKey,
} from "./outboxTargeting.ts";

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const noteTarget = { kind: "row", rowKind: "tn", id: "note-1", book: "ZEC" };

// --- The issue #487 timeline, as the ops would look in the store ---
//
// 1. Edit "A" to a note exhausts MAX_ATTEMPTS during a server outage.
const op1FailedA = {
  id: "op1",
  target: noteTarget,
  action: "patch",
  patch: { note: "A" },
  expectedVersion: 5,
  queuedAt: 1000,
  attempts: 20,
  hardAttempts: 20,
  status: "failed",
  lastError: MAX_ATTEMPTS_SENTINEL,
};
// 2. The user edits the note again, to "AB" — a younger, still-pending op
//    for the SAME target queues up behind the failed one.
const op2PendingAB = {
  id: "op2",
  target: noteTarget,
  action: "patch",
  patch: { note: "AB" },
  expectedVersion: 5,
  queuedAt: 2000,
  attempts: 0,
  status: "pending",
};

// --- isMaxAttemptsBlocked: drainPass's `blocked` set ---
//
// This is the leapfrog fix itself. Before #487, only `status === "conflict"`
// blocked a target — a max-attempts-failed op did not, so op2 was free to
// drain and land while op1 sat there waiting to auto-revive. Blocking on it
// keeps the two ops in their original FIFO order: op1 must resolve (revive,
// dispatch, and either land or genuinely 409) before op2 is ever picked up.

check(
  isMaxAttemptsBlocked(op1FailedA) === true,
  "REGRESSION (upstream #487): a max-attempts-failed op blocks its target, so a younger sibling can't leapfrog it",
);
check(
  isMaxAttemptsBlocked(op2PendingAB) === false,
  "a pending op never blocks on its own account",
);

// A fatal (non-revivable) refusal must NOT block — nothing will ever re-send
// it, so blocking on it would freeze the target forever.
const op1FatalRefusal = { ...op1FailedA, lastError: "http 400" };
check(
  isMaxAttemptsBlocked(op1FatalRefusal) === false,
  "a fatal (non-revivable) refusal does not block — it never auto-revives",
);

// A quarantined lane-freeze recovery copy is `failed` with the freeze reason
// as lastError — not the sentinel. It never auto-revives (only a user Retry
// after the lane unfreezes), so it must not block either.
check(
  isMaxAttemptsBlocked({
    status: "failed",
    lastError: "Quarantined: ult lane is frozen",
  }) === false,
  "a quarantined lane-freeze op does not block — it never auto-revives",
);

// A legacy record with no lastError classifies as a refusal, not a blocker.
check(
  isMaxAttemptsBlocked({ status: "failed", lastError: undefined }) === false,
  "a legacy failed record with no lastError does not block",
);

// Conflict-status ops are handled by drainPass's own `status === "conflict"`
// check, not this predicate — confirm this predicate stays narrowly scoped
// to the max-attempts class so the two checks don't overlap confusingly.
check(
  isMaxAttemptsBlocked({ status: "conflict", lastError: "version_mismatch" }) === false,
  "a conflict-status op is out of scope for this predicate (drainPass ORs it in separately)",
);

// --- eligibleForVersionThread: threadVersionToSiblings's sibling filter ---
//
// Defense in depth for the same bug: even if a max-attempts-failed op's
// target were ever picked up as a sibling of a just-landed op (e.g. a stale
// snapshot, a future refactor), it must not be handed the fresh version. It
// has to stay on ITS OWN expectedVersion so that when it revives, it
// re-arms through the normal 409/autoheal path — where classifyRowPatchConflict
// can tell a genuine conflict (op2 already changed this field) from a
// spurious one — instead of silently overwriting op2's landed "AB" with its
// own stale "A".

check(
  eligibleForVersionThread(op1FailedA) === false,
  "REGRESSION (upstream #487): a max-attempts-failed op is excluded from silent version-threading",
);
check(
  eligibleForVersionThread(op2PendingAB) === true,
  "a pending sibling is still threaded the fresh version, as before",
);

// #754 round 3 (C-F2): a restored NoteCard draft's Save goes out at the older
// version its text was typed against, so the server's 409 brings up the
// conflict prompt. Threading it to the version an earlier write of the row
// (a reorder) just landed at would send it at a version that already carries
// another person's note, and it would replace that note with a 200.
check(
  eligibleForVersionThread({ status: "pending", originPinned: true }) === false,
  "#754: a Save pinned to the version its text was typed against is not threaded",
);

// Fatal failed ops keep the pre-#487 behaviour: they're still threaded, so a
// user-initiated Retry (which does not reset expectedVersion) doesn't fail
// on a version that's needlessly stale.
check(
  eligibleForVersionThread(op1FatalRefusal) === true,
  "a fatal (non-revivable) failed op is still threaded — only the auto-revive class is excluded",
);

// in_flight / conflict ops are never threading candidates — conflict is
// owned by the user-resolve flow (resolveConflict overwrites expectedVersion
// itself), and in_flight means a request is already on the wire.
check(
  eligibleForVersionThread({ status: "conflict", lastError: "version_mismatch" }) === false,
  "a conflict-status op is not a threading candidate",
);
check(
  eligibleForVersionThread({ status: "in_flight", lastError: undefined }) === false,
  "an in_flight op is not a threading candidate",
);

// --- End-to-end shape of the fix, replaying drainPass's own logic ---
//
// This mirrors exactly what drainPass computes over a `listAll()` snapshot,
// and what threadVersionToSiblings computes over the same store: given the
// two-op timeline above, confirm the blocked set contains op1's target (so
// op2 cannot drain ahead of it) and that threading a fresh version — as if
// op1 had somehow landed first — would skip op1's stale sibling but still
// reach a genuinely-pending one.

const ops = [op1FailedA, op2PendingAB];
const blocked = new Set();
for (const o of ops) {
  if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
}
check(
  blocked.has(targetKey(noteTarget)),
  "the shared target is blocked while op1 sits failed with the max-attempts sentinel",
);
const nextPending = ops.find((o) => o.status === "pending" && !blocked.has(targetKey(o.target)));
check(
  nextPending === undefined,
  "REGRESSION (upstream #487): op2 is NOT picked up for dispatch while op1 blocks the target — no leapfrog",
);

const threadCandidates = ops.filter(
  (o) => targetKey(o.target) === targetKey(noteTarget) && eligibleForVersionThread(o),
);
check(
  threadCandidates.length === 1 && threadCandidates[0].id === "op2",
  "only the pending sibling (op2) would receive a threaded version — op1 keeps its own",
);

// --- Manual Retry must not reintroduce the leapfrog (upstream PR #504, P1) ---
//
// The blocked-set/threading fix above covers *automatic* revival
// (reviveMaxAttemptsFailed, on focus/online/auth-refresh), which never
// touches queuedAt — the op keeps its original queue position, so once it
// flips back to "pending" plain FIFO order alone keeps it ahead of op2.
//
// The user-driven Retry button (outbox.ts's retry()) also flips a failed op
// to "pending" — the same loss of isMaxAttemptsBlocked's protection. In this
// fork retry() deliberately leaves queuedAt/seq untouched; upstream's
// version used to refresh queuedAt to "now", which reopens the hole: op2
// queued at 2000, behind the then-failed op1; if op1's queuedAt jumps to
// "now" (e.g. 9000), op2's untouched 2000 makes it look OLDER, so plain FIFO
// hands op2 the target first. op2 lands, and being
// `eligibleForVersionThread` (pending), its fresh version threads straight
// into the just-retried op1 — which then drains and lands cleanly on top of
// op2's newer content. Model both the buggy (queuedAt refreshed) and correct
// (queuedAt preserved) shapes here so nobody reintroduces a
// "freshen queue position on Retry" tweak.

const op1RetriedPreservingQueue = {
  ...op1FailedA,
  status: "pending",
  attempts: 0,
  hardAttempts: 0,
  lastError: undefined,
  // queuedAt/seq intentionally NOT bumped — this is what retry() does.
};
const op1RetriedWithBumpedQueue = {
  ...op1RetriedPreservingQueue,
  queuedAt: 9000, // what a naive retry() would do: op.queuedAt = Date.now()
};

// Whichever shape, Retry always forfeits isMaxAttemptsBlocked's protection
// (status is no longer "failed") — that part is unavoidable and expected.
check(
  isMaxAttemptsBlocked(op1RetriedPreservingQueue) === false,
  "a just-retried op is no longer max-attempts-blocked (status is pending) — FIFO order alone must protect it now",
);

// REGRESSION (upstream #504 review P1): with a bumped-queuedAt Retry, op2 —
// still holding its original, now-earlier-looking queuedAt — sorts first
// and leapfrogs the just-retried op1.
const buggyOps = [op1RetriedWithBumpedQueue, op2PendingAB];
const buggyBlocked = new Set();
for (const o of buggyOps) {
  if (o.status === "conflict" || isMaxAttemptsBlocked(o)) buggyBlocked.add(targetKey(o.target));
}
const buggyOrdered = [...buggyOps].sort(
  (a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0),
);
const buggyNext = buggyOrdered.find(
  (o) => o.status === "pending" && !buggyBlocked.has(targetKey(o.target)),
);
check(
  buggyNext === op2PendingAB,
  "demonstrates the bug this test guards against: bumping queuedAt on Retry lets op2 leapfrog the retried op1",
);
// ...and once op2 lands, the retried op1 (pending) is still
// eligibleForVersionThread, so it would silently receive op2's fresh
// version and overwrite it on its next drain — the exact revert reported
// in the upstream review.
check(
  eligibleForVersionThread(op1RetriedWithBumpedQueue) === true,
  "demonstrates the bug: a just-retried op is eligible for silent version-threading from a sibling that leapfrogged it",
);

// CORRECT SHAPE: preserving queuedAt/seq keeps op1 sorted ahead of op2, so
// plain FIFO order — not the (now-inapplicable) blocked set — drains op1
// first, the same as if it had never failed. op2 remains un-drained until
// op1 resolves.
const fixedOps = [op1RetriedPreservingQueue, op2PendingAB];
const fixedBlocked = new Set();
for (const o of fixedOps) {
  if (o.status === "conflict" || isMaxAttemptsBlocked(o)) fixedBlocked.add(targetKey(o.target));
}
const fixedOrdered = [...fixedOps].sort(
  (a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0),
);
const fixedNext = fixedOrdered.find(
  (o) => o.status === "pending" && !fixedBlocked.has(targetKey(o.target)),
);
check(
  fixedNext === op1RetriedPreservingQueue,
  "preserving queuedAt/seq on Retry keeps op1 ahead of op2 in FIFO order — no leapfrog, no silent overwrite of op2's landed edit",
);

// --- drainPass's `blocked` set must recompute per iteration, not just grow
// --- (upstream issue #515) ---
//
// The bug: drainPass's `while (true)` loop built one `blocked` Set before
// the loop and only ever added to it. If retry() or reviveMaxAttemptsFailed()
// flips a blocking op back to "pending" *while a pass is running*, their own
// drain() call is a no-op (a pass is already active — see drain()'s
// `draining` guard), so the running pass is the only thing that will ever
// notice the revival. But since a target, once added to `blocked`, was never
// removed, the pass kept skipping the now-pending op for the rest of its
// iterations — even though a fresh snapshot no longer justifies blocking it —
// and exited without ever draining it. Nothing else re-triggers a pass, so
// the op sat stranded until an unrelated event (focus/online/next enqueue).
//
// The fix: recompute the status-derived portion of `blocked` fresh from each
// iteration's snapshot (seeded from a separate `pinnedBlocked` set that only
// holds targets *this pass* just parked as conflict/retry-backoff, which
// legitimately must stay blocked regardless of a later snapshot). These two
// helpers model the buggy (ever-growing) and fixed (per-iteration recompute)
// shapes of drainPass's loop body over the same two-iteration timeline.

function computeNextBuggy(iterations) {
  // Old shape: one Set built before the loop, only ever grown.
  const blocked = new Set();
  let next;
  for (const ops of iterations) {
    for (const o of ops) {
      if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
    }
    next = ops.find((o) => o.status === "pending" && !blocked.has(targetKey(o.target)));
    if (next) break;
  }
  return next;
}

function computeNextFixed(iterations, pinnedBlocked = new Set()) {
  // New shape: `blocked` reseeded from `pinnedBlocked` every iteration.
  let next;
  for (const ops of iterations) {
    const blocked = new Set(pinnedBlocked);
    for (const o of ops) {
      if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
    }
    next = ops.find((o) => o.status === "pending" && !blocked.has(targetKey(o.target)));
    if (next) break;
  }
  return next;
}

// Iteration 1: op1 is still failed (max-attempts blocked) and there's no
// other pending work in this snapshot — mirrors the moment drainPass has
// just marked the target blocked and found nothing else to dispatch.
const iteration1 = [op1FailedA];
// Between iterations, retry() (or reviveMaxAttemptsFailed) flips op1 to
// pending mid-pass — its own drain() call is swallowed because this pass is
// still running.
const op1RevivedMidPass = {
  ...op1FailedA,
  status: "pending",
  attempts: 0,
  hardAttempts: 0,
  lastError: undefined,
};
// Iteration 2: a fresh snapshot shows op1 as pending now.
const iteration2 = [op1RevivedMidPass];

check(
  computeNextBuggy([iteration1, iteration2]) === undefined,
  "REGRESSION (upstream #515): the old ever-growing blocked set strands op1 even after it's revived mid-pass",
);
check(
  computeNextFixed([iteration1, iteration2]) === op1RevivedMidPass,
  "FIX (upstream #515): recomputing blocked from each iteration's snapshot drains op1 as soon as it's revived, no external trigger needed",
);

// A target this pass itself just parked on conflict/retry-backoff must stay
// blocked across iterations even under the fixed (recomputed) logic — a
// fresh snapshot of a "pending" retry-backoff op wouldn't otherwise trip
// isMaxAttemptsBlocked (that only fires on status "failed"), so without
// pinning it the very next iteration would redispatch it before its backoff
// elapsed.
const backoffTarget = { kind: "row", rowKind: "tn", id: "note-2", book: "ZEC" };
const op3PendingBackoff = {
  id: "op3",
  target: backoffTarget,
  action: "patch",
  patch: { note: "C" },
  expectedVersion: 1,
  queuedAt: 500,
  attempts: 1,
  status: "pending",
  lastError: "transient 503",
};
const pinnedFromThisPass = new Set([targetKey(backoffTarget)]);
check(
  computeNextFixed([[op3PendingBackoff]], pinnedFromThisPass) === undefined,
  "a target this pass just parked on retry-backoff (pinnedBlocked) stays blocked on the very next snapshot, unlike a stale isMaxAttemptsBlocked entry",
);

// --- issue #570: drainPass must not announce a `locked` result whose
// persist block (the IndexedDB delete that finalizes the op) threw and got
// re-armed as `pending`. Listeners that treat `locked` as a terminal exit
// (Shell's pipeline toast, drafts.ts's verse-base pin release) would
// otherwise fire for an op that is in fact still queued and will retry.

check(
  shouldAnnounceResult("locked", true) === true,
  "a `locked` result that persisted (the delete committed) still announces",
);
check(
  shouldAnnounceResult("locked", false) === false,
  "FIX (#570): a `locked` result whose persist failed and re-armed as pending must NOT announce",
);
check(
  shouldAnnounceResult("ok", false) === true,
  "an `ok` result still announces even when the local delete failed — the server DID apply the change, so cache-updating listeners should adopt it",
);
check(
  shouldAnnounceResult("ok", true) === true,
  "an `ok` result that persisted announces, as before",
);
check(
  shouldAnnounceResult("conflict", false) === true,
  "non-locked results (conflict/retry/fatal) are unaffected by a persist failure — only `locked` gets suppressed",
);

console.log(`\noutboxTargeting: ${passed} checks passed`);
