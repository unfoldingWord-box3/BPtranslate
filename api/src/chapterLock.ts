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

// Returns the first non-terminal job covering this (book, chapter), or null
// if the chapter is unlocked. Locks are global — any translator's pipeline
// locks the chapter for everyone, by design.
//
// The book introduction (chapter 0, front:intro) is covered by a TRANSLATE job
// that starts at chapter 1: that job translates the intro too (the same rule
// as sliceChapterRows, parseOutputEntry's frontInScope and
// applyTranslateTnRow's `chapter = 0 AND start = 1`), so the intro has to be
// locked with it (issue #561). Other job types never write chapter 0.
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
             OR (?2 = 0 AND start_chapter = 1 AND pipeline_type = 'translate'))
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
