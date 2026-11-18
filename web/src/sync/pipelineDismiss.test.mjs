// Run: node --experimental-strip-types --no-warnings --test src/sync/pipelineDismiss.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { hideDismissedRow } from "./pipelineDismiss.ts";

test("a dismissed job the server still runs stays in the store, so it keeps being polled", () => {
  for (const s of ["queued", "dispatching", "running", "paused_for_outage", "paused_for_usage_limit"]) {
    assert.equal(hideDismissedRow(s, true), false, s);
  }
});

test("a dismissed job the server says is over stays hidden", () => {
  for (const s of ["done", "failed", "cancelled"]) assert.equal(hideDismissedRow(s, true), true, s);
});

test("a job never dismissed is never hidden", () => {
  assert.equal(hideDismissedRow("done", false), false);
  assert.equal(hideDismissedRow("running", false), false);
});
