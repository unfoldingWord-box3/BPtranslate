// "Draft missing templates from approved notes" (#818). Admin only. Mounted in
// both template screens (TemplateWorkspace and the admin desk's CurateScreen)
// so neither drifts from the other (adminSurfaceMap entry
// "draftMissingTemplates").
//
// The server picks the note types (SupportReference slugs) with enough
// approved notes and no approved template, drafts one bounded batch per press
// on the org's own AI key, and reports how many remain. Drafts land as AI
// drafts that an editor still has to approve.

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError, isAdmin, type DraftMissingPreview, type DraftMissingResult } from "../sync/api";

/**
 * For a draft this feature wrote: how many approved notes the model was shown
 * (`used`, at most 30) out of how many the note type has (`total`). Null for
 * any other draft.
 */
export function draftNoteCount(draftMetaJson: string | null | undefined): { used: number; total: number } | null {
  if (!draftMetaJson) return null;
  try {
    const meta = JSON.parse(draftMetaJson) as { source?: unknown; approved_note_count?: unknown; example_count?: unknown };
    if (meta.source !== "approved_notes" || typeof meta.approved_note_count !== "number") return null;
    const used = typeof meta.example_count === "number" ? meta.example_count : meta.approved_note_count;
    return { used, total: meta.approved_note_count };
  } catch {
    return null;
  }
}

// Left-to-right isolation for Latin slugs and codes inside Arabic text
// (U+2066 … U+2069), the same wrapping the `cost` string uses.
export const isolate = (s: string) => `\u2066${s}\u2069`;

/**
 * Slot words (SPEAKER, PERSON) that a draft from this feature may have
 * dropped (draft_meta_json.placeholder_warnings). Empty for any other draft.
 */
export function draftSlotWarnings(draftMetaJson: string | null | undefined): string[] {
  if (!draftMetaJson) return [];
  try {
    const meta = JSON.parse(draftMetaJson) as { source?: unknown; placeholder_warnings?: unknown };
    if (meta.source !== "approved_notes" || !Array.isArray(meta.placeholder_warnings)) return [];
    return meta.placeholder_warnings.filter((w): w is string => typeof w === "string");
  } catch {
    return [];
  }
}

/** The warning line both template editors show under an AI draft. */
export function SlotWarningLine({ draftMetaJson }: { draftMetaJson: string | null | undefined }) {
  const { t } = useTranslation();
  const words = draftSlotWarnings(draftMetaJson);
  if (words.length === 0) return null;
  return (
    <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 600 }} data-testid="slot-word-warning">
      {t("templates.draftMissing.slotWarning", {
        words: words.map(isolate).join(t("templates.draftMissing.wordSeparator")),
      })}
    </Typography>
  );
}

function reasonText(reason: string, provider: string | null, t: TFunction): string {
  switch (reason) {
    case "ai_provider_not_configured":
    case "api_key_missing":
      return t("templates.draftMissing.notConfigured");
    case "provider_not_supported":
      return t("templates.draftMissing.unsupported", { provider: isolate(provider ?? "") });
    case "run_in_progress":
      return t("templates.draftMissing.runInProgress");
    case "not_migrated":
    case "model_missing":
    case "ai_provider_key_decrypt_failed":
    case "ai_key_encryption_unavailable":
    case "not_translation_project":
      return t("templates.draftMissing.unavailable", { reason: t(`templates.draftMissing.reason.${reason}`) });
    default:
      return t("templates.draftMissing.unavailable", { reason: isolate(reason) });
  }
}

// Every failure code the server reports for one note type (templateDraftMissing.ts).
const FAILURE_CODES = new Set([
  "rate_limited",
  "provider_overloaded",
  "timeout",
  "network_error",
  "invalid_key",
  "model_not_found",
  "context_too_long",
  "output_too_long",
  "empty_output",
  "provider_error",
  "not_started",
  "unreadable_output",
  "not_written",
  "partial_output",
  "placeholder_missing",
  "internal_error",
]);

function failureText(code: string, t: TFunction): string {
  return FAILURE_CODES.has(code)
    ? t(`templates.draftMissing.code.${code}`)
    : t("templates.draftMissing.code.other", { code: isolate(code) });
}

/**
 * `onRun` is called after every run that got an answer, with the template ids
 * it wrote. The screen refetches its list and reloads an open editor whose unit
 * is in `written`: the editor holds its own copy of the unit, and an Approve
 * on a stale copy would publish AI text nobody saw (the web app's validate
 * call sends no If-Match).
 */
export function DraftMissingTemplatesButton({ onRun }: { onRun: (written: string[]) => void }) {
  const { t } = useTranslation();
  const admin = isAdmin();
  const [preview, setPreview] = useState<DraftMissingPreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [running, setRunning] = useState(false);
  // Set synchronously on press, so a second click before React re-renders the
  // disabled button cannot start (and then clear the state of) another run.
  const runningRef = useRef(false);
  // Only the latest preview request may set state: an older one that lands
  // late must not overwrite a newer success or failure.
  const loadSeq = useRef(0);
  const [result, setResult] = useState<DraftMissingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Note types the LAST press reported as failed. The next press sends them
  // so they wait that one press (the server retries them anyway when nothing
  // else is left), then the list is replaced by that press's own failures.
  const [skipSlugs, setSkipSlugs] = useState<string[]>([]);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    api
      .getDraftMissingTemplates()
      .then((p) => {
        if (seq !== loadSeq.current) return;
        setPreview(p);
        setPreviewFailed(false);
      })
      .catch(() => {
        if (seq !== loadSeq.current) return;
        setPreviewFailed(true);
      });
  }, []);

  useEffect(() => {
    if (admin) load();
  }, [admin, load]);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.draftMissingTemplates(skipSlugs);
      setResult(r);
      setSkipSlugs(r.failed.filter((f) => f.code !== "not_started").map((f) => f.slug));
      onRun(r.written ?? []);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string; provider?: string | null } | undefined) : undefined;
      setError(body?.error ? reasonText(body.error, body.provider ?? null, t) : t("templates.draftMissing.failed"));
    } finally {
      runningRef.current = false;
      setRunning(false);
      load();
    }
  }, [skipSlugs, onRun, load, t]);

  if (!admin) return null;
  if (!preview) {
    // Say why the control is missing instead of hiding it silently.
    return previewFailed ? (
      <Stack direction="row" alignItems="center" spacing={1} data-testid="draft-missing-templates">
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {t("templates.draftMissing.previewFailed")}
        </Typography>
        <Button size="small" onClick={load} sx={{ fontSize: 11, minWidth: 0 }}>
          {t("common.retry")}
        </Button>
      </Stack>
    ) : null;
  }

  // The server's own count, the same query as the run's `remaining`: the
  // button is enabled whenever the server says work remains. A failed
  // refresh leaves those counts stale, so it disables the button and shows
  // the error with Retry until a refresh succeeds.
  const ready = preview.qualifying.length;
  const disabled = running || previewFailed || !preview.available || ready === 0;

  return (
    <Stack spacing={0.75} data-testid="draft-missing-templates">
      <Box>
        <Button
          size="small"
          variant="outlined"
          startIcon={running ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon fontSize="small" />}
          onClick={run}
          disabled={disabled}
          sx={{ fontSize: 11, textAlign: "start" }}
        >
          {running ? t("templates.draftMissing.running") : t("templates.draftMissing.button")}
        </Button>
      </Box>
      {previewFailed ? (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            {t("templates.draftMissing.previewFailed")}
          </Typography>
          <Button size="small" onClick={load} sx={{ fontSize: 11, minWidth: 0 }}>
            {t("common.retry")}
          </Button>
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {!preview.available
            ? reasonText(preview.reason ?? "", preview.provider, t)
            : ready > 0
              ? t("templates.draftMissing.ready", { n: ready, min: preview.minApprovedNotes, batch: preview.batchSize })
              : t("templates.draftMissing.none", { min: preview.minApprovedNotes })}
        </Typography>
      )}
      {result ? (
        <Alert
          severity={result.failed.length > 0 ? "warning" : "success"}
          onClose={() => setResult(null)}
          sx={{ py: 0, fontSize: 11, "& .MuiAlert-message": { py: 0.5 } }}
        >
          {t("templates.draftMissing.done", { n: result.drafted.length, remaining: result.remaining })}
          {result.estimatedCostUsd != null
            ? ` ${t("templates.draftMissing.cost", { cost: result.estimatedCostUsd.toFixed(2) })}`
            : ""}
          {result.failed.length > 0 ? (
            <Box component="span" sx={{ display: "block", mt: 0.5 }}>
              {t("templates.draftMissing.notDrafted")}
              {result.failed.map((f) => (
                <Box component="span" key={f.slug} sx={{ display: "block" }} data-testid="draft-missing-failure">
                  {t("templates.draftMissing.failedItem", { slug: isolate(f.slug), reason: failureText(f.code, t) })}
                </Box>
              ))}
            </Box>
          ) : null}
        </Alert>
      ) : null}
      {error ? (
        <Alert severity="warning" onClose={() => setError(null)} sx={{ py: 0, fontSize: 11, "& .MuiAlert-message": { py: 0.5 } }}>
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}
