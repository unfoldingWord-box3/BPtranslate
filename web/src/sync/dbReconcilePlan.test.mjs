// Unit test for dbReconcilePlan.ts's decideAdoption — the per-record rule that
// adopt-on-open reconciliation (#502) applies when moving stranded outbox ops
// and drafts from a sibling IndexedDB into the one the app opened.
//
// Run from repo root:
//   node --experimental-strip-types --no-warnings web/src/sync/dbReconcilePlan.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptRecords, decideAdoption } from "./dbReconcilePlan.ts";

// In-memory stand-in for one IndexedDB object store keyed by `id`.
// `onTx(n)` runs as the n-th transaction opens (0-based), to simulate another
// tab writing between adoptRecords' phases; `failTx(n)` makes that one throw.
function fakeStore(records, { onTx, failTx } = {}) {
  const map = new Map(records.map((r) => [r.id, structuredClone(r)]));
  let n = 0;
  return {
    map,
    readAll: async () => [...map.values()].map((r) => structuredClone(r)),
    tx: () => {
      const i = n++;
      onTx?.(i, map);
      const fail = failTx?.(i);
      return {
        get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
        put: async (r) => {
          if (fail) throw new Error("tx failed");
          map.set(r.id, structuredClone(r));
        },
        delete: async (k) => {
          if (fail) throw new Error("tx failed");
          map.delete(k);
        },
        done: Promise.resolve(),
      };
    },
  };
}
const keyOf = (r) => r.id;

test("adoptRecords moves stranded ops and empties the sibling", async () => {
  const sibling = fakeStore([{ id: "a", v: 1 }, { id: "b", v: 1 }]);
  const opened = fakeStore([]);
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 2);
  assert.deepEqual([...opened.map.keys()].sort(), ["a", "b"]);
  assert.equal(sibling.map.size, 0);
});

test("A3: a failing sibling delete still reports the copies that committed", async () => {
  const sibling = fakeStore([{ id: "a", v: 1 }], { failTx: (i) => i === 0 });
  const opened = fakeStore([]);
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 1, "caller must still drain/notify");
  assert.equal(res.failed, true, "and must retry later to drop the sibling copy");
  assert.ok(opened.map.has("a"));
  assert.ok(sibling.map.has("a"), "left for the next open to drop");
});

test("A1: a sibling op rewritten by a live tab after the snapshot is not duplicated", async () => {
  // The sibling's owner coalesces a newer value into op "a" after our snapshot
  // (as our opened-store write starts). Its version must be the only one left.
  const opened = fakeStore([]);
  const sibling = fakeStore([{ id: "a", value: "old" }]);
  const realTx = opened.tx;
  let first = true;
  opened.tx = () => {
    if (first) {
      first = false;
      sibling.map.set("a", { id: "a", value: "new" });
    }
    return realTx();
  };
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 0);
  assert.equal(opened.map.has("a"), false, "our stale copy is undone");
  assert.deepEqual(sibling.map.get("a"), { id: "a", value: "new" });
});

test("A1: a sibling op sent or discarded by a live tab after the snapshot is not re-sent", async () => {
  const opened = fakeStore([]);
  const sibling = fakeStore([{ id: "a", value: "x" }]);
  const realTx = opened.tx;
  let first = true;
  opened.tx = () => {
    if (first) {
      first = false;
      sibling.map.delete("a");
    }
    return realTx();
  };
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 0);
  assert.equal(opened.map.has("a"), false);
});

test("A1: a held (young in-flight) op stays in the sibling and reports when to retry", async () => {
  const sibling = fakeStore([
    { id: "a", status: "in_flight", until: 500 },
    { id: "b", status: "pending" },
  ]);
  const opened = fakeStore([]);
  const res = await adoptRecords({
    sibling,
    opened,
    keyOf,
    holdUntil: (r) => (r.status === "in_flight" ? r.until : undefined),
  });
  assert.equal(res.adopted, 1);
  assert.equal(res.heldUntil, 500);
  assert.ok(sibling.map.has("a") && !opened.map.has("a"));
  assert.ok(opened.map.has("b") && !sibling.map.has("b"));
});

test("B3: a newer coalesced payload in the sibling replaces an older adopted copy", async () => {
  // 1. An earlier adoption copied op X into the opened DB but its sibling
  //    delete failed, so X sits in both.
  // 2. A live tab still on the sibling coalesces a newer payload into X
  //    (same uuid, new patch, newer queuedAt).
  // 3. The next adoption must keep the NEWER payload, not drop it.
  const opened = fakeStore([{ id: "X", queuedAt: 1, patch: { note: "old" }, status: "pending" }]);
  const sibling = fakeStore([{ id: "X", queuedAt: 2, patch: { note: "new" }, status: "pending" }]);
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 1);
  assert.deepEqual(opened.map.get("X").patch, { note: "new" });
  assert.equal(sibling.map.size, 0);
});

test("B3: same queuedAt (same payload, drain bookkeeping differs) keeps ours and drops the sibling", () => {
  const ours = { id: "X", queuedAt: 1, patch: { note: "a" }, status: "pending", attempts: 3 };
  const theirs = { id: "X", queuedAt: 1, patch: { note: "a" }, status: "pending", attempts: 0 };
  assert.equal(decideAdoption(theirs, ours), "drop");
  assert.equal(decideAdoption({ ...theirs, queuedAt: 0 }, ours), "drop");
});

test("D3': an attempt aborted before its write never touches the opened store", async () => {
  // The outbox gave up on this attempt (timeout) and released the drain lock;
  // drain may already have dispatched X. The abandoned attempt must not
  // overwrite it with the sibling's copy.
  const opened = fakeStore([{ id: "X", queuedAt: 1, status: "in_flight", patch: { v: "sent" } }]);
  const sibling = fakeStore([{ id: "X", queuedAt: 2, status: "pending", patch: { v: "newer" } }]);
  const res = await adoptRecords({ sibling, opened, keyOf, isAborted: () => true });
  assert.equal(res.failed, true);
  assert.equal(res.adopted, 0);
  assert.equal(opened.map.get("X").status, "in_flight", "our in-flight record is untouched");
  assert.equal(sibling.map.get("X").patch.v, "newer", "the newer payload stays for the next attempt");
});

test("D3': an attempt aborted after its copy commits leaves the sibling copy and reports failed", async () => {
  const opened = fakeStore([]);
  const sibling = fakeStore([{ id: "a", queuedAt: 1 }]);
  let calls = 0;
  const res = await adoptRecords({ sibling, opened, keyOf, isAborted: () => calls++ > 0 });
  assert.equal(res.failed, true);
  assert.equal(res.adopted, 1);
  assert.ok(opened.map.has("a"));
  assert.ok(sibling.map.has("a"), "the next attempt drops it");
});

test("A5: an equal-timestamp, different-content draft is left in both places", async () => {
  const sibling = fakeStore([{ id: "K", updatedAt: 5, text: "B" }]);
  const opened = fakeStore([{ id: "K", updatedAt: 5, text: "A" }]);
  const res = await adoptRecords({ sibling, opened, keyOf });
  assert.equal(res.adopted, 0);
  assert.equal(opened.map.get("K").text, "A");
  assert.equal(sibling.map.get("K").text, "B");
});

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

test("same updatedAt but different content keeps both copies (no distinct edit discarded)", () => {
  const a = { key: "K", updatedAt: 5, payload: "typed in session A" };
  const b = { key: "K", updatedAt: 5, payload: "typed in session B" };
  assert.equal(decideAdoption(a, b), "keep");
});
