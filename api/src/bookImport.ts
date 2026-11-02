// Book list + on-demand import from DCS.
//
// GET  /api/books              — list imported books (existing behaviour).
// POST /api/books/:book/import — pull ULT/UST/UHB-or-UGNT/tn/tq/twl for a
//   single book from DCS, parse, and write into D1. Idempotent: if the
//   book is already in book_imports we short-circuit and return ok.
//
// This is the Worker equivalent of `scripts/import-book.mjs`. Same shape,
// just running server-side so the editor's dropdown can auto-import a book
// on first selection instead of asking the operator to run a CLI.

import { Hono } from "hono";
import type { Env } from "./index";
import {
  extractUsfmHeaders,
  extractVersesForRange,
  makeVerseSortOrder,
  parseTsv,
  refParts,
} from "./importParsers";
import { requireAuth, requireEditor, requireAdmin, currentUserId, currentUserRole } from "./auth";
import { aquiferDrafts, AQUIFER_SOURCE, pickId } from "./aquiferImport.ts";
import { aquiferRepairFormatting } from "./aquiferRepair.ts";
import { bulkReviewState } from "./reviewState.ts";
import { convertAquiferBook, type EnRow, type ResolvedNote } from "./aquiferConvert.ts";
import { loadEnglishLinks } from "./aquiferLinks.ts";
import { aquiferJsonUrl, aquiferLangFor } from "./aquiferSources.ts";
import {
  BOOK_NUMBERS,
  dcsUrls,
  dcsRawUrl,
  dcsResourceFile,
  fileCommitSha,
  fetchText,
  fetchTextWithStatus,
  shouldFallBackOnStatus,
  sourceProvenance,
  translationSourceRepoRef,
  scriptureImportOverrides,
  type DcsRepoOverrides,
} from "./dcsSources";
import { isIdent, parseDoor43SourceRef, type RepoRef } from "./repoUrl";
import { getProjectConfig, type ProjectConfig } from "./projectConfig.ts";
import {
  planBookNoteSources,
  listBookSourceOverrides,
  setBookSourceRange,
  clearBookSourceOverride,
  clearBookSourceRange,
  isBookSourceResource,
  WHOLE_BOOK_START,
  WHOLE_BOOK_END,
  AQUIFER_ORG_SENTINEL,
  type ResolvedSourceRange,
} from "./bookSource.ts";
import { populateReferencedArticles } from "./articlePopulate";
import { bookSourcePlansForClient } from "./sourceNotes.ts";
import type { Context } from "hono";
import { reimportBookFromDcs, recordResourceSync, resourceSourceRef, type Resource } from "./bookReimport";
import { lintTnRows, lintUsfmVerses } from "./lint";
import type { TnRow, VerseRow } from "./types";
import { ensureLaneState, requireLaneState, origSourceGeneration, activeLaneConfig } from "./scriptureLane";
import {
  acquireExportLease,
  releaseExportLease,
  renewExportLease,
} from "./scriptureLaneReplacement";

export const books = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Schedule article population off the import hot path — the fetch fan-out
// (~300-500 tW + ~50-70 tA×3 for a large book) must never run inside the
// importBookFromDcs subrequest budget. waitUntil keeps the response fast and
// lets the population settle after; a failure only logs (edits stay safe, and
// the POLL_CRON backstop + next import catch up).
function schedulePopulate(
  c: Context<{ Bindings: Env; Variables: { userId?: number } }>,
  book: string,
): void {
  const run = populateReferencedArticles(c.env, { book, maxFetches: 150 })
    .catch((e) => console.error("populateReferencedArticles failed", book, e instanceof Error ? e.message : String(e)));
  try {
    c.executionCtx.waitUntil(run);
  } catch {
    // No execution context (e.g. in a test harness) — fire and forget.
    void run;
  }
}

books.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports ORDER BY book`,
  ).all<{ book: string; imported_at: number }>();
  return c.json({ books: rs.results });
});

// GET /api/books/:book/lint — the in-app "issues to clean up" feed for a book.
// Runs the flag/escalate lint (the DCS checks the export can't auto-fix) over the
// book's live D1 rows and returns the issues, each with a ref + (for TN) a row id
// so the UI can jump straight to it. Read-only; any authed user can view.
books.get("/:book/lint", requireAuth, async (c) => {
  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  const tn = await c.env.DB.prepare(
    `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
       ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TnRow>();
  const ult = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();
  const ust = await c.env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'UST' ORDER BY chapter, verse`,
  )
    .bind(book)
    .all<VerseRow>();

  const issues = [
    ...lintTnRows(tn.results ?? []).map((i) => ({ ...i, resource: "tn" })),
    ...lintUsfmVerses(ult.results ?? []).map((i) => ({ ...i, resource: "ult" })),
    ...lintUsfmVerses(ust.results ?? []).map((i) => ({ ...i, resource: "ust" })),
  ];
  const flagCount = issues.filter((i) => i.bucket === "flag").length;
  const escalateCount = issues.filter((i) => i.bucket === "escalate").length;
  return c.json({ book, total: issues.length, flagCount, escalateCount, issues });
});

// POST /api/books/:book/aquifer-drafts — re-source this book's tN from Aquifer as
// unapproved drafts merged onto the en_tn skeleton (admin-only).
books.post("/:book/aquifer-drafts", requireAdmin, aquiferDrafts);

// POST /api/books/:book/aquifer-repair — rewrite the markdown formatting of notes
// already imported from Aquifer, for the rows the import itself cannot repair
// (approved/edited ones). `?dryRun=1` reports the counts without writing.
books.post("/:book/aquifer-repair", requireAdmin, aquiferRepairFormatting);

// POST /api/books/:book/review-state — set the baseline review state (approved /
// needs review) for a chapter, chapter range, or the whole book, for tn or tq
// (admin-only; issue #296). `?dryRun=1` reports the counts without writing.
// Every swept row is stamped `admin_bulk_state` so the AI few-shot selectors
// exclude it — see the decisions written up in reviewState.ts.
books.post("/:book/review-state", requireAdmin, bulkReviewState);

// ── Per-book / per-chapter-range source overrides (issue #103) ─────────────
// GET  /api/books/:book/sources — list this book's per-resource source ranges.
// PUT  /api/books/:book/sources — set/clear one range (admin). Takes effect on
//   the next import of the book (POST /:book/import): the chosen source is
//   fetched per chapter range, its rows stamped, and those chapters held out of
//   the nightly reimport/export.
books.get("/:book/sources", requireAuth, async (c) => {
  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 404);
  const overrides = await listBookSourceOverrides(c.env, book);
  // Which source each chapter's English tN source note is read from (#691),
  // resolved here so the web app's Source panel follows the same rules as
  // import and the chat tools. null for an authoring project; a plan that
  // could not be resolved is left out of the response (#697), and the
  // overrides list above still answers.
  // tqQuestionSources is the same for the English source question (#695).
  const { tnNoteSources, tqQuestionSources } = await bookSourcePlansForClient(c.env, book);
  return c.json({ book, overrides, tnNoteSources, tqQuestionSources });
});

// Body:
//   set whole book : { resource, url|org+repo }
//   set a range    : { resource, url|org+repo, chapterStart, chapterEnd }
//   clear a range  : { resource, clear: true, chapterStart }
//   clear resource : { resource, clear: true }
// A pasted Door43 URL is parsed + ident-validated the same way #84's
// verify-source does. REPO EXISTENCE is NOT checked here — the caller verifies
// via GET /api/orgs/verify-source first, matching the decoupled project-wide flow.
books.put("/:book/sources", requireAdmin, async (c) => {
  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 404);
  let body: {
    resource?: unknown;
    kind?: unknown;
    url?: unknown;
    org?: unknown;
    repo?: unknown;
    clear?: unknown;
    chapterStart?: unknown;
    chapterEnd?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const resource = typeof body.resource === "string" ? body.resource : "";
  if (!isBookSourceResource(resource)) {
    return c.json({ error: "unsupported_resource", resource }, 400);
  }
  const hasStart = body.chapterStart !== undefined;
  const hasEnd = body.chapterEnd !== undefined;

  // CLEAR is handled first, and needs only chapterStart (chapterEnd is irrelevant
  // when removing a range by its start) — so the both-bounds check below, which
  // applies to SET, must not reject a clear that carries just chapterStart.
  if (body.clear === true) {
    if (hasStart) {
      const cs = Number(body.chapterStart);
      if (!Number.isInteger(cs)) return c.json({ error: "invalid_range" }, 400);
      await clearBookSourceRange(c.env, book, resource, cs);
      return c.json({ book, resource, chapterStart: cs, cleared: true });
    }
    await clearBookSourceOverride(c.env, book, resource);
    return c.json({ book, resource, cleared: true });
  }

  // SET. Chapter bounds absent → whole book (0, 999). A partial pair (only one of
  // the two) is rejected — it's almost certainly a client mistake.
  if (hasStart !== hasEnd) {
    return c.json({ error: "range_needs_both_bounds" }, 400);
  }
  const chapterStart = hasStart ? Number(body.chapterStart) : WHOLE_BOOK_START;
  const chapterEnd = hasEnd ? Number(body.chapterEnd) : WHOLE_BOOK_END;
  if (hasStart && (!Number.isInteger(chapterStart) || !Number.isInteger(chapterEnd))) {
    return c.json({ error: "invalid_range" }, 400);
  }

  const userId = currentUserId(c) ?? null;

  // Aquifer variant: no url/org/repo — the aqLang is derived from the project's
  // language. tN only; a chapter range is required (whole-book Aquifer belongs to
  // the aquifer-drafts route, which does merge-and-preserve). The stored row is
  // kind='aquifer', org=sentinel, repo=aqLang.
  if (body.kind === "aquifer") {
    if (resource !== "tn") return c.json({ error: "aquifer_tn_only" }, 400);
    if (!hasStart) return c.json({ error: "aquifer_needs_range" }, 400);
    const cfg = await getProjectConfig(c.env);
    const aqLang = aquiferLangFor(cfg.languageCode);
    if (!aqLang) return c.json({ error: "aquifer_language_unavailable", languageCode: cfg.languageCode }, 400);
    try {
      await setBookSourceRange(c.env, book, resource, chapterStart, chapterEnd, "aquifer", AQUIFER_ORG_SENTINEL, aqLang, userId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "overlapping_range") return c.json({ error: msg }, 409);
      if (
        msg === "invalid_range" ||
        msg === "aquifer_needs_range" ||
        msg === "aquifer_tn_only" ||
        msg === "invalid_aquifer_lang"
      ) {
        return c.json({ error: msg }, 400);
      }
      throw e;
    }
    return c.json({ book, resource, chapterStart, chapterEnd, kind: "aquifer", aqLang });
  }

  let org: string;
  let repo: string;
  if (typeof body.url === "string" && body.url.trim()) {
    const parsed = parseDoor43SourceRef(body.url);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    org = parsed.org;
    repo = parsed.repo;
  } else if (typeof body.org === "string" && typeof body.repo === "string") {
    org = body.org.trim();
    repo = body.repo.trim();
  } else {
    return c.json({ error: "expected_url_or_org_repo" }, 400);
  }
  // Defense in depth: reject a non-ident org/repo before it can be persisted
  // (the resolver re-validates on read, but never store a value we know is bad).
  if (!isIdent(org) || !isIdent(repo)) {
    return c.json({ error: "invalid_org_or_repo", org, repo }, 400);
  }
  try {
    await setBookSourceRange(c.env, book, resource, chapterStart, chapterEnd, "dcs", org, repo, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "overlapping_range") return c.json({ error: msg }, 409);
    if (msg === "invalid_range" || msg === "invalid_org_or_repo") return c.json({ error: msg }, 400);
    throw e;
  }
  return c.json({ book, resource, chapterStart, chapterEnd, org, repo });
});

books.post("/:book/import", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  const num = BOOK_NUMBERS[book];
  if (!num) return c.json({ error: "unknown_book", book }, 400);

  // Optional body: { translateFromSource?, force?, confirmDiscardEdits? }. A
  // missing/invalid/empty body is normal (the UI's plain import posts nothing),
  // so never 4xx on it. Parsed up here because `force` gates the two early
  // returns below.
  let body: { translateFromSource?: unknown; force?: unknown; confirmDiscardEdits?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* no body → default options */
  }
  const translateFromSource = body?.translateFromSource === true;
  const force = body?.force === true;

  // force re-imports a book that is ALREADY imported — the only way to reach
  // the translate-from-source path for a book that was bootstrapped before the
  // feature existed (e.g. BSOJ/MAL). It wipes and re-loads the book, so it is
  // admin-only; the normal (non-forced) import stays editor-accessible, hence
  // the check lives here rather than on the route.
  if (force && currentUserRole(c) !== "admin") {
    return c.json({ error: "forbidden", detail: "force requires admin" }, 403);
  }

  if (force) {
    // Safety gate: importBookFromDcs wipes tn_rows, tq_rows, twl_rows, verses
    // (ULT/UST + original-language) and book_usfm_meta for the book, then
    // re-inserts from DCS — so ANY of those tables can hold destroyed human
    // work, not just tn/tq. (This gap — twl/verses edits sailing through with
    // no 409 — is exactly what review of PR #54 flagged as a HIGH-severity
    // data-loss bug: the UI's "Re-source notes from English" label gives an
    // admin no reason to expect scripture loss.) Count rows that represent
    // real human work in every wiped table — translation_state
    // 'edited'/'validated' (migrations 0037/0038, tn/tq only — twl/verses have
    // no translation_state column) or any row a user has touched (updated_by
    // non-NULL, the same pristine predicate the reimport uses) — and refuse
    // unless the caller has explicitly acknowledged the loss.
    const edits = await c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL
            AND (translation_state IN ('edited','validated') OR updated_by IS NOT NULL)) AS tn,
         (SELECT COUNT(*) FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
            AND (translation_state IN ('edited','validated') OR updated_by IS NOT NULL)) AS tq,
         (SELECT COUNT(*) FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
            AND updated_by IS NOT NULL) AS twl,
         (SELECT COUNT(*) FROM verses WHERE book = ?1 AND updated_by IS NOT NULL) AS verses`,
    )
      .bind(book)
      .first<{ tn: number; tq: number; twl: number; verses: number }>();
    const tnEdits = edits?.tn ?? 0;
    const tqEdits = edits?.tq ?? 0;
    const twlEdits = edits?.twl ?? 0;
    const verseEdits = edits?.verses ?? 0;
    if (tnEdits + tqEdits + twlEdits + verseEdits > 0 && body?.confirmDiscardEdits !== true) {
      return c.json(
        { error: "has_local_edits", book, tn: tnEdits, tq: tqEdits, twl: twlEdits, verses: verseEdits },
        409,
      );
    }
    // Destructive + irreversible from the app's side: leave a trace of who did
    // it, to what, and how much work it discarded.
    console.warn("forced book import: wiping and re-loading from DCS", {
      book,
      userId,
      translateFromSource,
      discardedEdits: { tn: tnEdits, tq: tqEdits, twl: twlEdits, verses: verseEdits },
    });
  }

  // Idempotency: already imported → fast path (skipped by force).
  const existing = await c.env.DB.prepare(
    `SELECT book, imported_at FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first<{ book: string; imported_at: number }>();
  if (existing && !force) {
    schedulePopulate(c, book);
    return c.json({ ok: true, book, alreadyImported: true, imported_at: existing.imported_at });
  }

  // Orphan recovery: a prior import inserted rows but crashed before writing the
  // final book_imports marker. That marker is the LAST write, so a clean crash
  // leaves the FULL resource set present — only then is it safe to re-register
  // without re-fetching. We therefore require ULT, UST, TN, TQ and TWL to all be
  // non-empty. A partial leftover (e.g. the original-language source survived a
  // delete but the translations/notes were removed) must NOT be mistaken for a
  // recoverable import: it falls through to the clean wipe-and-import below,
  // which re-fetches every resource from DCS.
  //
  // (Previously this checked only "any verse exists", so a book left with just
  // its UHB/UGNT source got stamped source_url='recovered' and could never be
  // re-imported — the marker made every later POST hit the alreadyImported fast
  // path above. This is exactly how ISA got stuck with Hebrew-only content.)
  //
  // force skips this too: a forced caller wants a real re-fetch, not a marker
  // that re-registers whatever rows happen to be lying around.
  const present = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'ULT') AS ult,
       (SELECT COUNT(*) FROM verses   WHERE book = ?1 AND bible_version = 'UST') AS ust,
       (SELECT COUNT(*) FROM tn_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tn,
       (SELECT COUNT(*) FROM tq_rows  WHERE book = ?1 AND deleted_at IS NULL)    AS tq,
       (SELECT COUNT(*) FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL)    AS twl`,
  )
    .bind(book)
    .first<{ ult: number; ust: number; tn: number; tq: number; twl: number }>();
  const looksComplete =
    !!present &&
    present.ult > 0 &&
    present.ust > 0 &&
    present.tn > 0 &&
    present.tq > 0 &&
    present.twl > 0;
  if (looksComplete && !force) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO book_imports (book, source_url, imported_at, imported_by)
       VALUES (?1, 'recovered', unixepoch(), ?2)`,
    )
      .bind(book, userId)
      .run();
    schedulePopulate(c, book);
    return c.json({ ok: true, book, recovered: true });
  }

  // Cross-isolate import lock — `INSERT OR IGNORE` on the PK gives us an
  // atomic "first writer wins" handshake. The previous in-memory Set was
  // per-Worker-isolate, so a second POST that happened to land on a
  // different edge node would have raced the DELETE-then-INSERT pipeline
  // below and double-imported the book. A stale lock from a crashed Worker
  // is reclaimed by the */5 sweep in api/src/index.ts.
  const lock = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, unixepoch(), ?2)`,
  )
    .bind(book, userId)
    .run();
  if (!lock.meta.changes) {
    return c.json({ error: "in_progress", book }, 409);
  }

  try {
    const result = await importBookFromDcs(c.env, book, num, userId, { translateFromSource });
    schedulePopulate(c, book);
    return c.json({ ok: true, book, ...result, ...(force ? { forced: true } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A completeness failure where EVERY missing resource was a hard 404 is
    // permanent (the org simply has no file for this book) — return 422 so a
    // caller can distinguish it from a transient/mixed failure (kept at 502).
    const permanent = !!(e && typeof e === "object" && (e as { permanent?: boolean }).permanent);
    return c.json({ error: "import_failed", book, message: msg }, permanent ? 422 : 502);
  } finally {
    await c.env.DB.prepare(
      `DELETE FROM book_import_locks WHERE book = ?1`,
    )
      .bind(book)
      .run();
  }
});

// POST /api/books/:book/reimport — non-destructive per-chapter, per-resource
// re-import from DCS. Required body: { chapters: number[], resources: Resource[] }.
// Skips rows that have been edited locally (see bookReimport.ts for the
// pristine predicate). Requires the book to be bootstrapped (404 otherwise);
// reuses book_import_locks (409 in_progress if held).
const ALLOWED_RESOURCES: ReadonlyArray<Resource> = ["ult", "ust", "tn", "tq", "twl"];

books.post("/:book/reimport", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = c.req.param("book").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  let body: { chapters?: unknown; resources?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_body" }, 422);
  }
  const chapters = Array.isArray(body.chapters)
    ? body.chapters
        .map((n) => (typeof n === "number" ? Math.floor(n) : NaN))
        .filter((n) => Number.isFinite(n) && n >= 1)
    : [];
  const resources = Array.isArray(body.resources)
    ? body.resources.filter((r): r is Resource =>
        typeof r === "string" && (ALLOWED_RESOURCES as readonly string[]).includes(r),
      )
    : [];
  if (chapters.length === 0) {
    return c.json({ error: "invalid_body", detail: "chapters must be a non-empty list of positive integers" }, 422);
  }
  if (resources.length === 0) {
    return c.json({ error: "invalid_body", detail: "resources must include at least one of ult/ust/tn/tq/twl" }, 422);
  }

  try {
    const result = await reimportBookFromDcs(c.env, book, chapters, resources, userId, { source: "user" });
    // New tn/twl content can reference articles not yet populated — repopulate.
    if (resources.includes("tn") || resources.includes("twl")) schedulePopulate(c, book);
    return c.json({ ok: true, ...result });
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "";
    if (name === "BookNotImportedError") return c.json({ error: "book_not_imported", book }, 404);
    if (name === "ImportInProgressError") return c.json({ error: "in_progress", book }, 409);
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: "reimport_failed", book, message: msg }, 502);
  }
});

interface ImportCounts {
  verses: number;
  tn: number;
  tq: number;
  twl: number;
  fetched: { ult: boolean; ust: boolean; orig: boolean; tn: boolean; tq: boolean; twl: boolean };
  /** Resource-source provenance: 'source:<owner>/<repo>' when the resource came
   *  from the project's English translationSource instead of the org/lane's own
   *  repo, else null. tn/tq additionally support 'aquifer:<lang>'; ult/ust/twl
   *  have no Aquifer path (issue #142). */
  sources: {
    tn: string | null;
    tq: string | null;
    ult: string | null;
    ust: string | null;
    twl: string | null;
  };
}

// Fetch each per-chapter-range source file for a note resource (issue #103
// Tier 2). Returns [{ range, raw }] in range order; THROWS if any configured
// range's file cannot be fetched — a missing range source must fail the import,
// never silently leave those chapters to the base source.
async function fetchRangeNoteFiles(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  resource: "tn" | "tq",
  ranges: ResolvedSourceRange[],
): Promise<Array<{ range: ResolvedSourceRange; raw: string }>> {
  const out: Array<{ range: ResolvedSourceRange; raw: string }> = [];
  for (const range of ranges) {
    if (range.source.kind !== "dcs") continue; // aquifer ranges take the JSON path
    const ref = range.source.ref;
    const urls = dcsUrls(env, cfg, book, { [resource]: ref });
    if (!urls) throw new Error(`unknown book: ${book}`);
    const url = urls[resource];
    const raw = await fetchText(url);
    if (raw == null) {
      throw new Error(
        `range source ${ref.owner}/${ref.repo} has no ${resource} file for ${book} ` +
          `(chapters ${range.chapter_start}-${range.chapter_end}): ${url}`,
      );
    }
    out.push({ range, raw });
  }
  return out;
}

// Aquifer per-chapter-range notes (issue #103 follow-up). Fetches the en_tn
// skeleton ONCE (via the project's translationSource) plus the Aquifer JSON for
// the book, converts with the shared converter, and returns each range's notes
// filtered to its chapters. tN only. A missing translationSource, en_tn file, or
// Aquifer JSON is a HARD error — never silently fall back to the base source for
// those chapters (that would import the wrong content and skip the hold-out).
async function fetchAquiferRangeNotes(
  env: Env,
  cfg: ProjectConfig,
  book: string,
  ranges: ResolvedSourceRange[],
): Promise<Array<{ range: ResolvedSourceRange; aqLang: string; notes: ResolvedNote[] }>> {
  const aquiferRanges = ranges.filter((r) => r.source.kind === "aquifer");
  if (aquiferRanges.length === 0) return [];

  // en_tn skeleton — the join target Aquifer notes graft onto.
  const enRef = translationSourceRepoRef(cfg, "tn");
  if (!enRef) throw new Error("aquifer_requires_translation_source");
  const enRaw = await fetchText(dcsRawUrl(env, enRef.owner, enRef.repo, `tn_${book}.tsv`));
  if (enRaw == null) {
    throw new Error(`aquifer range: en_tn fetch failed for ${book} (${enRef.owner}/${enRef.repo})`);
  }
  const enRows: EnRow[] = parseTsv(enRaw).rows
    .map((r) => ({
      Reference: r["Reference"] ?? "",
      ID: r["ID"] ?? "",
      Tags: r["Tags"] ?? "",
      SupportReference: r["SupportReference"] ?? "",
      Quote: r["Quote"] ?? "",
      Occurrence: r["Occurrence"] ?? "",
      Note: r["Note"] ?? "",
    }))
    .filter((r) => r.ID);

  // All aquifer ranges for a book share the project-derived aqLang; fetch+convert once.
  const aqLang = aquiferRanges[0].source.kind === "aquifer" ? aquiferRanges[0].source.aqLang : "";
  const aqUrl = aquiferJsonUrl(aqLang, book);
  if (!aqUrl) throw new Error(`aquifer range: no Aquifer URL for ${book} (${aqLang})`);
  const aqRaw = await fetchText(aqUrl);
  if (aqRaw == null) throw new Error(`aquifer range: Aquifer JSON fetch failed for ${book} (${aqLang}): ${aqUrl}`);
  let aqItems: unknown;
  try {
    aqItems = JSON.parse(aqRaw);
  } catch {
    throw new Error(`aquifer range: Aquifer JSON parse failed for ${book} (${aqLang})`);
  }
  if (!Array.isArray(aqItems)) throw new Error(`aquifer range: Aquifer JSON shape unexpected for ${book}`);

  // Link-first join (metadata.json); throws on a failed read rather than falling
  // back to the quote-first join, which can pick the wrong en_tn row.
  const links = await loadEnglishLinks(aqLang, aqItems as Parameters<typeof loadEnglishLinks>[1]);
  const { notes } = convertAquiferBook(aqItems as Parameters<typeof convertAquiferBook>[0], enRows, links);

  return aquiferRanges.map((range) => {
    const inRange = notes.filter((n) => {
      const [ch] = refParts(n.ref);
      return ch >= range.chapter_start && ch <= range.chapter_end;
    });
    return { range, aqLang, notes: inRange };
  });
}

// Pre-wipe scan (issue #126 cold-review follow-up): a row id repeated WITHIN
// one source file (the base file or a single range file) is a malformed TSV,
// not a legitimate cross-source collision, and must still abort — it is NOT
// safe to let insertMergedNotes' cross-file remap below absorb it. Threading
// one `usedIds` Set through every row of a single file's own insert() call
// means that Set can't otherwise distinguish "this id belongs to another
// file" from "this file used its own id twice"; without this scan the second
// occurrence would be silently re-minted (data loss: the note's own id is
// discarded) instead of the abort a malformed file deserves. Mirrors
// insertMergedNotes' exact chapter partitioning so it predicts the real
// per-file insert set, but — unlike the old (pre-#126) mergedNoteIdCollision
// this replaces — resets `seen` per file, since a cross-file repeat is now
// the legitimate, intentionally-remapped case, not a duplicate to reject.
function mergedNoteSameFileDuplicate(
  baseRaw: string | null,
  ranges: ResolvedSourceRange[],
  rangeFiles: Array<{ range: ResolvedSourceRange; raw: string }>,
): string | null {
  if (ranges.length === 0) return null;
  const covered = (ch: number) => ranges.some((r) => ch >= r.chapter_start && ch <= r.chapter_end);
  const scanOneFile = (raw: string | null, include: (ch: number) => boolean): string | null => {
    if (!raw) return null;
    const seen = new Set<string>();
    for (const r of parseTsv(raw).rows) {
      const id = r["ID"];
      if (!id) continue;
      const [ch] = refParts(r["Reference"] ?? "");
      if (!include(ch)) continue;
      if (seen.has(id)) return id;
      seen.add(id);
    }
    return null;
  };
  const baseDup = scanOneFile(baseRaw, (ch) => !covered(ch));
  if (baseDup) return baseDup;
  for (const { range, raw } of rangeFiles) {
    const dup = scanOneFile(raw, (ch) => ch >= range.chapter_start && ch <= range.chapter_end);
    if (dup) return dup;
  }
  return null;
}

// Merge multiple per-chapter source files into one book's note rows (issue #103
// Tier 2). The base file contributes only chapters NOT covered by any range;
// each range file contributes only its own chapters. With no ranges this is a
// single unfiltered insert — byte-for-byte the Tier 1 path.
//
// The whole-book DELETE has already run (caller), so these are pure inserts into
// an empty book. A cross-source ID collision (two source repos using the same tn
// id for the SAME book in DIFFERENT chapters) is remapped rather than aborted
// (issue #126 follow-up to #103): `usedIds` is shared across the base file and
// every range file in insertion order, so the base file always keeps its ids and
// a later range file's colliding id is re-minted via the same `pickId`/`mintId`
// primitive `insertAquiferRangeNotes` already uses for inherited en_tn ids. A
// single file's own internal duplicate ids are a DIFFERENT concern — caller
// rejects those pre-wipe via `mergedNoteSameFileDuplicate` above, since letting
// this function's shared `usedIds` absorb them would silently re-mint (not
// reject) a malformed file's repeated id.
async function insertMergedNotes(
  insert: (raw: string | null, filter?: (ch: number) => boolean, usedIds?: Set<string>) => Promise<number>,
  baseRaw: string | null,
  ranges: ResolvedSourceRange[],
  rangeFiles: Array<{ range: ResolvedSourceRange; raw: string }>,
  renew: () => Promise<void>,
  aquiferInserts: Array<{ run: () => Promise<number> }> = [],
): Promise<number> {
  if (ranges.length === 0) {
    // No cross-source ranges: the base file is the whole book (Tier 1 fast path).
    // Still run any aquifer inserts — belt-and-suspenders, since a non-empty
    // aquiferInserts should always coincide with an aquifer range in `ranges`.
    let baseOnly = await insert(baseRaw);
    for (const { run } of aquiferInserts) {
      await renew();
      baseOnly += await run();
    }
    return baseOnly;
  }
  // `covered` spans BOTH dcs and aquifer ranges so the base file never re-inserts
  // a chapter a cross-source range owns. Order: base → dcs range files → aquifer
  // ranges last (their id minting reads the ids base+dcs already landed).
  const covered = (ch: number) => ranges.some((r) => ch >= r.chapter_start && ch <= r.chapter_end);
  const usedIds = new Set<string>();
  let total = await insert(baseRaw, (ch) => !covered(ch), usedIds);
  for (const { range, raw } of rangeFiles) {
    await renew();
    total += await insert(raw, (ch) => ch >= range.chapter_start && ch <= range.chapter_end, usedIds);
  }
  for (const { run } of aquiferInserts) {
    await renew();
    total += await run();
  }
  return total;
}

async function importBookFromDcs(
  env: Env,
  book: string,
  _num: string,
  userId: number,
  opts: { translateFromSource?: boolean } = {},
): Promise<ImportCounts> {
  // Assert lanes not frozen before starting import. A frozen lane (an open
  // replacement job) or a lane that still requires a replacement (BSOJ
  // transitional gen-1 quarantine) must not accept a fresh scripture import —
  // it would write gen-1 rows the replacement is meant to supersede.
  await ensureLaneState(env);
  const litState = await requireLaneState(env, "lit");
  const simState = await requireLaneState(env, "sim");
  if (litState.replacement_job_id) throw new Error("lit_lane_frozen_for_replacement");
  if (simState.replacement_job_id) throw new Error("sim_lane_frozen_for_replacement");
  if (litState.replacement_required) throw new Error("lit_lane_replacement_required");
  if (simState.replacement_required) throw new Error("sim_lane_replacement_required");

  const cfg = await getProjectConfig(env);

  // Opting in to translate-from-source only makes sense on a translation
  // project; without a configured translationSource there is nothing to pull.
  if (opts.translateFromSource && !cfg.translationSource) {
    throw new Error("not_a_translation_project");
  }

  // Per-resource note source plan (issue #103). Each resolves, in precedence
  // order: per-chapter-range override → whole-book override → project-wide
  // translationSource → org's own repo. `base` is the source for chapters NOT
  // covered by a cross-org range (project-wide, or null = org's own); `ranges`
  // are the cross-org per-chapter ranges to splice in.
  //
  // `noteSource.tn/tq` = the BASE ref. It drives (a) the base-file fetch URL and
  // (b) the book_imports.tn_source/tq_source marker: a non-null base means the
  // WHOLE book is off-org → whole-book hold-out marker; a null base (org's own
  // for uncovered chapters) with ranges → marker stays NULL and the range table
  // (heldOutChapters) drives PER-CHAPTER hold-out. This keeps the base fetch,
  // the 404 fallback, and provenance stamping exactly as before for a book with
  // no per-chapter ranges (Tier 1), and correct for a partially-sourced book.
  const tnPlan = await planBookNoteSources(env, cfg, book, "tn", !!opts.translateFromSource);
  const tqPlan = await planBookNoteSources(env, cfg, book, "tq", !!opts.translateFromSource);
  const noteSource: { tn: RepoRef | null; tq: RepoRef | null } = {
    tn: tnPlan.base,
    tq: tqPlan.base,
  };

  // Use lane source refs from active config for scripture USFM URLs, unless
  // translating from source: then ULT/UST/TWL should also come from the
  // project's configured English translationSource (same reasoning as
  // tn/tq below) rather than the org's own — possibly scaffold-only —
  // repos, falling back to the lane/org default when the source has no
  // ref for that role.
  const litCfg = activeLaneConfig(litState);
  const simCfg = activeLaneConfig(simState);
  const translateFromSource = !!opts.translateFromSource;
  const scriptureOverrides = scriptureImportOverrides(cfg, translateFromSource, litCfg.source, simCfg.source, {
    lit: litCfg.textReadOnly,
    sim: simCfg.textReadOnly,
  });
  const overrides: DcsRepoOverrides = {
    lit: scriptureOverrides.lit,
    sim: scriptureOverrides.sim,
    ...(scriptureOverrides.twl ? { twl: scriptureOverrides.twl } : {}),
    ...(noteSource.tn ? { tn: noteSource.tn } : {}),
    ...(noteSource.tq ? { tq: noteSource.tq } : {}),
  };
  const urls = dcsUrls(env, cfg, book, overrides);
  if (!urls) throw new Error(`unknown book: ${book}`);
  const origVersion = urls.origVersion;

  // Fire all six fetches in parallel. unfoldingWord's repos carry every
  // resource for every supported book, so any null here is a transient DCS
  // issue (timeout, 5xx, partial outage). Marking the book as imported with
  // a critical resource missing leaves it silently broken — see the ZEC
  // bootstrap that landed without TWLs. Fail loudly so the next attempt
  // succeeds cleanly.
  // `let`: tn/tq may be replaced by the translation-source fallback below.
  let [ultRaw, ustRaw, origRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    fetchText(urls.ult),
    fetchText(urls.ust),
    fetchText(urls.orig),
    fetchText(urls.tn),
    fetchText(urls.tq),
    fetchText(urls.twl),
  ]);

  // Automatic fallback: the org GENUINELY has no tn/tq file for this book. On a
  // translation project the English source always carries one, so pull it from
  // there rather than failing the whole import, and mark the provenance so the
  // nightly reimport/export hold that resource out.
  //
  // 404-ONLY, deliberately. fetchText above collapses 404 / 5xx / network error
  // / truncated read all into null, and substituting English on a transient
  // failure would import the wrong language during a DCS outage AND permanently
  // hold the book out of reimport+export. So we re-probe the org URL with
  // fetchTextWithStatus and fall back only on a hard 404 (shouldFallBackOnStatus);
  // anything else falls through to the missing/throw path below and is retried.
  const noteUrls: Record<"tn" | "tq", string> = { tn: urls.tn, tq: urls.tq };
  // The fallback (translation-source) URL actually attempted for a note
  // resource, if any. Retained even when the fallback fetch fails so the
  // failure-path classifier below can re-probe BOTH the primary AND the
  // fallback and only mark the resource permanently missing when both are hard
  // 404s (a transient fallback failure must not masquerade as permanent).
  const noteFallbackAttempt: Partial<Record<"tn" | "tq" | "ult" | "ust", string>> = {};
  // tn and tq are independent (disjoint noteSource/noteUrls keys), so run both
  // fallback probes concurrently rather than serially — a book missing both
  // files otherwise pays for 4 sequential DCS round-trips instead of 2 pairs
  // in parallel. Each resource still does its OWN probe (fetchTextWithStatus)
  // then its own primary-shaped fetch (fetchText, which retries once on
  // network-error/truncation — that retry is the twl_PSA / HAB truncation
  // guard, so it must stay fetchText and not be swapped for fetchTextWithStatus).
  const [tnFallback, tqFallback] = await Promise.all(
    (["tn", "tq"] as const).map(async (resource) => {
      const raw = resource === "tn" ? tnRaw : tqRaw;
      if (raw != null || noteSource[resource]) return null;
      const ref = translationSourceRepoRef(cfg, resource);
      if (!ref) return null;
      const probe = await fetchTextWithStatus(env, noteUrls[resource]);
      if (!shouldFallBackOnStatus(probe.status)) return null;
      const fallbackUrls = dcsUrls(env, cfg, book, { ...overrides, [resource]: ref })!;
      const url = fallbackUrls[resource];
      noteFallbackAttempt[resource] = url;
      const fetched = await fetchText(url);
      if (fetched == null) return null;
      console.warn("import: org note file absent; falling back to translation source", {
        book,
        resource,
        url,
      });
      return { ref, url, fetched };
    }),
  );
  if (tnFallback) {
    noteSource.tn = tnFallback.ref;
    noteUrls.tn = tnFallback.url;
    tnRaw = tnFallback.fetched;
  }
  if (tqFallback) {
    noteSource.tq = tqFallback.ref;
    noteUrls.tq = tqFallback.url;
    tqRaw = tqFallback.fetched;
  }

  // Scripture lanes: same 404-ONLY rule. The lane repo (the project's own
  // ULT/UST text — e.g. BSOJ ar_avd/ar_nav) was fetched first above; only when
  // it genuinely has no file for this book, and the lane is not locked, does a
  // translate-mode import pull the English translationSource instead (a
  // scaffold-only org) and stamp ult_source/ust_source so reimport/export hold
  // that lane out. See scriptureImportOverrides for why this is not eager.
  const [ultFallback, ustFallback] = await Promise.all(
    (["ult", "ust"] as const).map(async (resource) => {
      const role = resource === "ult" ? "lit" : "sim";
      const raw = resource === "ult" ? ultRaw : ustRaw;
      const ref = scriptureOverrides.fallback[role];
      if (raw != null || !ref) return null;
      const probe = await fetchTextWithStatus(env, urls[resource]);
      if (!shouldFallBackOnStatus(probe.status)) return null;
      const fallbackUrls = dcsUrls(env, cfg, book, { ...overrides, [role]: ref })!;
      const url = fallbackUrls[resource];
      noteFallbackAttempt[resource] = url;
      const fetched = await fetchText(url);
      if (fetched == null) return null;
      console.warn("import: lane scripture file absent; falling back to translation source", {
        book,
        resource,
        url,
      });
      return { ref, url, fetched };
    }),
  );
  if (ultFallback) {
    scriptureOverrides.lit = ultFallback.ref;
    scriptureOverrides.fromSource.lit = true;
    urls.ult = ultFallback.url;
    ultRaw = ultFallback.fetched;
  }
  if (ustFallback) {
    scriptureOverrides.sim = ustFallback.ref;
    scriptureOverrides.fromSource.sim = true;
    urls.ust = ustFallback.url;
    ustRaw = ustFallback.fetched;
  }

  const missing: Array<{ label: string; url: string }> = [];
  if (!ultRaw) missing.push({ label: "ult", url: urls.ult });
  if (!ustRaw) missing.push({ label: "ust", url: urls.ust });
  if (!origRaw) missing.push({ label: origVersion.toLowerCase(), url: urls.orig });
  if (!tnRaw) missing.push({ label: "tn", url: noteUrls.tn });
  if (!tqRaw) missing.push({ label: "tq", url: noteUrls.tq });
  if (!twlRaw) missing.push({ label: "twl", url: urls.twl });
  if (missing.length > 0) {
    // Re-probe each missing resource — on the failure path ONLY, never the
    // happy path — to classify why it failed. A hard 404 means the org's repo
    // genuinely has no file for this book (permanent: retrying won't help); a
    // 5xx / network error / truncated read is transient (retry may succeed).
    // fetchText collapses all of those to null, so the primary fetch above
    // can't tell them apart; this second probe restores the distinction so the
    // thrown message — and the HTTP status the route returns — can say which it
    // is. See issue #58. (Extra DCS round-trips here are acceptable: the import
    // has already failed.)
    const classifyStatus = (probe: { status: number; truncated?: boolean }) => {
      const permanent = probe.status === 404;
      const reason = permanent
        ? "missing (HTTP 404)"
        : probe.status === 0
          ? "transient (network error)"
          : probe.truncated
            ? "transient (truncated read)"
            : probe.status === 200
              ? // TOCTOU: the primary fetch returned null but the re-probe now
                // succeeds — treat as transient, never emit "HTTP 200" as a reason.
                "transient (recovered on re-check)"
              : `transient (HTTP ${probe.status})`;
      return { permanent, reason };
    };
    const classified = await Promise.all(
      missing.map(async ({ label, url }) => {
        const primary = classifyStatus(await fetchTextWithStatus(env, url));
        // tn/tq that also attempted a translation-source fallback: the resource
        // is only permanently missing when BOTH the org's primary URL and the
        // fallback URL are hard 404s. If either probe is transient, retrying may
        // still recover the resource, so classify the whole thing as transient.
        const fallbackUrl =
          label === "tn" || label === "tq" || label === "ult" || label === "ust"
            ? noteFallbackAttempt[label]
            : undefined;
        if (fallbackUrl) {
          const fallback = classifyStatus(await fetchTextWithStatus(env, fallbackUrl));
          const permanent = primary.permanent && fallback.permanent;
          const reason = permanent
            ? "missing (HTTP 404 on org + fallback)"
            : `org ${primary.reason}; fallback ${fallback.reason}`;
          return { label, url, permanent, reason };
        }
        return { label, url, permanent: primary.permanent, reason: primary.reason };
      }),
    );
    const allPermanent = classified.every((r) => r.permanent);
    const detail = classified.map((r) => `${r.label} — ${r.reason} (${r.url})`).join("; ");
    const message = allPermanent
      ? `This org's repos have no file for ${missing.length} resource(s); retrying won't help: ${detail}`
      : `DCS fetch failed for ${missing.length} resource(s); retry may succeed: ${detail}`;
    const err = new Error(message) as Error & { permanent?: boolean };
    err.permanent = allPermanent;
    throw err;
  }

  // Per-chapter-range note sources (issue #103 Tier 2): fetch each cross-org
  // range's tn/tq file so the insert can splice its chapters into the book. A
  // configured range whose file cannot be fetched is a HARD error — we must NOT
  // silently fall back to the base source for those chapters (that would import
  // the wrong content and skip the intended per-chapter hold-out).
  const tnRangeFiles = await fetchRangeNoteFiles(env, cfg, book, "tn", tnPlan.ranges);
  const tqRangeFiles = await fetchRangeNoteFiles(env, cfg, book, "tq", tqPlan.ranges);

  // Aquifer per-chapter ranges (tN only) — fetch + convert BEFORE the wipe so a
  // missing source fails loudly with no destructive change (same contract as the
  // DCS range files). tqPlan never carries aquifer ranges (resolveRangeSource
  // rejects aquifer for tq), so there is no tq equivalent.
  const tnAquiferRanges = await fetchAquiferRangeNotes(env, cfg, book, tnPlan.ranges);

  // Cross-source ID collisions (issue #103's original concern — two source
  // files reusing the same row id for DIFFERENT chapters of the merged book) no
  // longer need a pre-wipe abort: `insertMergedNotes` remaps the colliding id at
  // insert time (issue #126), so the merge always lands cleanly. A row id
  // repeated WITHIN one source file is a different, still-fatal case (cold-review
  // follow-up to #126) — that stays a pre-wipe abort so a malformed file is a
  // clean no-op rather than a silently re-minted id.
  for (const [resource, baseRaw, ranges, files] of [
    ["tn", tnRaw, tnPlan.ranges, tnRangeFiles],
    ["tq", tqRaw, tqPlan.ranges, tqRangeFiles],
  ] as const) {
    const dup = mergedNoteSameFileDuplicate(baseRaw, ranges, files);
    if (dup) {
      throw new Error(
        `merge source ${resource} duplicate id: '${dup}' appears more than once within the same source file for ` +
          `${book}; fix the malformed source file before importing (no changes were made)`,
      );
    }
  }

  // Re-check lane state AFTER the (potentially slow) DCS fetches. Then couple
  // the destructive wipe to a transactional lane-state predicate: DELETE only
  // while both lanes are still free at the expected generation (EXISTS). A
  // concurrent replacement freeze makes the DELETEs no-ops; we abort before
  // INSERT if the claim count is wrong.
  const litRecheck = await requireLaneState(env, "lit");
  const simRecheck = await requireLaneState(env, "sim");
  if (litRecheck.replacement_job_id) throw new Error("lit_lane_frozen_for_replacement");
  if (simRecheck.replacement_job_id) throw new Error("sim_lane_frozen_for_replacement");
  if (litRecheck.replacement_required) throw new Error("lit_lane_replacement_required");
  if (simRecheck.replacement_required) throw new Error("sim_lane_replacement_required");
  if (litRecheck.active_generation !== litState.active_generation) {
    throw new Error("lit_lane_generation_changed");
  }
  if (simRecheck.active_generation !== simState.active_generation) {
    throw new Error("sim_lane_generation_changed");
  }

  const litGen = litRecheck.active_generation;
  const simGen = simRecheck.active_generation;
  const olGen = origSourceGeneration();

  // Hold export leases on both lanes for the whole wipe+repopulate. Per-statement
  // EXISTS fences alone cannot roll back earlier committed batches if replacement
  // reserves mid-import; startReplacement refuses while these leases are held.
  const litLease = await acquireExportLease(env, "lit", `import:${book}`);
  if ("error" in litLease) throw new Error(`lit_import_lease:${litLease.error}`);
  const simLease = await acquireExportLease(env, "sim", `import:${book}`);
  if ("error" in simLease) {
    await releaseExportLease(env, litLease.leaseId).catch(() => {});
    throw new Error(`sim_import_lease:${simLease.error}`);
  }

  try {
    // Renew once before the wipe so a slow DCS fetch above doesn't leave a
    // near-expired heartbeat into the multi-batch writes.
    await renewExportLease(env, litLease.leaseId);
    await renewExportLease(env, simLease.leaseId);

    // Wipe + lane CAS in one batch. The leading UPDATEs must each affect 1 row
    // (lane still free at expected gen); DELETEs are further guarded by EXISTS.
    const wipe = await env.DB.batch([
      env.DB.prepare(
        `UPDATE scripture_lane_state SET updated_at = unixepoch()
          WHERE lane = 'lit'
            AND replacement_job_id IS NULL
            AND replacement_required = 0
            AND active_generation = ?1`,
      ).bind(litGen),
      env.DB.prepare(
        `UPDATE scripture_lane_state SET updated_at = unixepoch()
          WHERE lane = 'sim'
            AND replacement_job_id IS NULL
            AND replacement_required = 0
            AND active_generation = ?1`,
      ).bind(simGen),
      env.DB.prepare(`DELETE FROM tn_rows  WHERE book = ?1`).bind(book),
      env.DB.prepare(`DELETE FROM tq_rows  WHERE book = ?1`).bind(book),
      env.DB.prepare(`DELETE FROM twl_rows WHERE book = ?1`).bind(book),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'lit' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, litGen),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = 'UST' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'sim' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, simGen),
      env.DB.prepare(
        `DELETE FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`,
      ).bind(book, origVersion, olGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'lit' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, litGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = 'UST' AND source_generation = ?2
           AND EXISTS (
             SELECT 1 FROM scripture_lane_state
              WHERE lane = 'sim' AND replacement_job_id IS NULL
                AND replacement_required = 0 AND active_generation = ?2
           )`,
      ).bind(book, simGen),
      env.DB.prepare(
        `DELETE FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`,
      ).bind(book, origVersion, olGen),
    ]);
    if ((wipe[0]?.meta?.changes ?? 0) !== 1 || (wipe[1]?.meta?.changes ?? 0) !== 1) {
      throw new Error("lane_state_changed_during_import");
    }

    // Inserts are fenced with EXISTS predicates (not a separate recheck) so a
    // replacement freeze/activation between wipe and write cannot land.
    const counts: ImportCounts = {
      verses: 0,
      tn: 0,
      tq: 0,
      twl: 0,
      fetched: {
        ult: !!ultRaw,
        ust: !!ustRaw,
        orig: !!origRaw,
        tn: !!tnRaw,
        tq: !!tqRaw,
        twl: !!twlRaw,
      },
      sources: {
        tn: noteSource.tn ? sourceProvenance(noteSource.tn.owner, noteSource.tn.repo) : null,
        tq: noteSource.tq ? sourceProvenance(noteSource.tq.owner, noteSource.tq.repo) : null,
        ult: scriptureOverrides.fromSource.lit
          ? sourceProvenance(scriptureOverrides.lit.owner, scriptureOverrides.lit.repo)
          : null,
        ust: scriptureOverrides.fromSource.sim
          ? sourceProvenance(scriptureOverrides.sim.owner, scriptureOverrides.sim.repo)
          : null,
        twl: scriptureOverrides.fromSource.twl && scriptureOverrides.twl
          ? sourceProvenance(scriptureOverrides.twl.owner, scriptureOverrides.twl.repo)
          : null,
      },
    };

    const renewBoth = async () => {
      const okLit = await renewExportLease(env, litLease.leaseId);
      const okSim = await renewExportLease(env, simLease.leaseId);
      if (!okLit || !okSim) throw new Error("import_lease_lost");
    };

    await renewBoth();
    counts.verses += await insertVerses(env, book, "ULT", ultRaw, litGen, "lit");
    await renewBoth();
    counts.verses += await insertVerses(env, book, "UST", ustRaw, simGen, "sim");
    counts.verses += await insertVerses(env, book, origVersion, origRaw, olGen, null);

    await renewBoth();
    counts.tn = await insertMergedNotes(
      (raw, filter, usedIds) => insertTnRows(env, book, raw, userId, litGen, simGen, filter, usedIds),
      tnRaw, tnPlan.ranges, tnRangeFiles, renewBoth,
      tnAquiferRanges.map(({ notes, aqLang }) => ({
        run: () => insertAquiferRangeNotes(env, book, notes, userId, litGen, simGen, aqLang),
      })),
    );
    await renewBoth();
    counts.tq = await insertMergedNotes(
      (raw, filter, usedIds) => insertTqRows(env, book, raw, userId, litGen, simGen, filter, usedIds),
      tqRaw, tqPlan.ranges, tqRangeFiles, renewBoth,
    );
    await renewBoth();
    counts.twl = await insertTwlRows(env, book, twlRaw, userId, litGen, simGen);

    // Final marker — only if both lanes are still free at the expected gens.
    const sources = Object.entries(counts.fetched)
      .filter(([, ok]) => ok)
      .map(([k]) => k)
      .join(",");
    const marker = await env.DB.prepare(
      `INSERT OR REPLACE INTO book_imports
         (book, source_url, imported_at, imported_by, tn_source, tq_source, ult_source, ust_source, twl_source)
       SELECT ?1, ?2, unixepoch(), ?3, ?6, ?7, ?8, ?9, ?10
        WHERE EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = 'lit' AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?4
            )
          AND EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = 'sim' AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?5
            )`,
    )
      .bind(
        book,
        `dcs:${sources}`,
        userId,
        litGen,
        simGen,
        counts.sources.tn,
        counts.sources.tq,
        counts.sources.ult,
        counts.sources.ust,
        counts.sources.twl,
      )
      .run();
    if ((marker.meta?.changes ?? 0) !== 1) {
      throw new Error("lane_state_changed_during_import");
    }

    // Seed per-resource SHA watermarks so the nightly self-heal can skip files
    // that haven't changed since this import (see book_resource_syncs +
    // bookReimport.ts). Best-effort — a missing watermark just means the first
    // nightly reimports that resource.
    for (const resource of ["ult", "ust", "tn", "tq", "twl"] as Resource[]) {
      if (!counts.fetched[resource]) continue;
      // Skip source-pulled resources. ALL FIVE resources are now held out of
      // the nightly reimport + export via their book_imports.*_source column
      // (heldOutNoteResources reads all five — issue #142 closed the ult/ust/
      // twl gap: previously they had no column, so a missing watermark plus
      // the reimport's fail-open-on-unknown behavior meant the nightly job
      // could silently re-fetch and overwrite source-pulled scripture/twl rows
      // from a populated org/lane repo). Stamping a watermark for a held-out
      // resource would be write-only (the reimport short-circuits before
      // checking it) and, for ult/ust/twl, would also be misleading —
      // resourceSourceRef resolves them from lane state / the org repo, neither
      // of which reflects the actual source pull.
      if (resource === "tn" && noteSource.tn) continue;
      if (resource === "tq" && noteSource.tq) continue;
      if (resource === "ult" && scriptureOverrides.fromSource.lit) continue;
      if (resource === "ust" && scriptureOverrides.fromSource.sim) continue;
      if (resource === "twl" && scriptureOverrides.fromSource.twl) continue;
      const file = dcsResourceFile(cfg, book, resource);
      if (!file) continue;
      const src = await resourceSourceRef(env, resource, cfg);
      const sha = await fileCommitSha(env, src.owner, src.repo, file.path, src.ref);
      if (sha) await recordResourceSync(env, book, resource, sha, "import", src);
    }

    return counts;
  } finally {
    await releaseExportLease(env, litLease.leaseId).catch(() => {});
    await releaseExportLease(env, simLease.leaseId).catch(() => {});
  }
}

// D1 batch() caps at 100 statements per call. Keep chunks well under that.
const CHUNK = 80;

async function insertVerses(
  env: Env,
  book: string,
  bibleVersion: string,
  rawUsfm: string | null,
  sourceGeneration?: number,
  lane?: "lit" | "sim" | null,
): Promise<number> {
  if (!rawUsfm) return 0;

  const gen = sourceGeneration ?? 1;

  const headers = extractUsfmHeaders(rawUsfm);
  if (headers) {
    if (lane) {
      const meta = await env.DB.prepare(
        `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
         SELECT ?1, ?2, ?3, ?4
          WHERE EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?5 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?3
          )`,
      )
        .bind(book, bibleVersion, gen, JSON.stringify(headers), lane)
        .run();
      if ((meta.meta?.changes ?? 0) !== 1) {
        throw new Error("lane_state_changed_during_import");
      }
    } else {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO book_usfm_meta (book, bible_version, source_generation, headers_json)
         VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(book, bibleVersion, gen, JSON.stringify(headers))
        .run();
    }
  }

  // Whole-book extract; the [1, 999] range covers any chapter that exists.
  const verses = extractVersesForRange(rawUsfm, 1, 999);
  if (verses.length === 0) return 0;

  const stmt = lane
    ? env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?9 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?6
          )`,
      )
    : env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      );
  let inserted = 0;
  for (let i = 0; i < verses.length; i += CHUNK) {
    const slice = verses.slice(i, i + CHUNK);
    const results = await env.DB.batch(
      slice.map((v) =>
        lane
          ? stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText, lane)
          : stmt.bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText),
      ),
    );
    for (const r of results) inserted += r.meta?.changes ?? 0;
  }
  if (lane && inserted !== verses.length) {
    throw new Error("lane_state_changed_during_import");
  }
  return verses.length;
}

/** Dual-lane free predicate for bootstrap TSV inserts. */
function bothLanesFreeSql(litParam: string, simParam: string): string {
  return `EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = 'lit' AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ${litParam}
          )
        AND EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = 'sim' AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ${simParam}
          )`;
}

async function insertTnRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
  chapterFilter?: (chapter: number) => boolean,
  usedIds?: Set<string>,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tn_rows
       (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE ${bothLanesFreeSql("?12", "?13")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'tn', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  const seen = new Set<string>();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const rawId = r["ID"];
    if (!rawId) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    // Per-chapter-range merge (issue #103 Tier 2): skip rows whose chapter this
    // pass doesn't own, so the base file and each range file each contribute only
    // their assigned chapters into one merged book. Checked BEFORE any id
    // remap below so a skipped row never consumes a usedIds slot it won't fill.
    if (chapterFilter && !chapterFilter(ch)) continue;
    // Cross-source merge (issue #126): when a shared usedIds set is threaded
    // through (the ranges.length > 0 path in insertMergedNotes), re-mint any id
    // that a prior file in this same merge already claimed — base file first, so
    // base always wins and a later range file's collision is what gets remapped.
    // Without usedIds (Tier 1 / no cross-source ranges) ids pass through as-is,
    // unchanged from before.
    //
    // Duplicate ID within this one file (master TSVs really do ship these —
    // the ISA 48 delete+duplicate, the AI TN doubling): first-in wins,
    // matching the reimport path's skipped_dup semantics. Without the skip
    // the second copy's INSERT violates the (book, id) PK and hard-fails the
    // whole book AFTER the wipe already ran — and every retry hits the same
    // wall until master is fixed. Skipped BEFORE the batch so the paired
    // edit_log 'create' row, `expected`, and the returned count stay truthful.
    // (The Tier 2 merge path separately rejects in-file duplicates pre-wipe
    // via mergedNoteSameFileDuplicate; this covers the Tier 1 single-file
    // path, where that scan deliberately doesn't run.)
    if (seen.has(rawId)) continue; // duplicate ID in master's file — first-in wins
    seen.add(rawId);
    const id = usedIds ? pickId(rawId, usedIds) : rawId;
    if (id !== rawId) {
      console.warn("import: cross-source tn id collision remapped", { book, from: rawId, to: id });
    }
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      support_reference: r["SupportReference"] || null,
      quote: r["Quote"] || null,
      occurrence,
      note: r["Note"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.support_reference, payload.quote, payload.occurrence, payload.note,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}

// Insert a chapter range's Aquifer tN notes as unapproved drafts (issue #103
// follow-up). Mirrors the insert in aquiferImport.ts — translation_state
// 'ai_draft', draft_meta_json.source='aquifer', review_kind for unverified
// matches — but runs in the wipe-and-import path (a fresh, empty book) so it does
// NO dedup/preserve, and it is fenced by bothLanesFreeSql like the other bootstrap
// inserts. Runs LAST in the merge, so it seeds its id minter from the ids the
// base + DCS ranges already landed and mints around any collision (an inherited
// en_tn id can never clash with a base row).
async function insertAquiferRangeNotes(
  env: Env,
  book: string,
  notes: ResolvedNote[],
  userId: number,
  litGen: number,
  simGen: number,
  aqLang: string,
): Promise<number> {
  if (notes.length === 0) return 0;

  // Live ids for this book (base + dcs ranges already inserted), INCLUDING any
  // soft-deleted rows — the PK is (book, id) and a tombstone keeps its slot.
  const usedIds = new Set(
    ((await env.DB.prepare(`SELECT id FROM tn_rows WHERE book = ?1`).bind(book).all<{ id: string }>()).results ?? [])
      .map((r) => r.id),
  );

  const insertStmt = env.DB.prepare(
    `INSERT INTO tn_rows
       (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note,
        version, updated_by, updated_at, sort_order, preserve,
        translation_state, draft_meta_json, pre_draft_json, review_kind, review_reason)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        1, ?11, ?12, ?13, 1, 'ai_draft', ?14, ?15, ?16, ?17
      WHERE ${bothLanesFreeSql("?18", "?19")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     SELECT 'tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5
      WHERE changes() > 0`,
  );

  const now = Math.floor(Date.now() / 1000);
  const nextSort = makeVerseSortOrder();
  let expected = 0;
  let landed = 0;
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const note of notes) {
    const id = pickId(note.enId, usedIds);
    const [ch, v] = refParts(note.ref);
    const draftMeta = JSON.stringify({
      source: AQUIFER_SOURCE, aqLang, aquiferContentId: note.aquiferContentId, joinMethod: note.joinMethod,
    });
    const preDraft = JSON.stringify({ note: "", tags: null });
    const reviewKind = note.reviewReason ? "aquifer_unverified" : null;
    batch.push(
      insertStmt.bind(
        id, book, ch, v, note.ref,
        note.tags, note.supportReference, note.quote, note.occurrence, note.note,
        userId, now, nextSort(ch, v),
        draftMeta, preDraft, reviewKind, note.reviewReason,
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify({ ref: note.ref, source: AQUIFER_SOURCE }), AQUIFER_SOURCE),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}

async function insertTqRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
  chapterFilter?: (chapter: number) => boolean,
  usedIds?: Set<string>,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO tq_rows
       (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
      WHERE ${bothLanesFreeSql("?12", "?13")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'tq', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  const seen = new Set<string>();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const rawId = r["ID"];
    if (!rawId) continue;
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    // Per-chapter-range merge (issue #103 Tier 2) — see insertTnRows. Checked
    // BEFORE any id remap so a skipped row never consumes a usedIds slot.
    if (chapterFilter && !chapterFilter(ch)) continue;
    // Duplicate-ID tolerance: see insertTnRows (first-in wins so a malformed
    // master file can't PK-collide and hard-fail the book post-wipe).
    if (seen.has(rawId)) continue; // duplicate ID in master's file — first-in wins
    seen.add(rawId);
    // Cross-source id remap (issue #126) — see insertTnRows.
    const id = usedIds ? pickId(rawId, usedIds) : rawId;
    if (id !== rawId) {
      console.warn("import: cross-source tq id collision remapped", { book, from: rawId, to: id });
    }
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      quote: r["Quote"] || null,
      occurrence,
      question: r["Question"] || null,
      response: r["Response"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.quote, payload.occurrence, payload.question, payload.response,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}

async function insertTwlRows(
  env: Env,
  book: string,
  raw: string | null,
  userId: number,
  litGen: number,
  simGen: number,
): Promise<number> {
  if (!raw) return 0;
  const { rows } = parseTsv(raw);
  if (rows.length === 0) return 0;

  const insertStmt = env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
      WHERE ${bothLanesFreeSql("?11", "?12")}`,
  );
  const auditStmt = env.DB.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json)
     SELECT 'twl', ?1, ?2, ?3, NULL, 1, 'create', ?4
      WHERE changes() > 0`,
  );

  let expected = 0;
  let landed = 0;
  const nextSort = makeVerseSortOrder();
  const seen = new Set<string>();
  let batch: D1PreparedStatement[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const results = await env.DB.batch(batch);
    for (let i = 0; i < results.length; i += 2) {
      if ((results[i]?.meta?.changes ?? 0) > 0) landed++;
    }
    batch = [];
  };

  for (const r of rows) {
    const id = r["ID"];
    if (!id) continue;
    // Duplicate-ID tolerance: see insertTnRows (first-in wins so a malformed
    // master file can't PK-collide and hard-fail the book post-wipe).
    if (seen.has(id)) continue; // duplicate ID in master's file — first-in wins
    seen.add(id);
    const refRaw = r["Reference"] ?? "";
    const [ch, v] = refParts(refRaw);
    const occRaw = r["Occurrence"];
    const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
    const payload = {
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: r["Tags"] || null,
      orig_words: r["OrigWords"] || null,
      occurrence,
      tw_link: r["TWLink"] || null,
    };
    batch.push(
      insertStmt.bind(
        id, book, ch, v, refRaw,
        payload.tags, payload.orig_words, payload.occurrence, payload.tw_link,
        nextSort(ch, v),
        litGen, simGen,
      ),
      auditStmt.bind(id, book, userId, JSON.stringify(payload)),
    );
    expected++;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
  if (landed !== expected) throw new Error("lane_state_changed_during_import");
  return landed;
}
