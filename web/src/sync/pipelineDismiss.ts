// Whether a reload should leave a job out of the pipeline store because the
// user dismissed it from the AI chip. Leaf module (no imports) so it runs
// under `node --experimental-strip-types`.
//
// "Dismiss all" only hides resolved jobs, but a job can look resolved in the
// browser while the server still has it running: the poll that lost the import
// claim used to pass the bot's 'done' through (LUK 18, 2026-11-18). Once
// dismissed, that job was skipped on every reload, so this browser never polled
// it again, and only that poll could finish the apply and release the chapter
// lock. A dismissal therefore only hides a job the server also says is over.
const ACTIVE_ON_SERVER: ReadonlySet<string> = new Set([
  "queued",
  "dispatching",
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
]);

export function hideDismissedRow(state: string, dismissed: boolean): boolean {
  return dismissed && !ACTIVE_ON_SERVER.has(state);
}
