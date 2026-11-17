// The translate apply's skip report (#601, option B): notes a person changed
// after the job was queued are left alone, and the job carries their ids in
// apply_skipped_json. The flows Redo uses it to tell "your note was kept"
// apart from "new draft ready" (a Redo that attached to an already-queued
// chapter-wide job whose apply skipped this note).
import test from "node:test";
import assert from "node:assert/strict";
import { redoOutcome, skippedTnRowIds } from "./applySkipped.ts";

const skipped = JSON.stringify({ tnTouched: 2, tnTouchedIds: ["a1b2", "c3d4"] });

test("reads the skipped note ids from the job", () => {
  assert.deepEqual(skippedTnRowIds({ apply_skipped_json: skipped }), ["a1b2", "c3d4"]);
});

test("no report, or an unreadable one, means nothing was skipped", () => {
  assert.deepEqual(skippedTnRowIds({ apply_skipped_json: null }), []);
  assert.deepEqual(skippedTnRowIds({}), []);
  assert.deepEqual(skippedTnRowIds({ apply_skipped_json: "{not json" }), []);
  assert.deepEqual(skippedTnRowIds({ apply_skipped_json: JSON.stringify({ tnTouchedIds: "a1b2" }) }), []);
});

test("a done job that skipped this note: the note was kept", () => {
  assert.equal(redoOutcome({ state: "done", apply_skipped_json: skipped }, "c3d4"), "kept");
});

test("a done job that skipped other notes: new draft", () => {
  assert.equal(redoOutcome({ state: "done", apply_skipped_json: skipped }, "zzzz"), "drafted");
  assert.equal(redoOutcome({ state: "done" }, "a1b2"), "drafted");
});

test("a done job that dropped this note's draft as the English: english (#794)", () => {
  const report = JSON.stringify({ tnSameAsEnglish: 1, tnSameAsEnglishIds: ["a1b2"] });
  assert.equal(redoOutcome({ state: "done", apply_skipped_json: report }, "a1b2"), "english");
  assert.equal(redoOutcome({ state: "done", apply_skipped_json: report }, "c3d4"), "drafted");
  assert.deepEqual(skippedTnRowIds({ apply_skipped_json: report }), [], "an English echo is not a kept edit");
});

test("a job that did not finish is a failure whatever it skipped", () => {
  assert.equal(redoOutcome({ state: "failed", apply_skipped_json: skipped }, "a1b2"), "failed");
  assert.equal(redoOutcome({ state: "cancelled" }, "a1b2"), "failed");
});
