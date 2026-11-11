// Issue #883: how the outbox reads a row save's 409 (item 6), what it does with
// an expected_state refusal (item 4), and when an auto-heal resend keeps the
// expected_state pin (item 2). conflict409.ts is pure, so these run under the
// strip-types runner that cannot load sync/api.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { resultFor409, deletesOnFatal, healKeepsStatePin } from "./conflict409.ts";

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
