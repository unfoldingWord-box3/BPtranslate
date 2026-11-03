// Workflow instance ids and the context export queue. A leaf module
// (type-only imports) so routes and the node test runner can load it without
// pulling in the export routes or the Workflow runtime.

import type { Env } from "./index";

// Deterministic second-precision Workflow instance id. Shared by every spawn
// site (manual `manual-`/`context-` in exports.ts, queued `context-save-`
// below) so the no-collision-across-prefixes guarantee rests on ONE timestamp
// format, not parallel copies. The manual routes rely on the same-second dedup
// (a double-submit gets a 409); queued runs add a random suffix (see
// startQueuedContextExport).
export function workflowRunId(prefix: string): string {
  return `${prefix}${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;
}

// ── One context export at a time per workspace (#716, #722) ─────────────────
//
// Door43's file-change request has no base-commit check, so two context
// exports running at once could fail for good or leave an older pack on top of
// a newer one (#722). The context_export_lock row (migration 0078) serializes
// every context export of a workspace — save-triggered, manual and nightly:
//
// - A save sets `pending` and starts a run only when no run holds the lease.
// - A run takes the lease and clears `pending` BEFORE it reads D1, so it
//   carries every save made up to its start. A save during the run sets
//   `pending` again, and the run starts exactly one follow-up when it ends;
//   further saves coalesce into that follow-up, which renders when it starts.
// - Any other run that starts while the lease is held does not export: it
//   leaves `pending` set and the holder's follow-up covers it.
// - A run that fails for a reason that may pass (Door43 or network trouble,
//   CAS retries used up, en source fetch) gives the lease back with `pending`
//   still set and throws, so the Workflow step retries it; when the retries
//   run out, the next save, export or */5 cron sweep starts a run.
// - The lease runs out after CONTEXT_EXPORT_LEASE_SECONDS, so a run that died
//   without releasing (isolate evicted, instance terminated) is taken over by
//   the next save, export or cron sweep. Before committing, the holder renews
//   the lease and gives up if it lost it, so a run that was taken over never
//   commits over the run that took over.
// - The lease holder is one ATTEMPT of a Workflow step (instance id + a random
//   nonce), not the instance: Cloudflare's docs say a step's timeout is per
//   attempt but not whether a timed-out attempt is stopped before the retry
//   starts. A retry takes the lease over from its own instance's earlier
//   attempt, which then fails its pre-commit check.
//
// What the lease does NOT cover: the renewal happens right before the commit
// request, not during it. commitContextPackToMaster's own round trips (tip
// read, tree read, ChangeFiles POST, parent and tip checks) run unguarded, so
// a commit that stalls longer than CONTEXT_EXPORT_LEASE_SECONDS after the
// renewal could still overlap a run that took over. Those calls normally take
// seconds.
//
// Dry runs (no service token, dryDcs) write nothing to Door43 and skip all this.

// Longer than one export's worst case (three CAS attempts, each a few Door43
// round trips), short enough that a dead run holds the queue for minutes.
export const CONTEXT_EXPORT_LEASE_SECONDS = 600;
// An admin's shrink-guard override that had to wait is honoured only by a run
// that starts within this long of the click; after that it is dropped.
export const SHRINK_OVERRIDE_MAX_AGE_SECONDS = 3600;

type Db = Env["DB"];
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Record that a context-pack input changed. Returns true when no run holds a
// live lease, i.e. the caller must start one; false when the running export
// will pick the change up in its follow-up.
export async function markContextExportPending(
  db: Db,
  key: string,
  opts: { shrinkOverride?: boolean } = {},
  now = nowSeconds(),
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO context_export_lock (workspace, pending, shrink_override_at, requested_at)
       VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(workspace) DO UPDATE SET
         pending = 1,
         shrink_override_at = COALESCE(excluded.shrink_override_at, shrink_override_at),
         requested_at = excluded.requested_at
       RETURNING holder, lease_until`,
    )
    .bind(key, opts.shrinkOverride ? now : null, now)
    .first<{ holder: string | null; lease_until: number | null }>();
  return !row?.holder || (row.lease_until ?? 0) <= now;
}

// True when saves are waiting and no live run will pick them up: the */5 cron
// sweep then starts a run (index.ts).
export async function contextExportNeedsRun(db: Db, key: string, now = nowSeconds()): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS due FROM context_export_lock
        WHERE workspace = ?1 AND pending = 1 AND (holder IS NULL OR lease_until <= ?2)`,
    )
    .bind(key, now)
    .first<{ due: number }>();
  return !!row;
}

// The */5 cron's sweep for one workspace (index.ts). Without a service token
// every run is a dry run that never takes the lease or clears `pending`, so
// there is nothing to sweep (and a run per tick would never stop).
export async function sweepContextExportQueue(
  env: Pick<Env, "DB" | "EXPORT_WORKFLOW" | "WORKSPACE_SLUG" | "DCS_SERVICE_TOKEN">,
): Promise<void> {
  if (!env.DCS_SERVICE_TOKEN) return;
  if (await contextExportNeedsRun(env.DB, env.WORKSPACE_SLUG ?? "default")) await startQueuedContextExport(env);
}

// Daily context export (#793). Validated tN/tQ rows queue no export, so on a
// deployment without the nightly full export (the live dev worker has none)
// the pack's examples only refreshed when someone saved prefs, terms or a
// template — BSOJ's sat at 114 examples for two months while ~3,000 notes were
// validated. Marking the workspace pending and starting a run when none holds
// the lease is exactly what a save does, so a run already in flight picks this
// up in its follow-up. Skipped without a service token (a dry run then).
export async function requestDailyContextExport(
  env: Pick<Env, "DB" | "EXPORT_WORKFLOW" | "WORKSPACE_SLUG" | "DCS_SERVICE_TOKEN">,
): Promise<void> {
  if (!env.DCS_SERVICE_TOKEN) return;
  if (await markContextExportPending(env.DB, env.WORKSPACE_SLUG ?? "default")) await startQueuedContextExport(env);
}

// Holders are `<Workflow instance id>#<nonce>`, one per step attempt.
const SAME_INSTANCE = `substr(holder, 1, length(?5) + 1) = ?5 || '#'`;

// Take the lease for `holder` (an attempt of `instance`): when it is free and
// a save is pending, when the previous holder's lease ran out, or from an
// earlier attempt of the same instance (a Workflow step retry). Clears
// `pending` — this run's D1 read will include those saves. Returns whether a
// fresh shrink override waits for this run, or null when another run holds
// the lease.
export async function acquireContextExportLease(
  db: Db,
  key: string,
  instance: string,
  holder: string,
  now = nowSeconds(),
): Promise<{ shrinkOverride: boolean } | null> {
  const row = await db
    .prepare(
      `UPDATE context_export_lock SET
         holder = ?2,
         lease_until = ?3 + ?4,
         started_at = ?3,
         pending = 0,
         holder_shrink_override_at = CASE WHEN ${SAME_INSTANCE}
           THEN NULLIF(MAX(COALESCE(holder_shrink_override_at, 0), COALESCE(shrink_override_at, 0)), 0)
           ELSE shrink_override_at END,
         shrink_override_at = NULL
       WHERE workspace = ?1
         AND (${SAME_INSTANCE}
              OR (holder IS NULL AND pending = 1)
              OR (holder IS NOT NULL AND lease_until <= ?3))
       RETURNING holder_shrink_override_at`,
    )
    .bind(key, holder, now, CONTEXT_EXPORT_LEASE_SECONDS, instance)
    .first<{ holder_shrink_override_at: number | null }>();
  if (!row) return null;
  const at = row.holder_shrink_override_at;
  return { shrinkOverride: at != null && at > now - SHRINK_OVERRIDE_MAX_AGE_SECONDS };
}

// Renew the lease right before the Door43 commit. False = another run (or a
// retry of this step) took it over, so this attempt must not commit.
export async function renewContextExportLease(db: Db, key: string, holder: string, now = nowSeconds()): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE context_export_lock SET lease_until = ?3 + ?4 WHERE workspace = ?1 AND holder = ?2`)
    .bind(key, holder, now, CONTEXT_EXPORT_LEASE_SECONDS)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

// Give the lease back. Returns true when a save arrived during the run, i.e.
// the caller must start the follow-up. `failed`: the run published nothing —
// leave its saves pending (and its override waiting) for the Workflow step's
// retry or the next run.
export async function releaseContextExportLease(
  db: Db,
  key: string,
  holder: string,
  opts: { failed?: boolean } = {},
): Promise<boolean> {
  const row = await db
    .prepare(
      opts.failed
        ? `UPDATE context_export_lock SET holder = NULL, lease_until = NULL, pending = 1,
             shrink_override_at = NULLIF(MAX(COALESCE(shrink_override_at, 0), COALESCE(holder_shrink_override_at, 0)), 0),
             holder_shrink_override_at = NULL
           WHERE workspace = ?1 AND holder = ?2 RETURNING pending`
        : `UPDATE context_export_lock SET holder = NULL, lease_until = NULL, holder_shrink_override_at = NULL
           WHERE workspace = ?1 AND holder = ?2 RETURNING pending`,
    )
    .bind(key, holder)
    .first<{ pending: number }>();
  return !opts.failed && row?.pending === 1;
}

// Failures that the same inputs will hit again, so retrying cannot help: they
// clear `pending` like a success. Every other `failed` result (Door43 5xx,
// network errors, a 422, CAS or "cannot lock ref" retries used up, en source
// fetch or truncation) is treated as passing and retried.
const DETERMINISTIC_FAILURES = [
  "not_a_gl_project",
  "context_export_lease_lost",
  "context_repo_not_provisioned",
  "context_repo_uninitialized",
  "no_translation_source",
  "missing_en_source:",
  "empty_en_source:",
  "empty_target:",
];
export function contextExportFailureIsTransient(r: { status: string; failureReason: string | null }): boolean {
  if (r.status !== "failed") return false;
  const reason = r.failureReason ?? "";
  if (DETERMINISTIC_FAILURES.some((d) => (d.endsWith(":") ? reason.startsWith(d) : reason === d))) return false;
  // A Door43 auth / not-found refusal (e.g. "dcs_batch_commit_failed: POST 403")
  // needs a person, not a retry.
  if (/^dcs_[a-z_]+_failed: (?:[A-Z]+ )?(?:401|403|404)\b/.test(reason)) return false;
  return true;
}

// Run one context export under the lease. Returns null when another run holds
// it (nothing exported; the holder's follow-up carries this request). Throws
// on a passing failure after giving the lease back with the request still
// pending, so the Workflow step retries. `instance` is the Workflow instance
// id. `markPending`: true for runs that are their own request (manual,
// nightly); false for runs a save, follow-up or sweep started, whose request
// is already recorded.
export async function runContextExportExclusive<T extends { status: string; failureReason: string | null }>(o: {
  db: Db;
  key: string;
  instance: string;
  markPending: boolean;
  shrinkOverride: boolean;
  run: (ctx: { shrinkOverride: boolean; holdsLease: () => Promise<boolean> }) => Promise<T>;
  startFollowUp: () => Promise<unknown>;
}): Promise<T | null> {
  const holder = `${o.instance}#${crypto.randomUUID().slice(0, 8)}`;
  if (o.markPending) await markContextExportPending(o.db, o.key, { shrinkOverride: o.shrinkOverride });
  const lease = await acquireContextExportLease(o.db, o.key, o.instance, holder);
  if (!lease) return null;
  const giveBack = () =>
    releaseContextExportLease(o.db, o.key, holder, { failed: true }).catch((err: unknown) => {
      console.error("context export lease release failed", holder, err instanceof Error ? err.message : String(err));
    });
  let result: T;
  try {
    result = await o.run({
      shrinkOverride: o.shrinkOverride || lease.shrinkOverride,
      holdsLease: () => renewContextExportLease(o.db, o.key, holder),
    });
  } catch (e) {
    await giveBack();
    throw e;
  }
  if (contextExportFailureIsTransient(result)) {
    await giveBack();
    throw new Error(`context_export_retry:${result.failureReason ?? "failed"}`);
  }
  if (await releaseContextExportLease(o.db, o.key, holder)) {
    // A failed create leaves `pending` set with the lease free, so the next
    // save, export or cron sweep starts the run.
    try {
      await o.startFollowUp();
    } catch (e) {
      console.log("context export follow-up not started", holder, e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}

// What a run that found the lease held reports (ContextPackStepResult shape).
export const CONTEXT_EXPORT_DEFERRED = {
  status: "deferred",
  commitSha: null,
  contentFiles: 0,
  terms: 0,
  examplesTn: 0,
  examplesTq: 0,
  failureReason: "export_in_progress",
} as const;

// The ExportWorkflow's context step (exportWorkflow.ts calls this with its
// render-and-commit method). Dry runs bypass the lease; a run that finds the
// lease held returns CONTEXT_EXPORT_DEFERRED.
export async function exportContextPackUnderLease<T extends { status: string; failureReason: string | null }>(o: {
  env: Pick<Env, "DB" | "EXPORT_WORKFLOW" | "WORKSPACE_SLUG">;
  instanceId: string;
  queued: boolean;
  dcsAllowed: boolean;
  shrinkOverride: boolean;
  render: (shrinkOverride: boolean, holdsLease: () => Promise<boolean>) => Promise<T>;
}): Promise<T | typeof CONTEXT_EXPORT_DEFERRED> {
  if (!o.dcsAllowed) return o.render(o.shrinkOverride, async () => true);
  const result = await runContextExportExclusive({
    db: o.env.DB,
    key: o.env.WORKSPACE_SLUG ?? "default",
    instance: o.instanceId,
    markPending: !o.queued,
    shrinkOverride: o.shrinkOverride,
    run: ({ shrinkOverride, holdsLease }) => o.render(shrinkOverride, holdsLease),
    startFollowUp: () => startQueuedContextExport(o.env),
  });
  if (result) return result;
  console.log("context export deferred: another run holds the lease and will follow up", { instance: o.instanceId });
  return CONTEXT_EXPORT_DEFERRED;
}

// Start a queued context-only run (a save's, or a follow-up). The random
// suffix keeps two runs started in one second from sharing an id: a repeated
// id is refused by Workflows, which used to drop the second save (#716). Slug
// <= 32 chars, so the id stays under Workflows' 100-char limit.
export async function startQueuedContextExport(env: Pick<Env, "EXPORT_WORKFLOW" | "WORKSPACE_SLUG">): Promise<void> {
  const id = `${workflowRunId(`context-save-${env.WORKSPACE_SLUG ?? "default"}-`)}-${crypto.randomUUID().slice(0, 8)}`;
  await env.EXPORT_WORKFLOW.create({ id, params: { contextOnly: true, workspace: env.WORKSPACE_SLUG, queued: true } });
}

// Fire-and-forget context-pack sync: every successful prefs/terminology write
// or template approval calls this so the {org}/translation-context repo tracks
// D1 without the translator ever thinking about git. It records the save and
// starts a run only when none is in flight (see above). Without a service
// token the run is a dry run that never takes the lease, so the save starts it
// directly and records nothing pending (that flag would never be cleared).
// The catch swallows everything (D1 or binding failures) — a sync hiccup must
// never fail the save; the nightly export is the backstop.
export type QueueContext = { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } };
export function queueContextExport(c: QueueContext): void {
  const key = c.env.WORKSPACE_SLUG ?? "default";
  const p = (async () => {
    if (!c.env.DCS_SERVICE_TOKEN || (await markContextExportPending(c.env.DB, key))) await startQueuedContextExport(c.env);
  })().catch((e: unknown) => {
    console.log("context export queue skipped", key, e instanceof Error ? e.message : String(e));
  });
  try {
    c.executionCtx.waitUntil(p);
  } catch (e) {
    console.log("context export queue unavailable", key, e instanceof Error ? e.message : String(e));
  }
}
