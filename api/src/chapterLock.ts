// Centralized chapter-lock check. While a pipeline_jobs row is non-terminal
// for a given (book, chapter), the chapter is read-only for mutations on
// tn / tq / twl / verses — the AI run will overwrite anything edited mid-flight
// when it completes. See docs/ai-pipeline-handoff.md (Phase 2c) and the plan
// for the exemption rules (/preserve, /hint, legacy /keep alias; tn PATCH is
// exempt only for non-translate runs — issue #561).

import type { Env } from "./index";
import { coveredVersesFromRef } from "./importParsers.ts";

export interface ActiveLock {
  jobId: string;
  pipelineType: string;
  userId: number;
  startedAt: number; // unix seconds
}

// States that lock the chapter: a run that's actively on the bot (or being
// dispatched to it) will overwrite this chapter when it lands. A 'queued' job
// has NOT started — it doesn't lock, so translators can keep editing a chapter
// whose run is still waiting in line.
const NON_TERMINAL = [
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "dispatching",
] as const;

// SQL twin of isChapterWideTnTranslate / parseTranslateScope (below), over an
// unqualified pipeline_jobs row, and it must agree with them on every input
// (chapterLockTranslate.test.mjs checks a table of odd options): a non-string
// resourceType means 'tn'; only a NON-EMPTY rowIds array is a selection; only
// a NUMERIC verseStart is a selection. json_valid guards the json_* calls,
// which throw on bad JSON; json_type returns NULL for a missing path.
const CHAPTER_WIDE_TN_TRANSLATE_SQL = `pipeline_type = 'translate'
             AND (options_json IS NULL OR NOT json_valid(options_json)
                  OR ((CASE WHEN json_type(options_json, '$.resourceType') = 'text'
                            THEN json_extract(options_json, '$.resourceType') ELSE 'tn' END) = 'tn'
                      AND NOT (COALESCE(json_type(options_json, '$.rowIds'), '') = 'array'
                               AND json_array_length(options_json, '$.rowIds') > 0)
                      AND COALESCE(json_type(options_json, '$.verseStart'), '') NOT IN ('integer', 'real')))`;

// Returns the first non-terminal job covering this (book, chapter), or null
// if the chapter is unlocked. Locks are global — any translator's pipeline
// locks the chapter for everyone, by design.
//
// The book introduction (chapter 0, front:intro) is covered by a chapter-wide
// tn TRANSLATE job that starts at chapter 1: that job translates the intro too
// (the same rule as sliceChapterRows, parseOutputEntry's frontInScope and
// applyTranslateTnRow's `chapter = 0 AND start = 1`), so the intro has to be
// locked with it (issue #561). Other job types never write chapter 0, and a
// row-scoped or verse-ranged redraft writes the intro only when it selected it
// — the tn PATCH check (translateLockForTnRow) handles that per row.
// Unreadable options_json counts as chapter-wide, as in parseTranslateScope.
export async function activePipelineForChapter(
  env: Env,
  book: string,
  chapter: number,
): Promise<ActiveLock | null> {
  const statePlaceholders = NON_TERMINAL.map((_, i) => `?${i + 3}`).join(", ");
  const row = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at
       FROM pipeline_jobs
      WHERE book = ?1
        AND ((start_chapter <= ?2 AND end_chapter >= ?2)
             OR (?2 = 0 AND start_chapter = 1 AND ${CHAPTER_WIDE_TN_TRANSLATE_SQL}))
        AND state IN (${statePlaceholders})
      ORDER BY created_at ASC
      LIMIT 1`,
  )
    .bind(book.toUpperCase(), chapter, ...NON_TERMINAL)
    .first<{
      job_id: string;
      pipeline_type: string;
      user_id: number;
      created_at: number;
    }>();
  if (!row) return null;
  return {
    jobId: row.job_id,
    pipelineType: row.pipeline_type,
    userId: row.user_id,
    startedAt: row.created_at,
  };
}

// What a translate job will write, read from its options_json the same way
// pipelineImport.ts translateSelection does: no rowIds / verseStart means the
// whole chapter range; rowIds means those rows; a verse range means the rows
// whose verses overlap it. resourceType defaults to 'tn' for jobs that predate
// it (same COALESCE as pipelineDedupSql.ts).
export interface TranslateScope {
  resourceType: string;
  rowIds: string[] | null;
  verseStart: number | null;
  verseEnd: number | null;
}

export function parseTranslateScope(optionsJson: string | null | undefined): TranslateScope {
  let o: { resourceType?: unknown; rowIds?: unknown; verseStart?: unknown; verseEnd?: unknown } = {};
  try {
    const parsed: unknown = optionsJson ? JSON.parse(optionsJson) : null;
    if (parsed && typeof parsed === "object") o = parsed;
  } catch {
    /* unreadable options: treat as whole-range, like dispatch does */
  }
  return {
    resourceType: typeof o.resourceType === "string" ? o.resourceType : "tn",
    rowIds: Array.isArray(o.rowIds) && o.rowIds.length ? o.rowIds.map(String) : null,
    verseStart: typeof o.verseStart === "number" ? o.verseStart : null,
    verseEnd: typeof o.verseEnd === "number" ? o.verseEnd : null,
  };
}

// A tn translate with no row or verse selection: it rewrites every note in its
// range. The client uses this (as pipeline_jobs list field
// locks_chapter_notes) to make the whole chapter's notes read-only.
export function isChapterWideTnTranslate(pipelineType: string, optionsJson: string | null | undefined): boolean {
  if (pipelineType !== "translate") return false;
  const s = parseTranslateScope(optionsJson);
  return s.resourceType === "tn" && s.rowIds === null && s.verseStart === null;
}

// The notes a row-scoped or verse-ranged tn translate will write, for the
// pipeline_jobs list field note_selection (issue #606): the client disables
// just those notes' buttons up front. Null for every other job — a chapter-wide
// run is locks_chapter_notes, and a tq/twl run never writes notes. Only the
// selection leaves the server, never the rest of options_json (hints live there).
export interface NoteSelection {
  row_ids: string[] | null;
  verse_start: number | null;
  verse_end: number | null;
}

export function translateNoteSelection(
  pipelineType: string,
  optionsJson: string | null | undefined,
): NoteSelection | null {
  if (pipelineType !== "translate") return null;
  const s = parseTranslateScope(optionsJson);
  if (s.resourceType !== "tn" || (s.rowIds === null && s.verseStart === null)) return null;
  return { row_ids: s.rowIds, verse_start: s.verseStart, verse_end: s.verseEnd };
}

// True when a translate job with this scope will write over this tn row on
// apply. A chapter-wide run covers every row in its range (the book intro
// included when the range starts at chapter 1 — the caller's query handles
// that); a row-scoped or verse-ranged redraft covers only its own rows, so a
// "re-run AI on this note" does not block editing the other notes (#300). The
// book intro is never in a verse range (selectRows' refVerseRange is null for
// front:intro).
export function translateRunCoversTnRow(
  scope: TranslateScope,
  row: { id: string; chapter: number; verse: number; ref_raw: string | null },
): boolean {
  if (scope.resourceType !== "tn") return false;
  if (scope.rowIds && !scope.rowIds.includes(row.id)) return false;
  if (scope.verseStart != null) {
    if (row.chapter === 0) return false;
    const start = scope.verseStart;
    const end = scope.verseEnd ?? start;
    return coveredVersesFromRef(row.ref_raw, row.verse).some((v) => v >= start && v <= end);
  }
  return true;
}

// The in-flight translate job, if any, that will overwrite this tn row when it
// applies (issue #561, decision B). Checks every such job, not just the oldest:
// a chapter-wide run and a row-scoped redraft can be in flight together.
export async function translateLockForTnRow(
  env: Env,
  book: string,
  row: { id: string; chapter: number; verse: number; ref_raw: string | null },
): Promise<ActiveLock | null> {
  const statePlaceholders = NON_TERMINAL.map((_, i) => `?${i + 3}`).join(", ");
  const res = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at, options_json
       FROM pipeline_jobs
      WHERE book = ?1
        AND pipeline_type = 'translate'
        AND ((start_chapter <= ?2 AND end_chapter >= ?2) OR (?2 = 0 AND start_chapter = 1))
        AND state IN (${statePlaceholders})
      ORDER BY created_at ASC`,
  )
    .bind(book.toUpperCase(), row.chapter, ...NON_TERMINAL)
    .all<{
      job_id: string;
      pipeline_type: string;
      user_id: number;
      created_at: number;
      options_json: string | null;
    }>();
  for (const j of res.results ?? []) {
    if (!translateRunCoversTnRow(parseTranslateScope(j.options_json), row)) continue;
    return { jobId: j.job_id, pipelineType: j.pipeline_type, userId: j.user_id, startedAt: j.created_at };
  }
  return null;
}

// translateLockForTnRow over many rows of one book with a single job query —
// the admin review-state sweep checks a whole chapter range at once (#602).
// Same coverage rule: the job's chapter range, plus the book intro for a job
// starting at chapter 1, then translateRunCoversTnRow for its selection.
export async function translateLockForTnRows(
  env: Env,
  book: string,
  rows: Array<{ id: string; chapter: number; verse: number; ref_raw: string | null }>,
): Promise<ActiveLock | null> {
  if (rows.length === 0) return null;
  const statePlaceholders = NON_TERMINAL.map((_, i) => `?${i + 2}`).join(", ");
  const res = await env.DB.prepare(
    `SELECT job_id, pipeline_type, user_id, created_at, start_chapter, end_chapter, options_json
       FROM pipeline_jobs
      WHERE book = ?1 AND pipeline_type = 'translate' AND state IN (${statePlaceholders})
      ORDER BY created_at ASC`,
  )
    .bind(book.toUpperCase(), ...NON_TERMINAL)
    .all<{
      job_id: string;
      pipeline_type: string;
      user_id: number;
      created_at: number;
      start_chapter: number;
      end_chapter: number;
      options_json: string | null;
    }>();
  for (const j of res.results ?? []) {
    const scope = parseTranslateScope(j.options_json);
    const hit = rows.some(
      (r) =>
        ((j.start_chapter <= r.chapter && j.end_chapter >= r.chapter) || (r.chapter === 0 && j.start_chapter === 1)) &&
        translateRunCoversTnRow(scope, r),
    );
    if (hit) return { jobId: j.job_id, pipelineType: j.pipeline_type, userId: j.user_id, startedAt: j.created_at };
  }
  return null;
}

// Shape of the 409 body when a write is rejected due to an active lock.
// The client uses this to render "AI run in progress (started X min ago)"
// without a second request.
export interface ChapterLockedError {
  error: "chapter_locked";
  jobId: string;
  pipelineType: string;
  startedAt: number;
}

export function lockedResponseBody(lock: ActiveLock): ChapterLockedError {
  return {
    error: "chapter_locked",
    jobId: lock.jobId,
    pipelineType: lock.pipelineType,
    startedAt: lock.startedAt,
  };
}
