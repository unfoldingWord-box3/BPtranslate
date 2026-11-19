// Internal translate runner — Cloudflare Workflow (docs/translate-internal-runner.md §B).
//
// Runs the bp-assistant `translate` pipeline inside this Worker for orgs that
// bring their own provider key. One instance per pipeline_jobs row
// (`translate-${workspace}-${jobId}`); one durable step per batch so a
// provider hiccup retries that batch instead of restarting the run.
//
// Step list (retry policy in brackets):
//   1. guard-and-source   [3 × 5s exp]   cancel check → fetch source TSV → slice/select
//                                        → buildBatches → R2 work/batch-NN.tsv
//   2. context            [3 × 5s exp]   context pack + scripture → R2 batch-NN-pack.md/-task.json
//   3. batch-NN × N       [2 × 30s exp,   cancel check → R2 output-reuse → decrypt key (step-local)
//                          25 min timeout] → draft+repair (llm.runBatch) → RETURN the output
//      batch-NN-persist × N [3 × 5s exp]   → R2 batch-NN-out.tsv, replaying the step above's
//                                           persisted return, so its retry costs no provider call
//   4. merge-report       [3 × 5s exp]   whole-range checks → merge into target book →
//                                        R2 out/<file> + out/translate-report → wf_status done
//   5. record-failure     (catch-all)    wf_status failed {errorKind, error}, scrubbed
//
// The bodies live in translate/workflowSteps.ts so they are unit-testable
// without a Workflows runtime; this file only maps them onto step.do and
// decides retryable vs NonRetryableError.
//
// D1 contract: this Workflow writes ONLY current_skill / current_status /
// updated_at / wf_status_json (status.writeWfStatus). State transitions and
// output_json stay owned by pipelines.ts pollPipelineJob.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./index";
import { workspaceEnv, primeWorkspaces } from "./workspaces.ts";
import {
  batchPersistStep,
  batchTranslateStep,
  classifyStepError,
  contextStep,
  guardAndSourceStep,
  mergeReportStep,
  recordFailure,
  resolveWorkflowWorkspaceFresh,
  retryableStepError,
  type BatchStepResult,
  type StepDeps,
  type TranslateWorkflowParams,
} from "./translate/workflowSteps.ts";
import { batchNn } from "./translate/storage.ts";

export type { TranslateWorkflowParams } from "./translate/workflowSteps.ts";

// Infra steps (DCS fetches, R2 puts, D1 reads): same policy as ExportWorkflow.
const INFRA_RETRY = { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } } as const;
// LLM steps (design §B step 3): two retries, 30s → 60s, and a 25-minute cap
// per attempt — llm.callProvider already bounds a single completion at 10 min
// and the draft+repair loop makes at most 2 completions (plus a low-effort
// truncation retry).
const BATCH_RETRY = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "25 minutes" } as const;

/**
 * Run a step body, converting deterministic failures into NonRetryableError so
 * the engine fails the instance instead of spending the retry budget (and, for
 * batch steps, more of the org's money) on a request that cannot succeed. The
 * `[kind] ` prefix survives the engine's rethrow into run() so record-failure
 * can still name the kind (workflowSteps.classifyStepError) — it is written on
 * BOTH paths, because a rate_limited failure that exhausts its retries needs
 * its kind recorded just as much as a deterministic one does.
 *
 * NO second constructor argument to NonRetryableError. Its runtime class is
 * `constructor(message, name = "NonRetryableError") { super(message); this.name = name; }`
 * and the Workflows engine decides fatality with
 * `err.name === "NonRetryableError" || err.message.startsWith("NonRetryableError")`.
 * Passing the kind as the name therefore made the engine treat every
 * deterministic failure as an ordinary error and RETRY it — re-billing the org
 * for a request that cannot succeed. The kind rides in the message instead.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const c = classifyStepError(err);
    if (c.retryable) throw retryableStepError(c);
    throw new NonRetryableError(`[${c.errorKind}] ${c.message}`);
  }
}

export type TranslateWorkflowResult = {
  jobId: string;
  workspace: string;
  batchCount: number;
  rowCount: number;
  bookFile: string;
  reportFile: string;
  calls: number;
  costUsd: number | null;
};

export class TranslateWorkflow extends WorkflowEntrypoint<Env, TranslateWorkflowParams> {
  async run(event: WorkflowEvent<TranslateWorkflowParams>, step: WorkflowStep): Promise<TranslateWorkflowResult> {
    const params = event.payload;

    // NOTHING may touch a tenant's D1 until params.workspace has been resolved
    // AND verified. Until the re-point below, this.env.DB is the RAW (default)
    // binding — Workflows don't inherit the per-request env clone that
    // index.ts's fetch wrapper builds — and status.writeWfStatus is an UPDATE
    // keyed by job_id alone. Job ids are unique only WITHIN a tenant database,
    // so a refusal recorded here silently overwrote ANOTHER org's row
    // (current_skill, current_status, updated_at, wf_status_json) whenever the
    // two happened to share an id. An earlier revision built `deps` above this
    // resolve precisely so a refusal could be recorded; that traded a silent
    // failure for a cross-tenant write, which is the worse of the two.
    //
    // There is no correct row to write instead: workspace_missing names no
    // tenant at all, and workspace_unknown names one this deployment has no
    // binding for — so the refusal writes NOTHING, by design. The job row is
    // left to the sweeps that already own abandoned rows (pipelines.ts):
    // pollAllNonTerminal bumps attempt_count on every poll that sees no
    // progress and auto-fails a still-'running' row after MAX_POLL_ATTEMPTS
    // (~8h without progress at the */5 cron), with
    // the 48h no-progress sweep behind it. The immediate signal is the errored
    // Workflow instance, which is what an operator has to look at anyway for a
    // refusal that names a workspace this deployment does not have.
    //
    // A translate run reads an org's provider key and writes that org's job
    // row, so "fall back to the default workspace" is a cross-tenant bug, not a
    // convenience (unlike the export, where params.workspace is optional).
    await primeWorkspaces(this.env);
    let ws;
    try {
      ws = await resolveWorkflowWorkspaceFresh(this.env, params);
    } catch (err) {
      const c = classifyStepError(err);
      // The instance's own error is all an operator gets for this failure, and
      // the engine reports a NonRetryableError thrown out of run() as a generic
      // "WorkflowFatalError … a step threw an NonRetryableError" with the
      // message dropped (measured in translate/workflowEngine.test.mjs). Since
      // nothing may be written to a tenant row here, the log line IS the
      // diagnosis — job id, slug and kind, all non-secret.
      console.error("TranslateWorkflow: refusing a run whose workspace cannot be resolved", {
        jobId: params?.jobId, workspace: params?.workspace, errorKind: c.errorKind, error: c.message,
      });
      throw new NonRetryableError(`[${c.errorKind}] ${c.message}`);
    }
    (this as unknown as { env: Env }).env = workspaceEnv(this.env, ws);

    // Only now — every binding here belongs to the verified workspace.
    const deps: StepDeps = {
      db: this.env.DB,
      blobs: this.env.BLOBS,
      workspaceSlug: this.env.WORKSPACE_SLUG ?? ws.slug,
      wrappingKey: this.env.AI_KEY_WRAPPING_KEY,
      startedAt: new Date(event.timestamp).toISOString(),
    };

    try {
      const src = await step.do("guard-and-source", INFRA_RETRY, () => guarded(() => guardAndSourceStep(deps, params)));

      const ctx = await step.do("context", INFRA_RETRY, () => guarded(() => contextStep(deps, params, src.batchCount)));

      // Two steps per batch, and the split is the cost control. The paying step
      // RETURNS its output; Cloudflare persists a step's return before the next
      // one runs, so the write that follows can retry off durable state instead
      // of off the provider. Done inside one step, an R2 refusal after a billed
      // call had only bad options: retry the step and pay again, or fail the
      // batch. (What no split can save: an isolate death between the provider's
      // reply and the commit of batch-NN's return — nothing is durable yet.)
      const results: BatchStepResult[] = [];
      for (let i = 0; i < src.batchCount; i++) {
        const nn = batchNn(i);
        const translated = await step.do(`batch-${nn}`, BATCH_RETRY, () => guarded(() => batchTranslateStep(deps, params, i, src.batchCount)));
        results.push(await step.do(`batch-${nn}-persist`, INFRA_RETRY, () => guarded(() => batchPersistStep(deps, params, translated))));
      }

      const merged = await step.do("merge-report", INFRA_RETRY, () => guarded(() => mergeReportStep(deps, params, src, ctx, results)));

      return {
        jobId: params.jobId,
        workspace: ws.slug,
        batchCount: src.batchCount,
        rowCount: merged.rowCount,
        bookFile: merged.bookFile,
        reportFile: merged.reportFile,
        calls: merged.calls,
        costUsd: merged.costUsd,
      };
    } catch (err) {
      // Catch-all, like exportWorkflow's `${stepName}-record-fail`: best-effort,
      // never lets the recording error mask the real one, then rethrows so the
      // instance reports errored (pollPipelineJob reads wf_status_json, not the
      // instance status, so the rethrow is for operators, not the UI).
      try {
        await step.do("record-failure", async () => recordFailure(deps, params, err));
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }
}
