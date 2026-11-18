// Single-applier claim policy for AI-pipeline imports.
//
// Two pollers race to import a job the instant the bot flips it to 'done': the
// */5 cron (pollAllNonTerminal) and a translator's open tab hitting
// GET /api/pipelines/:jobId. Both gate the import on no_output_yet, read from a
// SELECT that predates the ~minute-long apply, and output_json (which clears
// that flag) is written only after the poll completes — so both can enter
// importJobOutput. With the old English notes apply (retired in #726), each
// apply's chapter-scoped delete sweep then removed the OTHER apply's freshly
// inserted AI rows, so their delete/insert phases interleaved and corrupted the
// chapter (ISA 48 en_tn, 2026-06-30: vv.1–12 wiped, 13–22 doubled). Two
// concurrent translate applies would race the same rows too. importJobOutput claims the job by atomically stamping
// pipeline_jobs.import_claimed_at; the poller that loses the CAS no-ops.
//
// Leaf module (no imports) so the concurrency rule is unit-testable under
// `node --experimental-strip-types` — same pattern as shrinkGuard.ts.

// A claim left dangling by a hard Worker death (no JS throw to release it)
// becomes reclaimable by a later poll once older than this. Must comfortably
// exceed the longest real apply (a single-chapter notes apply runs ~1 min) so a
// still-running apply is never reclaimed out from under itself.
export const IMPORT_CLAIM_STALE_SECONDS = 600;

// Pure mirror of the atomic claim predicate in importJobOutput's
// `UPDATE ... WHERE` clause: a poller may take the import slot when it is
// unclaimed, or when the existing claim is older than the stale window (crash
// recovery). The production path enforces this in one CAS UPDATE rather than
// read-then-write, so two racing pollers can't both pass — this function
// documents and tests the rule, it is not the enforcement point.
export function mayClaimImport(
  currentClaim: number | null,
  now: number,
  staleSeconds: number = IMPORT_CLAIM_STALE_SECONDS,
): boolean {
  return currentClaim == null || currentClaim < now - staleSeconds;
}

// What a poll that lost the import claim tells its caller (issue: LUK 18,
// 2026-11-18). The bot already says 'done', but this job's output is not in D1
// yet: another poll is mid-apply, or died mid-apply and left its claim to go
// stale. Passing the bot's 'done' through made the browser toast "AI output
// applied", acknowledge the job and stop polling, while D1 still said 'running'
// and kept the chapter locked, with nothing left to retry the apply. Report
// 'running' instead, so the caller keeps polling until a poll finalizes.
export function claimLostStatus<T extends { state?: string; output?: unknown; current?: object }>(
  upstream: T,
): T & { state: "running" } {
  const { output: _output, ...rest } = upstream;
  return {
    ...(rest as T),
    state: "running",
    current: { ...(upstream.current ?? {}), status: "applying AI output" },
  };
}
