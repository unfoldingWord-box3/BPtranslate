// Workflow instance ids and the save-triggered context export queue. A leaf
// module (type-only imports) so routes and the node test runner can load it
// without pulling in the export routes.

import type { Env } from "./index";

// Deterministic second-precision Workflow instance id. Shared by every spawn
// site (manual `manual-`/`context-` in exports.ts, save-triggered
// `context-save-` below) so the no-collision-across-prefixes guarantee rests
// on ONE timestamp format, not parallel copies. The manual routes rely on the
// same-second dedup (a double-submit gets a 409); save-triggered ids add a
// random suffix and so never dedupe (#716).
export function workflowRunId(prefix: string): string {
  return `${prefix}${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}`;
}

// Fire-and-forget context-pack sync: every successful prefs/terminology write
// or template approval queues a context-only export so the
// {org}/translation-context repo tracks D1 without the translator ever
// thinking about git. Every save starts its own
// workflow: the second-precision id (distinct `context-save-` prefix so it
// can't collide with the manual route's `context-` ids) gets a short random
// suffix. Before #716 the id had no suffix, so a second save in the same
// second was rejected as a duplicate id and swallowed; if the first run had
// already read D1, that save waited for the next export. Runs that overlap
// are safe: each re-reads D1 before committing and retries a CAS conflict
// (#713, #718), and context_export_results keys rows by its own id. The cost
// is one run per save in a burst rather than one per second. The try/catch
// swallows everything (a missing binding, queue failures) — a sync hiccup
// must never fail the save; the nightly export is the backstop.
export type QueueContext = { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } };
export function queueContextExport(c: QueueContext): void {
  // Workspace slug in the prefix keeps ids per org; the random suffix keeps
  // two saves in one second from sharing an id (#716). Slug <= 32 chars, so
  // the id stays well under Workflows' 100-char limit.
  const id = `${workflowRunId(`context-save-${c.env.WORKSPACE_SLUG ?? "default"}-`)}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const p = c.env.EXPORT_WORKFLOW.create({ id, params: { contextOnly: true, workspace: c.env.WORKSPACE_SLUG } }).catch((e: unknown) => {
      console.log("context export queue skipped", id, e instanceof Error ? e.message : String(e));
    });
    c.executionCtx.waitUntil(p);
  } catch (e) {
    console.log("context export queue unavailable", id, e instanceof Error ? e.message : String(e));
  }
}
