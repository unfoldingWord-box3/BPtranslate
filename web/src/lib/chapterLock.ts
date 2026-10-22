// Client mirror of api/src/chapterLock.ts: which active pipeline job locks a
// (book, chapter), and what that lock means for a note card. The server is the
// source of truth (a locked write gets 409 chapter_locked); this only lets the
// UI show the banner and read-only editors up front instead of after a save is
// refused.

// States that lock a chapter — the same list as NON_TERMINAL on the server.
// A 'queued' job has not started and locks nothing.
const LOCKING_STATES = new Set(["running", "paused_for_outage", "paused_for_usage_limit", "dispatching"]);

export interface LockJobLike {
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: string;
  pipeline_type: string;
  // From GET /api/pipelines: a tn translate with no row or verse selection,
  // which rewrites every note in its chapters (issue #561).
  locks_chapter_notes?: boolean;
}

// True when `job` locks (book, chapter). The book introduction (chapter 0) is
// covered by a chapter-wide tn translate that starts at chapter 1, because
// that run translates the intro too (issue #561).
export function jobLocksChapter(job: LockJobLike, book: string, chapter: number): boolean {
  if (job.book !== book || !LOCKING_STATES.has(job.state)) return false;
  if (job.start_chapter <= chapter && job.end_chapter >= chapter) return true;
  return chapter === 0 && job.start_chapter === 1 && isChapterWideNotesTranslate(job);
}

// True when `job` makes every note in (book, chapter) read-only: a chapter-wide
// tn translate run covering it. A single-note or verse-range redraft locks only
// its own notes on the server and is not reported here.
export function jobLocksChapterNotes(job: LockJobLike, book: string, chapter: number): boolean {
  return isChapterWideNotesTranslate(job) && jobLocksChapter(job, book, chapter);
}

function isChapterWideNotesTranslate(job: LockJobLike): boolean {
  return job.pipeline_type === "translate" && job.locks_chapter_notes === true;
}

// Whether a note card is read-only because of a chapter lock. A translate run
// overwrites every note it covers regardless of keep/hint, so all of them are
// read-only during one. Other runs leave kept (preserve) and hint notes
// editable, as before.
export function noteLockedReadOnly(
  lockPipelineType: string | null | undefined,
  locked: boolean,
  isPreserved: boolean,
  isHint: boolean,
): boolean {
  if (!locked) return false;
  if (lockPipelineType === "translate") return true;
  return !isPreserved && !isHint;
}
