// Issue #883: how the outbox reads a row save's 409 (item 6), what it does with
// an expected_state refusal (item 4), and when an auto-heal resend keeps the
// expected_state pin (item 2). conflict409.ts is pure, so these run under the
// strip-types runner that cannot load sync/api.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { resultFor409, deletesOnFatal, healKeepsStatePin, rearmOnKeepMine } from "./conflict409.ts";
import * as c409 from "./conflict409.ts";

test("Keep mine re-arms the resolved op without its expected_state pin (#883 review A2)", () => {
  const held = { id: "op1", status: "conflict", expectedVersion: 3, conflictCurrent: { version: 5 }, expectedState: "ai_draft", patch: { note: "x" } };
  const out = rearmOnKeepMine(held, "op1", 5);
  assert.equal(out.status, "pending");
  assert.equal(out.expectedVersion, 5);
  assert.equal(out.conflictCurrent, undefined);
  // The user chose to write over the note as it is now: a pin would only be refused.
  assert.equal("expectedState" in out, false);
  assert.deepEqual(out.patch, { note: "x" });
  // A pinned null ("no state") is dropped the same way.
  assert.equal("expectedState" in rearmOnKeepMine({ ...held, expectedState: null }, "op1", 5), false);
});

test("Keep mine re-arms the row's other waiting saves as before, pins kept", () => {
  const sibling = { id: "op2", status: "pending", expectedVersion: 3, expectedState: "edited", patch: { note: "y" } };
  const out = rearmOnKeepMine(sibling, "op1", 5);
  assert.equal(out.status, "pending");
  assert.equal(out.expectedVersion, 5);
  assert.equal(out.conflictCurrent, undefined);
  assert.equal(out.expectedState, "edited");
  // A typed op has no pin and gains none.
  assert.equal("expectedState" in rearmOnKeepMine({ id: "op1", status: "conflict", expectedVersion: 3, patch: {} }, "op1", 5), false);
});

const row = { id: "n1", version: 4, note: "text", translation_state: "validated", trashed_at: null };

test("a state_mismatch 409 is final and carries the row as it is now", () => {
  assert.deepEqual(resultFor409({ error: "state_mismatch", current: row }), {
    kind: "fatal",
    reason: "state_mismatch",
    current: row,
  });
});

test("a version_mismatch 409 is a conflict with the server row", () => {
  assert.deepEqual(resultFor409({ error: "version_mismatch", current: row }), { kind: "conflict", current: row });
  assert.deepEqual(resultFor409(undefined), { kind: "conflict", current: undefined });
  assert.deepEqual(resultFor409(null), { kind: "conflict", current: undefined });
});

test("a workspace_mismatch 409 keeps the op queued", () => {
  assert.deepEqual(resultFor409({ error: "workspace_mismatch" }), { kind: "retry", reason: "workspace_mismatch" });
});

test("verse-lane refusals and alignment loss stay final", () => {
  for (const code of [
    "source_generation_mismatch",
    "lane_replacement_required",
    "lane_replacement_in_progress",
    "scripture_text_read_only",
    "scripture_fully_locked",
  ]) {
    assert.deepEqual(resultFor409({ error: code }), { kind: "fatal", reason: code });
  }
  assert.deepEqual(
    resultFor409({ error: "unexpected_alignment_loss", delta: { unexpectedLosses: [{ text: "a" }, { text: "b" }, {}, { text: "d" }] } }),
    { kind: "fatal", reason: "unexpected_alignment_loss: a, b" },
  );
  assert.deepEqual(resultFor409({ error: "unexpected_alignment_loss" }), { kind: "fatal", reason: "unexpected_alignment_loss" });
});

test("only a state_mismatch refusal is deleted from the outbox (it holds no typing)", () => {
  assert.equal(deletesOnFatal("state_mismatch"), true);
  for (const r of ["http 403", "http 404", "http 422", "source_generation_mismatch", "unexpected_alignment_loss: a"]) {
    assert.equal(deletesOnFatal(r), false, r);
  }
});

test("an auto-heal resend drops the pin when the server note already equals the patch", () => {
  // Our own edit landed (now 'edited'), its response was lost: resending with
  // the 'ai_draft' pin would be refused as state_mismatch.
  assert.equal(healKeepsStatePin({ note: "assistant text" }, { ...row, note: "assistant text", translation_state: "edited" }), false);
});

test("an auto-heal resend keeps the pin whenever a pinless resend could write", () => {
  // Another field moved the version; our field still differs: the resend writes.
  assert.equal(healKeepsStatePin({ note: "assistant text" }, { ...row, note: "text" }), true);
  // Equal only once newlines are folded: the server's no-op test is strict, so it would write.
  assert.equal(healKeepsStatePin({ note: "a\\nb" }, { ...row, note: "a\nb" }), true);
  // A set-aside note skips the server's no-op shortcut: a pinless resend would revive it.
  assert.equal(healKeepsStatePin({ note: "text" }, { ...row, note: "text", trashed_at: 1700000000 }), true);
  // One of two fields differs.
  assert.equal(healKeepsStatePin({ note: "text", quote: "q2" }, { ...row, quote: "q" }), true);
  // No usable server row.
  assert.equal(healKeepsStatePin({ note: "text" }, null), true);
  assert.equal(healKeepsStatePin({}, row), true);
});

test("a pinned assistant edit whose 409 shows it already saved settles as saved, with nothing resent (#886 item 1)", () => {
  const f = c409.healSettlesAsSaved;
  assert.equal(typeof f, "function");
  const op = (patch, expectedState = "ai_draft") => ({ patch, expectedState });
  // Our edit landed and its response was lost: the server note holds our text.
  // A resend without the pin is a write that a set-aside or revert in the gap
  // cannot stop, so the op is settled from the 409's row instead.
  assert.equal(f(op({ note: "assistant text" }), { ...row, note: "assistant text", translation_state: "edited" }), true);
  // A colleague approved it since (#883 review A1): still saved, not a refusal.
  assert.equal(f(op({ note: "assistant text" }), { ...row, note: "assistant text", translation_state: "validated" }), true);
  // null pins "no state" and is still a pin.
  assert.equal(f(op({ note: "text" }, null), { ...row, translation_state: null }), true);
});

test("everything else about an auto-healed 409 is unchanged (#886 item 1)", () => {
  const f = c409.healSettlesAsSaved;
  assert.equal(typeof f, "function");
  // A typed edit (no pin) keeps resending as before.
  assert.equal(f({ patch: { note: "text" } }, row), false);
  // Set aside: keep the pin and resend, so the server refuses it.
  assert.equal(f({ patch: { note: "text" }, expectedState: "ai_draft" }, { ...row, trashed_at: 1700000000 }), false);
  // Our field still differs, or is equal only once newlines are folded: the resend writes.
  assert.equal(f({ patch: { note: "assistant text" }, expectedState: "ai_draft" }, row), false);
  assert.equal(f({ patch: { note: "a\\nb" }, expectedState: "ai_draft" }, { ...row, note: "a\nb" }), false);
  // No usable server row.
  assert.equal(f({ patch: { note: "text" }, expectedState: "ai_draft" }, null), false);
});
