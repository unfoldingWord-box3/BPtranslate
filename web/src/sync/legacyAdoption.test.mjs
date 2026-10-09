// Unit tests for legacyAdoption.ts's move rule (#502): records an older build
// left in a legacy database are copied into the live one, and the legacy copy
// is deleted only when unchanged.
//
// Run from repo root:
//   node --experimental-strip-types --no-warnings --test web/src/sync/legacyAdoption.test.mjs

import test from "node:test";
import assert from "node:assert/strict";

const { moveRecords, decide } = await import("./legacyAdoption.ts");

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

test("decide: an absent live copy always takes the legacy record", () => {
  assert.equal(decide({ id: "a" }, undefined, "outbox"), "copy");
  assert.equal(decide({ key: "k", updatedAt: 1 }, undefined, "draft"), "copy");
});

test("decide (outbox): newer queuedAt wins, a tie or older keeps the live op", () => {
  assert.equal(decide({ queuedAt: 9 }, { queuedAt: 1, status: "pending" }, "outbox"), "copy");
  assert.equal(decide({ queuedAt: 1, p: 1 }, { queuedAt: 1, p: 2, status: "pending" }, "outbox"), "drop");
  assert.equal(decide({ queuedAt: 1 }, { queuedAt: 9, status: "pending" }, "outbox"), "drop");
});

test("decide (outbox): an in_flight live op is never overwritten", () => {
  assert.equal(decide({ queuedAt: 9 }, { queuedAt: 1, status: "in_flight" }, "outbox"), "keep");
  assert.equal(decide({ queuedAt: 1 }, { queuedAt: 9, status: "in_flight" }, "outbox"), "drop");
});

test("decide (outbox): a missing or non-numeric queuedAt on either side keeps both", () => {
  assert.equal(decide({ id: "a" }, { id: "a", queuedAt: 1, status: "pending" }, "outbox"), "keep");
  assert.equal(decide({ id: "a", queuedAt: 9 }, { id: "a", status: "pending" }, "outbox"), "keep");
  assert.equal(decide({ id: "a", queuedAt: "9" }, { id: "a", queuedAt: 1 }, "outbox"), "keep");
});

test("decide (draft): strictly newer wins; otherwise drop only identical content", () => {
  const d = (updatedAt, text, extra = {}) => ({ key: "k", updatedAt, payload: { text }, ...extra });
  assert.equal(decide(d(5, "a"), d(4, "b"), "draft"), "copy");
  assert.equal(decide(d(4, "a"), d(5, "a"), "draft"), "drop");
  assert.equal(decide(d(4, "a"), d(5, "b"), "draft"), "keep");
  assert.equal(decide(d(5, "a"), d(5, "b"), "draft"), "keep");
});

test("decide (draft): identical text drops despite different generation / expectedVersion", () => {
  const legacy = { key: "k", updatedAt: 1, payload: { text: "x" }, generation: "g1", expectedVersion: 3 };
  const live = { key: "k", updatedAt: 2, payload: { text: "x" }, generation: "g2", expectedVersion: 4 };
  assert.equal(decide(legacy, live, "draft"), "drop");
  const aLegacy = { key: "k", updatedAt: 1, content: { verseObjects: [1] }, expectedVersion: 3, sourceGeneration: 1 };
  const aLive = { key: "k", updatedAt: 2, content: { verseObjects: [1] }, expectedVersion: 4, sourceGeneration: 2 };
  assert.equal(decide(aLegacy, aLive, "draft"), "drop", "alignment drafts compare `content`");
  assert.equal(decide(aLegacy, { ...aLive, content: { verseObjects: [2] } }, "draft"), "keep");
});

test("moves outbox ops into the live store and empties the legacy one", async () => {
  const legacy = side([{ id: "a", status: "pending" }, { id: "b", status: "failed" }], "id");
  const target = side([{ id: "c", status: "pending" }], "id");
  const moved = await moveRecords(legacy, target, byId, "outbox");
  assert.equal(moved, 2);
  assert.equal(legacy.m.size, 0);
  assert.deepEqual([...target.m.keys()].sort(), ["a", "b", "c"]);
});

test("an op an interrupted run already copied is not re-copied; the legacy copy is removed", async () => {
  const legacy = side([{ id: "a", queuedAt: 1, status: "pending" }], "id");
  const target = side([{ id: "a", queuedAt: 1, status: "in_flight", attempts: 1 }], "id");
  const moved = await moveRecords(legacy, target, byId, "outbox");
  assert.equal(moved, 0);
  assert.equal(legacy.m.size, 0);
  assert.deepEqual(target.m.get("a"), { id: "a", queuedAt: 1, status: "in_flight", attempts: 1 });
});

test("drafts: newer legacy draft replaces the live one; a different older or tied one stays in legacy", async () => {
  const legacy = side(
    [
      { key: "new", updatedAt: 10, payload: "legacy" },
      { key: "old", updatedAt: 1, payload: "legacy" },
      { key: "tie", updatedAt: 5, payload: "legacy" },
    ],
    "key",
  );
  const target = side(
    [
      { key: "new", updatedAt: 2, payload: "live" },
      { key: "old", updatedAt: 3, payload: "live" },
      { key: "tie", updatedAt: 5, payload: "live" },
    ],
    "key",
  );
  await moveRecords(legacy, target, byKey, "draft");
  assert.equal(target.m.get("new").payload, "legacy");
  assert.equal(target.m.get("old").payload, "live");
  assert.equal(target.m.get("tie").payload, "live");
  assert.deepEqual([...legacy.m.keys()].sort(), ["old", "tie"], "different older/tied drafts are kept, not deleted");
});

test("a legacy record changed by an older-build tab mid-move is left for the next run, and our copy undone", async () => {
  let legacyUpdates = 0;
  const legacy = side([{ id: "a", patch: { note: "v1" } }], "id", (key, m) => {
    // The first legacy update is our delete-if-unchanged; the old tab
    // coalesces a newer payload into the same op right before it.
    if (legacyUpdates++ === 0) m.set(key, { id: "a", patch: { note: "v2" } });
  });
  const target = side([], "id");
  const moved = await moveRecords(legacy, target, byId, "outbox");
  assert.equal(moved, 0);
  assert.equal(target.m.size, 0, "stale copy removed from the live store");
  assert.deepEqual(legacy.m.get("a"), { id: "a", patch: { note: "v2" } }, "newer payload kept");

  // Next run moves the newer payload.
  const again = await moveRecords(legacy, target, byId, "outbox");
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
  assert.equal(await moveRecords(legacy, target, byId, "outbox"), 0);
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
  await moveRecords(legacy, target, byKey, "draft");
  assert.equal(target.m.get("k").text, "live tab");
});

test("drafts: an older legacy draft identical in content is dropped", async () => {
  const legacy = side([{ key: "k", updatedAt: 1, payload: "same", generation: "a" }], "key");
  const target = side([{ key: "k", updatedAt: 9, payload: "same", generation: "b" }], "key");
  await moveRecords(legacy, target, byKey, "draft");
  assert.equal(legacy.m.size, 0);
  assert.equal(target.m.get("k").updatedAt, 9);
});

test("outbox: a newer legacy payload under a shared id replaces a pending live copy", async () => {
  const legacy = side([{ id: "a", queuedAt: 9, patch: { note: "v2" } }], "id");
  const target = side([{ id: "a", queuedAt: 1, status: "pending", patch: { note: "v1" } }], "id");
  assert.equal(await moveRecords(legacy, target, byId, "outbox"), 1);
  assert.deepEqual(target.m.get("a").patch, { note: "v2" });
  assert.equal(legacy.m.size, 0);
});

test("outbox: a newer legacy payload waits while the live copy is in_flight", async () => {
  const legacy = side([{ id: "a", queuedAt: 9, patch: { note: "v2" } }], "id");
  const target = side([{ id: "a", queuedAt: 1, status: "in_flight", patch: { note: "v1" } }], "id");
  assert.equal(await moveRecords(legacy, target, byId, "outbox"), 0);
  assert.deepEqual(target.m.get("a").patch, { note: "v1" });
  assert.equal(legacy.m.size, 1, "kept for the next run");
});
