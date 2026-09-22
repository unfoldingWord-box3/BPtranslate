// TranslateWorkflow step bodies (docs/translate-internal-runner.md §B).
//
// Everything a `step.do` closure executes lives here, as plain async functions
// over an explicit `StepDeps` (D1 + R2 + fetch + transport), so the bodies run
// under the node strip-types test runner with a node:sqlite D1, a Map-backed
// BlobStore and a stub transport. translateWorkflow.ts is the thin
// WorkflowEntrypoint that wires these into steps with retry policy — it is the
// only file that imports `cloudflare:workers` / `cloudflare:workflows`.
//
// Contract with the rest of the app (design §B):
//   * D1 writes go through status.writeWfStatus only: current_skill,
//     current_status, updated_at, wf_status_json. Never state / output_json.
//   * Content lives in R2 under storage.ts's job prefix and step returns stay
//     small, because Cloudflare persists every one of them. The single
//     deliberate exception is batch-NN, which returns its validated output (~8-70
//     KB) so that writing it becomes a separate, freely retryable step: the
//     engine's own persistence is what stops an R2 failure from re-buying a
//     provider call. See BatchTranslateResult for the measured limits.
//   * The org's API key exists only as a local const inside batchStep. It is
//     never returned, never written, and every error leaving that scope is
//     scrubbed of it (llm.scrubSecrets).
//   * Failures carry an errorKind. Deterministic ones are `retryable: false`
//     and the Workflow turns them into NonRetryableError; provider-side
//     transients (rate_limited, provider_overloaded, timeout, network_error)
//     and plain infrastructure errors propagate as-is so the step retries.

import type { Workspace } from "../workspaces.ts";
import { resolveWorkspace, resolveWorkspaceFresh } from "../workspaces.ts";
import { shrinkRefused } from "../articleExport.ts";
import { getAiProviderConfig, resolveDispatchAi } from "../aiProvider.ts";
import { decryptApiKey } from "../aiKeyCrypto.ts";
import { resolveParams, type TranslateParams } from "./params.ts";
import {
  buildBatchArtifacts,
  buildBatches,
  buildTranslateReport,
  fetchResourceFile,
  mergeChapterIntoBook,
  renderBatchPack,
  selectRows,
  sliceChapterRows,
  tsvResource,
  updateRowsById,
  validateBatchOutput,
  type BatchMeta,
  type TsvResource,
} from "./core.ts";
import { loadContextPack, type FetchLike } from "./contextPack.ts";
import { buildScripturePack } from "./scripture.ts";
import { runChecks, type CheckResult } from "./checks.ts";
import type { TsvRow } from "./tsvCodec.ts";
import { normalizeSourceRows } from "./tsvCodec.ts";
import {
  TranslateProviderError,
  addLlmCall,
  isRetryableCode,
  newLlmUsage,
  redactSecretPatterns,
  runBatch,
  scrubSecrets,
  transportFor,
  type LlmCall,
  type Transport,
} from "./llm.ts";
import {
  batchFileNames,
  batchKeys,
  batchNn,
  getText,
  outKey,
  putText,
  reportFileName,
  type BatchKeys,
  type BlobStore,
} from "./storage.ts";
import {
  buildEditorManifest,
  doneStatus,
  failedStatus,
  runningStatus,
  writeWfStatus,
  type StatusScope,
} from "./status.ts";

// ---------------------------------------------------------------------------
// Params (persisted by Cloudflare — nothing secret, ever)
// ---------------------------------------------------------------------------

export type TranslateWorkflowParams = {
  jobId: string;
  /** REQUIRED. Workflows don't inherit the per-request env clone; this is how run() finds the org's D1. */
  workspace: string;
  userId: number;
  resourceType: string;
  book: string;
  startChapter: number;
  endChapter: number;
  verseStart?: number | null;
  verseEnd?: number | null;
  rowIds?: string[] | null;
  articleId?: string | null;
  articleUrl?: string | null;
  targetLang: string;
  direction: "ltr" | "rtl";
  sourceRef: string;
  contextRef?: string | null;
  literalRef?: string | null;
  simplifiedRef?: string | null;
  sourceLiteralRef: string;
  sourceSimplifiedRef: string;
  targetOrg: string;
  repoName: string;
  /**
   * Deliberately create the target book when it does not exist on DCS yet.
   * Absent/false, merge-report refuses to write an out/ file for a job that
   * translates only part of the book onto a 404 (see mergeReportStep) — a
   * wrongly defaulted targetOrg/repoName 404s exactly like a genuine first
   * translation, and the difference is only knowable from the caller's intent.
   */
  createIfAbsent?: boolean;
  /** Provider + model only. The key is re-read from ai_provider_config inside each batch step. */
  provider: string;
  model: string;
  thinking: "medium";
};

/** Fold the flat params into the bot's resolved shape (defaults, names, mergeMode, skill). */
export function paramsToTranslateParams(p: TranslateWorkflowParams): TranslateParams {
  return resolveParams({
    resourceType: p.resourceType,
    book: p.book,
    startChapter: p.startChapter,
    endChapter: p.endChapter,
    verseStart: p.verseStart ?? null,
    verseEnd: p.verseEnd ?? null,
    rowIds: p.rowIds ?? null,
    articleId: p.articleId ?? null,
    articleUrl: p.articleUrl ?? null,
    targetLang: p.targetLang,
    targetOrg: p.targetOrg,
    repoName: p.repoName,
    sourceRef: p.sourceRef,
    contextRef: p.contextRef ?? null,
    sourceLiteralRef: p.sourceLiteralRef,
    sourceSimplifiedRef: p.sourceSimplifiedRef,
    literalRef: p.literalRef ?? null,
    simplifiedRef: p.simplifiedRef ?? null,
    direction: p.direction,
    jobId: p.jobId,
    provider: p.provider,
    model: p.model,
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A step failure with a machine-readable kind. `retryable: false` becomes NonRetryableError. */
export class TranslateStepError extends Error {
  errorKind: string;
  retryable: boolean;
  constructor(errorKind: string, message: string, { retryable = false, cause }: { retryable?: boolean; cause?: unknown } = {}) {
    super(`[${errorKind}] ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = "TranslateStepError";
    this.errorKind = errorKind;
    this.retryable = retryable;
  }
}

export type StepFailure = { errorKind: string; message: string; retryable: boolean };

const KIND_TAG = /^\[([a-z][a-z0-9_]*)\]\s*/;

/**
 * The engine hands a step's error back to run() across an isolate boundary and
 * rebuilds it there as a plain Error whose message is `${name}: ${message}` —
 * so what run()'s catch actually sees is "NonRetryableError: [merge_failed] …",
 * not "[merge_failed] …". Measured under a real Workflows runtime
 * (translate/workflowEngine.test.mjs); without this, every failure recorded by
 * the catch-all lost its kind and was filed as a retryable internal_error.
 */
const ENGINE_NAME_PREFIX = /^[A-Za-z][A-Za-z0-9_]*(?:Error|Exception):\s*/;

/** The `[kind] ` tag, whether or not the engine prefixed the error's name. */
function kindTag(message: string): RegExpExecArray | null {
  return KIND_TAG.exec(message) ?? KIND_TAG.exec(message.replace(ENGINE_NAME_PREFIX, ""));
}

/**
 * Normalize anything a step threw. Workflows re-throws a step's final error
 * into run() after retries are exhausted, and only `message`/`name` reliably
 * survive that hop — so the kind is also carried as a `[kind] ` message prefix
 * (TranslateStepError and the NonRetryableError wrapper both write it).
 * Unknown errors default to RETRYABLE `internal_error`: a D1 or DCS hiccup
 * deserves the step's retry budget, and a deterministic bug still fails the
 * instance once that budget is spent.
 */
export function classifyStepError(err: unknown): StepFailure {
  const e = (err ?? {}) as Record<string, unknown>;
  const rawMessage = err instanceof Error ? err.message : String(err);
  if (err instanceof TranslateProviderError) {
    return { errorKind: err.code, message: redactSecretPatterns(rawMessage), retryable: err.retryable };
  }
  if (err instanceof TranslateStepError) {
    return { errorKind: err.errorKind, message: redactSecretPatterns(rawMessage.replace(KIND_TAG, "")), retryable: err.retryable };
  }
  const tagged = kindTag(rawMessage);
  if (tagged) {
    const kind = tagged[1];
    // internal_error is the untagged default's kind and IS retryable (see the
    // doc comment); a tagged one — written by retryableStepError below — must
    // classify the same way, or a re-classified retry would flip to fatal.
    const retryable = isRetryableCode(kind) || kind === "internal_error";
    return { errorKind: kind, message: redactSecretPatterns(rawMessage.replace(ENGINE_NAME_PREFIX, "").slice(tagged[0].length)), retryable };
  }
  if (typeof e.code === "string" && (isRetryableCode(e.code) || typeof e.retryable === "boolean")) {
    return { errorKind: e.code, message: redactSecretPatterns(rawMessage), retryable: e.retryable === true || isRetryableCode(e.code) };
  }
  return { errorKind: "internal_error", message: redactSecretPatterns(rawMessage), retryable: true };
}

/**
 * The error the Workflow layer rethrows for a RETRYABLE step failure
 * (translateWorkflow.guarded). Two jobs:
 *   1. Carry the `[kind] ` tag. Only the NonRetryableError path used to write
 *      it, so a rate_limited / timeout failure that exhausted its retries
 *      reached run()'s catch as a bare Error and recorded internal_error,
 *      losing the one field an operator needs.
 *   2. Hand the engine a freshly built Error. The original may be a provider
 *      object whose stack, cause chain and extra properties (transportResults,
 *      llmCalls) Cloudflare persists at rest between attempts.
 */
export function retryableStepError(failure: StepFailure): Error {
  return new Error(`[${failure.errorKind}] ${failure.message}`);
}

// ---------------------------------------------------------------------------
// Workspace re-point (design §B first line; STATE.md Workflows env-clone lesson)
// ---------------------------------------------------------------------------

/**
 * The slug a queued run must resolve before touching any binding. Missing →
 * non-retryable: dispatch always sets it, so its absence is a caller bug, not
 * something a retry can fix. Unknown → non-retryable too: resolveWorkspace()
 * answers an unknown slug with list[0] (another tenant's D1), which is exactly
 * the wrong-tenant hole this guard exists to close.
 */
export function resolveWorkflowWorkspace(env: Parameters<typeof resolveWorkspace>[0], params: { workspace?: string | null } | null | undefined): Workspace {
  const slug = params?.workspace;
  if (!slug) throw new TranslateStepError("workspace_missing", "TranslateWorkflow requires params.workspace (set from env.WORKSPACE_SLUG at dispatch)");
  const ws = resolveWorkspace(env, slug);
  if (ws.slug !== slug) throw new TranslateStepError("workspace_unknown", `params.workspace "${slug}" is not a known workspace on this deployment`);
  return ws;
}

/**
 * What run() actually calls. Same guard, minus the warm-stale false negative
 * issue #418/#419 fixed for the request path: the registry is primed ONCE per
 * isolate and never expires, so an org claimed on a sibling isolate is unknown
 * to an already-warm one — and here "unknown" is a permanent, non-retryable
 * refusal, so a legitimate new org's every run would fail until the isolate
 * recycled. Re-read the registry once (rate-limited inside
 * resolveWorkspaceFresh) before refusing. A genuinely unknown slug still
 * refuses, which is the cross-tenant guard itself: resolveWorkspace answers it
 * with list[0], another tenant's D1.
 */
export async function resolveWorkflowWorkspaceFresh(
  env: Parameters<typeof resolveWorkspaceFresh>[0],
  params: { workspace?: string | null } | null | undefined,
): Promise<Workspace> {
  try {
    return resolveWorkflowWorkspace(env, params);
  } catch (err) {
    if (!(err instanceof TranslateStepError) || err.errorKind !== "workspace_unknown") throw err;
    await resolveWorkspaceFresh(env, params!.workspace!); // re-primes the isolate's registry
    return resolveWorkflowWorkspace(env, params); // rethrows workspace_unknown if still absent
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** The D1 subset the steps use (D1Database satisfies it; tests pass a node:sqlite adapter). */
export interface StepStmt {
  bind(...values: unknown[]): StepStmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface StepDb {
  prepare(sql: string): StepStmt;
}

export type StepDeps = {
  db: StepDb;
  blobs: BlobStore;
  /** The RESOLVED workspace slug (env.WORKSPACE_SLUG after re-point); prefixes every R2 key. */
  workspaceSlug: string;
  /** env.AI_KEY_WRAPPING_KEY — needed to decrypt the org's stored key. */
  wrappingKey: string | undefined;
  /** ISO timestamp of the Workflow event; surfaces as current.startedAt. */
  startedAt: string;
  /** Injected for tests; default = global fetch (DCS raw endpoints). */
  fetchImpl?: FetchLike;
  /** Injected for tests; default = the provider's in-Worker adapter. */
  transport?: Transport;
  now?: () => Date;
};

const LIVE_STATES = new Set(["running", "dispatching"]);

function scopeOf(p: TranslateParams, deps: StepDeps, chapter: number): StatusScope {
  return { chapter, skill: p.skill, startedAt: deps.startedAt };
}

async function progress(deps: StepDeps, jobId: string, p: TranslateParams, text: string): Promise<void> {
  await writeWfStatus(deps.db, jobId, runningStatus(scopeOf(p, deps, p.startChapter ?? 0), text, deps.now?.() ?? new Date()));
}

/**
 * Cooperative cancel (design §B): the cancel route only touches queued rows,
 * so a running job learns it was cancelled — or failed by the stale-dispatch
 * sweep — by re-reading its own row here, at step 1 and at the top of every
 * batch step. Missing row and non-live states are all non-retryable.
 */
export async function assertJobLive(deps: StepDeps, jobId: string): Promise<void> {
  const row = await deps.db.prepare(`SELECT state FROM pipeline_jobs WHERE job_id = ?1`).bind(jobId).first<{ state: string }>();
  if (!row) throw new TranslateStepError("job_missing", `pipeline_jobs row ${jobId} no longer exists`);
  if (row.state === "cancelled") throw new TranslateStepError("cancelled", `job ${jobId} was cancelled`);
  if (!LIVE_STATES.has(row.state)) throw new TranslateStepError("job_not_running", `job ${jobId} is '${row.state}', not running`);
}

async function readBatches(deps: StepDeps, jobId: string, batchCount: number, resource: TsvResource): Promise<TsvRow[][]> {
  const out: TsvRow[][] = [];
  for (let i = 0; i < batchCount; i++) {
    const nn = batchNn(i);
    const text = await getText(deps.blobs, batchKeys(deps.workspaceSlug, jobId, nn).source);
    if (text == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}.tsv is missing from R2 (guard-and-source did not persist it)`);
    out.push(resource.codec.parse(text));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 1: guard-and-source
// ---------------------------------------------------------------------------

export type GuardAndSourceResult = {
  batchCount: number;
  rowCount: number;
  /**
   * Every row of the source book was selected, so the merge can create an
   * absent target file without leaving a partial book behind (merge-report's
   * base guard).
   */
  coversWholeBook: boolean;
};

export async function guardAndSourceStep(deps: StepDeps, params: TranslateWorkflowParams): Promise<GuardAndSourceResult> {
  await assertJobLive(deps, params.jobId);
  const p = paramsToTranslateParams(params);
  if (p.family !== "tsv") {
    throw new TranslateStepError("resource_not_supported_internal", `${p.resourceType} (articles) is not yet supported by the internal runner`);
  }
  const resource = tsvResource(p.resourceType);
  const book = p.book!;

  const sourceText = await fetchResourceFile(p.sourceRef, resource.file(book), { fetchImpl: deps.fetchImpl });
  if (!sourceText) throw new TranslateStepError("source_not_found", `source not found: ${p.sourceRef} ${resource.file(book)}`);
  // Normalize BEFORE slicing and batching: buildBatches writes the source
  // snapshot to R2 and every later step (context, batch prompt, runChecks)
  // reads it back, so normalizing here is what keeps prompt and checks on one
  // value. See normalizeSourceRows (#472).
  const allRows = normalizeSourceRows(resource.codec.parse(sourceText));
  let rows = sliceChapterRows(allRows, p.startChapter!, p.endChapter!);
  rows = selectRows(rows, { rowIds: p.rowIds, verseStart: p.verseStart, verseEnd: p.verseEnd });
  if (!rows.length) {
    const sel = p.rowIds ? `rowIds ${p.rowIds.join(",")}`
      : p.verseStart != null ? `${p.startChapter}:${p.verseStart}${p.verseEnd !== p.verseStart ? `-${p.verseEnd}` : ""}`
        : `${p.startChapter}-${p.endChapter}`;
    throw new TranslateStepError("no_source_rows", `no source rows for ${book} ${sel}`);
  }

  const batches = buildBatches(rows, { sizeOf: resource.sizeOf });
  for (let i = 0; i < batches.length; i++) {
    await putText(deps.blobs, batchKeys(deps.workspaceSlug, params.jobId, batchNn(i)).source, resource.codec.serialize(batches[i]));
  }
  await progress(deps, params.jobId, p,
    `source: ${rows.length} row(s) from ${p.sourceRef}${p.mergeMode === "by-id" ? " (by-id subset)" : ""} — ${batches.length} batch(es)`);
  return { batchCount: batches.length, rowCount: rows.length, coversWholeBook: rows.length === allRows.length };
}

// ---------------------------------------------------------------------------
// Step 2: context
// ---------------------------------------------------------------------------

export type PerBatchContext = { slugs: string[]; templateFallbacks: string[] };
export type ContextResult = { contextSha: string | null; hasContent: boolean; perBatch: PerBatchContext[] };

export async function contextStep(deps: StepDeps, params: TranslateWorkflowParams, batchCount: number): Promise<ContextResult> {
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const book = p.book!;
  const batches = await readBatches(deps, params.jobId, batchCount, resource);
  const rows = batches.flat();

  const pack = await loadContextPack(p.contextRef, { allowEmpty: !p.contextRefExplicit, fetchImpl: deps.fetchImpl });

  // A missing target Bible is a 404 and comes back from buildScripturePack as
  // "absent" — still never fatal (translate-pipeline.js:411-424). But a
  // TRANSPORT failure is not absence: the old blanket catch turned one DCS
  // hiccup into a permanently persisted context-free pack that every batch of
  // the run is then billed against. Let the step's retry budget handle it.
  let scripture = null;
  try {
    scripture = await buildScripturePack({
      book, rows: rows as (TsvRow & { Reference: string })[],
      sourceLiteralRef: p.sourceLiteralRef,
      sourceSimplifiedRef: p.sourceSimplifiedRef,
      targetLiteralRef: p.targetLiteralRef,
      targetSimplifiedRef: p.targetSimplifiedRef,
    }, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    throw new TranslateStepError("scripture_fetch_failed", err instanceof Error ? err.message : String(err), { retryable: true, cause: err });
  }

  const perBatch: PerBatchContext[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batchRows = batches[i];
    const rendered = renderBatchPack({
      batchRows, pack, scripture,
      targetLang: p.targetLang, targetLangName: p.targetLangName, direction: p.direction, sourceLangName: p.sourceLangName,
    });
    const art = buildBatchArtifacts(i, {
      batchRows, packMarkdown: rendered.markdown,
      targetLang: p.targetLang, targetLangName: p.targetLangName, sourceLangName: p.sourceLangName,
      direction: p.direction, book, resource,
    });
    const keys = batchKeys(deps.workspaceSlug, params.jobId, art.nn);
    await putText(deps.blobs, keys.pack, art.packMarkdown);
    await putText(deps.blobs, keys.task, art.taskJson);
    perBatch.push({ slugs: rendered.slugs, templateFallbacks: rendered.templateFallbacks });
  }

  await progress(deps, params.jobId, p, pack.hasContent
    ? `context pack: ${p.contextRef}${pack.sha ? ` @ ${pack.sha.slice(0, 10)}` : ""} — ${pack.templates.size} templates, ${pack.terms.length} terms, ${pack.examples.length} examples`
    : `WARNING: no context pack at ${p.contextRef} — translating as a RAW BASELINE`);
  return { contextSha: pack.sha, hasContent: pack.hasContent, perBatch };
}

// ---------------------------------------------------------------------------
// Step 3: batch-NN
// ---------------------------------------------------------------------------

export type BatchStepResult = {
  nn: string;
  rowCount: number;
  /** Draft/repair passes (0 when a validated output was reused from R2). */
  attempts: number;
  /** Billed provider calls for this batch, an earlier attempt's resumed draft included (0 on reuse). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  reused: boolean;
};

/**
 * What `batch-NN` returns: the accounting above, plus the provider output the
 * following `batch-NN-persist` step writes to R2.
 *
 * The output rides in the step return ON PURPOSE. Cloudflare persists a step's
 * return value before the next step runs, so once `batch-NN` commits, the
 * thing the org paid for is durable in the engine's own storage — and the R2
 * write that follows becomes freely retryable, because its retry replays that
 * stored value instead of re-buying the batch. The previous shape did the write
 * inside the paying step, where the only way to keep a failed write from
 * charging twice was to fail the whole batch non-retryably.
 *
 * Size: one batch output is ~8-70 KB, against a documented ceiling of 1 MiB for
 * a non-stream step result and 100 MB (Free) / 1 GB (Paid) of persisted state
 * per instance (Cloudflare Workflows "Limits": "Maximum non-stream step result
 * per step", "Maximum state that can be persisted per Workflow instance"). A
 * 22-batch run persists ~1.5 MB. Nothing else grows with the run, and the
 * decrypted key is still never part of it.
 *
 * "~8-70 KB" is what the recorded runs measure, not a bound anything enforces:
 * batches are bounded by rows and source characters, and an output that expands
 * far beyond its input still passes every deterministic check. So the ceiling
 * is enforced, not assumed — see withinStepReturnLimit.
 */
export type BatchTranslateResult = BatchStepResult & {
  /**
   * The validated batch output, for `batch-NN-persist` to write. Null means
   * "already in R2, write nothing": either it was there from an earlier
   * instance, or this step wrote it itself because returning it would have
   * blown the engine's step-result ceiling (withinStepReturnLimit). Either way
   * re-writing it would be the one way to corrupt a good artifact.
   */
  outputText: string | null;
};

// A provider call is money, and everything between the provider's reply and a
// durable write is a window in which a step retry re-buys it. The validated
// output closes that window through the step return above. These constants
// bound what is left: the mid-loop put of a FAILED draft, which cannot be its
// own step because the batch step is still running when it happens.
const BILLED_PUT_ATTEMPTS = 3;
const BILLED_PUT_BASE_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Persist something the org has ALREADY been billed for, mid-step. Retries the
 * put in-step (R2 hiccups are transient and cost nothing to re-try) and, if it
 * still will not land, throws `output_persist_failed`. Whether that throw is
 * fatal is the caller's call: `withinStepReturnLimit` lets it fail the step —
 * an oversized return cannot be made durable at all, so a retry would re-buy the
 * batch — while `persistDraft` catches it, because since #460 the draft is only
 * a resume shortcut (see there).
 */
async function persistBilled(deps: StepDeps, key: string, text: string, what: string): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= BILLED_PUT_ATTEMPTS; attempt++) {
    try {
      await putText(deps.blobs, key, text);
      return;
    } catch (err) {
      last = err;
      if (attempt < BILLED_PUT_ATTEMPTS) await sleep(BILLED_PUT_BASE_DELAY_MS * attempt);
    }
  }
  throw new TranslateStepError(
    "output_persist_failed",
    `could not persist ${what} to R2 after ${BILLED_PUT_ATTEMPTS} attempts (${last instanceof Error ? last.message : String(last)}) `
    + `— failing without a retry so the provider call already paid for is not bought again`,
    { retryable: false },
  );
}

/**
 * A billed-but-invalid draft and the calls that bought it, as ONE R2 object.
 *
 * The text and its price used to be two keys, the price written first and
 * best-effort. That is a split brain: lose the sidecar and the draft still
 * gates a resume, which then re-enters at the repair pass and reports that call
 * alone — under-billing a draft the org had already been charged for. R2 is
 * atomic per object and atomic across none, so the fix is to stop having two.
 */
type StoredDraft = { output: string; calls: LlmCall[] };

/**
 * Store the billed-but-invalid draft before the repair call — text and ledger
 * together, under persistBilled's in-step retries.
 *
 * Non-fatal (issue #462). Before #460 the batch output was written inside this
 * same paying step, so a failed draft put had to fail the batch: a step retry
 * would have re-bought the model call. #460 moved the validated output into its
 * own retryable `batch-NN-persist` step, and this draft put now happens mid-loop
 * with the repair call about to run in THIS attempt regardless. So a refused
 * draft put no longer risks re-buying anything — it only forfeits the resume
 * shortcut a future retry could have taken (`readDraft` then returns null and
 * the batch re-drafts). Log and continue to the repair call rather than throwing
 * away a completable batch — and the draft it already paid for — to dodge a cost
 * that is no longer incurred. The in-step retries still run inside persistBilled.
 */
async function persistDraft(deps: StepDeps, keys: BatchKeys, nn: string, output: string, calls: readonly LlmCall[]): Promise<void> {
  const stored: StoredDraft = { output, calls: [...calls] };
  try {
    await persistBilled(deps, keys.draft, JSON.stringify(stored), `work/batch-${nn}-draft.json`);
  } catch (err) {
    console.warn("translate batch: could not persist billed draft; continuing to the repair call (a later retry will re-draft)", {
      nn, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read back a stored draft. Anything unreadable degrades to "no draft" — the
 * batch then re-translates, which costs money but cannot corrupt the bill;
 * a draft that IS readable always carries its own ledger, because the writer
 * put both in the same object.
 */
async function readDraft(deps: StepDeps, keys: BatchKeys): Promise<StoredDraft | null> {
  try {
    const json = await getText(deps.blobs, keys.draft);
    if (json == null) return null;
    const parsed = JSON.parse(json) as Partial<StoredDraft>;
    if (typeof parsed?.output !== "string" || parsed.output === "") return null;
    return { output: parsed.output, calls: Array.isArray(parsed.calls) ? parsed.calls : [] };
  } catch {
    return null;
  }
}

/** Sum a call ledger into the shape BatchStepResult reports (and buildTranslateReport bills from). */
function totals(calls: readonly LlmCall[]): { inputTokens: number; outputTokens: number; costUsd: number | null } {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  for (const c of calls) {
    inputTokens += c.usage?.inputTokens || 0;
    outputTokens += c.usage?.outputTokens || 0;
    if (c.costUsd != null) costUsd = (costUsd ?? 0) + c.costUsd;
  }
  return { inputTokens, outputTokens, costUsd };
}

/**
 * REBUILD — never mutate — the error leaving the decrypted key's scope.
 *
 * Scrubbing `e.message` in place is not enough: V8 materializes `.stack` at
 * construction, so an error whose message embedded the key still carries it in
 * `.stack`, and the Workflow engine persists the thrown object between
 * attempts. A TranslateProviderError also carries `transportResults` (raw
 * provider request/response records) and `llmCalls` on non-message properties.
 * So: classify the original, then throw a freshly built error with a scrubbed
 * message, no cause chain and no extra properties — nothing but strings,
 * numbers and booleans we put there ourselves.
 *
 * An error that is NOT a TranslateProviderError came out of the LLM path
 * unclassified — i.e. a bug in our own adapter code, possibly AFTER the model
 * answered and the org was billed. Retrying that buys two more billed calls for
 * the same crash, so it is non-retryable.
 */
export function sanitizeBatchError(err: unknown, apiKey: string): Error {
  const scrub = (s: string) => scrubSecrets(s, [apiKey]);
  if (err instanceof TranslateProviderError) {
    return new TranslateProviderError(err.code, err.provider, scrub(err.message), {
      status: err.status ?? null,
      retryAfterSeconds: err.retryAfterSeconds ?? null,
    });
  }
  if (err instanceof TranslateStepError) {
    return new TranslateStepError(err.errorKind, scrub(err.message.replace(KIND_TAG, "")), { retryable: err.retryable });
  }
  return new TranslateStepError("internal_error_after_call", scrub(err instanceof Error ? err.message : String(err)), { retryable: false });
}

/**
 * Cloudflare caps a non-stream step result at 1 MiB (Workflows "Limits":
 * "Maximum non-stream step result per step"). Over that the return fails to
 * persist, the engine retries the step — and the retry buys the batch again.
 * Returning the output is what makes the persist step cheap to retry, so the
 * ceiling has to be enforced here rather than hoped past.
 *
 * 768 KiB, against a 1 MiB cap: 256 KiB (25%) of headroom, because the number
 * measured below is a PROXY. What is measured is our own JSON encoding of the
 * return value; what the engine stores is its own encoding of that value plus
 * whatever envelope it wraps around it, and the two are not byte-identical.
 * Nothing legitimate comes near either number — a real batch output is 8-70 KB,
 * so 768 KiB is still an order of magnitude above the largest one observed, and
 * this path exists for the pathological case, not the ordinary one.
 */
const MAX_STEP_RETURN_BYTES = 768 * 1024;

/**
 * Keep `batch-NN`'s return under the engine's ceiling.
 *
 * Under it: return the output and let `batch-NN-persist` write it — the normal
 * path, where a failed write is freely retryable off the persisted return.
 *
 * At or over it: write the output HERE instead, inside the paying step, with
 * persistBilled's in-step retries, and hand back `outputText: null` so the
 * persist step no-ops. That is the pre-split behaviour, and it is strictly
 * better than the alternative for this case: an oversized return cannot be made
 * durable at all, so a retry off it would re-buy the batch, whereas a write
 * that will not land fails the step non-retryably and buys nothing.
 *
 * Bounding the batch's INPUT is not the same guarantee. Batches are bounded by
 * rows and source characters, and the deterministic checks tolerate arbitrary
 * whitespace and length growth in a translated column — an output an order of
 * magnitude larger than its input passes every check we run.
 */
async function withinStepReturnLimit(deps: StepDeps, keys: BatchKeys, nn: string, result: BatchTranslateResult): Promise<BatchTranslateResult> {
  if (result.outputText == null) return result;
  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  if (bytes <= MAX_STEP_RETURN_BYTES) return result;
  console.warn("translate batch: output too large to return from the step; persisting it in the paying step instead", {
    nn, bytes, limit: MAX_STEP_RETURN_BYTES,
  });
  await persistBilled(deps, keys.output, result.outputText, `work/batch-${nn}-out.tsv`);
  return { ...result, outputText: null };
}

/**
 * Step 3a `batch-NN` — the step that spends the org's money, and the ONLY one
 * that sees the decrypted key. It returns the validated output rather than
 * writing it, so the write can be retried without re-buying the batch; see
 * BatchTranslateResult. The key is a local const here: it is never returned,
 * and every error leaving this scope is rebuilt scrubbed (sanitizeBatchError).
 */
export async function batchTranslateStep(deps: StepDeps, params: TranslateWorkflowParams, index: number, batchCount: number): Promise<BatchTranslateResult> {
  const nn = batchNn(index);
  const total = String(batchCount).padStart(2, "0");
  await assertJobLive(deps, params.jobId);
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const keys = batchKeys(deps.workspaceSlug, params.jobId, nn);

  const sourceTsv = await getText(deps.blobs, keys.source);
  if (sourceTsv == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}.tsv is missing from R2`);
  const batchRows = resource.codec.parse(sourceTsv);

  // Idempotency (translate-pipeline.js:449-454): a retried step — or a
  // re-created instance — must not pay for a batch that already validated.
  const existing = await getText(deps.blobs, keys.output);
  if (existing != null) {
    try {
      const prev = validateBatchOutput(existing, batchRows, { parse: resource.codec.parse, checkOpts: resource.checkOpts });
      if (prev.checks.ok) {
        await progress(deps, params.jobId, p, `batch ${nn}/${total} reused from previous attempt (checks ok)`);
        return { nn, rowCount: batchRows.length, attempts: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, reused: true, outputText: null };
      }
    } catch {
      /* unparseable leftover — retranslate */
    }
  }

  const packMarkdown = await getText(deps.blobs, keys.pack);
  const taskJson = await getText(deps.blobs, keys.task);
  if (packMarkdown == null || taskJson == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}-pack.md or -task.json is missing from R2`);
  const stored = await readDraft(deps, keys);

  // Key handling (design §B): re-read the org's config, decrypt here, keep the
  // plaintext in this scope only. The provider must still be the one dispatch
  // pinned in params — an admin switching providers mid-run must fail the job,
  // not bill a different vendor with a key meant for another.
  const row = await getAiProviderConfig(deps.db as unknown as D1Database);
  const ai = resolveDispatchAi(row, deps.wrappingKey);
  if (ai.kind !== "configured") {
    throw new TranslateStepError("ai_provider_unavailable", ai.kind === "error" ? ai.reason : "no BYO provider configured for this workspace");
  }
  if (ai.provider !== params.provider) {
    throw new TranslateStepError("ai_provider_changed", `ai_provider_config now names '${ai.provider}' but this job was dispatched for '${params.provider}'`);
  }
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(deps.wrappingKey!, ai.ciphertext, ai.iv);
  } catch {
    throw new TranslateStepError("ai_provider_key_decrypt_failed", "stored provider key could not be decrypted (wrapping key rotated?)");
  }

  // Second idempotency tier: a draft this job already PAID for on an earlier
  // step attempt, stored by the onFailedDraft hook below because its checks
  // failed. Resuming from it turns this attempt into the repair pass, so a
  // transient failure that landed after a billed draft costs one call, not two.
  //
  // Its billed calls come back with it, in the same object (StoredDraft). They
  // are the org's real spend on this batch; dropping them made a resumed batch
  // report only the repair call, so the run's translate report under-billed a
  // draft the org had already paid for.
  let resume: { output: string; checks: CheckResult; calls: LlmCall[] } | null = null;
  if (stored != null) {
    try {
      const prev = validateBatchOutput(stored.output, batchRows, { parse: resource.codec.parse, checkOpts: resource.checkOpts });
      if (prev.checks.ok) {
        // Only stored when its checks failed, so this means the checks changed
        // under us. Promote it rather than re-buying an output that now passes.
        await progress(deps, params.jobId, p, `batch ${nn}/${total} reused a stored draft (checks ok)`);
        return await withinStepReturnLimit(deps, keys, nn, {
          nn, rowCount: batchRows.length, attempts: 0, calls: stored.calls.length, ...totals(stored.calls), reused: true, outputText: stored.output,
        });
      }
      resume = { output: stored.output, checks: prev.checks, calls: stored.calls };
    } catch {
      /* unparseable leftover — retranslate */
    }
  }

  let result;
  try {
    const transport = deps.transport ?? transportFor(params.provider);
    result = await runBatch(
      { provider: params.provider, model: params.model, apiKey, thinking: p.thinking, transport },
      { nn, names: batchFileNames(nn), sourceTsv, packMarkdown, taskJson, batchRows },
      {
        resource,
        skill: p.skill,
        resume,
        onFailedDraft: (output, _checks, calls) => persistDraft(deps, keys, nn, output, calls),
      },
    );
  } catch (err) {
    throw sanitizeBatchError(err, apiKey);
  }

  await progress(deps, params.jobId, p, `batch ${nn}/${total} done (${batchRows.length} rows, ${result.attempts} attempt(s))`);
  return await withinStepReturnLimit(deps, keys, nn, {
    nn, rowCount: batchRows.length, attempts: result.attempts, calls: result.calls,
    ...totals(result.llmCalls), reused: false, outputText: result.outputText,
  });
}

/**
 * Step 3b `batch-NN-persist` — write what `batch-NN` bought, and nothing else.
 *
 * Freely retryable, which is the whole point of the split: the engine replays
 * `batch-NN`'s persisted return on every attempt, so an R2 refusal here costs
 * retries, not another provider call. No cancel re-check either — the output is
 * already paid for, and step 3a of the NEXT batch is where a cancel takes
 * effect.
 *
 * The window that stays open is the one no arrangement of steps can close: an
 * isolate dying after the provider's reply arrives and before `batch-NN`'s
 * return is committed. Nothing durable exists yet at that instant, so the retry
 * pays again.
 */
export async function batchPersistStep(deps: StepDeps, params: TranslateWorkflowParams, translated: BatchTranslateResult): Promise<BatchStepResult> {
  const { outputText, ...result } = translated;
  if (outputText != null) {
    await putText(deps.blobs, batchKeys(deps.workspaceSlug, params.jobId, translated.nn).output, outputText);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step 4: merge-report
// ---------------------------------------------------------------------------

export type MergeReportResult = {
  rowCount: number;
  bookFile: string;
  reportFile: string;
  warningCount: number;
  calls: number;
  costUsd: number | null;
};

export async function mergeReportStep(
  deps: StepDeps,
  params: TranslateWorkflowParams,
  source: GuardAndSourceResult,
  context: ContextResult,
  batchResults: readonly BatchStepResult[],
): Promise<MergeReportResult> {
  // Cancel re-check, as at step 1 and every batch step: a job cancelled during
  // the last batch must not still write out/ and a done manifest.
  await assertJobLive(deps, params.jobId);
  const batchCount = source.batchCount;
  const p = paramsToTranslateParams(params);
  const resource = tsvResource(p.resourceType);
  const book = p.book!;
  const batches = await readBatches(deps, params.jobId, batchCount, resource);
  const sourceRows = batches.flat();

  const targetRows: TsvRow[] = [];
  for (let i = 0; i < batchCount; i++) {
    const nn = batchNn(i);
    const outText = await getText(deps.blobs, batchKeys(deps.workspaceSlug, params.jobId, nn).output);
    if (outText == null) throw new TranslateStepError("artifact_missing", `work/batch-${nn}-out.tsv is missing from R2`);
    targetRows.push(...validateBatchOutput(outText, batches[i], { parse: resource.codec.parse, checkOpts: resource.checkOpts }).rows);
  }

  // Whole-range validation (translate-pipeline.js:468-472).
  const checks = runChecks(sourceRows, targetRows, resource.checkOpts);
  if (!checks.ok) {
    const summary = checks.errors.slice(0, 5).map((e) => `[${e.check}] ${e.rowId}: ${e.message}`).join("; ");
    throw new TranslateStepError("checks_failed", `whole-range deterministic checks failed: ${summary}`);
  }

  // Merge into the whole-book target file (:477-486).
  //
  // Merge-base guards, modelled on exportWorkflow's masterFetchGate + shrink
  // guard (STATE.md records the real incident: a stale/partial base silently
  // reverted published work). fetchResourceFile returns null ONLY on a clean
  // 404 and now rejects a short read, so an absent base really means "no such
  // file" — but a wrongly defaulted targetOrg/repoName (params.ts targetOrg =
  // `${lang}_gl`, repoName = `${lang}_${type}`) 404s identically, and merging a
  // chapter range onto nothing writes an out/ file holding ONLY that range,
  // which step 5 then imports as the whole book.
  const targetRepoRef = `${p.targetOrg}/${p.repoName}@master`;
  const existingBookText = await fetchResourceFile(targetRepoRef, resource.file(book), { fetchImpl: deps.fetchImpl });
  if (existingBookText == null && p.mergeMode === "range" && !(params.createIfAbsent === true || source.coversWholeBook)) {
    // by-id is excluded: updateRowsById refuses an absent base itself, with a
    // message about the rows it cannot find.
    throw new TranslateStepError("target_book_absent",
      `${targetRepoRef} has no ${resource.file(book)}, and this job translated ${source.rowCount} of the book's rows `
      + `(${p.startChapter}-${p.endChapter}) — refusing to publish a partial book. Check targetOrg/repoName, `
      + `or set createIfAbsent to bootstrap the file deliberately.`);
  }
  let bookText: string;
  try {
    bookText = p.mergeMode === "by-id"
      ? updateRowsById(existingBookText, targetRows, { parse: resource.codec.parse, serialize: resource.codec.serialize })
      : mergeChapterIntoBook(existingBookText, targetRows, {
        startChapter: p.startChapter!, endChapter: p.endChapter!, parse: resource.codec.parse, serialize: resource.codec.serialize,
      });
  } catch (err) {
    throw new TranslateStepError("merge_failed", err instanceof Error ? err.message : String(err));
  }

  // Shrink guard (export.ts exportTsvShrinkRefused's shared policy, same
  // numbers): the merge replaces the translated range wholesale, so a base that
  // holds far more rows in that range than this run produced — a truncated
  // source fetch, a stale selection, a by-hand row set — would silently delete
  // them from the published book. Rows, not bytes, are the unit: a translation
  // legitimately differs in byte length from its source script.
  if (existingBookText != null) {
    const baseRows = resource.codec.parse(existingBookText).length;
    const mergedRows = resource.codec.parse(bookText).length;
    if (shrinkRefused(mergedRows, baseRows)) {
      throw new TranslateStepError("merge_shrink_refused",
        `merging ${targetRows.length} translated row(s) into ${targetRepoRef} ${resource.file(book)} would leave `
        + `${mergedRows} rows where the fetched base has ${baseRows} — refusing (truncated base or wrong selection).`);
    }
  }

  const llm = newLlmUsage(params.provider, params.model);
  const batchMeta: BatchMeta[] = [];
  for (let i = 0; i < batchCount; i++) {
    const r = batchResults[i];
    const c = context.perBatch[i] ?? { slugs: [], templateFallbacks: [] };
    batchMeta.push({ nn: batchNn(i), rowCount: r?.rowCount ?? batches[i].length, attempts: r?.attempts ?? 0, templateFallbacks: c.templateFallbacks, slugs: c.slugs });
    if (r && r.calls > 0) {
      // One synthetic call per batch carrying the step's summed usage.
      addLlmCall(llm, { usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens }, costUsd: r.costUsd, model: params.model });
      llm.calls += r.calls - 1;
    }
  }

  const report = buildTranslateReport({
    resourceType: p.resourceType,
    book, startChapter: p.startChapter, endChapter: p.endChapter,
    targetLang: p.targetLang, sourceLang: p.sourceLang,
    sourceRef: p.sourceRef, contextRef: p.contextRef, contextSha: context.contextSha,
    targetOrg: p.targetOrg, targetRepo: p.repoName,
    jobId: params.jobId,
    batches: batchMeta, checks, llm,
    selection: { mergeMode: p.mergeMode, verseStart: p.verseStart ?? null, verseEnd: p.verseEnd ?? null, rowIds: p.rowIds ?? null },
    generatedAt: (deps.now?.() ?? new Date()).toISOString(),
    generatedBy: "bible-editor/translate",
  });

  const bookFile = resource.file(book);
  const reportFile = reportFileName(p.startChapter!, p.endChapter!);
  await putText(deps.blobs, outKey(deps.workspaceSlug, params.jobId, bookFile), bookText);
  await putText(deps.blobs, outKey(deps.workspaceSlug, params.jobId, reportFile), JSON.stringify(report, null, 2));

  const manifest = buildEditorManifest({ resourceType: p.resourceType, targetOrg: p.targetOrg, repoName: p.repoName, bookFile, reportFile });
  await writeWfStatus(deps.db, params.jobId, doneStatus(scopeOf(p, deps, p.endChapter!), manifest, deps.now?.() ?? new Date()));

  return { rowCount: targetRows.length, bookFile, reportFile, warningCount: checks.warnings.length, calls: llm.calls, costUsd: llm.estimatedCostUsd };
}

// ---------------------------------------------------------------------------
// Catch-all: record-failure
// ---------------------------------------------------------------------------

/**
 * Write the failed status. Best-effort by contract (like exportWorkflow's
 * record-fail): never throws, so the original error stays the one the
 * instance reports. The message is pattern-scrubbed again here; the literal
 * batch key was already removed at the batchStep boundary.
 */
export async function recordFailure(deps: StepDeps, params: TranslateWorkflowParams, err: unknown): Promise<StepFailure> {
  const failure = classifyStepError(err);
  try {
    const p = paramsToTranslateParams(params);
    await writeWfStatus(deps.db, params.jobId, failedStatus(scopeOf(p, deps, p.startChapter ?? 0), failure.errorKind, failure.message, deps.now?.() ?? new Date()));
  } catch (e) {
    console.error("translate record-failure: could not write wf_status_json", { jobId: params.jobId, error: e instanceof Error ? e.message : String(e) });
  }
  return failure;
}
