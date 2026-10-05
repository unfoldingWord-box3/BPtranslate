// Step 5 of docs/translate-internal-runner.md (§D): the decision and the two
// shapes that let a translate job run on TRANSLATE_WORKFLOW instead of the Fly
// bot, without any other part of the pipeline contract moving.
//
// Everything here is pure so it runs under the node strip-types test runner:
// pipelines.ts owns the D1 writes and the Workflow `create()`; this module only
// answers "which runner", "what params", and "what status".
//
// Three invariants this file exists to hold:
//
//   1. The plaintext API key NEVER reaches Workflow params. Cloudflare persists
//      params for the life of the instance, so buildTranslateWorkflowParams
//      returns `provider` + `model` only, and every batch step re-reads
//      ai_provider_config and decrypts inside its own `step.do` (design §B).
//   2. Internal is OPT-IN and fails safe: four independent gates, any one of
//      which off means "proxy, exactly as today".
//   3. readInternalStatus synthesizes the bot's StatusResponse shape from one
//      D1 column, so everything in pollPipelineJob downstream of the status
//      read is identical for both runners.

import { resolveParams } from "./params.ts";
import { isTsvResource } from "./resourceTypes.ts";
import { parseWfStatus } from "./status.ts";
import type { TranslateWorkflowParams } from "./workflowSteps.ts";
import type { DispatchAi } from "../aiProvider.ts";

export type PipelineRunner = "proxy" | "internal";

/** Providers with an in-Worker adapter (llm.ts). Everything else stays proxied. */
export const DEFAULT_INTERNAL_PROVIDERS = ["claude"] as const;

export type RunnerEnv = {
  PIPELINE_MODE?: string;
  PIPELINE_INTERNAL_PROVIDERS?: string;
};

/**
 * Parse PIPELINE_INTERNAL_PROVIDERS. An UNSET var means the default
 * ({@link DEFAULT_INTERNAL_PROVIDERS}); a var that is set but empty means the
 * empty set — so an operator can disable the internal runner by blanking this
 * var alone, without also having to flip PIPELINE_MODE.
 */
export function internalProviders(env: RunnerEnv): Set<string> {
  const raw = env.PIPELINE_INTERNAL_PROVIDERS;
  if (raw === undefined || raw === null) return new Set<string>(DEFAULT_INTERNAL_PROVIDERS);
  return new Set(
    String(raw)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The job's resourceType as resolveParams reads it: the stored option, else the 'tn' pilot default. */
function resourceTypeOf(options: unknown): string {
  const o = options && typeof options === "object" ? (options as Record<string, unknown>) : {};
  return typeof o.resourceType === "string" && o.resourceType ? o.resourceType : "tn";
}

/**
 * Which runner this job dispatches to (design §D.1 / conclusion 6). Internal
 * requires ALL FIVE of:
 *
 *   * PIPELINE_MODE === "internal"       — the deployment opted in
 *   * pipeline_type === "translate"      — generate/notes/tqs have no in-Worker port
 *   * resolveDispatchAi → "configured"   — the org has its own usable key. Anything
 *                                          else is an error that dispatchNext fails
 *                                          before asking (#551: no shared account).
 *   * provider ∈ PIPELINE_INTERNAL_PROVIDERS
 *   * the resource is a TSV family (tn/tq)  — see the gate's own comment below
 *
 * Anything else proxies to Fly exactly as before.
 */
export function translateRunner(
  env: RunnerEnv,
  job: { pipeline_type: string },
  ai: DispatchAi,
  options?: unknown,
): PipelineRunner {
  if ((env.PIPELINE_MODE ?? "").trim().toLowerCase() !== "internal") return "proxy";
  if (job.pipeline_type !== "translate") return "proxy";
  if (ai.kind !== "configured") return "proxy";
  if (!internalProviders(env).has(ai.provider.trim().toLowerCase())) return "proxy";
  // REMOVE THIS GATE IN PHASE 2, when article (tw/tA) support lands — design §B
  // "Articles (tw/ta): same skeleton with resolve-article and article-NN steps;
  // phase 2", §A "articleResolver … Phase 2 (tw/ta)".
  //
  // Until then the internal runner has TSV steps only: guardAndSourceStep
  // throws resource_not_supported_internal for an article job
  // (workflowSteps.ts). The Fly bot translates tw/ta TODAY, so routing an
  // article job internal would convert a working capability into a failed run
  // the moment PIPELINE_MODE is flipped. Proxy it instead.
  //
  // The family comes from resourceTypes.ts rather than a name list here, so
  // phase 2 flips this in one place. An unrecognized resourceType is not a TSV
  // resource either, and proxying it lets the bot decide rather than failing an
  // instance we could not have built params for.
  if (!isTsvResource(resourceTypeOf(options))) return "proxy";
  return "internal";
}

/** Workflow instance id (design §B). Slug-scoped so two orgs' job ids can't collide. */
export function translateInstanceId(workspace: string, jobId: string): string {
  return `translate-${workspace}-${jobId}`;
}

/** The pipeline_jobs columns dispatchNext already SELECTs that params need. */
export type DispatchJobRow = {
  job_id: string;
  user_id: number;
  book: string;
  start_chapter: number;
  end_chapter: number;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Fold the stored options_json + job row into TranslateWorkflowParams.
 *
 * Defaults resolve HERE, through the same resolveParams the Workflow uses, so
 * params carry fully-resolved refs and the Workflow's own re-resolve is a no-op.
 * Three fields the editor never stores (repoName, sourceLiteralRef,
 * sourceSimplifiedRef) get exactly the bot's fallbacks.
 *
 * `contextRef` is the one field deliberately NOT round-tripped: resolveParams
 * fills a `${targetOrg}/translation-context@master` default and records
 * contextRefExplicit=false, and echoing that default back as an explicit param
 * would flip the Workflow's `loadContextPack(…, {allowEmpty: !explicit})` into
 * demanding a context repo that may not exist yet — turning a warning into a
 * hard failure. Only a caller-supplied contextRef is passed through.
 *
 * Throws (resolveParams's own errors) on an unusable job — dispatchNext turns
 * that into fail('sdk_error', …) rather than creating a doomed instance.
 */
export function buildTranslateWorkflowParams(args: {
  job: DispatchJobRow;
  options: unknown;
  workspace: string;
  provider: string;
  model: string;
}): TranslateWorkflowParams {
  const { job, workspace, provider, model } = args;
  const o = (args.options && typeof args.options === "object" ? args.options : {}) as Record<string, unknown>;

  const rowIds = Array.isArray(o.rowIds)
    ? (o.rowIds.filter((x) => typeof x === "string" && x) as string[])
    : null;

  const p = resolveParams({
    resourceType: str(o.resourceType),
    book: job.book,
    startChapter: job.start_chapter,
    endChapter: job.end_chapter,
    verseStart: num(o.verseStart),
    verseEnd: num(o.verseEnd),
    rowIds: rowIds && rowIds.length ? rowIds : null,
    articleId: str(o.articleId),
    articleUrl: str(o.articleUrl),
    targetLang: str(o.targetLang) ?? "",
    targetOrg: str(o.targetOrg),
    repoName: str(o.repoName),
    sourceRef: str(o.sourceRef),
    contextRef: str(o.contextRef),
    sourceLiteralRef: str(o.sourceLiteralRef),
    sourceSimplifiedRef: str(o.sourceSimplifiedRef),
    literalRef: str(o.literalRef),
    simplifiedRef: str(o.simplifiedRef),
    direction: o.direction === "rtl" || o.direction === "ltr" ? o.direction : null,
    jobId: job.job_id,
    provider,
    model,
  });

  return {
    jobId: job.job_id,
    workspace,
    userId: job.user_id,
    resourceType: p.resourceType,
    // Article jobs carry an editor-internal sentinel book ("TW"/"TA");
    // resolveParams nulls it for that family and the Workflow re-resolves.
    book: p.book ?? job.book,
    startChapter: p.startChapter ?? job.start_chapter,
    endChapter: p.endChapter ?? job.end_chapter,
    verseStart: p.verseStart,
    verseEnd: p.verseEnd,
    rowIds: p.rowIds ? [...p.rowIds] : null,
    articleId: p.articleId,
    articleUrl: p.articleUrl,
    targetLang: p.targetLang,
    direction: p.direction,
    sourceRef: p.sourceRef,
    contextRef: p.contextRefExplicit ? p.contextRef : null,
    literalRef: p.targetLiteralRef,
    simplifiedRef: p.targetSimplifiedRef,
    sourceLiteralRef: p.sourceLiteralRef,
    sourceSimplifiedRef: p.sourceSimplifiedRef,
    targetOrg: p.targetOrg,
    repoName: p.repoName,
    provider,
    model,
    thinking: "medium",
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Structurally the bot's StatusResponse (pipelines.ts). Declared here rather
 * than imported so this module keeps no dependency on pipelines.ts;
 * pipelines.ts assigns the result straight into its own `StatusResponse`.
 */
export type InternalStatus = {
  jobId: string;
  pipelineType: string;
  scope: { book: string; startChapter: number; endChapter: number };
  state: string;
  current?: {
    chapter: number;
    skill: string;
    status: string;
    startedAt: string;
    errorKind?: string;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  output?: Array<{
    type: string;
    repo: string;
    path: string;
    delivery?: string;
    file?: string;
  }>;
};

/** The pipeline_jobs columns readInternalStatus needs (a subset of PolledJob). */
export type InternalStatusJob = {
  job_id: string;
  pipeline_type: string;
  book: string;
  start_chapter: number;
  end_chapter: number;
  wf_status_json: string | null;
};

/**
 * Synthesize the bot-shaped status for an internal job from wf_status_json,
 * standing in for `GET /api/pipeline/:id`.
 *
 * A NULL / malformed / not-ours column reads as plain `running`: the instance
 * exists (dispatchNext only stamps runner='internal' after create() resolved)
 * but hasn't written its first status yet. That is exactly how the bot reports
 * a just-started run, so pollPipelineJob needs no new branch — it holds the row
 * at 'running' and polls again.
 *
 * `interrupted` is always false. The Workflow engine owns liveness (a dead
 * instance is retried or errored by Cloudflare), so the bot's frozen-checkpoint
 * failure mode has no analogue here and must not fire the interrupted sweep.
 */
export function readInternalStatus(job: InternalStatusJob, now: Date = new Date()): InternalStatus {
  const wf = parseWfStatus(job.wf_status_json);
  const updatedAt = wf?.updatedAt ?? now.toISOString();
  const startedAt = wf?.current?.startedAt ?? "";
  return {
    jobId: job.job_id,
    pipelineType: job.pipeline_type,
    scope: { book: job.book, startChapter: job.start_chapter, endChapter: job.end_chapter },
    state: wf?.state ?? "running",
    current: wf
      ? {
          chapter: wf.current.chapter,
          skill: wf.current.skill,
          status: wf.current.status,
          startedAt,
          ...(wf.current.errorKind ? { errorKind: wf.current.errorKind } : {}),
          ...(wf.current.error ? { error: wf.current.error } : {}),
        }
      : undefined,
    updatedAt,
    // pipeline_jobs.created_at isn't in the polled projection; the Workflow
    // event timestamp is the closest honest value, and the client falls back to
    // its own stored created_at when this doesn't parse (pipelineStore.ts:131).
    createdAt: startedAt || updatedAt,
    interrupted: false,
    ...(wf?.output
      ? {
          output: wf.output.map((e) => ({
            type: e.type,
            repo: e.repo ?? "",
            path: e.path ?? "",
            delivery: e.delivery,
            file: e.file,
          })),
        }
      : {}),
  };
}
