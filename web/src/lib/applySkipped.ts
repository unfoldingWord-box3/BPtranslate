// The translate apply's skip report (#601, option B). A note a person edited,
// approved, marked Not needed or restored after the job was queued keeps their
// work, and the job's apply_skipped_json (GET /api/pipelines, and
// `applySkipped` on the status poll) lists those note ids. It also lists the
// notes whose AI draft was the English source note copied back, which were not
// applied (#794).
// Kept free of imports so it can be unit-tested from a plain Node script.

function idsAt(job: { apply_skipped_json?: string | null }, key: string): string[] {
  if (!job.apply_skipped_json) return [];
  try {
    const parsed = JSON.parse(job.apply_skipped_json) as Record<string, unknown>;
    const ids = parsed[key];
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The note ids the job's apply left alone. Empty when none, or unreadable. */
export function skippedTnRowIds(job: { apply_skipped_json?: string | null }): string[] {
  return idsAt(job, "tnTouchedIds");
}

/**
 * How a single-note Redo ended: "drafted" (the AI draft landed), "kept" (the
 * job finished but left this note alone because someone changed it after the
 * job was queued), "english" (the AI returned the English note unchanged, so
 * the draft was not applied, #794), or "failed" (the job did not finish).
 */
export function redoOutcome(
  job: { state: string; apply_skipped_json?: string | null },
  rowId: string,
): "drafted" | "kept" | "english" | "failed" {
  if (job.state !== "done") return "failed";
  if (skippedTnRowIds(job).includes(rowId)) return "kept";
  return idsAt(job, "tnSameAsEnglishIds").includes(rowId) ? "english" : "drafted";
}
