// AI-studio error copy: turns a pipeline job's machine-readable errorKind into
// translator-facing text. Lives outside AiScreen.tsx so aiErrorCopy.test.mjs can
// check the real map against every kind the server can write (#471). Type-only
// imports, so node's strip-types test runner can load this file directly.
import type { TFunction } from "i18next";
import type { PipelineErrorKind } from "../sync/api";

// Friendly PipelineErrorKind copy — mirrors docs/flows/ui/l1-ai.html's
// ERROR_COPY verbatim (same enum, same intent: no bare enum string in front
// of a translator).
export const ERROR_COPY_KEY: Record<PipelineErrorKind, string> = {
  // Fly bot kinds.
  transient_outage: "aiStudio.errors.transient_outage",
  auth_error: "aiStudio.errors.auth_error",
  usage_limit: "aiStudio.errors.usage_limit",
  sdk_error: "aiStudio.errors.sdk_error",
  non_success_result: "aiStudio.errors.non_success_result",
  missing_output: "aiStudio.errors.missing_output",
  stale_output: "aiStudio.errors.stale_output",
  interrupted: "aiStudio.errors.interrupted",
  import_failed: "aiStudio.errors.import_failed",
  // Internal translate-runner kinds (#445/#471). The Record<PipelineErrorKind>
  // type makes this exhaustive: a new runner code with no copy fails typecheck.
  rate_limited: "aiStudio.errors.rate_limited",
  provider_overloaded: "aiStudio.errors.provider_overloaded",
  timeout: "aiStudio.errors.timeout",
  network_error: "aiStudio.errors.network_error",
  invalid_key: "aiStudio.errors.invalid_key",
  model_not_found: "aiStudio.errors.model_not_found",
  context_too_long: "aiStudio.errors.context_too_long",
  output_too_long: "aiStudio.errors.output_too_long",
  empty_output: "aiStudio.errors.empty_output",
  provider_error: "aiStudio.errors.provider_error",
  provider_not_supported_internal: "aiStudio.errors.provider_not_supported_internal",
  resource_not_supported_internal: "aiStudio.errors.resource_not_supported_internal",
  checks_failed: "aiStudio.errors.checks_failed",
  internal_error_after_call: "aiStudio.errors.internal_error_after_call",
  internal_error: "aiStudio.errors.internal_error",
  // Translate-runner step kinds (workflowSteps.ts TranslateStepError).
  workspace_missing: "aiStudio.errors.workspace_missing",
  workspace_unknown: "aiStudio.errors.workspace_unknown",
  job_missing: "aiStudio.errors.job_missing",
  job_not_running: "aiStudio.errors.job_not_running",
  cancelled: "aiStudio.errors.cancelled",
  artifact_missing: "aiStudio.errors.artifact_missing",
  source_not_found: "aiStudio.errors.source_not_found",
  no_source_rows: "aiStudio.errors.no_source_rows",
  scripture_fetch_failed: "aiStudio.errors.scripture_fetch_failed",
  output_persist_failed: "aiStudio.errors.output_persist_failed",
  ai_provider_unavailable: "aiStudio.errors.ai_provider_unavailable",
  ai_provider_changed: "aiStudio.errors.ai_provider_changed",
  ai_provider_key_decrypt_failed: "aiStudio.errors.ai_provider_key_decrypt_failed",
  target_book_absent: "aiStudio.errors.target_book_absent",
  merge_failed: "aiStudio.errors.merge_failed",
  merge_shrink_refused: "aiStudio.errors.merge_shrink_refused",
  // Dispatch-time kinds (pipelines.ts dispatchNext).
  lane_fenced: "aiStudio.errors.lane_fenced",
  pipeline_api_disabled: "aiStudio.errors.pipeline_api_disabled",
};

// `kind` is whatever string the server wrote, so it may be a kind this build
// doesn't know. Own-property check: a plain index would return Object.prototype
// members for "constructor" or "toString" and hand a function to t().
export function errorCopy(kind: string | null, t: TFunction): string {
  const key = kind && Object.hasOwn(ERROR_COPY_KEY, kind) ? ERROR_COPY_KEY[kind as PipelineErrorKind] : undefined;
  return key ? t(key) : t("aiStudio.unrecognizedError", { kind });
}
