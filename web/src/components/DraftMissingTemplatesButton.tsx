// "Draft missing templates from approved notes" (#818). Admin only. Mounted in
// both template screens (TemplateWorkspace and the admin desk's CurateScreen)
// so neither drifts from the other (adminSurfaceMap entry
// "draftMissingTemplates").
//
// The server picks the note types (SupportReference slugs) with enough
// approved notes and no approved template, drafts one bounded batch per press
// on the org's own AI key, and reports how many remain. Drafts land as AI
// drafts that an editor still has to approve.

import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError, isAdmin, type DraftMissingPreview, type DraftMissingResult } from "../sync/api";

/** The approved-note count a draft from this feature was built from, or null. */
export function draftNoteCount(draftMetaJson: string | null | undefined): number | null {
  if (!draftMetaJson) return null;
  try {
    const meta = JSON.parse(draftMetaJson) as { source?: unknown; approved_note_count?: unknown };
    return meta.source === "approved_notes" && typeof meta.approved_note_count === "number"
      ? meta.approved_note_count
      : null;
  } catch {
    return null;
  }
}

function reasonText(reason: string, provider: string | null, t: TFunction): string {
  switch (reason) {
    case "ai_provider_not_configured":
    case "api_key_missing":
      return t("templates.draftMissing.notConfigured");
    case "provider_not_supported":
      return t("templates.draftMissing.unsupported", { provider: provider ?? "" });
    default:
      return t("templates.draftMissing.unavailable", { reason });
  }
}

export function DraftMissingTemplatesButton({ onDrafted }: { onDrafted: () => void }) {
  const { t } = useTranslation();
  const admin = isAdmin();
  const [preview, setPreview] = useState<DraftMissingPreview | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DraftMissingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Slugs that failed earlier in this session: sent back so one note type that
  // keeps failing cannot take a place in every later batch.
  const [skipSlugs, setSkipSlugs] = useState<string[]>([]);

  const load = useCallback(() => {
    api
      .getDraftMissingTemplates()
      .then(setPreview)
      .catch(() => setPreview(null));
  }, []);

  useEffect(() => {
    if (admin) load();
  }, [admin, load]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.draftMissingTemplates(skipSlugs);
      setResult(r);
      const failedSlugs = r.failed.filter((f) => f.code !== "not_started").map((f) => f.slug);
      if (failedSlugs.length > 0) setSkipSlugs((prev) => Array.from(new Set([...prev, ...failedSlugs])));
      if (r.drafted.length > 0) onDrafted();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string; provider?: string | null } | undefined) : undefined;
      setError(body?.error ? reasonText(body.error, body.provider ?? null, t) : t("templates.draftMissing.failed"));
    } finally {
      setRunning(false);
      load();
    }
  }, [skipSlugs, onDrafted, load, t]);

  if (!admin || !preview) return null;

  const ready = preview.qualifying.filter((q) => !skipSlugs.includes(q.slug)).length;
  const disabled = running || !preview.available || ready === 0;

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
      <Typography variant="caption" color="text.secondary">
        {!preview.available
          ? reasonText(preview.reason ?? "", preview.provider, t)
          : ready > 0
            ? t("templates.draftMissing.ready", { n: ready, min: preview.minApprovedNotes, batch: preview.batchSize })
            : t("templates.draftMissing.none", { min: preview.minApprovedNotes })}
      </Typography>
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
            <Box component="span" sx={{ display: "block" }}>
              {t("templates.draftMissing.notDrafted", {
                list: result.failed.map((f) => `${f.slug} (${f.code})`).join(", "),
              })}
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
