// Pulls a done pipeline_jobs row's output[] from Door43, parses each file,
// and stages the rows into pending_imports for translator review (Phase 2).
//
// Called from the GET /api/pipelines/:jobId handler when the upstream poll
// surfaces state='done' for the first time. Idempotent on re-poll: a complete-
// staging marker (pipeline_jobs.staged_at) short-circuits the parse once the
// full proposal set has landed; an incomplete prior attempt is restaged.

import type { Env } from "./index";
import {
  collectSourceWords,
  curlifyText,
  curlifyVerseObjects,
  extractPlainText,
  extractVersesForRange,
  dropDuplicateSourceMilestones,
  healReplacementChars,
  normalizeNoteWhitespace,
  parseTsv,
  recomputeTargetOccurrences,
  refParts,
  stripOrphanAlignmentMarkers,
  type SourceWord,
  type VerseExtract,
} from "./importParsers.ts";
import { canonizeAlignmentSource } from "./canonizeHebrew.ts";
import { assertLaneWritable, laneForBibleVersion } from "./scriptureLane.ts";
import { NT_BOOKS } from "./dcsSources.ts";
import type { ProjectConfig } from "./projectConfig";
import { newRowId, isValidRowId, coerceRowId, deriveAltRowId } from "./rowId.ts";
import { tnContentKey } from "./tnDedup.ts";
import { IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";
import { nextPreDraftJson } from "./preDraftSnapshot.ts";
import { fetchBotOutputWith } from "./botOutput.ts";
import { getText, outKey } from "./translate/storage.ts";
import { rawUrlOriginError } from "./rawUrlPin.ts";
import { sameDcsName } from "./repoUrl.ts";

interface OutputEntry {
  type?: string;
  repo?: string;
  branch?: string;
  path?: string;
  rawUrl?: string;
  prNumber?: number;
  mergedAt?: string;
  commitSha?: string;
  // Editor delivery (docs/plan Design 1): the bot never pushed to Door43;
  // `file` is the retrieval key for its authenticated output endpoint.
  delivery?: string;
  file?: string;
}

interface ImportContext {
  jobId: string;
  pipelineType: "generate" | "notes" | "tqs" | string;
  book: string;
  startChapter: number;
  endChapter: number;
  cfg: ProjectConfig;
  // The bot's own job id (pipeline_jobs.upstream_job_id) — required to fetch
  // editor-delivery output entries on the PROXY runner; absent/unused for
  // Door43-branch delivery and for the internal runner (which addresses its
  // output by the editor's own job id under this workspace's R2 prefix).
  upstreamJobId?: string;
  // pipeline_jobs.runner (migration 0073): 'internal' reads editor-delivery
  // bytes from R2; NULL / 'proxy' keeps the bot's output endpoint.
  runner?: string | null;
}

export interface ImportResult {
  inserted: number;
  byKind: { tn: number; tq: number; verse: number; article: number };
  skipped: string[];           // human-readable reasons (one per output entry skipped)
  applied?: ApplyResult;
  // True when a concurrent poll already owns this import (the CAS claim was
  // lost). The caller MUST NOT finalize the job on this result — the owning
  // poll writes output_json when it completes. See pollPipelineJob.
  claimLost?: boolean;
}

// Classify a single output[] entry into the resource kind we know how to
// parse. Returns null for entries we don't recognize — those get surfaced
// in result.skipped and the job is otherwise marked imported.
type Classification =
  | { kind: "verse"; bibleVersion: "ULT" | "UST"; format: "usfm" }
  | { kind: "tn"; format: "tsv" }
  | { kind: "tq"; format: "tsv" }
  | { kind: "article"; resource: "tw" | "ta"; format: "md" }
  | { kind: "unknown" };

function classify(entry: OutputEntry, cfg: ProjectConfig): Classification {
  const repo = (entry.repo ?? "").toLowerCase();
  // Trailing match — repo strings look like "unfoldingWord/en_ult" or sometimes
  // just "en_ult"; either way the last path segment is what we want.
  const tail = repo.split("/").pop() ?? "";
  // Project-configured repo names first (e.g. ar_tn under a GL config), then
  // the en_* names as a legacy fallback so pre-config jobs keep classifying.
  if (tail.endsWith(cfg.repos.lit.toLowerCase())) return { kind: "verse", bibleVersion: "ULT", format: "usfm" };
  if (tail.endsWith(cfg.repos.sim.toLowerCase())) return { kind: "verse", bibleVersion: "UST", format: "usfm" };
  if (tail.endsWith(cfg.repos.tn.toLowerCase())) return { kind: "tn", format: "tsv" };
  if (tail.endsWith(cfg.repos.tq.toLowerCase())) return { kind: "tq", format: "tsv" };
  if (tail.endsWith(cfg.repos.tw.toLowerCase())) return { kind: "article", resource: "tw", format: "md" };
  if (tail.endsWith(cfg.repos.ta.toLowerCase())) return { kind: "article", resource: "ta", format: "md" };
  if (tail.endsWith("en_ult")) return { kind: "verse", bibleVersion: "ULT", format: "usfm" };
  if (tail.endsWith("en_ust")) return { kind: "verse", bibleVersion: "UST", format: "usfm" };
  if (tail.endsWith("en_tn")) return { kind: "tn", format: "tsv" };
  if (tail.endsWith("en_tq")) return { kind: "tq", format: "tsv" };
  if (tail.endsWith("en_tw")) return { kind: "article", resource: "tw", format: "md" };
  if (tail.endsWith("en_ta")) return { kind: "article", resource: "ta", format: "md" };
  return { kind: "unknown" };
}

async function fetchText(rawUrl: string): Promise<string> {
  const r = await fetch(rawUrl);
  if (!r.ok) {
    throw new Error(`fetch ${rawUrl} -> ${r.status}`);
  }
  return await r.text();
}

// Editor-delivery fetch: pull the result file from the bot's authenticated
// output endpoint (429-aware retry lives in botOutput.ts). The Door43 rawUrl
// path above stays fully intact for English pipelines / 'branch' delivery.
const DEFAULT_BOT_BASE = "https://uw-bt-bot.fly.dev";

async function fetchBotOutput(env: Env, upstreamJobId: string, file: string): Promise<string> {
  if (!env.BT_API_TOKEN) throw new Error("fetch bot output: BT_API_TOKEN not configured");
  const base = env.PIPELINE_API_BASE || DEFAULT_BOT_BASE;
  return fetchBotOutputWith(fetch, base, env.BT_API_TOKEN, upstreamJobId, file);
}

// Internal-runner counterpart of fetchBotOutput: the same editor-delivery
// manifest, but the bytes were written to R2 by TranslateWorkflow's merge-report
// step instead of being staged on the bot (design §C). Addressed by the EDITOR's
// job id — the internal runner has no separate upstream id — under this
// workspace's slug prefix, which is what keeps one org's import from ever
// reaching another org's output.
//
// `entry.file` comes from the manifest, which is JSON the Workflow wrote; outKey
// runs it through storage.ts's traversal guard anyway, on the rule that a path
// used to address storage is validated at the point of use, not at the point of
// trust.
async function fetchInternalOutput(env: Env, jobId: string, file: string): Promise<string> {
  const key = outKey(env.WORKSPACE_SLUG ?? "default", jobId, file);
  const text = await getText(env.BLOBS, key);
  if (text == null) throw new Error(`fetch internal output: ${key} not found`);
  return text;
}

interface StagedRow {
  kind: "tn" | "tq" | "verse" | "article";
  chapter: number;
  verse: number;
  bibleVersion: string | null;
  payload: Record<string, unknown>;
}

// tnPayload / tqPayload are exported for the direct regression tests in
// pipelineImport.test.mjs, which assert on the quote-curling below (JER 32/33,
// NUM 26:53 prod forensics — straight quotes in AI-generated note prose).
// Not intended as a public API beyond that — same rationale as deleteUnkeptTns.
export function tnPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      support_reference: row["SupportReference"] || null,
      quote: row["Quote"] || null,
      occurrence,
      // Collapse bp-assistant's double-space-after-punctuation artifact so the
      // stored note matches DCS master's normalized form (see
      // normalizeNoteWhitespace) — both apply paths (applyTnInsert and the hint
      // expansion) and the edit_log audit read this same staged note. Curl
      // straight quotes with the SAME contextual rule verse text ingest uses
      // (curlifyText, not tsvFormat.ts's educateQuotes — see the module
      // comment above curlifyVerseObjects in importParsers.ts for why the two
      // ingest paths must share one rule) so an AI-authored note never lands
      // with straight ' / " and never disagrees with an AI-authored verse
      // curled in the same run.
      note: row["Note"] ? curlifyText(normalizeNoteWhitespace(row["Note"])) : null,
    },
  };
}

export function tqPayload(book: string, refRaw: string, row: Record<string, string>) {
  const [ch, v] = refParts(refRaw);
  const occRaw = row["Occurrence"];
  const occurrence = occRaw === "" || occRaw == null ? null : parseInt(occRaw, 10) || 0;
  return {
    chapter: ch,
    verse: v,
    payload: {
      id: row["ID"] || null,
      book,
      chapter: ch,
      verse: v,
      ref_raw: refRaw,
      tags: row["Tags"] || null,
      quote: row["Quote"] || null,
      occurrence,
      // Curl straight quotes in AI-generated question/response prose — same
      // rationale (and same shared function) as tnPayload's note above.
      question: row["Question"] ? curlifyText(row["Question"]) : null,
      response: row["Response"] ? curlifyText(row["Response"]) : null,
    },
  };
}

function versePayload(book: string, bibleVersion: "ULT" | "UST", v: VerseExtract) {
  return {
    book,
    chapter: v.chapter,
    verse: v.verse,
    verse_end: v.verseEnd,
    bible_version: bibleVersion,
    content_json: v.contentJson,
    plain_text: v.plainText,
  };
}

async function parseOutputEntry(
  env: Env,
  ctx: ImportContext,
  entry: OutputEntry,
): Promise<{ staged: StagedRow[]; skipReason?: string }> {
  // Report sidecars (translate-report-*.json) aren't row content — skip them.
  // Populating draft_meta_json from the report is a deferred follow-up.
  if (entry.type === "report") {
    return { staged: [], skipReason: "report sidecar (not imported)" };
  }
  const isEditorDelivery = entry.delivery === "editor";
  if (!isEditorDelivery && !entry.rawUrl) return { staged: [], skipReason: "missing rawUrl" };
  if (isEditorDelivery && !entry.file) {
    return { staged: [], skipReason: "editor delivery entry missing file" };
  }
  if (!isEditorDelivery) {
    const originError = rawUrlOriginError(entry.rawUrl!, env.DCS_BASE_URL);
    if (originError) return { staged: [], skipReason: originError };
  }
  const cls = classify(entry, ctx.cfg);
  if (cls.kind === "unknown") {
    return { staged: [], skipReason: `unrecognized repo: ${entry.repo ?? "(none)"}` };
  }

  let raw: string;
  if (isEditorDelivery) {
    if (ctx.runner === "internal") {
      raw = await fetchInternalOutput(env, ctx.jobId, entry.file!);
    } else {
      // Proxy only: the bot's output endpoint is keyed by ITS job id, so a
      // missing upstream id means we cannot fetch. The internal runner has no
      // upstream id at all, which is why this requirement moved inside the
      // proxy branch rather than gating both.
      if (!ctx.upstreamJobId) {
        throw new Error(`editor delivery entry for job ${ctx.jobId} but no upstream_job_id`);
      }
      raw = await fetchBotOutput(env, ctx.upstreamJobId, entry.file!);
    }
  } else {
    raw = await fetchText(entry.rawUrl!);
  }
  const staged: StagedRow[] = [];

  if (cls.format === "md") {
    // One article file per output entry. `path` is the repo-relative markdown
    // path — the round-trip id keyed against article_units (bp-assistant
    // articles envelope: the in-repo path is the stable identity). No chapter/
    // verse scope for articles (sentinel 0/0).
    const path = entry.path ?? "";
    if (!path) return { staged: [], skipReason: "article output missing path" };
    staged.push({
      kind: "article",
      chapter: 0,
      verse: 0,
      bibleVersion: null,
      payload: { resource: cls.resource, path, target_md: raw },
    });
    return { staged };
  }

  if (cls.format === "tsv") {
    const { rows } = parseTsv(raw);
    for (const row of rows) {
      const refRaw = row["Reference"];
      if (!refRaw) continue;
      const [ch] = refParts(refRaw);
      if (ch < ctx.startChapter || ch > ctx.endChapter) continue;
      const built = cls.kind === "tn"
        ? tnPayload(ctx.book, refRaw, row)
        : tqPayload(ctx.book, refRaw, row);
      staged.push({
        kind: cls.kind,
        chapter: built.chapter,
        verse: built.verse,
        bibleVersion: null,
        payload: built.payload,
      });
    }
    return { staged };
  }

  // USFM
  const verses = extractVersesForRange(raw, ctx.startChapter, ctx.endChapter);
  for (const v of verses) {
    staged.push({
      kind: "verse",
      chapter: v.chapter,
      verse: v.verse,
      bibleVersion: cls.bibleVersion,
      payload: versePayload(ctx.book, cls.bibleVersion, v),
    });
  }
  return { staged };
}

// Top-level entry. Three phases:
//   0. CLAIM — atomically take the single-applier slot for this job so two
//      concurrent pollers (the */5 cron and a translator's open tab polling
//      GET /api/pipelines/:jobId) can't both run the destructive apply. The
//      loser no-ops. See migration 0035 — before this guard, interleaved
//      concurrent applies wiped/doubled ISA 48 en_tn (2026-06-30).
//   1. STAGE — fetch each rawUrl, parse, INSERT into pending_imports.
//      Idempotent on the pipeline_jobs.staged_at marker, written only after
//      the last chunk commits; a partial prior stage is dropped and redone.
//   2. APPLY — for every unresolved pending_imports row, mutate the live
//      tn_rows / tq_rows / verses tables and mark accepted_at.
//      Idempotent at the per-row level (accepted_at IS NULL filter) plus
//      the TN-delete phase, which only targets unkept rows.
//
// Throws on hard errors (Door43 fetch failure, malformed input, batch error).
// Callers should NOT mark output_json in pipeline_jobs unless this resolves
// successfully — that's how the next poll re-runs apply after a partial
// failure.
export async function importJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
): Promise<ImportResult> {
  // Atomic single-applier claim. The predicate mirrors mayClaimImport, but is
  // enforced in one CAS UPDATE so a concurrent racer that read the same
  // pre-apply state can't also win: exactly one UPDATE reports changes=1.
  const claim = await env.DB.prepare(
    `UPDATE pipeline_jobs SET import_claimed_at = unixepoch()
      WHERE job_id = ?1
        AND (import_claimed_at IS NULL OR import_claimed_at < unixepoch() - ?2)`,
  )
    .bind(job.jobId, IMPORT_CLAIM_STALE_SECONDS)
    .run();
  if ((claim.meta.changes ?? 0) === 0) {
    // Another poll already owns the import — do nothing rather than run a
    // second, interleaving delete/insert pass. Flag claimLost so the caller
    // does NOT finalize the job: the owning poll may still be mid-apply, and
    // writing output_json here would mark the import complete prematurely
    // (and, if the owner then fails, suppress the retry).
    return {
      inserted: 0,
      byKind: { tn: 0, tq: 0, verse: 0, article: 0 },
      skipped: ["import already claimed by a concurrent poll"],
      claimLost: true,
    };
  }
  try {
    const stageResult = await stageJobOutput(env, job, outputs);
    const applyResult = await applyJobOutput(env, job);
    return { ...stageResult, applied: applyResult };
  } catch (err) {
    // Release the slot so the caller's one-retry path (pollPipelineJob holds
    // state at 'running' on the first failure) can re-import. Staging keys its
    // own idempotency on staged_at and apply is per-row idempotent, so the
    // retry resumes rather than duplicating.
    await env.DB.prepare(
      `UPDATE pipeline_jobs SET import_claimed_at = NULL WHERE job_id = ?1`,
    )
      .bind(job.jobId)
      .run();
    throw err;
  }
}

async function stageJobOutput(
  env: Env,
  job: ImportContext,
  outputs: OutputEntry[],
): Promise<ImportResult> {
  // Idempotency guard: staged_at is written ONLY after the final chunk below
  // commits, so it — not the mere existence of a pending_imports row — is the
  // authoritative "full proposal set is present" signal. Staging spans many
  // D1 batch() calls (each atomic, the whole loop is not), so a mid-chunk
  // crash leaves a PARTIAL set; keying idempotency on row-existence would let
  // the retry apply that partial set and mark the job imported. See migration
  // 0030. With the marker set, apply picks up any still-unresolved rows.
  const marker = await env.DB.prepare(
    `SELECT staged_at FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{ staged_at: number | null }>();
  if (marker?.staged_at != null) {
    return { inserted: 0, byKind: { tn: 0, tq: 0, verse: 0, article: 0 }, skipped: ["already staged"] };
  }

  // No complete-staging marker: either this is the first run, or a prior
  // attempt died mid-chunk. Drop any partial, still-unresolved rows from that
  // dead attempt and restage from scratch so apply never runs against a
  // partial set. (Apply runs AFTER staging in importJobOutput, so for this job
  // nothing is accepted yet; the accepted/rejected filter is belt-and-
  // suspenders against a translator resolving a partial row in the retry gap.)
  await env.DB.prepare(
    `DELETE FROM pending_imports
      WHERE job_id = ?1 AND accepted_at IS NULL AND rejected_at IS NULL`,
  )
    .bind(job.jobId)
    .run();

  const skipped: string[] = [];
  const allStaged: StagedRow[] = [];
  for (const entry of outputs) {
    const { staged, skipReason } = await parseOutputEntry(env, job, entry);
    if (skipReason) skipped.push(skipReason);
    allStaged.push(...staged);
  }

  // Batch insert in chunks. D1 batch() caps at 100 statements per call.
  const stmt = env.DB.prepare(
    `INSERT INTO pending_imports
       (job_id, kind, book, chapter, verse, bible_version, payload_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  );

  const CHUNK = 100;
  let inserted = 0;
  const byKind = { tn: 0, tq: 0, verse: 0, article: 0 };
  for (let i = 0; i < allStaged.length; i += CHUNK) {
    const chunk = allStaged.slice(i, i + CHUNK);
    await env.DB.batch(
      chunk.map((s) =>
        stmt.bind(
          job.jobId,
          s.kind,
          job.book,
          s.chapter,
          s.verse,
          s.bibleVersion,
          JSON.stringify(s.payload),
        ),
      ),
    );
    inserted += chunk.length;
    for (const s of chunk) byKind[s.kind] += 1;
  }

  // Mark staging complete only after the last chunk committed (also covers the
  // zero-row case — staging is then vacuously complete). Any throw above leaves
  // staged_at NULL; importJobOutput's caller leaves output_json NULL on throw,
  // so the next poll re-enters here and restages cleanly.
  await env.DB.prepare(
    `UPDATE pipeline_jobs SET staged_at = unixepoch() WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .run();

  return { inserted, byKind, skipped };
}

// ── Apply phase ───────────────────────────────────────────────────────────

export interface ApplyResult {
  tnDeleted: number;
  tnCreated: number;
  tnHintExpanded: number;
  // Insert proposals dropped because an identical-content note already exists
  // live in scope (defense-in-depth content-dedup — see the loop below).
  tnSkippedDup: number;
  tqCreated: number;
  tqUpdated: number;
  // A tq_rows UPDATE lost its version CAS to a concurrent write (e.g. a
  // translator's edit landing between our read and write) — the proposal is
  // left unaccepted for a later pass / manual review, not silently clobbered.
  // See applyTqUpsert.
  tqSkippedConflict: number;
  // tw/ta article files updated in place by the translate apply (by path).
  articleUpdated: number;
  verseUpdated: number;
  // Distinct chapters that actually received a write, so the caller can fan out
  // one "chapter is stale" hint per changed chapter (not one per row).
  affectedChapters: number[];
}

interface PendingImportRow {
  id: number;
  kind: "tn" | "tq" | "verse" | "article";
  book: string;
  chapter: number;
  verse: number;
  bible_version: string | null;
  payload_json: string;
}

const AI_SOURCE = "ai_pipeline";

// Row-id grammar + validation now live in rowId.ts (ROW_ID_RE / isValidRowId),
// shared with the reimport's coerceRowId guard. bp-assistant normally emits a
// valid id for every TN row (hinted or not), and it's what gets pushed to
// master; preserving it keeps D1 and master ids in lockstep. Only a malformed id
// (the occasional incomplete emit) is replaced with a freshly minted one below.

async function applyJobOutput(env: Env, job: ImportContext): Promise<ApplyResult> {
  // Look up the pipeline-starter's user id — every audit and updated_by
  // write is attributed to them, matching the contract that says the run
  // was triggered on their behalf.
  const starter = await env.DB.prepare(
    `SELECT user_id, source_generation, source_owner, source_repo, source_ref,
            source_stamps_json, pipeline_type
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{
      user_id: number;
      source_generation: number | null;
      source_owner: string | null;
      source_repo: string | null;
      source_ref: string | null;
      source_stamps_json: string | null;
      pipeline_type: string;
    }>();
  if (!starter) throw new Error(`apply: pipeline_jobs row not found for ${job.jobId}`);
  const userId = starter.user_id;
  const jobStamp = {
    source_generation: starter.source_generation,
    source_owner: starter.source_owner,
    source_repo: starter.source_repo,
    source_ref: starter.source_ref,
    source_stamps_json: starter.source_stamps_json,
    pipeline_type: starter.pipeline_type,
  };

  // All unresolved proposals for this job, in stable order so retries do
  // the same work in the same sequence.
  const rs = await env.DB.prepare(
    `SELECT id, kind, book, chapter, verse, bible_version, payload_json
       FROM pending_imports
      WHERE job_id = ?1
        AND accepted_at IS NULL AND rejected_at IS NULL
      ORDER BY kind, chapter, verse, id`,
  )
    .bind(job.jobId)
    .all<PendingImportRow>();
  const rows = rs.results ?? [];

  const tnProposals = rows.filter((r) => r.kind === "tn");
  const tqProposals = rows.filter((r) => r.kind === "tq");
  const articleProposals = rows.filter((r) => r.kind === "article");
  const verseProposals = rows.filter((r) => r.kind === "verse");

  const result: ApplyResult = {
    tnDeleted: 0,
    tnCreated: 0,
    tnHintExpanded: 0,
    tnSkippedDup: 0,
    tqCreated: 0,
    tqUpdated: 0,
    tqSkippedConflict: 0,
    articleUpdated: 0,
    verseUpdated: 0,
    affectedChapters: [],
  };

  // Chapters that saw an actual write — populated at each mutation point below
  // and returned so the caller can hint open tabs once per changed chapter.
  const affected = new Set<number>();

  // Translate pipeline (multilingual): a wholly separate apply path. It UPDATEs
  // existing target rows by rowId, never deletes, never inserts — so it skips
  // the entire English delete-sweep/insert machinery below. A given translate
  // job produces exactly one resource kind (tn OR tq OR tw/ta articles), so
  // only the matching loop does work. Article apply is keyed by (resource,
  // path) against article_units. Returns early so a translate job can never
  // trip deleteUnkeptTns.
  if (job.pipelineType === "translate") {
    for (const p of tnProposals) {
      const outcome = await applyTranslateTnRow(env, p, job, userId);
      if (outcome === "drafted") {
        affected.add(p.chapter);
        result.tnHintExpanded += 1; // reuses the "updated in place" counter
      }
      // no_match: the id isn't a live target row (or a concurrent human edit
      // won the CAS) — the proposal is left unresolved rather than inserted,
      // preserving the row-identity guarantee. Surfaced via pending_imports.
    }
    for (const p of tqProposals) {
      const outcome = await applyTranslateTqRow(env, p, job, userId);
      if (outcome === "drafted") {
        affected.add(p.chapter);
        result.tqUpdated += 1; // reuses the "updated in place" counter
      }
    }
    for (const p of articleProposals) {
      const outcome = await applyTranslateArticle(env, p, userId);
      if (outcome === "drafted") result.articleUpdated += 1;
    }
    // Articles have no chapter to hint an open tab with (sentinel 0/0), so an
    // all-no-match article run would otherwise complete silently — the job goes
    // 'done', nothing lands, and there is no scripture tab to signal. Surface a
    // banner alert so "0 applied" is visible rather than silent. Only when there
    // WERE article proposals but none drafted (every target path missed its
    // article_units row, or a concurrent human edit won the CAS).
    if (articleProposals.length > 0 && result.articleUpdated === 0) {
      await recordArticleNoApplyAlert(env, job, userId, articleProposals.length);
    }
    result.affectedChapters = [...affected].sort((a, b) => a - b);
    return result;
  }

  // TN delete phase: only fires when this job produced TN proposals AND
  // there are unkept TNs in scope. Idempotent — re-running finds none left.
  if (tnProposals.length > 0) {
    result.tnDeleted = await deleteUnkeptTns(env, job, userId);
    // A delete mutates whatever chapters this job re-proposed TN for; those are
    // exactly the chapters carried by tnProposals.
    if (result.tnDeleted > 0) for (const p of tnProposals) affected.add(p.chapter);
  }

  // Content-dedup claim set (defense-in-depth, layered ON TOP of the AI-aware
  // sweep above). Seeded from the rows that SURVIVED the delete phase — kept
  // notes (preserve/hint/human-edited) plus, if the sweep ever fails to clear a
  // prior AI run, its leftovers — so a proposal whose exact content already
  // exists live is dropped instead of inserted as a duplicate. tnContentKey is
  // the same id-independent identity key the reimport's Guard 2 uses (includes
  // occurrence; excludes id/sort_order/tags). Grown as we insert so two
  // identical proposals in one file also collapse. This is the last line of
  // defense against the re-run doubling (ISA 36/41): even if the sweep misses a
  // row, its content key blocks the second copy.
  const claimedTnKeys = new Set<string>();
  if (tnProposals.length > 0) {
    const live = await env.DB.prepare(
      `SELECT chapter, verse, occurrence, support_reference, quote, note
         FROM tn_rows
        WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND deleted_at IS NULL`,
    )
      .bind(job.book, job.startChapter, job.endChapter)
      .all<{
        chapter: number;
        verse: number;
        occurrence: number | null;
        support_reference: string | null;
        quote: string | null;
        note: string | null;
      }>();
    // Normalize the LIVE row's note the same way tnPayload normalizes an
    // incoming proposal's note (curlifyText) before keying it. Without this,
    // a pre-fix straight-quote note that deleteUnkeptTns deliberately skips
    // (preserve=1 / hint=1) keeps a RAW key built from its stored straight
    // quotes, while a re-run's identical-content proposal is keyed from its
    // NOW-curled `payload.note` — the two keys never match, so content-dedup
    // silently fails to recognize the duplicate and a second copy gets
    // inserted. `quote` is deliberately left untouched here, matching
    // tnPayload — it must stay byte-exact for occurrence matching.
    for (const r of live.results ?? []) {
      claimedTnKeys.add(tnContentKey({ ...r, note: r.note ? curlifyText(r.note) : r.note }));
    }
  }

  // sort_order assignment. Proposals arrive ordered (chapter, verse, id) where
  // id is the staging order = the AI file's row order, so a per-verse counter
  // reproduces the source file order on export. For TN we seed each verse's
  // counter from the MAX sort_order of the rows that SURVIVED the delete phase
  // (preserve=1 / hint=1 / translator-edited), so freshly minted AI notes
  // append after the translator's kept notes rather than colliding with them.
  // For TQ there's no delete/preserve concept — every run fully reorders the
  // verse to match the file — so its counters start from zero.
  const tnBases = await maxSortOrderPerVerse(env, "tn_rows", job);
  const tnCounters = new Map<number, number>();
  const tqCounters = new Map<number, number>();
  const verseKey = (p: PendingImportRow) => p.chapter * 100000 + p.verse;

  for (const p of tnProposals) {
    // Hint expansion: if the AI's proposed id matches a queued hint stub in
    // this job's scope, UPDATE that row in place instead of minting a new
    // one. The hint's rowId round-trips through bp-assistant as the TSV ID
    // column — see docs/bp-assistant-tn-hints-contract.md. The stub keeps the
    // sort_order it was created with (it's a surviving row, already folded
    // into tnBases), so we don't consume a counter slot for it.
    // Content key of this proposal — computed up front so a hint expansion can
    // claim it too (the expanded stub now carries this content live, so a later
    // identical insert proposal in the same run must be suppressed).
    const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
    const contentKey = tnContentKey({
      chapter: p.chapter,
      verse: p.verse,
      occurrence: (payload.occurrence as number | null | undefined) ?? null,
      support_reference: (payload.support_reference as string | null | undefined) ?? null,
      quote: (payload.quote as string | null | undefined) ?? null,
      note: (payload.note as string | null | undefined) ?? null,
    });

    const expanded = await applyTnHintExpansionIfMatch(env, p, job, userId);
    if (expanded) {
      claimedTnKeys.add(contentKey);
      affected.add(p.chapter);
      result.tnHintExpanded += 1;
      continue;
    }
    // Drop a proposal whose exact content already exists live in scope (a kept
    // note, an expanded hint, or a prior-AI row the sweep somehow missed). Keyed
    // on content, not id, so the fresh id bp-assistant mints each run can't
    // sneak a duplicate past. A genuinely new/changed note has a different key
    // and still inserts.
    if (claimedTnKeys.has(contentKey)) {
      // Resolve the proposal so it doesn't linger as an unreviewed item in the
      // pending-imports review endpoint — the note it proposes already exists,
      // so accepting (without inserting) is the truthful resolution.
      await env.DB.prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
        .bind(p.id, userId)
        .run();
      result.tnSkippedDup += 1;
      continue;
    }
    claimedTnKeys.add(contentKey);
    const k = verseKey(p);
    const sortOrder = (tnCounters.get(k) ?? tnBases.get(k) ?? 0) + 100;
    tnCounters.set(k, sortOrder);
    await applyTnInsert(env, p, userId, sortOrder);
    affected.add(p.chapter);
    result.tnCreated += 1;
  }

  // Ids this pass has already written. Two distinct proposed ids can hash to
  // the same alternate (~1 in 786k per pair); without this, the second
  // proposal would find the first's brand-new row at the same chapter+verse,
  // read it as "mine from a previous run", and UPDATE over it — losing a
  // question silently. Proposal order is stable (ORDER BY kind, chapter, verse,
  // id), so which proposal wins the shared id is deterministic across re-runs
  // and each keeps landing on the same row. TN has the same idea in
  // claimedTnKeys, keyed on content rather than id.
  const claimedTqIds = new Set<string>();
  for (const p of tqProposals) {
    const k = verseKey(p);
    const sortOrder = (tqCounters.get(k) ?? 0) + 100;
    tqCounters.set(k, sortOrder);
    const action = await applyTqUpsert(env, p, userId, sortOrder, claimedTqIds);
    if (action === "conflict") {
      result.tqSkippedConflict += 1;
    } else {
      affected.add(p.chapter);
      if (action === "created") result.tqCreated += 1;
      else result.tqUpdated += 1;
    }
  }

  // Preload the book's UHB/UGNT source words once (a single query — cap-safe)
  // so each verse's alignment canonize + U+FFFD heal read from memory instead
  // of issuing a per-verse D1 read (a whole-book generate would otherwise blow
  // the ~1000-subrequest budget). Empty map when there are no verse proposals.
  const uhbWordsByVerse =
    verseProposals.length > 0
      ? await loadUhbSourceWords(env, job)
      : new Map<number, SourceWord[]>();

  for (const p of verseProposals) {
    await applyVerseUpdate(env, p, userId, uhbWordsByVerse, jobStamp);
    affected.add(p.chapter);
    result.verseUpdated += 1;
  }

  result.affectedChapters = [...affected].sort((a, b) => a - b);
  return result;
}

// Highest sort_order currently stored per (chapter, verse) in scope. Used to
// seed AI insert counters so new rows append after surviving rows in a verse.
// Run AFTER the TN delete phase so swept rows don't inflate the base.
async function maxSortOrderPerVerse(
  env: Env,
  table: "tn_rows" | "tq_rows",
  job: ImportContext,
): Promise<Map<number, number>> {
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, MAX(sort_order) AS mx FROM ${table}
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND deleted_at IS NULL
      GROUP BY chapter, verse`,
  )
    .bind(job.book, job.startChapter, job.endChapter)
    .all<{ chapter: number; verse: number; mx: number | null }>();
  const m = new Map<number, number>();
  for (const r of rs.results ?? []) {
    if (r.mx != null) m.set(r.chapter * 100000 + r.verse, r.mx);
  }
  return m;
}

async function deleteUnkeptTns(
  env: Env,
  job: ImportContext,
  userId: number,
): Promise<number> {
  // Identify which rows we're about to delete so the audit row can carry
  // the right pre-deletion version. A bulk UPDATE would lose that fidelity.
  // preserve=1 rows are translator-marked "keep through AI runs"; hint=1
  // rows are stubs queued for in-place expansion by the AI — both must
  // survive the sweep.
  //
  // Two classes are swept: (a) pristine rows the AI never touched
  // (updated_by IS NULL — the original bootstrap/reimport notes), and (b) the
  // PRIOR AI run's own output. applyTnInsert stamps updated_by = the pipeline
  // starter on every note it creates, so a re-run's notes are NOT pristine and
  // a plain `updated_by IS NULL` sweep would skip them — leaving them in place
  // while the re-run inserts a full fresh set, DOUBLING every note (ISA 36/41,
  // 2026-06). Class (b) is identified by the most-recent CONTENT-bearing
  // edit_log entry (action IN create/update) still being source 'ai_pipeline'.
  // The action filter matters: /preserve/hint/trash toggles write NULL-source
  // audit rows (rows.ts), so an AI note that was preserved-then-unpreserved
  // would otherwise look human-owned (its LATEST audit row is 'unpreserve',
  // source NULL) and dodge the sweep forever. A real human content edit writes
  // action 'update' source NULL, and a hint expansion writes 'hint_expansion'
  // — both correctly take the latest content action off 'ai_pipeline', so an
  // edited / hint-owned note is protected. The reimport never rewrites an AI
  // row (its UPDATE/prune are updated_by-IS-NULL gated), so the content source
  // stays 'ai_pipeline' reliably.
  //
  // trashed_at IS NULL: a trashed AI note is left alone — the content-dedup
  // claim set below (seeded from deleted_at IS NULL rows, which includes
  // trashed) suppresses the AI's re-proposal of it, so it stays trashed.
  // Sweeping it instead would delete it and let the re-insert RESURRECT it
  // un-trashed against the user's intent.
  // Scope the sweep to the (chapter, verse) pairs this job actually produced
  // proposals for (`pending_imports` for the job). The chapter-wide sweep
  // assumed the result covers every verse it requested; when it doesn't — a
  // partial result, or a concurrent apply that already consumed some proposals
  // — deleting across the whole chapter wipes notes for verses the new run
  // never re-supplies. Bounding the delete to supplied verses means a verse
  // missing from the result keeps its existing notes (mildly stale) instead of
  // being emptied. Match on BOTH chapter and verse: a job may span multiple
  // chapters (endChapter > startChapter is a valid range), and scoping by verse
  // number alone would let a proposal for ch2:v1 make ch1:v1 eligible for
  // deletion. Defense-in-depth alongside the single-applier claim in
  // importJobOutput.
  const targets = await env.DB.prepare(
    `SELECT id, version FROM tn_rows t
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
        AND deleted_at IS NULL AND trashed_at IS NULL
        AND preserve = 0 AND hint = 0
        AND EXISTS (
          SELECT 1 FROM pending_imports pi
            WHERE pi.job_id = ?5 AND pi.kind = 'tn'
              AND pi.chapter = t.chapter AND pi.verse = t.verse
        )
        AND (
          updated_by IS NULL
          OR (
            SELECT source FROM edit_log
              WHERE kind = 'tn' AND row_key = t.id
                AND (book = t.book OR book IS NULL)
                AND action IN ('create', 'update')
              ORDER BY id DESC LIMIT 1
          ) = ?4
        )`,
  )
    .bind(job.book, job.startChapter, job.endChapter, AI_SOURCE, job.jobId)
    .all<{ id: string; version: number }>();
  const list = targets.results ?? [];
  if (list.length === 0) return 0;

  const now = Math.floor(Date.now() / 1000);
  const CHUNK = 25; // 2 statements per row + headroom
  let deleted = 0;
  for (let i = 0; i < list.length; i += CHUNK) {
    const slice = list.slice(i, i + CHUNK);
    const stmts = [];
    for (const t of slice) {
      stmts.push(
        env.DB
          .prepare(
            // Re-assert the safety predicate at write time, not just in the
            // SELECT above: TN edits are allowed mid-pipeline (rows.ts), so a
            // change landing between the SELECT and this UPDATE must ABORT the
            // delete. A translator content edit bumps version — caught by the
            // version-CAS (`version = ?5`); a preserve/hint toggle is caught by
            // re-asserting `preserve = 0 AND hint = 0`; a trash toggle does NOT
            // bump version (rows.ts setTnTrashed), so it needs its own
            // `trashed_at IS NULL` re-assertion. (We can't re-use the old
            // `updated_by IS NULL` guard: a swept PRIOR-AI row already carries
            // the starter's updated_by, so that clause would abort every
            // legitimate AI-output delete.) Composite-key scoped so a
            // colliding-id row in another book is never touched.
            `UPDATE tn_rows
               SET deleted_at = ?1, version = version + 1,
                   updated_at = ?1, updated_by = ?2
             WHERE id = ?3 AND book = ?4 AND deleted_at IS NULL
               AND trashed_at IS NULL AND preserve = 0 AND hint = 0 AND version = ?5`,
          )
          .bind(now, userId, t.id, job.book, t.version),
        env.DB
          .prepare(
            // Audit only if the UPDATE above actually tombstoned this row in
            // THIS batch (D1 runs batch statements sequentially on one
            // connection, so this SELECT sees the prior UPDATE's effect). A
            // delete the pristine guard aborted writes no edit_log row.
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, source)
             SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'delete', ?6
              WHERE EXISTS (
                SELECT 1 FROM tn_rows
                 WHERE id = ?1 AND book = ?2
                   AND deleted_at = ?7 AND updated_by = ?3
              )`,
          )
          .bind(t.id, job.book, userId, t.version, t.version + 1, AI_SOURCE, now),
      );
    }
    const res = await env.DB.batch(stmts);
    // UPDATE results sit at even indices (update, audit, update, audit, ...).
    // Count only rows the guard actually deleted.
    for (let j = 0; j < res.length; j += 2) {
      deleted += res[j]?.meta?.changes ?? 0;
    }
  }
  return deleted;
}

// Per-revision source label for hint expansions. Distinct from AI_SOURCE so
// the row's AI chip (keyed on latest_source === 'ai_pipeline' in chapters.ts)
// stays off — standing authorship of a hinted note's existence is the human
// who created the stub, even though this specific revision was written by
// the AI. The history dialog can render this label however it likes.
const HINT_EXPANSION_SOURCE = "hint_expansion";

// Returns true if the proposal was applied as a hint expansion (UPDATE in
// place against an existing hint=1 stub), false if there's no match and the
// caller should fall through to applyTnInsert. Scoped to the job's chapter
// range so an id collision outside that range (vanishingly rare with 4-char
// random ids, but possible) doesn't accidentally clobber an unrelated row.
// Translate-pipeline apply (multilingual; PIPELINE-SPEC §2.1). The translate
// output is exactly one target row per input row, keyed by the same rowId, with
// only the Note translated — Reference/ID/SupportReference/Quote/Occurrence are
// copied through byte-identical, so we UPDATE the note (and tags, if localized)
// of the EXISTING target row and leave the structural columns alone. This is
// the opposite of English note generation (which deletes+inserts the full note
// set): a translate run NEVER deletes rows and NEVER mints new ids — it can
// only fill in a translation for a row that already exists (imported from the
// source project). A proposal whose id has no matching row is skipped (surfaced
// in result, not inserted — inventing a row would break the row-identity
// guarantee the whole contract rests on). Stamps translation_state='ai_draft'
// and writes edit_log source='ai_pipeline' so the review UI shows the AI chip.
async function applyTranslateTnRow(
  env: Env,
  p: PendingImportRow,
  job: ImportContext,
  userId: number,
): Promise<"drafted" | "no_match"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return "no_match";

  const target = await env.DB.prepare(
    `SELECT id, version, note, tags, translation_state, pre_draft_json FROM tn_rows
      WHERE id = ?1 AND deleted_at IS NULL
        AND book = ?2 AND chapter BETWEEN ?3 AND ?4`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{
      id: string;
      version: number;
      note: string | null;
      tags: string | null;
      translation_state: string | null;
      pre_draft_json: string | null;
    }>();
  if (!target) return "no_match";

  const now = Math.floor(Date.now() / 1000);
  const newVersion = target.version + 1;
  const note = (payload.note as string | null | undefined) ?? null;
  const tags = (payload.tags as string | null | undefined) ?? null;
  const srcHash = (payload.source_row_hash as string | null | undefined) ?? null;
  const draftMeta = payload.draft_meta != null ? JSON.stringify(payload.draft_meta) : null;
  // Snapshot of the last PUBLISHED content, so the export can keep shipping it
  // until this draft is validated (docs/plan Design 2). Fresh on NULL/'validated'
  // prior state; carried through unchanged on draft-over-draft.
  const preDraftJson = nextPreDraftJson(target.translation_state, target.pre_draft_json, {
    note: target.note,
    tags: target.tags,
  });

  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Only the translated Note (+ optional localized Tags) and the
        // translation bookkeeping change; quote/occurrence/support_reference/
        // ref_raw are the untranslatable structural columns and are left
        // untouched. CAS-guarded on version so a translator editing the row
        // between poll and apply isn't clobbered (lost CAS → skipped, the
        // draft is simply not applied over a fresh human edit). book-scoped.
        `UPDATE tn_rows
            SET note = ?1,
                tags = COALESCE(?2, tags),
                translation_state = 'ai_draft',
                source_row_hash = ?3,
                draft_meta_json = ?4,
                pre_draft_json = ?10,
                version = version + 1,
                updated_at = ?5,
                updated_by = ?6
          WHERE id = ?7 AND book = ?8 AND deleted_at IS NULL AND version = ?9`,
      )
      .bind(note, tags, srcHash, draftMeta, now, userId, target.id, job.book, target.version, preDraftJson),
    env.DB
      .prepare(
        // Audit gated on the CAS having won (post-update fingerprint present).
        // source='ai_pipeline' → the row-level AI chip shows for review.
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?1 AND book = ?2 AND version = ?5 AND updated_at = ?8
          )`,
      )
      .bind(target.id, job.book, userId, target.version, newVersion, JSON.stringify(payload), AI_SOURCE, now),
    env.DB
      .prepare(
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?3 AND book = ?4 AND version = ?5 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, target.id, job.book, newVersion, now),
  ]);
  return (res[0]?.meta?.changes ?? 0) > 0 ? "drafted" : "no_match";
}

// Translate-pipeline apply for translationQuestions (multilingual; PIPELINE-SPEC
// §2.1). The exact tN analogue: one target row per input row, keyed by the same
// rowId, with only the Question and Response translated — Reference/ID/Tags/
// Quote/Occurrence are copied through byte-identical, so we UPDATE question and
// response of the EXISTING target row and leave the structural columns alone. A
// translate run NEVER deletes rows and NEVER mints new ids — a proposal whose id
// has no matching row is skipped (surfaced in result, not inserted). Stamps
// translation_state='ai_draft' and writes edit_log kind='tq' source='ai_pipeline'
// so the review UI shows the AI chip.
async function applyTranslateTqRow(
  env: Env,
  p: PendingImportRow,
  job: ImportContext,
  userId: number,
): Promise<"drafted" | "no_match"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return "no_match";

  const target = await env.DB.prepare(
    `SELECT id, version, question, response, translation_state, pre_draft_json FROM tq_rows
      WHERE id = ?1 AND deleted_at IS NULL
        AND book = ?2 AND chapter BETWEEN ?3 AND ?4`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{
      id: string;
      version: number;
      question: string | null;
      response: string | null;
      translation_state: string | null;
      pre_draft_json: string | null;
    }>();
  if (!target) return "no_match";

  const now = Math.floor(Date.now() / 1000);
  const newVersion = target.version + 1;
  const question = (payload.question as string | null | undefined) ?? null;
  const response = (payload.response as string | null | undefined) ?? null;
  const srcHash = (payload.source_row_hash as string | null | undefined) ?? null;
  const draftMeta = payload.draft_meta != null ? JSON.stringify(payload.draft_meta) : null;
  // Last-published snapshot for export gating — see applyTranslateTnRow.
  const preDraftJson = nextPreDraftJson(target.translation_state, target.pre_draft_json, {
    question: target.question,
    response: target.response,
  });

  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Only the translated Question/Response and the translation bookkeeping
        // change; quote/occurrence/ref_raw/tags are the untranslatable structural
        // columns and are left untouched. CAS-guarded on version so a translator
        // editing the row between poll and apply isn't clobbered. book-scoped.
        `UPDATE tq_rows
            SET question = ?1,
                response = ?2,
                translation_state = 'ai_draft',
                source_row_hash = ?3,
                draft_meta_json = ?4,
                pre_draft_json = ?10,
                version = version + 1,
                updated_at = ?5,
                updated_by = ?6
          WHERE id = ?7 AND book = ?8 AND deleted_at IS NULL AND version = ?9`,
      )
      .bind(question, response, srcHash, draftMeta, now, userId, target.id, job.book, target.version, preDraftJson),
    env.DB
      .prepare(
        // Audit gated on the CAS having won (post-update fingerprint present).
        // source='ai_pipeline' → the row-level AI chip shows for review.
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'tq', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM tq_rows
             WHERE id = ?1 AND book = ?2 AND version = ?5 AND updated_at = ?8
          )`,
      )
      .bind(target.id, job.book, userId, target.version, newVersion, JSON.stringify(payload), AI_SOURCE, now),
    env.DB
      .prepare(
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM tq_rows
             WHERE id = ?3 AND book = ?4 AND version = ?5 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, target.id, job.book, newVersion, now),
  ]);
  return (res[0]?.meta?.changes ?? 0) > 0 ? "drafted" : "no_match";
}

// Translate-pipeline apply for tw/ta markdown articles (multilingual). The
// article analogue of applyTranslateTqRow: UPDATEs target_md of the EXISTING
// article_unit keyed by (resource, path), stamps translation_state='ai_draft',
// CAS-guarded on version, edit_log kind='tw'|'ta' source='ai_pipeline'. Never
// inserts — a path with no matching unit is skipped (the importer seeds units
// from source; the bot only translates files that already exist).
async function applyTranslateArticle(
  env: Env,
  p: PendingImportRow,
  userId: number,
): Promise<"drafted" | "no_match"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const resource = typeof payload.resource === "string" ? payload.resource : null;
  const path = typeof payload.path === "string" ? payload.path : null;
  const targetMd = typeof payload.target_md === "string" ? payload.target_md : null;
  if (!resource || !path || targetMd == null) return "no_match";

  const target = await env.DB.prepare(
    `SELECT version, target_md, translation_state, pre_draft_json FROM article_units
      WHERE resource = ?1 AND path = ?2 AND deleted_at IS NULL`,
  )
    .bind(resource, path)
    .first<{
      version: number;
      target_md: string | null;
      translation_state: string | null;
      pre_draft_json: string | null;
    }>();
  if (!target) return "no_match";

  const now = Math.floor(Date.now() / 1000);
  const newVersion = target.version + 1;
  const draftMeta = payload.draft_meta != null ? JSON.stringify(payload.draft_meta) : null;
  // Last-published snapshot for export gating — see applyTranslateTnRow. A
  // null target_md snapshot means "never previously translated": the export
  // then OMITS the file rather than shipping the unapproved draft.
  const preDraftJson = nextPreDraftJson(target.translation_state, target.pre_draft_json, {
    target_md: target.target_md,
  });

  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Only target_md + translation bookkeeping change; source_md/source_sha
        // (the English source, set by the importer) are untouched. CAS-guarded
        // on version so a human editing the target between poll and apply isn't
        // clobbered.
        `UPDATE article_units
            SET target_md = ?1,
                translation_state = 'ai_draft',
                draft_meta_json = ?2,
                pre_draft_json = ?8,
                version = version + 1,
                updated_at = ?3,
                updated_by = ?4
          WHERE resource = ?5 AND path = ?6 AND deleted_at IS NULL AND version = ?7`,
      )
      .bind(targetMd, draftMeta, now, userId, resource, path, target.version, preDraftJson),
    env.DB
      .prepare(
        // edit_log.kind carries the resource (tw|ta); row_key is the path.
        // Gated on the CAS having won (post-update fingerprint present).
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT ?1, ?2, NULL, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM article_units
             WHERE resource = ?1 AND path = ?2 AND version = ?5 AND updated_at = ?8
          )`,
      )
      .bind(resource, path, userId, target.version, newVersion, JSON.stringify(payload), AI_SOURCE, now),
    env.DB
      .prepare(
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM article_units
             WHERE resource = ?3 AND path = ?4 AND version = ?5 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, resource, path, newVersion, now),
  ]);
  return (res[0]?.meta?.changes ?? 0) > 0 ? "drafted" : "no_match";
}

// Banner alert (GET /api/alerts/me, rendered top-of-app) when a translate run
// produced article drafts but applied NONE — every path was a no_match. Keyed
// by job so the import's retry-once path replaces rather than duplicates it.
// Best-effort: an alert-write failure must never fail the apply.
async function recordArticleNoApplyAlert(
  env: Env,
  job: ImportContext,
  userId: number,
  proposalCount: number,
): Promise<void> {
  try {
    const u = await env.DB.prepare(`SELECT dcs_username FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ dcs_username: string }>();
    const username = u?.dcs_username;
    if (!username) return;
    const source = `translate_articles_no_apply:${job.jobId}`;
    const message =
      `Translation run produced ${proposalCount} article draft(s) but applied 0 — every target path was a ` +
      `no-match (the matching tW/tA article did not exist in this project, or a concurrent human edit won the ` +
      `version check). Re-import the source articles (scripts/import-articles.mjs) or verify the paths, then re-run.`;
    await env.DB.prepare(
      `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
    )
      .bind(username, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url)
       VALUES (?1, 'warning', ?2, ?3, ?4)`,
    )
      .bind(username, source, message, "#/articles")
      .run();
  } catch (e) {
    console.error("article no-apply alert failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

async function applyTnHintExpansionIfMatch(
  env: Env,
  p: PendingImportRow,
  job: ImportContext,
  userId: number,
): Promise<boolean> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return false;

  const stub = await env.DB.prepare(
    `SELECT id, version FROM tn_rows
      WHERE id = ?1 AND hint = 1 AND deleted_at IS NULL
        AND book = ?2 AND chapter BETWEEN ?3 AND ?4`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{ id: string; version: number }>();
  if (!stub) return false;

  const now = Math.floor(Date.now() / 1000);
  const newVersion = stub.version + 1;
  const res = await env.DB.batch([
    env.DB
      .prepare(
        // Update content; clear hint so the row stops being queued for
        // future runs. Leave preserve and updated_by alone — the row's
        // standing authorship stays with whoever created the stub, and
        // any prior preserve intent survives the expansion.
        //
        // CAS-guarded: `hint = 1` and `version = ?` must STILL hold at write
        // time. TN edits are allowed mid-pipeline (rows.ts), so between the
        // SELECT above and here a translator may (a) un-queue the hint
        // (hint -> 0, which does NOT bump version — caught by `hint = 1`) or
        // (b) edit the stub's content (bumps version + sets updated_by —
        // caught by `version = stub.version`). Either way the expansion must
        // abort rather than clobber the user's change. NOTE: we deliberately
        // do NOT guard on `updated_by IS NULL` — a human-created hint stub
        // already carries the creator's id (createRow sets updated_by), so
        // that predicate would abort every legitimate expansion.
        // book-scoped so a colliding stub id in another book isn't clobbered.
        `UPDATE tn_rows
            SET quote = ?1,
                support_reference = ?2,
                note = ?3,
                occurrence = ?4,
                ref_raw = COALESCE(?5, ref_raw),
                tags = ?6,
                hint = 0,
                version = version + 1,
                updated_at = ?7
          WHERE id = ?8 AND book = ?9 AND deleted_at IS NULL
            AND hint = 1 AND version = ?10`,
      )
      .bind(
        (payload.quote as string | null | undefined) ?? null,
        (payload.support_reference as string | null | undefined) ?? null,
        (payload.note as string | null | undefined) ?? null,
        (payload.occurrence as number | null | undefined) ?? null,
        (payload.ref_raw as string | null | undefined) ?? null,
        (payload.tags as string | null | undefined) ?? null,
        now,
        stub.id,
        job.book,
        stub.version,
      ),
    env.DB
      .prepare(
        // Audit row, gated on the CAS having WON: the post-update fingerprint
        // (new version + hint cleared + our updated_at) is present only if the
        // UPDATE above actually fired. A lost CAS writes neither audit nor
        // accept. AI wrote this revision, but with the hint_expansion label so
        // the row-level AI chip stays off.
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         SELECT 'tn', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
          WHERE EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?1 AND book = ?2
               AND version = ?5 AND hint = 0 AND updated_at = ?8
          )`,
      )
      .bind(
        stub.id,
        job.book,
        userId,
        stub.version,
        newVersion,
        JSON.stringify(payload),
        HINT_EXPANSION_SOURCE,
        now,
      ),
    env.DB
      .prepare(
        // Mark the proposal accepted only if the CAS won (same fingerprint).
        // On a lost CAS this stays unresolved and the caller falls through to
        // applyTnInsert below, materializing the AI note as a fresh row
        // instead of dropping it.
        `UPDATE pending_imports
            SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND EXISTS (
            SELECT 1 FROM tn_rows
             WHERE id = ?3 AND book = ?4
               AND version = ?5 AND hint = 0 AND updated_at = ?6
          )`,
      )
      .bind(p.id, userId, stub.id, job.book, newVersion, now),
  ]);
  // CAS won iff the UPDATE changed a row. On a lost CAS return false so the
  // caller materializes the proposal via applyTnInsert (its proposed id now
  // PK-collides with the concurrently-edited stub, so it retries to a fresh
  // id) — the translator's edit survives and the AI note isn't lost.
  return (res[0]?.meta?.changes ?? 0) > 0;
}

async function applyTnInsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const insertCols = [
    "id",
    "book",
    "chapter",
    "verse",
    "ref_raw",
    "tags",
    "support_reference",
    "quote",
    "occurrence",
    "note",
    "updated_by",
    "sort_order",
  ];

  // PRESERVE bp-assistant's proposed id. It's the SAME id that lands on master,
  // so keeping it lets the nightly reimport recognize this row instead of
  // re-adding a divergent-id copy of the same note — the TN duplication bug
  // (each AI-generated note ending up doubled). Only mint a fresh id when the
  // proposed one is malformed (bp-assistant occasionally emits an id that fails
  // the 4-char [a-z][a-z0-9]{3} format — usually a first char that isn't [a-z])
  // or when it actually PK-collides; attempt 0 uses the proposed id, later
  // attempts mint. TQ already preserves its proposed id (insertTqAtId).
  const proposedId =
    typeof payload.id === "string" && isValidRowId(payload.id) ? payload.id : null;
  let id = "";
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    id = attempt === 0 && proposedId ? proposedId : newRowId();
    const values: unknown[] = [
      id,
      payload.book ?? null,
      payload.chapter ?? null,
      payload.verse ?? null,
      payload.ref_raw ?? null,
      payload.tags ?? null,
      payload.support_reference ?? null,
      payload.quote ?? null,
      payload.occurrence ?? null,
      payload.note ?? null,
      userId,
      sortOrder,
    ];
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO tn_rows (${insertCols.join(", ")})
             VALUES (${insertCols.map((_, i) => `?${i + 1}`).join(", ")})`,
          )
          .bind(...values),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
          )
          .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
        env.DB
          .prepare(
            `UPDATE pending_imports
                SET accepted_at = unixepoch(), accepted_by = ?2
              WHERE id = ?1`,
          )
          .bind(p.id, userId),
      ]);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  if (lastErr) throw new Error(`tn id collision exhausted after 8 attempts`);
}

async function applyTqUpsert(
  env: Env,
  p: PendingImportRow,
  userId: number,
  sortOrder: number,
  claimedIds: Set<string>,
): Promise<"created" | "updated" | "conflict"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const rawId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;

  // Candidate-id chain. Attempt 0 is bp-assistant's proposed id (coerced if it
  // violates the 4-char grammar); later attempts are DETERMINISTIC derivations
  // of it. Determinism is the point: when the preferred id can't be used it
  // stays unusable, so a re-run of this chapter walks the identical chain,
  // finds the row the previous run created, and updates it. Minting randomly
  // instead would insert a second copy of the same question on every re-run.
  const seedId = rawId ? coerceRowId(rawId) : null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = seedId ? (attempt === 0 ? seedId : deriveAltRowId(seedId, attempt)) : newRowId();

    // Book-scoped to match the composite PK — a colliding id in another book is
    // a "not found here", not a stale match.
    const existing = await env.DB.prepare(
      `SELECT version, chapter, verse FROM tq_rows WHERE id = ?1 AND book = ?2 AND deleted_at IS NULL`,
    )
      .bind(id, p.book)
      .first<{ version: number; chapter: number; verse: number }>();
    if (existing) {
      // The id is live. Whether that row is OURS depends on where the candidate
      // came from, and guessing wrong overwrites someone else's question with
      // this one — silent loss, since the proposal is then marked accepted.
      //
      //   attempt 0 with a seed — the id bp-assistant asserts owns this row.
      //     Adopt it anywhere in this chapter; the update rewrites verse/ref_raw
      //     so a question moved within the chapter stays consistent. A match in
      //     a DIFFERENT chapter is a stale/reused id, not ours: TQ rows don't
      //     migrate between chapters, and adopting would rewrite an unrelated
      //     question while leaving it filed under its own chapter.
      //
      //   derived candidate (attempt >= 1) — not claimed by anyone; it's just
      //     the next free slot in this seed's deterministic chain. A live row
      //     here is ours ONLY if it's the row a previous run of this same chain
      //     created, which sits at this same chapter AND verse. Two different
      //     seeds can hash to the same alternate (~1 in 786k per pair); without
      //     the verse check the second proposal would UPDATE over the first.
      //
      //   no seed (random mint) — the candidate asserts nothing at all, so a
      //     live row is never ours. Step on. Without this, a random id that
      //     happens to hit a live row in this chapter silently overwrites it.
      //   ...and never a row THIS pass already wrote (claimedIds): that row
      //     belongs to an earlier proposal in this same run, not to a previous
      //     run of our chain, so adopting it would overwrite a question we just
      //     created. This is the same-verse case the chapter/verse check alone
      //     cannot separate.
      const isOurs =
        seedId !== null &&
        existing.chapter === p.chapter &&
        (attempt === 0 || existing.verse === p.verse) &&
        !claimedIds.has(id);
      if (!isOurs) continue;
      const newVersion = existing.version + 1;
      const now = Math.floor(Date.now() / 1000);
      const patch = {
        ref_raw: payload.ref_raw ?? null,
        tags: payload.tags ?? null,
        quote: payload.quote ?? null,
        occurrence: payload.occurrence ?? null,
        question: payload.question ?? null,
        response: payload.response ?? null,
      };
      // CAS-guarded, mirroring applyVerseUpdate below. tq_rows is live editable
      // content (TQ has no active-pipeline PATCH guard the way tn does, so a
      // translator's edit can land here between our SELECT above and this
      // write). Without `AND version = ?13` this UPDATE would unconditionally
      // overwrite it and then mark the proposal accepted — silently discarding
      // the concurrent edit. The whole write stays ONE D1 batch (one
      // transaction), so a lost CAS can never leave the content UPDATE
      // committed with its audit trail missing.
      //
      // The accept runs immediately after the UPDATE so its `changes() > 0`
      // reads THAT mutation's row count (an intervening statement would reset
      // changes()); the audit INSERT self-gates in SQL on a causal fingerprint
      // (version = newVersion AND updated_by = our userId AND updated_at = now)
      // rather than JS branching, which a D1 batch can't make conditional on an
      // earlier statement. updated_by is the AI-pipeline user, never a human's,
      // so a translator CAS racing from the same starting version — which
      // computes the identical newVersion — can't satisfy the fingerprint.
      const results = await env.DB.batch([
        env.DB
          .prepare(
            // sort_order is refreshed too: TQ has no preserve/keep semantics —
            // each run fully reorders the verse to match the incoming file.
            // `verse` is rewritten alongside ref_raw so a question the run
            // moved to another verse of this chapter can't end up filed under
            // its old verse while displaying the new reference.
            `UPDATE tq_rows
                SET ref_raw = ?1, tags = ?2, quote = ?3, occurrence = ?4,
                    question = ?5, response = ?6, sort_order = ?7, verse = ?8,
                    version = version + 1, updated_at = ?9, updated_by = ?10
              WHERE id = ?11 AND book = ?12 AND deleted_at IS NULL AND version = ?13`,
          )
          .bind(
            patch.ref_raw,
            patch.tags,
            patch.quote,
            patch.occurrence,
            patch.question,
            patch.response,
            sortOrder,
            p.verse,
            now,
            userId,
            id,
            p.book,
            existing.version,
          ),
        env.DB
          .prepare(
            `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2
              WHERE id = ?1 AND changes() > 0`,
          )
          .bind(p.id, userId),
        env.DB
          .prepare(
            `INSERT INTO edit_log
               (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
             SELECT 'tq', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7
              WHERE EXISTS (
                SELECT 1 FROM tq_rows
                 WHERE id = ?1 AND book = ?2 AND version = ?5
                   AND updated_by = ?3 AND updated_at = ?8
              )`,
          )
          .bind(id, p.book, userId, existing.version, newVersion, JSON.stringify(patch), AI_SOURCE, now),
      ]);
      if ((results[0]?.meta?.changes ?? 0) === 0) {
        // Lost the race: a concurrent write advanced this row's version between
        // our SELECT and the UPDATE, so the CAS matched nothing — the accept and
        // audit both self-gated shut. Leave pending_imports unaccepted: it stays
        // visible via GET /api/pending-imports for review, and is deliberately
        // NOT auto-retried (re-applying this now-stale AI content over the
        // concurrent edit would reproduce the exact clobber this guard prevents).
        // The id is NOT claimed — nothing of ours landed on it.
        console.warn("pipeline apply: tq CAS conflict — row changed since read, skipping (needs manual review)", {
          id,
          book: p.book,
          chapter: p.chapter,
          verse: p.verse,
          expectedVersion: existing.version,
        });
        return "conflict";
      }
      claimedIds.add(id);
      return "updated";
    }

    // No LIVE row at this id. It's either free, or held by a TOMBSTONE: the
    // lookup above filters `deleted_at IS NULL` while the constraint the insert
    // must satisfy is `PRIMARY KEY (book, id)`, which has no deleted_at
    // component — so a soft-deleted row is invisible here yet owns its slot
    // forever. Let the INSERT be the arbiter and step to the next candidate on
    // collision. Stepping (rather than reusing the slot) is deliberate:
    // overwriting a tombstone would silently resurrect a row a translator
    // deleted, into whatever verse the new proposal belongs to.
    //
    // (1CH 23:7 proposed `hoig`, held by a hand-deleted 1CH 5:4 question. The
    // previously unguarded insert threw out of applyJobOutput and killed the
    // whole job, twice, terminally.)
    try {
      await insertTqAtId(env, p, payload, id, userId, sortOrder);
      claimedIds.add(id);
      return "created";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE|PRIMARY KEY/i.test(msg)) throw e;
    }
  }
  throw new Error(
    `tq id collision exhausted after 8 attempts (book ${p.book}, ref ${p.chapter}:${p.verse}, proposed id ${rawId ?? "none"})`,
  );
}

async function insertTqAtId(
  env: Env,
  p: PendingImportRow,
  payload: Record<string, unknown>,
  id: string,
  userId: number,
  sortOrder: number,
): Promise<void> {
  const cols = ["id", "book", "chapter", "verse", "ref_raw", "tags", "quote", "occurrence", "question", "response", "updated_by", "sort_order"];
  // book/chapter/verse come from the pending_imports row, NOT the payload.
  // `p.book` is the job's book and is what the caller's liveness lookup, the
  // (book, id) collision guard, and the edit_log row below all key on; taking
  // them from the payload instead would let a stray TSV cell insert the row
  // into a different (book, id) space than the one just checked, leaving the
  // audit row pointing at a row that doesn't exist there.
  const values = [
    id,
    p.book,
    p.chapter,
    p.verse,
    payload.ref_raw ?? null,
    payload.tags ?? null,
    payload.quote ?? null,
    payload.occurrence ?? null,
    payload.question ?? null,
    payload.response ?? null,
    userId,
    sortOrder,
  ];
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO tq_rows (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
      )
      .bind(...values),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
         VALUES ('tq', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
      )
      .bind(id, p.book, userId, JSON.stringify(payload), AI_SOURCE),
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
      .bind(p.id, userId),
  ]);
}

// Load every UHB/UGNT source verse in the job's chapter range in ONE query and
// index its `\w` source words by verse. Used to canonize alignment source attrs
// (and heal U+FFFD) against the exact source without a per-verse D1 read.
async function loadUhbSourceWords(
  env: Env,
  job: ImportContext,
): Promise<Map<number, SourceWord[]>> {
  const srcVersion = NT_BOOKS.has(job.book) ? "UGNT" : "UHB";
  const rs = await env.DB.prepare(
    `SELECT chapter, verse, content_json FROM verses
      WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3 AND bible_version = ?4
        AND source_generation = 1`,
  )
    .bind(job.book, job.startChapter, job.endChapter, srcVersion)
    .all<{ chapter: number; verse: number; content_json: string }>();
  const map = new Map<number, SourceWord[]>();
  for (const r of rs.results ?? []) {
    try {
      const vo = (JSON.parse(r.content_json) as { verseObjects?: unknown[] }).verseObjects ?? [];
      map.set(r.chapter * 100000 + r.verse, collectSourceWords(vo));
    } catch {
      /* skip an unparseable source verse — canonize/heal then no-op for it */
    }
  }
  return map;
}

// Source words for a target verse, unioned across a verse bridge (verse_end) so
// a bridged ULT/UST verse can match source words from every verse it spans.
function sourceWordsForRange(
  map: Map<number, SourceWord[]>,
  chapter: number,
  verse: number,
  verseEnd: number | null,
): SourceWord[] {
  const end = verseEnd != null && verseEnd >= verse ? verseEnd : verse;
  if (end === verse) return map.get(chapter * 100000 + verse) ?? [];
  const out: SourceWord[] = [];
  for (let v = verse; v <= end; v++) {
    const ws = map.get(chapter * 100000 + v);
    if (ws) out.push(...ws);
  }
  return out;
}

async function applyVerseUpdate(
  env: Env,
  p: PendingImportRow,
  userId: number,
  uhbWordsByVerse: Map<number, SourceWord[]>,
  jobStamp?: {
    source_generation: number | null;
    source_owner: string | null;
    source_repo: string | null;
    source_ref: string | null;
    source_stamps_json: string | null;
    pipeline_type: string;
  },
): Promise<void> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const book = String(payload.book ?? p.book);
  const chapter = Number(payload.chapter ?? p.chapter);
  const verse = Number(payload.verse ?? p.verse);
  const verseEndRaw = payload.verse_end;
  const verseEnd =
    typeof verseEndRaw === "number" && Number.isFinite(verseEndRaw) ? verseEndRaw : null;
  const uhbWords = sourceWordsForRange(uhbWordsByVerse, chapter, verse, verseEnd);
  const bibleVersion = String(payload.bible_version ?? p.bible_version ?? "");
  let contentJson = String(payload.content_json ?? "");
  // Mutable: the AI-supplied value is the starting point, but every mutation
  // pass below that can change `.text` or drop/rewrite a node makes it stale
  // the moment it fires — see the re-derive after the ULT/UST self-heal block.
  let plainText = (payload.plain_text as string | null) ?? null;
  const rowKey = `${book}/${chapter}/${verse}/${bibleVersion}`;

  // Scripture-lane guard: never let an AI pipeline write scripture into a lane
  // that's frozen for a replacement (or still requires one). The generation is
  // about to flip; a late apply would land on the superseded generation. TSV
  // resources (tn/tq) are lane-agnostic and don't reach this path.
  const lane = laneForBibleVersion(bibleVersion);
  let sourceGeneration = 1;
  if (lane) {
    const gate = await assertLaneWritable(env, lane, "pipeline");
    if (!gate.ok) {
      // Mark the pending row accepted-with-skip so the job can finalize instead
      // of retrying a write the freeze will keep rejecting.
      await env.DB.prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
      )
        .bind(p.id, userId)
        .run();
      return;
    }
    // Generate jobs must have stamped a generation at create; refuse applies
    // that would land on a different generation than the job was started for.
    // Dual-lane jobs fence each bible version against THAT lane's stamp.
    if (jobStamp?.pipeline_type === "generate") {
      let laneStamp: {
        generation: number;
        owner: string;
        repo: string;
        ref: string;
      } | null = null;
      if (jobStamp.source_stamps_json) {
        try {
          const parsed = JSON.parse(jobStamp.source_stamps_json) as Record<
            string,
            { generation: number; owner: string; repo: string; ref: string }
          >;
          laneStamp = parsed[lane] ?? null;
        } catch {
          laneStamp = null;
        }
      }
      if (!laneStamp && jobStamp.source_generation != null) {
        laneStamp = {
          generation: jobStamp.source_generation,
          owner: jobStamp.source_owner!,
          repo: jobStamp.source_repo!,
          ref: jobStamp.source_ref!,
        };
      }
      if (!laneStamp) {
        await env.DB.prepare(
          `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
        )
          .bind(p.id, userId)
          .run();
        return;
      }
      if (
        gate.generation !== laneStamp.generation ||
        // owner/repo are DCS names (case-insensitive); ref stays exact.
        !sameDcsName(gate.config.source.owner, laneStamp.owner) ||
        !sameDcsName(gate.config.source.repo, laneStamp.repo) ||
        gate.config.source.ref !== laneStamp.ref
      ) {
        await env.DB.prepare(
          `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2 WHERE id = ?1`,
        )
          .bind(p.id, userId)
          .run();
        return;
      }
      sourceGeneration = laneStamp.generation;
    } else {
      sourceGeneration = gate.generation;
    }
  }

  // Self-heal target `\w` occurrence numbering before the AI-applied alignment
  // lands in D1. The bot can emit colliding/`occurrences="1"` data; recomputing
  // from document position keeps note-highlight / colors / quote-builder correct
  // and the DCS export valid. No-op on clean output; source text left untouched.
  if (bibleVersion === "ULT" || bibleVersion === "UST") {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      if (Array.isArray(parsed?.verseObjects)) {
        // Drop AI-mangled orphan `\zaln-e` end-markers / bare "-e" junk before
        // recompute, so the cleaned tree lands in D1 (and exports clean). See
        // stripOrphanAlignmentMarkers — MIC 6:10 UST.
        parsed.verseObjects = stripOrphanAlignmentMarkers(parsed.verseObjects);
        // Collapse any `\zaln-s` compound that wraps the same source token twice
        // (the doubled-source defect, e.g. JER 31:33 `אֶת אֶת בֵּית`) before it
        // lands in D1 / exports. No-op on clean output; source text untouched.
        parsed.verseObjects = dropDuplicateSourceMilestones(parsed.verseObjects);
        // Canonize `\zaln-s` source attrs (x-content / x-lemma) to the exact UHB
        // bytes — fixing combining-mark order and dropped joiners the AI aligner
        // emits — so stored + exported Hebrew matches the source and downstream
        // nfc() compares become no-ops. Structure-preserving; no-op when nothing
        // matches or the source verse wasn't loaded. See canonizeHebrew.ts.
        canonizeAlignmentSource(parsed.verseObjects, uhbWords);
        // Curl straight quotes bp-assistant wrote into verse text (JER 32/33,
        // NUM 26:53 prod forensics) before it lands in D1 / exports to master.
        // Structure-preserving — see curlifyVerseObjects: it only ever
        // reassigns a `.text` string, never a `\zaln-s` source attribute, so
        // this can't unalign a word or touch Hebrew/Greek. No-op on clean
        // output. MUST run BEFORE recomputeTargetOccurrences: curling can make
        // two `\w` nodes' text byte-identical (an already-curly "LORD’s" and an
        // AI-written straight "LORD's" both become "LORD’s"), and occurrence
        // numbering is keyed on exact text equality — recomputing first would
        // stamp the two as distinct occurrences of what are now the same word,
        // recreating the very `${text}|${occurrence}` collision that recompute
        // exists to prevent. Curling first means the recompute below always
        // sees the FINAL text.
        curlifyVerseObjects(parsed.verseObjects);
        recomputeTargetOccurrences(parsed.verseObjects);
        contentJson = JSON.stringify(parsed);
        // Re-derive plain_text from the FINAL corrected tree. Every pass
        // above can change what plain_text should read — curlifyVerseObjects
        // rewrites `.text`, stripOrphanAlignmentMarkers strips junk text,
        // dropDuplicateSourceMilestones can drop a duplicated wrapper — so
        // trusting the AI-supplied payload.plain_text past this point would
        // store it stale. A stale plain_text breaks FindReplaceOverlay /
        // source search (both match against plain_text) and, worse, makes
        // the next nightly bookReimport compare master's freshly-extracted
        // text against THIS stale value, see a false diff, and spuriously
        // re-seed the verse every night. Cheap and always correct to
        // recompute unconditionally here rather than tracking a changed-flag
        // across the differently-shaped healers.
        plainText = extractPlainText(parsed);
      }
    } catch {
      /* leave contentJson/plainText as-is if it isn't parseable JSON */
    }
  }

  // Heal AI-mangled U+FFFD in `\zaln-s` source attributes (the generator can emit
  // garbled multi-byte Hebrew, e.g. וּזְה❖❖בָם for "gold") before it lands in D1
  // — otherwise it shows as a broken aligner card and exports the garble to DCS.
  // Reconstruct from the parallel UHB/UGNT row; gated on the rare defect, and
  // structure-preserving so no word unaligns. See healReplacementChars. Does
  // NOT re-derive plainText: it only ever reassigns a milestone's source
  // attribute string (x-content/x-lemma/x-morph), never a node's `.text`, so
  // plain_text (which concatenates `.text` only) cannot change here.
  if ((bibleVersion === "ULT" || bibleVersion === "UST") && contentJson.includes("�")) {
    try {
      const parsed = JSON.parse(contentJson) as { verseObjects?: unknown[] };
      // Reuse the preloaded source words (same UHB/UGNT verse, now union of the
      // bridge range) instead of a per-verse read — see loadUhbSourceWords.
      const report = healReplacementChars(parsed.verseObjects ?? [], uhbWords);
      if (report.repaired.length > 0) contentJson = JSON.stringify(parsed);
      if (report.unrepaired.length > 0) {
        console.warn("pipeline apply: unrepaired U+FFFD in alignment source attrs", {
          book,
          chapter,
          verse,
          bibleVersion,
          unrepaired: report.unrepaired,
        });
      }
    } catch {
      /* leave contentJson as-is if anything is unparseable */
    }
  }

  // Pull the outgoing row too (not just its version): the AI write overwrites
  // content_json, so this is our one chance to preserve the PRE-AI state ("v0")
  // for verse history — see the guarded baseline insert below.
  const existing = await env.DB.prepare(
    `SELECT version, content_json, plain_text, updated_at FROM verses
      WHERE book = ?1 AND chapter = ?2 AND verse = ?3 AND bible_version = ?4
        AND source_generation = ?5`,
  )
    .bind(book, chapter, verse, bibleVersion, sourceGeneration)
    .first<{ version: number; content_json: string; plain_text: string | null; updated_at: number }>();

  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    const expectedVersion = existing.version;
    const newVersion = expectedVersion + 1;
    // Param order for the UPDATE: content…, book coords, source_generation,
    // expectedVersion, [lane]. Lane EXISTS uses the generation + lane binds.
    const lanePred = lane
      ? `AND EXISTS (
            SELECT 1 FROM scripture_lane_state
             WHERE lane = ?12 AND replacement_job_id IS NULL
               AND replacement_required = 0 AND active_generation = ?10
          )`
      : "";
    await env.DB.batch([
      // Expected-version CAS: only this mutation may advance expected → expected+1.
      env.DB
        .prepare(
          `UPDATE verses
              SET content_json = ?1, plain_text = ?2, verse_end = ?3,
                  version = version + 1, updated_at = ?4, updated_by = ?5
            WHERE book = ?6 AND chapter = ?7 AND verse = ?8 AND bible_version = ?9
              AND source_generation = ?10 AND version = ?11
              ${lanePred}`,
        )
        .bind(
          ...(lane
            ? [
                contentJson,
                plainText,
                verseEnd,
                now,
                userId,
                book,
                chapter,
                verse,
                bibleVersion,
                sourceGeneration,
                expectedVersion,
                lane,
              ]
            : [
                contentJson,
                plainText,
                verseEnd,
                now,
                userId,
                book,
                chapter,
                verse,
                bibleVersion,
                sourceGeneration,
                expectedVersion,
              ]),
        ),
      // Accept immediately after the UPDATE so changes() reflects THAT mutation
      // (not a concurrent writer's version bump). Intervening statements would
      // overwrite changes().
      env.DB
        .prepare(
          `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2
            WHERE id = ?1 AND changes() > 0`,
        )
        .bind(p.id, userId),
      // Audit only if THIS mutation landed: match the causal fingerprint we wrote
      // (version + updated_by + content_json + updated_at). A competitor that
      // created newVersion with different bytes must not fabricate our history.
      env.DB
        .prepare(
          `INSERT INTO edit_log
             (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, created_at, source_generation)
           SELECT 'verse', ?1, ?2, NULL, NULL, ?3, 'baseline', ?4, NULL, ?5, ?6
            WHERE EXISTS (
              SELECT 1 FROM verses
               WHERE book = ?7 AND chapter = ?8 AND verse = ?9 AND bible_version = ?10
                 AND source_generation = ?11 AND version = ?12
                 AND updated_by = ?13 AND content_json = ?14 AND updated_at = ?15
            )
              AND NOT EXISTS (
              SELECT 1 FROM edit_log WHERE kind = 'verse' AND row_key = ?1 AND new_version = ?3
            )`,
        )
        .bind(
          rowKey,
          book,
          expectedVersion,
          JSON.stringify({ plain_text: existing.plain_text, content: existing.content_json }),
          existing.updated_at,
          sourceGeneration,
          book,
          chapter,
          verse,
          bibleVersion,
          sourceGeneration,
          newVersion,
          userId,
          contentJson,
          now,
        ),
      env.DB
        .prepare(
          `INSERT INTO edit_log
             (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, source_generation)
           SELECT 'verse', ?1, ?2, ?3, ?4, ?5, 'update', ?6, ?7, ?8
            WHERE EXISTS (
              SELECT 1 FROM verses
               WHERE book = ?9 AND chapter = ?10 AND verse = ?11 AND bible_version = ?12
                 AND source_generation = ?13 AND version = ?5
                 AND updated_by = ?3 AND content_json = ?14 AND updated_at = ?15
            )`,
        )
        .bind(
          rowKey,
          book,
          userId,
          expectedVersion,
          newVersion,
          JSON.stringify({ plain_text: plainText, content: contentJson }),
          AI_SOURCE,
          sourceGeneration,
          book,
          chapter,
          verse,
          bibleVersion,
          sourceGeneration,
          contentJson,
          now,
        ),
    ]);
    return;
  }

  // The verse should exist from the initial book import; this branch is the
  // defensive case where the seed missed something. Insert as a brand-new row.
  await env.DB.batch([
    lane
      ? env.DB
          .prepare(
            `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text, updated_by)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
              WHERE EXISTS (
                SELECT 1 FROM scripture_lane_state
                 WHERE lane = ?10 AND replacement_job_id IS NULL
                   AND replacement_required = 0 AND active_generation = ?6
              )`,
          )
          .bind(book, chapter, verse, verseEnd, bibleVersion, sourceGeneration, contentJson, plainText, userId, lane)
      : env.DB
          .prepare(
            `INSERT INTO verses (book, chapter, verse, verse_end, bible_version, source_generation, content_json, plain_text, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          )
          .bind(book, chapter, verse, verseEnd, bibleVersion, sourceGeneration, contentJson, plainText, userId),
    // Accept immediately after INSERT so changes() reflects that mutation.
    env.DB
      .prepare(
        `UPDATE pending_imports SET accepted_at = unixepoch(), accepted_by = ?2
          WHERE id = ?1 AND changes() > 0`,
      )
      .bind(p.id, userId),
    env.DB
      .prepare(
        `INSERT INTO edit_log
           (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source, source_generation)
         SELECT 'verse', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5, ?6
          WHERE EXISTS (
            SELECT 1 FROM verses
             WHERE book = ?7 AND chapter = ?8 AND verse = ?9 AND bible_version = ?10
               AND source_generation = ?11 AND version = 1
               AND updated_by = ?3 AND content_json = ?12
          )`,
      )
      .bind(
        rowKey,
        book,
        userId,
        JSON.stringify({ plain_text: plainText, content: contentJson }),
        AI_SOURCE,
        sourceGeneration,
        book,
        chapter,
        verse,
        bibleVersion,
        sourceGeneration,
        contentJson,
      ),
  ]);
}
