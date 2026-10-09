// Write-ahead outbox: every user edit is durably queued in IndexedDB before
// it leaves the browser. A drain worker pops in order and dispatches to the
// API; on 200 the op is removed, on 409 the conflict is surfaced, on
// network/auth failures the op stays until the next drain tick. This is the
// single feature that keeps the editor safe from network blips and tab
// crashes — see docs/plan.md "Save protocol".

import { openDB, type IDBPDatabase } from "idb";
import {
  api,
  ApiError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isChapterLockedBody,
  isReadOnly,
  onAuthRefreshed,
  type ChapterLockedBody,
  type AlignmentIntent,
  type RowKind,
  type CheckLane,
} from "./api";
import { backoffMs } from "./backoff";
import { classifyRowPatchConflict } from "./rowConflict";
import { isLaneFrozen, laneFreezeReason } from "./laneFreeze";
import {
  MAX_ATTEMPTS_SENTINEL,
  eligibleForVersionThread,
  isMaxAttemptsBlocked,
  shouldAnnounceResult,
  targetKey,
} from "./outboxTargeting.ts";
import { workspaceDbName } from "./workspace";
import i18n from "../i18n";

// DISPLAY-ONLY fallback for the freeze reason stamped on a quarantined op —
// SyncStatusBar renders `op.quarantined` / `op.lastError` verbatim. The
// predicates in outboxTargeting.ts only compare `lastError` against
// MAX_ATTEMPTS_SENTINEL, so this prose is never a logic value. Built per call
// (never at module load) so the active UI language wins; `bibleVersion` is a
// role code and is interpolated, never translated.
function laneQuarantineReason(bibleVersion: string): string {
  return (
    laneFreezeReason(bibleVersion) ??
    i18n.t("messages.outbox.laneQuarantined", { version: bibleVersion })
  );
}

// Namespaced per workspace so switching Door43 orgs can never drain one org's
// queued edits into another org's D1 database — without this, an edit queued
// offline while in org A would ship to org B after a workspace switch. Do NOT
// "simplify" this back to a fixed name.
//
// Back-compat: pre-workspaces installs have a populated unsuffixed
// "bible-editor-outbox" database with real unsynced edits. The FALLBACK
// workspace (first entry in WORKSPACES, or the sole implicit "default" one —
// see workspace.ts's getWorkspaceIsFallback) keeps using that original name so
// no queued edit is orphaned by this deploy. This must key off "is this the
// fallback workspace", NOT off the literal slug "default": the moment
// WORKSPACES is first configured, the fallback workspace gets a real slug
// (e.g. "bsoj"), and keying off the literal string would strand any edits
// queued before that deploy in a database no longer reachable by any slug.
// Only non-fallback slugs get the "-{slug}" suffix. The fallback rule itself
// lives in workspace.ts's workspaceDbName(), shared verbatim with the drafts
// stores (drafts.ts, alignmentDrafts.ts) — see issue #228.
function outboxDbName(): string {
  return workspaceDbName("bible-editor-outbox");
}

const DB_VERSION = 1;
const STORE = "ops";

// Hard cap on retry attempts that reached a *responding* server. backoffMs()
// saturates around 30s, so 20 attempts is ~10 minutes of real-world
// wall-clock for a transient server error (5xx / 408 / 425 / 429). Beyond
// that the op is almost certainly stuck on something structural (deleted
// row, malformed payload) — keep retrying and we just churn the network and
// battery. Only those server errors consume the cap (tracked in
// `hardAttempts`); network failures and auth retries can recur indefinitely
// — an offline laptop or a signed-out session must never burn queued edits.
// At the cap the op transitions to `failed` with `lastError =
// "max_attempts_exceeded"`; the user sees it in the failed-ops drawer and
// can Retry (resets attempts) or Discard, and it auto-revives when the
// connection or session comes back (see reviveMaxAttemptsFailed).
const MAX_ATTEMPTS = 20;

// Cap on silent re-arm-and-retry after a 409 that we judged spurious — either a
// reorder-only patch (sort_order is transient last-write-wins, see api/src/rows.ts
// "transient fields like sort_order") or a content patch that doesn't genuinely
// conflict with the server's current row (see classifyRowPatchConflict). Neither
// should surface a conflict prompt. This cap stops a pathological loop if another
// writer is bumping the same row faster than we can land — beyond it, fall through
// to the normal conflict flow.
const MAX_CONFLICT_AUTOHEAL = 5;

// recoverInFlight only re-arms in_flight ops at least this stale. A live
// request can't outlast its api.ts timeout, so 2× that means "the tab that
// dispatched this is gone (crash / reload), not mid-request" — without the
// threshold, a second tab's drain would re-arm the first tab's live op and
// double-PATCH it.
const IN_FLIGHT_RECOVERY_AGE_MS = 2 * DEFAULT_REQUEST_TIMEOUT_MS;

export interface RowTarget {
  kind: "row";
  rowKind: RowKind;
  id: string;
  book: string;
}
export interface VerseTarget {
  kind: "verse";
  book: string;
  chapter: number;
  verse: number;
  bibleVersion: string;
}
export interface VerseStatusTarget {
  kind: "verse_status";
  book: string;
  chapter: number;
  verse: number;
}
export interface LaneCheckTarget {
  kind: "lane_check";
  book: string;
  chapter: number;
  verse: number;
  lane: CheckLane;
}
export type OpTarget = RowTarget | VerseTarget | VerseStatusTarget | LaneCheckTarget;

export type OpStatus = "pending" | "in_flight" | "conflict" | "failed";
export type OpAction = "patch" | "delete";

export interface OutboxOp {
  id: string;               // op uuid (separate from row id)
  target: OpTarget;
  action: OpAction;
  patch: Record<string, unknown>;
  expectedVersion: number;
  queuedAt: number;
  // Monotonic per-session counter breaking queuedAt ties (ms granularity) so
  // two enqueues in the same millisecond keep their true order — the IDB
  // index otherwise falls back to primary-key (uuid) order. Absent on
  // records persisted before this field existed; treated as 0.
  seq?: number;
  attempts: number;
  // Failures that consume the MAX_ATTEMPTS cap — genuine server errors only
  // (transient 5xx/408/425/429). Network and auth retries bump `attempts`
  // (which drives backoff) but not this. Absent = 0.
  hardAttempts?: number;
  // Wall-clock of the last pending → in_flight transition. recoverInFlight
  // uses it to distinguish a crashed tab's orphan from another tab's live
  // request.
  dispatchedAt?: number;
  status: OpStatus;
  lastError?: string;
  conflictCurrent?: unknown;
  // Count of silent re-arms after a sort_order-only 409 (see
  // MAX_CONFLICT_AUTOHEAL). Absent = 0.
  conflictRetries?: number;
  // Set when this patch came from "switch to v{N}" in the history dialog.
  // The server stores it on the new edit_log entry + the row's column so
  // the UI can label the chip v{N} even though row.version is now N+1.
  restoredFromVersion?: number;
  // The row's values for the patched fields at the moment we enqueued (the
  // version we branched from). On a 409 this lets us tell a spurious conflict
  // (the server changed a *different* field, or already has our value) from a
  // genuine one (the server changed a field we're also editing). Only set for
  // row patches; absent for verse/status/lane ops and pre-baseline records.
  baseline?: Record<string, unknown>;
  // The source_generation the verse was loaded under. Sent as X-Source-Generation
  // so the server can reject edits against a superseded generation.
  sourceGeneration?: number;
  // Exact local text-draft generation captured by this save. Used only for
  // generation-safe cleanup after a successful verse PATCH (see
  // draftSaveState.ts). Unrelated to sourceGeneration above (a server-side
  // lane concept).
  draftGeneration?: string;
  // Set when a scripture lane freezes for replacement. Quarantined ops stay in
  // IDB as failed recovery copies — a late 200 from an in-flight dispatch must
  // not delete them (see drainPass).
  quarantined?: string;
}

// Ops still awaiting a settled outcome — either queued or on the wire. Shared
// by SyncStatusBar's "saving N" pill and WorkspaceSwitcher's pre-switch guard
// (an unsaved edit must finish syncing before a workspace switch, since the
// outbox is about to be renamed to the new org's database).
export function isOpPending(op: OutboxOp): boolean {
  return op.status === "pending" || op.status === "in_flight";
}

type Subscriber = (ops: OutboxOp[]) => void;

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    // Resolved at first-open time (not module load) so it picks up a slug
    // written during boot reconciliation (see App.tsx) before any op is queued.
    dbp = openDB(outboxDbName(), DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("queuedAt", "queuedAt");
          store.createIndex("status", "status");
        }
      },
    });
  }
  return dbp;
}

const subscribers = new Set<Subscriber>();

async function listAll(): Promise<OutboxOp[]> {
  const tx = (await db()).transaction(STORE, "readonly");
  const all = (await tx.store.index("queuedAt").getAll()) as OutboxOp[];
  // The index orders queuedAt ties by primary key (random uuid) — re-sort
  // with seq as tiebreak so same-millisecond enqueues drain in true order.
  all.sort((a, b) => a.queuedAt - b.queuedAt || (a.seq ?? 0) - (b.seq ?? 0));
  return all;
}

// Coalesce notify() calls onto a single microtask. drainPass calls notify()
// twice per drained op (after the in_flight flip, after the result persists),
// and each call does a full-store read + sort. Batching collapses a burst of
// calls in the same tick into one read+broadcast; subscribers only care about
// the latest snapshot anyway.
let notifyScheduled = false;
// Set when a notify() arrives while a read+dispatch is already in flight. The
// flag stays raised across the whole read+dispatch (not reset before the await
// resolves), so a swallowed notify in that window doesn't strand the UI on a
// stale snapshot — we loop and re-read.
let notifyPendingRerun = false;
async function notify() {
  if (subscribers.size === 0) return;
  if (notifyScheduled) {
    // A read+dispatch is in flight. Its listAll() may have already resolved,
    // so the snapshot it broadcasts could predate the state this call reflects.
    // Request a re-run instead of dropping the notification.
    notifyPendingRerun = true;
    return;
  }
  notifyScheduled = true;
  await Promise.resolve();
  // Keep the flag raised across the full read+dispatch so concurrent notify()
  // calls coalesce into notifyPendingRerun rather than slipping through.
  do {
    notifyPendingRerun = false;
    if (subscribers.size === 0) break;
    const all = await listAll();
    for (const s of subscribers) s(all);
    // If a notify() arrived while listAll()/dispatch ran, re-read so the last
    // snapshot the UI settles on reflects the latest committed state.
  } while (notifyPendingRerun);
  notifyScheduled = false;
}

function uid() {
  // crypto.randomUUID is universally available in modern browsers / workers.
  return crypto.randomUUID();
}

// See OutboxOp.seq. Per-session is enough: across reloads queuedAt itself
// can't tie (a reload takes well over a millisecond).
let seqCounter = 0;
function nextSeq(): number {
  return ++seqCounter;
}

// In read-only mode (viewer role), enqueue methods short-circuit before
// touching IndexedDB so a viewer who types in a note never produces a
// "failed" chip downstream. Local React state still reflects the typing —
// the read-only banner above the Shell explains why nothing persists.
function noopOp(target: OpTarget, action: OpAction, patch: Record<string, unknown>): OutboxOp {
  return {
    id: "readonly-noop",
    target,
    action,
    patch,
    expectedVersion: 0,
    queuedAt: Date.now(),
    attempts: 0,
    status: "pending",
  };
}

// targetKey / isMaxAttemptsBlocked / eligibleForVersionThread live in
// outboxTargeting.ts, not here — that module has no dependency on api.ts (its
// ApiError class uses a TS parameter-property constructor Node's strip-types
// loader can't erase), so it can be `import()`ed directly by a plain Node
// regression test. See outboxTargeting.test.mjs for the upstream-#487 coverage.

export const outbox = {
  subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    void listAll().then(fn);
    return () => subscribers.delete(fn);
  },

  async enqueueRow(
    rowKind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts: { restoredFromVersion?: number; book: string; baseline?: Record<string, unknown> },
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "row", rowKind, id, book: opts.book }, "patch", patch);
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id, book: opts.book },
      action: "patch",
      patch,
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
      ...(opts.restoredFromVersion !== undefined
        ? { restoredFromVersion: opts.restoredFromVersion }
        : {}),
      ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  async enqueueDeleteRow(
    rowKind: RowKind,
    id: string,
    expectedVersion: number,
    book: string,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "row", rowKind, id, book }, "delete", {});
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "row", rowKind, id, book },
      action: "delete",
      patch: {},
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  async enqueueVerse(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    patch: { content: unknown; plain_text?: string | null; alignment_intent?: AlignmentIntent },
    opts?: { sourceGeneration?: number; draftGeneration?: string },
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp(
        { kind: "verse", book, chapter, verse, bibleVersion },
        "patch",
        patch as Record<string, unknown>,
      );
    }
    // Lane freeze: refuse to ship — park as a failed/quarantined recovery copy
    // with no network attempt. Covers the window before projectConfig refresh.
    if (isLaneFrozen(bibleVersion)) {
      const reason = laneQuarantineReason(bibleVersion);
      const op: OutboxOp = {
        id: uid(),
        target: { kind: "verse", book, chapter, verse, bibleVersion },
        action: "patch",
        patch: patch as Record<string, unknown>,
        expectedVersion,
        queuedAt: Date.now(),
        seq: nextSeq(),
        attempts: 0,
        status: "failed",
        lastError: reason,
        quarantined: reason,
        ...(opts?.sourceGeneration != null ? { sourceGeneration: opts.sourceGeneration } : {}),
      };
      await (await db()).put(STORE, op);
      void notify();
      return op;
    }
    const op: OutboxOp = {
      id: uid(),
      target: { kind: "verse", book, chapter, verse, bibleVersion },
      action: "patch",
      patch: patch as Record<string, unknown>,
      expectedVersion,
      queuedAt: Date.now(),
      seq: nextSeq(),
      attempts: 0,
      status: "pending",
      ...(opts?.sourceGeneration != null ? { sourceGeneration: opts.sourceGeneration } : {}),
      ...(opts?.draftGeneration ? { draftGeneration: opts.draftGeneration } : {}),
    };
    await (await db()).put(STORE, op);
    void notify();
    void drain();
    return op;
  },

  // verse_status (done flag) has no version field — the worker upserts on
  // primary key (book, chapter, verse) with a UPSERT-style ON CONFLICT. We
  // still want it in the outbox so an offline toggle survives a crash and
  // doesn't need the user to re-click after reconnecting. Coalesce queued
  // toggles for the same verse so a rapid click→click→click only ships the
  // last value.
  async enqueueVerseStatus(
    book: string,
    chapter: number,
    verse: number,
    done: boolean,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "verse_status", book, chapter, verse }, "patch", { done });
    }
    const idb = await db();
    const key = `vstatus:${book}:${chapter}:${verse}`;
    // Find-and-rewrite in a SINGLE readwrite transaction. The old two-step
    // (getAll in one tx, put in another) raced the drain: between the read
    // and the write, drain could flip the found op pending → in_flight and
    // delete it on 200, so our coalesced payload landed on a doomed op and
    // the toggle vanished unsent. One tx makes the check-and-rewrite atomic
    // against drain's own single-tx pending → in_flight transition.
    //
    // Coalesce only into *pending* ops. Rewriting an in_flight op's payload
    // races the drain worker regardless of tx boundaries (the request already
    // left with the old payload, and the 200 handler deletes the op). If the
    // only op for this verse is mid-flight, queue a fresh one behind it
    // (upsert route, no If-Match, so it simply lands after).
    const tx = idb.transaction(STORE, "readwrite");
    const all = (await tx.store.getAll()) as OutboxOp[];
    const pending = all.find(
      (o) => targetKey(o.target) === key && o.status === "pending",
    );
    let result: OutboxOp;
    if (pending) {
      // Coalesce: rewrite the existing op's payload rather than queue a
      // second one that would just race to overwrite the first.
      pending.patch = { done };
      pending.queuedAt = Date.now();
      pending.seq = nextSeq();
      await tx.store.put(pending);
      result = pending;
    } else {
      result = {
        id: uid(),
        target: { kind: "verse_status", book, chapter, verse },
        action: "patch",
        patch: { done },
        expectedVersion: 0,
        queuedAt: Date.now(),
        seq: nextSeq(),
        attempts: 0,
        status: "pending",
      };
      await tx.store.put(result);
    }
    await tx.done;
    void notify();
    void drain();
    return result;
  },

  // lane_check (per-resource checkoff stamp) — same upsert/coalesce shape as
  // verse_status: no version, the (user, lane) row is what's toggled, so rapid
  // click-click only ships the final state. Offline-safe like every other op.
  async enqueueLaneCheck(
    book: string,
    chapter: number,
    verse: number,
    lane: CheckLane,
    checked: boolean,
  ): Promise<OutboxOp> {
    if (isReadOnly()) {
      return noopOp({ kind: "lane_check", book, chapter, verse, lane }, "patch", { checked });
    }
    const idb = await db();
    const key = `lanecheck:${book}:${chapter}:${verse}:${lane}`;
    const tx = idb.transaction(STORE, "readwrite");
    const all = (await tx.store.getAll()) as OutboxOp[];
    const pending = all.find((o) => targetKey(o.target) === key && o.status === "pending");
    let result: OutboxOp;
    if (pending) {
      pending.patch = { checked };
      pending.queuedAt = Date.now();
      pending.seq = nextSeq();
      await tx.store.put(pending);
      result = pending;
    } else {
      result = {
        id: uid(),
        target: { kind: "lane_check", book, chapter, verse, lane },
        action: "patch",
        patch: { checked },
        expectedVersion: 0,
        queuedAt: Date.now(),
        seq: nextSeq(),
        attempts: 0,
        status: "pending",
      };
      await tx.store.put(result);
    }
    await tx.done;
    void notify();
    void drain();
    return result;
  },

  // Re-arm a conflicted op against the freshly-observed server version. Also
  // resets every op for the same target so a single user resolution doesn't
  // cascade-conflict the queue (otherwise N edits to one row produce N
  // prompts for what was logically one upstream change).
  async resolveConflict(opId: string, newExpectedVersion: number) {
    const idb = await db();
    // Read AND write inside ONE readwrite tx. The old two-step (get + getAll in
    // autocommit txs, then put in a new tx) raced the drain: between the read
    // and the write, drain could flip a sibling pending → in_flight, and the
    // stale write here would clobber that transition (re-arming a live op and
    // double-PATCHing it). Re-check status inside the tx so we only touch ops
    // still safe to reset.
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (!op) {
      await tx.done;
      return;
    }
    const key = targetKey(op.target);
    const all = (await tx.store.getAll()) as OutboxOp[];
    for (const o of all) {
      if (targetKey(o.target) !== key) continue;
      if (o.status === "conflict" || o.status === "pending") {
        o.expectedVersion = newExpectedVersion;
        o.status = "pending";
        o.conflictCurrent = undefined;
        await tx.store.put(o);
      }
    }
    await tx.done;
    void notify();
    void drain();
  },

  // onlyIfStatus excludes "in_flight": the unconditional in_flight guard below
  // returns first, so that value could never match — don't promise it.
  async drop(opId: string, opts?: { onlyIfStatus?: Exclude<OpStatus, "in_flight"> }) {
    // Guard against dropping an op the drain just flipped to in_flight (same
    // race the drain itself guards at the listAll → fresh re-read). A request
    // is already on the wire; deleting the record here would race the 200
    // handler's own delete and could strand or double-handle the result. Leave
    // in_flight ops alone — they resolve on their own; the user can drop them
    // once they settle. Read-and-check inside one readwrite tx so we don't
    // open a window against drain's pending → in_flight transition.
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (op && op.status === "in_flight") {
      await tx.done;
      return;
    }
    // A caller acting on a snapshot (the confirm-before-discard dialogs) may
    // be stale: another tab can re-arm a conflict/failed op to pending between
    // snapshot and click, and deleting it then destroys an edit that's about
    // to save. onlyIfStatus makes the check-and-delete atomic inside this tx.
    if (op && opts?.onlyIfStatus && op.status !== opts.onlyIfStatus) {
      await tx.done;
      // The mismatch means this tab just observed state it may not know about
      // (cross-tab writes never reach this tab's notify) — broadcast so the
      // UI catches up, and drain in case the op is now pending.
      void notify();
      void drain();
      return;
    }
    await tx.store.delete(opId);
    await tx.done;
    void notify();
    void drain();
  },

  // User-driven recovery for a `failed` op (typically one that hit
  // max_attempts_exceeded against a transient back-end issue that has since
  // cleared). Resets the attempt counter so it gets a full retry budget,
  // not just one more shot before re-failing.
  async retry(opId: string) {
    const idb = await db();
    // Read-and-check inside one readwrite tx. If the drain just flipped this op
    // to in_flight, a request is already on the wire — resetting it to pending
    // here would let a second drain re-dispatch it (double-PATCH) or clobber
    // the in-flight result. Leave in_flight ops alone; they resolve on their
    // own. pending/failed ops retry as before (failed → fresh attempt budget).
    const tx = idb.transaction(STORE, "readwrite");
    const op = (await tx.store.get(opId)) as OutboxOp | undefined;
    if (!op || op.status === "in_flight") {
      await tx.done;
      return;
    }
    // Still-frozen lane: keep the quarantine — retrying would just re-fail.
    if (
      op.quarantined &&
      op.target.kind === "verse" &&
      isLaneFrozen(op.target.bibleVersion)
    ) {
      await tx.done;
      return;
    }
    // Deliberately leave queuedAt/seq untouched. A max-attempts-failed op was
    // holding its target's place in the FIFO (isMaxAttemptsBlocked); flipping
    // status to "pending" forfeits that protection, so keeping its original
    // queue position is what stops a sibling that queued while it sat failed
    // from leapfrogging it, landing first, and getting silently reverted when
    // this op drains after being threaded the sibling's fresh version
    // (upstream #487 / PR #504). Do not "freshen" queuedAt/seq here.
    op.status = "pending";
    op.attempts = 0;
    op.hardAttempts = 0;
    op.lastError = undefined;
    op.quarantined = undefined;
    await tx.store.put(op);
    await tx.done;
    void notify();
    void drain();
  },

  async list(): Promise<OutboxOp[]> {
    return listAll();
  },

  // Quarantine every queued verse op for a bible_version whose lane just froze
  // for a replacement. The active generation is about to flip, so any still-
  // queued edit is against a generation the server will reject (or, worse,
  // would land on soon-to-be-superseded content). Mark them `failed` with a
  // durable `quarantined` flag so they surface in the failed-ops drawer and a
  // late 200 from an already-in-flight dispatch cannot delete the recovery
  // copy. Touches pending / in_flight / conflict / failed (e.g. raced to
  // http 403 before freeze landed) ops. Returns the count quarantined.
  async quarantineLaneOps(bibleVersion: string, reason: string): Promise<number> {
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const all = (await tx.store.getAll()) as OutboxOp[];
    let n = 0;
    for (const o of all) {
      if (o.target.kind !== "verse") continue;
      if (o.target.bibleVersion !== bibleVersion) continue;
      if (o.quarantined) continue;
      if (
        o.status === "pending" ||
        o.status === "in_flight" ||
        o.status === "conflict" ||
        o.status === "failed"
      ) {
        o.status = "failed";
        o.lastError = reason;
        o.quarantined = reason;
        o.conflictCurrent = undefined;
        await tx.store.put(o);
        n++;
      }
    }
    await tx.done;
    void notify();
    return n;
  },
};

// ---------- drain ----------

let draining = false;
// Set when drain() is called while a drain is already active — mirrors
// notify()'s notifyPendingRerun. An enqueue whose IDB put commits after the
// running pass's final listAll() snapshot, and whose drain() call lands
// before `draining` flips false, is neither seen by that pass nor able to
// start a new one; without this flag the op sits pending until an unrelated
// trigger (focus/online/next enqueue). The active drain consumes the flag by
// re-running drainPass before it finishes.
let drainRequested = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
// Wall-clock deadline of the pending drainTimer, 0 when none. scheduleDrain
// only replaces the timer when the new deadline is EARLIER — with a single
// shared timer, a long reschedule (young in-flight recovery, up to the 60s
// recovery age) would otherwise clobber a short due retry (~250ms backoff)
// and an op due in 250ms could wait the full recovery age.
let drainTimerAt = 0;

type Result =
  | { kind: "ok"; updated: unknown }
  | { kind: "conflict"; current: unknown }
  | { kind: "retry"; reason: string }
  | { kind: "fatal"; reason: string }
  // Chapter is locked because an AI pipeline is mid-flight. The auto-apply
  // step will overwrite the row anyway, so retrying is pointless — the op
  // gets dropped and the listener can surface a toast.
  | { kind: "locked"; lockBody: ChapterLockedBody };

export type { Result as OutboxResult };

type ResultListener = (op: OutboxOp, result: Result) => void;
const resultListeners = new Set<ResultListener>();
export function onOutboxResult(fn: ResultListener): () => void {
  resultListeners.add(fn);
  return () => resultListeners.delete(fn);
}

function unexpectedAlignmentLossReason(body: unknown): string | null {
  const error = (body as { error?: unknown } | null)?.error;
  if (error !== "unexpected_alignment_loss") return null;
  const losses = (body as { delta?: { unexpectedLosses?: unknown[] } } | null)
    ?.delta?.unexpectedLosses;
  const sample = Array.isArray(losses)
    ? losses
        .slice(0, 3)
        .map((loss) => (loss as { text?: unknown } | null)?.text)
        .filter((text): text is string => typeof text === "string" && text.length > 0)
        .join(", ")
    : "";
  return `unexpected_alignment_loss${sample ? `: ${sample}` : ""}`;
}

async function dispatch(op: OutboxOp): Promise<Result> {
  try {
    let updated: unknown;
    if (op.target.kind === "row") {
      if (op.action === "delete") {
        updated = await api.deleteRow(
          op.target.rowKind,
          op.target.id,
          op.expectedVersion,
          op.target.book,
        );
      } else {
        updated = await api.patchRow(
          op.target.rowKind,
          op.target.id,
          op.expectedVersion,
          op.patch,
          {
            ...(op.restoredFromVersion !== undefined ? { restoredFromVersion: op.restoredFromVersion } : {}),
            book: op.target.book,
          },
        );
      }
    } else if (op.target.kind === "verse_status") {
      updated = await api.setVerseDone(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        Boolean((op.patch as { done?: boolean }).done),
      );
    } else if (op.target.kind === "lane_check") {
      updated = await api.setLaneCheck(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        op.target.lane,
        Boolean((op.patch as { checked?: boolean }).checked),
      );
    } else {
      updated = await api.patchVerse(
        op.target.book,
        op.target.chapter,
        op.target.verse,
        op.target.bibleVersion,
        op.expectedVersion,
        op.patch as { content: unknown; plain_text?: string | null },
        { sourceGeneration: op.sourceGeneration },
      );
    }
    return { kind: "ok", updated };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) {
        if (isChapterLockedBody(e.body)) {
          return { kind: "locked", lockBody: e.body };
        }
        const alignmentLoss = unexpectedAlignmentLossReason(e.body);
        if (alignmentLoss) {
          return { kind: "fatal", reason: alignmentLoss };
        }
        // Lane-specific terminal errors: the verse's generation is stale or a
        // replacement is active — retrying won't help; quarantine immediately.
        const errCode = (e.body as { error?: string } | null)?.error;
        if (errCode === "workspace_mismatch") {
          // This tab's X-Workspace header (its own notion of the active org)
          // no longer matches the workspace the server resolved the request
          // against — a SIBLING tab switched orgs out from under it (see
          // api.ts's request() and workspaces.ts's requireWorkspaceMatch).
          // This is NOT a version conflict: don't surface a merge prompt,
          // don't burn the retry-attempt cap (reason doesn't start with
          // "transient"). The op still belongs to — and is valid against —
          // the OTHER workspace's outbox database; leave it queued as-is. Once
          // api.ts's reload lands the user back where their outbox agrees
          // with the server, it drains normally.
          return { kind: "retry", reason: "workspace_mismatch" };
        }
        if (
          errCode === "source_generation_mismatch" ||
          errCode === "lane_replacement_required" ||
          errCode === "lane_replacement_in_progress" ||
          errCode === "scripture_text_read_only" ||
          errCode === "scripture_fully_locked"
        ) {
          return { kind: "fatal", reason: errCode };
        }
        const body = e.body as { current?: unknown } | undefined;
        return { kind: "conflict", current: body?.current };
      }
      if (e.status === 401) {
        // Token missing/expired. Don't burn retries against a wall — pause
        // and let an outer reauth refresh the token. The op stays pending.
        return { kind: "retry", reason: `auth ${e.status}` };
      }
      // Transient HTTP signals: rate-limit, timeout, too-early. 5xx is the
      // server saying "try again". 503 / 504 explicitly.
      if (
        e.status === 408 ||
        e.status === 425 ||
        e.status === 429 ||
        e.status >= 500
      ) {
        return { kind: "retry", reason: `transient ${e.status}` };
      }
      // A csrf_mismatch 403 is recoverable: the be_csrf cookie expired but the
      // session is still valid. api.ts already refreshes-and-retries inline; if
      // one still reaches here (refresh raced/failed), keep the op pending and
      // retry rather than failing it permanently. read_only 403s carry no
      // `error` body and fall through to fatal, as they must (they'd loop).
      if (
        e.status === 403 &&
        (e.body as { error?: string } | undefined)?.error === "csrf_mismatch"
      ) {
        return { kind: "retry", reason: "csrf_mismatch" };
      }
      // 403, 404, 422, 428 etc. are non-retryable client errors — sending
      // the same payload again won't change the outcome.
      return { kind: "fatal", reason: `http ${e.status}` };
    }
    return { kind: "retry", reason: "network" };
  }
}

// Re-arm anything stuck mid-flight from a previous tab crash / hot reload.
// Without this, the drain filter (status === "pending") would skip ops that
// were transitioned to "in_flight" but never resolved. Age-gated on
// dispatchedAt so we never re-arm another live tab's in-flight request
// (the request can't outlast its timeout; see IN_FLIGHT_RECOVERY_AGE_MS).
// Records without dispatchedAt predate the field — recover them as before.
//
// Returns the soonest wall-clock at which a *young* (skipped) in-flight op
// becomes recovery-eligible, or undefined if there were none. drainPass uses
// it to self-schedule the next pass: without it, a save → reload within the
// recovery age leaves the op in_flight with no pending work and nothing arms
// a timer, so the edit stalls until an unrelated trigger (focus/online/new
// enqueue) fires after the age elapses.
async function recoverInFlight(): Promise<number | undefined> {
  const idb = await db();
  // Query the status index instead of scanning the whole store — only
  // in_flight ops are candidates here.
  const inFlight = (await idb
    .transaction(STORE, "readonly")
    .store.index("status")
    .getAll("in_flight")) as OutboxOp[];
  const now = Date.now();
  const stuck: OutboxOp[] = [];
  let soonestYoungEligibility: number | undefined;
  for (const o of inFlight) {
    if (o.dispatchedAt === undefined || now - o.dispatchedAt > IN_FLIGHT_RECOVERY_AGE_MS) {
      stuck.push(o);
    } else {
      // Skipped (another live tab may own it) — track when it would become
      // eligible so the caller can re-check then.
      const eligibleAt = o.dispatchedAt + IN_FLIGHT_RECOVERY_AGE_MS;
      if (soonestYoungEligibility === undefined || eligibleAt < soonestYoungEligibility) {
        soonestYoungEligibility = eligibleAt;
      }
    }
  }
  if (stuck.length === 0) return soonestYoungEligibility;
  const tx = idb.transaction(STORE, "readwrite");
  for (const o of stuck) {
    o.status = "pending";
    o.lastError = "recovered_from_in_flight";
    await tx.store.put(o);
  }
  await tx.done;
  return soonestYoungEligibility;
}

// A 200 means the server's version for this target just advanced; sibling
// ops queued behind the completed one still carry the old expectedVersion
// and would self-409 in a guaranteed cascade (offline double-save, AI-draft
// apply). Thread the confirmed version into them — with several siblings
// queued, each landing re-threads the rest. Skips `conflict` ops (those are
// owned by the user-resolve flow: drain won't pick them up, and
// resolveConflict overwrites expectedVersion anyway), max-attempts-failed ops
// (see eligibleForVersionThread — upstream #487), and anything without a
// numeric version in the response (verse_status upserts, row deletes).
async function threadVersionToSiblings(done: OutboxOp, updated: unknown) {
  const version = (updated as { version?: unknown } | null | undefined)?.version;
  if (typeof version !== "number") return;
  const key = targetKey(done.target);
  const idb = await db();
  // Read AND write inside ONE readwrite tx. The old two-step (getAll in an
  // autocommit tx, then put in a new tx) raced the drain: between the read and
  // the write, drain could flip a sibling pending → in_flight, and re-threading
  // its version here would clobber that live op. Re-check status inside the tx
  // so we only thread ops still pending/failed (never an in_flight one).
  const tx = idb.transaction(STORE, "readwrite");
  const all = (await tx.store.getAll()) as OutboxOp[];
  for (const o of all) {
    if (
      targetKey(o.target) === key &&
      eligibleForVersionThread(o) &&
      o.expectedVersion !== version
    ) {
      o.expectedVersion = version;
      await tx.store.put(o);
    }
  }
  await tx.done;
}

// A reorder enqueues a patch whose only field is sort_order. Such patches are
// last-write-wins and must never raise a user-facing conflict — they auto-heal
// against the server's current version instead.
function isSortOrderOnlyPatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === "sort_order";
}

async function drainPass() {
  const youngInFlightEligibleAt = await recoverInFlight();
  // Targets this pass has itself just parked as conflict/retry-backoff
  // (below) — must stay blocked for the rest of the pass regardless of what
  // a later snapshot shows, since the backoff hasn't elapsed yet. This is
  // distinct from the per-iteration recompute below: unlike a live status
  // check, nothing will flip these back to pending mid-pass, so pinning is
  // correct here and doesn't reintroduce upstream issue #515. Blocking is
  // per-target either way, so a single hot row doesn't freeze the queue.
  const pinnedBlocked = new Set<string>();
  while (true) {
    // Offline — nothing can leave the machine, so dispatching would only
    // burn attempts against guaranteed failures. Park the queue (mirrors
    // the offline wait in fetchWithRetry.ts); the `online` listener below
    // re-drains the moment connectivity returns.
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    const ops = await listAll();
    // Mark any target with a still-conflicted op as blocked, so we don't
    // pick up sibling pending ops with stale expectedVersion either. A
    // max-attempts-failed op blocks the same way (isMaxAttemptsBlocked —
    // upstream #487): it WILL auto-revive with a stale expectedVersion, so a
    // younger pending sibling must not be allowed to land ahead of it and
    // then get silently reverted when the older op re-arms. Fatal
    // (non-revivable) failed ops are excluded from this — nothing will ever
    // re-send them, so blocking on them would freeze the target forever.
    //
    // Recomputed fresh from this iteration's snapshot every time (seeded
    // from pinnedBlocked, not accumulated into it) — upstream issue #515: if
    // retry() or reviveMaxAttemptsFailed() flips a blocking op back to
    // pending while this pass is running, their own drain() call is a
    // no-op (a pass is already active), so this loop is the only thing
    // that will ever notice. A blocked set that only ever grew would keep
    // treating that target as blocked for the rest of the pass even after
    // its live status no longer justifies it, stranding the revived op
    // until some unrelated trigger fires.
    const blocked = new Set(pinnedBlocked);
    for (const o of ops) {
      if (o.status === "conflict" || isMaxAttemptsBlocked(o)) blocked.add(targetKey(o.target));
    }
    let next = ops.find(
      (o) => o.status === "pending" && !blocked.has(targetKey(o.target)),
    );
    if (!next) {
      // No pending work, but recoverInFlight skipped a young in-flight op
      // (its dispatching tab may have crashed/reloaded). Nothing else will
      // re-check it — the retry-backoff and online/focus triggers only fire
      // on other events — so schedule a pass for when it becomes recovery-
      // eligible, plus a small margin to clear the age threshold. This keeps
      // the retry chain self-continuing instead of stalling for the full age.
      if (youngInFlightEligibleAt !== undefined) {
        scheduleDrain(Math.max(0, youngInFlightEligibleAt - Date.now()) + 250);
      }
      break;
    }
    // Re-read the record fresh inside the same readwrite tx that flips it
    // in_flight, rather than trusting the snapshot listAll() handed us. A
    // verse-status coalesce (enqueueVerseStatus) may have rewritten this op's
    // payload after listAll() read it; dispatching the stale `next` would
    // ship the pre-coalesce value and the toggle would be lost. Re-reading
    // here picks up the coalesced payload; if the op vanished or is no longer
    // pending (another path claimed it), skip and re-loop.
    const tx = (await db()).transaction(STORE, "readwrite");
    const fresh = (await tx.store.get(next.id)) as OutboxOp | undefined;
    if (!fresh || fresh.status !== "pending") {
      await tx.done;
      continue;
    }
    // Local freeze may have landed after enqueue — park as quarantined recovery
    // without sending another PATCH that would race the generation flip.
    if (
      fresh.target.kind === "verse" &&
      isLaneFrozen(fresh.target.bibleVersion)
    ) {
      const reason = laneQuarantineReason(fresh.target.bibleVersion);
      fresh.status = "failed";
      fresh.lastError = reason;
      fresh.quarantined = reason;
      await tx.store.put(fresh);
      await tx.done;
      void notify();
      continue;
    }
    fresh.status = "in_flight";
    fresh.attempts += 1;
    fresh.dispatchedAt = Date.now();
    await tx.store.put(fresh);
    await tx.done;
    next = fresh;
    void notify();

    let result: Result;
    try {
      result = await dispatch(next);
    } catch (err) {
      result = { kind: "retry", reason: `dispatch_threw: ${String(err)}` };
    }

    // Persist the new status *before* notifying listeners. If a put() or
    // delete() throws, the catch below resets the op to pending so it
    // doesn't strand at in_flight.
    //
    // Always re-read before mutating: quarantineLaneOps may have flipped this
    // op to failed+quarantined while dispatch was in flight. Check + delete/put
    // MUST share one readwrite transaction so a quarantine between get and
    // delete cannot erase recovery. Mutate must be synchronous (no other awaits
    // while the txn is open) so IndexedDB does not auto-commit early.
    const settleAfterDispatch = async (
      mutate: (stored: OutboxOp) => "delete" | "put",
    ): Promise<"deleted" | "quarantined" | "kept" | "missing"> => {
      if (!next) return "missing";
      const idb = await db();
      const tx = idb.transaction(STORE, "readwrite");
      const stored = (await tx.store.get(next.id)) as OutboxOp | undefined;
      if (!stored) {
        await tx.done;
        return "missing";
      }
      if (stored.quarantined) {
        stored.status = "failed";
        stored.lastError = stored.quarantined;
        stored.dispatchedAt = undefined;
        await tx.store.put(stored);
        await tx.done;
        next = stored;
        return "quarantined";
      }
      const action = mutate(stored);
      if (action === "delete") {
        await tx.store.delete(stored.id);
        await tx.done;
        return "deleted";
      }
      await tx.store.put(stored);
      await tx.done;
      next = stored;
      return "kept";
    };
    //
    // `persisted` records whether that persist committed, so the listener
    // dispatch below can tell a genuine terminal exit from one that got
    // walked back (upstream issue #570).
    let persisted = true;
    try {
      if (result.kind === "ok") {
        await settleAfterDispatch(() => "delete");
        try {
          await threadVersionToSiblings(next, result.updated);
        } catch {
          /* siblings keep their stale version and resolve via the 409 flow */
        }
      } else if (result.kind === "locked") {
        // The chapter is mid-pipeline; the auto-apply will overwrite this
        // row anyway. Drop the op — unless quarantine already claimed it.
        await settleAfterDispatch(() => "delete");
      } else if (result.kind === "conflict") {
        const settled = await settleAfterDispatch((stored) => {
          const serverVersion = (result.current as { version?: unknown } | null | undefined)
            ?.version;
          const sortOrderOnly =
            stored.target.kind === "row" &&
            stored.action === "patch" &&
            isSortOrderOnlyPatch(stored.patch);
          const nonConflictingContent =
            stored.target.kind === "row" &&
            stored.action === "patch" &&
            !sortOrderOnly &&
            classifyRowPatchConflict(
              stored.patch,
              stored.baseline,
              result.current as Record<string, unknown>,
            ) === "auto_heal";
          if (
            (sortOrderOnly || nonConflictingContent) &&
            typeof serverVersion === "number" &&
            (stored.conflictRetries ?? 0) < MAX_CONFLICT_AUTOHEAL
          ) {
            stored.status = "pending";
            stored.expectedVersion = serverVersion;
            stored.conflictRetries = (stored.conflictRetries ?? 0) + 1;
            stored.conflictCurrent = undefined;
            stored.lastError = sortOrderOnly ? "sort_order_autoheal" : "nonconflict_autoheal";
          } else {
            stored.status = "conflict";
            stored.conflictCurrent = result.current;
            stored.lastError = "version_mismatch";
            pinnedBlocked.add(targetKey(stored.target));
          }
          return "put";
        });
        if (settled === "quarantined") {
          /* keep quarantine */
        }
      } else if (result.kind === "retry") {
        const settled = await settleAfterDispatch((stored) => {
          // Only genuine server errors (`transient NNN`) consume MAX_ATTEMPTS.
          const capEligible = result.reason.startsWith("transient");
          if (capEligible) stored.hardAttempts = (stored.hardAttempts ?? 0) + 1;
          if (capEligible && (stored.hardAttempts ?? 0) >= MAX_ATTEMPTS) {
            stored.status = "failed";
            stored.lastError = MAX_ATTEMPTS_SENTINEL;
          } else {
            stored.status = "pending";
            stored.lastError = result.reason;
            scheduleDrain(backoffMs(stored.attempts));
            pinnedBlocked.add(targetKey(stored.target));
          }
          return "put";
        });
        if (settled === "quarantined") {
          /* keep quarantine */
        }
      } else {
        await settleAfterDispatch((stored) => {
          stored.status = "failed";
          stored.lastError = result.reason;
          if (
            stored.target.kind === "verse" &&
            (result.reason === "source_generation_mismatch" ||
              result.reason === "lane_replacement_required" ||
              result.reason === "lane_replacement_in_progress" ||
              result.reason === "scripture_text_read_only" ||
              result.reason === "scripture_fully_locked" ||
              isLaneFrozen(stored.target.bibleVersion) ||
              /^http 403$/.test(result.reason))
          ) {
            stored.quarantined =
              laneFreezeReason(stored.target.bibleVersion) ?? result.reason;
          }
          return "put";
        });
      }
    } catch (persistErr) {
      persisted = false;
      // Best-effort recovery — if IndexedDB itself failed, the op may be
      // half-written. Force pending so the next drain pass tries again —
      // unless quarantine already owns it.
      try {
        await settleAfterDispatch((stored) => {
          stored.status = "pending";
          stored.lastError = `persist_failed: ${String(persistErr)}`;
          return "put";
        });
      } catch {
        /* nothing we can do; will be picked up by recoverInFlight on reload */
      }
    }

    if (shouldAnnounceResult(result.kind, persisted)) {
      for (const l of resultListeners) l(next, result);
    }
    void notify();
  }
}

export async function drain() {
  if (draining) {
    // A pass is active. Request a re-run instead of dropping the wakeup —
    // the running pass's final listAll() may already have resolved, so the
    // op that prompted this call could be invisible to it.
    drainRequested = true;
    return;
  }
  draining = true;
  try {
    // Cross-tab mutual exclusion. Two tabs share one IndexedDB store; both
    // draining at once double-PATCHes the same ops. ifAvailable means we
    // never queue behind the other tab — if it holds the lock it's already
    // doing our work; check back shortly in case it closes mid-queue.
    if (typeof navigator !== "undefined" && navigator.locks) {
      const acquired = await navigator.locks.request(
        "be-outbox-drain",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) return false;
          await drainPass();
          // Consume queued wakeups while the lock is still held, so the
          // re-pass keeps the cross-tab exclusion drainPass relies on.
          while (drainRequested) {
            drainRequested = false;
            await drainPass();
          }
          return true;
        },
      );
      if (!acquired) scheduleDrain(3000);
    } else {
      // No Web Locks (very old browser) — fall back to single-tab behavior.
      await drainPass();
      while (drainRequested) {
        drainRequested = false;
        await drainPass();
      }
    }
  } finally {
    draining = false;
    void notify();
    // A wakeup can still land in the awaits between the re-pass loop above
    // and this line (lock release, promise resolution). `draining` is false
    // again now, so a fresh drain() re-acquires the lock and handles it.
    if (drainRequested) {
      drainRequested = false;
      void drain();
    }
  }
}

function scheduleDrain(ms: number) {
  const at = Date.now() + ms;
  if (drainTimer) {
    // Keep the pending timer when it fires no later than the new request —
    // clearing it unconditionally let a longer reschedule silently push out
    // an already-due retry (see drainTimerAt).
    if (at >= drainTimerAt) return;
    clearTimeout(drainTimer);
  }
  drainTimerAt = at;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    drainTimerAt = 0;
    void drain();
  }, ms);
}

// Ops that exhausted MAX_ATTEMPTS get a fresh retry budget when the world
// genuinely changes — connectivity returns or the session is refreshed.
// Without this, ~10 minutes of bad luck would park edits as `failed`
// forever (drain only picks up `pending`), one discard click from gone.
async function reviveMaxAttemptsFailed() {
  const idb = await db();
  // Read AND write inside ONE readwrite tx (same shape as resolveConflict).
  // The old two-step (index read in a readonly tx, puts in a new tx) raced
  // drop(): a user's Discard could delete the record in the gap, and the put
  // here would RE-CREATE it as pending — a user-discarded edit saving to the
  // server. Re-check status + the revivable sentinel on the freshly-read
  // records inside the tx so we only revive ops still parked as failed.
  const tx = idb.transaction(STORE, "readwrite");
  // Only `failed` ops are candidates — query the status index rather than
  // scanning the whole store.
  const failedOps = (await tx.store.index("status").getAll("failed")) as OutboxOp[];
  const revivable = failedOps.filter(
    (o) => o.status === "failed" && o.lastError === MAX_ATTEMPTS_SENTINEL,
  );
  if (revivable.length === 0) {
    await tx.done;
    return;
  }
  for (const o of revivable) {
    o.status = "pending";
    o.attempts = 0;
    o.hardAttempts = 0;
    o.lastError = undefined;
    await tx.store.put(o);
  }
  await tx.done;
  void notify();
}

async function reviveAndDrain() {
  await reviveMaxAttemptsFailed();
  await drain();
}

// Drain on focus / online so a sleeping tab catches up on wake. Also kick
// off an initial drain (which runs recoverInFlight first) so any ops left
// stranded by a previous tab crash get re-armed at startup.
if (typeof window !== "undefined") {
  window.addEventListener("online", () => void reviveAndDrain());
  window.addEventListener("focus", () => void drain());
  // A successful silent refresh means auth-stalled ops can move again.
  onAuthRefreshed(() => void reviveAndDrain());
  void drain();
}
