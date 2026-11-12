// Undo for a deleted term (issue #801): turns the answer from
// POST /api/translation-memory/terms/:id/restore into what the Style page
// shows. Pure and type-only-importing, so node's strip-types test runner can
// load it directly (termRestore.test.mjs).
//
// The route's answers (api/src/translationMemory.ts, "POST /terms/:id/restore"):
//   200                     the term, back with the same id and a new version
//   409 duplicate_term      a live term with the same identity exists (current)
//   409 not_deleted         the term is already live: nothing to do
//   409 version_mismatch    someone restored, changed and deleted it again
//   404 not_found           the term is gone
//
// "retryable" (#809) is a 5xx, or a network error (the caller maps a non-HTTP
// failure to it): the term is still deleted and the same id and version can
// be sent again, so the page brings the Undo offer back. Any other 4xx is
// "failed": a resend would get the same answer.
export type RestoreOutcome =
  | { kind: "restored" }
  | { kind: "duplicate"; source: string; target: string }
  | { kind: "not_deleted" }
  | { kind: "version_mismatch" }
  | { kind: "not_found" }
  | { kind: "retryable" }
  | { kind: "failed" };

/** Classify a failed restore from its HTTP status and parsed JSON body. */
export function restoreFailure(status: number, body: unknown): RestoreOutcome {
  if (status >= 500) return { kind: "retryable" };
  if (status === 404) return { kind: "not_found" };
  if (status !== 409) return { kind: "failed" };
  const b = (body ?? {}) as { error?: unknown; current?: unknown };
  if (b.error === "not_deleted") return { kind: "not_deleted" };
  if (b.error === "version_mismatch") return { kind: "version_mismatch" };
  if (b.error === "duplicate_term") {
    const cur = (b.current ?? {}) as { source_term?: unknown; target_term?: unknown };
    return {
      kind: "duplicate",
      source: typeof cur.source_term === "string" ? cur.source_term : "",
      target: typeof cur.target_term === "string" ? cur.target_term : "",
    };
  }
  return { kind: "failed" };
}

/**
 * The message key (and interpolation values) to show for an outcome, and
 * whether the list should be refetched. Only "restored" and "not_deleted"
 * refresh: in every other case nothing changed on the server.
 */
export function restoreMessage(o: RestoreOutcome): {
  key: string;
  values?: Record<string, string>;
  refresh: boolean;
} {
  switch (o.kind) {
    case "restored":
      return { key: "preferences.termRestored", refresh: true };
    case "not_deleted":
      return { key: "preferences.termRestoreNotDeleted", refresh: true };
    case "duplicate":
      return { key: "preferences.termRestoreDuplicate", values: { source: o.source, target: o.target }, refresh: false };
    case "version_mismatch":
      return { key: "preferences.termRestoreChanged", refresh: false };
    case "not_found":
      return { key: "preferences.termRestoreNotFound", refresh: false };
    case "retryable":
      return { key: "preferences.termRestoreRetry", refresh: false };
    case "failed":
      return { key: "preferences.actionFailed", refresh: false };
  }
}
