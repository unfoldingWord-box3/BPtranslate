// Unit test for the scope terms of the /api/pipelines/start conflict queries
// (issue #316 row scope, #347 item 2 verse range, #347 item 1 coverage, #745
// row scope inside a verse range, #757 rows touched after the covering job).
//
// The queries live inline in the Hono route in pipelines.ts, so this test drives
// them against an in-memory node:sqlite DB (the schema-invariant testing pattern
// noted in STATE.md). It used to hand-copy the WHERE clause, which could drift
// from the real query while still passing (flagged in the #356 review); the
// clauses are now IMPORTED from pipelineDedupSql.ts — the same strings the route
// executes — and only the bound values are reproduced here.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineRowScopeDedup.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DatabaseSync } from "node:sqlite";
import { normalizeRowIds } from "./translateOptions.ts";
import {
  PIPELINE_COVERAGE_WHERE,
  COVERING_WHOLE_CHAPTER_COLUMN,
  approvedRowInRequestQuery,
  PIPELINE_DEDUP_WHERE,
  PIPELINE_VERSE_RANGE_JOB_WHERE,
  coverageVerseRange,
  isNarrowerTranslateScope,
  needsRowVerseLookup,
  needsTouchedRowCheck,
  rowTouchedAfterJobBindings,
  rowTouchedAfterJobSql,
  rowVerseLookupSql,
  rowVerseSpan,
} from "./pipelineDedupSql.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// One isolated in-memory DB plus the bind-value logic the route computes around
// the shared clauses. Each block makes its own so seeded jobs never leak.
function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE pipeline_jobs (
      job_id TEXT PRIMARY KEY,
      user_id INTEGER,
      pipeline_type TEXT,
      book TEXT,
      start_chapter INTEGER,
      end_chapter INTEGER,
      options_json TEXT,
      state TEXT,
      created_at INTEGER,
      edit_log_watermark INTEGER
    );
    CREATE TABLE edit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, row_key TEXT, book TEXT,
                           action TEXT, source TEXT, created_at INTEGER);
    CREATE TABLE tn_rows (id TEXT, book TEXT, chapter INTEGER, verse INTEGER, deleted_at INTEGER,
                          translation_state TEXT, PRIMARY KEY (book, id));
    CREATE TABLE tq_rows (id TEXT, book TEXT, chapter INTEGER, verse INTEGER, deleted_at INTEGER,
                          translation_state TEXT, PRIMARY KEY (book, id));
  `);
  let seq = 0;

  // A tn/tq row the row-scope lookup (#745) resolves to a verse.
  // `state` is translation_state ('validated' = approved, #794).
  function seedRow(table, id, verse, { chapter = 5, deleted = false, state = null } = {}) {
    db.prepare(
      `INSERT INTO ${table} (id, book, chapter, verse, deleted_at, translation_state) VALUES (?, 'MRK', ?, ?, ?, ?)`,
    ).run(id, chapter, verse, deleted ? 1 : null, state);
  }

  // Mirror buildTranslateOptions' persistence: rowIds stored normalized, omitted
  // entirely for a chapter-wide job; verseStart/verseEnd only when present.
  // `watermark: true` stamps edit_log_watermark the way the route's INSERT does
  // (MAX(edit_log.id) at enqueue); false leaves it NULL, like a job queued
  // before migration 0076. `createdAt` overrides the enqueue second.
  function seed(
    jobId,
    userId,
    translate,
    pipelineType = "translate",
    state = "running",
    { watermark = true, createdAt } = {},
  ) {
    const opts =
      pipelineType === "translate" ? { resourceType: translate?.resourceType ?? "tn" } : {};
    const norm = normalizeRowIds(translate?.rowIds);
    if (norm) opts.rowIds = norm;
    if (translate?.verseStart != null) opts.verseStart = translate.verseStart;
    if (translate?.verseEnd != null) opts.verseEnd = translate.verseEnd;
    db.prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, options_json, state, created_at,
          edit_log_watermark)
       VALUES (?, ?, ?, 'MRK', 5, 5, ?, ?, ?,
               ${watermark ? "(SELECT COALESCE(MAX(id), 0) FROM edit_log)" : "NULL"})`,
    ).run(jobId, userId, pipelineType, JSON.stringify(opts), state, createdAt ?? seq++);
  }

  // An edit_log row for a tn/tq row in MRK, as the row routes write it. source
  // NULL is the web app; `at` is the second it landed in.
  function touch(kind, rowKey, { action = "update", source = null, at = 1000 } = {}) {
    db.prepare(
      `INSERT INTO edit_log (kind, row_key, book, action, source, created_at) VALUES (?, ?, 'MRK', ?, ?, ?)`,
    ).run(kind, rowKey, action, source, at);
  }

  // Exact-identity dedupe — the route's PIPELINE_DEDUP_WHERE, bound the way the
  // route binds it (book/chapter fixed to the seeded scope).
  function findDup(translate, pipelineType = "translate") {
    const isTranslate = pipelineType === "translate";
    const norm = normalizeRowIds(translate?.rowIds);
    return db
      .prepare(
        `SELECT j.job_id, j.user_id
           FROM pipeline_jobs j
          WHERE ${PIPELINE_DEDUP_WHERE}
          ORDER BY j.created_at ASC
          LIMIT 1`,
      )
      .get(
        "MRK",
        5,
        5,
        pipelineType,
        isTranslate ? (translate?.resourceType ?? "tn") : null,
        isTranslate ? (norm ? JSON.stringify(norm) : "ALL") : null,
        isTranslate ? (translate?.verseStart ?? 0) : null,
        isTranslate ? (translate?.verseEnd ?? 0) : null,
      );
  }

  // Coverage conflict — the route's PIPELINE_COVERAGE_WHERE, bound through the
  // route's own coverageVerseRange (imported, not re-typed).
  function findCovering(translate, verses = coverageVerseRange(translate?.verseStart, translate?.verseEnd)) {
    return db
      .prepare(
        `SELECT j.job_id, j.user_id, j.created_at, j.edit_log_watermark, ${COVERING_WHOLE_CHAPTER_COLUMN}
           FROM pipeline_jobs j
          WHERE ${PIPELINE_COVERAGE_WHERE}
          ORDER BY j.created_at ASC
          LIMIT 1`,
      )
      .get("MRK", 5, 5, translate?.resourceType ?? "tn", verses.start, verses.end);
  }

  // The route's full decision: exact identity first, then — only when the route's
  // own isNarrowerTranslateScope says the incoming request is the narrower side —
  // the coverage query. Then (#745), only for a row-scoped request that the route's
  // own needsRowVerseLookup admits: the cheap "any verse-range job here?" gate,
  // the rowId → verse lookup, and the coverage query again with the rows' span.
  // `lookups` counts row-table reads so a test can prove the gate kept them off
  // the common path.
  let lookups = 0;
  function resolveConflict(translate, pipelineType = "translate") {
    const exact = findDup(translate, pipelineType);
    if (exact) return exact;
    const covering = findCoveringJob(translate, pipelineType);
    if (!covering) return undefined;
    // #757: the route's own predicate, SQL and bindings — a requested row a
    // person touched after the covering job was queued drops the coverage answer.
    const rt = pipelineType === "translate" ? (translate?.resourceType ?? "tn") : null;
    const norm = normalizeRowIds(translate?.rowIds);
    if (needsTouchedRowCheck(pipelineType, rt, norm)) {
      const touched = db
        .prepare(rowTouchedAfterJobSql(rt, covering.edit_log_watermark !== null, norm.length))
        .get(...rowTouchedAfterJobBindings("MRK", covering, norm));
      if (touched) return undefined;
    }
    // #794: the route's own query; a whole-chapter covering job keeps approved
    // rows, so a request naming one is not covered by it.
    if (covering.whole_chapter === 1) {
      const verses = coverageVerseRange(translate?.verseStart, translate?.verseEnd);
      const q = approvedRowInRequestQuery(rt, "MRK", 5, 5, norm, verses);
      if (q && db.prepare(q.sql).get(...q.bindings)) return undefined;
    }
    return covering;
  }

  // Both coverage paths (#347 item 1, then #745), as the route runs them.
  function findCoveringJob(translate, pipelineType) {
    const verses = coverageVerseRange(translate?.verseStart, translate?.verseEnd);
    const norm = normalizeRowIds(translate?.rowIds);
    const narrower = isNarrowerTranslateScope(pipelineType, norm, verses);
    if (!narrower) return undefined;
    const covering = findCovering(translate);
    if (covering) return covering;
    const rt = pipelineType === "translate" ? (translate?.resourceType ?? "tn") : null;
    if (!needsRowVerseLookup(pipelineType, rt, norm, verses, 5, 5)) return undefined;
    const gate = db
      .prepare(`SELECT 1 AS hit FROM pipeline_jobs j WHERE ${PIPELINE_VERSE_RANGE_JOB_WHERE} LIMIT 1`)
      .get("MRK", 5, 5, rt);
    if (!gate) return undefined;
    const sql = rowVerseLookupSql(rt, norm.length);
    if (!sql) return undefined;
    lookups++;
    const rows = db.prepare(sql).all("MRK", 5, ...norm);
    const span = rowVerseSpan(rows, norm.length);
    return span ? findCovering(translate, span) : undefined;
  }

  return { seed, seedRow, touch, findDup, findCovering, resolveConflict, lookupCount: () => lookups };
}

const USER = 1;

console.log("[#316] row scope is part of dedupe identity");
{
  const { seed, findDup } = makeDb();
  // Row A in flight for this user.
  seed("jobA", USER, { rowIds: ["rowA"] });

  // Bullet 1: a DIFFERENT row → NOT a dup (row B must get its own job).
  assert(findDup({ rowIds: ["rowB"] }) === undefined, "row B does not dedup onto row A's job (the bug)");

  // Bullet 2: the SAME row → still already_running (dup found).
  const same = findDup({ rowIds: ["rowA"] });
  assert(same && same.job_id === "jobA", "row A again → dedups onto jobA (already_running preserved)");

  // Order-independence: same set, different order → still dups.
  seed("jobAB", USER, { rowIds: ["p", "q"] });
  const reorder = findDup({ rowIds: ["q", "p"] });
  assert(reorder && reorder.job_id === "jobAB", "[q,p] dedups onto stored [p,q] (order-independent)");

  // Bullet 3: a chapter-wide translate is unaffected by row-scoped jobs...
  assert(findDup(undefined) === undefined, "chapter-wide request does not dedup against row-scoped jobs");
  // ...and a row-scoped request has no EXACT dup against a chapter-wide job.
  // (#347 item 1 layers a coverage conflict on top of that; see its block below.)
  seed("jobAll", USER, undefined);
  assert(
    findDup({ rowIds: ["rowZ"] }) === undefined,
    "row-scoped request has no exact dup against a chapter-wide job",
  );
  // Chapter-wide DOES still dedup against another chapter-wide (unchanged behavior).
  const allDup = findDup(undefined);
  assert(allDup && allDup.job_id === "jobAll", "chapter-wide dedups against chapter-wide (unchanged)");

  // resourceType still separates work: a tq row-scoped job for the same row does
  // not collide with the tn one.
  seed("jobTqA", USER, { resourceType: "tq", rowIds: ["rowA"] });
  const tnA = findDup({ resourceType: "tn", rowIds: ["rowA"] });
  assert(tnA && tnA.job_id === "jobA", "tn row A dedups onto the tn job, not the tq one");
  const tqA = findDup({ resourceType: "tq", rowIds: ["rowA"] });
  assert(tqA && tqA.job_id === "jobTqA", "tq row A dedups onto the tq job (resourceType still separates)");
}

console.log("\n[#347 item 2] verse-range scope is part of dedupe identity");
{
  const { seed, findDup } = makeDb();
  // A verse-range translate for verses 6-7 in flight (no rowIds → row scope 'ALL').
  seed("jobV67", USER, { verseStart: 6, verseEnd: 7 });

  // Different verse range in the same chapter → NOT a dup (the bug: both resolve
  // to row scope 'ALL', so without a verse-range term they would collapse).
  assert(
    findDup({ verseStart: 8, verseEnd: 9 }) === undefined,
    "verses 8-9 do not dedup onto the 6-7 job (verse range is part of identity)",
  );
  // Same verse range → still already_running.
  const sameRange = findDup({ verseStart: 6, verseEnd: 7 });
  assert(sameRange && sameRange.job_id === "jobV67", "verses 6-7 again → dedups onto jobV67");
  // A single-verse range that shares verseStart but differs on verseEnd is distinct.
  assert(
    findDup({ verseStart: 6, verseEnd: 6 }) === undefined,
    "verse 6 alone has no exact dup on the 6-7 range (verseEnd separates)",
  );
  // Verse-range vs chapter-wide are distinct identities (consistent with #316's
  // row-scoped vs chapter-wide choice): a chapter-wide request binds verseStart 0.
  seed("jobAll", USER, undefined);
  const chapWide = findDup(undefined);
  assert(
    chapWide && chapWide.job_id === "jobAll",
    "chapter-wide request does not dedup onto the verse-range job",
  );
  // A verse-range request resolves to its own verse-range job, not the chapter-wide one.
  const rangeDup = findDup({ verseStart: 6, verseEnd: 7 });
  assert(
    rangeDup && rangeDup.job_id === "jobV67",
    "verse-range request resolves to its verse-range job, not a chapter-wide one",
  );
  // A verse-range request has no exact dup against a row-scoped job in the chapter.
  seed("jobRowX", USER, { rowIds: ["rX"] });
  assert(
    findDup({ verseStart: 3, verseEnd: 3 }) === undefined,
    "verse-range request has no exact dup against a row-scoped job",
  );
}

console.log("\n[#347 item 1] a broader in-flight job blocks a narrower request inside its scope");
{
  const { seed, findDup, resolveConflict } = makeDb();
  // A chapter-wide tn translate is running.
  seed("jobChapter", USER, undefined);

  // 1. chapter-wide blocks row-scoped.
  const rowInside = resolveConflict({ rowIds: ["rowA"] });
  assert(
    rowInside && rowInside.job_id === "jobChapter",
    "row-scoped request is blocked by the in-flight chapter-wide job (returns its id)",
  );
  // 2. chapter-wide blocks verse-range.
  const rangeInside = resolveConflict({ verseStart: 6, verseEnd: 7 });
  assert(
    rangeInside && rangeInside.job_id === "jobChapter",
    "verse-range request is blocked by the in-flight chapter-wide job",
  );
  // An END-ONLY request ({verseEnd: 7}, no verseStart — TranslateOptions accepts
  // it) is narrower too, and must not slip past the coverage query.
  const endOnly = resolveConflict({ verseEnd: 7 });
  assert(
    endOnly && endOnly.job_id === "jobChapter",
    "end-only verse selection is blocked by the in-flight chapter-wide job",
  );
  // resourceType still separates: a tq narrower request is NOT blocked by the tn
  // chapter-wide job.
  assert(
    resolveConflict({ resourceType: "tq", rowIds: ["rowA"] }) === undefined,
    "tq row-scoped request is not blocked by a tn chapter-wide job",
  );

  // 3. identical-request dedupe unchanged, and exact identity wins over coverage:
  // with BOTH a chapter-wide job and the row's own job in flight, the row-scoped
  // request still resolves to its OWN job's id (no #316 mis-attribution).
  seed("jobRowA", USER, { rowIds: ["rowA"] });
  const exactWins = resolveConflict({ rowIds: ["rowA"] });
  assert(
    exactWins && exactWins.job_id === "jobRowA",
    "exact identity still wins over coverage (row A resolves to its own job)",
  );
  const chapAgain = findDup(undefined);
  assert(
    chapAgain && chapAgain.job_id === "jobChapter",
    "identical chapter-wide request still dedups onto the chapter-wide job (unchanged)",
  );
}

console.log("\n[#347 item 1] the reverse direction stays allowed");
{
  // A bulk (chapter-wide) request while a row-scoped job runs proceeds as today.
  const { seed, resolveConflict } = makeDb();
  seed("jobRowOnly", USER, { rowIds: ["rowA"] });
  assert(
    resolveConflict(undefined) === undefined,
    "chapter-wide request is NOT blocked by an in-flight row-scoped job",
  );
  assert(
    resolveConflict({ rowIds: ["rowB"] }) === undefined,
    "a row-scoped job does not block a different row-scoped request",
  );

  // A WIDER verse range (or a chapter-wide run) while a narrower range runs is
  // likewise untouched — coverage is narrower-inside-broader only.
  const { seed: seedB, resolveConflict: resolveB } = makeDb();
  seedB("jobV67", USER, { verseStart: 6, verseEnd: 7 });
  assert(
    resolveB({ verseStart: 5, verseEnd: 9 }) === undefined,
    "a wider verse-range request is not blocked by a narrower in-flight range",
  );
  assert(
    resolveB(undefined) === undefined,
    "chapter-wide request is not blocked by an in-flight verse-range job",
  );
}

console.log("\n[#347 item 1] a covering verse range blocks a narrower range inside it");
{
  const { seed, seedRow, resolveConflict } = makeDb();
  seed("jobV68", USER, { verseStart: 6, verseEnd: 8 });
  seedRow("tn_rows", "rowA", 7);

  const inner = resolveConflict({ verseStart: 6, verseEnd: 7 });
  assert(inner && inner.job_id === "jobV68", "verses 6-7 blocked by the covering 6-8 job");
  const innerMid = resolveConflict({ verseStart: 7, verseEnd: 7 });
  assert(innerMid && innerMid.job_id === "jobV68", "verse 7 alone blocked by the covering 6-8 job");
  // Partial overlap is NOT containment → still allowed (narrower-inside-broader only).
  assert(
    resolveConflict({ verseStart: 8, verseEnd: 10 }) === undefined,
    "verses 8-10 (overlapping but not contained) are not blocked by the 6-8 job",
  );
  assert(
    resolveConflict({ verseStart: 1, verseEnd: 3 }) === undefined,
    "a disjoint verse range is not blocked",
  );
  // An end-only request has an unknown extent, so only a chapter-wide job can
  // cover it — a verse-range job is not provably broader and must not block it.
  assert(
    resolveConflict({ verseEnd: 7 }) === undefined,
    "end-only request is not blocked by a verse-range job (only a chapter-wide one covers it)",
  );
  // Formerly a documented GAP (#745): a row-scoped request inside a covering
  // verse-range job is now detected through the rowId → verse lookup.
  const rowInRange = resolveConflict({ rowIds: ["rowA"] });
  assert(
    rowInRange && rowInRange.job_id === "jobV68",
    "row-scoped request for a row on verse 7 is blocked by the covering 6-8 job (#745, was the gap)",
  );
  // An INVERTED request range ({verseStart: 8, verseEnd: 3} — the schema allows
  // it, there is no ordering refine) must not be satisfied by a job that covers
  // only the low end. coverageVerseRange clamps the end up to the start, so this
  // demands a job covering verse 8; the 6-8 job does cover it, but a 1-4 job
  // must not.
  const inverted = resolveConflict({ verseStart: 8, verseEnd: 3 });
  assert(
    inverted && inverted.job_id === "jobV68",
    "inverted range 8-3 is clamped to verse 8 and matches the covering 6-8 job",
  );
  const { seed: seedLow, resolveConflict: resolveLow } = makeDb();
  seedLow("jobV14", USER, { verseStart: 1, verseEnd: 4 });
  assert(
    resolveLow({ verseStart: 8, verseEnd: 3 }) === undefined,
    "inverted range 8-3 is NOT falsely blocked by a job covering verses 1-4",
  );
}

console.log("\n[#745] a row-scoped request inside a running verse-range job is caught");
{
  // The issue's shape: an admin drafts verses 2-4 from chat (bpt_draft sends a
  // verse range), then someone re-runs AI on one note from the web (rowIds).
  const OTHER = 2;
  const { seed, seedRow, resolveConflict, lookupCount } = makeDb();
  seed("jobV24", USER, { verseStart: 2, verseEnd: 4 });
  seedRow("tn_rows", "n3", 3);
  seedRow("tn_rows", "n3b", 3);
  seedRow("tn_rows", "n4", 4);
  seedRow("tn_rows", "n5", 5);
  seedRow("tn_rows", "n1", 1);
  seedRow("tn_rows", "nIntro", 0); // a chapter-intro note (verse 0)
  seedRow("tn_rows", "nGone", 3, { deleted: true });
  seedRow("tq_rows", "q3", 3);

  // Same user → the route answers already_running with the running job's id;
  // a different user gets the 409 conflict for the same job. The decision is
  // made on job identity + user_id, so both resolve to jobV24 with its owner.
  const v3 = resolveConflict({ rowIds: ["n3"] });
  assert(v3 && v3.job_id === "jobV24" && v3.user_id === USER, "row on verse 3 → covered by the 2-4 job (same user: already_running)");
  const { seed: seedO, seedRow: seedRowO, resolveConflict: resolveO } = makeDb();
  seedO("jobV24other", OTHER, { verseStart: 2, verseEnd: 4 });
  seedRowO("tn_rows", "n3", 3);
  const v3other = resolveO({ rowIds: ["n3"] });
  assert(
    v3other && v3other.job_id === "jobV24other" && v3other.user_id === OTHER,
    "row on verse 3 → covered by another user's 2-4 job (route answers the 409 conflict)",
  );

  // Rows at both ends of the range, and several rows all inside it.
  const v4 = resolveConflict({ rowIds: ["n4"] });
  assert(v4 && v4.job_id === "jobV24", "row on verse 4 (range end) is covered");
  const many = resolveConflict({ rowIds: ["n3", "n3b", "n4"] });
  assert(many && many.job_id === "jobV24", "several rows all on verses 3-4 are covered");

  // Outside the range → still starts.
  assert(resolveConflict({ rowIds: ["n5"] }) === undefined, "row on verse 5 is not covered (starts)");
  assert(resolveConflict({ rowIds: ["n1"] }) === undefined, "row on verse 1 is not covered (starts)");

  // Partial overlap: rows on verses 3 and 5 span 3-5, which the 2-4 job does not
  // CONTAIN. The #347 rule is containment ("8-10 overlapping but not contained are
  // not blocked" above), so this request proceeds — same rule, applied to the span.
  assert(
    resolveConflict({ rowIds: ["n3", "n5"] }) === undefined,
    "rows on verses 3 and 5 (span 3-5, partly outside 2-4) are not blocked (#347 containment rule)",
  );

  // Unknown extent → never block. A row id that isn't in this chapter, or a
  // soft-deleted row, leaves the lookup short of the requested count.
  assert(
    resolveConflict({ rowIds: ["n3", "nope"] }) === undefined,
    "a request naming an unknown row id is not blocked (extent unknown)",
  );
  assert(resolveConflict({ rowIds: ["nGone"] }) === undefined, "a soft-deleted row is not blocked");
  // A chapter-intro row (verse 0) is never inside a verse range.
  assert(resolveConflict({ rowIds: ["nIntro"] }) === undefined, "a chapter-intro row (verse 0) is not blocked");

  // resourceType separates: a tq row is not covered by a tn verse-range job.
  assert(
    resolveConflict({ resourceType: "tq", rowIds: ["q3"] }) === undefined,
    "a tq row on verse 3 is not blocked by a tn verse-range job",
  );

  // Exact identity still wins: the row's own in-flight job is returned, not the
  // covering one.
  seed("jobRow3", USER, { rowIds: ["n3"] });
  const own = resolveConflict({ rowIds: ["n3"] });
  assert(own && own.job_id === "jobRow3", "exact identity still wins over row-scope coverage");

  // A row-scoped JOB is not a covering verse-range job, and a chapter with no
  // verse-range job never reaches the row table (the cheap gate).
  const { seed: seedG, seedRow: seedRowG, resolveConflict: resolveG, lookupCount: gLookups } = makeDb();
  seedG("jobRowOther", USER, { rowIds: ["n4"] });
  seedRowG("tn_rows", "n3", 3);
  assert(resolveG({ rowIds: ["n3"] }) === undefined, "no verse-range job → row-scoped request starts");
  assert(gLookups() === 0, "no verse-range job in flight → the row table is never queried (gate)");
  assert(lookupCount() > 0, "with a verse-range job in flight the lookup does run");

  // A finished verse-range job does not cover.
  const { seed: seedD, seedRow: seedRowD, resolveConflict: resolveD } = makeDb();
  seedD("jobV24done", USER, { verseStart: 2, verseEnd: 4 }, "translate", "done");
  seedRowD("tn_rows", "n3", 3);
  assert(resolveD({ rowIds: ["n3"] }) === undefined, "a 'done' verse-range job does not block a row on verse 3");

  // A tq verse-range job covers a tq row the same way.
  const { seed: seedQ, seedRow: seedRowQ, resolveConflict: resolveQ } = makeDb();
  seedQ("jobTqV24", USER, { resourceType: "tq", verseStart: 2, verseEnd: 4 });
  seedRowQ("tq_rows", "q3", 3);
  const tq = resolveQ({ resourceType: "tq", rowIds: ["q3"] });
  assert(tq && tq.job_id === "jobTqV24", "a tq row on verse 3 is covered by a tq 2-4 job");
}

console.log("\n[#757] a row a person touched after the covering job was queued is not covered");
{
  // The covering job's apply skips a row a person edited, approved, trashed or
  // restored after it was queued (humanTouchedIds, #601 notes / #725 questions).
  // So an explicit "re-run AI on this row" must not be answered with that job.
  const OTHER = 2;

  // The issue's case: a running verse-range tq translate on verses 2-4.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tq_rows", "q3", 3);
    seedRow("tq_rows", "q3b", 3);
    seed("jobTqV24", USER, { resourceType: "tq", verseStart: 2, verseEnd: 4 });
    touch("tq", "q3"); // edited after the job was queued
    assert(
      resolveConflict({ resourceType: "tq", rowIds: ["q3"] }) === undefined,
      "verse-range tq 2-4: a question on verse 3 edited after the job was queued → the row-scoped start proceeds",
    );
    const untouched = resolveConflict({ resourceType: "tq", rowIds: ["q3b"] });
    assert(
      untouched && untouched.job_id === "jobTqV24",
      "verse-range tq 2-4: an untouched question on verse 3 → still already_running",
    );
    assert(
      resolveConflict({ resourceType: "tq", rowIds: ["q3", "q3b"] }) === undefined,
      "one touched row among the requested ones is enough to start",
    );
  }

  // Same for a chapter-wide job (shape (a)), tn and tq.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tn_rows", "n3", 3);
    seedRow("tn_rows", "n4", 4);
    seedRow("tq_rows", "q3", 3);
    seed("jobAll", USER, undefined);
    seed("jobAllTq", USER, { resourceType: "tq" });
    touch("tn", "n3", { action: "validate" }); // Approve
    touch("tq", "q3");
    assert(
      resolveConflict({ rowIds: ["n3"] }) === undefined,
      "chapter-wide tn: a note approved after the job was queued → the row-scoped start proceeds",
    );
    const n4 = resolveConflict({ rowIds: ["n4"] });
    assert(n4 && n4.job_id === "jobAll", "chapter-wide tn: an untouched note → still already_running");
    assert(
      resolveConflict({ resourceType: "tq", rowIds: ["q3"] }) === undefined,
      "chapter-wide tq: a question edited after the job was queued → the row-scoped start proceeds",
    );
  }

  // Another user's covering job: the route would answer 409; a touched row starts instead.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tn_rows", "n3", 3);
    seed("jobV24other", OTHER, { verseStart: 2, verseEnd: 4 });
    touch("tn", "n3");
    assert(
      resolveConflict({ rowIds: ["n3"] }) === undefined,
      "another user's covering job does not 409 a row touched after it was queued",
    );
  }

  // Touches that do not release the request.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tn_rows", "n3", 3);
    touch("tn", "n3"); // BEFORE the job was queued: the job will redraft it
    seed("jobV24", USER, { verseStart: 2, verseEnd: 4 });
    touch("tn", "n3", { source: "ai_pipeline" }); // a machine writer, not a person
    touch("tn", "n3", { action: "unvalidate" }); // un-approve: the apply resets it anyway
    touch("tq", "n3"); // same id, other kind
    const still = resolveConflict({ rowIds: ["n3"] });
    assert(
      still && still.job_id === "jobV24",
      "a touch before the enqueue, a machine-source touch, an excluded action or another kind's row → still covered",
    );
    touch("tn", "n3", { source: "chat" }); // a person through the chat
    assert(resolveConflict({ rowIds: ["n3"] }) === undefined, "a chat-source edit after the enqueue counts as a person");
  }

  // A job queued before migration 0076 (no watermark): seconds fallback on created_at.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tn_rows", "n3", 3);
    seedRow("tn_rows", "n4", 4);
    seed("jobOld", USER, undefined, "translate", "running", { watermark: false, createdAt: 500 });
    touch("tn", "n3", { at: 500 }); // the enqueue second itself counts (the job has no rowIds)
    touch("tn", "n4", { at: 499 });
    assert(resolveConflict({ rowIds: ["n3"] }) === undefined, "no watermark: a touch in the enqueue second releases");
    const n4 = resolveConflict({ rowIds: ["n4"] });
    assert(n4 && n4.job_id === "jobOld", "no watermark: a touch the second before the enqueue does not");
  }

  // Known gap (under-blocks, the safe side): only the EARLIEST covering job is
  // checked. A later covering job queued after the touch would redraft the row,
  // but the request still starts — duplicate work, no lost edit.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tn_rows", "n3", 3);
    seed("jobAll", USER, undefined);
    touch("tn", "n3");
    seed("jobV24later", USER, { verseStart: 2, verseEnd: 4 });
    assert(
      resolveConflict({ rowIds: ["n3"] }) === undefined,
      "touched after the earliest covering job → starts, even though a later covering job would redraft it (gap)",
    );
  }

  // Unchanged paths.
  {
    const { seed, seedRow, touch, resolveConflict } = makeDb();
    seedRow("tq_rows", "q3", 3);
    seed("jobRowQ3", USER, { resourceType: "tq", rowIds: ["q3"] });
    seed("jobAll", USER, undefined);
    touch("tq", "q3");
    touch("tn", "n3");
    const exact = resolveConflict({ resourceType: "tq", rowIds: ["q3"] });
    assert(exact && exact.job_id === "jobRowQ3", "exact identity is unchanged: the same row's own job still answers");
    const range = resolveConflict({ verseStart: 3, verseEnd: 3 });
    assert(
      range && range.job_id === "jobAll",
      "a verse-range request (not row-scoped) inside a chapter-wide job stays covered",
    );
  }
}

console.log("\n[#347 item 1] only non-terminal jobs cover");
{
  // A job that is done/failed/cancelled is not going to write anything, so it must
  // not block a narrower request. The coverage clause shares the active-state list
  // with the exact-identity clause.
  for (const state of ["done", "failed", "cancelled", "error"]) {
    const { seed, resolveConflict } = makeDb();
    seed("jobChapter", USER, undefined, "translate", state);
    assert(
      resolveConflict({ rowIds: ["rowA"] }) === undefined,
      `a '${state}' chapter-wide job does not block a row-scoped request`,
    );
  }
  // Paused states DO still count as in flight (the decision says non-terminal).
  for (const state of ["queued", "dispatching", "paused_for_outage", "paused_for_usage_limit"]) {
    const { seed, resolveConflict } = makeDb();
    seed("jobChapter", USER, undefined, "translate", state);
    const blocked = resolveConflict({ rowIds: ["rowA"] });
    assert(
      blocked && blocked.job_id === "jobChapter",
      `a '${state}' chapter-wide job blocks a row-scoped request`,
    );
  }
}

console.log("\n[#347 item 1] a job with an unknown extent never covers");
{
  // A stored job carrying verseEnd but NO verseStart has an extent we can't reason
  // about; the clause must treat it as non-covering rather than falsely blocking.
  const { seed, resolveConflict } = makeDb();
  seed("jobEndOnly", USER, { verseEnd: 9 });
  assert(
    resolveConflict({ verseStart: 6, verseEnd: 7 }) === undefined,
    "a job with verseEnd but no verseStart covers nothing (no false block)",
  );
  assert(
    resolveConflict({ rowIds: ["rowA"] }) === undefined,
    "a job with verseEnd but no verseStart does not block a row-scoped request",
  );
  // A job with verseStart but no verseEnd covers exactly that one verse.
  const { seed: seedS, resolveConflict: resolveS } = makeDb();
  seedS("jobStartOnly", USER, { verseStart: 6 });
  const one = resolveS({ verseStart: 6, verseEnd: 6 });
  assert(one && one.job_id === "jobStartOnly", "a job with verseStart only covers that single verse");
  assert(
    resolveS({ verseStart: 6, verseEnd: 7 }) === undefined,
    "a job with verseStart only does not cover a two-verse request",
  );
}

console.log("\n[#347 item 1] non-translate pipelines are unaffected");
{
  const { seed, resolveConflict } = makeDb();
  seed("jobNotes", USER, undefined, "notes");
  const notesDup = resolveConflict(undefined, "notes");
  assert(
    notesDup && notesDup.job_id === "jobNotes",
    "notes request dedups against the in-flight notes job (unchanged)",
  );
  // A translate request in the same scope is not blocked by a notes job.
  assert(
    resolveConflict({ rowIds: ["rowA"] }) === undefined,
    "translate row-scoped request is not blocked by a non-translate job",
  );
  // And a notes job never blocks another kind's narrower request via coverage.
  const { seed: seedG, resolveConflict: resolveG } = makeDb();
  seedG("jobGenerate", USER, undefined, "generate");
  assert(
    resolveG({ verseStart: 2, verseEnd: 3 }) === undefined,
    "verse-range translate request is not blocked by an in-flight generate job",
  );
}

console.log("\n[#794] a narrower request naming an approved row is not covered by a whole-chapter job");
{
  // A whole-chapter translate keeps approved rows as they are; the one-note
  // redo and verse-range runs are how a person redrafts one. So those requests
  // must start rather than attach to the whole-chapter job.
  const { seed, seedRow, resolveConflict } = makeDb();
  seedRow("tn_rows", "n3", 3, { state: "validated" });
  seedRow("tn_rows", "n4", 4, { state: "ai_draft" });
  seedRow("tq_rows", "q3", 3, { state: "validated" });
  seed("jobAll", USER, undefined);
  seed("jobAllTq", USER, { resourceType: "tq" });
  assert(resolveConflict({ rowIds: ["n3"] }) === undefined, "chapter-wide tn: a redo of an approved note starts");
  const n4 = resolveConflict({ rowIds: ["n4"] });
  assert(n4 && n4.job_id === "jobAll", "chapter-wide tn: a redo of a draft note is still already_running");
  assert(resolveConflict({ rowIds: ["n3", "n4"] }) === undefined, "one approved row among the requested ones is enough");
  assert(
    resolveConflict({ verseStart: 2, verseEnd: 3 }) === undefined,
    "chapter-wide tn: a verse range holding an approved note starts",
  );
  const v4 = resolveConflict({ verseStart: 4, verseEnd: 4 });
  assert(v4 && v4.job_id === "jobAll", "chapter-wide tn: a verse range with no approved note is still covered");
  assert(
    resolveConflict({ resourceType: "tq", rowIds: ["q3"] }) === undefined,
    "chapter-wide tq: a redo of an approved question starts",
  );
}
{
  // A verse-range covering job redrafts approved rows, so it still covers them.
  const { seed, seedRow, resolveConflict } = makeDb();
  seedRow("tn_rows", "n3", 3, { state: "validated" });
  seed("jobV24", USER, { verseStart: 2, verseEnd: 4 });
  const r = resolveConflict({ rowIds: ["n3"] });
  assert(r && r.job_id === "jobV24", "verse-range tn 2-4: a redo of an approved note on verse 3 is still covered");
}

console.log("\npipelineRowScopeDedup: all assertions passed");
