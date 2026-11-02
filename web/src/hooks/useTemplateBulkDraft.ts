// Bulk-draft orchestration for POST /api/templates/unit/draft — the
// many-units analogue of useTemplateAiDraft.ts. Runs a small worker pool
// (concurrency 3) pulling from a shared index over a caller-supplied,
// already-filtered list of units. No i18n strings live here: every
// user-facing message is the caller's job — this hook only returns
// structured counts and enum-ish reason/error codes.
//
// Fail-fast is the load-bearing behaviour: the upstream bot endpoint can be
// down (404/503) for the whole run, and without a cap a "draft all" over a
// few hundred units would fire that many doomed requests. Three consecutive
// failures aborts the run; a success resets the streak. A 503
// template_draft_disabled body is terminal on the very first occurrence —
// AI isn't configured, so retrying anything is pointless.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type TemplateUnitMeta } from "../sync/api";
import { reduceBulkDraftOutcome, type BulkDraftState } from "../lib/bulkDraft";
import { AI_NEEDS_ORG_KEY } from "../lib/aiProviderErrors";

const WORKER_COUNT = 3;
const RETRY_WAIT_MS = 2000;

export interface BulkDraftProgress {
  done: number;
  total: number;
  failed: number;
}

export type BulkDraftStopReason = "completed" | "cancelled" | "aborted_failures" | "disabled";

export interface BulkDraftResult {
  drafted: number;
  failed: number;
  reason: BulkDraftStopReason;
  lastErrorCode: string | null;
}

// ── Network glue ──

function extractApiErrorCode(err: ApiError): string | null {
  if (err.body && typeof err.body === "object" && "error" in err.body) {
    return String((err.body as { error?: unknown }).error);
  }
  return null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

type UnitOutcome =
  | { kind: "success"; errorCode: null }
  | { kind: "failure"; errorCode: string | null }
  | { kind: "disabled"; errorCode: string }
  | { kind: "aborted"; errorCode: null };

async function draftOne(unit: TemplateUnitMeta, signal: AbortSignal): Promise<UnitOutcome> {
  try {
    await api.draftTemplate(unit.template_id, unit.version, signal);
    return { kind: "success", errorCode: null };
  } catch (err) {
    if (signal.aborted) return { kind: "aborted", errorCode: null };
    if (err instanceof ApiError) {
      const code = extractApiErrorCode(err);
      if (err.status === 503 && code === "template_draft_disabled") {
        return { kind: "disabled", errorCode: "template_draft_disabled" };
      }
      // #551: template drafting can't use the org's own AI key yet. Just as
      // terminal: stop at the first unit instead of failing every one.
      if (err.status === 409 && code === AI_NEEDS_ORG_KEY) {
        return { kind: "disabled", errorCode: AI_NEEDS_ORG_KEY };
      }
      if (err.status === 429) {
        // ApiError does not carry response headers (see api.ts), so a
        // Retry-After value is not available to honour — fall back to a
        // fixed wait, then retry this unit exactly once.
        await delay(RETRY_WAIT_MS, signal);
        if (signal.aborted) return { kind: "aborted", errorCode: null };
        try {
          await api.draftTemplate(unit.template_id, unit.version, signal);
          return { kind: "success", errorCode: null };
        } catch (retryErr) {
          if (signal.aborted) return { kind: "aborted", errorCode: null };
          const retryCode = retryErr instanceof ApiError ? extractApiErrorCode(retryErr) : null;
          return { kind: "failure", errorCode: retryCode };
        }
      }
      // Includes 409 version_mismatch: counted as a failure, no auto-retry —
      // the caller refetches after the run rather than drafting over a row
      // that changed mid-run.
      return { kind: "failure", errorCode: code };
    }
    return { kind: "failure", errorCode: null };
  }
}

export interface UseTemplateBulkDraftAPI {
  running: boolean;
  progress: BulkDraftProgress | null;
  result: BulkDraftResult | null;
  clearResult: () => void;
  cancel: () => void;
  draftAll: (units: TemplateUnitMeta[]) => Promise<BulkDraftResult>;
}

export function useTemplateBulkDraft(): UseTemplateBulkDraftAPI {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BulkDraftProgress | null>(null);
  const [result, setResult] = useState<BulkDraftResult | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const clearResult = useCallback(() => setResult(null), []);
  const cancel = useCallback(() => controllerRef.current?.abort(), []);

  const draftAll = useCallback(async (units: TemplateUnitMeta[]): Promise<BulkDraftResult> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    const total = units.length;
    let cursor = 0;
    let stopReason: BulkDraftStopReason | null = null;
    let lastErrorCode: string | null = null;
    let state: BulkDraftState = { done: 0, failed: 0, consecutiveFailures: 0 };

    setResult(null);
    setRunning(true);
    setProgress({ done: 0, total, failed: 0 });

    const runWorker = async () => {
      while (!stopReason && !signal.aborted) {
        const idx = cursor;
        cursor += 1;
        if (idx >= total) return;

        const outcome = await draftOne(units[idx], signal);

        if (outcome.kind === "aborted") {
          if (!stopReason) stopReason = "cancelled";
          return;
        }
        if (outcome.errorCode) lastErrorCode = outcome.errorCode;

        const reduced = reduceBulkDraftOutcome({ state, kind: outcome.kind });
        state = reduced.state;
        setProgress({ done: state.done, total, failed: state.failed });

        if (reduced.stopReason) {
          stopReason = reduced.stopReason;
          // Stop launching further work immediately and unblock the other
          // workers' in-flight requests rather than letting them run to
          // completion — that's the whole point of fail-fast.
          controller.abort();
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(WORKER_COUNT, total) }, () => runWorker()));

    if (!stopReason) stopReason = signal.aborted ? "cancelled" : "completed";

    const finalResult: BulkDraftResult = {
      drafted: state.done - state.failed,
      failed: state.failed,
      reason: stopReason,
      lastErrorCode,
    };
    setRunning(false);
    setResult(finalResult);
    return finalResult;
  }, []);

  // Abort any in-flight drafts when the owning component unmounts, matching
  // useTemplateAiDraft.ts's cleanup pattern.
  useEffect(() => () => controllerRef.current?.abort(), []);

  return { running, progress, result, clearResult, cancel, draftAll };
}
