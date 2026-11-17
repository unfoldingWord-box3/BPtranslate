// Shared SQL fragments for the /api/pipelines/start conflict queries.
//
// These clauses live here — not inline in the Hono route — because
// `api/src/pipelineRowScopeDedup.test.mjs` proves their behaviour against an
// in-memory node:sqlite DB, and it used to do that by hand-copying the WHERE
// clause out of pipelines.ts. That copy could (and did, per the #356 review)
// drift from the real query, so the test would keep passing while the route
// changed underneath it. Both sides now import the same strings; a change to
// the clause is a change to what the test exercises.
//
// Parameter numbering is part of the contract — every consumer must bind in the
// documented order.

// The job states that count as "still in flight" for conflict purposes.
// Deliberately NARROWER than pipelines.ts' NON_TERMINAL_STATES, which also
// includes 'failed': a failed job is not going to write anything, so it must not
// block a fresh request.
export const PIPELINE_ACTIVE_STATES_SQL =
  "('queued', 'dispatching', 'running', 'paused_for_outage', 'paused_for_usage_limit')";

// EXACT-IDENTITY dedupe (#316 rowIds, #347 item 2 verse range).
// Two requests collide only when their full scope identity matches:
// book + chapter range + pipeline type + resourceType + row scope + verse range.
//
// Binding order:
//   ?1 book              ?2 startChapter        ?3 endChapter
//   ?4 pipelineType      ?5 resourceType|null   ?6 rowScope|null ('ALL' sentinel
//                                                  or JSON.stringify(normalizeRowIds(...)))
//   ?7 verseStart|null (0 sentinel)             ?8 verseEnd|null (0 sentinel)
// Non-translate jobs bind null for ?5-?8 → those clauses go vacuously true.
export const PIPELINE_DEDUP_WHERE = `j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
        AND j.pipeline_type = ?4
        AND (?5 IS NULL OR COALESCE(json_extract(j.options_json, '$.resourceType'), 'tn') = ?5)
        AND (?6 IS NULL OR COALESCE(json_extract(j.options_json, '$.rowIds'), 'ALL') = ?6)
        AND (?7 IS NULL OR COALESCE(json_extract(j.options_json, '$.verseStart'), 0) = ?7)
        AND (?8 IS NULL OR COALESCE(json_extract(j.options_json, '$.verseEnd'), 0) = ?8)
        AND j.state IN ${PIPELINE_ACTIVE_STATES_SQL}`;

// COVERAGE conflict (#347 item 1, decided 2026-08-27: "broader blocks narrower").
// Finds an in-flight TRANSLATE job whose scope strictly CONTAINS the incoming
// narrower request, so the request can be answered with the running job's id
// instead of spawning a second job that redrafts rows the running one already
// covers.
//
// Direction is one-way by construction: the caller only runs this query when the
// incoming request is itself narrower (row-scoped or verse-ranged). A
// chapter-wide request while a row-scoped job runs is untouched — it proceeds as
// it always has.
//
// Two covering shapes:
//   (a) chapter-wide job — no $.rowIds AND no verse range. Covers every narrower
//       request in the same book/chapter/resource.
//   (b) covering verse-range job — no $.rowIds, and its [verseStart, verseEnd]
//       contains the request's [?5, ?6]. A job that stored verseEnd only (no
//       verseStart) matches NEITHER shape: its extent is unknown, so it is
//       treated as non-covering rather than falsely blocking.
//
// A ROW-SCOPED request carries no verse numbers of its own, so this clause alone
// (bound with the 0 sentinel) only catches it under shape (a). Shape (b) for a
// row-scoped request (#745) runs this same clause a second time, bound with the
// rows' verse span — see needsRowVerseLookup / PIPELINE_VERSE_RANGE_JOB_WHERE /
// rowVerseLookupSql / rowVerseSpan below. The rule is unchanged: the span
// [min verse, max verse] must be CONTAINED in the job's range, so rows on
// verses 3 and 5 against a 2-4 job proceed, exactly like the verse-range request
// 8-10 against a 6-8 job.
//
// Deliberate GAPS — each UNDER-blocks (the request proceeds as it does today:
// duplicate work, serialized upstream, last apply wins, no corruption), which is
// the safe side to err on:
//   1. Row-scoped coverage by a verse-range job is decided on each row's leading
//      `verse` column, not its full ref. A note on "1:1-3" has verse 1, so a 2-4
//      job (which will touch it on apply — see translateRunCoversTnRow) does not
//      block it. Never over-blocks: a row's leading verse is always one of the
//      verses it covers. Also not caught: a request naming any row id the lookup
//      can't find in that book/chapter (unknown, soft-deleted), and a multi-
//      chapter row-scoped request; both leave the extent unknown.
//   2. Chapter scope is matched by EQUALITY (?2/?3), not containment, so a
//      multi-chapter job (e.g. a book-wide MRK 1-16 run) does not cover a
//      narrower request scoped to MRK 5. That mirrors the exact-identity clause's
//      long-standing chapter handling; widening it to `start_chapter <= … AND
//      end_chapter >= …` is a separate decision, since it would also start
//      blocking whole-chapter requests inside a book-wide run.
//
// Binding order:
//   ?1 book   ?2 startChapter   ?3 endChapter   ?4 resourceType ('tn' default)
//   ?5 request verseStart (0 when the request has no verse range)
//   ?6 request verseEnd   (never less than ?5 — see coverageVerseRange)
export const PIPELINE_COVERAGE_WHERE = `j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
        AND j.pipeline_type = 'translate'
        AND COALESCE(json_extract(j.options_json, '$.resourceType'), 'tn') = ?4
        AND json_extract(j.options_json, '$.rowIds') IS NULL
        AND (
              (json_extract(j.options_json, '$.verseStart') IS NULL
               AND json_extract(j.options_json, '$.verseEnd') IS NULL)
           OR (?5 > 0
               AND json_extract(j.options_json, '$.verseStart') IS NOT NULL
               AND json_extract(j.options_json, '$.verseStart') <= ?5
               AND COALESCE(json_extract(j.options_json, '$.verseEnd'),
                            json_extract(j.options_json, '$.verseStart')) >= ?6)
        )
        AND j.state IN ${PIPELINE_ACTIVE_STATES_SQL}`;

// Whether an incoming /start request is the NARROWER side of a possible overlap,
// i.e. whether PIPELINE_COVERAGE_WHERE should be run for it at all. Exported
// alongside the SQL for the same anti-drift reason: this predicate is what makes
// the rule one-way (a chapter-wide request never reaches the coverage query), so
// the test must exercise the route's copy of it, not a re-typed one.
//
// EITHER verse boundary makes a request narrower. TranslateOptions accepts an
// end-only selection ({verseEnd: 7} with no verseStart), and keying this on
// verseStart alone would let such a request slip past the coverage query and run
// alongside a chapter-wide job that already covers it. An end-only request keeps
// `verses.start === 0`, so inside the clause only the chapter-wide shape (a) can
// match it — shape (b) is guarded by `?5 > 0` — which is exactly right: its
// extent is unknown, so a chapter-wide job covers it and a verse-range job is not
// provably broader than it.
export function isNarrowerTranslateScope(
  pipelineType: string,
  normalizedRowIds: string[] | undefined,
  verses: { start: number; end: number },
): boolean {
  return (
    pipelineType === "translate" &&
    (normalizedRowIds !== undefined || verses.start > 0 || verses.end > 0)
  );
}

// The ?5/?6 pair for PIPELINE_COVERAGE_WHERE. Both default to 0 (the "no verse
// range" sentinel, which only shape (a) can match, since shape (b) is guarded by
// `?5 > 0`). verseEnd defaults to verseStart when only a start was sent.
//
// The Math.max is a guard, not cosmetics: TranslateOptions validates verseStart
// and verseEnd as independent positive ints with no ordering refine, so a caller
// can post an INVERTED range like {verseStart: 8, verseEnd: 3}. Bound verbatim
// that becomes `job.verseStart <= 8 AND job.verseEnd >= 3`, which a running job
// for verses 1-4 satisfies — a false already_running. Clamping the end to the
// start makes an inverted range demand a job that actually covers verse 8.
export function coverageVerseRange(
  verseStart: number | undefined,
  verseEnd: number | undefined,
): { start: number; end: number } {
  const start = verseStart ?? 0;
  return { start, end: Math.max(start, verseEnd ?? start) };
}

// ── Row-scoped request inside a running verse-range job (#745) ──────────────
//
// Three steps, run by the route only after the coverage query above missed:
//   1. needsRowVerseLookup — pure: is this a single-chapter tn/tq request scoped
//      by rowIds with no verse range of its own?
//   2. PIPELINE_VERSE_RANGE_JOB_WHERE — the cheap gate: is any verse-range
//      translate for this book/chapter/resource in flight? Almost always no, so a
//      row-scoped start never touches the rows table unless it might matter.
//   3. rowVerseLookupSql + rowVerseSpan — the rows' verses, then
//      PIPELINE_COVERAGE_WHERE again with that span as ?5/?6.

export function needsRowVerseLookup(
  pipelineType: string,
  resourceType: string | null,
  normalizedRowIds: string[] | undefined,
  verses: { start: number; end: number },
  startChapter: number,
  endChapter: number,
): boolean {
  return (
    pipelineType === "translate" &&
    (resourceType === "tn" || resourceType === "tq") &&
    normalizedRowIds !== undefined &&
    verses.start === 0 &&
    verses.end === 0 &&
    startChapter === endChapter
  );
}

// Same book/chapter/resource/state terms as PIPELINE_COVERAGE_WHERE, narrowed to
// verse-range jobs (no $.rowIds, a stored verseStart — the only jobs shape (b)
// can match). Binding: ?1 book ?2 startChapter ?3 endChapter ?4 resourceType.
export const PIPELINE_VERSE_RANGE_JOB_WHERE = `j.book = ?1 AND j.start_chapter = ?2 AND j.end_chapter = ?3
        AND j.pipeline_type = 'translate'
        AND COALESCE(json_extract(j.options_json, '$.resourceType'), 'tn') = ?4
        AND json_extract(j.options_json, '$.rowIds') IS NULL
        AND json_extract(j.options_json, '$.verseStart') IS NOT NULL
        AND j.state IN ${PIPELINE_ACTIVE_STATES_SQL}`;

// The leading verse of each requested row. The table name comes from a fixed
// map, never from input. Binding: ?1 book ?2 chapter ?3.. the normalized row ids.
// No chunking: the StartBody schema caps translate.rowIds at 50, so at most 52
// bindings, under D1's 100-parameter limit. (book, id) is the primary key, so
// each id matches at most one row. Soft-deleted rows are left out.
export function rowVerseLookupSql(resourceType: string, count: number): string | null {
  const table = resourceType === "tn" ? "tn_rows" : resourceType === "tq" ? "tq_rows" : null;
  if (!table || count < 1) return null;
  const ids = Array.from({ length: count }, (_, i) => `?${i + 3}`).join(", ");
  return `SELECT verse FROM ${table}
          WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL AND id IN (${ids})`;
}

// The [min, max] leading-verse span of the looked-up rows, or undefined when the
// extent is unknown: fewer rows came back than were requested, or a row sits on
// verse 0 (a chapter intro, which no verse range covers). Undefined means "don't
// block" — the request proceeds.
export function rowVerseSpan(
  rows: { verse: number }[],
  expectedCount: number,
): { start: number; end: number } | undefined {
  if (rows.length === 0 || rows.length !== expectedCount) return undefined;
  const verses = rows.map((r) => Number(r.verse));
  const start = Math.min(...verses);
  if (!Number.isInteger(start) || start < 1) return undefined;
  return { start, end: Math.max(...verses) };
}

// ── A row-scoped request whose rows a person touched after the covering job
//    was queued (#757) ────────────────────────────────────────────────────────
//
// The coverage answer above assumes the covering job will redraft the requested
// rows. It won't redraft a row a person changed after it was queued: its apply
// skips that row (humanTouchedIds in pipelineImport.ts, #601 notes / #725
// questions). So when coverage finds a job for a ROW-SCOPED tn/tq request, the
// route asks this one question; a hit drops the coverage answer and the request
// starts (it runs after the covering job, serialized on the bot). Exact-identity
// dups and non-row-scoped requests never ask it.
//
// Gap (under-blocks, the safe side): only the covering job the coverage
// queries return is checked — the earliest. If a person touched the row after
// that job but before a LATER covering job was queued, the later job would
// redraft it, yet the request still starts: duplicate work, no lost edit.
//
// edit_log entries that count as a person changing a note (#601, option B) or
// a question (#725; questions only have content edits and Approve, so the
// trash/untrash actions never occur for them):
// a content edit (PATCH, history restore included), Approve, Not needed and
// Restore. Keep and hint toggles are left out (the translate apply never writes
// those bits, so they survive it, #602), and so is un-approve (the apply resets
// the note to ai_draft anyway, #602). Sources: the web app (NULL), the chat
// (`chat`) and the admin approve sweep (`admin_bulk_state`); machine writers
// (ai_pipeline, hint_expansion, dcs_reimport, aquifer, nightly_finalize) are
// not a person. Same action+source reading of edit_log as deleteUnkeptTns and
// reimportClassify.ts. Shared with humanTouchedIds so the apply-time skip and
// this start-time check read the same entries.
export const HUMAN_TOUCH_ACTIONS = ["update", "validate", "trash", "untrash"] as const;
export const HUMAN_TOUCH_SOURCES = ["chat", "admin_bulk_state"] as const;

// Whether the start route should run rowTouchedAfterJobSql for a coverage hit:
// a translate request scoped by rowIds to notes or questions (the two kinds
// whose apply skips touched rows).
export function needsTouchedRowCheck(
  pipelineType: string,
  resourceType: string | null,
  normalizedRowIds: string[] | undefined,
): resourceType is "tn" | "tq" {
  return (
    pipelineType === "translate" &&
    (resourceType === "tn" || resourceType === "tq") &&
    normalizedRowIds !== undefined
  );
}

// "Did a person touch any of these rows after this job was queued?" — the
// humanTouchedIds rule for one job. Exact when the job carries an
// edit_log_watermark (edit_log id above it); otherwise the seconds fallback on
// created_at, where the enqueue second itself counts. humanTouchedIds narrows
// that second to a later one only for rows the job itself was asked for by id;
// a covering job never has rowIds (both coverage clauses require
// `$.rowIds IS NULL`), so that branch never applies here.
//
// Binding: ?1 book  ?2 job.edit_log_watermark (exact) or job.created_at
//          ?3.. HUMAN_TOUCH_ACTIONS, then HUMAN_TOUCH_SOURCES, then the row ids
// — rowTouchedAfterJobBindings builds that list. No chunking: translate.rowIds
// is capped at 50, so at most 58 bindings, under D1's 100-parameter limit. The
// kind is a literal from the fixed tn|tq union, never input.
export function rowTouchedAfterJobSql(kind: "tn" | "tq", exact: boolean, count: number): string {
  const actions = HUMAN_TOUCH_ACTIONS.map((_, i) => `?${i + 3}`).join(", ");
  const sources = HUMAN_TOUCH_SOURCES.map((_, i) => `?${i + 3 + HUMAN_TOUCH_ACTIONS.length}`).join(", ");
  const first = 3 + HUMAN_TOUCH_ACTIONS.length + HUMAN_TOUCH_SOURCES.length;
  const ids = Array.from({ length: count }, (_, i) => `?${i + first}`).join(", ");
  return `SELECT 1 AS hit FROM edit_log
          WHERE kind = '${kind}' AND book = ?1 AND ${exact ? "id > ?2" : "created_at >= ?2"}
            AND action IN (${actions})
            AND (source IS NULL OR source IN (${sources}))
            AND row_key IN (${ids})
          LIMIT 1`;
}

export function rowTouchedAfterJobBindings(
  book: string,
  job: { edit_log_watermark: number | null; created_at: number },
  rowIds: string[],
): unknown[] {
  return [
    book,
    job.edit_log_watermark ?? job.created_at,
    ...HUMAN_TOUCH_ACTIONS,
    ...HUMAN_TOUCH_SOURCES,
    ...rowIds,
  ];
}

// ── A narrower request that names an approved row, covered by a whole-chapter
//    job (#794) ────────────────────────────────────────────────────────────────
//
// A whole-chapter translate (no rowIds, no verse range) keeps approved notes and
// questions as they are (pipelineImport.ts applyJobOutput, keepApproved). A
// one-note redo or a verse-range run is how a person redrafts an approved row,
// so such a request must not be answered with a covering whole-chapter job that
// would keep the row. A covering job is whole-chapter exactly when it has no
// verseStart (PIPELINE_COVERAGE_WHERE already excludes rowIds, and its shape (b)
// requires a verseStart) — the same test translateSelection makes at apply.
// Select this column next to the covering job to read it.
export const COVERING_WHOLE_CHAPTER_COLUMN = `(json_extract(j.options_json, '$.verseStart') IS NULL) AS whole_chapter`;

// The query asking "is any row this request names approved?", or null when the
// request is not a tn/tq row-scoped or verse-range one (an end-only verse
// selection is whole-chapter at apply, so it keeps approved rows too). Row ids
// are unique per book (primary key), so the row form needs no chapter.
// No chunking: translate.rowIds is capped at 50.
export function approvedRowInRequestQuery(
  resourceType: string | null,
  book: string,
  startChapter: number,
  endChapter: number,
  rowIds: string[] | undefined,
  verses: { start: number; end: number },
): { sql: string; bindings: unknown[] } | null {
  const table = resourceType === "tn" ? "tn_rows" : resourceType === "tq" ? "tq_rows" : null;
  if (!table) return null;
  const approved = `deleted_at IS NULL AND translation_state = 'validated'`;
  if (rowIds && rowIds.length > 0) {
    const ids = rowIds.map((_, i) => `?${i + 2}`).join(", ");
    return {
      sql: `SELECT 1 AS hit FROM ${table} WHERE book = ?1 AND ${approved} AND id IN (${ids}) LIMIT 1`,
      bindings: [book, ...rowIds],
    };
  }
  if (verses.start > 0) {
    return {
      sql: `SELECT 1 AS hit FROM ${table}
             WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND ${approved} AND verse BETWEEN ?4 AND ?5 LIMIT 1`,
      bindings: [book, startChapter, endChapter, verses.start, verses.end],
    };
  }
  return null;
}
