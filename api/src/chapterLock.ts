// Centralized chapter-lock check. While a pipeline_jobs row is non-terminal
// for a given (book, chapter), the chapter is read-only for mutations on
// tn / tq / twl / verses — the AI run will overwrite anything edited mid-flight
// when it completes. See docs/ai-pipeline-handoff.md (Phase 2c) and the plan
// for the exemption rules (/preserve, /hint, legacy /keep alias; tn PATCH is
// exempt only for non-translate runs — issue #561).

import type { Env } from "./index";

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
