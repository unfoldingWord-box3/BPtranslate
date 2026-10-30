// Workflow instance ids and the save-triggered context export queue. A leaf
// module (type-only imports) so routes and the node test runner can load it
// without pulling in the export routes.

import type { Env } from "./index";

// Deterministic second-precision Workflow instance id. Shared by every spawn
// site (manual `manual-`/`context-` in exports.ts, save-triggered
// `context-save-` below) so the no-collision-across-prefixes and same-second
// dedup guarantees rest on ONE timestamp format, not parallel copies.
export function workflowRunId(prefix: string): string {
  return `${prefix}${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;
}

// Fire-and-forget context-pack sync: every successful prefs/terminology write
// or template approval queues a context-only export so the
// {org}/translation-context repo tracks D1 without the translator ever
// thinking about git. Deterministic second-
// precision id dedupes same-second bursts (distinct `context-save-` prefix so
// it can't collide with the manual route's `context-` ids). Known limitation:
// two DISTINCT writes in the same second dedupe to one workflow, and if that
// instance reads D1 before the second write commits, the second change waits
// for the next edit / manual export / nightly backstop — accepted, since every
// later write re-queues. The try/catch swallows everything (duplicate-id
// rejections, a missing binding, queue failures) — a sync hiccup must never
// fail the save; the nightly export is the backstop.
export type QueueContext = { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } };
export function queueContextExport(c: QueueContext): void {
  // Workspace slug in the id prefix keeps two orgs' same-second saves from
  // colliding on the deterministic id (see workflowRunId's dedup contract).
  const id = workflowRunId(`context-save-${c.env.WORKSPACE_SLUG ?? "default"}-`);
  try {
    const p = c.env.EXPORT_WORKFLOW.create({ id, params: { contextOnly: true, workspace: c.env.WORKSPACE_SLUG } }).catch((e: unknown) => {
      console.log("context export queue skipped", id, e instanceof Error ? e.message : String(e));
    });
    c.executionCtx.waitUntil(p);
  } catch (e) {
    console.log("context export queue unavailable", id, e instanceof Error ? e.message : String(e));
  }
}
