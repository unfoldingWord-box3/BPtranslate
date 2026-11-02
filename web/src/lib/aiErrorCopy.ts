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
  ai_needs_org_key: "aiStudio.errors.ai_needs_org_key",
};

// i18n key for the AI-studio banner, from GET /api/ai-provider/status's
// `reason` (#551 part E). "No AI key" only when the org really has none; a key
// that is stored but unusable gets the copy dispatch would fail the job with
// (decrypt failure, or ai_provider_unavailable for the other reasons). null =
// no banner: available, or a reason this build doesn't know.
export function orgKeyStatusCopyKey(reason: string | null): string | null {
  switch (reason) {
    case "ai_provider_not_configured":
    case "api_key_missing":
      return "preferences.aiService.noKey";
    case "ai_provider_key_decrypt_failed":
      return ERROR_COPY_KEY.ai_provider_key_decrypt_failed;
    case "ai_key_encryption_unavailable":
    case "model_missing":
      return ERROR_COPY_KEY.ai_provider_unavailable;
    default:
      return null;
  }
}

// i18n key for the warning in the admin AI service section (#551 part F): a key
// is stored (`configured`) but the status probe says it can't be used, e.g. the
// wrapping secret was rotated and the key no longer decrypts. null when the
// section already says it another way: no key (its noKey line), encryption off
// (its encryptionUnavailable warning), or the probe isn't back / failed.
export function adminKeyWarningCopyKey(
  configured: boolean,
  status: { available: boolean; reason: string | null } | null,
): string | null {
  if (!configured || !status || status.available) return null;
  if (status.reason === "ai_key_encryption_unavailable") return null;
  // `configured` (publicShape) needs only key_ciphertext; dispatch also needs
  // key_iv and reports api_key_missing without it. The stored key is unusable
  // and must be re-entered, the same fix as a decrypt failure.
  if (status.reason === "api_key_missing") return ERROR_COPY_KEY.ai_provider_key_decrypt_failed;
  const key = orgKeyStatusCopyKey(status.reason);
  return key === "preferences.aiService.noKey" ? null : key;
}

// `kind` is whatever string the server wrote, so it may be a kind this build
// doesn't know. Own-property check: a plain index would return Object.prototype
// members for "constructor" or "toString" and hand a function to t().
//
// `message` is the job's error_message. sdk_error's copy says retrying usually
// fixes it, which is wrong when the dispatch POST was refused with a 4xx
// (pipelines.ts writes "upstream <status>: …"): the same request gets the same
// refusal, so it gets provider_error's "check the AI settings" copy (#678).
// 408, 409 and 429 are 4xx but clear on a retry (409: another run holds that
// scope, and a retry works once it finishes), so they keep the generic copy.
export function errorCopy(kind: string | null, t: TFunction, message?: string | null): string {
  if (kind === "sdk_error" && message) {
    const status = /^upstream (4\d\d)\b/.exec(message)?.[1];
    if (status && status !== "408" && status !== "409" && status !== "429") return t(ERROR_COPY_KEY.provider_error);
  }
  const key = kind && Object.hasOwn(ERROR_COPY_KEY, kind) ? ERROR_COPY_KEY[kind as PipelineErrorKind] : undefined;
  return key ? t(key) : t("aiStudio.unrecognizedError", { kind });
}
