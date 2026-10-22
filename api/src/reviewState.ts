// Admin bulk review-state sweep (issue #296).
//
//   POST /api/books/:book/review-state        (admin only — requireAdmin)
//
// Sets the BASELINE review state for a whole chapter, a chapter range, or a
// whole book, for one resource (tn | tq). The use case is an imported body of
// work whose real status we already know — "this book was checked upstream",
// "chapters 1-5 are approved, the rest needs review" — which today can only be
// expressed one note at a time in the review UI, so the state machine ends up
// describing the importer rather than reality.
//
// ── The decisions, made deliberately (issue #296 asks for exactly this) ─────
//
// 1. NEVER-DRAFTED ROWS ARE IN SCOPE. The per-row validate helpers
//    (setTnTranslationState / setTqTranslationState in rows.ts) are guarded to
//    `translation_state IS NOT NULL` so an imported row the translate pipeline
//    never touched can't be stamped 'validated' and leak into the few-shot
//    gold. This route deliberately LIFTS that guard — those imported rows are
//    the whole point of the feature — and pays for it with the provenance stamp
//    in (3). (Owner decision, 2026-08-27: "Option 1 — bulk-approve MAY validate
//    never-drafted rows, with a provenance stamp so the AI few-shot selector
//    excludes admin bulk sweeps".)
//
// 2. IT OVERWRITES HUMAN-EDITED-BUT-UNAPPROVED ROWS. An 'edited' or 'ai_draft'
//    row in the swept range takes the target state like any other. That is the
//    point of a *baseline* setter — the admin is asserting the status of the
//    whole range — but it is a real overwrite of a translator's in-progress
//    state, so it is a documented choice, not an accident. What it never
//    touches is CONTENT: the sweep writes state columns only.
//
// 3. EVERY SWEPT ROW IS STAMPED `admin_bulk_state` (migration 0071). The AI
//    few-shot pipeline treats `validated` as human-approved gold; a bulk sweep
//    is a statement about a body of work, not a per-row review, so
//    contextExport.ts's validated-examples selectors exclude stamped rows
//    (VALIDATED_TN_EXAMPLES_SQL / VALIDATED_TQ_EXAMPLES_SQL). The stamped value
//    is the state displaced by the FIRST sweep — COALESCE(admin_bulk_state,
//    translation_state, 'none') — so a repeat sweep keeps the original
//    pre-sweep state rather than recording its own output.
//
// 4. DELETED AND TRASHED ROWS ARE NEVER TOUCHED. `deleted_at IS NULL` matches
//    every other query (a sweep must not resurrect a tombstone), and for tn
//    `trashed_at IS NULL` too: a row queued for deletion is not part of the
//    body of work being approved.
//
// 5. NO VERSION BUMP, NO AUTHORSHIP CHANGE. This mirrors the per-row validate
//    helpers exactly: a state flip is not a content edit, so `version` stays put
//    (in-flight If-Match preconditions on open editors stay valid — a sweep must
//    not turn every translator's queued outbox op into a 409) and `updated_by`
//    is left alone (standing authorship is whoever wrote the note, not whoever
//    swept it). `updated_at` does move, so the row sorts as recently touched.
//    The audit trail is edit_log, written per chapter with source =
//    ADMIN_BULK_SOURCE so a sweep is distinguishable from a translator's
//    approval.
//
// 6. SUBREQUEST BUDGET. Writes are SET-BASED — two statements per chapter (one
//    UPDATE, one INSERT ... SELECT into edit_log), not two per row — so a
//    150-chapter book costs 300 statements, batched in chunks under D1's bound
//    limits. Per-row statements would blow the Workers ~1000-subrequest cap on
//    any real book (the failure mode that has bitten this codebase before; see
//    CLAUDE.md on ExportWorkflow).

import type { Context } from "hono";
import type { Env } from "./index";
import { currentUserId } from "./auth.ts";
import { BOOK_NUMBERS } from "./dcsSources.ts";
import { broadcastChapter } from "./wsEvents.ts";
import { lockedResponseBody, translateLockForTnRows } from "./chapterLock.ts";

/** edit_log.source tag for a bulk sweep, and the value stamped on the rows. */
export const ADMIN_BULK_SOURCE = "admin_bulk_state";

/** Statements per D1 batch. Matches aquiferImport's CHUNK. */
const CHUNK = 40;

/**
 * Chapters we fan a WS hint out to after a sweep (issue #395).
 *
 * DECISION: we DO fan out per chapter, including for a whole-book sweep — we do
 * not skip it. The fanout is bounded by construction: only chapters the sweep
 * actually CHANGED get an event, one DO fetch each, and the longest book in the
 * canon is Psalms at 150 chapters. That is the same order of magnitude as
 * broadcastLaneEvent's existing 500-room fanout and sits comfortably inside the
 * Workers subrequest budget alongside the sweep's own handful of D1 batches.
 * Beyond this cap we stop broadcasting rather than risk the budget; a missed
 * hint only means that tab refreshes on its next action (HTTP + If-Match
 * remains the source of truth, per CLAUDE.md's save protocol).
 */
const BROADCAST_CHAPTER_CAP = 150;
/** DO fetches issued concurrently per wave (mirrors broadcastLaneEvent). */
const BROADCAST_CHUNK = 25;

export type ReviewResource = "tn" | "tq";
export type ReviewTarget = "approved" | "needs_review";

/** The translation_state a target maps onto. */
export function stateForTarget(target: ReviewTarget): "validated" | "edited" {
  // 'approved' → validated. 'needs_review' → 'edited', matching the per-row
  // un-approve (POST /rows/:kind/:id/validate with value=0): the row is
  // "reviewed but not approved" and surfaces in the review queue, rather than
  // pretending to be a fresh AI draft.
  return target === "approved" ? "validated" : "edited";
}

export interface ChapterRange {
  start: number;
  end: number;
}

export type ParsedSweepRequest =
  | { ok: true; resource: ReviewResource; target: ReviewTarget; range: ChapterRange | null }
  | { ok: false; error: string };

/**
 * Validate a sweep request body. Pure so it is unit-testable without D1.
 *
 * Accepted scopes, in precedence order:
 *   { chapter: n }                       — one chapter
 *   { chapterStart: a, chapterEnd: b }   — inclusive range (chapterEnd defaults to chapterStart)
 *   { allChapters: true }                — the whole book (range === null)
 * Exactly one scope must be given; an empty body is rejected rather than
 * silently sweeping the whole book.
 */
export function parseSweepRequest(body: Record<string, unknown>): ParsedSweepRequest {
  const resource = body.resource;
  if (resource !== "tn" && resource !== "tq") return { ok: false, error: "invalid_resource" };

  const rawTarget = body.state ?? body.target;
  if (rawTarget !== "approved" && rawTarget !== "needs_review") {
    return { ok: false, error: "invalid_state" };
  }

  const isChapterNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 200;

  const hasChapter = body.chapter !== undefined && body.chapter !== null;
  const hasRange = body.chapterStart !== undefined && body.chapterStart !== null;
  const allChapters = body.allChapters === true;

  // Ambiguity is an error, not a precedence puzzle — a caller that sends both a
  // chapter and allChapters has a bug, and guessing which it meant is how a
  // whole book gets swept by accident.
  if ([hasChapter, hasRange, allChapters].filter(Boolean).length !== 1) {
    return { ok: false, error: "invalid_scope" };
  }

  if (allChapters) return { ok: true, resource, target: rawTarget, range: null };

  if (hasChapter) {
    if (!isChapterNum(body.chapter)) return { ok: false, error: "invalid_chapter" };
    return { ok: true, resource, target: rawTarget, range: { start: body.chapter, end: body.chapter } };
  }

  if (!isChapterNum(body.chapterStart)) return { ok: false, error: "invalid_chapter" };
  const end = body.chapterEnd === undefined || body.chapterEnd === null ? body.chapterStart : body.chapterEnd;
  if (!isChapterNum(end)) return { ok: false, error: "invalid_chapter" };
  if (end < body.chapterStart) return { ok: false, error: "invalid_chapter_range" };
  return { ok: true, resource, target: rawTarget, range: { start: body.chapterStart, end } };
}

/**
 * The rows a sweep may touch (see decision 4 above). tn additionally excludes
 * trashed rows; tq has no trash queue.
 */
export function liveRowsClause(resource: ReviewResource): string {
  return resource === "tn" ? "deleted_at IS NULL AND trashed_at IS NULL" : "deleted_at IS NULL";
}

/**
 * The UPDATE one chapter's sweep issues. Bind: ?1 state, ?2 now, ?3 book, ?4 chapter.
 *
 * SQLite evaluates every SET right-hand side against the row's ORIGINAL values,
 * so `admin_bulk_state = COALESCE(admin_bulk_state, translation_state, 'none')`
 * sees the pre-sweep translation_state even though the same statement is
 * overwriting it. The outer COALESCE on admin_bulk_state makes a repeat sweep
 * idempotent: the stamp keeps the state displaced by the FIRST sweep.
 *
 * `pre_draft_json` is snapshotted on approve for exactly the reason
 * setTnTranslationState does it (migration 0049): the export gate ships the last
 * validated content for a non-validated row, so a validated row must carry a
 * snapshot of what it published. On needs_review the existing snapshot is left
 * alone — an approve that is later withdrawn keeps exporting the once-approved
 * content, matching the per-row un-approve (docs/plan Design 2).
 *
 * Deliberately NOT set: `version` (no bump — in-flight If-Match stays valid) and
 * `updated_by` (authorship is whoever wrote the note). See decision 5.
 */
export function sweepUpdateSql(resource: ReviewResource, target: ReviewTarget): string {
  const table = resource === "tn" ? "tn_rows" : "tq_rows";
  const snapshot =
    target !== "approved"
      ? ""
      : resource === "tn"
        ? ", pre_draft_json = json_object('note', note, 'tags', tags)"
        : ", pre_draft_json = json_object('question', question, 'response', response)";
  return `UPDATE ${table}
             SET translation_state = ?1,
                 admin_bulk_state = COALESCE(admin_bulk_state, translation_state, 'none'),
                 updated_at = ?2${snapshot}
           WHERE book = ?3 AND chapter = ?4 AND ${liveRowsClause(resource)}`;
}

/**
 * The audit INSERT for one chapter's sweep. Bind: ?1 book, ?2 chapter, ?3 user,
 * ?4 action, ?5 source.
 *
 * One edit_log row per swept row (the audit trail is per row, that is the point)
 * but written as a single INSERT ... SELECT so the cost is one statement per
 * chapter. prev_version = new_version = version because the sweep does not bump
 * it. Runs AFTER the UPDATE in the same batch, so it selects exactly the rows
 * the UPDATE just wrote — identified by the admin_bulk_state stamp being present
 * plus the same live-rows clause.
 */
export function sweepAuditSql(resource: ReviewResource): string {
  const table = resource === "tn" ? "tn_rows" : "tq_rows";
  return `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
          SELECT '${resource}', id, book, ?3, version, version, ?4, ?5
            FROM ${table}
           WHERE book = ?1 AND chapter = ?2 AND ${liveRowsClause(resource)}
             AND admin_bulk_state IS NOT NULL`;
}

export interface SweepResult {
  book: string;
  resource: ReviewResource;
  state: ReviewTarget;
  translationState: "validated" | "edited";
  chapters: number[];
  changed: number;
  /** Chapters that actually had rows written, in ascending order. */
  changedChapters: number[];
  broadcastChapters: number;
}

/**
 * Run the sweep. Exported (rather than inlined in the handler) so the
 * node:sqlite journey test can drive the real statements against the real
 * schema instead of re-typing the SQL.
 */
export async function runReviewStateSweep(
  env: Env,
  book: string,
  resource: ReviewResource,
  target: ReviewTarget,
  range: ChapterRange | null,
  userId: number | null,
): Promise<SweepResult> {
  const table = resource === "tn" ? "tn_rows" : "tq_rows";
  // Only chapters that actually hold live rows — sweeping 1..150 blind would
  // burn statements on chapters this book does not have.
  const chapterRs = await env.DB.prepare(
    `SELECT DISTINCT chapter FROM ${table}
      WHERE book = ?1 AND ${liveRowsClause(resource)}
        ${range ? "AND chapter >= ?2 AND chapter <= ?3" : ""}
      ORDER BY chapter`,
  )
    .bind(...(range ? [book, range.start, range.end] : [book]))
    .all<{ chapter: number }>();
  const chapters = (chapterRs.results ?? []).map((r) => Number(r.chapter));

  const nextState = stateForTarget(target);
  const action = target === "approved" ? "validate" : "unvalidate";
  const now = Math.floor(Date.now() / 1000);
  const updateStmt = env.DB.prepare(sweepUpdateSql(resource, target));
  const auditStmt = env.DB.prepare(sweepAuditSql(resource));

  let changed = 0;
  const changedChapters: number[] = [];
  // Two statements per chapter, batched. The UPDATE's meta.changes is the row
  // count for that chapter; the audit INSERT that follows it in the same batch
  // sees the stamped rows.
  for (let i = 0; i < chapters.length; i += CHUNK) {
    const slice = chapters.slice(i, i + CHUNK);
    const stmts = slice.flatMap((ch) => [
      updateStmt.bind(nextState, now, book, ch),
      auditStmt.bind(book, ch, userId ?? null, action, ADMIN_BULK_SOURCE),
    ]);
    const res = await env.DB.batch(stmts);
    slice.forEach((ch, j) => {
      const n = Number(res[j * 2]?.meta?.changes ?? 0);
      if (n > 0) {
        changed += n;
        changedChapters.push(ch);
      }
    });
  }

  return {
    book,
    resource,
    state: target,
    translationState: nextState,
    chapters,
    changed,
    changedChapters,
    broadcastChapters: Math.min(changedChapters.length, BROADCAST_CHAPTER_CAP),
  };
}

/**
 * Fan the "your approval chips are stale" hint out to open chapter editors
 * (issue #395). One coalesced event per changed chapter — broadcasting
 * row.upserted per row would be a fanout storm, and the client only needs to
 * know the chapter's review state moved. See BROADCAST_CHAPTER_CAP for why the
 * whole-book case fans out rather than skipping.
 */
export async function broadcastSweep(env: Env, result: SweepResult): Promise<void> {
  const targets = result.changedChapters.slice(0, BROADCAST_CHAPTER_CAP);
  for (let i = 0; i < targets.length; i += BROADCAST_CHUNK) {
    const slice = targets.slice(i, i + BROADCAST_CHUNK);
    await Promise.all(
      slice.map((ch) =>
        broadcastChapter(env, result.book, ch, {
          type: "chapter.review_state_swept",
          book: result.book,
          chapter: ch,
          resource: result.resource,
          state: result.state,
        }),
      ),
    );
  }
}

/**
 * POST /api/books/:book/review-state — admin-only (wired with requireAdmin in
 * bookImport.ts, which is where every other /api/books route is gated).
 *
 * Body: { resource: "tn" | "tq", state: "approved" | "needs_review",
 *         chapter? | chapterStart?+chapterEnd? | allChapters? }
 * `?dryRun=1` reports the chapters and row count that WOULD be swept and writes
 * nothing — the "confirm before applying, and report how many rows changed"
 * half of the issue's safety requirement, so the admin UI can show a real count
 * in its confirmation rather than a guess.
 */
export async function bulkReviewState(c: Context<{ Bindings: Env; Variables: { userId?: number } }>) {
  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = parseSweepRequest(body ?? {});
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const { resource, target, range } = parsed;
  const dryRun = c.req.query("dryRun") === "1" || body.dryRun === true;

  // An approve sweep over notes an AI translate run will write is undone when
  // the run applies (it sets ai_draft, and the sweep bumps no version for its
  // CAS to catch), so refuse the whole request, dry run included, with the
  // same 409 the per-row Approve returns (issue #602). A needs_review sweep is
  // let through: the apply resets those rows to ai_draft anyway.
  if (resource === "tn" && target === "approved") {
    const rs = await c.env.DB.prepare(
      `SELECT id, chapter, verse, ref_raw FROM tn_rows
        WHERE book = ?1 AND ${liveRowsClause(resource)}
          ${range ? "AND chapter >= ?2 AND chapter <= ?3" : ""}`,
    )
      .bind(...(range ? [book, range.start, range.end] : [book]))
      .all<{ id: string; chapter: number; verse: number; ref_raw: string | null }>();
    const lock = await translateLockForTnRows(c.env, book, rs.results ?? []);
    if (lock) return c.json(lockedResponseBody(lock), 409);
  }

  if (dryRun) {
    const table = resource === "tn" ? "tn_rows" : "tq_rows";
    const rs = await c.env.DB.prepare(
      `SELECT chapter, COUNT(*) AS n FROM ${table}
        WHERE book = ?1 AND ${liveRowsClause(resource)}
          ${range ? "AND chapter >= ?2 AND chapter <= ?3" : ""}
        GROUP BY chapter ORDER BY chapter`,
    )
      .bind(...(range ? [book, range.start, range.end] : [book]))
      .all<{ chapter: number; n: number }>();
    const rows = rs.results ?? [];
    return c.json({
      ok: true,
      dryRun: true,
      book,
      resource,
      state: target,
      translationState: stateForTarget(target),
      chapters: rows.map((r) => Number(r.chapter)),
      wouldChange: rows.reduce((a, r) => a + Number(r.n), 0),
    });
  }

  const result = await runReviewStateSweep(c.env, book, resource, target, range, currentUserId(c));
  // Fanout is a hint, never the source of truth — do it after the commit and
  // outside the response path (broadcastChapter already swallows its own
  // failures; waitUntil keeps a slow DO off the admin's request).
  c.executionCtx.waitUntil(broadcastSweep(c.env, result));
  return c.json({ ok: true, ...result });
}
