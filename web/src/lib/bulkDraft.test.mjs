import test from "node:test";
import assert from "node:assert/strict";

import { reduceBulkDraftOutcome, CONSECUTIVE_FAILURE_LIMIT, openEditorNeedsReload } from "./bulkDraft.ts";

const fresh = () => ({ done: 0, failed: 0, consecutiveFailures: 0 });

// Fold a sequence of outcomes, stopping at the first stopReason like the hook's
// worker loop does.
function run(kinds) {
  let state = fresh();
  for (const kind of kinds) {
    const r = reduceBulkDraftOutcome({ state, kind });
    state = r.state;
    if (r.stopReason) return { state, stopReason: r.stopReason };
  }
  return { state, stopReason: null };
}

test("success advances done and never stops the run", () => {
  const { state, stopReason } = run(["success", "success", "success", "success"]);
  assert.equal(stopReason, null);
  assert.equal(state.done, 4);
  assert.equal(state.failed, 0);
});

test("stops after the consecutive-failure limit", () => {
  const { state, stopReason } = run(Array(10).fill("failure"));
  assert.equal(stopReason, "aborted_failures");
  assert.equal(state.failed, CONSECUTIVE_FAILURE_LIMIT);
  // Proves the cap actually short-circuits: 10 units in, only 3 consumed.
  assert.equal(state.done, CONSECUTIVE_FAILURE_LIMIT);
});

test("a success resets the failure streak", () => {
  const { state, stopReason } = run(["failure", "failure", "success", "failure", "failure"]);
  assert.equal(stopReason, null);
  assert.equal(state.done, 5);
  assert.equal(state.failed, 4);
  assert.equal(state.consecutiveFailures, 2);
});

test("disabled stops immediately, on the very first occurrence", () => {
  const { state, stopReason } = run(["disabled", "failure", "failure"]);
  assert.equal(stopReason, "disabled");
  assert.equal(state.done, 1);
  assert.equal(state.failed, 1);
});

test("disabled stops mid-run even after successes", () => {
  const { state, stopReason } = run(["success", "success", "disabled", "success"]);
  assert.equal(stopReason, "disabled");
  assert.equal(state.done, 3);
  assert.equal(state.failed, 1);
});

// #843: after "Draft all with AI", the open template editor remounts (so it
// refetches) when the run targeted the unit that is open at the end of the run.
test("reload: nothing open never reloads", () => {
  assert.equal(openEditorNeedsReload(null, new Set(["a", "b"])), false);
});

test("reload: open unit not in the run does not reload", () => {
  // Covers a unit skipped because it held unsaved typing: the caller's
  // draftable list leaves it out, so it is never targeted.
  assert.equal(openEditorNeedsReload("c", new Set(["a", "b"])), false);
});

test("reload: open unit in the run reloads", () => {
  assert.equal(openEditorNeedsReload("b", new Set(["a", "b"])), true);
});

test("reload: an empty run never reloads", () => {
  assert.equal(openEditorNeedsReload("a", new Set()), false);
});

// The rule is "targeted", not "counted as drafted": a cancelled or fail-fast
// run aborts in-flight requests the server may still have written, so the
// helper takes no run result on purpose. A targeted unit that the run counted
// as failed (or never reached) still reloads; that costs one refetch.
test("reload: does not take the run's drafted count into account", () => {
  assert.equal(openEditorNeedsReload.length, 2);
  assert.equal(openEditorNeedsReload("a", new Set(["a"])), true);
});
