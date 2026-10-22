// Issue #561: client-side chapter-lock derivation must match the server
// (api/src/chapterLock.ts) so the banner and read-only editors appear before a
// save is refused.
import { test } from "node:test";
import assert from "node:assert/strict";

import { jobLocksChapter, jobLocksChapterNotes, noteLockedReadOnly } from "./chapterLock.ts";

const job = (over = {}) => ({
  book: "ZEC",
  start_chapter: 1,
  end_chapter: 1,
  state: "running",
  pipeline_type: "translate",
  locks_chapter_notes: true,
  ...over,
});

test("a running job locks the chapters in its range only", () => {
  assert.equal(jobLocksChapter(job(), "ZEC", 1), true);
  assert.equal(jobLocksChapter(job(), "ZEC", 2), false);
  assert.equal(jobLocksChapter(job(), "HOS", 1), false);
  assert.equal(jobLocksChapter(job({ pipeline_type: "notes", locks_chapter_notes: false }), "ZEC", 1), true);
});

test("the book intro (chapter 0) is locked by a chapter-wide translate that starts at chapter 1", () => {
  assert.equal(jobLocksChapter(job(), "ZEC", 0), true);
  assert.equal(jobLocksChapter(job({ start_chapter: 2, end_chapter: 3 }), "ZEC", 0), false);
  assert.equal(jobLocksChapter(job({ pipeline_type: "notes", locks_chapter_notes: false }), "ZEC", 0), false);
  assert.equal(jobLocksChapter(job({ locks_chapter_notes: false }), "ZEC", 0), false, "a single-note redraft");
  assert.equal(jobLocksChapter(job({ locks_chapter_notes: undefined }), "ZEC", 0), false, "unknown scope");
});

test("only in-flight states lock", () => {
  for (const state of ["running", "paused_for_outage", "paused_for_usage_limit", "dispatching"]) {
    assert.equal(jobLocksChapter(job({ state }), "ZEC", 1), true, state);
  }
  for (const state of ["queued", "done", "failed", "cancelled"]) {
    assert.equal(jobLocksChapter(job({ state }), "ZEC", 1), false, state);
    assert.equal(jobLocksChapter(job({ state }), "ZEC", 0), false, state);
    assert.equal(jobLocksChapterNotes(job({ state }), "ZEC", 1), false, state);
  }
});

test("jobLocksChapterNotes: only a chapter-wide tn translate makes every note read-only", () => {
  assert.equal(jobLocksChapterNotes(job(), "ZEC", 1), true);
  assert.equal(jobLocksChapterNotes(job(), "ZEC", 0), true);
  assert.equal(jobLocksChapterNotes(job({ locks_chapter_notes: false }), "ZEC", 1), false);
  assert.equal(jobLocksChapterNotes(job({ pipeline_type: "notes" }), "ZEC", 1), false);
  assert.equal(jobLocksChapterNotes(job(), "ZEC", 2), false);
});

test("a translate lock makes every note read-only, kept and hint notes included", () => {
  assert.equal(noteLockedReadOnly("translate", true, false, false), true);
  assert.equal(noteLockedReadOnly("translate", true, true, false), true);
  assert.equal(noteLockedReadOnly("translate", true, false, true), true);
});

test("a non-translate lock keeps kept and hint notes editable (unchanged behavior)", () => {
  assert.equal(noteLockedReadOnly("notes", true, false, false), true);
  assert.equal(noteLockedReadOnly("notes", true, true, false), false);
  assert.equal(noteLockedReadOnly("notes", true, false, true), false);
  assert.equal(noteLockedReadOnly(null, true, true, false), false);
});

test("no lock, no read-only", () => {
  assert.equal(noteLockedReadOnly("translate", false, false, false), false);
  assert.equal(noteLockedReadOnly(null, false, false, false), false);
});
