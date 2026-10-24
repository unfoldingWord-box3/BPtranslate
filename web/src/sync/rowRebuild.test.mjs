// Tests for the cached-row rebuild after a row op that never lands (issue #637
// item 1): rebuildsAfterResult, rebuiltRow and rowRebuildAction in
// outboxTargeting.ts.
//
// The defect: a Save patches the cached row at once. When the server refused
// the save (fatal 4xx), the outbox dropped it because an AI pipeline held the
// chapter (locked), or the user discarded it, the cache kept the unsaved value
// until a refetch: on screen, and as the classic editors' saved baseline, so
// their Save stayed disabled. rowRebuild.ts now re-reads the server's row and
// the cache hooks rebuild it with these helpers. The traps named by the PR #642
// review each have a case here (or a note on why the design removes them).

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ATTEMPTS_SENTINEL,
  RowGenerations,
  rebuildsAfterResult,
  rebuiltRow,
  rowRebuildAction,
} from "./outboxTargeting.ts";

const target = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC" };
const otherRow = { kind: "row", rowKind: "tq", id: "q-2", book: "ZEC" };

function op(id, patch, extra = {}) {
  return { id, target, action: "patch", patch, expectedVersion: 2, queuedAt: 0, attempts: 0, status: "pending", ...extra };
}

const server = { id: "q-1", book: "ZEC", chapter: 1, verse: 1, question: "Q", response: "AB", version: 2 };
const optimistic = { ...server, response: "ABC" };

test("which results rebuild the row: fatal (not 404) and locked; not ok, conflict or retry", () => {
  assert.equal(rebuildsAfterResult({ kind: "fatal", reason: "http 422" }), true);
  assert.equal(rebuildsAfterResult({ kind: "locked", lockBody: {} }), true);
  assert.equal(rebuildsAfterResult({ kind: "fatal", reason: "http 404" }), false, "the row is gone");
  assert.equal(rebuildsAfterResult({ kind: "ok", updated: server }), false);
  assert.equal(rebuildsAfterResult({ kind: "conflict", current: server }), false);
  assert.equal(rebuildsAfterResult({ kind: "retry", reason: "network" }), false);
});

test("a refused save is taken off the cached row: the server's row comes back", () => {
  const rebuilt = rebuiltRow(server, target, [op("op-1", { response: "ABC" }, { status: "failed", lastError: "http 422" })], "fatal");
  assert.deepEqual(rowRebuildAction(optimistic, rebuilt), { t: "replace", row: server });
});

test("a later save still waiting at the server's version stays on top; other rows' saves do not", () => {
  const rebuilt = rebuiltRow(
    server,
    target,
    [
      op("op-1", { response: "ABC" }, { status: "failed", lastError: "http 422" }),
      op("op-2", { question: "Q2" }),
      { ...op("op-x", { response: "other" }), target: otherRow },
    ],
    "fatal",
  );
  assert.equal(rebuilt.question, "Q2");
  assert.equal(rebuilt.response, "AB");
  assert.equal(rebuilt.version, 2);
});

test("conflicted or max-attempts-blocked saves are not re-applied", () => {
  for (const extra of [{ status: "conflict" }, { status: "failed", lastError: MAX_ATTEMPTS_SENTINEL }]) {
    assert.equal(rebuiltRow(server, target, [op("op-2", { response: "X" }, extra)], "drop").response, "AB");
  }
});

test("trap 1: a refused or discarded optimistic delete brings the row back", () => {
  // The delete removed the row from the cache; it is no longer queued (fatal
  // leaves it failed, Discard deleted it), so the row is inserted back.
  const failedDelete = { ...op("op-d", undefined), action: "delete", status: "failed", lastError: "http 422" };
  for (const queued of [[failedDelete], []]) {
    assert.deepEqual(rowRebuildAction(undefined, rebuiltRow(server, target, queued, "fatal"), true), {
      t: "insert",
      row: server,
    });
  }
});

test("review A2: a row missing after a refused or discarded PATCH is not inserted back", () => {
  // Something deleted it (this user's later delete, a conflicted delete, another
  // user): only the op that was itself the row's delete may bring it back.
  assert.equal(rowRebuildAction(undefined, rebuiltRow(server, target, [], "fatal"), false), null);
  assert.equal(rowRebuildAction(undefined, rebuiltRow(server, target, [], "drop"), false), null);
  // A cached row is still replaced either way.
  assert.equal(rowRebuildAction(optimistic, rebuiltRow(server, target, [], "drop"), false).t, "replace");
});

test("trap 1: a row with a delete still waiting stays removed", () => {
  const waiting = { ...op("op-d", undefined), action: "delete" };
  assert.equal(rebuiltRow(server, target, [waiting], "drop"), null);
  assert.equal(rowRebuildAction(undefined, null), null);
});

test("trap 3: same-version server changes are kept, since the row is the server's own", () => {
  // The cached row carries a preserve flag the server set at the same version
  // (a confirmed copy kept from an earlier fetch would not have it). The
  // rebuild starts from the server row just read, so it has it.
  const tnServer = { id: "n-1", book: "ZEC", chapter: 1, verse: 1, note: "AB", preserve: 1, hint: 0, version: 5 };
  const tnTarget = { kind: "row", rowKind: "tn", id: "n-1", book: "ZEC" };
  const cached = { ...tnServer, note: "ABC" };
  const action = rowRebuildAction(cached, rebuiltRow(tnServer, tnTarget, [], "fatal"));
  assert.equal(action.row.note, "AB");
  assert.equal(action.row.preserve, 1);
});

test("trap 4: keep theirs rebuilds to the server's newer row; a sibling sent at the old version is left off", () => {
  // The dropped op's 409 said the server is at v3 with the other user's text.
  const theirs = { ...server, response: "THEIRS", version: 3 };
  // A sibling save queued at v2 for the same field would hit a genuine
  // conflict on top of v3 (its baseline "AB" is not what v3 has), so it must
  // not be shown stamped with v3.
  const sibling = op("op-2", { response: "MINE2" }, { baseline: { response: "AB" } });
  const rebuilt = rebuiltRow(theirs, target, [sibling], "drop");
  assert.equal(rebuilt.response, "THEIRS");
  assert.deepEqual(rowRebuildAction(optimistic, rebuilt), { t: "replace", row: theirs });
});

test("trap 4: a sibling the 409 rule would auto-heal is kept on top of the newer row", () => {
  // The other user changed the question; the sibling sends the response, which
  // v3 still has at the sibling's baseline value: it will land.
  const theirs = { ...server, question: "Q-THEIRS", version: 3 };
  const sibling = op("op-2", { response: "MINE2" }, { baseline: { response: "AB" } });
  const rebuilt = rebuiltRow(theirs, target, [sibling], "drop");
  assert.equal(rebuilt.response, "MINE2");
  assert.equal(rebuilt.question, "Q-THEIRS");
  assert.equal(rebuilt.version, 3);
});

test("trap 5: a cached row newer than the server row read is left alone", () => {
  // A later save's 200 (v3) landed while the server row (v2) was being read.
  const newer = { ...server, response: "ABCD", version: 3 };
  assert.equal(rowRebuildAction(newer, rebuiltRow(server, target, [], "fatal")), null);
  // Same version: the cached copy is the optimistic one, replaced.
  assert.equal(rowRebuildAction(optimistic, rebuiltRow(server, target, [], "fatal")).t, "replace");
});

test("an unreadable outbox leaves the cache alone (a waiting save cannot be ruled out)", () => {
  assert.equal(rebuiltRow(server, target, null, "fatal"), null);
  assert.equal(rebuiltRow(server, target, undefined, "drop"), null);
});

test("trap 7: after a locked drop no waiting save is re-applied (each will be dropped too)", () => {
  const rebuilt = rebuiltRow(server, target, [op("op-2", { response: "ABCD" })], "locked");
  assert.equal(rebuilt, server);
});

test("trap 7: the AI apply's newer row is not rolled back by a late rebuild", () => {
  const aiApplied = { ...server, response: "AI TEXT", version: 4 };
  assert.equal(rowRebuildAction(aiApplied, rebuiltRow(server, target, [], "locked")), null);
});

// Review round 2 B1: a rebuild's server read is applied only if nothing else
// happened to the row (another outbox result or drop, or another rebuild)
// since that rebuild started.
test("B1: a later event for the row makes an in-flight rebuild stale", () => {
  // A refused DELETE's read is in flight; then a later DELETE for the row
  // succeeds. The old read must not put the row back.
  const g = new RowGenerations();
  const started = g.bump("row:tq:ZEC:q-1");
  g.bump("row:tq:ZEC:q-1"); // the later delete's "ok" result
  assert.equal(g.isCurrent("row:tq:ZEC:q-1", started), false);
  // Another row's events do not touch it.
  const other = g.bump("row:tq:ZEC:q-2");
  g.bump("row:tq:ZEC:q-1");
  assert.equal(g.isCurrent("row:tq:ZEC:q-2", other), true);
});

test("B1: of two overlapping rebuilds for a row, only the one started last applies, whichever read returns first", () => {
  const key = "row:tq:ZEC:q-1";
  for (const order of [["first", "second"], ["second", "first"]]) {
    const g = new RowGenerations();
    const gens = { first: g.bump(key), second: g.bump(key) };
    const applied = order.filter((name) => g.isCurrent(key, gens[name]));
    assert.deepEqual(applied, ["second"], `returns in order ${order.join(", ")}`);
  }
});
