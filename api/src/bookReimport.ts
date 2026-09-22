// Non-destructive per-chapter, per-resource re-import from Door43.
//
// The bootstrap path (bookImport.ts) wipes the book and re-inserts. This
// module is the maintenance lane: pull fresh content from DCS for selected
// chapters / resources without clobbering rows a translator has edited.
//
// Don't-clobber rule (canonical): a row is "safe to overwrite" iff no HUMAN
// owns it. Two admissible cases (see isReimportableRow in reimportClassify.ts):
//   1. pristine — never touched at all (updated_by IS NULL), plus the human-owned
//      protections clear:
//        tn:  deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0
//        tq:  deleted_at IS NULL
//        twl: deleted_at IS NULL
//      (trashed_at: a note pending deletion is never overwritten/resurrected by a
//      reimport — it's promoted to a deleted_at tombstone by the nightly job.)
//   2. AI-only — the AI pipeline wrote the row (so updated_by is the pipeline
//      starter's id) but no human has edited it since: the latest content-bearing
//      edit_log entry is source='ai_pipeline'. This is the same signal the AI
//      pipeline sweep uses in pipelineImport.ts deleteUnkeptTns. An AI-only row is
//      re-seeded from master exactly like a pristine one AND reclaimed to
//      master-owned (updated_by → NULL), counted as `reimported_ai` (NOT the
//      misleading `skipped_edited`). Its write is guarded by version-CAS + the
//      same protection re-assertion so a human edit landing mid-import can't be
//      clobbered (a human PATCH bumps version and writes a null/manual-source
//      edit_log row, so the row stops being AI-only).
// A genuinely human-edited row (latest edit_log source null/manual) is SKIPPED,
// not merged or warned about.
//
// This distinction closes the recurring "N skipped (already edited)" mislabel on
// every AI-touched book: before, updated_by != null alone marked a row edited, so
// AI-generated rows no human had touched were never re-seeded from master.
//
// Concurrency:
//   - book_import_locks is reused (per-book serialization). A second caller
//     gets 409 in_progress.
//   - Active AI pipelines on a chapter cause that chapter to be skipped
//     (counted as skipped_locked) — the AI run would overwrite us anyway.
//   - The UPDATE-WHERE-pristine predicate is the real race guard: if a user
//     edits mid-import, their PATCH bumps updated_by and our UPDATE matches
//     0 rows. No SELECT-then-UPDATE window.

import type { Env } from "./index";
import type { WorkflowStep } from "cloudflare:workers";
// NOTE: runtime imports below use explicit `.ts` specifiers so this module —
// and the regression suites that drive its REAL functions (reimportJourney
// .test.mjs, tombstoneReclaim.test.mjs) — loads under Node's
// --experimental-strip-types test runner, which does no extension guessing.
// Wrangler/esbuild resolves them identically; type-only imports are stripped
// and can stay extensionless.
import { dcsUrls, dcsResourceFile, dcsRawUrl, fileCommitSha, fetchText, fetchTextWithStatus, heldOutNoteResources, releaseLockedLaneHoldOuts, unlockedLaneHoldOutsToProbe, shouldReleaseProbedHoldOut, NT_BOOKS, type FetchTextResult, type LockedLanes } from "./dcsSources.ts";
import { getProjectConfig, type ProjectConfig } from "./projectConfig.ts";
import { heldOutChapters, isChapterHeldOut, NOTHING_HELD_OUT, type HeldOut } from "./bookSource.ts";
import {
  collectSourceWords,
  extractVersesForRange,
  healReplacementChars,
  makeVerseSortOrder,
  parseTsv,
  reconcileSourceAttrsFromMaster,
  refParts,
  type SourceWord,
  type VerseExtract,
} from "./importParsers.ts";
import { activePipelineForChapter } from "./chapterLock.ts";
import { requireLaneState, laneForBibleVersion, activeLaneConfig, origSourceGeneration, activeGenerationForBibleVersion } from "./scriptureLane.ts";
import { coerceRowId } from "./rowId.ts";
import { planTnContentDedup } from "./tnDedup.ts";
import { isCatastrophicTsvShrink } from "./shrinkGuard.ts";
import { classifyReimportRow, isReimportableRow, isReissuedTombstone } from "./reimportClassify.ts";
import { shouldRecordResourceSync } from "./reimportSyncGate.ts";
import { computeTwlSortOrderUpdates } from "./twlCanonicalOrder.ts";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply.ts";
import type { TwlRow, VerseRow } from "./types";
import { sameDcsName } from "./repoUrl.ts";

export type Resource = "ult" | "ust" | "tn" | "tq" | "twl";

export const ALL_RESOURCES: readonly Resource[] = ["ult", "ust", "tn", "tq", "twl"];

// Chapters per Workflow step in the chunked reimport. Sized so even the largest
// book (Psalms, 150 ch) stays well under Cloudflare's 600 000 ms per-step limit
// that the old whole-book reimport blew on Isaiah. In steady state the
// per-resource SHA gate skips unchanged files entirely, so this rarely bites.
export const REIMPORT_CHAPTER_CHUNK = 8;

// Max statements per env.DB.batch() write. D1 caps a batch at 100 statements and
// 100 bound params per statement; 90 stays safely under both. The batched
// applyTsvRows / applyVerseRows paths exist to keep the nightly DCS→D1 sync under
// the per-invocation subrequest cap — DO NOT revert them to a per-row loop. That
// exact regression (PR #180 batched them → a later refactor un-batched them →
// PR #195 re-batched) silently reintroduced the cap once. See bookReimport's
// section header + the nightly-sync-subrequest-cap memory.
const WRITE_BATCH = 90;

export interface ReimportCounts {
  updated: number;
  // AI-only rows (written by the AI pipeline, never human-edited) that were
  // overwritten from master and reclaimed to master-owned (updated_by → NULL).
  // Tracked separately from `updated` (pristine rows) so the summary can say
  // "N refreshed (AI-generated)" instead of the old, misleading "N skipped
  // (already edited)". See isReimportableRow / the header don't-clobber rule.
  reimported_ai: number;
  inserted: number;
  // Pristine rows soft-deleted because master no longer carries their id. Only
  // the TSV resources populate this (verses are never row-deleted on reimport).
  deleted: number;
  skipped_edited: number;
  skipped_locked: number;
  skipped_noop: number;
  // Incoming row not inserted because an identical-content row already exists
  // (Guard 2, content-dedup). Tracked separately from skipped_noop so the guard
  // firing is visible in the reimport summary / logs.
  skipped_dup: number;
  // ── Issue #427, option 2: the silent tombstone-PK drop, made visible ──────
  //
  // A master row this run intended to INSERT whose `INSERT ... ON CONFLICT(id,
  // book) DO NOTHING` wrote 0 rows — the (book, id) slot was already taken by a
  // row the in-memory diff didn't see (in practice a tombstone; soft deletes
  // keep their primary key forever). Previously folded into `skipped_noop` with
  // a "raced" comment, which asserted a cause the code had not measured. The
  // narrower of the two drop routes: applyTsvRows' `existing` read does NOT
  // filter `deleted_at IS NULL`, so a known tombstone reaches the tombstone
  // branch below and never gets here — this counter is the backstop for a slot
  // taken between the read and the insert.
  conflict_skipped: number;
  // A master row dropped by the TOMBSTONE branch of applyTsvRows where master
  // carries that id at a DIFFERENT reference than the tombstone holds — i.e.
  // the id has been reissued to a genuinely different row, so master's row is
  // real and is being silently lost. This is the route upstream's 1CH 23 tQ
  // incident actually took (six ids tombstoned at 1CH 5:x, reissued by
  // bp-assistant at 1CH 23:x, dropped with no error and no counter while the
  // watermark certified the book in sync). See isReissuedTombstone in
  // reimportClassify.ts for the discriminator and why a SAME-reference
  // tombstone is deliberately NOT counted (that skip is what preserves a
  // delete pending export).
  //
  // (`skipped_noop` DID change meaning: the PK-conflict case used to be
  // folded into it and no longer is.)
  //
  // Issue #427's option 1 (reclaim a reissued id) has SHIPPED — see
  // `tombstone_reclaimed` below and the tombstone branch of applyTsvRows. This
  // counter no longer means "master's row was dropped and we only reported it";
  // for a reissued tombstone the reimport now ATTEMPTS the reclaim in the same
  // run, and `tombstone_blocked` only still increments for that row when the
  // reclaim itself lost the version-CAS race (something touched the tombstoned
  // row between the read and the write) — a residual, expected-to-self-heal-on-
  // retry case, kept here rather than silently dropped so a lost race is never
  // quieter than the pre-reclaim behavior. `conflict_skipped` above is unrelated
  // to reclaim (it's the INSERT-path race) and still behaves exactly as before.
  tombstone_blocked: number;
  // ── Issue #427, option 1: reclaim a reissued tombstone's slot ──────────────
  //
  // A tombstoned row master's file now carries at a DIFFERENT reference (see
  // isReissuedTombstone) — the exact condition that used to only increment
  // tombstone_blocked and freeze the export — is now RECLAIMED: master's
  // incoming row is written into the freed-up (book, id) slot (deleted_at
  // cleared, content/ref/chapter/verse/sort_order set to master's, version
  // bumped, updated_by reset to NULL so the row is master-owned going forward).
  // The old tombstoned row's content and protection flags (trashed_at/preserve/
  // hint/updated_by) are irrelevant to this decision — master's new row is a
  // completely different logical entity being written into a slot the old row
  // merely happened to vacate, not a continuation of it. See the "Batch the
  // reclaims" write site for the CAS guard this relies on, and the lost-CAS
  // fallback that still counts tombstone_blocked (never a silent drop).
  // Audited as "create" (edit_log): from this slot's new life's perspective,
  // master's row IS a fresh row. Does NOT gate the watermark by itself — a
  // landed reclaim means master's content IS now in D1, so there is nothing
  // left to withhold for; only the lost-CAS fallback (tombstone_blocked) does.
  tombstone_reclaimed: number;
  // Taint: a write batch THREW, so content this run staged is known-absent
  // from D1 (distinct from counts_incomplete, which marks an absent
  // MEASUREMENT). Checked as a sibling withhold condition at the reimport-sync
  // step — certifying the resource in sync over a thrown batch would let the
  // nightly export revert master with no retry.
  apply_incomplete?: boolean;
  // Human-readable identification of the rows the two counters above dropped —
  // resource, id, and both references. Capped at BLOCKED_SAMPLE_CAP because the
  // failure mode is a whole book's ids being re-minted at once, and this rides
  // in a Workflow step result and an alert message. Diagnostic ONLY: it is not
  // consulted by any gate, so a truncated or absent list can never change a
  // watermark decision — the counters do that. It exists because withholding a
  // watermark with no automatic release (see the reimport-sync step) is only
  // actionable if a human is told WHICH rows to go fix.
  blocked_samples?: string[];
  // Taint: some counter in this aggregate was ABSENT on a folded-in chunk
  // result (a Workflow instance that started pre-deploy replaying memoized
  // step results), or a write's D1 result carried no row count at all — either
  // way, "not measured" must not be laundered into "measured zero". Checked by
  // shouldRecordResourceSync; see addCounts.
  counts_incomplete?: boolean;
  // Pristine tombstone that master still carries, brought back to life because
  // an earlier reimport prune had erroneously soft-deleted it (the HAB tn
  // truncated-fetch incident). Human-deleted/trashed rows are never resurrected.
  resurrected: number;
  // Edited verse (updated_by != null) whose SOURCE-owned `\zaln-s` attributes
  // (x-content/x-lemma/x-morph) were reconciled from master while preserving the
  // translator's target text + grouping. Stops the nightly export from reverting
  // a curated original-language fix on an edited verse (the NUM 20–22 incident).
  // verses only — TSV rows have no source attrs.
  source_attr_reconciled: number;
  // Source-attr divergence on an edited verse that could NOT be uniquely
  // reconciled (master ambiguous for the source key). Left as-is, logged so the
  // residual potential clobber is visible. Normally zero.
  source_attr_divergent: number;
  // twl rows whose sort_order was rewritten by the canonical post-pass to match
  // the ULT-position ordering (the same order the nightly export computes). Lets
  // the reimport adopt canonical order back into D1 for content-identical rows
  // that classifyReimportRow otherwise preserves as a local reorder. Book-level
  // pass, tallied onto perResource.twl.
  twl_reordered: number;
  dcs_404: number;
  errors: string[];
}

export interface ReimportResult {
  book: string;
  perResource: Record<Resource, ReimportCounts>;
  totals: ReimportCounts;
}

const REIMPORT_SOURCE = "dcs_reimport";

// Cap on ReimportCounts.blocked_samples. Also caps the per-row console.warn at
// each drop site: a mass id-reissue would otherwise emit one Workers log line
// per row, and the per-resource summary at the reimport-sync step already
// carries the total.
const BLOCKED_SAMPLE_CAP = 20;

// Record one dropped row's identification, and log it, both capped. Kept as one
// helper so the cap can never be applied to the list but forgotten on the log.
function noteBlockedSample(counts: ReimportCounts, sample: string): void {
  const samples = (counts.blocked_samples ??= []);
  if (samples.length >= BLOCKED_SAMPLE_CAP) return;
  samples.push(sample);
  console.warn("reimport: master row not imported — id already held in D1", { sample });
}

function zeroCounts(): ReimportCounts {
  return {
    updated: 0,
    reimported_ai: 0,
    inserted: 0,
    deleted: 0,
    skipped_edited: 0,
    skipped_locked: 0,
    skipped_noop: 0,
    skipped_dup: 0,
    conflict_skipped: 0,
    tombstone_blocked: 0,
    tombstone_reclaimed: 0,
    resurrected: 0,
    source_attr_reconciled: 0,
    source_attr_divergent: 0,
    twl_reordered: 0,
    dcs_404: 0,
    errors: [],
    counts_incomplete: false,
  };
}

// Test-only aliases (reimportJourney.test.mjs). The aggregation step is where an
// absent counter could be laundered into a present zero, so the journey test has
// to fold through the REAL addCounts rather than re-implement it.
export const zeroCountsForTest = (): ReimportCounts => zeroCounts();
export const addCountsForTest = (into: ReimportCounts, from: ReimportCounts): void => addCounts(into, from);
export const raiseTombstoneBlockAlertForTest = (
  env: Env,
  book: string,
  resource: Resource,
  counts: ReimportCounts,
): Promise<void> => raiseTombstoneBlockAlert(env, book, resource, counts);
export const clearTombstoneBlockAlertForTest = (
  env: Env,
  book: string,
  resource: Resource,
): Promise<void> => clearTombstoneBlockAlert(env, book, resource);
// applyVerseRows has no D1-mock test harness above this module — exposed here,
// same convention as zeroCountsForTest, so applyVerseRows.test.mjs can drive
// the real chunked-batch write path against a real SQLite-backed env.DB.
export const applyVerseRowsForTest = (
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
  intendedSrc?: ResourceSourceRef | null,
): Promise<ReimportCounts> => applyVerseRows(env, book, bibleVersion, verses, userId, intendedSrc);

function addCounts(into: ReimportCounts, from: ReimportCounts): void {
  into.updated += from.updated;
  into.reimported_ai += from.reimported_ai;
  into.inserted += from.inserted;
  into.deleted += from.deleted;
  into.skipped_edited += from.skipped_edited;
  into.skipped_locked += from.skipped_locked;
  into.skipped_noop += from.skipped_noop;
  into.skipped_dup += from.skipped_dup;
  // `conflict_skipped` / `tombstone_blocked` (issue #427) did not exist before
  // this change, so EVERY chunk result memoized by a Workflow instance that
  // started pre-deploy is missing them. Their absence must not be laundered
  // into a present zero: shouldRecordResourceSync stamps the sync watermark
  // only when these are provably zero, and "provably" is the point — coercing
  // `undefined` to 0 here and stamping would certify a run that may have
  // dropped rows to a tombstone collision mid-deploy. So the incompleteness is
  // recorded separately, on `counts_incomplete`, which survives the coercion
  // below and is checked by the gate in addition to its direct-absence check.
  const incomplete =
    from.conflict_skipped === undefined || from.tombstone_blocked === undefined;
  into.counts_incomplete = Boolean(into.counts_incomplete || from.counts_incomplete || incomplete);
  // apply_incomplete is sticky across chunks: one thrown write batch anywhere
  // in the run means the resource cannot be certified in sync.
  into.apply_incomplete = Boolean(into.apply_incomplete || from.apply_incomplete);
  into.conflict_skipped += from.conflict_skipped ?? 0;
  into.tombstone_blocked += from.tombstone_blocked ?? 0;
  // tombstone_reclaimed (issue #427, option 1) deliberately does NOT join the
  // `incomplete` taint check above: a landed reclaim means master's content IS
  // now in D1, so there is no watermark decision here for an absent-vs-zero
  // distinction to protect — only the lost-CAS fallback (which still
  // increments tombstone_blocked, already covered above) withholds. Plain
  // `?? 0` coercion is the right and sufficient handling for a legacy/replayed
  // chunk result that predates this field.
  into.tombstone_reclaimed += from.tombstone_reclaimed ?? 0;
  // Diagnostic list, merged under the same cap. Never gates anything, so a
  // truncation here cannot affect a watermark decision.
  if (from.blocked_samples?.length) {
    const into_ = (into.blocked_samples ??= []);
    for (const s of from.blocked_samples) {
      if (into_.length >= BLOCKED_SAMPLE_CAP) break;
      into_.push(s);
    }
  }
  into.resurrected += from.resurrected;
  into.source_attr_reconciled += from.source_attr_reconciled;
  into.source_attr_divergent += from.source_attr_divergent;
  into.twl_reordered += from.twl_reordered;
  into.dcs_404 += from.dcs_404;
  if (from.errors.length) into.errors.push(...from.errors);
}

// Recompute + persist canonical TWL sort_order for a whole book from the CURRENT
// ULT alignment — the SAME diff the nightly export computes
// (computeTwlSortOrderUpdates). TWL order is derived from ULT word position, not
// preserved: classifyReimportRow deliberately no-ops a content-identical twl row's
// sort_order (the HOS reorder-revert fix), so canonical order is owned here.
// Positional metadata only — never touches content/updated_by, never logs edit
// history; idempotent (empty diff when already canonical). Callers must have ULT
// verses current in D1 first. Returns the number of rows re-sequenced.
async function canonicalizeTwlOrder(env: Env, book: string): Promise<number> {
  const twlRows = await env.DB.prepare(
    `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
     ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
  )
    .bind(book)
    .all<TwlRow>();
  const ultGen = (await activeGenerationForBibleVersion(env, "ULT")) ?? 1;
  const ultVerses = await env.DB.prepare(
    `SELECT * FROM verses WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2
     ORDER BY chapter, verse`,
  )
    .bind(book, ultGen)
    .all<VerseRow>();
  const updates = computeTwlSortOrderUpdates(twlRows.results, ultVerses.results);
  await applyTwlSortOrderUpdates(env.DB, book, updates);
  return updates.length;
}

export class BookNotImportedError extends Error {
  book: string;
  constructor(book: string) {
    super(`book not imported: ${book}`);
    this.book = book;
  }
}

export class ImportInProgressError extends Error {
  book: string;
  constructor(book: string) {
    super(`import in progress for ${book}`);
    this.book = book;
  }
}

export async function reimportBookFromDcs(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
  _opts: { source: "user" | "cron" },
): Promise<ReimportResult> {
  const cfg = await getProjectConfig(env);
  const urls = dcsUrls(env, cfg, book);
  if (!urls) throw new Error(`unknown book: ${book}`);

  // Re-import is the maintenance lane — book must already be bootstrapped.
  // The first-time path (bookImport.ts POST /:book/import) handles the
  // wipe-and-load case; re-running it post-edits would clobber everything.
  const imported = await env.DB.prepare(
    `SELECT 1 FROM book_imports WHERE book = ?1`,
  )
    .bind(book)
    .first();
  if (!imported) throw new BookNotImportedError(book);

  // Reuse the per-book lock (same table the first-time import uses + the
  // */5 stale sweep cleans up). A second concurrent re-import on the same
  // book gets a 409 from the caller. A first-time import racing a re-import
  // on the same book is also blocked — that's the safe answer.
  const startedAt = Math.floor(Date.now() / 1000);
  const lock = await env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by)
     VALUES (?1, ?2, ?3)`,
  )
    .bind(book, startedAt, userId)
    .run();
  if (!lock.meta.changes) throw new ImportInProgressError(book);

  try {
    return await runReimport(env, book, chapters, resources, userId);
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`)
      .bind(book)
      .run();
  }
}

async function runReimport(
  env: Env,
  book: string,
  chapters: number[],
  resources: Resource[],
  userId: number | null,
): Promise<ReimportResult> {
  const cfg = await getProjectConfig(env);
  const urls = dcsUrls(env, cfg, book)!;

  // Fetch each requested resource once at the book level. ULT/UST/TN/TQ/TWL
  // are whole-book files; chapter filtering happens after parse.
  const want = new Set(resources);

  // Held-out note chapters (issue #103): a book's tn/tq chapters that did NOT
  // come from the configured org repo — whole-book (Aquifer rebuild, the English
  // translationSource fallback: the book_imports marker) OR specific chapter
  // ranges (per-chapter override). A DCS reimport from the configured repo would
  // clobber/prune those source-keyed rows, so hold them out. `.all` → drop the
  // resource entirely (don't even fetch it); a partial set → keep the resource
  // for its OWNED chapters and skip only the held-out chapters in the loop + prune.
  const heldOut: Partial<Record<"tn" | "tq", HeldOut>> = {};
  if (want.has("tn") || want.has("tq")) {
    const prov = await env.DB.prepare(`SELECT tn_source, tq_source FROM book_imports WHERE book = ?1`)
      .bind(book)
      .first<{ tn_source: string | null; tq_source: string | null }>();
    for (const r of ["tn", "tq"] as const) {
      if (!want.has(r)) continue;
      const marker = r === "tn" ? prov?.tn_source : prov?.tq_source;
      const h = await heldOutChapters(env, cfg, book, r, marker);
      heldOut[r] = h;
      if (h.all) want.delete(r);
    }
  }
  const tnHeld = heldOut.tn ?? NOTHING_HELD_OUT;
  const tqHeld = heldOut.tq ?? NOTHING_HELD_OUT;

  // Scripture-lane guard: a frozen lane (open replacement) or a lane that still
  // requires a replacement must not accept a scripture reimport — it would
  // clobber the generation the replacement is staging/superseding. TSV
  // resources (tn/tq/twl) are lane-agnostic and stay allowed.
  // Capture the intended source identity once so later writes + watermarks stay
  // sticky to the generation/owner/repo/ref we planned against.
  const intendedByBv: Partial<Record<"ULT" | "UST", ResourceSourceRef>> = {};
  for (const [resource, bv] of [["ult", "ULT"], ["ust", "UST"]] as const) {
    if (!want.has(resource)) continue;
    const lane = laneForBibleVersion(bv);
    if (!lane) continue;
    const state = await requireLaneState(env, lane);
    if (state.replacement_job_id || state.replacement_required) {
      throw new Error(`${lane}_lane_frozen_for_replacement`);
    }
    intendedByBv[bv] = await resourceSourceRef(env, resource, cfg);
  }
  let [ultRaw, ustRaw, tnRaw, tqRaw, twlRaw] = await Promise.all([
    want.has("ult") ? fetchText(urls.ult) : Promise.resolve(null),
    want.has("ust") ? fetchText(urls.ust) : Promise.resolve(null),
    want.has("tn") ? fetchText(urls.tn) : Promise.resolve(null),
    want.has("tq") ? fetchText(urls.tq) : Promise.resolve(null),
    want.has("twl") ? fetchText(urls.twl) : Promise.resolve(null),
  ]);

  // Completeness gate (TSV only). A truncated master fetch that slipped past
  // fetchText (e.g. a no-Content-Length partial body — the HAB tn incident)
  // parses to far fewer rows than the book holds live in D1. Treat it as
  // not-fetched so it can't drive the apply OR the prune; the existing dcs_404
  // tally below records the miss. Verses are exempt (never row-pruned; a short
  // USFM just no-ops its missing chapters).
  if (tnRaw && (await tsvFetchLooksTruncated(env, book, "tn", tnRaw, tnHeld))) tnRaw = null;
  if (tqRaw && (await tsvFetchLooksTruncated(env, book, "tq", tqRaw, tqHeld))) tqRaw = null;
  if (twlRaw && (await tsvFetchLooksTruncated(env, book, "twl", twlRaw))) twlRaw = null;

  const perResource: Record<Resource, ReimportCounts> = {
    ult: zeroCounts(),
    ust: zeroCounts(),
    tn: zeroCounts(),
    tq: zeroCounts(),
    twl: zeroCounts(),
  };
  const totals = zeroCounts();

  // Mark DCS-missing resources up front (one 404 per requested resource,
  // not per chapter). If a resource wasn't requested, leave counts at zero.
  if (want.has("ult") && !ultRaw) perResource.ult.dcs_404++;
  if (want.has("ust") && !ustRaw) perResource.ust.dcs_404++;
  if (want.has("tn") && !tnRaw) perResource.tn.dcs_404++;
  if (want.has("tq") && !tqRaw) perResource.tq.dcs_404++;
  if (want.has("twl") && !twlRaw) perResource.twl.dcs_404++;

  for (const chapter of chapters) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const r of resources) perResource[r].skipped_locked++;
      continue;
    }

    if (want.has("tn") && tnRaw && !isChapterHeldOut(tnHeld, chapter)) {
      const c = await reimportTsvForChapter(env, book, chapter, tnRaw, "tn", userId);
      addCounts(perResource.tn, c);
    }
    if (want.has("tq") && tqRaw && !isChapterHeldOut(tqHeld, chapter)) {
      const c = await reimportTsvForChapter(env, book, chapter, tqRaw, "tq", userId);
      addCounts(perResource.tq, c);
    }
    if (want.has("twl") && twlRaw) {
      const c = await reimportTsvForChapter(env, book, chapter, twlRaw, "twl", userId);
      addCounts(perResource.twl, c);
    }
    if (want.has("ult") && ultRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ultRaw, "ULT", userId, intendedByBv.ULT);
      addCounts(perResource.ult, c);
    }
    if (want.has("ust") && ustRaw) {
      const c = await reimportVersesForChapter(env, book, chapter, ustRaw, "UST", userId, intendedByBv.UST);
      addCounts(perResource.ust, c);
    }
  }

  // Soft-delete pristine rows whose ids master no longer carries — for the
  // chapters this run touched. The nightly runChunkedReimport already does
  // this; the user-triggered path must too, or an out-of-band master deletion
  // (e.g. a Zulip-run AI rewrite that replaced a verse's notes with new ids,
  // imported via this route) leaves the old ids orphaned in D1 with no human
  // edit to protect them — they then export back onto master as resurrected
  // rows. softDeleteRemovedTsvRows compares against the WHOLE file's id set and
  // only touches pristine rows in covered chapters (see its guardrails).
  const tsvRawByKind: Record<TsvKind, string | null> = { tn: tnRaw, tq: tqRaw, twl: twlRaw };
  const heldByKind: Partial<Record<TsvKind, HeldOut>> = { tn: tnHeld, tq: tqHeld };
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = tsvRawByKind[kind];
    if (!want.has(kind) || !raw) continue;
    // Prune ONLY the non-held-out chapters. A held-out chapter's rows came from a
    // different source and are (correctly) absent from the org master file — if
    // the prune saw them it would soft-delete every one (the twl_PSA/HAB
    // data-loss signature, re-created per chapter). twl is never held out.
    const held = heldByKind[kind];
    const pruneChapters = held ? chapters.filter((ch) => !isChapterHeldOut(held, ch)) : chapters;
    if (pruneChapters.length === 0) continue;
    try {
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, pruneChapters);
      perResource[kind].deleted += res.deleted;
      perResource[kind].skipped_locked += res.skippedLocked;
    } catch (e) {
      perResource[kind].errors.push(`${kind} prune: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Canonical TWL order post-pass. classifyReimportRow deliberately PRESERVES a
  // content-identical twl row's local sort_order (the HOS reorder-revert fix), so
  // a content-identical-but-misordered file never adopts canonical order through
  // the row loop. Order is instead owned by this pass: now that D1's ULT verses
  // are current (all resources applied above), recompute the ULT-position
  // ordering — the SAME diff the nightly export computes
  // (computeTwlSortOrderUpdates) — and write it. Reads twl rows + ULT from D1 (no
  // dependency on twlRaw), so it also runs on a ULT-ONLY import: re-aligning the
  // ULT changes the canonical order, and D1's twl sort_order must follow. Mirrors
  // the nightly `twl || ult` gate.
  if (want.has("twl") || want.has("ult")) {
    try {
      perResource.twl.twl_reordered += await canonicalizeTwlOrder(env, book);
    } catch (e) {
      perResource.twl.errors.push(`twl canonical order: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const r of resources) addCounts(totals, perResource[r]);

  return { book, perResource, totals };
}

// ── TSV resources (tn / tq / twl) ──────────────────────────────────────────

type TsvKind = "tn" | "tq" | "twl";

interface ParsedTsvRow {
  id: string;
  // True when `id` is NOT master's literal ID — parseTsvRow rewrote a malformed
  // one through coerceRowId (rowId.ts). Issue #427: this must suppress the
  // tombstone/conflict *blocked* counters. coerceRowId hashes into a 96-ID
  // space, so two different malformed master IDs can legitimately land on the
  // same coerced value, and a coerced ID can land on an unrelated tombstone.
  // Neither is "master reissued this ID to a different row" — the coerced ID was
  // never the row's identity in the first place, so the reissue inference is
  // meaningless for it. Counting those as blocked would withhold the watermark,
  // and that withhold has no automatic release (see raiseTombstoneBlockAlert),
  // so a documented-benign coercion no-op would freeze the book's export.
  idCoerced?: boolean;
  refRaw: string;
  chapter: number;
  verse: number;
  occurrence: number | null;
  tags: string | null;
  // tn-specific
  support_reference?: string | null;
  quote?: string | null;
  note?: string | null;
  // tq-specific
  question?: string | null;
  response?: string | null;
  // twl-specific
  orig_words?: string | null;
  tw_link?: string | null;
}

// Normalize one raw TSV record into a ParsedTsvRow (no chapter filter). Shared
// by rowsForChapter (the reimport row loop) and changedTsvChapters (the diff
// gate) so the two agree exactly on field normalization — otherwise the gate
// could mis-classify a chapter as unchanged. Returns null for a row with no ID.
function parseTsvRow(r: Record<string, string>, kind: TsvKind): ParsedTsvRow | null {
  const rawId = r["ID"];
  if (!rawId) return null;
  // Guard 1 (defense-in-depth): coerce a malformed master id (e.g. the
  // digit-first ids an old newRowId bug minted before PR #225) to a valid one
  // BEFORE it's used anywhere. Coercing in this single shared normalizer is what
  // keeps the three reimport consumers consistent — the apply path's by-id read,
  // the diff gate (changedTsvChapters), and the prune (softDeleteRemovedTsvRows)
  // all see the SAME coerced id, so an inserted-under-coerced-id row is never
  // mistaken by the prune for a row master "no longer carries" and deleted. The
  // coercion is deterministic, so it's idempotent across nights and a no-op for
  // every well-formed id. (storedTsvRowToParsed deliberately does NOT coerce, so
  // a legacy bad id already in D1 mismatches the coerced incoming id, re-runs the
  // chapter, and self-heals: insert coerced + prune removes the stale raw id.)
  const id = coerceRowId(rawId);
  const refRaw = r["Reference"] ?? "";
  const [ch, v] = refParts(refRaw);
  const occRaw = r["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  const base: ParsedTsvRow = {
    id,
    // Record that the id is ours, not master's — see ParsedTsvRow.idCoerced.
    // coerceRowId is a strict no-op for a well-formed id, so this is false for
    // essentially every real row.
    idCoerced: id !== rawId,
    refRaw,
    chapter: ch,
    verse: v,
    occurrence,
    tags: r["Tags"] || null,
  };
  if (kind === "tn") {
    base.support_reference = r["SupportReference"] || null;
    base.quote = r["Quote"] || null;
    base.note = r["Note"] || null;
  } else if (kind === "tq") {
    base.quote = r["Quote"] || null;
    base.question = r["Question"] || null;
    base.response = r["Response"] || null;
  } else {
    base.orig_words = r["OrigWords"] || null;
    base.tw_link = r["TWLink"] || null;
  }
  return base;
}

function rowsForChapter(raw: string, kind: TsvKind, chapter: number): ParsedTsvRow[] {
  const { rows } = parseTsv(raw);
  const out: ParsedTsvRow[] = [];
  for (const r of rows) {
    const parsed = parseTsvRow(r, kind);
    if (!parsed || parsed.chapter !== chapter) continue;
    out.push(parsed);
  }
  return out;
}

// One UPDATE per pristine row, plus one INSERT-OR-IGNORE per row to seed
// any DCS-new entries. We don't batch into env.DB.batch() because the per-
// row "did anything change?" signal comes from meta.changes, and batch()
// reports aggregate counts only. Throughput is fine — a chapter's worth of
// tn rows is dozens, not thousands.
async function reimportTsvForChapter(
  env: Env,
  book: string,
  chapter: number,
  raw: string,
  kind: TsvKind,
  userId: number | null,
): Promise<ReimportCounts> {
  return applyTsvRows(env, book, kind, rowsForChapter(raw, kind, chapter), userId);
}

// Upsert already-parsed TSV rows (any chapters). Batched to stay under the
// per-invocation subrequest cap: ONE chunked read of the current rows, an
// in-memory diff, then env.DB.batch() of the pristine UPDATEs (+ their edit_log
// rows). New rows are rare in a reimport, so inserts stay a per-row path. The
// old per-row UPDATE loop issued ~5 D1 calls per row and blew the 10k cap on
// large books — DO NOT revert it (PR #180 batched this; a later refactor
// reverted it; PR #195 re-batched). See the nightly-sync-subrequest-cap memory.
//
// sort_order is a per-verse ordinal (makeVerseSortOrder): deterministic and
// chunk-independent, so an unchanged DCS file produces no churn; a reordered/
// extended verse renumbers only that verse. `incoming` is the chapter's rows in
// file order, so the ordinal tracks source order exactly. The pristine guard +
// version-CAS stay ON each UPDATE, so a translator edit landing between the read
// and the batch matches 0 rows (no clobber) and is counted skipped_edited.
// Exported for the integration test ONLY (reimportJourney.test.mjs). Issue #427:
// the tombstone-collision claims were previously asserted by a test that
// hand-copied this function's SQL, which proves nothing if the real SQL later
// drifts — notably the `existing` read's deliberate absence of a
// `deleted_at IS NULL` filter, which is the whole reason a tombstoned id reaches
// the tombstone branch instead of the insert. Driving the real function is what
// makes that claim drift-detecting. Not part of the module's public API.
export async function applyTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  incoming: ParsedTsvRow[],
  userId: number | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (incoming.length === 0) return counts;
  const now = Math.floor(Date.now() / 1000);

  // One read of the comparable + pristine-predicate columns for the incoming
  // ids (chunked under the 100 bound-param limit) so classification is in memory.
  // admin_bulk_state is part of the pristine predicate (isReimportableRow, issue
  // #394) and exists on tn_rows/tq_rows only — twl has no such column. Drop it
  // from this list and the guard receives `undefined` and silently stops firing.
  const pristineCols =
    kind === "tn"
      ? "version, updated_by, deleted_at, trashed_at, preserve, hint, admin_bulk_state"
      : kind === "tq"
        ? "version, updated_by, deleted_at, admin_bulk_state"
        : "version, updated_by, deleted_at";
  const existing = new Map<string, Record<string, unknown>>();
  const ids = incoming.map((r) => r.id);
  for (let i = 0; i < ids.length; i += WRITE_BATCH) {
    const slice = ids.slice(i, i + WRITE_BATCH);
    // ?1 = book, ?2 = kind (edit_log.kind = the resource name), ids from ?3.
    const inClause = slice.map((_, j) => `?${j + 3}`).join(", ");
    // latest_source: source of the latest content-bearing edit_log entry, so we
    // can tell an AI-only row (updated_by set, latest source = ai_pipeline) apart
    // from a human edit. Mirrors the deleteUnkeptTns correlated subquery.
    const rs = await env.DB.prepare(
      `SELECT id, ${TSV_STORED_COLS[kind]}, sort_order, ${pristineCols},
              (SELECT source FROM edit_log
                 WHERE kind = ?2 AND row_key = ${kind}_rows.id
                   AND (book = ?1 OR book IS NULL)
                   AND action IN ('create', 'update')
                 ORDER BY id DESC LIMIT 1) AS latest_source
         FROM ${kind}_rows WHERE book = ?1 AND id IN (${inClause})`,
    )
      .bind(book, kind, ...slice)
      .all<Record<string, unknown>>();
    for (const row of rs.results) existing.set(String(row.id), row);
  }

  // Guard 2 (defense-in-depth, TN only): content-dedup. Prevents the AI-note
  // duplication round-trip (see tnDedup.ts). Decide up front which insert
  // candidates duplicate a row that will already exist LIVE + PRISTINE under a
  // different id — the decision is pure (no extra D1 read), off the by-id
  // `existing` map we just loaded.
  let skipDupIdx = new Set<number>();
  if (kind === "tn") {
    const existsAnyId = new Set(existing.keys());
    const existsPristineId = new Set(
      [...existing].filter(([, cur]) => isPristineTsv(kind, cur)).map(([id]) => id),
    );
    skipDupIdx = planTnContentDedup(incoming, existsPristineId, existsAnyId);
  }

  // Classify. Inserts run per-row (DCS-new rows are rare); updates +
  // resurrections are batched.
  const nextSort = makeVerseSortOrder();
  const updates: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // AI-only rows to re-seed from master AND reclaim to master-owned (updated_by
  // → NULL). Written under a relaxed guard (version-CAS + protection re-assert)
  // in their own batch so the pristine UPDATE's `updated_by IS NULL` guard stays
  // untouched. Counted `reimported_ai`.
  const aiReseeds: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  const resurrects: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // Issue #427, option 1: reissued tombstones whose slot master's row will
  // reclaim. Deliberately its OWN array, not folded into `resurrects` — reclaim
  // is semantically different (see the tombstone branch below and the "Batch
  // the reclaims" write site): resurrect only fires for a narrow self-heal case
  // (pristine content AND the last delete was a reimport prune bug) and keeps
  // the pristine guard (trashed_at/preserve/hint); reclaim fires for ANY
  // tombstone regardless of how/why it was deleted, because the row being
  // written is a completely different logical entity from whatever the
  // tombstone used to protect.
  const reclaims: Array<{ row: ParsedTsvRow; sortOrder: number; oldVersion: number }> = [];
  // Ids this pass has already INSERTED. `existing` is read once, before the
  // loop, and is never updated afterwards — so if master's own file carries the
  // same id twice, the second occurrence still finds nothing in `existing`,
  // reaches the insert, and is refused by ON CONFLICT with 0 changes. That is a
  // duplicate id ON MASTER, not a primary-key collision with a tombstone, and it
  // must NOT be counted as conflict_skipped: conflict_skipped withholds the
  // watermark, and a duplicate id never clears by itself, so mislabelling it
  // would freeze that book's export indefinitely over a cosmetic condition the
  // old code (rightly) treated as harmless. Upstream has shipped duplicated
  // master rows before (the ISA 48 delete+dup repair, the AI TN duplication
  // round-trip), so the case is real, not theoretical. Caught BEFORE the insert
  // so the two causes never share a counter.
  const insertedThisPass = new Set<string>();
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i];
    const sortOrder = nextSort(row.chapter, row.verse);
    const cur = existing.get(row.id);
    if (!cur) {
      if (insertedThisPass.has(row.id)) {
        counts.skipped_dup++;
        console.warn("reimport: master file carries this id more than once", {
          book,
          resource: kind,
          id: row.id,
          ref: row.refRaw,
        });
        continue;
      }
      if (skipDupIdx.has(i)) {
        counts.skipped_dup++;
        console.warn("reimport: skipped duplicate-content tn row", {
          book,
          id: row.id,
          chapter: row.chapter,
          verse: row.verse,
        });
        continue;
      }
      try {
        const outcome = await tryInsertTsvRow(env, book, kind, row, sortOrder);
        if (outcome === "inserted") {
          counts.inserted++;
          insertedThisPass.add(row.id);
          await logEdit(env, kind, row.id, book, userId, null, 1, "create", row);
        } else if (outcome === "unknown") {
          // D1 reported no row count, so we do not know whether this row landed.
          // Do NOT call that a conflict: `conflict_skipped` withholds the
          // watermark and a mis-read here would freeze the book's export on a
          // run where nothing was wrong. Taint the run instead — same "absent
          // measurement must not be laundered into a value" rule the rest of
          // this file follows, applied in the red direction as well as the green.
          counts.counts_incomplete = true;
          console.warn("reimport: insert returned no row count — treating as unknown, not as a conflict", {
            book,
            resource: kind,
            id: row.id,
          });
        } else if (row.idCoerced) {
          // The (book, id) slot is taken, but this id is OURS — coerceRowId
          // rewrote a malformed master id into a 96-id space, so a collision
          // here says nothing about master reissuing anything. Documented-benign
          // no-op (see ParsedTsvRow.idCoerced); count it as a duplicate, never as
          // a blocked drop, or a coercion collision would freeze the export.
          counts.skipped_dup++;
          console.warn("reimport: coerced id collided — benign, not counted as blocked", {
            book,
            resource: kind,
            coercedId: row.id,
            ref: row.refRaw,
          });
        } else {
          // 0 rows written by `ON CONFLICT(id, book) DO NOTHING` on a row the
          // diff said to insert, and NOT a duplicate id within master's own file
          // (that is caught above). The (book, id) slot is held by something the
          // `existing` read didn't return — in practice a row created between
          // the read and this insert. Issue #427 — count it as a conflict skip
          // and let it withhold the watermark. The old code called this "raced"
          // and folded it into skipped_noop, which both asserted an unmeasured
          // cause and hid a real drop inside a benign counter.
          counts.conflict_skipped++;
          noteBlockedSample(counts, `${kind} ${row.id} @ ${row.refRaw} (id already taken)`);
        }
      } catch (e) {
        counts.errors.push(`${kind} ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }
    // Tombstone master still carries. Normally a deleted row stays dead — but an
    // erroneous earlier prune (the HAB tn truncated-fetch incident: a short
    // master fetch soft-deleted 559 pristine rows master never actually dropped)
    // leaves a row that should still exist. Resurrect ONLY a pristine tombstone
    // whose latest delete was a reimport prune (source='dcs_reimport'); a
    // human-deleted/trashed row (or any non-reimport delete) stays dead. Must run
    // BEFORE the no-op check below: a tombstone whose content already matches
    // master still needs deleted_at cleared, so it can never be a no-op. See
    // tsvFetchLooksTruncated — this is the self-heal half of the same fix (the
    // gate stops new damage; this revives rows a past truncation already killed).
    if (cur.deleted_at != null) {
      if (isPristineTombstone(kind, cur) && (await lastTsvDeleteWasReimport(env, kind, row.id, book))) {
        resurrects.push({ row, sortOrder, oldVersion: Number(cur.version) });
      } else if (
        // Issue #427, option 1. The tombstone keeps its (book, id) primary key
        // forever, so master's row for that id cannot land via the normal INSERT
        // path — and that is CORRECT when master still carries it at the same
        // reference (a delete awaiting export: reclaiming there would resurrect
        // every pending deletion on the next nightly run). When master carries it
        // at a DIFFERENT reference the id has been reissued to a genuinely
        // different row, and master is authoritative for a row it still carries
        // — so RECLAIM the slot (batched below) instead of dropping it.
        // `!row.idCoerced` first: for a coerced id the "master reissued this id
        // to a different row" inference is meaningless — the id is ours, hashed
        // into a 96-id space, so landing on an unrelated tombstone at a
        // different reference is an expected collision, not evidence master
        // moved anything. Reclaiming (or counting it blocked) would either
        // corrupt an unrelated row or freeze the export over a documented-benign
        // no-op. See ParsedTsvRow.idCoerced.
        !row.idCoerced &&
        isReissuedTombstone(
          { refRaw: (cur.ref_raw as string | null) ?? null, chapter: Number(cur.chapter), verse: Number(cur.verse) },
          { refRaw: row.refRaw, chapter: row.chapter, verse: row.verse },
        )
      ) {
        reclaims.push({ row, sortOrder, oldVersion: Number(cur.version) });
      } else {
        // Same-reference tombstone (a delete awaiting export) — stays dead,
        // exactly as before this fix. Not counted tombstone_blocked: that would
        // withhold the watermark for a condition that clears itself once
        // tonight's export runs.
        counts.skipped_edited++;
      }
      continue;
    }
    // Classify content vs sort_order independently. A divergent sort_order on a
    // content-identical tn/twl row that already carries an order is a local
    // in-app reorder (rows.ts writes sort_order via a non-versioning fast path);
    // order flows app→master via the nightly export, so we must NOT adopt
    // master's file order and revert it — the HOS 11 TN / HOS 12 TWL
    // reorder-revert bug. That preservation is SCOPED: tq has no in-app reorder
    // (master owns its order), and a NULL sort_order has no order to preserve
    // (it must still be repaired to file order). Both fall through to the normal
    // adopt-from-master path. See classifyReimportRow for the full rationale.
    // NOTE: for twl this only preserves the row through the loop; canonical
    // (ULT-position) order is (re)asserted afterwards by the twl canonical
    // post-pass in runReimport, which owns twl sort_order.
    const contentMatches =
      tsvRowSignature(kind, storedTsvRowToParsed(kind, cur)) === tsvRowSignature(kind, row);
    const sortMatches = (cur.sort_order == null ? null : Number(cur.sort_order)) === sortOrder;
    const preserveLocalOrder = (kind === "tn" || kind === "twl") && cur.sort_order != null;
    // "reimportable" spans pristine AND AI-only (see isReimportableRow); aiOnly
    // is the AI-only sub-case (updated_by set but latest edit_log source is AI).
    const reimportable = isReimportableRow({
      updated_by: cur.updated_by as number | null,
      latestSource: (cur.latest_source as string | null) ?? null,
      deleted_at: cur.deleted_at as number | null,
      admin_bulk_state: (cur.admin_bulk_state as string | null) ?? null,
      trashed_at: cur.trashed_at as number | null,
      preserve: cur.preserve as number | null,
      hint: cur.hint as number | null,
      kind,
    });
    const aiOnly = reimportable && cur.updated_by != null;
    // Reorder interaction (by design, not a gap): a pure reorder writes only
    // sort_order via the rows.ts fast path — no version bump, no edit_log — so a
    // reordered AI row stays "AI-only". That's intended: reorder is transient
    // last-write-wins (rows.ts), and a HUMAN content edit is NOT transient — it
    // takes the versioning PATCH path, which logs a source=NULL edit_log row,
    // flipping isReimportableRow false (never re-seeded). For a content-IDENTICAL
    // reordered AI row, `contentMatches && preserveLocalOrder → noop` fires below
    // BEFORE the aiOnly re-seed, so the reorder is preserved (the reorder-revert
    // fix). Only a reordered AI row whose CONTENT also drifted on master takes
    // master wholesale (content + file order) — the re-seed we want.
    const fate = classifyReimportRow(contentMatches, sortMatches, reimportable, preserveLocalOrder, aiOnly);
    if (fate === "noop") {
      counts.skipped_noop++;
      continue;
    }
    if (fate === "edited") {
      counts.skipped_edited++;
      continue;
    }
    if (fate === "update_ai") {
      aiReseeds.push({ row, sortOrder, oldVersion: Number(cur.version) });
      continue;
    }
    updates.push({ row, sortOrder, oldVersion: Number(cur.version) });
  }

  // Batch the pristine UPDATEs, then audit only the ones that actually applied
  // (meta.changes > 0 — a row edited between read and batch fails the pristine +
  // version-CAS guard and is counted skipped_edited). On a batch() error record
  // it and move on; the chunk step retries and the next sync catches up.
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const slice = updates.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.updated++;
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} update batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the AI-only re-seeds (overwrite from master + reclaim to master-owned).
  // Relaxed guard vs the pristine UPDATE: no `updated_by IS NULL` (the row IS
  // AI-owned), but version-CAS (`AND version = oldVersion`) PLUS re-asserted
  // protections (deleted_at/trashed_at/preserve/hint) still fire — a human edit
  // landing between the read and the batch bumps version → 0 rows changed →
  // counted skipped_edited, never clobbered. `updated_by = NULL` in the SET
  // returns the row to master-owned. Audited as 'update'.
  for (let i = 0; i < aiReseeds.length; i += WRITE_BATCH) {
    const slice = aiReseeds.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, false, true)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "update", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} ai-reseed batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the resurrections (clear deleted_at + bring content to master). Same
  // version-CAS + pristine guard as the UPDATE path, but flipped to require a
  // tombstone (deleted_at IS NOT NULL); a row a human deleted/edited between the
  // read and the batch matches 0 rows and is counted skipped_edited. updated_by
  // stays NULL so the row remains reimport-owned. Audited as 'restore'.
  for (let i = 0; i < resurrects.length; i += WRITE_BATCH) {
    const slice = resurrects.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) => buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, true)),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.resurrected++;
          console.warn("reimport: resurrected pristine tombstone master still carries", {
            book,
            kind,
            id: u.row.id,
            chapter: u.row.chapter,
            verse: u.row.verse,
          });
          logs.push(logEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "restore", u.row));
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`${kind} resurrect batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Batch the reclaims (issue #427, option 1: overwrite a reissued tombstone's
  // slot with master's row — deliberately its own write, not folded into the
  // resurrect batch above). The guard is narrower than every other write in
  // this file on purpose: `deleted_at IS NOT NULL AND version = oldVersion`
  // ONLY — no `updated_by IS NULL` / trashed_at / preserve / hint re-assertion.
  // Those flags describe the OLD tombstoned row's protection state, and reclaim
  // discards that row's content wholesale in favor of master's — a completely
  // different logical row moving into a primary-key slot the old row merely
  // happened to vacate, not a continuation of it, so re-asserting its
  // protections would be checking the wrong row. version-CAS is still the full
  // safety net: a concurrent modification to the SAME tombstoned row (another
  // writer's resurrect/reclaim/edit landing between the read and this batch)
  // bumps its version and fails the CAS — that is NOT silently dropped (the
  // whole point of this fix is to stop silent drops): it falls back to
  // `tombstone_blocked`, exactly the pre-reclaim safety net, so a lost race is
  // never quieter than before this change. `updated_by = NULL` in the SET
  // starts master's row life master-owned, same as a fresh insert. Audited as
  // "create" — from this slot's new life's perspective, master's row IS a
  // fresh row, not an update to whatever used to occupy the slot.
  // RECLAIM_PAIR_BATCH (half of WRITE_BATCH): each reclaim travels as TWO
  // statements — the write immediately followed by its own SQL-`changes()`-
  // gated edit_log INSERT (gatedLogEditStmt) — in the SAME batch() call, so
  // chunking halves to stay within D1's ≤100-statement cap with twice the
  // statements per row. This keeps the write and its audit row atomic: the
  // audit row IS the boundary rowHistoryBoundary.ts relies on to hide the
  // dead tombstoned row's history from the reclaimed row, so a write that
  // landed with no matching log would leave that boundary permanently
  // missing — a RETRY can't repair it, because a reclaimed row is no longer a
  // tombstone and won't hit this branch again next run. Two separate batch()
  // calls (write batch, then a JS-gated log batch) would let a write batch
  // commit while the log batch failed independently — content correct, but
  // boundary silently missing forever.
  const RECLAIM_PAIR_BATCH = Math.floor(WRITE_BATCH / 2);
  for (let i = 0; i < reclaims.length; i += RECLAIM_PAIR_BATCH) {
    const slice = reclaims.slice(i, i + RECLAIM_PAIR_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const u of slice) {
      stmts.push(
        buildTsvUpdateStmt(env, book, kind, u.row, u.sortOrder, u.oldVersion, now, false, false, true),
        gatedLogEditStmt(env, kind, u.row.id, book, userId, u.oldVersion, u.oldVersion + 1, "create", u.row),
      );
    }
    try {
      const results = await env.DB.batch(stmts);
      slice.forEach((u, j) => {
        if ((results[j * 2]?.meta.changes ?? 0) > 0) {
          counts.tombstone_reclaimed++;
          console.warn("reimport: reclaimed reissued tombstone slot for master's row", {
            book,
            kind,
            id: u.row.id,
            chapter: u.row.chapter,
            verse: u.row.verse,
          });
        } else {
          // Lost the version-CAS race — something touched this tombstoned row
          // between the read and this batch. Fall back to the pre-reclaim
          // safety net so a lost race is never silently dropped: count it
          // tombstone_blocked (withholds the watermark) exactly as if reclaim
          // had never been attempted for this row. The paired log statement
          // also no-ops (its own `changes() > 0` gate sees the write's 0), so
          // no phantom audit row lands for a reclaim that didn't happen.
          counts.tombstone_blocked++;
          noteBlockedSample(
            counts,
            `${kind} ${u.row.id}: reclaim lost the version-CAS race, deleted row now reissued at ${u.row.refRaw}`,
          );
        }
      });
    } catch (e) {
      // Correctness-bearing: a thrown batch is one D1 transaction that never
      // committed, so NEITHER the write NOR its paired log landed for this
      // whole slice — this run must not be certified in sync, or the
      // reimport-sync step stamps the watermark over still-missing content
      // and the nightly export never retries. Taint apply_incomplete so the
      // sync step's sibling check withholds it; the next sync retries this
      // same slice from scratch (still tombstoned, since nothing landed).
      counts.apply_incomplete = true;
      counts.errors.push(`${kind} reclaim batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// Outcome of one `INSERT ... ON CONFLICT(id, book) DO NOTHING`.
//
// Deliberately TRI-state rather than a boolean (issue #427). The signal is
// D1's `meta.changes`, and the old `(r.meta.changes ?? 0) > 0` collapsed two
// very different situations into "not inserted": a real 0 (the primary key was
// taken — a measured conflict) and `undefined` (D1 did not report a row count
// at all). Since these counters now WITHHOLD the sync watermark, and that
// withhold has no automatic release, treating an unreported count as a measured
// conflict would recount every successful insert as a drop and freeze the book's
// export on a run where nothing was actually wrong.
//
// So: "unknown" is reported separately and taints the run (counts_incomplete)
// instead of asserting a conflict. That is the same direction the rest of this
// file takes — an absent measurement must never be laundered into a value, in
// EITHER direction (not into a green "0", and not into a red "conflict").
//
// NOTE the node:sqlite integration tests prove SQLite's semantics here, not
// D1's. They are strong evidence for the ON CONFLICT behavior but they cannot
// prove what D1 puts in `meta.changes`, which is exactly why this branch exists.
type TsvInsertOutcome = "inserted" | "conflict" | "unknown";

// The one place `meta.changes` is interpreted, so the undefined case cannot be
// re-collapsed at one of the three call sites and not the others.
function insertOutcome(r: { meta?: { changes?: number } }): TsvInsertOutcome {
  const changes = r.meta?.changes;
  if (changes === undefined || changes === null || !Number.isFinite(changes)) return "unknown";
  return changes > 0 ? "inserted" : "conflict";
}

// Returns "inserted" if the row was written, "conflict" if the (book, id) slot
// was already taken, "unknown" if D1 reported no row count (caller must not
// treat that as either).
async function tryInsertTsvRow(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  sortOrder: number,
): Promise<TsvInsertOutcome> {
  if (kind === "tn") {
    const r = await env.DB.prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.support_reference ?? null, row.quote ?? null,
        row.occurrence, row.note ?? null, sortOrder,
      )
      .run();
    return insertOutcome(r);
  }
  if (kind === "tq") {
    const r = await env.DB.prepare(
      `INSERT INTO tq_rows
         (id, book, chapter, verse, ref_raw, tags, quote, occurrence, question, response, sort_order)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(id, book) DO NOTHING`,
    )
      .bind(
        row.id, book, row.chapter, row.verse, row.refRaw,
        row.tags, row.quote ?? null, row.occurrence,
        row.question ?? null, row.response ?? null, sortOrder,
      )
      .run();
    return insertOutcome(r);
  }
  const r = await env.DB.prepare(
    `INSERT INTO twl_rows
       (id, book, chapter, verse, ref_raw, tags, orig_words, occurrence, tw_link, sort_order)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(id, book) DO NOTHING`,
  )
    .bind(
      row.id, book, row.chapter, row.verse, row.refRaw,
      row.tags, row.orig_words ?? null, row.occurrence, row.tw_link ?? null, sortOrder,
    )
    .run();
  return insertOutcome(r);
}

// True iff this stored row has never been touched by a human and isn't pending
// deletion — i.e. safe for the reimport to overwrite. In-memory mirror of the
// pristine SQL predicate, evaluated against the batched read.
function isPristineTsv(kind: TsvKind, row: Record<string, unknown>): boolean {
  if (row.updated_by != null) return false;
  if (row.deleted_at != null) return false;
  if (kind === "tn") {
    if (row.trashed_at != null) return false;
    if (Number(row.preserve ?? 0) !== 0) return false;
    if (Number(row.hint ?? 0) !== 0) return false;
  }
  return true;
}

// True iff this stored row is a TOMBSTONE that is otherwise pristine — deleted,
// but never human-edited, not in the trash queue, no preserve/hint. Mirror of
// isPristineTsv with the deleted_at test INVERTED. Column-shape only: it does
// NOT prove WHO deleted the row. A human trash promoted by the nightly job sets
// `deleted_at = trashed_at, trashed_at = NULL` and never touches updated_by, so
// it is column-identical to a reimport prune here — the caller MUST also gate on
// lastTsvDeleteWasReimport to keep human deletions dead.
function isPristineTombstone(kind: TsvKind, row: Record<string, unknown>): boolean {
  if (row.deleted_at == null) return false;
  if (row.updated_by != null) return false;
  if (kind === "tn") {
    if (row.trashed_at != null) return false;
    if (Number(row.preserve ?? 0) !== 0) return false;
    if (Number(row.hint ?? 0) !== 0) return false;
  }
  return true;
}

// True iff the most recent 'delete' on this row was a reimport prune
// (source='dcs_reimport'), not a human trash-finalize ('nightly_finalize') or
// any other delete. This is the ONLY signal that separates an erroneous
// truncated-fetch prune (resurrect it) from a human deletion (keep it dead),
// because the nightly trash promotion erases the column-level trace. One indexed
// read (edit_log_row covers kind, row_key); resurrection candidates are rare
// (normally zero — a tombstone whose id master still carries).
async function lastTsvDeleteWasReimport(
  env: Env,
  kind: TsvKind,
  id: string,
  book: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT source FROM edit_log
      WHERE kind = ?1 AND row_key = ?2 AND book = ?3 AND action = 'delete'
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(kind, id, book)
    .first<{ source: string | null }>();
  return row?.source === REIMPORT_SOURCE;
}

// ── Truncated-fetch completeness gate ───────────────────────────────────────
// Does this fetched TSV body look truncated relative to what D1 already holds?
// Compares parsed incoming rows (valid-id only, same normalizer the apply path
// uses) against live (non-deleted) D1 rows for the book/resource. Returns true
// → caller treats the fetch as failed (no apply / no prune / no watermark).
async function tsvFetchLooksTruncated(
  env: Env,
  book: string,
  kind: TsvKind,
  raw: string,
  held?: HeldOut,
): Promise<boolean> {
  // Compare like-for-like: EXCLUDE held-out chapters (issue #103) from both
  // sides. For a partial-source book the org file legitimately lacks the
  // cross-sourced chapters, so counting them on the live side would read the
  // org file as a catastrophic shrink and drop the whole reimport — starving the
  // OWNED chapters of their self-heal. The guard must judge only the chapters the
  // org file is expected to carry.
  const isHeld = (chapter: number) => (held ? isChapterHeldOut(held, chapter) : false);
  const liveRows = await env.DB.prepare(
    `SELECT chapter, COUNT(*) AS n FROM ${kind}_rows WHERE book = ?1 AND deleted_at IS NULL GROUP BY chapter`,
  )
    .bind(book)
    .all<{ chapter: number; n: number }>();
  let live = 0;
  for (const r of liveRows.results ?? []) if (!isHeld(Number(r.chapter))) live += Number(r.n);
  let incoming = 0;
  for (const r of parseTsv(raw).rows) {
    const p = parseTsvRow(r, kind);
    if (p && !isHeld(p.chapter)) incoming++;
  }
  if (!isCatastrophicTsvShrink(live, incoming)) return false;
  console.error(
    "reimport: incoming TSV is a catastrophic shrink vs live D1 — treating as a truncated fetch (no apply/prune/watermark)",
    { book, kind, liveRows: live, incomingRows: incoming },
  );
  return true;
}

// Build (don't run) the pristine UPDATE for one TSV row, for env.DB.batch().
// version-CAS (`AND version = oldVersion`) + the pristine predicate keep the
// write safe: a row a translator edited between the read and the batch matches
// 0 rows (meta.changes 0 → caller counts skipped_edited; no clobber, no audit).
// updated_by stays NULL so future re-imports still see the row as overwritable.
// `resurrect` flips the deleted_at guard: a normal pristine UPDATE requires a
// LIVE row (deleted_at IS NULL); a resurrection requires a TOMBSTONE
// (deleted_at IS NOT NULL) and clears it in the SET. `reseedAi` (mutually
// exclusive with resurrect and reclaim) is the AI-only re-seed: it DROPS the
// `updated_by IS NULL` guard (the row is AI-owned) and sets `updated_by = NULL`
// to reclaim it to master-owned — safety now rests on the version-CAS + the
// retained deleted_at/trashed_at/preserve/hint re-assertions.
// `reclaim` (mutually exclusive with resurrect and reseedAi; issue #427, option
// 1) is the reissued-tombstone slot reclaim: like resurrect it requires a
// TOMBSTONE (deleted_at IS NOT NULL) and clears it, but UNLIKE every other mode
// it drops the trashed_at/preserve/hint re-assertion entirely (`pristine`
// collapses to just the deletedGuard) — those flags describe the OLD
// tombstoned row's protection state, and master's incoming row is a
// completely different logical entity moving into a slot the old row merely
// vacated, not a continuation of it, so re-asserting them would be checking
// the wrong row's history. For the SAME reason, a tn reclaim also explicitly
// CLEARS trashed_at/preserve/hint in the SET (`clearProtections` below), and
// EVERY kind's reclaim clears restored_from_version (`clearReviewMeta` below;
// tn additionally clears review_kind/review_reason — in this fork those two
// columns exist on tn_rows only, migration 0031) — rather than leaving
// whatever the tombstoned row happened to hold. None of those columns are
// part of the pristine guard's WHERE for reclaim, so nothing else would ever
// reset them, and a human's "preserve this note"/"queue this as an AI hint"/
// "flag for review"/"showing as vN" intent for the OLD content must never
// silently apply to master's new content. It also drops the
// `updated_by IS NULL` guard (like reseedAi) and sets `updated_by = NULL`,
// starting master's row master-owned.
// version-CAS is the only guard reclaim keeps, and it is load-bearing: a
// concurrent write to the SAME tombstoned row between the read and this batch
// still fails the CAS and is caught by the caller (falls back to
// tombstone_blocked, never a silent drop). Bound-param positions are identical
// in all modes (the `= NULL` clauses carry no param), so the .bind() lists
// below are unchanged.
function buildTsvUpdateStmt(
  env: Env,
  book: string,
  kind: TsvKind,
  row: ParsedTsvRow,
  sortOrder: number,
  oldVersion: number,
  now: number,
  resurrect = false,
  reseedAi = false,
  reclaim = false,
): D1PreparedStatement {
  const deletedGuard = resurrect || reclaim ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  const ownerGuard = reseedAi || reclaim ? "" : "updated_by IS NULL AND ";
  const pristine = reclaim
    ? deletedGuard
    : kind === "tn"
      ? `${ownerGuard}${deletedGuard} AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `${ownerGuard}${deletedGuard}`;
  const clearDeleted = resurrect || reclaim ? "deleted_at = NULL, " : "";
  const clearOwner = reseedAi || reclaim ? "updated_by = NULL, " : "";
  // Reclaim ONLY (tn): master's row is starting a fresh life in this slot, the
  // same as a brand-new INSERT would (whose columns default to NULL/0 — see
  // tryInsertTsvRow, which never sets these three either). A tombstoned row's
  // trashed_at/preserve/hint describe intent a human set for the OLD content
  // (the trash queue, "protect from the AI sweep", "queue as an AI hint") —
  // carrying any of those forward onto master's unrelated new content would be
  // applying a human's decision to a row they never made it about. Every other
  // mode leaves these three columns alone (there's nothing to clear: the
  // pristine guard above already requires them clear before a normal
  // UPDATE/resurrect/reseed can proceed at all).
  const clearProtections = reclaim && kind === "tn" ? "trashed_at = NULL, preserve = 0, hint = 0, " : "";
  // Reclaim ONLY: restored_from_version (the "switch to vN" display chip, all
  // three kinds) and review_kind/review_reason (the flag-for-review markers —
  // tn-only columns in this fork, migration 0031) describe the OLD tombstoned
  // row, same rationale as clearProtections above. Left uncleared, a human's
  // stale "this needs review because X" or "showing as vN" carries onto
  // master's unrelated new content with no way to tell it's wrong.
  // Fresh-insert default for all of them is NULL (tryInsertTsvRow never sets
  // any).
  const clearReviewMeta = reclaim
    ? kind === "tn"
      ? "restored_from_version = NULL, review_kind = NULL, review_reason = NULL, "
      : "restored_from_version = NULL, "
    : "";
  const newVersion = oldVersion + 1;
  if (kind === "tn") {
    return env.DB.prepare(
      `UPDATE tn_rows
          SET ${clearDeleted}${clearOwner}${clearProtections}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              support_reference = ?5, quote = ?6, occurrence = ?7, note = ?8,
              sort_order = ?9, version = ?10, updated_at = ?11
        WHERE id = ?12 AND book = ?13 AND ${pristine} AND version = ?14`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.support_reference ?? null, row.quote ?? null, row.occurrence, row.note ?? null,
      sortOrder, newVersion, now, row.id, book, oldVersion,
    );
  }
  if (kind === "tq") {
    return env.DB.prepare(
      `UPDATE tq_rows
          SET ${clearDeleted}${clearOwner}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
              quote = ?5, occurrence = ?6, question = ?7, response = ?8,
              sort_order = ?9, version = ?10, updated_at = ?11
        WHERE id = ?12 AND book = ?13 AND ${pristine} AND version = ?14`,
    ).bind(
      row.refRaw, row.chapter, row.verse, row.tags,
      row.quote ?? null, row.occurrence, row.question ?? null, row.response ?? null,
      sortOrder, newVersion, now, row.id, book, oldVersion,
    );
  }
  return env.DB.prepare(
    `UPDATE twl_rows
        SET ${clearDeleted}${clearOwner}${clearReviewMeta}ref_raw = ?1, chapter = ?2, verse = ?3, tags = ?4,
            orig_words = ?5, occurrence = ?6, tw_link = ?7,
            sort_order = ?8, version = ?9, updated_at = ?10
      WHERE id = ?11 AND book = ?12 AND ${pristine} AND version = ?13`,
  ).bind(
    row.refRaw, row.chapter, row.verse, row.tags,
    row.orig_words ?? null, row.occurrence, row.tw_link ?? null,
    sortOrder, newVersion, now, row.id, book, oldVersion,
  );
}

// edit_log INSERT as a statement, for batching alongside the writes it audits.
// Same columns as logEdit (which stays for the per-row insert path).
function logEditStmt(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update" | "restore",
  payload: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE);
}

// SQL-`changes()`-gated sibling of logEditStmt, for a write+log pair that MUST
// travel in the SAME env.DB.batch() call, immediately adjacent (write, then
// this). D1 batches are transactional but are NOT one INSERT — two separate
// batch() calls (write batch, then a JS-meta.changes-gated log batch) can
// commit the first and lose the second independently, leaving a write with no
// audit row. `changes()` reflects the immediately-preceding statement in the
// SAME batch, so this only inserts when that statement actually changed a
// row — never a phantom audit row for a write that lost its guard/CAS. Same
// pattern as applyVerseRows' gated verse-audit INSERTs — reused here for the
// reclaim batch, which needs the same guarantee: a reclaim's audit row is also
// a history BOUNDARY (rowHistoryBoundary.ts) that must never land without the
// write it belongs to, or vice versa.
function gatedLogEditStmt(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update" | "restore",
  payload: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE changes() > 0`,
  ).bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE);
}

// ── Verses (ULT / UST) ─────────────────────────────────────────────────────

async function reimportVersesForChapter(
  env: Env,
  book: string,
  chapter: number,
  rawUsfm: string,
  bibleVersion: "ULT" | "UST",
  userId: number | null,
  intendedSrc?: ResourceSourceRef | null,
): Promise<ReimportCounts> {
  return applyVerseRows(
    env, book, bibleVersion,
    extractVersesForRange(rawUsfm, chapter, chapter),
    userId,
    intendedSrc,
  );
}

// Heal AI-mangled U+FFFD in `\zaln-s` source attributes (x-content / x-lemma /
// x-morph) on the incoming verses, reconstructing from the parallel UHB/UGNT row
// in D1, BEFORE the diff/write so the repaired (clean) content lands instead of
// re-importing upstream's garbled bytes. Gated on a string `.includes("�")`, so
// the source lookup only runs for the rare verse that carries the defect — no
// extra subrequests on clean chapters (which is every chapter in steady state).
// Structure-preserving (see healReplacementChars): only attribute strings change,
// so plain_text/verse_end are untouched and nothing unaligns. Mutates each
// affected verse's contentJson in place (the same objects the write + per-row
// fallback reuse).
async function healIncomingReplacementChars(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
): Promise<void> {
  const need = verses.filter((v) => v.contentJson.includes("�"));
  if (need.length === 0) return;
  const srcVersion = NT_BOOKS.has(book) ? "UGNT" : "UHB";
  const chapters = [...new Set(need.map((v) => v.chapter))];
  const ph = chapters.map((_c, i) => `?${i + 3}`).join(", ");
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, content_json FROM verses
      WHERE book = ?1 AND bible_version = ?2 AND source_generation = 1 AND chapter IN (${ph})`,
  )
    .bind(book, srcVersion, ...chapters)
    .all<{ chapter: number; verse: number; content_json: string }>();
  const srcByKey = new Map<string, SourceWord[]>();
  for (const r of rs.results ?? []) {
    try {
      const vo = (JSON.parse(r.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [];
      srcByKey.set(`${r.chapter}:${r.verse}`, collectSourceWords(vo));
    } catch {
      /* unparseable source row — leave the target's FFFD unrepaired */
    }
  }
  for (const v of need) {
    let parsed: { verseObjects?: unknown[] };
    try {
      parsed = JSON.parse(v.contentJson) as { verseObjects?: unknown[] };
    } catch {
      continue;
    }
    const report = healReplacementChars(parsed.verseObjects ?? [], srcByKey.get(`${v.chapter}:${v.verse}`) ?? []);
    if (report.repaired.length > 0) v.contentJson = JSON.stringify(parsed);
    if (report.unrepaired.length > 0) {
      console.warn("reimport: unrepaired U+FFFD in alignment source attrs", {
        book,
        bibleVersion,
        chapter: v.chapter,
        verse: v.verse,
        unrepaired: report.unrepaired,
      });
    }
  }
}

// Reconcile the source-owned `\zaln-s` attributes (x-content/x-lemma/x-morph) of
// an EDITED verse against the incoming master verse, returning the merged
// content_json (translator's target text + grouping preserved, source spelling
// adopted from master) plus a count of source divergences that couldn't be
// uniquely reconciled. `changed` is false (json === d1Json) when nothing applied.
// Unparseable input is treated as a no-op (changed:false) so a malformed row can
// never throw out of the verse diff loop. See reconcileSourceAttrsFromMaster.
function reconcileEditedVerseSourceAttrs(
  d1Json: string,
  masterJson: string,
): { changed: boolean; json: string; divergent: number } {
  let d1Parsed: { verseObjects?: unknown[] };
  let masterParsed: { verseObjects?: unknown[] };
  try {
    d1Parsed = JSON.parse(d1Json) as { verseObjects?: unknown[] };
    masterParsed = JSON.parse(masterJson) as { verseObjects?: unknown[] };
  } catch {
    return { changed: false, json: d1Json, divergent: 0 };
  }
  const report = reconcileSourceAttrsFromMaster(d1Parsed.verseObjects ?? [], masterParsed.verseObjects ?? []);
  const changed = report.reconciled.length > 0;
  return { changed, json: changed ? JSON.stringify(d1Parsed) : d1Json, divergent: report.divergent.length };
}

// Confirm the lane's active generation + source owner/repo/ref still match the
// identity we intend to write. Uncached D1 read. Returns null on freeze /
// quarantine / mismatch so callers can abort with zero writes (and no watermark).
async function verifyVerseWriteIdentity(
  env: Env,
  bibleVersion: "ULT" | "UST",
  intended: ResourceSourceRef | null | undefined,
): Promise<ResourceSourceRef | null> {
  const lane = laneForBibleVersion(bibleVersion);
  if (!lane) return null;
  const row = await requireLaneState(env, lane);
  if (row.replacement_job_id || row.replacement_required) return null;
  const cfg = activeLaneConfig(row);
  const live: ResourceSourceRef = {
    generation: row.active_generation,
    owner: cfg.source.owner,
    repo: cfg.source.repo,
    ref: cfg.source.ref,
  };
  if (intended) {
    if (
      live.generation !== intended.generation ||
      // owner/repo are DCS names (case-insensitive); ref stays exact.
      !sameDcsName(live.owner, intended.owner) ||
      !sameDcsName(live.repo, intended.repo) ||
      live.ref !== intended.ref
    ) {
      return null;
    }
  }
  return live;
}

// Per-verse upsert over already-parsed verses (keys off each verse's own
// chapter, so it works across a whole chunk range). Batched: ONE read of the
// current rows for these verses' chapters, an in-memory diff, then
// PRISTINE_PAIR_BATCH-sized batch() calls of the INSERT/UPDATE writes, each
// verse's write immediately followed by its own SQL-`changes()`-gated audit
// row IN THE SAME batch() call. This collapses the old 2–5 D1 round-trips PER
// VERSE (insert-probe + select + update + version re-select + edit_log) down
// to a couple of subrequests per chunk — the fix for the nightly sync blowing
// the 10k-per-invocation subrequest budget on large books (PSA's ~5k ULT+UST
// verses alone exceeded it, starving every later book). Chunking (rather than
// one unchunked batch() for the whole chapter) matters on its own: D1 caps a
// single batch at 100 statements, same as every other write site in this file
// — an unchunked call on a chapter with >50 changed verses (e.g. a
// chapter-wide master change to PSA 119) would throw and silently degrade to
// the per-row fallback for the WHOLE chapter, blowing the very subrequest
// budget this batching exists to protect. content_json / plain_text /
// verse_end are stored byte-for-byte exactly as extractVersesForRange
// produced them; nothing about the USFM parse changes. The pristine guard
// (updated_by IS NULL) stays ON each UPDATE, so a translator edit landing
// between the read and the batch matches 0 rows — no clobber, and that
// statement's own meta.changes is what routes it to skipped_edited rather
// than counting a phantom update. On a slice's batch error we fall back to
// the isolated per-row path for just that slice, so one bad verse — or one
// oversized chapter — can't sink the whole book.
// An EDITED verse (updated_by != null) is NOT overwritten, but its source-owned
// `\zaln-s` attributes (x-content/x-lemma/x-morph) are reconciled from master in
// a separate version-CAS batch (see reconcileEditedVerseSourceAttrs) so a curated
// original-language fix isn't reverted by re-exporting stale source bytes.
// DO NOT revert this to a per-row loop: that regression silently reintroduced
// the subrequest cap once (PR #180 batched it → a refactor un-batched it → PR
// #195 re-batched). See the nightly-sync-subrequest-cap memory.
async function applyVerseRows(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
  intendedSrc?: ResourceSourceRef | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (verses.length === 0) return counts;

  // Capture (or re-verify) the intended source identity before any write. A
  // freeze / generation flip / source swap mid-run → zero writes, no watermark.
  const identity = await verifyVerseWriteIdentity(env, bibleVersion, intendedSrc);
  if (!identity) return counts;
  const gen = identity.generation;
  const lane = laneForBibleVersion(bibleVersion)!;

  // Heal AI-mangled U+FFFD source attributes before the diff so we never write
  // (or no-op against) upstream's garbled bytes. No-op + zero extra reads unless
  // an incoming verse actually carries the defect.
  await healIncomingReplacementChars(env, book, bibleVersion, verses);

  // Re-verify immediately before the write batch — a replacement may have
  // activated during the (potentially slow) heal / read above.
  const recheck = await verifyVerseWriteIdentity(env, bibleVersion, identity);
  if (!recheck) return counts;

  const now = Math.floor(Date.now() / 1000);

  // 1. Read the current rows for exactly these verses' chapters in ONE query
  //    (callers pass a single chapter's verses, so the IN list is tiny).
  const chapters = [...new Set(verses.map((v) => v.chapter))];
  const chPlaceholders = chapters.map((_, i) => `?${i + 4}`).join(", ");
  const existingRs = await env.DB.prepare(
    `SELECT chapter, verse, content_json, plain_text, verse_end, version, updated_by,
            (SELECT source FROM edit_log
               WHERE kind = 'verse'
                 AND row_key = ?1 || '/' || chapter || '/' || verse || '/' || ?2
                 AND (book = ?1 OR book IS NULL)
                 AND action IN ('create', 'update')
               ORDER BY id DESC LIMIT 1) AS latest_source
       FROM verses
      WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3 AND chapter IN (${chPlaceholders})`,
  )
    .bind(book, bibleVersion, gen, ...chapters)
    .all<{
      chapter: number;
      verse: number;
      content_json: string;
      plain_text: string | null;
      verse_end: number | null;
      version: number;
      updated_by: number | null;
      latest_source: string | null;
    }>();
  const existing = new Map<string, (typeof existingRs.results)[number]>();
  for (const r of existingRs.results) existing.set(`${r.chapter}:${r.verse}`, r);

  // 2. Diff in memory. Stage a write only for verses that are new or
  //    pristine-and-changed; count no-ops / edited rows straight from the
  //    read. inserted/updated are tallied per-statement from meta.changes once
  //    each chunk's batch commits (see step 3) — never assumed up front, since
  //    an INSERT can lose its NOT-EXISTS race and an UPDATE can lose its
  //    `updated_by IS NULL` guard to a concurrent edit.
  const pristineWrites: Array<{
    v: VerseExtract;
    isInsert: boolean;
    stmt: D1PreparedStatement;
    // The audit row, gated on SQL-side `changes() > 0` (not a JS check after
    // the fact) so it MUST land in the exact same batch() call as `stmt`,
    // immediately after it — D1 batches are transactional, so this keeps the
    // write and its audit row atomic: either both commit or neither does.
    // Splitting them into two separate batch() calls (write batch, then a
    // JS-gated log batch) would let a log-batch failure after a landed write
    // batch leave version-bumped verses with no edit_log row, and the per-row
    // fallback couldn't recover them (it would see the content already
    // matching and count a no-op). See step 3 below.
    logStmt: D1PreparedStatement;
  }> = [];
  // Edited verses whose source-owned alignment attrs were reconciled from master
  // (target text + grouping unchanged). Written in a separate version-CAS batch.
  const sourceReconciles: Array<{ v: VerseExtract; mergedJson: string; oldVersion: number; plainText: string | null }> = [];
  // AI-only verses (updated_by set but written by the AI pipeline, never
  // human-edited) to re-seed fully from master + reclaim to master-owned. Written
  // in a version-CAS batch below (the main batch's UPDATE guards on
  // `updated_by IS NULL`, which an AI-only verse fails). Counted `reimported_ai`.
  const aiReseeds: Array<{ v: VerseExtract; oldVersion: number }> = [];
  for (const v of verses) {
    const ex = existing.get(`${v.chapter}:${v.verse}`);
    const rowKey = `${book}/${v.chapter}/${v.verse}/${bibleVersion}`;
    if (!ex) {
      pristineWrites.push({
        v,
        isInsert: true,
        stmt: env.DB.prepare(
          `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
            WHERE NOT EXISTS (
              SELECT 1 FROM verses
               WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?5 AND source_generation = ?6
            )
              AND EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = ?9 AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?6
            )`,
        ).bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText, lane),
        // Conditional on the INSERT actually landing: the NOT-EXISTS guard
        // means a verse that already exists (created between our read and
        // this batch) inserts 0 rows — don't log a phantom restorable v1.
        logStmt: env.DB.prepare(
          `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, source_generation)
           SELECT 'verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5, ?6
            WHERE changes() > 0`,
        ).bind(rowKey, book, userId, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE, gen),
      });
      continue;
    }
    if (ex.updated_by != null) {
      // updated_by is set — but by WHOM? An AI-only verse (the AI pipeline wrote
      // it, no human has edited it since: latest content edit_log source is
      // ai_pipeline) is NOT translator-owned, so re-seed it fully from master and
      // reclaim it to master-owned (updated_by → NULL) — the fix for AI-generated
      // verses being wrongly reported "skipped (already edited)".
      const aiOnly = isReimportableRow({
        updated_by: ex.updated_by,
        latestSource: ex.latest_source ?? null,
        deleted_at: null,
        kind: "verse",
      });
      if (aiOnly) {
        if (
          ex.content_json === v.contentJson &&
          (ex.plain_text ?? null) === (v.plainText ?? null) &&
          (ex.verse_end ?? null) === (v.verseEnd ?? null)
        ) {
          counts.skipped_noop++;
        } else {
          aiReseeds.push({ v, oldVersion: ex.version });
        }
        continue;
      }
      // Genuinely human-edited verse: the translator owns the target text +
      // grouping, so we never overwrite the verse. BUT the original-language
      // source attributes on its `\zaln-s` milestones (x-content/x-lemma/x-morph)
      // are SOURCE-owned, not translator-owned — reconcile just those from master
      // so a curated source fix (e.g. the NUM 20–22 combining-mark correction)
      // isn't reverted when the nightly export re-renders this verse. Staged into
      // a separate version-CAS batch below; if nothing reconciled it stays a plain
      // edited skip. (verses analogue of the TWL-PSA / Hebrew-NFC clobber class.)
      const rec = reconcileEditedVerseSourceAttrs(ex.content_json, v.contentJson);
      if (rec.divergent > 0) {
        counts.source_attr_divergent += rec.divergent;
        console.warn("reimport: source-attr divergence on edited verse couldn't be uniquely reconciled from master", {
          book, bibleVersion, chapter: v.chapter, verse: v.verse, divergent: rec.divergent,
        });
      }
      if (rec.changed) {
        sourceReconciles.push({ v, mergedJson: rec.json, oldVersion: ex.version, plainText: ex.plain_text });
      } else {
        counts.skipped_edited++;
      }
      continue;
    }
    if (
      ex.content_json === v.contentJson &&
      (ex.plain_text ?? null) === (v.plainText ?? null) &&
      (ex.verse_end ?? null) === (v.verseEnd ?? null)
    ) {
      counts.skipped_noop++;
      continue;
    }
    // Pristine + changed → update. The guard stays on the UPDATE; new_version is
    // ex.version + 1 because the update only applies while the row is untouched.
    pristineWrites.push({
      v,
      isInsert: false,
      stmt: env.DB.prepare(
        `UPDATE verses
            SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                version = version + 1, updated_at = ?4
          WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
            AND source_generation = ?9 AND updated_by IS NULL
            AND EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = ?10 AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?9
            )`,
      ).bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion, gen, lane),
      // Conditional on the UPDATE actually landing (mirrors verses.ts).
      // The UPDATE is guarded on `updated_by IS NULL`, so if an editor touched
      // this verse between our read and this batch the UPDATE matches 0 rows —
      // but the content we'd log never landed. An unconditional insert would
      // record a phantom restorable version carrying stale DCS content (and
      // could shadow the real ex.version+1 the editor just created). changes()
      // reflects the immediately-preceding UPDATE in this batch.
      logStmt: env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, source_generation)
         SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7, ?8
          WHERE changes() > 0`,
      ).bind(rowKey, book, userId, ex.version, ex.version + 1, JSON.stringify({ plain_text: v.plainText, content: v.contentJson }), REIMPORT_SOURCE, gen),
    });
  }

  // 3. Chunked batches for all pristine INSERT/UPDATE writes, each verse's
  //    write statement immediately followed by its own SQL-`changes()`-gated
  //    audit row IN THE SAME batch() call — two statements per verse, so
  //    chunked at PRISTINE_PAIR_BATCH (half of WRITE_BATCH) to stay within
  //    the same ≤100-statement D1 cap this file asserts everywhere else.
  //    Keeping the write and its audit row in one atomic batch (rather than
  //    a separate follow-up batch of logs) matters: a batch() call is one D1
  //    transaction, so either both land or neither does — if a (separate)
  //    log batch failed after the write batch had already landed, the catch
  //    below would fall back to the per-row path, which would see the
  //    content already matching and count a silent no-op, permanently
  //    losing the audit row for a verse whose version really did bump.
  //    changes() reflects the immediately-preceding statement, so a lost
  //    race (the NOT-EXISTS guard on the INSERT; the `updated_by IS NULL`
  //    guard losing to a concurrent edit on the UPDATE) is never logged as a
  //    phantom restorable version and never counted as inserted/updated — a
  //    lost UPDATE is routed to skipped_edited (mirrors the aiReseeds/
  //    sourceReconciles batches below); a lost INSERT is routed to
  //    skipped_noop (the verse now exists, same as reading it fresh would
  //    have shown). On a slice failure, only that slice falls back to the
  //    isolated per-row path so one bad verse — or one oversized chapter's
  //    worth of verses — can't sink the whole book. (Edited-verse
  //    source-attr reconciles run in their own batch below — they're
  //    version-CAS-guarded, not updated_by-guarded, so they can't share this
  //    path's pristine semantics.)
  const PRISTINE_PAIR_BATCH = Math.floor(WRITE_BATCH / 2);
  for (let i = 0; i < pristineWrites.length; i += PRISTINE_PAIR_BATCH) {
    const slice = pristineWrites.slice(i, i + PRISTINE_PAIR_BATCH);
    const stmts: D1PreparedStatement[] = [];
    for (const w of slice) stmts.push(w.stmt, w.logStmt);
    try {
      const results = await env.DB.batch(stmts);
      slice.forEach((w, j) => {
        const changed = (results[j * 2]?.meta?.changes ?? 0) > 0;
        if (!changed) {
          if (w.isInsert) counts.skipped_noop++;
          else counts.skipped_edited++;
          return;
        }
        if (w.isInsert) counts.inserted++;
        else counts.updated++;
      });
    } catch (e) {
      console.error("reimport verse batch failed; falling back per-row", {
        book,
        bibleVersion,
        chapters,
        error: e instanceof Error ? e.message : String(e),
      });
      addCounts(counts, await applyVerseRowsPerRow(env, book, bibleVersion, slice.map((w) => w.v), userId, identity));
    }
  }

  // 4. Reconcile source-owned alignment attrs on edited verses. Separate batch:
  //    the UPDATE is guarded on version-CAS (`AND version = oldVersion`) but
  //    intentionally NOT on `updated_by IS NULL` — the verse IS edited; only its
  //    source spelling syncs, and updated_by is left untouched so the row stays
  //    translator-owned. A translator edit landing between the read and the batch
  //    bumps version → matches 0 rows → counted skipped_edited (no clobber).
  //    Audited only when the UPDATE actually applied (meta.changes > 0).
  for (let i = 0; i < sourceReconciles.length; i += WRITE_BATCH) {
    const slice = sourceReconciles.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) =>
          env.DB.prepare(
            `UPDATE verses
                SET content_json = ?1, version = version + 1, updated_at = ?2
              WHERE book = ?3 AND chapter = ?4 AND verse = ?5 AND bible_version = ?6
                AND source_generation = ?7 AND version = ?8
                AND EXISTS (
                  SELECT 1 FROM scripture_lane_state
                   WHERE lane = ?9 AND replacement_job_id IS NULL
                     AND replacement_required = 0 AND active_generation = ?7
                )`,
          ).bind(u.mergedJson, now, book, u.v.chapter, u.v.verse, bibleVersion, gen, u.oldVersion, lane),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.source_attr_reconciled++;
          console.warn("reimport: reconciled source-owned \\zaln attrs on edited verse from master", {
            book, bibleVersion, chapter: u.v.chapter, verse: u.v.verse,
          });
          logs.push(
            logEditStmt(
              env, "verse",
              `${book}/${u.v.chapter}/${u.v.verse}/${bibleVersion}`,
              book, userId, u.oldVersion, u.oldVersion + 1, "update",
              { plain_text: u.plainText, content: u.mergedJson },
            ),
          );
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`verse source-attr reconcile batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5. Re-seed AI-only verses from master + reclaim to master-owned. Separate
  //    batch: version-CAS-guarded (`AND version = oldVersion`), NOT
  //    `updated_by IS NULL` — the verse IS AI-owned, and we set `updated_by = NULL`
  //    to return it to master-owned. A human edit landing between the read and the
  //    batch bumps version → 0 rows → counted skipped_edited (no clobber). Audited
  //    only when the UPDATE actually applied.
  for (let i = 0; i < aiReseeds.length; i += WRITE_BATCH) {
    const slice = aiReseeds.slice(i, i + WRITE_BATCH);
    try {
      const results = await env.DB.batch(
        slice.map((u) =>
          env.DB.prepare(
            `UPDATE verses
                SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                    updated_by = NULL, version = version + 1, updated_at = ?4
              WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
                AND source_generation = ?9 AND version = ?10
                AND EXISTS (
                  SELECT 1 FROM scripture_lane_state
                   WHERE lane = ?11 AND replacement_job_id IS NULL
                     AND replacement_required = 0 AND active_generation = ?9
                )`,
          ).bind(u.v.contentJson, u.v.plainText, u.v.verseEnd, now, book, u.v.chapter, u.v.verse, bibleVersion, gen, u.oldVersion, lane),
        ),
      );
      const logs: D1PreparedStatement[] = [];
      slice.forEach((u, j) => {
        if ((results[j]?.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          logs.push(
            logEditStmt(
              env, "verse",
              `${book}/${u.v.chapter}/${u.v.verse}/${bibleVersion}`,
              book, userId, u.oldVersion, u.oldVersion + 1, "update",
              { plain_text: u.v.plainText, content: u.v.contentJson },
            ),
          );
        } else {
          counts.skipped_edited++;
        }
      });
      if (logs.length) await env.DB.batch(logs);
    } catch (e) {
      counts.errors.push(`verse ai-reseed batch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return counts;
}

// Per-row upsert fallback — the original, error-isolated implementation. Invoked
// only when the batched applyVerseRows hits an atomic batch() error, so one bad
// verse can't sink a whole chapter. Keys off each verse's own chapter.
async function applyVerseRowsPerRow(
  env: Env,
  book: string,
  bibleVersion: "ULT" | "UST",
  verses: VerseExtract[],
  userId: number | null,
  intendedSrc?: ResourceSourceRef | null,
): Promise<ReimportCounts> {
  const counts = zeroCounts();
  if (verses.length === 0) return counts;

  const identity = await verifyVerseWriteIdentity(env, bibleVersion, intendedSrc);
  if (!identity) return counts;
  const gen = identity.generation;
  const lane = laneForBibleVersion(bibleVersion)!;

  const now = Math.floor(Date.now() / 1000);
  for (const v of verses) {
    // Re-verify per verse so a mid-loop activation can't write into a new gen.
    const still = await verifyVerseWriteIdentity(env, bibleVersion, identity);
    if (!still) return counts;
    try {
      // Try insert first; cheap signal for "doesn't exist locally".
      const ins = await env.DB.prepare(
        `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
          WHERE NOT EXISTS (
            SELECT 1 FROM verses
             WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?5 AND source_generation = ?6
          )
            AND EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?9 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?6
          )`,
      )
        .bind(book, v.chapter, v.verse, v.verseEnd, bibleVersion, gen, v.contentJson, v.plainText, lane)
        .run();
      if ((ins.meta.changes ?? 0) > 0) {
        counts.inserted++;
        await logEdit(
          env, "verse",
          `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
          book, userId, null, 1, "create",
          { plain_text: v.plainText, content: v.contentJson },
        );
        continue;
      }
      // Exists locally — SELECT first so we can short-circuit on byte-equal
      // content. content_json is produced by extractVersesForRange in both
      // directions (bootstrap + reimport), so byte-compare is stable for
      // pristine rows. version/updated_by/latest_source drive the pristine vs
      // AI-only vs human-edited classification (mirrors the batched path).
      const existing = await env.DB.prepare(
        `SELECT content_json, plain_text, verse_end, version, updated_by,
                (SELECT source FROM edit_log
                   WHERE kind = 'verse'
                     AND row_key = ?1 || '/' || ?2 || '/' || ?3 || '/' || ?4
                     AND (book = ?1 OR book IS NULL)
                     AND action IN ('create', 'update')
                   ORDER BY id DESC LIMIT 1) AS latest_source
           FROM verses
          WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4
            AND source_generation = ?5`,
      )
        .bind(book, v.chapter, v.verse, bibleVersion, gen)
        .first<{
          content_json: string;
          plain_text: string | null;
          verse_end: number | null;
          version: number;
          updated_by: number | null;
          latest_source: string | null;
        }>();
      if (
        existing &&
        existing.content_json === v.contentJson &&
        (existing.plain_text ?? null) === (v.plainText ?? null) &&
        (existing.verse_end ?? null) === (v.verseEnd ?? null)
      ) {
        counts.skipped_noop++;
        continue;
      }
      // AI-only verse (updated_by set, latest content edit_log source is AI):
      // re-seed from master + reclaim to master-owned via a version-CAS UPDATE
      // (no `updated_by IS NULL` guard). A human edit landing first bumps version
      // → 0 rows → skipped_edited. Human-edited verses fall through to the
      // pristine UPDATE below, whose `updated_by IS NULL` guard skips them.
      const aiOnly =
        existing != null &&
        existing.updated_by != null &&
        isReimportableRow({
          updated_by: existing.updated_by,
          latestSource: existing.latest_source ?? null,
          deleted_at: null,
          kind: "verse",
        });
      if (aiOnly) {
        const upd = await env.DB.prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  updated_by = NULL, version = version + 1, updated_at = ?4
            WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
              AND source_generation = ?9 AND version = ?10
              AND EXISTS (
                SELECT 1 FROM scripture_lane_state
                 WHERE lane = ?11 AND replacement_job_id IS NULL
                   AND replacement_required = 0 AND active_generation = ?9
              )`,
        )
          .bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion, gen, existing!.version, lane)
          .run();
        if ((upd.meta.changes ?? 0) > 0) {
          counts.reimported_ai++;
          await logEdit(
            env, "verse",
            `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
            book, userId, existing!.version, existing!.version + 1, "update",
            { plain_text: v.plainText, content: v.contentJson },
          );
        } else {
          counts.skipped_edited++;
        }
        continue;
      }
      const upd = await env.DB.prepare(
        `UPDATE verses
            SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                version = version + 1, updated_at = ?4
          WHERE book = ?5 AND chapter = ?6 AND verse = ?7 AND bible_version = ?8
            AND source_generation = ?9 AND updated_by IS NULL
            AND EXISTS (
              SELECT 1 FROM scripture_lane_state
               WHERE lane = ?10 AND replacement_job_id IS NULL
                 AND replacement_required = 0 AND active_generation = ?9
            )`,
      )
        .bind(v.contentJson, v.plainText, v.verseEnd, now, book, v.chapter, v.verse, bibleVersion, gen, lane)
        .run();
      if ((upd.meta.changes ?? 0) > 0) {
        counts.updated++;
        const got = await env.DB.prepare(
          `SELECT version FROM verses
            WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4
              AND source_generation = ?5`,
        )
          .bind(book, v.chapter, v.verse, bibleVersion, gen)
          .first<{ version: number }>();
        if (got) {
          await logEdit(
            env, "verse",
            `${book}/${v.chapter}/${v.verse}/${bibleVersion}`,
            book, userId, got.version - 1, got.version, "update",
            { plain_text: v.plainText, content: v.contentJson },
          );
        }
      } else {
        counts.skipped_edited++;
      }
    } catch (e) {
      counts.errors.push(
        `verse ${bibleVersion} ${book} ${v.chapter}:${v.verse}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return counts;
}

// ── Audit ──────────────────────────────────────────────────────────────────

async function logEdit(
  env: Env,
  kind: "tn" | "tq" | "twl" | "verse",
  rowKey: string,
  book: string,
  userId: number | null,
  prevVersion: number | null,
  newVersion: number,
  action: "create" | "update",
  payload: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO edit_log
       (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(kind, rowKey, book, userId, prevVersion, newVersion, action, JSON.stringify(payload), REIMPORT_SOURCE)
    .run();
}

// ── Chunked, SHA-gated, diff-aware reimport (Workflow path) ─────────────────
//
// reimportBookFromDcs (above) runs in one call and is used by the HTTP route
// (client-supplied chapters) + first-time bootstrap. It is NOT safe inside a
// Cloudflare Workflow step for a large book — per-chapter re-parse + sequential
// D1 round-trips blow the 600 000 ms step limit (what failed on Isaiah). The
// functions below run the same row-level logic but:
//   1. skip a whole (book,resource) when its DCS file commit SHA is unchanged,
//   2. fetch each changed file once and stage it to R2,
//   3. process chapters in REIMPORT_CHAPTER_CHUNK-sized Workflow steps,
//   4. for TSV, skip chapters whose pristine content already matches DCS.
// No per-book lock is taken: a Workflow step REPLAYS on retry, so a held lock
// would self-deadlock; the pristine `WHERE updated_by IS NULL ...` UPDATE guard
// (unchanged) is the real protection against clobbering a concurrent edit.

interface StagedResource {
  resource: Resource;
  changed: boolean;        // false → SHA unchanged or DCS 404; skipped
  masterSha: string | null;
  r2Key: string | null;    // staged file location when changed
  /** Source identity captured at plan time — used for watermarks + write gates. */
  src: ResourceSourceRef | null;
  /** Per-chapter hold-out (issue #103). Chapters sourced off the org repo are
   *  applied/pruned from neither this staged org file nor the export — a whole-
   *  book hold-out is dropped at plan time (never staged), so this only ever
   *  carries a PARTIAL set. Absent → nothing held out. */
  held?: HeldOut;
}

interface ReimportPlan {
  maxChapter: number;
  entries: StagedResource[];
}

function freshPerResource(): Record<Resource, ReimportCounts> {
  return { ult: zeroCounts(), ust: zeroCounts(), tn: zeroCounts(), tq: zeroCounts(), twl: zeroCounts() };
}

function mergePerResource(
  into: Record<Resource, ReimportCounts>,
  from: Record<Resource, ReimportCounts>,
): void {
  for (const r of ALL_RESOURCES) addCounts(into[r], from[r]);
}

function emptyResult(book: string): ReimportResult {
  return { book, perResource: freshPerResource(), totals: zeroCounts() };
}

async function readStaged(env: Env, key: string): Promise<string | null> {
  const obj = await env.BLOBS.get(key);
  return obj ? await obj.text() : null;
}

// Full source identity a (book,resource) watermark is keyed by. Scripture
// (ult/ust) tracks its lane's active source owner/repo/ref + active generation;
// other resources track the project org + role repo on master at generation 1.
export interface ResourceSourceRef {
  generation: number;
  owner: string;
  repo: string;
  ref: string;
}

// Resolve the source identity for a (book,resource) sync watermark. ULT/UST
// read live lane state (active generation + the lane's source owner/repo/ref);
// tn/tq/twl use the project config org + role repo on master at generation 1
// (origSourceGeneration — also the sentinel used for UHB/UGNT originals).
export async function resourceSourceRef(
  env: Env,
  resource: Resource,
  cfg: ProjectConfig,
): Promise<ResourceSourceRef> {
  const lane = laneForBibleVersion(resource === "ult" ? "ULT" : resource === "ust" ? "UST" : resource);
  if (lane) {
    const row = await requireLaneState(env, lane);
    const laneCfg = activeLaneConfig(row);
    return {
      generation: row.active_generation,
      owner: laneCfg.source.owner,
      repo: laneCfg.source.repo,
      ref: laneCfg.source.ref,
    };
  }
  // tn/tq/twl — project org + role repo on master at generation 1.
  // Narrow away ult/ust (handled above via lane) so we can index cfg.repos.
  if (resource === "ult" || resource === "ust") {
    return {
      generation: origSourceGeneration(),
      owner: cfg.org,
      repo: resource === "ult" ? cfg.repos.lit : cfg.repos.sim,
      ref: "master",
    };
  }
  return {
    generation: origSourceGeneration(),
    owner: cfg.org,
    repo: cfg.repos[resource],
    ref: "master",
  };
}

// Upsert the per-(book,resource,generation,owner,repo,ref) sync watermark.
// `origin` is provenance only; only 'import'/'reimport' watermarks are written
// as skip gates ('reimport_withheld' carries the sentinel SHA, which never
// matches a real commit, so it can never act as one). source_repo is part of
// the identity key (migration 0044).
export async function recordResourceSync(
  env: Env,
  book: string,
  resource: Resource,
  sha: string,
  origin: "import" | "reimport" | "export" | "reimport_withheld",
  source: ResourceSourceRef,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO book_resource_syncs (
       book, resource, source_generation, source_owner, source_repo, source_ref, source_sha, synced_at, origin
     )
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), ?8)
     ON CONFLICT(book, resource, source_generation, source_owner, source_repo, source_ref) DO UPDATE SET
       source_sha = excluded.source_sha,
       synced_at = excluded.synced_at,
       origin = excluded.origin`,
  )
    .bind(book, resource, source.generation, source.owner, source.repo, source.ref, sha, origin)
    .run();
}

// A watermark recorded under a DIFFERENT source identity (generation, owner,
// repo, or ref) describes a different upstream — treat it as absent (fail-open:
// the reimport refetches, the export freshness gate sees "no watermark"). This
// is what makes switching a project's org/lane source safe rather than silently
// trusting a stale SHA.
export async function storedResourceSha(
  env: Env,
  book: string,
  resource: Resource,
  source: ResourceSourceRef,
): Promise<string | null> {
  const row = await env.DB.prepare(
    // source_owner/source_repo are DCS names (case-insensitive);
    // source_generation and source_ref (a git ref) are NOT.
    //
    // Migration 0069 made book_resource_syncs.source_owner (part of the PK)
    // COLLATE NOCASE, so both the explicit `COLLATE NOCASE` in the WHERE clause
    // and the bare `source_owner = ?4` in the ORDER BY tiebreak are now
    // case-insensitive — the tiebreak no longer distinguishes rows by exact
    // casing the way it did when the column was BINARY. That's fine: 0069's
    // preflight aborts the migration if any two rows already differ only by
    // source_owner casing, so no case-variant duplicate PK can survive into a
    // NOCASE column, and this ORDER BY is left in place only as defense in
    // depth for a lookup that can no longer actually see two candidate rows.
    `SELECT source_sha FROM book_resource_syncs
      WHERE book = ?1 AND resource = ?2
        AND source_generation = ?3 AND source_owner = ?4 COLLATE NOCASE
        AND source_repo = ?5 COLLATE NOCASE AND source_ref = ?6
      ORDER BY (source_owner = ?4 AND source_repo = ?5) DESC, synced_at DESC
      LIMIT 1`,
  )
    .bind(book, resource, source.generation, source.owner, source.repo, source.ref)
    .first<{ source_sha: string | null }>();
  return row?.source_sha ?? null;
}

// Sentinel SHA that can never equal a real git commit SHA. Written by
// recordWithheldSyncIfAbsent below when a (book, resource) has NO existing
// watermark row under the current source identity and this run is withholding
// the stamp (a dropped master row — see shouldRecordResourceSync).
// Consequences, both intentional:
//   - checkMasterFreshness (exportWorkflow.ts) compares this sentinel against
//     master's real SHA, which never matches → returns `master_ahead` instead
//     of the current `no_watermark` (which returns ok:true and bypasses the
//     freshness gate entirely) → the export honestly skips with `export_stale`.
//   - planAndStageBookResources's SHA skip-gate (`fileCommitSha === stored`)
//     also never matches this sentinel → the file is re-fetched and staged
//     again next night, which is the desired retry.
// A real SHA recorded later via recordResourceSync's normal upsert overwrites
// this sentinel with no special handling — same UPSERT, no code path cares
// which sha was there before.
const WITHHELD_SYNC_SENTINEL_SHA = "withheld";

// Guarantee the freshness gate has SOMETHING to compare against for a
// (book, resource) whose watermark stamp we're withholding this run. Without
// this, a book with no `book_resource_syncs` row at all under this source
// identity (seeded imports whose fetch-time SHA came back null — see
// bookImport.ts; scripts/import-book.mjs, which never writes one; or a source
// identity that just switched, which storedResourceSha treats as absent) sees
// withholding change nothing: checkMasterFreshness reports `no_watermark`
// (ok:true) either way, and the export proceeds on stale D1 data indefinitely
// — the silent-revert outcome the withhold exists to prevent, just reached
// from "no watermark" instead of "stale watermark".
//
// Deliberately a no-op when a row already exists (real OR previously
// withheld) — see storedResourceSha's contract: an older real SHA already
// yields `master_ahead` on its own, which is correct and preserves a genuine
// "last synced" SHA; overwriting it here would throw that useful information
// away for no benefit.
export async function recordWithheldSyncIfAbsent(
  env: Env,
  book: string,
  resource: Resource,
  source: ResourceSourceRef,
): Promise<void> {
  const existing = await storedResourceSha(env, book, resource, source);
  if (existing) return;
  await recordResourceSync(env, book, resource, WITHHELD_SYNC_SENTINEL_SHA, "reimport_withheld", source);
}

// Comparable-field signature for a normalized TSV row. MUST cover exactly the
// columns applyTsvRows' no-op check compares (same fields, same null
// normalization) — note sort_order is NOT in the signature; applyTsvRows checks
// it separately — so a signature + sort_order match is equivalent to a no-op.
function tsvRowSignature(kind: TsvKind, r: ParsedTsvRow): string {
  const f =
    kind === "tn"
      ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.support_reference ?? null, r.quote ?? null, r.occurrence ?? null, r.note ?? null]
      : kind === "tq"
        ? [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.quote ?? null, r.occurrence ?? null, r.question ?? null, r.response ?? null]
        : [r.refRaw, r.chapter, r.verse, r.tags ?? null, r.orig_words ?? null, r.occurrence ?? null, r.tw_link ?? null];
  return JSON.stringify(f);
}

const TSV_STORED_COLS: Record<TsvKind, string> = {
  tn: "ref_raw, chapter, verse, tags, support_reference, quote, occurrence, note",
  tq: "ref_raw, chapter, verse, tags, quote, occurrence, question, response",
  twl: "ref_raw, chapter, verse, tags, orig_words, occurrence, tw_link",
};

// Build a ParsedTsvRow from a stored D1 row so it yields the same signature an
// incoming TSV row would.
function storedTsvRowToParsed(kind: TsvKind, row: Record<string, unknown>): ParsedTsvRow {
  const base: ParsedTsvRow = {
    id: String(row.id),
    refRaw: (row.ref_raw as string | null) ?? "",
    chapter: Number(row.chapter),
    verse: Number(row.verse),
    occurrence: (row.occurrence as number | null) ?? null,
    tags: (row.tags as string | null) ?? null,
  };
  if (kind === "tn") {
    base.support_reference = (row.support_reference as string | null) ?? null;
    base.quote = (row.quote as string | null) ?? null;
    base.note = (row.note as string | null) ?? null;
  } else if (kind === "tq") {
    base.quote = (row.quote as string | null) ?? null;
    base.question = (row.question as string | null) ?? null;
    base.response = (row.response as string | null) ?? null;
  } else {
    base.orig_words = (row.orig_words as string | null) ?? null;
    base.tw_link = (row.tw_link as string | null) ?? null;
  }
  return base;
}

// Chapters whose pristine D1 content differs from the incoming DCS TSV. A
// chapter is "unchanged" (skippable) ONLY when its incoming {id → signature}
// map equals its stored-pristine map exactly. Detects add/change/delete and id
// moves; errs toward "changed" whenever an edited (non-pristine) row is present
// (excluded from the stored map → chapter re-runs, edited row skipped
// harmlessly). A perf filter — it can never skip a real update.
export async function changedTsvChapters(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
): Promise<Set<number>> {
  const pristine =
    kind === "tn"
      ? `updated_by IS NULL AND deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `updated_by IS NULL AND deleted_at IS NULL`;

  const incoming = new Map<number, Map<string, string>>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p || p.chapter < 1) continue;
    let m = incoming.get(p.chapter);
    if (!m) incoming.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  const stored = new Map<number, Map<string, string>>();
  const res = await env.DB.prepare(
    `SELECT id, ${TSV_STORED_COLS[kind]} FROM ${kind}_rows WHERE book = ?1 AND ${pristine}`,
  )
    .bind(book)
    .all<Record<string, unknown>>();
  for (const row of res.results) {
    const p = storedTsvRowToParsed(kind, row);
    if (p.chapter < 1) continue;
    let m = stored.get(p.chapter);
    if (!m) stored.set(p.chapter, (m = new Map()));
    m.set(p.id, tsvRowSignature(kind, p));
  }

  const changed = new Set<number>();
  for (const ch of new Set<number>([...incoming.keys(), ...stored.keys()])) {
    const a = incoming.get(ch) ?? new Map<string, string>();
    const b = stored.get(ch) ?? new Map<string, string>();
    if (a.size !== b.size) { changed.add(ch); continue; }
    let same = true;
    for (const [id, sig] of a) {
      if (b.get(id) !== sig) { same = false; break; }
    }
    if (!same) changed.add(ch);
  }
  return changed;
}

// Soft-delete rows no HUMAN owns that master no longer carries, so the nightly
// export can't resurrect an out-of-band deletion. Mirrors pipelineImport.ts
// deleteUnkeptTns and the app's DELETE handler shape (rows.ts): set
// deleted_at, bump version, audit a 'delete'. "No human owns it" spans both
// pristine (updated_by IS NULL) AND AI-only rows (updated_by set but the latest
// content edit_log source is ai_pipeline) — the same isReimportableRow rule the
// apply path uses, so a row the AI wrote and master later dropped is pruned
// instead of lingering and re-exporting (the apply/prune consistency the
// reimported_ai fix would otherwise miss). Conservative on every axis: only
// chapters the incoming file covers AND the diff gate flagged as changed (a
// deletion always flags its chapter), never under an active pipeline lock, and
// the WRITE re-asserts version-CAS + the deleted/trashed/preserve/hint
// protections (NOT updated_by IS NULL — an AI-only row carries the starter's id,
// exactly as deleteUnkeptTns notes) so a human edit landing after the SELECT
// bumps version → 0 rows → skipped. updated_by → NULL reclaims the tombstone to
// reimport-owned. The id comparison is against the WHOLE file's id set so a row
// the update path just moved to another chapter isn't mistaken for removed.
async function softDeleteRemovedTsvRows(
  env: Env,
  book: string,
  kind: TsvKind,
  rawTsv: string,
  candidateChapters: number[],
): Promise<{ deleted: number; skippedLocked: number }> {
  const incomingIds = new Set<string>();
  const coveredChapters = new Set<number>();
  for (const r of parseTsv(rawTsv).rows) {
    const p = parseTsvRow(r, kind);
    if (!p) continue;
    incomingIds.add(p.id);
    if (p.chapter >= 1) coveredChapters.add(p.chapter);
  }
  // Defensive: an empty or garbled file must never sweep a book clean.
  if (incomingIds.size === 0) return { deleted: 0, skippedLocked: 0 };

  // SELECT filters the human-owned protections that are stable columns
  // (deleted/trashed/preserve/hint) but NOT updated_by — an AI-only row carries
  // the starter's id yet is still prunable. latest_source separates AI-only from
  // a human edit (isReimportableRow decides). The WRITE guard below re-asserts
  // the same protections + version-CAS (deleteUnkeptTns pattern).
  const selectProtections =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0`
      : `deleted_at IS NULL`;
  const writeGuard =
    kind === "tn"
      ? `deleted_at IS NULL AND trashed_at IS NULL AND preserve = 0 AND hint = 0 AND version = ?4`
      : `deleted_at IS NULL AND version = ?4`;
  // twl has no admin_bulk_state column (only tn/tq carry the bulk review-state
  // stamp), so select a literal NULL for it there and keep one row shape.
  const bulkStateCol = kind === "twl" ? "NULL AS admin_bulk_state" : "admin_bulk_state";
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let skippedLocked = 0;
  for (const ch of candidateChapters) {
    if (!coveredChapters.has(ch)) continue;
    if (await activePipelineForChapter(env, book, ch)) {
      skippedLocked++;
      continue;
    }
    const rs = await env.DB.prepare(
      `SELECT id, version, updated_by, ${bulkStateCol},
              (SELECT source FROM edit_log
                 WHERE kind = ?3 AND row_key = ${kind}_rows.id
                   AND (book = ?1 OR book IS NULL)
                   AND action IN ('create', 'update')
                 ORDER BY id DESC LIMIT 1) AS latest_source
         FROM ${kind}_rows WHERE book = ?1 AND chapter = ?2 AND ${selectProtections}`,
    )
      .bind(book, ch, kind)
      .all<{
        id: string;
        version: number;
        updated_by: number | null;
        admin_bulk_state: string | null;
        latest_source: string | null;
      }>();
    const targets = (rs.results ?? []).filter(
      (r) =>
        !incomingIds.has(r.id) &&
        isReimportableRow({
          updated_by: r.updated_by,
          latestSource: r.latest_source ?? null,
          deleted_at: null,
          admin_bulk_state: r.admin_bulk_state ?? null,
          trashed_at: null,
          preserve: 0,
          hint: 0,
          kind,
        }),
    );
    for (const t of targets) {
      // updated_by → NULL reclaims the tombstone to reimport-owned; version-CAS
      // (?4) + the re-asserted protections abort if a human touched the row
      // between the SELECT and here (bumps version → 0 rows changed).
      const upd = await env.DB.prepare(
        `UPDATE ${kind}_rows
            SET deleted_at = ?1, updated_by = NULL, version = version + 1, updated_at = ?1
          WHERE id = ?2 AND book = ?3 AND ${writeGuard}`,
      )
        .bind(now, t.id, book, t.version)
        .run();
      if (!upd.meta.changes) continue;
      deleted++;
      await env.DB.prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'delete', ?6)`,
      )
        .bind(kind, t.id, book, t.version, t.version + 1, REIMPORT_SOURCE)
        .run();
    }
  }
  return { deleted, skippedLocked };
}

// Alerts raised by the reimport target the operator's banner feed (the SPA
// polls GET /api/alerts/me). Same recipient convention as exportWorkflow.ts's
// EXPORT_ALERT_USERNAME.
const REIMPORT_ALERT_USERNAME = "deferredreward";

// Banner for issue #427's withhold. This one NEEDS an alert in a way most
// withholds do not, and the difference is the whole reason it exists: before
// option 1 shipped, a reissued tombstone blocked EVERY run, forever, until a
// human acted — the soft-deleted row keeps its (book, id) slot forever, master
// keeps carrying that id, and every subsequent night re-stages the file (the
// SHA gate cannot skip it — the watermark was never advanced), re-drops the
// same rows, and re-withholds.
//
// Issue #427's option 1 (reclaim a reissued id) has now SHIPPED — see the
// tombstone branch of applyTsvRows and the "Batch the reclaims" write site —
// and runs automatically, in the SAME run a reissued tombstone is first
// detected, so the common case this alert used to describe no longer produces
// a `tombstone_blocked` count at all: master's row lands, reclaimed, same
// night. `tombstone_blocked` now fires ONLY for the residual: a reclaim
// attempt that LOST the version-CAS race against a concurrent writer touching
// the SAME tombstoned row between the read and the write. Unlike the pre-fix
// permanent freeze, that is expected to self-heal on the NEXT sync once the
// race that caused it has resolved — but "usually self-heals" is not the same
// as "guaranteed to clear silently," so this alert still fires for it.
// `conflict_skipped` (the OTHER half of this alert — an INSERT-path race
// against a row the in-memory diff never saw) is unrelated to option 1 and
// keeps its original semantics and its original "does not clear on its own"
// framing.
//
// The freeze itself is still the correct fail-safe direction while either
// count is nonzero — exporting instead would render a D1 that is short of
// master back over master, deleting master's rows, the original 1CH failure
// class — but a freeze nobody is told about is not safe, it is just quiet.
// The freshness-gate skip surfaces as export_stale too, and its implicit
// advice — "re-run the sync, then re-export" — cannot possibly work for the
// conflict_skipped half, because re-running the sync re-encounters the same
// collision. So this alert names the measured cause and the rows, and gives a
// remedy that can actually clear it.
//
// The wording states only what the code measured: the counters, and the sampled
// rows themselves. It does NOT claim which of the two situations produced any
// given `tombstone_blocked` row (an id genuinely re-minted for a new row, versus
// a maintainer re-anchoring the Reference of a row we had deleted) — the
// reference test cannot separate those, and asserting either would repeat the
// mistake this repo has a standing lesson about. That ambiguity now drives an
// actual reclaim WRITE rather than merely a freeze — see isReissuedTombstone's
// KNOWN FALSE POSITIVE note in reimportClassify.ts for what that means.
async function raiseTombstoneBlockAlert(
  env: Env,
  book: string,
  resource: Resource,
  counts: ReimportCounts,
): Promise<void> {
  const blocked = counts.tombstone_blocked ?? 0;
  const conflicts = counts.conflict_skipped ?? 0;
  const samples = counts.blocked_samples ?? [];
  const source = `reimport_id_blocked:${book}:${resource}`;
  const shown = samples.slice(0, 10);
  const more = blocked + conflicts - shown.length;
  const message =
    `Benjamin — tonight's Door43 sync could not import ${blocked + conflicts} ${book} ` +
    `${resource.toUpperCase()} row(s) because their IDs are still held in our database by ` +
    `soft-deleted rows (a deleted row keeps its ID for that book permanently). Those rows are ` +
    `MISSING from the app, so ${book} ${resource.toUpperCase()} has been left marked out of sync and ` +
    `will NOT export to Door43 until this is cleared — otherwise the export would delete those same ` +
    `rows from Door43. ` +
    (blocked > 0
      ? `${blocked} lost the automatic reclaim's version-CAS race against a concurrent writer on the ` +
        `same deleted row (usually clears on its own next sync, once that race resolves)`
      : "") +
    (blocked > 0 && conflicts > 0 ? "; " : "") +
    (conflicts > 0 ? `${conflicts} refused by the database as an ID already in use` : "") +
    `. Affected: ${shown.join(" | ")}${more > 0 ? ` (and ${more} more)` : ""}. ` +
    (conflicts > 0
      ? `The ID-already-in-use row(s) do NOT clear on their own — the next sync hits the same collision; ` +
        `give the affected row(s) a different ID on Door43. `
      : "") +
    (blocked > 0
      ? `The reclaim-race row(s) above should resolve automatically; if this persists across multiple ` +
        `nights for the same row, something is wrong with the automatic reclaim (upstream issue #427, ` +
        `option 1) and it needs a human look.`
      : "");
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(REIMPORT_ALERT_USERNAME, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(REIMPORT_ALERT_USERNAME, "error", source, message, null)
      .run();
  } catch (e) {
    // Best-effort, exactly like every other alert helper in this codebase: a
    // failed banner must never fail the reimport. The withhold itself already
    // happened.
    console.error("reimport tombstone-block alert failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Clears a resource's reimport_id_blocked alert (raiseTombstoneBlockAlert)
// once its sync actually succeeds and a watermark is recorded. The alert's
// own text promises the reclaim-race half of the count "usually clears on
// its own next sync" — but without this function, the ONLY place that
// DELETE runs is inside raiseTombstoneBlockAlert itself, which fires only
// while the resource is STILL withheld. A resource that recovers next run
// never calls it again, so a resolved alert would stay active in the banner
// forever, falsely claiming the resource was still out of sync. Called from
// the sync-success branch in runChunkedReimport, immediately after
// recordResourceSync lands — see clearTombstoneBlockAlertForTest for the
// reimportJourney.test.mjs coverage. Best-effort like every other alert
// helper here: a failed cleanup must never fail the reimport, and clearing
// an alert that doesn't exist (the common case — most resources never had
// one) is a harmless no-op DELETE.
async function clearTombstoneBlockAlert(env: Env, book: string, resource: Resource): Promise<void> {
  const source = `reimport_id_blocked:${book}:${resource}`;
  try {
    await env.DB.prepare(`DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`)
      .bind(REIMPORT_ALERT_USERNAME, source)
      .run();
  } catch (e) {
    console.error("reimport tombstone-block alert clear failed", {
      book,
      resource,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Reimport self-heal for a book whose ULT/UST were held out of the nightly
// reimport by a translate-mode import's English fallback. Mutates `scriptureHeld`
// (deleting each released resource so the caller's stage loop re-pulls it) and
// clears the matching book_imports.*_source columns in one UPDATE.
//
//  - LOCKED (textReadOnly) lanes release UNCONDITIONALLY via
//    releaseLockedLaneHoldOuts — a published Bible never legitimately sources
//    English, so a non-null column is always poison (the #440 case).
//  - UNLOCKED lanes release only when `probe` reports the lane repo now serves
//    the book (shouldReleaseProbedHoldOut) — the column can be a legitimate
//    404-only fallback, so it must not be cleared blind (issue #441).
//
// `probe` is injected (not fetched inline) so the decision + the column-clear
// SQL are testable against the real schema without a network — see
// scriptureSelfHeal.test.mjs. Returns what was released for logging/tests.
export async function selfHealScriptureHoldOuts(
  env: Env,
  book: string,
  scriptureHeld: Set<Resource>,
  lockedLanes: LockedLanes,
  probe: (resource: "ult" | "ust") => Promise<FetchTextResult>,
): Promise<{ locked: ("ult" | "ust")[]; probed: ("ult" | "ust")[] }> {
  const locked = releaseLockedLaneHoldOuts(scriptureHeld, lockedLanes);
  for (const r of locked) scriptureHeld.delete(r);

  const probed: ("ult" | "ust")[] = [];
  for (const r of unlockedLaneHoldOutsToProbe(scriptureHeld, lockedLanes)) {
    if (shouldReleaseProbedHoldOut(await probe(r))) probed.push(r);
  }
  for (const r of probed) scriptureHeld.delete(r);

  const cleared = [...locked, ...probed];
  if (cleared.length > 0) {
    const cols = cleared.map((r) => `${r}_source = NULL`).join(", ");
    await env.DB.prepare(`UPDATE book_imports SET ${cols} WHERE book = ?1`).bind(book).run();
    console.warn("reimport: released scripture hold-out", { book, locked, probed });
  }
  return { locked, probed };
}

// SHA-gate each requested resource and stage the changed ones to R2. Returns
// the book's chapter extent + a manifest the chunk steps read from.
async function planAndStageBookResources(
  env: Env,
  book: string,
  resources: Resource[],
  instanceId: string,
): Promise<ReimportPlan> {
  const maxRow = await env.DB
    .prepare(`SELECT MAX(chapter) AS m FROM verses WHERE book = ?1`)
    .bind(book)
    .first<{ m: number | null }>();
  const maxChapter = maxRow?.m ?? 0;
  if (maxChapter < 1) return { maxChapter, entries: [] };

  // Same held-out guard runReimport applies (issue #103): a book whose tn/tq
  // came from Aquifer, the English translationSource, or a per-chapter override
  // must never be re-fetched from the configured org repo for the held-out
  // chapters. `.all` (whole-book) → a no-op entry (never fetch/watermark, as
  // before). A PARTIAL set → still stage the org file for the OWNED chapters and
  // carry the held-out ranges so the chunk apply + prune skip them. Only queried
  // when tn/tq are actually requested, matching the guard in runReimport.
  const needsNoteProv = resources.some((r) => r === "tn" || r === "tq");
  // Scripture/twl hold-out (issue #142): whole-book only — unlike tn/tq there is
  // no per-chapter-range override mechanism for ult/ust/twl, so a non-null
  // book_imports.*_source column always means the WHOLE book is held out for
  // that resource. Only queried when one of those resources is requested.
  const needsScriptureProv = resources.some((r) => r === "ult" || r === "ust" || r === "twl");
  const [cfg, prov] = await Promise.all([
    getProjectConfig(env),
    needsNoteProv || needsScriptureProv
      ? env.DB
          .prepare(
            `SELECT tn_source, tq_source, ult_source, ust_source, twl_source
               FROM book_imports WHERE book = ?1`,
          )
          .bind(book)
          .first<{
            tn_source: string | null;
            tq_source: string | null;
            ult_source: string | null;
            ust_source: string | null;
            twl_source: string | null;
          }>()
      : Promise.resolve(null),
  ]);
  const heldByResource: Partial<Record<"tn" | "tq", HeldOut>> = {};
  for (const r of ["tn", "tq"] as const) {
    if (!resources.includes(r)) continue;
    heldByResource[r] = await heldOutChapters(env, cfg, book, r, r === "tn" ? prov?.tn_source : prov?.tq_source);
  }
  const scriptureHeld: Set<Resource> = needsScriptureProv ? heldOutNoteResources(prov) : new Set();
  // Self-heal for books whose lane was loaded from the English translationSource
  // by a pre-fix / scaffold-only translate-mode import. A LOCKED (textReadOnly)
  // lane releases unconditionally (a published Bible never legitimately sources
  // English — the #440 case). An UNLOCKED lane's column can be a legitimate
  // 404-only fallback, so it releases only after PROBING the lane repo and
  // finding the book now present (issue #441 — the fallback never lifting once
  // the org populates its own scripture repo). Either release clears the stale
  // provenance so this pass re-pulls the lane repo's own pristine rows.
  if (scriptureHeld.has("ult") || scriptureHeld.has("ust")) {
    const [litRow, simRow] = await Promise.all([requireLaneState(env, "lit"), requireLaneState(env, "sim")]);
    const lockedLanes: LockedLanes = {
      lit: activeLaneConfig(litRow).textReadOnly,
      sim: activeLaneConfig(simRow).textReadOnly,
    };
    await selfHealScriptureHoldOuts(env, book, scriptureHeld, lockedLanes, async (resource) => {
      const file = dcsResourceFile(cfg, book, resource);
      if (!file) return { status: 0, text: null }; // unknown book/path → transient, keep held
      const src = await resourceSourceRef(env, resource, cfg);
      return fetchTextWithStatus(env, dcsRawUrl(env, src.owner, src.repo, file.path, src.ref));
    });
  }

  const entries: StagedResource[] = [];
  for (const resource of resources) {
    if (resource === "tn" || resource === "tq") {
      const held = heldByResource[resource];
      if (held?.all) {
        entries.push({ resource, changed: false, masterSha: null, r2Key: null, src: null });
        continue;
      }
    }
    if ((resource === "ult" || resource === "ust" || resource === "twl") && scriptureHeld.has(resource)) {
      // Source-pulled scripture/twl: never re-fetch from the org/lane repo —
      // no watermark write either, exactly like the tn/tq whole-book case above.
      entries.push({ resource, changed: false, masterSha: null, r2Key: null, src: null });
      continue;
    }
    const file = dcsResourceFile(cfg, book, resource);
    if (!file) { entries.push({ resource, changed: false, masterSha: null, r2Key: null, src: null }); continue; }

    const src = await resourceSourceRef(env, resource, cfg);
    const masterSha = await fileCommitSha(env, src.owner, src.repo, file.path, src.ref);
    const stored = await storedResourceSha(env, book, resource, src);
    // Skip ONLY on a positive SHA match (fail-open: null/unknown → reimport).
    if (masterSha && stored && masterSha === stored) {
      entries.push({ resource, changed: false, masterSha, r2Key: null, src });
      continue;
    }

    // Fetch from the immutable commit SHA when we have one (same discipline as
    // stageBook) so the bytes we stage cannot diverge from the watermark SHA
    // if master moves between the SHA lookup and the raw fetch.
    const fetchRef = masterSha ?? src.ref;
    const raw = await fetchText(dcsRawUrl(env, src.owner, src.repo, file.path, fetchRef));
    if (raw == null) {
      // DCS 404 / fetch error → nothing to import, no watermark.
      entries.push({ resource, changed: false, masterSha: null, r2Key: null, src });
      continue;
    }
    // Completeness gate (TSV only). A truncated body must NOT be staged or get a
    // watermark — otherwise it prunes the book AND certifies it "in sync",
    // hiding the damage (the HAB tn incident). masterSha:null here is critical:
    // the reimport-sync step only stamps watermarks for entries with a masterSha.
    if (
      (resource === "tn" || resource === "tq" || resource === "twl") &&
      (await tsvFetchLooksTruncated(
        env,
        book,
        resource,
        raw,
        resource === "tn" || resource === "tq" ? heldByResource[resource] : undefined,
      ))
    ) {
      entries.push({ resource, changed: false, masterSha: null, r2Key: null, src });
      continue;
    }
    const r2Key = `reimport-stage/${instanceId}/${book}/${resource}`;
    await env.BLOBS.put(r2Key, raw);
    const held = resource === "tn" || resource === "tq" ? heldByResource[resource] : undefined;
    entries.push({ resource, changed: true, masterSha, r2Key, src, held });
  }
  return { maxChapter, entries };
}

// Reimport one chapter range from staged files. Reads each staged file once,
// then loops chapters. TSV chapters absent from changedTsv[kind] are skipped.
async function reimportStagedChunk(
  env: Env,
  book: string,
  startChapter: number,
  endChapter: number,
  staged: StagedResource[],
  changedTsv: Partial<Record<TsvKind, number[]>>,
  userId: number | null,
): Promise<Record<Resource, ReimportCounts>> {
  const perResource = freshPerResource();

  // Read + parse each staged file ONCE for the whole chunk (not per chapter).
  // The old per-chapter calls re-parsed the entire book each time (usfm.toJSON
  // / parseTsv), which tripped the per-step CPU limit on large books.
  const rawByResource: Partial<Record<Resource, string>> = {};
  for (const e of staged) {
    if (!e.changed || !e.r2Key) continue;
    const raw = await readStaged(env, e.r2Key);
    if (raw != null) rawByResource[e.resource] = raw;
  }

  // USFM: one parse of the chunk range per version, grouped by chapter.
  const versesByChapter: Partial<Record<"ult" | "ust", Map<number, VerseExtract[]>>> = {};
  for (const resource of ["ult", "ust"] as const) {
    const raw = rawByResource[resource];
    if (!raw) continue;
    const byCh = new Map<number, VerseExtract[]>();
    for (const ve of extractVersesForRange(raw, startChapter, endChapter)) {
      let arr = byCh.get(ve.chapter);
      if (!arr) byCh.set(ve.chapter, (arr = []));
      arr.push(ve);
    }
    versesByChapter[resource] = byCh;
  }

  // TSV: one parse per kind, grouped by chapter (within the chunk range).
  const rowsByChapter: Partial<Record<TsvKind, Map<number, ParsedTsvRow[]>>> = {};
  for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
    const raw = rawByResource[kind];
    if (!raw) continue;
    const byCh = new Map<number, ParsedTsvRow[]>();
    for (const r of parseTsv(raw).rows) {
      const p = parseTsvRow(r, kind);
      if (!p || p.chapter < startChapter || p.chapter > endChapter) continue;
      let arr = byCh.get(p.chapter);
      if (!arr) byCh.set(p.chapter, (arr = []));
      arr.push(p);
    }
    rowsByChapter[kind] = byCh;
  }

  const changedSets: Partial<Record<TsvKind, Set<number>>> = {};
  for (const k of ["tn", "tq", "twl"] as TsvKind[]) {
    if (changedTsv[k]) changedSets[k] = new Set(changedTsv[k]);
  }

  // Per-chapter hold-out (issue #103): chapters this resource sourced off the org
  // repo must not be applied from the staged org file. (Whole-book hold-out never
  // reaches here — planAndStageBookResources drops it as a no-op entry.)
  const heldByKind: Partial<Record<TsvKind, HeldOut>> = {};
  for (const e of staged) {
    if ((e.resource === "tn" || e.resource === "tq") && e.held) heldByKind[e.resource] = e.held;
  }

  for (let chapter = startChapter; chapter <= endChapter; chapter++) {
    const lock = await activePipelineForChapter(env, book, chapter);
    if (lock) {
      for (const e of staged) if (e.changed) perResource[e.resource].skipped_locked++;
      continue;
    }
    for (const kind of ["tn", "tq", "twl"] as TsvKind[]) {
      const byCh = rowsByChapter[kind];
      if (!byCh) continue;
      const held = heldByKind[kind];
      if (held && isChapterHeldOut(held, chapter)) continue;  // sourced off-org — don't clobber
      const set = changedSets[kind];
      if (set && !set.has(chapter)) continue;  // chapter unchanged — skip the row loop
      addCounts(perResource[kind], await applyTsvRows(env, book, kind, byCh.get(chapter) ?? [], userId));
    }
    if (versesByChapter.ult) {
      const src = staged.find((e) => e.resource === "ult")?.src ?? null;
      addCounts(perResource.ult, await applyVerseRows(env, book, "ULT", versesByChapter.ult.get(chapter) ?? [], userId, src));
    }
    if (versesByChapter.ust) {
      const src = staged.find((e) => e.resource === "ust")?.src ?? null;
      addCounts(perResource.ust, await applyVerseRows(env, book, "UST", versesByChapter.ust.get(chapter) ?? [], userId, src));
    }
  }
  return perResource;
}

// Orchestrate a chunked, SHA-gated, diff-aware reimport of one book as a series
// of Workflow steps. Lock-free (see section header). Returns aggregate counts.
export async function runChunkedReimport(
  env: Env,
  step: WorkflowStep,
  book: string,
  instanceId: string,
  resources: Resource[],
  opts: { chunk?: number } = {},
): Promise<ReimportResult> {
  const chunkSize = opts.chunk ?? REIMPORT_CHAPTER_CHUNK;

  const plan = await step.do(
    `reimport-fetch-${book}`,
    { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
    async () => planAndStageBookResources(env, book, resources, instanceId),
  );

  const changed = plan.entries.filter((e) => e.changed);
  if (plan.maxChapter < 1 || changed.length === 0) return emptyResult(book);

  // Per-changed-TSV: which chapters actually differ (so chunks skip the rest).
  const changedTsv = await step.do(`reimport-tsvgate-${book}`, async () => {
    const out: Partial<Record<TsvKind, number[]>> = {};
    for (const e of changed) {
      if (e.resource === "ult" || e.resource === "ust" || !e.r2Key) continue;
      const raw = await readStaged(env, e.r2Key);
      if (raw == null) continue;
      out[e.resource] = [...(await changedTsvChapters(env, book, e.resource, raw))];
    }
    return out;
  });

  const perResource = freshPerResource();
  for (let start = 1; start <= plan.maxChapter; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, plan.maxChapter);
    const counts = await step.do(
      `reimport-${book}-ch${start}-${end}`,
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async () => reimportStagedChunk(env, book, start, end, changed, changedTsv, null),
    );
    mergePerResource(perResource, counts);
  }

  // After applying each changed TSV file, soft-delete pristine rows whose ids
  // master no longer carries — otherwise the next export branch resurrects
  // out-of-band deletions. See softDeleteRemovedTsvRows for the guardrails.
  // Runs before the staged-R2 cleanup step so the file is still readable.
  for (const e of changed) {
    const kind = e.resource;
    if (kind === "ult" || kind === "ust" || !e.r2Key) continue;
    let chs = changedTsv[kind];
    if (!chs || chs.length === 0) continue;
    // Never prune a held-out chapter: its rows came from another source and are
    // (correctly) absent from the org master file — the prune would soft-delete
    // every one (the twl_PSA/HAB signature, per chapter).
    if (e.held) chs = chs.filter((ch) => !isChapterHeldOut(e.held!, ch));
    if (chs.length === 0) continue;
    const r2Key = e.r2Key;
    const pruneChs = chs;
    await step.do(`reimport-prune-${book}-${kind}`, async () => {
      const raw = await readStaged(env, r2Key);
      if (raw == null) return { deleted: 0, skippedLocked: 0 };
      const res = await softDeleteRemovedTsvRows(env, book, kind, raw, pruneChs);
      if (res.deleted > 0 || res.skippedLocked > 0) {
        console.log("reimport pruned rows removed on master", { book, resource: kind, ...res });
      }
      return res;
    });
  }

  // Canonical TWL order: recompute the ULT-position ordering for the book now
  // that this run's ULT + twl changes are applied. The export step canonicalizes
  // too, but a twl file whose content didn't change is freshness-skipped at
  // export — so an upstream ULT re-alignment (twl file untouched) would otherwise
  // never re-sequence twl in D1. Idempotent (empty diff when already canonical);
  // positional metadata only. Runs only when this night touched twl or ult.
  if (changed.some((e) => e.resource === "twl" || e.resource === "ult")) {
    const r = await step.do(`reimport-twlorder-${book}`, async () => ({
      reordered: await canonicalizeTwlOrder(env, book),
    }));
    perResource.twl.twl_reordered += r.reordered;
  }

  // Record fetch-time SHAs only for resources still under a valid identity
  // AND whose counts prove this run actually applied master's content. A
  // mid-run replacement must not certify a watermark for skipped writes, and
  // (issue #427, option 2) a run that DROPPED master rows — a reissued
  // tombstone holding a master id's slot, or an insert refused by ON CONFLICT
  // — must not stamp either: the stamp is what the export freshness gate
  // trusts, and the next run's SHA gate would see an unchanged source_sha and
  // never retry, making the drop a permanent silent divergence.
  await step.do(`reimport-sync-${book}`, async () => {
    let recorded = 0;
    const withheld: Resource[] = [];
    for (const e of changed) {
      if (!e.masterSha || !e.src) continue;
      if (e.resource === "ult" || e.resource === "ust") {
        const bv = e.resource === "ult" ? "ULT" : "UST";
        const still = await verifyVerseWriteIdentity(env, bv, e.src);
        if (!still) continue;
      }
      // apply_incomplete: a write batch THREW this run (e.g. the reclaim
      // batch), so content this run staged is known-absent from D1 — stamping
      // would certify it in sync and the export would revert master with no
      // retry. A sibling withhold condition to the counter gate, mirroring
      // upstream's shape (checked here, not folded into the gate).
      const applyIncomplete = perResource[e.resource].apply_incomplete === true;
      if (!shouldRecordResourceSync(perResource[e.resource]) || applyIncomplete) {
        withheld.push(e.resource);
        const dropped =
          (perResource[e.resource].conflict_skipped ?? 0) +
          (perResource[e.resource].tombstone_blocked ?? 0);
        if (dropped > 0) {
          await raiseTombstoneBlockAlert(env, book, e.resource, perResource[e.resource]);
        }
        // A (book, resource) with NO watermark row at all under this source
        // identity would otherwise have withholding be a no-op — the export's
        // freshness gate reads "no watermark" as ok. Write the sentinel so the
        // withhold actually holds — see recordWithheldSyncIfAbsent.
        await recordWithheldSyncIfAbsent(env, book, e.resource, e.src);
        continue;
      }
      await recordResourceSync(env, book, e.resource, e.masterSha, "reimport", e.src);
      recorded++;
      // The resource just synced cleanly (it reached here, so it was NOT
      // withheld above) — clear any stale reimport_id_blocked alert from a
      // past run's tombstone_blocked/conflict_skipped count. See
      // clearTombstoneBlockAlert's doc comment for why this can't live inside
      // raiseTombstoneBlockAlert itself.
      await clearTombstoneBlockAlert(env, book, e.resource);
    }
    if (withheld.length) {
      console.warn("reimport: sync watermark withheld — this run's counts show dropped or unverified master rows", {
        book,
        withheld,
      });
    }
    return { recorded, withheld };
  });

  // Best-effort cleanup of staged R2 objects.
  await step.do(`reimport-cleanup-${book}`, async () => {
    let cleaned = 0;
    for (const e of changed) {
      if (e.r2Key) { try { await env.BLOBS.delete(e.r2Key); cleaned++; } catch { /* best-effort */ } }
    }
    return { cleaned };
  });

  const totals = zeroCounts();
  for (const r of ALL_RESOURCES) addCounts(totals, perResource[r]);
  return { book, perResource, totals };
}
