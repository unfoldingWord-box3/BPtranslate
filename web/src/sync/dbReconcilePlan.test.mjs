// Unit test for dbReconcilePlan.ts's decideAdoption — the per-record rule that
// adopt-on-open reconciliation (#502) applies when moving stranded outbox ops
// and drafts from a sibling IndexedDB into the one the app opened.
//
// Run from repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/dbReconcilePlan.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAdoption } from "./dbReconcilePlan.ts";

test("a stranded record the opened DB lacks is copied", () => {
  assert.equal(decideAdoption({ id: "op-1", status: "pending" }, undefined), "put");
});

test("an outbox op already adopted (same uuid key) only has its sibling copy dropped", () => {
  const op = { id: "op-1", status: "pending" };
  assert.equal(decideAdoption(op, { ...op }), "drop");
});

test("a stranded draft NEWER than the opened DB's copy wins (not deleted unseen)", () => {
  // Session A wrote K at t=1 into the unsuffixed DB; session B (pre-flag) wrote
  // K at t=2 into the suffixed one. Session C opens the unsuffixed DB: the
  // newer t=2 typing must be adopted, not dropped.
  const older = { key: "K", updatedAt: 1, payload: "old" };
  const newer = { key: "K", updatedAt: 2, payload: "new" };
  assert.equal(decideAdoption(newer, older), "put");
});

test("a stranded draft older than or equal to the opened DB's copy is dropped", () => {
  const older = { key: "K", updatedAt: 1 };
  const newer = { key: "K", updatedAt: 2 };
  assert.equal(decideAdoption(older, newer), "drop");
  assert.equal(decideAdoption(newer, { ...newer }), "drop");
});
