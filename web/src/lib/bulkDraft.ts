// Stop rules for the bulk "Draft all with AI" run over note templates. Kept
// in lib/ (dependency-free) rather than inside useTemplateBulkDraft.ts so it
// is testable: the hook imports ../sync/api, whose TypeScript
// parameter-property constructor Node's strip-only type mode rejects, so
// anything importing the hook can't be unit tested.
//
// Fail-fast is the load-bearing behaviour. The upstream bot endpoint can be
// down for a whole run (it currently 404s — see docs/template-quick-contract.md),
// and without a cap a "draft all" over ~200 units would fire that many doomed
// requests at it.

export const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface BulkDraftState {
  done: number;
  failed: number;
  consecutiveFailures: number;
}

export type BulkDraftOutcomeKind = "success" | "failure" | "disabled";

export interface BulkDraftReduceResult {
  state: BulkDraftState;
  /** Non-null means the caller must stop launching further work. */
  stopReason: "aborted_failures" | "disabled" | null;
}

/** Folds one unit's outcome into the running state and decides whether the
 *  whole run must stop. Two stop rules: N consecutive failures, or a single
 *  "disabled" outcome (AI isn't configured, so retrying anything is pointless). */
export function reduceBulkDraftOutcome(input: {
  state: BulkDraftState;
  kind: BulkDraftOutcomeKind;
}): BulkDraftReduceResult {
  const { state, kind } = input;
  if (kind === "success") {
    return {
      state: { done: state.done + 1, failed: state.failed, consecutiveFailures: 0 },
      stopReason: null,
    };
  }
  const failed = state.failed + 1;
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (kind === "disabled") {
    return { state: { done: state.done + 1, failed, consecutiveFailures }, stopReason: "disabled" };
  }
  return {
    state: { done: state.done + 1, failed, consecutiveFailures },
    stopReason: consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT ? "aborted_failures" : null,
  };
}

/** Whether the open template editor must remount after a "Draft all" run
 *  (#843). The editor fetched its unit once, on mount, so a run that rewrote
 *  that unit leaves it showing old text at an old version. Pass the unit open
 *  NOW (when the run ends, not when it started: the user can switch units
 *  mid-run) and the ids the run was given. The run's drafted count is ignored
 *  on purpose: a cancelled or fail-fast run aborts requests the server may
 *  still have completed, and a needless remount only costs a refetch. Callers
 *  leave units with unsaved typing out of the run, and the remounted editor
 *  restores any typing from the drafts store either way. */
export function openEditorNeedsReload(openId: string | null, targetedIds: ReadonlySet<string>): boolean {
  return openId != null && targetedIds.has(openId);
}
