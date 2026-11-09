// Per-chapter AI draft quality scorecard (issue #816). Read-only.
//
// GET /api/books/:book/draft-scorecard (admin only, wired in bookImport.ts)
// answers, for each chapter of one book: of the translation notes a person has
// approved (tn_rows.translation_state = 'validated'), how close was the AI
// draft to what was approved, and which context pack the draft was made with.
// It is the measuring stick for the translate learning loop: without it nobody
// can tell whether a guidance change makes drafts better.
//
// Definitions (the exact rules; the admin page explains them in plain words):
//
//   draft      the note in the payload of the row's LATEST edit_log entry with
//              source 'ai_pipeline' (kind 'tn', action create/update). That is
//              what the translate apply wrote (pipelineImport.ts,
//              applyTranslateTnRow). No such entry, or one whose payload has
//              no string note → "no draft logged". The prod cron prunes
//              edit_log after 180 days, so old chapters lose their drafts;
//              they are counted, never treated as unchanged.
//   final      the row's current note.
//   English    the draft equals (both trimmed, non-empty) the row's English
//   source     source note, read by id from the project's English tN on Door43
//              exactly as the chat tools and the Source panel read it
//              (readBookSourceNotes, sourceNotes.ts — the English is not
//              stored in D1). Such a row is a run that applied untranslated
//              text; it is excluded from every metric and counted on its own.
//              A note that is legitimately identical to the English (links
//              only) is excluded the same way. When the English could not be
//              read for a chapter, nothing in it is excluded and the chapter
//              says so (englishCheck "none"; the total says "some" when only
//              part of the book was checked).
//   compared   validated − no draft logged − English source.
//   unchanged  final === draft, exactly. Share = unchanged / compared.
//   similarity 1 − levenshtein(draft, final) / max(length), counted in Unicode
//              code points; two empty strings are 1. Median over compared rows.
//              Exact for normal notes. CPU is bounded (similarity()): after the
//              shared prefix/suffix is stripped, a middle longer than
//              SIMILARITY_SEGMENT_CAP is scored on its first CAP code points
//              and scaled, and once the request has spent
//              SIMILARITY_CELL_BUDGET DP cells the remaining rows use a cheap
//              character-count bound. Both are approximate (counted in
//              approximateSimilarity).
//   closing    eligible: the draft, trailing whitespace trimmed, ends with "]"
//   period     (so there is no period after it). Made: the final, trimmed the
//              same way, ends with "].". Share = made / eligible.
//   context    the contextRef ("org/repo@sha") in the options_json of the
//   pack       translate job that wrote the draft. Neither the edit_log row nor
//              its payload records the job id, so the job is inferred. The
//              candidates are tN translate jobs for the book that cover the
//              row's chapter (chapter 0 rides with a job starting at 1), were
//              enqueued before the draft (edit_log id > the job's
//              edit_log_watermark; created_at when the job has no watermark),
//              and had not finished before it (drafted_at <= updated_at). The
//              applying job stamps updated_at right after its apply, so the
//              writer is the candidate whose updated_at is EARLIEST; ties go to
//              the latest created_at. This is a time match, not a stored link:
//              rare overlapping runs (a failed writer whose updated_at a later
//              status read re-stamped; a parent and child in the same second)
//              can be credited to the wrong run. A job with no contextRef (no
//              successful export yet, or a chain/follow-up child) still ran,
//              on the unpinned latest pack if one existed
//              (translate/params.ts); the page says "not pinned". The prod
//              cron deletes done jobs after 7 days, so older drafts count as
//              "run no longer on record" (untracedDrafts) rather than a guess.
//
// Bounded: one book per request. Two D1 reads of our own (rows with their
// draft, the book's translate jobs), then readBookSourceNotes: one config and
// override lookup, and at most one Door43 read per distinct source repo, all
// concurrent (cached per isolate), so a hanging Door43 costs one timeout. No
// new tables, no writes.

import type { Context } from "hono";
import type { Env } from "./index";
import { BOOK_NUMBERS } from "./dcsSources.ts";
import { readBookSourceNotes } from "./sourceNotes.ts";

// ── Data shapes ─────────────────────────────────────────────────────────────

/** One validated tN row with its latest logged AI draft (null fields when none). */
export interface ScorecardRow {
  id: string;
  chapter: number;
  finalNote: string | null;
  draftLogId: number | null;
  draftedAt: number | null;
  draftNote: string | null;
}

/** One translate job for the book, as far as attribution needs it. */
export interface ScorecardJob {
  jobId: string;
  startChapter: number;
  endChapter: number;
  createdAt: number;
  updatedAt: number;
  editLogWatermark: number | null;
  contextRef: string | null;
  resourceType: string | null;
}

/** A context pack the chapter's compared drafts were made with. ref null = the run was not pinned (latest pack at run time, if any). */
export interface ContextPackCount {
  ref: string | null;
  count: number;
}

export interface ScorecardChapter {
  /** null on the book total. */
  chapter: number | null;
  validated: number;
  noDraft: number;
  englishSource: number;
  compared: number;
  unchanged: number;
  /** 0–100, null when nothing was compared. */
  unchangedPct: number | null;
  /** 0–1, null when nothing was compared. */
  medianSimilarity: number | null;
  /** Compared rows whose similarity is approximate (see similarity()). */
  approximateSimilarity: number;
  closingPeriod: { eligible: number; made: number };
  contextPacks: ContextPackCount[];
  /** Compared drafts whose translate job is no longer on record. */
  untracedDrafts: number;
  /**
   * Whether drafts were checked against the English source: "all", "none"
   * (the English could not be read, so no row was excluded as English), or,
   * on the book total only, "some" (part of the book was checked).
   */
  englishCheck: EnglishCheck;
}

export type EnglishCheck = "all" | "some" | "none";

export interface DraftScorecardResponse {
  book: string;
  chapters: ScorecardChapter[];
  total: ScorecardChapter;
  /** Chapters whose English source could not be read (ascending). */
  englishUncheckedChapters: number[];
  /** Each distinct reason the English source could not be read, with its chapters (ascending). */
  englishProblems: { reason: string; chapters: number[] }[];
}

// ── Pure metrics ────────────────────────────────────────────────────────────

/** Longest middle segment (after the shared prefix/suffix strip) scored exactly. */
export const SIMILARITY_SEGMENT_CAP = 2_000;
/**
 * DP cells one request may spend on similarity. ~100M cells/s in V8 here, so
 * this keeps a 3,000-row book to roughly a second of CPU; normal notes use a
 * few thousand cells each, so only a book full of long rewrites reaches it.
 */
export const SIMILARITY_CELL_BUDGET = 100_000_000;

/** Remaining DP cells for one request; similarity() spends from it. */
export interface CellBudget {
  cells: number;
}

// Levenshtein distance of x[xs, xe) and y[ys, ye), two-row DP.
function levenshtein(x: string[], xs: number, xe: number, y: string[], ys: number, ye: number): number {
  const n = xe - xs;
  const m = ye - ys;
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const xi = x[xs + i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (xi === y[ys + j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[m];
}

/**
 * 1 − levenshtein(a, b) / max(len) over Unicode code points, with bounded
 * CPU. Equal strings short-circuit; the shared prefix and suffix are stripped
 * first, so a small edit in a long note stays cheap. Then:
 *   - both middles ≤ SIMILARITY_SEGMENT_CAP and the budget covers n×m cells:
 *     exact;
 *   - otherwise, if the budget covers the capped segments (the first CAP code
 *     points of each middle): their edit rate, scaled to the full middle and
 *     clamped to the true bounds [|n−m|, max(n, m)] — approximate;
 *   - otherwise a cheap O(n+m) bound: max(n, m) minus the characters the two
 *     middles share (a lower bound on the distance) — approximate.
 */
export function similarity(
  a: string,
  b: string,
  budget: CellBudget = { cells: Infinity },
): { value: number; approximate: boolean } {
  if (a === b) return { value: 1, approximate: false };
  const x = Array.from(a);
  const y = Array.from(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return { value: 1, approximate: false };
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const n = endX - start;
  const m = endY - start;
  if (n === 0 || m === 0) return { value: 1 - Math.max(n, m) / longest, approximate: false };

  if (n <= SIMILARITY_SEGMENT_CAP && m <= SIMILARITY_SEGMENT_CAP && n * m <= budget.cells) {
    budget.cells -= n * m;
    return { value: 1 - levenshtein(x, start, endX, y, start, endY) / longest, approximate: false };
  }

  const cn = Math.min(n, SIMILARITY_SEGMENT_CAP);
  const cm = Math.min(m, SIMILARITY_SEGMENT_CAP);
  let distance: number;
  if (cn * cm <= budget.cells) {
    budget.cells -= cn * cm;
    const rate = levenshtein(x, start, start + cn, y, start, start + cm) / Math.max(cn, cm);
    distance = Math.min(Math.max(rate * Math.max(n, m), Math.abs(n - m)), Math.max(n, m));
  } else {
    const counts = new Map<string, number>();
    for (let i = start; i < endX; i++) counts.set(x[i], (counts.get(x[i]) ?? 0) + 1);
    let shared = 0;
    for (let j = start; j < endY; j++) {
      const c = counts.get(y[j]) ?? 0;
      if (c > 0) {
        shared++;
        counts.set(y[j], c - 1);
      }
    }
    distance = Math.max(n, m) - shared;
  }
  return { value: 1 - distance / longest, approximate: true };
}

/** similarity() without a request budget; a middle over the segment cap is still approximate. */
export function editSimilarity(a: string, b: string): number {
  return similarity(a, b).value;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((p, q) => p - q);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type ClosingPeriodOutcome = "ineligible" | "made" | "not_made";

/** The one tracked correction so far: a closing period after a final "]". */
export function closingPeriodOutcome(draft: string, final: string): ClosingPeriodOutcome {
  if (!draft.trimEnd().endsWith("]")) return "ineligible";
  return final.trimEnd().endsWith("].") ? "made" : "not_made";
}

/** The logged draft is the English source note (a run that applied untranslated text). */
export function isEnglishSourceDraft(draft: string, english: string | undefined): boolean {
  if (english == null) return false;
  const e = english.trim();
  return e !== "" && draft.trim() === e;
}

/**
 * The translate job that wrote a draft, or null when none on record fits.
 * Among the jobs whose window brackets the draft, the writer is the one that
 * finished first after it (earliest updated_at): a job queued meanwhile, or a
 * chain child carrying its parent's older watermark, finishes later.
 */
export function matchDraftJob(
  draft: { chapter: number; draftLogId: number; draftedAt: number },
  jobs: ScorecardJob[],
): ScorecardJob | null {
  let best: ScorecardJob | null = null;
  for (const j of jobs) {
    if (j.resourceType != null && j.resourceType !== "tn") continue;
    const covers =
      (draft.chapter >= j.startChapter && draft.chapter <= j.endChapter) ||
      (draft.chapter === 0 && j.startChapter === 1);
    if (!covers) continue;
    const enqueuedBefore =
      j.editLogWatermark != null ? draft.draftLogId > j.editLogWatermark : j.createdAt <= draft.draftedAt;
    if (!enqueuedBefore || draft.draftedAt > j.updatedAt) continue;
    if (
      !best ||
      j.updatedAt < best.updatedAt ||
      (j.updatedAt === best.updatedAt &&
        (j.createdAt > best.createdAt ||
          (j.createdAt === best.createdAt && (j.editLogWatermark ?? -1) > (best.editLogWatermark ?? -1))))
    ) {
      best = j;
    }
  }
  return best;
}

interface Tally {
  validated: number;
  noDraft: number;
  englishSource: number;
  unchanged: number;
  similarities: number[];
  approximate: number;
  eligible: number;
  made: number;
  packs: Map<string | null, number>;
  untraced: number;
  englishCheck: EnglishCheck;
}

const emptyTally = (): Tally => ({
  validated: 0,
  noDraft: 0,
  englishSource: 0,
  unchanged: 0,
  similarities: [],
  approximate: 0,
  eligible: 0,
  made: 0,
  packs: new Map(),
  untraced: 0,
  englishCheck: "all",
});

function finish(chapter: number | null, t: Tally): ScorecardChapter {
  const compared = t.similarities.length;
  return {
    chapter,
    validated: t.validated,
    noDraft: t.noDraft,
    englishSource: t.englishSource,
    compared,
    unchanged: t.unchanged,
    unchangedPct: compared ? (t.unchanged / compared) * 100 : null,
    medianSimilarity: median(t.similarities),
    approximateSimilarity: t.approximate,
    closingPeriod: { eligible: t.eligible, made: t.made },
    contextPacks: [...t.packs]
      .map(([ref, count]) => ({ ref, count }))
      .sort((p, q) => q.count - p.count || String(p.ref).localeCompare(String(q.ref))),
    untracedDrafts: t.untraced,
    englishCheck: t.englishCheck,
  };
}

/**
 * Roll rows up per chapter and for the whole book. `englishByChapter` maps a
 * chapter to its English source notes by row id; a chapter missing from it
 * had no readable English source, so none of its rows is excluded as English.
 */
export function buildScorecard(
  rows: ScorecardRow[],
  jobs: ScorecardJob[],
  englishByChapter: Map<number, Map<string, string>>,
  budget: CellBudget = { cells: SIMILARITY_CELL_BUDGET },
): { chapters: ScorecardChapter[]; total: ScorecardChapter } {
  const byChapter = new Map<number, Tally>();
  const total = emptyTally();
  for (const r of rows) {
    let t = byChapter.get(r.chapter);
    if (!t) {
      t = emptyTally();
      t.englishCheck = englishByChapter.has(r.chapter) ? "all" : "none";
      byChapter.set(r.chapter, t);
    }
    for (const s of [t, total]) s.validated++;
    // An audit row whose payload carries no string note is not a usable draft.
    if (r.draftLogId == null || r.draftNote == null) {
      for (const s of [t, total]) s.noDraft++;
      continue;
    }
    const draft = r.draftNote;
    const final = r.finalNote ?? "";
    if (isEnglishSourceDraft(draft, englishByChapter.get(r.chapter)?.get(r.id))) {
      for (const s of [t, total]) s.englishSource++;
      continue;
    }
    const sim = similarity(draft, final, budget);
    const outcome = closingPeriodOutcome(draft, final);
    const job = matchDraftJob({ chapter: r.chapter, draftLogId: r.draftLogId, draftedAt: r.draftedAt ?? 0 }, jobs);
    for (const s of [t, total]) {
      s.similarities.push(sim.value);
      if (sim.approximate) s.approximate++;
      if (draft === final) s.unchanged++;
      if (outcome !== "ineligible") s.eligible++;
      if (outcome === "made") s.made++;
      if (job) s.packs.set(job.contextRef, (s.packs.get(job.contextRef) ?? 0) + 1);
      else s.untraced++;
    }
  }
  const tallies = [...byChapter.values()];
  const unchecked = tallies.filter((t) => t.englishCheck === "none").length;
  total.englishCheck = unchecked === 0 ? "all" : unchecked === tallies.length ? "none" : "some";
  const chapters = [...byChapter.entries()].sort(([p], [q]) => p - q).map(([ch, t]) => finish(ch, t));
  return { chapters, total: finish(null, total) };
}

// ── D1 loader ───────────────────────────────────────────────────────────────

// The latest ai_pipeline audit row per validated, live tN row of the book.
// Book-scoped on edit_log.book. A pre-0017 audit row has a NULL book, so it is
// accepted only when the row has no book-matched one: `e.book IS NULL` sorts
// after 0 (book-matched) first, so another book's NULL-book row for a shared
// id can never outrank this book's own draft. The (kind, row_key) index keeps
// the correlated subquery cheap.
export const SCORECARD_ROWS_SQL = `
  SELECT t.id AS id, t.chapter AS chapter, t.note AS final_note,
         d.id AS draft_log_id, d.created_at AS drafted_at,
         CASE WHEN json_valid(d.payload_json) THEN json_extract(d.payload_json, '$.note') END AS draft_note
    FROM tn_rows t
    LEFT JOIN edit_log d ON d.id = (
      SELECT e.id FROM edit_log e
       WHERE e.kind = 'tn' AND e.row_key = t.id
         AND (e.book = t.book OR e.book IS NULL)
         AND e.source = 'ai_pipeline' AND e.action IN ('create', 'update')
       ORDER BY (e.book IS NULL), e.id DESC LIMIT 1
    )
   WHERE t.book = ?1 AND t.deleted_at IS NULL AND t.trashed_at IS NULL
     AND t.translation_state = 'validated'
   ORDER BY t.chapter, t.id`;

export const SCORECARD_JOBS_SQL = `
  SELECT job_id, start_chapter, end_chapter, created_at, updated_at, edit_log_watermark,
         CASE WHEN json_valid(options_json) THEN json_extract(options_json, '$.contextRef') END AS context_ref,
         CASE WHEN json_valid(options_json) THEN json_extract(options_json, '$.resourceType') END AS resource_type
    FROM pipeline_jobs
   WHERE book = ?1 AND pipeline_type = 'translate'`;

type Db = Pick<D1Database, "prepare">;

export async function loadScorecardInputs(db: Db, book: string): Promise<{ rows: ScorecardRow[]; jobs: ScorecardJob[] }> {
  const [rowRes, jobRes] = await Promise.all([
    db.prepare(SCORECARD_ROWS_SQL).bind(book).all<{
      id: string;
      chapter: number;
      final_note: string | null;
      draft_log_id: number | null;
      drafted_at: number | null;
      draft_note: unknown;
    }>(),
    db.prepare(SCORECARD_JOBS_SQL).bind(book).all<{
      job_id: string;
      start_chapter: number;
      end_chapter: number;
      created_at: number;
      updated_at: number;
      edit_log_watermark: number | null;
      context_ref: unknown;
      resource_type: unknown;
    }>(),
  ]);
  const rows = (rowRes.results ?? []).map((r) => ({
    id: r.id,
    chapter: r.chapter,
    finalNote: r.final_note,
    draftLogId: r.draft_log_id,
    draftedAt: r.drafted_at,
    draftNote: typeof r.draft_note === "string" ? r.draft_note : null,
  }));
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const jobs = (jobRes.results ?? []).map((j) => ({
    jobId: j.job_id,
    startChapter: j.start_chapter,
    endChapter: j.end_chapter,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    editLogWatermark: j.edit_log_watermark,
    contextRef: str(j.context_ref),
    resourceType: str(j.resource_type),
  }));
  return { rows, jobs };
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function draftScorecard(c: Context<{ Bindings: Env }>) {
  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const { rows, jobs } = await loadScorecardInputs(c.env.DB, book);

  // The English source, for the chapters that have a draft to compare: at most
  // one Door43 read per distinct source repo, all concurrent (sourceNotes.ts).
  // A failed source leaves its chapters unchecked rather than failing the
  // scorecard, and is not retried.
  const englishByChapter = new Map<number, Map<string, string>>();
  const problems = new Map<string, number[]>();
  const draftedChapters = new Set(rows.filter((r) => r.draftLogId != null && r.draftNote != null).map((r) => r.chapter));
  const sources = await readBookSourceNotes(c.env, book, [...draftedChapters]);
  for (const [ch, src] of sources) {
    if (src.ok) englishByChapter.set(ch, src.notes);
    else problems.set(src.reason, [...(problems.get(src.reason) ?? []), ch]);
  }
  const englishProblems = [...problems]
    .map(([reason, chs]) => ({ reason, chapters: chs.sort((p, q) => p - q) }))
    .sort((p, q) => p.chapters[0] - q.chapters[0]);
  // A chapter with no draft at all has nothing to exclude, so it is not "unchecked".
  for (const r of rows) if (!draftedChapters.has(r.chapter)) englishByChapter.set(r.chapter, new Map());

  const { chapters, total } = buildScorecard(rows, jobs, englishByChapter);
  const englishUncheckedChapters = chapters
    .filter((s) => s.englishCheck === "none")
    .map((s) => s.chapter as number);
  const body: DraftScorecardResponse = { book, chapters, total, englishUncheckedChapters, englishProblems };
  return c.json(body);
}
