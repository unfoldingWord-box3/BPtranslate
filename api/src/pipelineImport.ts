// Pulls a done pipeline_jobs row's output[] from Door43, parses each file,
// and stages the rows into pending_imports for translator review (Phase 2).
//
// Called from the GET /api/pipelines/:jobId handler when the upstream poll
// surfaces state='done' for the first time. Idempotent on re-poll: a complete-
// staging marker (pipeline_jobs.staged_at) short-circuits the parse once the
// full proposal set has landed; an incomplete prior attempt is restaged.

import type { Env } from "./index";
import {
  curlifyText,
  extractVersesForRange,
  normalizeNoteWhitespace,
  parseTsv,
  refParts,
  type VerseExtract,
} from "./importParsers.ts";
import type { ProjectConfig } from "./projectConfig";
import { IMPORT_CLAIM_STALE_SECONDS } from "./pipelineImportClaim.ts";
import { nextPreDraftJson } from "./preDraftSnapshot.ts";
import { fetchBotOutputWith } from "./botOutput.ts";
import { getText, outKey } from "./translate/storage.ts";
import { selectRows } from "./translate/core.ts";
import { rawUrlOriginError } from "./rawUrlPin.ts";
import { HUMAN_TOUCH_ACTIONS, HUMAN_TOUCH_SOURCES } from "./pipelineDedupSql.ts";
import { houseStyleForProposal, loadEnabledHouseStyleRules, type HouseStyleRule } from "./houseStyle.ts";
import { readBookSourceNotes, readPinnedSourceNotes, type SourceNotes } from "./sourceNotes.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";

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
  pipelineType: string;
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
// Not intended as a public API beyond that.
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
      // normalizeNoteWhitespace) — the apply and the edit_log audit read this
      // same staged note. Curl straight quotes with the SAME contextual rule
      // verse text ingest uses
      // (curlifyText, not tsvFormat.ts's educateQuotes — see the module
      // comment above curlifyText in importParsers.ts for why the two
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

// The subset of its chapter range a translate job selected: explicit rowIds
// and/or a verse range, read from options_json the same way translate/params.ts
// does. null = the whole range. The output file is the WHOLE target book, so
// every row the job did not select is just the DCS copy, which can be older than
// D1 and must not be written over it (#559: a single-note rerun overwrote 173
// notes of LUK 7). Rows are matched with selectRows, the same filter the run
// used to pick its source rows, so import and run agree on the subset. That
// also covers the book introduction: a row-scoped job selects it only if it
// named it, a verse-range job never.
type TranslateSelection = { rowIds: string[] | null; verseStart: number | null; verseEnd: number | null };
async function translateSelection(env: Env, jobId: string): Promise<TranslateSelection | null> {
  const r = await env.DB.prepare(`SELECT options_json FROM pipeline_jobs WHERE job_id = ?1`)
    .bind(jobId)
    .first<{ options_json: string | null }>();
  let o: { rowIds?: unknown; verseStart?: unknown; verseEnd?: unknown } = {};
  try {
    const parsed: unknown = r?.options_json ? JSON.parse(r.options_json) : null;
    if (parsed && typeof parsed === "object") o = parsed;
  } catch {
    /* unreadable options: treat as whole-range, like dispatch does */
  }
  const rowIds = Array.isArray(o.rowIds) && o.rowIds.length ? o.rowIds.map(String) : null;
  const verseStart = typeof o.verseStart === "number" ? o.verseStart : null;
  const verseEnd = typeof o.verseEnd === "number" ? o.verseEnd : null;
  if (!rowIds && verseStart == null) return null;
  return { rowIds, verseStart, verseEnd };
}

// #794: the English a translate job translated from, "org/repo@ref", as
// buildTranslateOptions stored it in options_json (the project's source on
// master, or a caller's pinned ref). null when the job has none.
async function translateSourceRef(env: Env, jobId: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT options_json FROM pipeline_jobs WHERE job_id = ?1`)
    .bind(jobId)
    .first<{ options_json: string | null }>();
  try {
    const o: unknown = r?.options_json ? JSON.parse(r.options_json) : null;
    const ref = o && typeof o === "object" ? (o as { sourceRef?: unknown }).sourceRef : null;
    return typeof ref === "string" && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
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
    const selection = ctx.pipelineType === "translate" ? await translateSelection(env, ctx.jobId) : null;
    let unselected = 0;
    for (const row of rows) {
      const refRaw = row["Reference"];
      if (!refRaw) continue;
      const [ch] = refParts(refRaw);
      const selected = !selection || selectRows([row], selection).length > 0;
      // Book front matter (front:intro) is chapter 0. A translate job that starts
      // at chapter 1 can have translated it (translate/tsvCodec.ts
      // sliceChapterRows gives it to such a range), so it must not be scoped out
      // here, but only when this job actually selected it.
      const frontInScope =
        ch === 0 &&
        cls.kind === "tn" &&
        ctx.pipelineType === "translate" &&
        ctx.startChapter === 1 &&
        selected;
      if ((ch < ctx.startChapter && !frontInScope) || ch > ctx.endChapter) continue;
      if (!selected) {
        unselected += 1;
        continue;
      }
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
    if (unselected > 0) {
      return {
        staged,
        skipReason: `${unselected} ${cls.kind} row(s) outside the job's selected rows or verses (not imported)`,
      };
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
//      Idempotent at the per-row level (accepted_at IS NULL filter).
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
  // Set only by the retired tqs apply (#726), so always 0 now; as are
  // tnDeleted, tnCreated, tnHintExpanded, tnSkippedDup, tqCreated and verseUpdated.
  tqSkippedConflict: number;
  // Translate apply only (#601, option B): notes a person edited, approved,
  // marked Not needed or restored after this job was queued. Their AI draft is
  // not applied (the proposal stays unresolved) and the job's starter gets a
  // banner alert listing them. See humanTouchedIds.
  tnSkippedTouched: number;
  tnSkippedTouchedIds: string[];
  // The same for questions (#725): edited or approved after the job was queued.
  tqSkippedTouched: number;
  tqSkippedTouchedIds: string[];
  // Translate apply only (#735): notes already marked Not needed (trashed) when
  // the apply ran, so they get no AI draft. Kept apart from the touched count
  // above, which covers only changes made after the job was queued.
  tnSkippedTrashed: number;
  // Translate apply only (#794, option B): a whole-chapter run (no rowIds, no
  // verse range) leaves approved notes and questions as they are. A run that
  // names the row (one-note redo, verse range) still redrafts it.
  tnSkippedApproved: number;
  tnSkippedApprovedIds: string[];
  tqSkippedApproved: number;
  tqSkippedApprovedIds: string[];
  // Translate apply only (#794): note drafts that were the English source note
  // copied back (isEnglishEcho), so they were not applied.
  tnSkippedEnglish: number;
  tnSkippedEnglishIds: string[];
  // Why the English check could not run for a note that was then applied
  // anyway (it fails open), or null when it ran for every applied note.
  tnEnglishCheckNotRun: string | null;
  // tw/ta article files updated in place by the translate apply (by path).
  articleUpdated: number;
  // The same for tW/tA articles (#734), by path: edited or approved after the
  // job was queued.
  articleSkippedTouched: number;
  articleSkippedTouchedPaths: string[];
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
    `SELECT user_id, created_at, edit_log_watermark
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(job.jobId)
    .first<{
      user_id: number;
      created_at: number;
      edit_log_watermark: number | null;
    }>();
  if (!starter) throw new Error(`apply: pipeline_jobs row not found for ${job.jobId}`);
  const userId = starter.user_id;

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

  const result: ApplyResult = {
    tnDeleted: 0,
    tnCreated: 0,
    tnHintExpanded: 0,
    tnSkippedDup: 0,
    tqCreated: 0,
    tqUpdated: 0,
    tqSkippedConflict: 0,
    tnSkippedTouched: 0,
    tnSkippedTouchedIds: [],
    tqSkippedTouched: 0,
    tqSkippedTouchedIds: [],
    tnSkippedTrashed: 0,
    tnSkippedApproved: 0,
    tnSkippedApprovedIds: [],
    tqSkippedApproved: 0,
    tqSkippedApprovedIds: [],
    tnSkippedEnglish: 0,
    tnSkippedEnglishIds: [],
    tnEnglishCheckNotRun: null,
    articleUpdated: 0,
    articleSkippedTouched: 0,
    articleSkippedTouchedPaths: [],
    verseUpdated: 0,
    affectedChapters: [],
  };

  // Chapters that saw an actual write — populated at each mutation point below
  // and returned so the caller can hint open tabs once per changed chapter.
  const affected = new Set<number>();

  // Translate pipeline (multilingual): the only apply path (#726). It UPDATEs
  // existing target rows by rowId, never deletes, never inserts. A given
  // translate job produces exactly one resource kind (tn OR tq OR tw/ta
  // articles), so only the matching loop does work. Article apply is keyed by
  // (resource, path) against article_units.
  if (job.pipelineType === "translate") {
    // Option B on #601 (notes) and #725 (questions): a row a person changed
    // after this job was queued keeps their work. One query per kind for the
    // whole job (not one per row), so a whole-chapter apply stays inside the
    // subrequest budget.
    const selection =
      tnProposals.length > 0 || tqProposals.length > 0 ? await translateSelection(env, job.jobId) : null;
    const requested = new Set(selection?.rowIds ?? []);
    // #794: a whole-chapter run (no rowIds, no verse range) keeps approved rows.
    const keepApproved = selection === null;
    // #794: the English source notes, read once per job for every chapter with
    // a note proposal (cached per isolate). The English is the file the job
    // translated from: its options_json.sourceRef ("org/repo@ref", set at start,
    // possibly pinned to a commit), one read for the whole job. A job without
    // one (queued before sourceRef was stored) falls back to the project's
    // per-chapter source on master. A project that writes its notes in English
    // has no English source, so nothing is read.
    const english = new Map<number, SourceNotes>();
    if (tnProposals.length > 0 && isTranslationConfig(job.cfg)) {
      const chapters = [...new Set(tnProposals.map((p) => p.chapter))];
      const sourceRef = await translateSourceRef(env, job.jobId);
      if (sourceRef) {
        const notes = await readPinnedSourceNotes(env, sourceRef, job.book);
        for (const ch of chapters) english.set(ch, notes);
      } else {
        for (const [ch, notes] of await readBookSourceNotes(env, job.book, chapters)) english.set(ch, notes);
      }
    }
    // #815: this workspace's enabled house-style rules, read once per job (not
    // per row) and applied to every drafted note / question below.
    const houseRules =
      tnProposals.length > 0 || tqProposals.length > 0 ? await loadEnabledHouseStyleRules(env.DB) : [];
    // Returns, for a proposal, the key it would write (a row id, or an article
    // path) when a person touched it after the enqueue, else null.
    const touchedLookup = async (
      kind: TouchKind,
      proposals: PendingImportRow[],
      book: string | null,
      key: "id" | "path",
      requestedKeys: Set<string>,
    ) => {
      const proposalIds = new Map<PendingImportRow, string>();
      for (const p of proposals) {
        const id = (JSON.parse(p.payload_json) as Record<string, unknown>)[key];
        if (typeof id === "string") proposalIds.set(p, id);
      }
      const touched = await humanTouchedIds(
        env,
        kind,
        book,
        { watermark: starter.edit_log_watermark, queuedAt: starter.created_at },
        [...new Set(proposalIds.values())],
        requestedKeys,
      );
      return (p: PendingImportRow): string | null => {
        const id = proposalIds.get(p);
        return id !== undefined && touched.has(id) ? id : null;
      };
    };
    // A skipped proposal is left unresolved, like a no_match: nothing accepts
    // it later, and the one-retry import path skips it the same way.
    type SkipRefs = { refs: string[]; firstChapter: number | null };
    const noRefs = (): Record<"tn" | "tq", SkipRefs> => ({
      tn: { refs: [], firstChapter: null },
      tq: { refs: [], firstChapter: null },
    });
    // touched: a person changed it after the enqueue (#601/#725); approved:
    // approved before a whole-chapter run (#794); english: the draft was the
    // English source note (#794, notes only).
    const skipped: Record<SkipReason, Record<"tn" | "tq", SkipRefs>> = {
      touched: noRefs(),
      approved: noRefs(),
      english: noRefs(),
    };
    const recordSkip = (reason: SkipReason, kind: "tn" | "tq", p: PendingImportRow) => {
      const s = skipped[reason][kind];
      // Book intro is chapter 0; a chapter intro is verse 0 of its chapter.
      s.refs.push(p.chapter === 0 ? "intro" : p.verse === 0 ? `${p.chapter}:intro` : `${p.chapter}:${p.verse}`);
      s.firstChapter ??= p.chapter;
    };
    const tnTouched = await touchedLookup("tn", tnProposals, job.book, "id", requested);
    for (const p of tnProposals) {
      const proposedId = tnTouched(p);
      if (proposedId !== null) {
        result.tnSkippedTouched += 1;
        result.tnSkippedTouchedIds.push(proposedId);
        recordSkip("touched", "tn", p);
        continue;
      }
      const payload = JSON.parse(p.payload_json) as { id?: unknown; note?: unknown };
      const id = typeof payload.id === "string" ? payload.id : null;
      const source = english.get(p.chapter);
      const englishEcho =
        source?.ok === true && id !== null && isEnglishEcho(payload.note, source.notes.get(id));
      const outcome = await applyTranslateTnRow(env, p, job, userId, houseRules, { keepApproved, englishEcho });
      if (outcome === "drafted") {
        affected.add(p.chapter);
        result.tnHintExpanded += 1; // reuses the "updated in place" counter
        // Fail open (#794): the draft was applied without the English check.
        if (source && !source.ok) result.tnEnglishCheckNotRun ??= source.reason;
      } else if (outcome === "approved" && id !== null) {
        result.tnSkippedApproved += 1;
        result.tnSkippedApprovedIds.push(id);
        recordSkip("approved", "tn", p);
      } else if (outcome === "same_as_english" && id !== null) {
        // Left unresolved, like a touched skip; the note keeps its text.
        result.tnSkippedEnglish += 1;
        result.tnSkippedEnglishIds.push(id);
        recordSkip("english", "tn", p);
      } else if (outcome === "trashed") {
        // Marked Not needed before the apply: the proposal is left unresolved,
        // like a no_match, and the note keeps its text and state (#735).
        result.tnSkippedTrashed += 1;
      }
      // no_match: the id isn't a live target row (or a concurrent human edit
      // won the CAS) — the proposal is left unresolved rather than inserted,
      // preserving the row-identity guarantee. Surfaced via pending_imports.
    }
    const tqTouched = await touchedLookup("tq", tqProposals, job.book, "id", requested);
    for (const p of tqProposals) {
      const proposedId = tqTouched(p);
      if (proposedId !== null) {
        result.tqSkippedTouched += 1;
        result.tqSkippedTouchedIds.push(proposedId);
        recordSkip("touched", "tq", p);
        continue;
      }
      const outcome = await applyTranslateTqRow(env, p, job, userId, houseRules, { keepApproved });
      if (outcome === "drafted") {
        affected.add(p.chapter);
        result.tqUpdated += 1; // reuses the "updated in place" counter
      } else if (outcome === "approved") {
        const id = (JSON.parse(p.payload_json) as { id: string }).id;
        result.tqSkippedApproved += 1;
        result.tqSkippedApprovedIds.push(id);
        recordSkip("approved", "tq", p);
      }
    }
    // #734: the same for tW/tA articles. Their edit_log rows carry the resource
    // (tw|ta) as kind, the path as row_key and a NULL book, so the read is one
    // per resource, keyed on path. Articles have no single-row Redo, so nothing
    // is `requested`. Known gap: article routes have no lock while the job runs,
    // so a person's edit or Approve landing after this read and before that
    // article's write is not caught (applyTranslateArticle re-reads the version
    // just before its CAS, and Approve does not bump the version anyway).
    const articleTouched = new Map<PendingImportRow, string>();
    const articleSkipped: Record<"tw" | "ta", string[]> = { tw: [], ta: [] };
    for (const resource of ["tw", "ta"] as const) {
      const proposals = articleProposals.filter(
        (p) => (JSON.parse(p.payload_json) as { resource?: unknown }).resource === resource,
      );
      const touched = await touchedLookup(resource, proposals, null, "path", new Set());
      for (const p of proposals) {
        const path = touched(p);
        if (path !== null) articleTouched.set(p, path);
      }
    }
    for (const p of articleProposals) {
      const path = articleTouched.get(p);
      if (path !== undefined) {
        result.articleSkippedTouched += 1;
        result.articleSkippedTouchedPaths.push(path);
        articleSkipped[(JSON.parse(p.payload_json) as { resource: "tw" | "ta" }).resource].push(path);
        continue;
      }
      const outcome = await applyTranslateArticle(env, p, userId);
      if (outcome === "drafted") result.articleUpdated += 1;
    }
    // Articles have no chapter to hint an open tab with (sentinel 0/0), so an
    // all-no-match article run would otherwise complete silently — the job goes
    // 'done', nothing lands, and there is no scripture tab to signal. Surface a
    // banner alert so "0 applied" is visible rather than silent. Only when there
    // WERE article proposals it tried to apply but none drafted (every target
    // path missed its article_units row, or a concurrent human edit won the
    // CAS). Articles skipped as touched get the skipped alert below instead.
    const articleAttempted = articleProposals.length - result.articleSkippedTouched;
    if (articleAttempted > 0 && result.articleUpdated === 0) {
      await recordArticleNoApplyAlert(env, job, userId, articleAttempted);
    }
    for (const reason of ["touched", "approved", "english"] as const) {
      for (const kind of ["tn", "tq"] as const) {
        const s = skipped[reason][kind];
        if (s.firstChapter !== null) {
          // The book intro (chapter 0) is shown on chapter 1.
          await recordSkippedAlert(env, job, userId, reason, kind, s.refs, `#/${job.book}/${Math.max(1, s.firstChapter)}`);
        }
      }
    }
    for (const resource of ["tw", "ta"] as const) {
      const paths = articleSkipped[resource];
      if (paths.length > 0) await recordSkippedAlert(env, job, userId, "touched", resource, paths, `#/articles/${resource}`);
    }
    // The job result the status and list APIs read (#601): output_json is the
    // bot's own output, so the apply's skip report has its own column. Written
    // on every tn, tq or article translate apply, so a retry replaces it rather
    // than adding.
    if (tnProposals.length > 0 || tqProposals.length > 0 || articleProposals.length > 0) {
      const report = applySkippedOf(result);
      await env.DB.prepare(`UPDATE pipeline_jobs SET apply_skipped_json = ?2 WHERE job_id = ?1`)
        .bind(job.jobId, report ? JSON.stringify(report) : null)
        .run();
    }
    result.affectedChapters = [...affected].sort((a, b) => a - b);
    return result;
  }

  // #726: only translate jobs import. The retired types (generate/notes/tqs)
  // had their own delete-and-insert apply here; it is gone, and the poll fails
  // such a job before calling the import at all. This guards any other path.
  throw new Error(`apply: pipeline type '${job.pipelineType}' is retired; its output is not imported`);
}

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
  houseRules: HouseStyleRule[],
  guard: { keepApproved: boolean; englishEcho: boolean },
): Promise<"drafted" | "no_match" | "trashed" | "approved" | "same_as_english"> {
  const payload = JSON.parse(p.payload_json) as Record<string, unknown>;
  const proposedId = typeof payload.id === "string" ? payload.id : null;
  if (!proposedId) return "no_match";

  // `chapter = 0 AND ?3 = 1`: the book introduction (front:intro) rides along
  // with a job that starts at chapter 1, as in parseOutputEntry's staging scope.
  // trashed_at is read, not filtered, so a note marked Not needed reports
  // "trashed" rather than "no_match" (#735).
  const target = await env.DB.prepare(
    `SELECT id, version, note, tags, translation_state, pre_draft_json, trashed_at FROM tn_rows
      WHERE id = ?1 AND deleted_at IS NULL
        AND book = ?2 AND (chapter BETWEEN ?3 AND ?4 OR (chapter = 0 AND ?3 = 1))`,
  )
    .bind(proposedId, job.book, job.startChapter, job.endChapter)
    .first<{
      id: string;
      version: number;
      note: string | null;
      tags: string | null;
      translation_state: string | null;
      pre_draft_json: string | null;
      trashed_at: number | null;
    }>();
  if (!target) return "no_match";
  // A note marked Not needed gets no AI draft, as on the English apply path:
  // restoring it later must not bring back AI text nobody reviewed (#735).
  if (target.trashed_at != null) return "trashed";
  // #794: a whole-chapter run leaves an approved note as it is; only a run
  // that names the note (one-note redo, verse range) redrafts it.
  if (guard.keepApproved && target.translation_state === "validated") return "approved";
  // #794: a draft that is the English source note copied back is not applied.
  if (guard.englishEcho) return "same_as_english";

  const now = Math.floor(Date.now() / 1000);
  const newVersion = target.version + 1;
  // House-style rules (#815) fix the model's note before it is stored. The
  // staged payload stays raw; the edit_log payload gains raw_note +
  // applied_rules only when a rule changed something. Leftover English is
  // flagged in draft_meta_json, not rewritten.
  const house = houseStyleForProposal(payload, ["note"], houseRules);
  const note = house.values.note;
  const tags = (payload.tags as string | null | undefined) ?? null;
  const srcHash = (payload.source_row_hash as string | null | undefined) ?? null;
  const draftMeta = house.draftMetaJson;
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
          WHERE id = ?7 AND book = ?8 AND deleted_at IS NULL AND trashed_at IS NULL AND version = ?9
            AND (?11 = 0 OR translation_state IS NOT 'validated')`,
      )
      // ?11: an Approve does not bump the version, so the CAS alone would not
      // catch one landing between the read above and this write (#794).
      .bind(note, tags, srcHash, draftMeta, now, userId, target.id, job.book, target.version, preDraftJson, guard.keepApproved ? 1 : 0),
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
      .bind(target.id, job.book, userId, target.version, newVersion, JSON.stringify(house.logPayload), AI_SOURCE, now),
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
  if ((res[0]?.meta?.changes ?? 0) > 0) return "drafted";
  // #794: the write changed nothing. If the state guard was on and the note is
  // approved now, an Approve landed after the read above: report it as kept.
  return guard.keepApproved && (await approvedNow(env, "tn_rows", target.id, job.book)) ? "approved" : "no_match";
}

// #794: is this row approved right now? Read only after a guarded write changed
// nothing, so a whole-chapter apply pays it only on a lost race.
async function approvedNow(env: Env, table: "tn_rows" | "tq_rows", id: string, book: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT translation_state FROM ${table} WHERE id = ?1 AND book = ?2 AND deleted_at IS NULL`)
    .bind(id, book)
    .first<{ translation_state: string | null }>();
  return r?.translation_state === "validated";
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
  houseRules: HouseStyleRule[],
  guard: { keepApproved: boolean },
): Promise<"drafted" | "no_match" | "approved"> {
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
  // #794: a whole-chapter run leaves an approved question as it is.
  if (guard.keepApproved && target.translation_state === "validated") return "approved";

  const now = Math.floor(Date.now() / 1000);
  const newVersion = target.version + 1;
  // House-style rules (#815), as in applyTranslateTnRow, on both the question
  // and the response (raw_question / raw_response in the edit_log payload).
  const house = houseStyleForProposal(payload, ["question", "response"], houseRules);
  const question = house.values.question;
  const response = house.values.response;
  const srcHash = (payload.source_row_hash as string | null | undefined) ?? null;
  const draftMeta = house.draftMetaJson;
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
          WHERE id = ?7 AND book = ?8 AND deleted_at IS NULL AND version = ?9
            AND (?11 = 0 OR translation_state IS NOT 'validated')`,
      )
      // ?11: as in applyTranslateTnRow (#794).
      .bind(question, response, srcHash, draftMeta, now, userId, target.id, job.book, target.version, preDraftJson, guard.keepApproved ? 1 : 0),
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
      .bind(target.id, job.book, userId, target.version, newVersion, JSON.stringify(house.logPayload), AI_SOURCE, now),
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
  if ((res[0]?.meta?.changes ?? 0) > 0) return "drafted";
  // #794: see applyTranslateTnRow.
  return guard.keepApproved && (await approvedNow(env, "tq_rows", target.id, job.book)) ? "approved" : "no_match";
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

// HUMAN_TOUCH_ACTIONS / HUMAN_TOUCH_SOURCES (which edit_log entries count as a
// person changing a note or question) live in pipelineDedupSql.ts, shared with
// the /start route's #757 check so the two can't read edit_log differently.

// Ids among `ids` (this job's proposals) that a person touched after the job
// was queued. Exact when the job carries an edit_log watermark (migration
// 0076): a human edit_log row with id above it was written after the enqueue,
// whatever second either landed in, for every row the job writes.
// Jobs queued before that column (watermark NULL) fall back to seconds,
// comparing edit_log.created_at with pipeline_jobs.created_at, where a touch in
// the enqueue second itself is ambiguous: for a row the job was asked to
// (re)draft by id (`requested`, a Redo) it is most likely the save made just
// before asking, so only a later second counts; for any other row it counts,
// the side that loses no work.
// Bounded by `row_key IN (...)` (chunked under D1's bind limit) so a chapter
// job reads only its own rows' history, not the book's. The window between
// this read and the apply's write is covered by the #561/#602 route locks (the
// job is 'running' while it applies), and a content edit is also caught by the
// version CAS in applyTranslateTnRow / applyTranslateTqRow. For questions the
// lock covers PATCH, Approve (/rows/tq/:id/validate) and the admin
// review-state approve sweep (#752).
// tW/tA articles (#734): kind is the resource, ids are paths, and `book` is
// null (article edit_log rows have a NULL book; `book IS ?1` matches it). The
// article routes have no lock at all, so for them neither an edit nor an
// Approve inside that window is caught (see the article loop in applyJobOutput).
type TouchKind = "tn" | "tq" | "tw" | "ta";
const TOUCH_ID_CHUNK = 80;
async function humanTouchedIds(
  env: Env,
  kind: TouchKind,
  book: string | null,
  queued: { watermark: number | null; queuedAt: number },
  ids: string[],
  requested: Set<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const exact = queued.watermark !== null;
  const fixed = 2 + HUMAN_TOUCH_ACTIONS.length + HUMAN_TOUCH_SOURCES.length;
  const actions = HUMAN_TOUCH_ACTIONS.map((_, i) => `?${i + 3}`).join(", ");
  const sources = HUMAN_TOUCH_SOURCES.map((_, i) => `?${i + 3 + HUMAN_TOUCH_ACTIONS.length}`).join(", ");
  for (let i = 0; i < ids.length; i += TOUCH_ID_CHUNK) {
    const chunk = ids.slice(i, i + TOUCH_ID_CHUNK);
    const idPlaces = chunk.map((_, j) => `?${j + fixed + 1}`).join(", ");
    const rs = await env.DB.prepare(
      `SELECT row_key, MAX(created_at) AS last_touch FROM edit_log
        WHERE kind = '${kind}' AND book IS ?1 AND ${exact ? "id > ?2" : "created_at >= ?2"}
          AND action IN (${actions})
          AND (source IS NULL OR source IN (${sources}))
          AND row_key IN (${idPlaces})
        GROUP BY row_key`,
    )
      .bind(book, exact ? queued.watermark : queued.queuedAt, ...HUMAN_TOUCH_ACTIONS, ...HUMAN_TOUCH_SOURCES, ...chunk)
      .all<{ row_key: string; last_touch: number }>();
    for (const r of rs.results ?? []) {
      if (exact || r.last_touch > queued.queuedAt || !requested.has(r.row_key)) out.add(r.row_key);
    }
  }
  return out;
}

/**
 * pipeline_jobs.apply_skipped_json: what a translate apply left alone (#601
 * notes, #725 questions, #734 tW/tA articles by path), each key pair present
 * only when it skipped something:
 * - *Touched: a person changed the row after the job was queued.
 * - *Approved (#794): approved before a whole-chapter run, so kept as it is.
 * - tnSameAsEnglish (#794): the note draft was the English source note, so it
 *   was not applied.
 * - tnEnglishCheckNotRun (#794): why the English check could not run for
 *   notes that were applied anyway (it fails open).
 */
export interface ApplySkipped {
  tnTouched?: number;
  tnTouchedIds?: string[];
  tqTouched?: number;
  tqTouchedIds?: string[];
  articleTouched?: number;
  articleTouchedPaths?: string[];
  tnApproved?: number;
  tnApprovedIds?: string[];
  tqApproved?: number;
  tqApprovedIds?: string[];
  tnSameAsEnglish?: number;
  tnSameAsEnglishIds?: string[];
  tnEnglishCheckNotRun?: string;
}
/** The skip report for an apply, or null when it skipped nothing. */
export function applySkippedOf(r: ApplyResult): ApplySkipped | null {
  const report: ApplySkipped = {
    ...(r.tnSkippedTouched > 0 ? { tnTouched: r.tnSkippedTouched, tnTouchedIds: r.tnSkippedTouchedIds } : {}),
    ...(r.tqSkippedTouched > 0 ? { tqTouched: r.tqSkippedTouched, tqTouchedIds: r.tqSkippedTouchedIds } : {}),
    ...(r.articleSkippedTouched > 0
      ? { articleTouched: r.articleSkippedTouched, articleTouchedPaths: r.articleSkippedTouchedPaths }
      : {}),
    ...(r.tnSkippedApproved > 0 ? { tnApproved: r.tnSkippedApproved, tnApprovedIds: r.tnSkippedApprovedIds } : {}),
    ...(r.tqSkippedApproved > 0 ? { tqApproved: r.tqSkippedApproved, tqApprovedIds: r.tqSkippedApprovedIds } : {}),
    ...(r.tnSkippedEnglish > 0
      ? { tnSameAsEnglish: r.tnSkippedEnglish, tnSameAsEnglishIds: r.tnSkippedEnglishIds }
      : {}),
    ...(r.tnEnglishCheckNotRun !== null ? { tnEnglishCheckNotRun: r.tnEnglishCheckNotRun } : {}),
  };
  return Object.keys(report).length > 0 ? report : null;
}

// rc:// links (the same token rule as translate/checks.ts RC_LINK_RE) and web
// links. A note with no letter left once these are removed is links only.
const NOTE_LINK_RE = /(?:rc|https?):\/\/[^\s\])]+/g;

/**
 * #794: is this AI note draft the English source note copied back? The staged
 * draft went through normalizeNoteWhitespace and curlifyText (tnPayload), so
 * the English gets the same two steps; then both sides are NFC-normalized and
 * trimmed, and must match exactly. An empty English never counts, nor does a
 * links-only one (no letter outside its links), which is legitimately the same
 * in every language.
 */
export function isEnglishEcho(draft: unknown, english: string | undefined): boolean {
  if (typeof draft !== "string" || english == null) return false;
  const norm = (t: string) => t.normalize("NFC").trim();
  const e = norm(curlifyText(normalizeNoteWhitespace(english)));
  if (e === "" || !/\p{L}/u.test(e.replace(NOTE_LINK_RE, ""))) return false;
  return norm(draft) === e;
}

// Banner alert for the job's starter listing the notes, questions or tW/tA
// articles the translate apply left alone: because a person changed them after
// the job was queued (#601, #725, #734), because they were approved before a
// whole-chapter run (#794), or because the note draft was the English source
// note (#794). Same shape as recordArticleNoApplyAlert: server-side English
// text, one alert per job and reason (replaced on a retry), best-effort.
// `refs` are verse refs for tn/tq and paths for articles.
type SkipReason = "touched" | "approved" | "english";
const SKIPPED_REFS_SHOWN = 10;
async function recordSkippedAlert(
  env: Env,
  job: ImportContext,
  userId: number,
  reason: SkipReason,
  kind: TouchKind,
  refs: string[],
  linkUrl: string,
): Promise<void> {
  try {
    const u = await env.DB.prepare(`SELECT dcs_username FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ dcs_username: string }>();
    const username = u?.dcs_username;
    if (!username) return;
    const source =
      reason === "touched"
        ? `translate_${kind}_skipped_touched:${job.jobId}`
        : reason === "approved"
          ? `translate_${kind}_kept_approved:${job.jobId}`
          : `translate_${kind}_same_as_english:${job.jobId}`;
    const shown = refs.slice(0, SKIPPED_REFS_SHOWN).join(", ");
    const more = refs.length > SKIPPED_REFS_SHOWN ? ` and ${refs.length - SKIPPED_REFS_SHOWN} more` : "";
    const one = refs.length === 1;
    const noun = kind === "tn" ? "note" : "question";
    // Questions have no Not needed or Restore, so their text names only edit
    // and Approve. A single question can be re-run from the classic editor
    // (Shell.handleTranslateQuestion queues a tq job with rowIds: [id]).
    const message =
      reason === "approved"
        ? `AI translation of ${job.book}: ${one ? `1 approved ${noun} was` : `${refs.length} approved ${noun}s were`} ` +
          `kept as ${one ? "it is" : "they are"} (${job.book} ${shown}${more}). A run on a whole chapter does not redraft ` +
          `approved ${noun}s. To get a new draft for one, run the AI on that ${noun} alone.`
        : reason === "english"
          ? `AI translation of ${job.book}: the AI returned the English note unchanged for ` +
            `${one ? "1 note" : `${refs.length} notes`} (${job.book} ${shown}${more}), so ` +
            `${one ? "that draft was" : "those drafts were"} not applied and ${one ? "the note keeps its" : "the notes keep their"} ` +
            `current text. Run the AI on a note again to try for a translation.`
          : kind === "tn"
        ? `AI translation of ${job.book}: ${one ? "1 note was" : `${refs.length} notes were`} left as people changed ` +
          `${one ? "it" : "them"} (${job.book} ${shown}${more}). Someone edited, approved, marked Not needed or ` +
          `restored ${one ? "it" : "them"} while the job waited in the queue, so the AI ${one ? "draft was" : "drafts were"} ` +
          `not applied. Run the AI on a note again if you want a draft for it.`
        : kind === "tq"
          ? `AI translation of ${job.book}: ${one ? "1 question was" : `${refs.length} questions were`} left as people ` +
            `changed ${one ? "it" : "them"} (${job.book} ${shown}${more}). Someone edited or approved ` +
            `${one ? "it" : "them"} while the job waited in the queue, so the AI ${one ? "draft was" : "drafts were"} ` +
            `not applied. Run the AI on a question again if you want a draft for it.`
          : `AI translation of ${kind === "tw" ? "tW" : "tA"} articles: ${one ? "1 article was" : `${refs.length} articles were`} ` +
            `left as people changed ${one ? "it" : "them"} (${shown}${more}). Someone edited or approved ` +
            `${one ? "it" : "them"} while the job waited in the queue, so the AI ${one ? "draft was" : "drafts were"} ` +
            `not applied. Run the AI again if you want a draft for ${one ? "it" : "them"}.`;
    await env.DB.prepare(
      `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
    )
      .bind(username, source)
      .run();
    await env.DB.prepare(
      `INSERT INTO system_alerts (username, severity, source, message, link_url)
       VALUES (?1, 'info', ?2, ?3, ?4)`,
    )
      .bind(username, source, message, linkUrl)
      .run();
  } catch (e) {
    console.error(`${kind} skipped-${reason} alert failed`, { error: e instanceof Error ? e.message : String(e) });
  }
}
