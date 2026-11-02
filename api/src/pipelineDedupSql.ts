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
