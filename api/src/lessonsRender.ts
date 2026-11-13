// Lessons from editor corrections (issue #817): the stored set and how it is
// rendered into the context pack's instructions.md. A leaf module (no Hono, no
// provider code) so the pure context-pack renderer and its loader can use it.
// The nightly job that writes the set lives in lessons.ts.

// The subset of D1 these reads use (tests pass a node:sqlite wrapper).
type Db = {
  prepare(sql: string): {
    bind(...args: unknown[]): { all<T>(): Promise<{ results?: T[] }> };
    first<T>(): Promise<T | null>;
  };
};

// A missing table OR column: a database a migration behind (0085 without 0086,
// 0087 or 0088) reads as not migrated, not as a failure (#908 leftover 6).
export const tableMissing = (e: unknown) => /no such (?:table|column)/i.test(e instanceof Error ? e.message : String(e));

export const LESSONS_HEADING = "## Lessons from recent editor corrections";

export type Lesson = {
  lesson: string;
  /** The AI draft's words (may be empty). */
  before: string;
  /** The editor's words (may be empty for a deletion). */
  after: string;
  /** Notes the correction was seen in, as the model counted it. */
  evidence: number;
  /** When this lesson first appeared (unix seconds). */
  firstSeenAt: number;
  /** Pinned by an admin (#908): every nightly merge keeps it as it is. */
  pinned: boolean;
};

/** The switch. No row, or a missing table (unmigrated workspace), reads as off. */
export async function lessonsEnabled(db: Db): Promise<boolean> {
  try {
    const r = await db.prepare(`SELECT enabled FROM lesson_settings WHERE id = 1`).first<{ enabled: number }>();
    return r?.enabled === 1;
  } catch (e) {
    if (tableMissing(e)) return false;
    throw e;
  }
}

type LessonRow = {
  lesson: string;
  example_before: string;
  example_after: string;
  evidence: number;
  first_seen_at: number;
  pinned: number;
};

/**
 * Statuses whose lesson_runs row holds a lesson set: a night's successful run
 * ('ok') and an admin's change ('edited', #908). The newest one is current.
 */
export const SET_STATUSES_SQL = `('ok', 'edited')`;

/** One stored set's lessons, in order. */
export async function loadLessonSet(db: Db, runId: number): Promise<Lesson[]> {
  const rs = await db
    .prepare(
      `SELECT lesson, example_before, example_after, evidence, first_seen_at, pinned
         FROM lessons WHERE run_id = ?1 ORDER BY position`,
    )
    .bind(runId)
    .all<LessonRow>();
  return (rs.results ?? []).map((r) => ({
    lesson: r.lesson,
    before: r.example_before,
    after: r.example_after,
    evidence: r.evidence,
    firstSeenAt: r.first_seen_at,
    pinned: r.pinned === 1,
  }));
}

/**
 * The current set: the newest night's successful run or admin change (empty
 * when none). runId is that set's lesson_runs id. Missing tables read as empty.
 */
export async function loadCurrentLessons(db: Db): Promise<{ runId: number | null; setAt: number | null; lessons: Lesson[] }> {
  try {
    const run = await db
      .prepare(`SELECT id, finished_at FROM lesson_runs WHERE status IN ${SET_STATUSES_SQL} ORDER BY id DESC LIMIT 1`)
      .first<{ id: number; finished_at: number | null }>();
    if (!run) return { runId: null, setAt: null, lessons: [] };
    return { runId: run.id, setAt: run.finished_at, lessons: await loadLessonSet(db, run.id) };
  } catch (e) {
    if (tableMissing(e)) return { runId: null, setAt: null, lessons: [] };
    throw e;
  }
}

/** What the context pack renders: the current set when the switch is on, else nothing. */
export async function loadLessonsForRender(db: Db): Promise<Lesson[]> {
  if (!(await lessonsEnabled(db))) return [];
  return (await loadCurrentLessons(db)).lessons;
}

export function lessonLine(l: Lesson): string {
  let line = `- ${l.lesson}`;
  if (l.before || l.after) line += ` Example: «${l.before}» → «${l.after || "∅"}»`;
  if (l.evidence > 0) line += ` (seen in ${l.evidence} notes)`;
  return line;
}

/** The third instructions.md section, or null when there is nothing to say. */
export function renderLessonsSection(lessons: readonly Lesson[]): string | null {
  if (lessons.length === 0) return null;
  return [
    LESSONS_HEADING,
    "",
    "Written automatically each night from what editors changed in recent AI drafts before approving them.",
    "",
    ...lessons.map(lessonLine),
  ].join("\n");
}
