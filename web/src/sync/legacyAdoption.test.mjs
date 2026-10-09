// Unit tests for legacyAdoption.ts's move rule (#502): records an older build
// left in a legacy database are copied into the live one, and the legacy copy
// is deleted only when unchanged.
//
// Run from repo root:
//   node --experimental-strip-types --no-warnings --test web/src/sync/legacyAdoption.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { moveRecords, shouldReplace } = await import("./legacyAdoption.ts");

// A Map-backed StoreSide. `beforeUpdate(key)` runs before each update, to
// simulate another tab writing between our read and our write.
function side(records, keyField, beforeUpdate) {
  const m = new Map(records.map((r) => [r[keyField], structuredClone(r)]));
  return {
    m,
    async getAll() {
      return [...m.values()].map((r) => structuredClone(r));
    },
    async update(key, decide) {
      beforeUpdate?.(key, m);
      const change = decide(m.has(key) ? structuredClone(m.get(key)) : undefined);
      if (change && "put" in change) m.set(key, structuredClone(change.put));
      else if (change) m.delete(key);
    },
  };
}
const byId = (r) => r.id;
const byKey = (r) => r.key;

test("shouldReplace: absent target always takes the legacy record", () => {
  assert.equal(shouldReplace({ id: "a" }, undefined), true);
  assert.equal(shouldReplace({ key: "k", updatedAt: 1 }, undefined, "updatedAt"), true);
});

test("shouldReplace: outbox ops (no newerField) keep the target's copy", () => {
  assert.equal(shouldReplace({ id: "a", queuedAt: 9 }, { id: "a", queuedAt: 1 }), false);
});

test("shouldReplace: drafts take the strictly newer updatedAt; a tie keeps the target", () => {
  assert.equal(shouldReplace({ updatedAt: 5 }, { updatedAt: 4 }, "updatedAt"), true);
  assert.equal(shouldReplace({ updatedAt: 4 }, { updatedAt: 5 }, "updatedAt"), false);
  assert.equal(shouldReplace({ updatedAt: 5, x: 1 }, { updatedAt: 5, x: 2 }, "updatedAt"), false);
});

test("moves outbox ops into the live store and empties the legacy one", async () => {
  const legacy = side([{ id: "a", status: "pending" }, { id: "b", status: "failed" }], "id");
  const target = side([{ id: "c", status: "pending" }], "id");
  const moved = await moveRecords(legacy, target, byId);
  assert.equal(moved, 2);
  assert.equal(legacy.m.size, 0);
  assert.deepEqual([...target.m.keys()].sort(), ["a", "b", "c"]);
});

test("an op an interrupted run already copied is not re-copied; the legacy copy is removed", async () => {
  const legacy = side([{ id: "a", status: "pending" }], "id");
  const target = side([{ id: "a", status: "in_flight", attempts: 1 }], "id");
  const moved = await moveRecords(legacy, target, byId);
  assert.equal(moved, 0);
  assert.equal(legacy.m.size, 0);
  assert.deepEqual(target.m.get("a"), { id: "a", status: "in_flight", attempts: 1 });
});

test("drafts: newer legacy draft replaces the target's; older or tied one is dropped", async () => {
  const legacy = side(
    [
      { key: "new", updatedAt: 10, text: "legacy" },
      { key: "old", updatedAt: 1, text: "legacy" },
      { key: "tie", updatedAt: 5, text: "legacy" },
    ],
    "key",
  );
  const target = side(
    [
      { key: "new", updatedAt: 2, text: "live" },
      { key: "old", updatedAt: 3, text: "live" },
      { key: "tie", updatedAt: 5, text: "live" },
    ],
    "key",
  );
  await moveRecords(legacy, target, byKey, "updatedAt");
  assert.equal(legacy.m.size, 0, "legacy store emptied");
  assert.equal(target.m.get("new").text, "legacy");
  assert.equal(target.m.get("old").text, "live");
  assert.equal(target.m.get("tie").text, "live");
});

test("a legacy record changed by an older-build tab mid-move is left for the next run, and our copy undone", async () => {
  let legacyUpdates = 0;
  const legacy = side([{ id: "a", patch: { note: "v1" } }], "id", (key, m) => {
    // The first legacy update is our delete-if-unchanged; the old tab
    // coalesces a newer payload into the same op right before it.
    if (legacyUpdates++ === 0) m.set(key, { id: "a", patch: { note: "v2" } });
  });
  const target = side([], "id");
  const moved = await moveRecords(legacy, target, byId);
  assert.equal(moved, 0);
  assert.equal(target.m.size, 0, "stale copy removed from the live store");
  assert.deepEqual(legacy.m.get("a"), { id: "a", patch: { note: "v2" } }, "newer payload kept");

  // Next run moves the newer payload.
  const again = await moveRecords(legacy, target, byId);
  assert.equal(again, 1);
  assert.deepEqual(target.m.get("a"), { id: "a", patch: { note: "v2" } });
  assert.equal(legacy.m.size, 0);
});

test("a legacy record removed by an older-build tab mid-move (it was sent) is not resurrected", async () => {
  let n = 0;
  const legacy = side([{ id: "a" }], "id", (key, m) => {
    if (n++ === 0) m.delete(key);
  });
  const target = side([], "id");
  assert.equal(await moveRecords(legacy, target, byId), 0);
  assert.equal(target.m.size, 0);
});

test("the undo never deletes a newer draft a live tab wrote over our copy", async () => {
  let n = 0;
  let targetRef;
  const legacy = side([{ key: "k", updatedAt: 5, text: "legacy" }], "key", (key, m) => {
    if (n++ === 0) {
      m.set(key, { key: "k", updatedAt: 6, text: "old tab" });
      targetRef.m.set(key, { key: "k", updatedAt: 7, text: "live tab" });
    }
  });
  const target = side([], "key");
  targetRef = target;
  await moveRecords(legacy, target, byKey, "updatedAt");
  assert.equal(target.m.get("k").text, "live tab");
});
