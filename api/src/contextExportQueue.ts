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
// - The lease runs out after CONTEXT_EXPORT_LEASE_SECONDS, so a run that died
//   without releasing (isolate evicted, instance terminated) is taken over by
//   the next save or export. Before committing, the holder renews the lease
//   and gives up if it lost it, so a run that was taken over never commits
//   over the run that took over.
//
// Dry runs (no service token, dryDcs) write nothing to Door43 and skip all this.

// Longer than one export's worst case (three CAS attempts, each a few Door43
// round trips), short enough that a dead run holds the queue for minutes.
export const CONTEXT_EXPORT_LEASE_SECONDS = 600;

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
      `INSERT INTO context_export_lock (workspace, pending, shrink_override, requested_at)
       VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(workspace) DO UPDATE SET
         pending = 1,
         shrink_override = MAX(shrink_override, excluded.shrink_override),
         requested_at = excluded.requested_at
       RETURNING holder, lease_until`,
    )
    .bind(key, opts.shrinkOverride ? 1 : 0, now)
    .first<{ holder: string | null; lease_until: number | null }>();
  return !row?.holder || (row.lease_until ?? 0) <= now;
}

// Take the lease for `holder`: when it is free and a save is pending, when the
// previous holder's lease ran out, or again for the same holder (a Workflow
// step retry). Clears `pending` — this run's D1 read will include those saves.
// Returns the shrink override waiting for this run, or null when another run
// holds the lease.
export async function acquireContextExportLease(
  db: Db,
  key: string,
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
         holder_shrink_override = CASE WHEN holder = ?2
           THEN MAX(holder_shrink_override, shrink_override) ELSE shrink_override END,
         shrink_override = 0
       WHERE workspace = ?1
         AND (holder = ?2
              OR (holder IS NULL AND pending = 1)
              OR (holder IS NOT NULL AND lease_until <= ?3))
       RETURNING holder_shrink_override`,
    )
    .bind(key, holder, now, CONTEXT_EXPORT_LEASE_SECONDS)
    .first<{ holder_shrink_override: number }>();
  return row ? { shrinkOverride: row.holder_shrink_override === 1 } : null;
}

// Renew the lease right before the Door43 commit. False = another run took it
// over (this one ran past its lease), so this run must not commit.
export async function renewContextExportLease(db: Db, key: string, holder: string, now = nowSeconds()): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE context_export_lock SET lease_until = ?3 + ?4 WHERE workspace = ?1 AND holder = ?2`)
    .bind(key, holder, now, CONTEXT_EXPORT_LEASE_SECONDS)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

// Give the lease back. Returns true when a save arrived during the run, i.e.
// the caller must start the follow-up. `failed`: the run threw, so it
// published nothing — leave its saves pending (and its override waiting) for
// the Workflow step's retry or the next run.
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
             shrink_override = MAX(shrink_override, holder_shrink_override), holder_shrink_override = 0
           WHERE workspace = ?1 AND holder = ?2 RETURNING pending`
        : `UPDATE context_export_lock SET holder = NULL, lease_until = NULL, holder_shrink_override = 0
           WHERE workspace = ?1 AND holder = ?2 RETURNING pending`,
    )
    .bind(key, holder)
    .first<{ pending: number }>();
  return !opts.failed && row?.pending === 1;
}

// Run one context export under the lease. Returns null when another run holds
// it (nothing exported; the holder's follow-up carries this request). `holder`
// must be stable across the Workflow step's retries and unique per instance —
// the Workflow instance id. `markPending`: true for runs that are their own
// request (manual, nightly); false for runs a save or a follow-up started,
// whose request is already recorded.
export async function runContextExportExclusive<T>(o: {
  db: Db;
  key: string;
  holder: string;
  markPending: boolean;
  shrinkOverride: boolean;
  run: (ctx: { shrinkOverride: boolean; holdsLease: () => Promise<boolean> }) => Promise<T>;
  startFollowUp: () => Promise<unknown>;
}): Promise<T | null> {
  if (o.markPending) await markContextExportPending(o.db, o.key, { shrinkOverride: o.shrinkOverride });
  const lease = await acquireContextExportLease(o.db, o.key, o.holder);
  if (!lease) return null;
  let result: T;
  try {
    result = await o.run({
      shrinkOverride: o.shrinkOverride || lease.shrinkOverride,
      holdsLease: () => renewContextExportLease(o.db, o.key, o.holder),
    });
  } catch (e) {
    await releaseContextExportLease(o.db, o.key, o.holder, { failed: true }).catch((err: unknown) => {
      console.error("context export lease release failed", o.holder, err instanceof Error ? err.message : String(err));
    });
    throw e;
  }
  if (await releaseContextExportLease(o.db, o.key, o.holder)) {
    // A failed create leaves `pending` set with the lease free, so the next
    // save (or manual / nightly export) starts the run.
    try {
      await o.startFollowUp();
    } catch (e) {
      console.log("context export follow-up not started", o.holder, e instanceof Error ? e.message : String(e));
    }
  }
  return result;
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
// starts a run only when none is in flight (see above). The catch swallows
// everything (D1 or binding failures) — a sync hiccup must never fail the
// save; the nightly export is the backstop.
export type QueueContext = { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } };
export function queueContextExport(c: QueueContext): void {
  const key = c.env.WORKSPACE_SLUG ?? "default";
  const p = (async () => {
    if (await markContextExportPending(c.env.DB, key)) await startQueuedContextExport(c.env);
  })().catch((e: unknown) => {
    console.log("context export queue skipped", key, e instanceof Error ? e.message : String(e));
  });
  try {
    c.executionCtx.waitUntil(p);
  } catch (e) {
    console.log("context export queue unavailable", key, e instanceof Error ? e.message : String(e));
  }
}
