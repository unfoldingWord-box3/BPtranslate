import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type {
  ChapterPayload,
  CheckLane,
  TnRow,
  TqRow,
  TwlRow,
  VerseRow,
  VerseDto,
  VerseStatus,
  VerseLaneCheck,
} from "./types";
// Runtime (value) imports carry the .ts extension — same convention as rows.ts
// — so this module loads under `node --experimental-strip-types`, which is what
// the api test runner uses. Type-only imports are erased and need no extension.
import { CHECK_LANES } from "./types.ts";
import { currentUserId, requireEditor } from "./auth.ts";
import { broadcastChapter } from "./wsEvents.ts";
import { recomputeTargetOccurrences } from "./importParsers.ts";
import {
  CorruptContentJsonError,
  corruptContentJsonBody,
  logCorruptContentJson,
  parseVerseContentJson,
} from "./contentJson.ts";
import { ensureLaneState, requireLaneState } from "./scriptureLane.ts";
import { withChapterZero, type ChapterSummaryRow } from "./chapterSummary.ts";

export const chapters = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Bulk read everything for a chapter.
chapters.get("/:book/:chapter", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!book || !Number.isFinite(chapter) || chapter < 0) {
    return c.json({ error: "invalid_params" }, 400);
  }
  const db = c.env.DB;

  // Ensure lane state rows exist; resolve active generations.
  await ensureLaneState(c.env);
  const litState = await requireLaneState(c.env, "lit");
  const simState = await requireLaneState(c.env, "sim");

  // Build generation filters — only serve verses for the active generation
  // of each lane. OL (UHB/UGNT) always uses generation 1.
  const genForBv: Record<string, number | null> = {
    ULT: litState.replacement_required ? null : litState.active_generation,
    UST: simState.replacement_required ? null : simState.active_generation,
    UHB: 1,
    UGNT: 1,
  };

  // `latest_source` is derived from edit_log per row — the source column on
  // the *most recent* entry for (kind, row_key). It's 'ai_pipeline' iff the
  // last write was AI-driven; any later human edit / keep overwrites with
  // NULL via a fresh edit_log row, so the chip disappears automatically.
  // The (kind, row_key) index makes the correlated subquery cheap.
  //
  // Book-scope the subquery on edit_log.book (added in migration 0017) so
  // cross-book id collisions can't leak the wrong source chip. Pre-0017
  // audit rows have NULL book; the `OR book IS NULL` keeps them visible
  // until the next edit naturally backfills.
  // The tn arm below filters `deleted_at` ONLY — trashed rows are served on
  // purpose. The trash is visible and restorable (a trashed note grays out at
  // the bottom of its verse with a Restore button; the review rail has a
  // "Trashed" status filter), so filtering `trashed_at` here would delete the
  // trash UI, not fix a count. The count rule lives on the client instead:
  // `reviewStats`/`liveRows` in web/src/lib/reviewApproval.ts exclude trashed
  // rows from every denominator, matching this file's book-summary SQL below
  // (`deleted_at IS NULL AND trashed_at IS NULL`). #238 — the payload carries
  // them, the counts don't. Don't "fix" the asymmetry by narrowing this query;
  // chapterCountDenominator.test.mjs pins both halves.
  const [verses, tn, tq, twl, statuses, laneChecks] = await Promise.all([
    db
      .prepare(
        "SELECT * FROM verses WHERE book = ?1 AND chapter = ?2 ORDER BY verse, bible_version",
      )
      .bind(book, chapter)
      .all<VerseRow>(),
    db
      .prepare(
        `SELECT t.*, (
           SELECT source FROM edit_log
            WHERE kind = 'tn' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tn_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`,
      )
      .bind(book, chapter)
      .all<TnRow>(),
    db
      .prepare(
        `SELECT t.*, (
           SELECT source FROM edit_log
            WHERE kind = 'tq' AND row_key = t.id
              AND (book = t.book OR book IS NULL)
            ORDER BY id DESC LIMIT 1
         ) AS latest_source
            FROM tq_rows t
           WHERE t.book = ?1 AND t.chapter = ?2 AND t.deleted_at IS NULL
           ORDER BY verse, sort_order ASC NULLS LAST, id`,
      )
      .bind(book, chapter)
      .all<TqRow>(),
    db
      .prepare(
        "SELECT * FROM twl_rows WHERE book = ?1 AND chapter = ?2 AND deleted_at IS NULL ORDER BY verse, sort_order ASC NULLS LAST, id",
      )
      .bind(book, chapter)
      .all<TwlRow>(),
    db
      .prepare(
        "SELECT * FROM verse_statuses WHERE book = ?1 AND chapter = ?2",
      )
      .bind(book, chapter)
      .all<VerseStatus>(),
    db
      .prepare(
        "SELECT * FROM verse_lane_checks WHERE book = ?1 AND chapter = ?2",
      )
      .bind(book, chapter)
      .all<VerseLaneCheck>(),
  ]);

  // Reshape verses → verses[bibleVersion][verseNum] = VerseDto for easy client lookup.
  // Filter by active generation per lane; replacement_required lanes are omitted.
  const verseMap: Record<string, Record<number, VerseDto>> = {};
  for (const v of verses.results) {
    const requiredGen = genForBv[v.bible_version];
    // null means lane blocked (replacement_required) — omit entirely
    if (requiredGen === null || requiredGen === undefined) continue;
    // Filter to active generation only
    if ((v as VerseRow & { source_generation?: number }).source_generation !== undefined
        && (v as VerseRow & { source_generation?: number }).source_generation !== requiredGen) continue;
    if (!verseMap[v.bible_version]) verseMap[v.bible_version] = {};
    const { content_json, ...rest } = v;
    void content_json;
    let parsed: unknown;
    try {
      parsed = parseVerseContentJson(v);
    } catch (err) {
      if (err instanceof CorruptContentJsonError) {
        logCorruptContentJson(err);
        return c.json(corruptContentJsonBody(err), 500);
      }
      throw err;
    }
    // Defensively renumber `\w` occurrence/occurrences from document position
    // so the client never sees malformed/colliding occurrence data (which
    // breaks note-quote highlight, chip colors, and the quote builder — all key
    // words by `${text}|${occurrence}`). No-op on clean verses.
    //
    // Source UHB/UGNT is included: our imported source carries NO x-occurrence
    // on `\w` (usfm-js leaves it undefined), so identical surface forms — e.g.
    // the two כָל in ZEC 5:3 — all collapse to `text|1` and a single note quote
    // lights up every copy. Numbering by position matches the source's own
    // occurrence semantics (and the ULT/UST \zaln-s occurrence: ZEC 5:3's
    // second כָל is occ 2 on both sides). This is display-only — D1 storage and
    // the nightly export still emit source verbatim, so round-trip stays exact.
    const vos = (parsed as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (Array.isArray(vos)) recomputeTargetOccurrences(vos);
    verseMap[v.bible_version][v.verse] = {
      ...rest,
      content: parsed,
      source_generation: (v as VerseRow & { source_generation?: number }).source_generation ?? 1,
    } as VerseDto;
  }

  const payload: ChapterPayload = {
    book,
    chapter,
    verses: verseMap,
    tn: tn.results,
    tq: tq.results,
    twl: twl.results,
    verseStatuses: statuses.results,
    verseLaneChecks: laneChecks.results,
  };
  return c.json(payload);
});

// Toggle / set the done flag for a verse.
const StatusPatch = z.object({ done: z.boolean() });
chapters.patch("/:book/:chapter/:verse/status", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = StatusPatch.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const done = parsed.data.done ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);
  const userId = currentUserId(c);
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO verse_statuses (book, chapter, verse, done, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book, chapter, verse) DO UPDATE SET done = ?4, updated_at = ?5`,
      )
      .bind(book, chapter, verse, done, now),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         VALUES ('verse_status', ?1, ?2, ?3, NULL, NULL, 'update', ?4)`,
      )
      .bind(`${book}/${chapter}/${verse}`, book, userId, JSON.stringify({ done: !!parsed.data.done })),
  ]);
  const row = await c.env.DB.prepare(
    `SELECT * FROM verse_statuses WHERE book = ?1 AND chapter = ?2 AND verse = ?3`,
  )
    .bind(book, chapter, verse)
    .first<VerseStatus>();
  if (row) {
    c.executionCtx.waitUntil(
      broadcastChapter(c.env, row.book, row.chapter, { type: "verse_status.updated", status: row }),
    );
  }
  return c.json(row);
});

// --- Per-resource checkoff lanes (supersedes the single done flag above) ---

function isCheckLane(s: string): s is CheckLane {
  return (CHECK_LANES as readonly string[]).includes(s);
}

async function laneCheckersFor(
  db: D1Database,
  book: string,
  chapter: number,
  verse: number,
  lane: CheckLane,
): Promise<number[]> {
  const r = await db
    .prepare(
      `SELECT checked_by FROM verse_lane_checks
        WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane = ?4
        ORDER BY checked_by`,
    )
    .bind(book, chapter, verse, lane)
    .all<{ checked_by: number }>();
  return r.results.map((x) => x.checked_by);
}

// Toggle MY check stamp on one (verse, lane). Idempotent: re-PUTting the same
// state is a no-op. Returns the full checker set so the client recomputes its
// shade. No version / If-Match — like verse_status, the row is owned by (user,
// lane) so there is nothing to conflict on.
const LaneCheckPatch = z.object({ checked: z.boolean() });
chapters.patch("/:book/:chapter/:verse/lanes/:lane", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const verse = parseInt(c.req.param("verse"), 10);
  const lane = c.req.param("lane");
  if (!book || !Number.isFinite(chapter) || !Number.isFinite(verse) || !isCheckLane(lane)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = LaneCheckPatch.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const mutate = parsed.data.checked
    ? c.env.DB.prepare(
        `INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(book, chapter, verse, lane, checked_by) DO NOTHING`,
      ).bind(book, chapter, verse, lane, userId, now)
    : c.env.DB.prepare(
        `DELETE FROM verse_lane_checks
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane = ?4 AND checked_by = ?5`,
      ).bind(book, chapter, verse, lane, userId);
  await c.env.DB.batch([
    mutate,
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         VALUES ('verse_lane', ?1, ?2, ?3, NULL, NULL, 'update', ?4)`,
      )
      .bind(`${book}/${chapter}/${verse}/${lane}`, book, userId, JSON.stringify({ lane, checked: parsed.data.checked })),
  ]);
  const checkers = await laneCheckersFor(c.env.DB, book, chapter, verse, lane);
  const check = { book, chapter, verse, lane, checkers };
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, book, chapter, { type: "lane_check.updated", check }),
  );
  return c.json(check);
});

// Bulk "I'm done with <lane> for this chapter": add/remove my stamp across the
// supplied verses (the client sends the applicable verse list — it knows which
// verses actually have notes/questions). Returns the chapter+lane set so the
// client reconciles in one shot, and broadcasts a single lane_check.bulk so
// other open tabs reconcile live; per-verse WS would be a fanout storm.
const LaneBulkPatch = z.object({
  checked: z.boolean(),
  verses: z.array(z.number().int().min(0)).min(1).max(400),
});
chapters.patch("/:book/:chapter/lanes/:lane/bulk", requireEditor, async (c) => {
  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  const lane = c.req.param("lane");
  if (!book || !Number.isFinite(chapter) || !isCheckLane(lane)) {
    return c.json({ error: "invalid_params" }, 400);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const parsed = LaneBulkPatch.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const verses = [...new Set(parsed.data.verses)];
  const stmts = verses.map((v) =>
    parsed.data.checked
      ? c.env.DB.prepare(
          `INSERT INTO verse_lane_checks (book, chapter, verse, lane, checked_by, checked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT(book, chapter, verse, lane, checked_by) DO NOTHING`,
        ).bind(book, chapter, v, lane, userId, now)
      : c.env.DB.prepare(
          `DELETE FROM verse_lane_checks
            WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND lane = ?4 AND checked_by = ?5`,
        ).bind(book, chapter, v, lane, userId),
  );
  stmts.push(
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
         VALUES ('verse_lane', ?1, ?2, ?3, NULL, NULL, 'update', ?4)`,
      )
      .bind(`${book}/${chapter}/${lane}/bulk`, book, userId, JSON.stringify({ lane, checked: parsed.data.checked, verses })),
  );
  await c.env.DB.batch(stmts);
  const all = await c.env.DB
    .prepare(`SELECT * FROM verse_lane_checks WHERE book = ?1 AND chapter = ?2 AND lane = ?3`)
    .bind(book, chapter, lane)
    .all<VerseLaneCheck>();
  c.executionCtx.waitUntil(
    broadcastChapter(c.env, book, chapter, {
      type: "lane_check.bulk",
      book,
      chapter,
      lane,
      checks: all.results,
    }),
  );
  return c.json({ book, chapter, lane, checks: all.results });
});

// Book-level summary: chapter list + row counts. Useful for the timeline.
// Also the book-level review rollup (docs/ux-simplification.md A2): each
// chapter additionally reports tnValidated / tqValidated (live rows with
// translation_state='validated' — the 0037/0038 partial indexes keep these
// cheap) and versesDone (verse_statuses.done, the flag setVerseDone writes).
// Additive fields — existing consumers are unaffected.
chapters.get("/:book", async (c) => {
  const book = c.req.param("book").toUpperCase();
  const db = c.env.DB;
  // Resolve lit lane active generation for the ULT verse count filter.
  await ensureLaneState(c.env);
  const litState = await requireLaneState(c.env, "lit");
  const litGen = litState.replacement_required ? -1 : litState.active_generation;
  // Two compound queries batched together: D1 caps the number of terms in a
  // compound SELECT well below stock SQLite (a 7-arm UNION ALL fails at
  // runtime with "too many terms in compound SELECT" — caught against real
  // workerd; node:sqlite happily runs it), so the review-rollup arms live in
  // their own statement and are merged per chapter in JS.
  const [summary, rollup] = await db.batch<{
    chapter: number;
    verses?: number;
    tn?: number;
    tq?: number;
    twl?: number;
    tnValidated?: number;
    tqValidated?: number;
    versesDone?: number;
  }>([
    db
      .prepare(
        `SELECT chapter,
                SUM(CASE WHEN kind='verse' THEN 1 ELSE 0 END) AS verses,
                SUM(CASE WHEN kind='tn' THEN 1 ELSE 0 END) AS tn,
                SUM(CASE WHEN kind='tq' THEN 1 ELSE 0 END) AS tq,
                SUM(CASE WHEN kind='twl' THEN 1 ELSE 0 END) AS twl
         FROM (
           SELECT chapter, 'verse' AS kind FROM verses WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2 AND verse > 0
           UNION ALL
           SELECT chapter, 'tn' FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
           UNION ALL
           SELECT chapter, 'tq' FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
           UNION ALL
           SELECT chapter, 'twl' FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
         )
         GROUP BY chapter ORDER BY chapter`,
      )
      .bind(book, litGen),
    db
      .prepare(
        `SELECT chapter,
                SUM(CASE WHEN kind='tn_validated' THEN 1 ELSE 0 END) AS tnValidated,
                SUM(CASE WHEN kind='tq_validated' THEN 1 ELSE 0 END) AS tqValidated,
                SUM(CASE WHEN kind='verse_done' THEN 1 ELSE 0 END) AS versesDone
         FROM (
           SELECT chapter, 'tn_validated' AS kind FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL AND translation_state = 'validated'
           UNION ALL
           SELECT chapter, 'tq_validated' FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL AND translation_state = 'validated'
           UNION ALL
           SELECT chapter, 'verse_done' FROM verse_statuses WHERE book = ?1 AND done = 1 AND verse > 0
         )
         GROUP BY chapter`,
      )
      .bind(book),
  ]);
  const rollupByChapter = new Map(
    (rollup.results ?? []).map((r) => [r.chapter, r]),
  );
  const merged: ChapterSummaryRow[] = (summary.results ?? []).map((row) => {
    const r = rollupByChapter.get(row.chapter);
    return {
      chapter: row.chapter,
      verses: row.verses ?? 0,
      tn: row.tn ?? 0,
      tq: row.tq ?? 0,
      twl: row.twl ?? 0,
      tnValidated: r?.tnValidated ?? 0,
      tqValidated: r?.tqValidated ?? 0,
      versesDone: r?.versesDone ?? 0,
    };
  });
  // Always offer chapter 0 (the front:intro) for an imported book so a trashed
  // lone intro note stays reachable to restore (see chapterSummary.ts, #756).
  return c.json({ book, chapters: withChapterZero(merged) });
});
