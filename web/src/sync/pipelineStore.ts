// In-memory store for AI pipeline jobs (chapter-scale generation, ~1h runs).
// Mirrors the outbox.subscribe pattern so any component can render off it;
// jobs themselves are durably stored in D1 by the Worker, so we don't need
// IndexedDB here.
//
// Lifecycle:
//   1. init() loads non-terminal jobs from /api/pipelines (reconciliation
//      on tab open / reload).
//   2. While the tab is visible and there is at least one job in a
//      polling state (running / paused_*), tick every 2 minutes and call
//      /api/pipelines/{jobId} on each.
//   3. start(req) POSTs /api/pipelines/start; the returned jobId becomes
//      our local key. `already_running` is folded into the same flow.
//
// Phase 1 does not parse output[] back into D1 rows. On state=done we just
// retain the job record and emit a completion event so UI can toast.

import {
  api,
  ApiError,
  type PipelineJobRow,
  type PipelineQueueSummary,
  type PipelineState,
  type PipelineStartRequest,
  type PipelineStartResponse,
  type PipelineStatusResponse,
  type PipelineType,
} from "./api";
import { currentPipelineUserId } from "./pipelineSession";
export { getSessionKey, setPipelineUser } from "./pipelineSession";

const POLL_INTERVAL_MS = 120_000; // contract §5

// queued/dispatching are polled too — GET /api/pipelines/:id returns their
// live queue position, so the chip's "#N in line" refreshes each tick.
const POLLING_STATES: ReadonlySet<PipelineState> = new Set([
  "queued",
  "dispatching",
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
]);
const NON_TERMINAL_STATES: ReadonlySet<PipelineState> = new Set([
  "queued",
  "dispatching",
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "failed",
]);

const DISMISSED_LS = "bible-editor.pipeline.dismissed";

export type PipelineJob = PipelineJobRow;

type JobsListener = (jobs: PipelineJob[]) => void;
type CompletionListener = (job: PipelineJob, prev: PipelineState | null) => void;
// "Open the status panel and focus this job." Fired when start() comes back
// as already_running — i.e. the user retried the same scope they're already
// watching, and a toast is less useful than just surfacing the running job.
type FocusListener = (jobId: string) => void;

const jobs = new Map<string, PipelineJob>();
const subscribers = new Set<JobsListener>();
const completionListeners = new Set<CompletionListener>();
const focusListeners = new Set<FocusListener>();

// Last-known global queue context (the single running job + total queued),
// refreshed on each loadFromServer. Drives the "running ahead of you" header.
let queueSummary: PipelineQueueSummary | null = null;

// Job IDs the user has explicitly dismissed from the status chip. Persists
// across reloads so loadFromServer doesn't resurrect them. Done jobs stay
// in D1 (the upstream pipeline service owns the lifecycle); we just hide
// them client-side.
function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_LS);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}
const dismissed: Set<string> = loadDismissed();
function persistDismissed() {
  try {
    localStorage.setItem(DISMISSED_LS, JSON.stringify(Array.from(dismissed)));
  } catch {
    /* private mode / no storage */
  }
}

let initStarted = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityBound = false;

// A job belongs to another user. Foreign jobs are visible (shared queue) but
// read-only: we can't poll their per-job status endpoint (it 403s on non-owned
// jobs), can't cancel them, and they refresh only via the list. When the user
// id isn't bound yet we treat nothing as foreign so we don't skip our own work.
function isForeign(job: PipelineJob): boolean {
  const me = currentPipelineUserId();
  return me != null && job.user_id !== me;
}

function snapshot(): PipelineJob[] {
  return Array.from(jobs.values()).sort((a, b) => b.updated_at - a.updated_at);
}

function notify() {
  if (subscribers.size === 0) return;
  const list = snapshot();
  for (const s of subscribers) s(list);
}

function emitCompletion(job: PipelineJob, prev: PipelineState | null) {
  for (const l of completionListeners) l(job, prev);
}

function emitFocusRequest(jobId: string) {
  for (const l of focusListeners) l(jobId);
}

// Normalize the camelCase StatusResponse into the snake_case row shape so
// everything downstream renders from one type.
function rowFromStatus(prev: PipelineJob, status: PipelineStatusResponse): PipelineJob {
  const updatedTs = Date.parse(status.updatedAt);
  const createdTs = Date.parse(status.createdAt);
  return {
    ...prev,
    // Keep prev.job_id — it's OUR stable local id. status.jobId may be the
    // bot's upstream id (on a polled running job) and must not clobber it.
    job_id: prev.job_id,
    queue_position: status.queuePosition ?? null,
    queue_ahead: status.queueAhead ?? null,
    pipeline_type: status.pipelineType ?? prev.pipeline_type,
    book: status.scope?.book ?? prev.book,
    start_chapter: status.scope?.startChapter ?? prev.start_chapter,
    end_chapter: status.scope?.endChapter ?? prev.end_chapter,
    state: status.state,
    current_skill: status.current?.skill ?? null,
    current_status: status.current?.status ?? null,
    error_kind: status.current?.errorKind ?? null,
    error_message: status.current?.error ?? null,
    output_json: status.output ? JSON.stringify(status.output) : prev.output_json,
    updated_at: Number.isFinite(updatedTs) ? Math.floor(updatedTs / 1000) : prev.updated_at,
    created_at: Number.isFinite(createdTs) ? Math.floor(createdTs / 1000) : prev.created_at,
    last_polled_at: Math.floor(Date.now() / 1000),
  };
}

function mergeAndNotify(jobId: string, next: PipelineJob) {
  const prev = jobs.get(jobId);
  jobs.set(jobId, next);
  let firedCompletion = false;
  // Toast on transitions to done/failed only. 'cancelled' is terminal too but
  // user-initiated, so it gets no completion toast.
  if (prev && prev.state !== next.state && (next.state === "done" || next.state === "failed")) {
    emitCompletion(next, prev.state);
    firedCompletion = true;
  }
  // Live transition to a terminal state with a toast already shown — tell
  // the server so a reload doesn't re-fire the "while you were away" path.
  // Skip the call if the job is already marked (e.g. the upstream status
  // payload didn't include notified_user_at so we kept the previous value).
  if (firedCompletion && next.notified_user_at === null) {
    const now = Math.floor(Date.now() / 1000);
    jobs.set(jobId, { ...next, notified_user_at: now });
    void api.pipelineNotified(jobId).catch(() => { /* best effort */ });
  }
  notify();
}

async function pollOne(jobId: string) {
  // Another user's job — the per-job status endpoint 403s on it. Foreign jobs
  // are kept current by loadFromServer (the shared-queue list) instead.
  const existing = jobs.get(jobId);
  if (existing && isForeign(existing)) return;
  try {
    const status = await api.pipelineStatus(jobId);
    const prev = jobs.get(jobId);
    if (!prev) return;
    mergeAndNotify(jobId, rowFromStatus(prev, status));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      jobs.delete(jobId);
      notify();
      return;
    }
    // transient network / 5xx — leave the job as-is; next tick will retry.
  }
}

async function pollTick() {
  if (typeof document !== "undefined" && document.hidden) return;
  const active = Array.from(jobs.values()).filter((j) => POLLING_STATES.has(j.state));
  if (active.length === 0) return;
  await Promise.all(active.map((j) => pollOne(j.job_id)));
}

function ensurePolling() {
  if (pollTimer) return;
  if (typeof window === "undefined") return;
  // Reconcile the whole shared queue each tick (not just own polling jobs) so
  // other users' active/queued runs stay fresh and drop off once they finish.
  // loadFromServer polls our own jobs for rich progress at the end.
  pollTimer = setInterval(() => void loadFromServer(), POLL_INTERVAL_MS);
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void loadFromServer();
    });
  }
}

// 24h cutoff for "completed while you were away" toasts. A job that
// finished last week and was never notified is too stale to surface as a
// fresh toast — the user has either moved on or already noticed via the
// pipeline panel. We still mark it notified so it doesn't pile up.
const STALE_NOTIFICATION_CUTOFF_SECONDS = 24 * 60 * 60;

async function loadFromServer() {
  try {
    const res = await api.pipelineList();
    queueSummary = res.queue ?? null;
    // Collect terminal jobs we haven't toasted yet *before* mutating the
    // jobs map. Anything in the response with state=done/failed and
    // notified_user_at=null is a "while you were away" completion.
    const unannounced: PipelineJob[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    for (const row of res.jobs) {
      // Skip jobs the user has explicitly dismissed from the chip. They
      // stay in D1; we just don't resurrect them into the local map.
      if (dismissed.has(row.job_id)) continue;
      const isTerminal = !NON_TERMINAL_STATES.has(row.state) || row.state === "failed";
      if (
        isTerminal &&
        row.notified_user_at === null &&
        nowSec - row.updated_at <= STALE_NOTIFICATION_CUTOFF_SECONDS
      ) {
        unannounced.push(row);
      }
      jobs.set(row.job_id, row);
    }
    // Prune foreign jobs that fell out of the shared queue — another user's run
    // that finished (or was cancelled) is terminal and owner-scoped, so it no
    // longer comes back in the list and should vanish from our view. Own jobs
    // are never pruned here: they persist for the completion toast / dismiss.
    const seen = new Set(res.jobs.map((r) => r.job_id));
    for (const [id, j] of jobs) {
      if (isForeign(j) && !seen.has(id)) jobs.delete(id);
    }
    notify();

    // Emit "while you were away" toasts. prev=null so the listener can
    // distinguish these from live transitions if it cares (it currently
    // doesn't — same toast either way).
    for (const job of unannounced) {
      emitCompletion(job, null);
      // Mark notified server-side fire-and-forget. If the request fails
      // (offline / network), we'll re-toast next reload — acceptable
      // because the toast is idempotent from the user's perspective.
      void api.pipelineNotified(job.job_id).catch(() => { /* see comment */ });
      // Optimistically update local memory so a same-session re-list doesn't
      // double-fire.
      const updated = jobs.get(job.job_id);
      if (updated) jobs.set(job.job_id, { ...updated, notified_user_at: nowSec });
    }
    // Also silently mark any stale unannounced job notified so it doesn't
    // keep matching the "unnotified" filter on every reload forever.
    for (const row of res.jobs) {
      const isTerminal = !NON_TERMINAL_STATES.has(row.state) || row.state === "failed";
      if (
        isTerminal &&
        row.notified_user_at === null &&
        nowSec - row.updated_at > STALE_NOTIFICATION_CUTOFF_SECONDS
      ) {
        void api.pipelineNotified(row.job_id).catch(() => { /* best effort */ });
      }
    }

    // After reconciling, immediately refresh each polling job from upstream
    // so the user sees the latest state without waiting for the 2-min tick.
    await pollTick();
  } catch {
    // 401 (no auth yet) or network — try again next time someone subscribes.
    initStarted = false;
  }
}

export const pipelineStore = {
  subscribe(fn: JobsListener): () => void {
    subscribers.add(fn);
    fn(snapshot());
    if (!initStarted) {
      initStarted = true;
      void loadFromServer().then(() => ensurePolling());
    } else {
      ensurePolling();
    }
    return () => {
      subscribers.delete(fn);
    };
  },

  onComplete(fn: CompletionListener): () => void {
    completionListeners.add(fn);
    return () => {
      completionListeners.delete(fn);
    };
  },

  onFocusRequest(fn: FocusListener): () => void {
    focusListeners.add(fn);
    return () => {
      focusListeners.delete(fn);
    };
  },

  requestFocus(jobId: string) {
    emitFocusRequest(jobId);
  },

  get(jobId: string): PipelineJob | undefined {
    return jobs.get(jobId);
  },

  findActive(
    pipelineType: PipelineType,
    book: string,
    chapter: number,
  ): PipelineJob | undefined {
    for (const j of jobs.values()) {
      if (
        j.pipeline_type === pipelineType &&
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        NON_TERMINAL_STATES.has(j.state) &&
        // Only our own runs gate the menu; another user's run surfaces through
        // the server's conflict dialog on start, not by disabling the menu.
        !isForeign(j)
      ) {
        return j;
      }
    }
    return undefined;
  },

  async start(req: PipelineStartRequest): Promise<PipelineStartResponse> {
    const res = await api.pipelineStart(req);
    // Seed an optimistic row so the UI renders immediately. The next poll
    // will replace it with the canonical shape. The job may have won the bot
    // slot ("running") or be waiting in line ("queued").
    const now = Math.floor(Date.now() / 1000);
    const seeded: PipelineJob = {
      job_id: res.jobId,
      upstream_job_id: null,
      user_id: currentPipelineUserId() ?? 0,
      pipeline_type: req.pipelineType,
      book: res.scope.book,
      start_chapter: res.scope.startChapter,
      end_chapter: res.scope.endChapter,
      session_key: req.sessionKey,
      state: res.status === "queued" ? "queued" : "running",
      priority: 0,
      queue_position: res.queuePosition ?? null,
      queue_ahead: null,
      current_skill: null,
      current_status: null,
      error_kind: null,
      error_message: null,
      output_json: null,
      follow_up_job_id: null,
      created_at: now,
      updated_at: now,
      last_polled_at: null,
      notified_user_at: null,
      started_by_username: null,
    };
    jobs.set(res.jobId, jobs.get(res.jobId) ?? seeded);
    notify();
    ensurePolling();
    // Eagerly fetch the canonical status so the UI doesn't sit on the
    // seed shape for 2 minutes.
    void pollOne(res.jobId);
    if (res.status === "already_running") {
      // Same sessionKey hit the same scope a second time — the user is
      // looking for the existing run, not starting a new one. Surface the
      // status panel instead of a toast.
      emitFocusRequest(res.jobId);
    }
    return res;
  },

  // Withdraw a queued job. Optimistically drop it from the chip; if the server
  // says it already reached the front (409 cannot_cancel), re-poll so the row
  // reflects its real running state instead of vanishing.
  async cancel(jobId: string): Promise<{ ok: boolean; state?: PipelineState }> {
    try {
      await api.pipelineCancel(jobId);
      jobs.delete(jobId);
      notify();
      return { ok: true, state: "cancelled" };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { state?: PipelineState } | undefined;
        await pollOne(jobId);
        return { ok: false, state: body?.state };
      }
      throw e;
    }
  },

  getQueueSummary(): PipelineQueueSummary | null {
    return queueSummary;
  },

  async refresh(jobId: string) {
    await pollOne(jobId);
  },

  // Reconcile the whole shared queue from the server (own jobs + everyone's
  // active/queued runs). Used by the panel's manual Refresh, which must also
  // pick up other users' jobs — those can't be polled per-id.
  async reload() {
    await loadFromServer();
  },

  // Mark a single terminal job as seen — drop it from the chip and remember
  // the id so loadFromServer doesn't resurrect it. Used by the per-row dismiss
  // on failed/cancelled jobs (the "mark as seen" the chip otherwise lacks).
  // The row stays in D1 until the nightly cleanup cron purges it.
  dismiss(jobId: string) {
    if (!jobs.has(jobId)) return;
    jobs.delete(jobId);
    dismissed.add(jobId);
    persistDismissed();
    notify();
  },

  // Hide every currently-resolved job (done / failed / cancelled) from the
  // chip in one go. Dismissed IDs persist in localStorage so a tab reload
  // doesn't bring them back. Active / queued jobs are left alone — those still
  // need user attention.
  dismissResolved() {
    let changed = false;
    for (const [id, j] of jobs) {
      if (j.state === "done" || j.state === "failed" || j.state === "cancelled") {
        jobs.delete(id);
        dismissed.add(id);
        changed = true;
      }
    }
    if (changed) {
      persistDismissed();
      notify();
    }
  },
};
