// The translate apply's skip report (#601, option B). A note a person edited,
// approved, marked Not needed or restored after the job was queued keeps their
// work, and the job's apply_skipped_json (GET /api/pipelines, and
// `applySkipped` on the status poll) lists those note ids.
// Kept free of imports so it can be unit-tested from a plain Node script.

/** The note ids the job's apply left alone. Empty when none, or unreadable. */
export function skippedTnRowIds(job: { apply_skipped_json?: string | null }): string[] {
  if (!job.apply_skipped_json) return [];
  try {
    const parsed = JSON.parse(job.apply_skipped_json) as { tnTouchedIds?: unknown };
    return Array.isArray(parsed.tnTouchedIds) ? parsed.tnTouchedIds.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * How a single-note Redo ended: "drafted" (the AI draft landed), "kept" (the
 * job finished but left this note alone because someone changed it after the
 * job was queued), or "failed" (the job did not finish).
 */
export function redoOutcome(
  job: { state: string; apply_skipped_json?: string | null },
  rowId: string,
): "drafted" | "kept" | "failed" {
  if (job.state !== "done") return "failed";
  return skippedTnRowIds(job).includes(rowId) ? "kept" : "drafted";
}
