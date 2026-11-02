// Issue #561: client-side chapter-lock derivation must match the server
// (api/src/chapterLock.ts) so the banner and read-only editors appear before a
// save is refused.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  jobLocksChapter,
  jobLocksChapterNoteCards,
  jobLocksChapterNotes,
  jobLocksNote,
  lockJobReleased,
  noteLockedReadOnly,
} from "./chapterLock.ts";

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

// Issue #606: a single-note Redo or verse-range redraft locks only the notes it
// will write. jobLocksNote mirrors the server's translateLockForTnRow.
const note = (over = {}) => ({ id: "n1", chapter: 1, verse: 2, ref_raw: "1:2", ...over });
const redraft = (sel, over = {}) =>
  job({ locks_chapter_notes: false, note_selection: { row_ids: null, verse_start: null, verse_end: null, ...sel }, ...over });

test("jobLocksNote: a single-note redraft locks that note only", () => {
  const j = redraft({ row_ids: ["n1"] });
  assert.equal(jobLocksNote(j, "ZEC", note()), true);
  assert.equal(jobLocksNote(j, "ZEC", note({ id: "n2" })), false);
  assert.equal(jobLocksChapterNotes(j, "ZEC", 1), false);
  assert.equal(jobLocksNote(j, "MAL", note()), false);
});

test("jobLocksNote: a verse-range redraft locks notes whose verses overlap it, bridged refs included", () => {
  const j = redraft({ verse_start: 3, verse_end: 4 });
  assert.equal(jobLocksNote(j, "ZEC", note({ verse: 3, ref_raw: "1:3" })), true);
  assert.equal(jobLocksNote(j, "ZEC", note({ verse: 2, ref_raw: "1:2-3" })), true);
  assert.equal(jobLocksNote(j, "ZEC", note({ verse: 2, ref_raw: "1:2" })), false);
  assert.equal(jobLocksNote(j, "ZEC", note({ verse: 5, ref_raw: "1:5" })), false);
  // verse_end missing: the range is the single start verse.
  assert.equal(jobLocksNote(redraft({ verse_start: 2 }), "ZEC", note()), true);
});

test("jobLocksNote: the book intro is locked only when its row was selected", () => {
  const intro = note({ id: "intro", chapter: 0, verse: 0, ref_raw: "front:intro" });
  assert.equal(jobLocksNote(redraft({ row_ids: ["intro"] }), "ZEC", intro), true);
  assert.equal(jobLocksNote(redraft({ verse_start: 0, verse_end: 9 }), "ZEC", intro), false);
  // Intro is covered only by a job starting at chapter 1.
  assert.equal(jobLocksNote(redraft({ row_ids: ["intro"] }, { start_chapter: 2, end_chapter: 2 }), "ZEC", intro), false);
});

test("jobLocksNote: a chapter-wide translate locks every note in range; other jobs lock none", () => {
  assert.equal(jobLocksNote(job(), "ZEC", note({ id: "any" })), true);
  assert.equal(jobLocksNote(job(), "ZEC", note({ chapter: 2 })), false);
  assert.equal(jobLocksNote(job({ pipeline_type: "notes", locks_chapter_notes: false }), "ZEC", note()), false);
  // A non-tn translate selection carries no note_selection, so it locks no note.
  assert.equal(jobLocksNote(job({ locks_chapter_notes: false }), "ZEC", note()), false);
  assert.equal(jobLocksNote(redraft({ row_ids: ["n1"] }, { state: "queued" }), "ZEC", note()), false);
  assert.equal(jobLocksNote(redraft({ row_ids: ["n1"] }, { state: "done" }), "ZEC", note()), false);
});

test("lockJobReleased: only a known job that left the locking states releases a refused-save lock", () => {
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "done" }]), true);
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "failed" }]), true);
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "running" }]), false);
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "paused_for_outage" }]), false);
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "cancelled" }]), true);
  // The store can lag the server: 'queued' there while the server already
  // dispatched the job and refused the save. Not a release.
  assert.equal(lockJobReleased("j1", [{ job_id: "j1", state: "queued" }]), false);
  // Absent from the store: a stale tab may not know the job yet, so keep the lock.
  assert.equal(lockJobReleased("j1", [{ job_id: "j2", state: "done" }]), false);
  assert.equal(lockJobReleased("j1", []), false);
});

// Issue #607: in the classic editor a single-note or verse-range redraft must
// not put the chapter's other notes into keep-mode. The server refuses PATCH
// only on the notes the redraft covers (translateLockForTnRow); scripture, tq,
// twl and note create/delete stay chapter-locked, so jobLocksChapter is
// unchanged for it.
test("jobLocksChapterNoteCards: a row-scoped tn redraft leaves the chapter's note cards out of the lock", () => {
  const single = redraft({ row_ids: ["n1"] });
  const range = redraft({ verse_start: 2, verse_end: 4 });
  assert.equal(jobLocksChapterNoteCards(single, "ZEC", 1), false);
  assert.equal(jobLocksChapterNoteCards(range, "ZEC", 1), false);
  assert.equal(jobLocksChapter(single, "ZEC", 1), true, "scripture/tq/twl still locked");
});

test("jobLocksChapterNoteCards: every other locking job reaches the note cards, as before", () => {
  assert.equal(jobLocksChapterNoteCards(job(), "ZEC", 1), true, "chapter-wide tn translate");
  assert.equal(jobLocksChapterNoteCards(job(), "ZEC", 0), true, "chapter-wide translate covers the intro");
  assert.equal(jobLocksChapterNoteCards(job({ pipeline_type: "notes", locks_chapter_notes: false }), "ZEC", 1), true);
  // A tq/twl translate has no note_selection: unchanged keep-mode.
  assert.equal(jobLocksChapterNoteCards(job({ locks_chapter_notes: false, note_selection: null }), "ZEC", 1), true);
  // An older server that sends neither field: unchanged.
  assert.equal(jobLocksChapterNoteCards(job({ locks_chapter_notes: undefined }), "ZEC", 1), true);
  // Out of range or not locking: nothing.
  assert.equal(jobLocksChapterNoteCards(job(), "ZEC", 2), false);
  assert.equal(jobLocksChapterNoteCards(job({ state: "queued" }), "ZEC", 1), false);
});
