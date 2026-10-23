// "Bring in this book" source sheet (docs/ux-simplification.md §1.3 / Track
// A3). Folds the old two-stop flow — configure `book_source_overrides` on
// Admin → Setup, then import on Books — into ONE dialog on the book:
//
//   • intent (translate / load), the same toggle the detail panel used to host;
//   • per overridable resource (tn, tq) a compact row list
//     [source][from ch][to ch], where the source defaults to "Project default
//     (own repos)" (a no-op — the common path stays a 2-click import) and can
//     be the unfoldingWord upstream preset, Aquifer (tN only), or another
//     Door43 URL (verified via api.verifySource on submit);
//   • on confirm: PUT each planned override in order (a 409 overlapping_range
//     lands inline on the offending row), then POST the import.
//
// Overrides the book ALREADY has (api.getBookSources) are shown read-only at
// the top — they apply on import as-is; editing them stays on Admin → Setup.
// (Prefill-as-editable would need clear+re-PUT diffing against the server
// rows; the read-only display was the sanctioned simpler choice.)
//
// The `has_local_edits` 409 gets a real path here (it used to dead-end in an
// Alert): the counts render with an explicit, destructive, admin-only
// "Discard N edits and re-import" confirm that retries with
// { force: true, confirmDiscardEdits: true }. Reachable via the force path:
// when the sheet wrote overrides but the server answers `alreadyImported`
// (range overrides only apply on a FULL import), the dialog offers the
// explicit force re-import rather than pretending the sources took effect.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloseIcon from "@mui/icons-material/Close";
import {
  api,
  ApiError,
  type BookSourceOverride,
  type ImportHasLocalEditsBody,
} from "../../sync/api";
import { RepoRef } from "../SourceOverrideField";
import { UW_UPSTREAM_ORG, upstreamSourceForResource } from "../../lib/orgDraft";
import {
  OVERRIDABLE_RESOURCES,
  defaultSheetRows,
  planSourceWrites,
  setBookSourceBody,
  type OverridableResource,
  type SheetRow,
  type SheetRowErrorCode,
} from "../../lib/importSources";
import type { ImportIntent } from "../../lib/importIntent";

type ImportResult = Awaited<ReturnType<typeof api.importBook>>;

// Row-level error: a planner code, or one of the submit-time server outcomes.
type RowIssue = SheetRowErrorCode | "overlap_server" | "url_verify_failed";

const ROW_ISSUE_KEYS: Record<RowIssue, string> = {
  range_needs_both: "import.sources.rangeNeedsBoth",
  bad_chapter: "flowBooks.sheet.badRange",
  range_reversed: "flowBooks.sheet.badRange",
  aquifer_needs_range: "import.sources.aquiferNeedsRange",
  aquifer_tn_only: "flowBooks.sheet.aquiferTnOnly",
  url_required: "flowBooks.sheet.urlRequired",
  overlap: "flowBooks.sheet.overlapSheet",
  overlap_server: "import.sources.overlap",
  url_verify_failed: "flowBooks.sheet.urlVerifyFailed",
};

function isWholeBook(o: BookSourceOverride): boolean {
  return o.chapter_start === 0 && o.chapter_end === 999;
}

export interface BringInBookDialogProps {
  open: boolean;
  onClose: () => void;
  book: string;
  /** Import finished (fresh or forced) — parent surfaces the message + refetches. */
  onSuccess: (res: ImportResult) => void;
}

export function BringInBookDialog({ open, onClose, book, onSuccess }: BringInBookDialogProps) {
  const { t } = useTranslation();

  const [intent, setIntent] = useState<ImportIntent>("translate");
  const [rows, setRows] = useState<SheetRow[]>(defaultSheetRows);
  const [rowIssues, setRowIssues] = useState<Map<number, RowIssue>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Overrides already stored server-side (read-only display).
  const [existing, setExisting] = useState<BookSourceOverride[] | null>(null);
  const [existingFailed, setExistingFailed] = useState(false);

  // idle → saving (PUT overrides) → importing (POST import).
  const [phase, setPhase] = useState<"idle" | "saving" | "importing">("idle");
  // Sheet overrides were written but the book was already imported — they only
  // apply on a FULL import, so offer the explicit destructive force path.
  const [needsForce, setNeedsForce] = useState(false);
  // The has_local_edits 409 body → the scary discard-and-reimport confirm.
  const [discard, setDiscard] = useState<ImportHasLocalEditsBody | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the reset is paired with the getBookSources fetch this same effect starts on open (setExisting(null) must precede that fetch's result); keeping them in one effect keeps them in step.
    setIntent("translate");
    setRows(defaultSheetRows());
    setRowIssues(new Map());
    setError(null);
    setNeedsForce(false);
    setDiscard(null);
    setPhase("idle");
    setExisting(null);
    setExistingFailed(false);
    let cancelled = false;
    api
      .getBookSources(book)
      .then((r) => {
        if (!cancelled) setExisting(r.overrides);
      })
      .catch(() => {
        if (!cancelled) setExistingFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, book]);

  const busy = phase !== "idle";

  // Any sheet edit invalidates row-pinned errors (indices shift on add/remove,
  // and a fixed row shouldn't keep its stale error).
  const patchRow = (index: number, patch: Partial<SheetRow>) => {
    setRowIssues(new Map());
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const addRow = (resource: OverridableResource) => {
    setRowIssues(new Map());
    setRows((prev) => {
      // Insert after the resource's last row so the sheet stays grouped.
      const last = prev.map((r) => r.resource).lastIndexOf(resource);
      const next = [...prev];
      next.splice(last + 1, 0, { resource, kind: "upstream", url: "", fromCh: "", toCh: "" });
      return next;
    });
  };

  const removeRow = (index: number) => {
    setRowIssues(new Map());
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const runImport = useCallback(
    async (force: boolean) => {
      setPhase("importing");
      setError(null);
      try {
        const res = await api.importBook(book, {
          ...(intent === "translate" ? { translateFromSource: true } : {}),
          ...(force ? { force: true, confirmDiscardEdits: true } : {}),
        });
        return res;
      } finally {
        setPhase("idle");
      }
    },
    [book, intent],
  );

  const handleImportOutcome = useCallback(
    (res: ImportResult, hadWrites: boolean) => {
      if (res.alreadyImported && hadWrites) {
        // The overrides were saved but the fast path skipped the load — range
        // overrides only apply on a FULL import. Never pretend they took
        // effect; offer the explicit destructive re-import instead.
        setNeedsForce(true);
        return;
      }
      onSuccess(res);
      onClose();
    },
    [onSuccess, onClose],
  );

  const handleImportError = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as Partial<ImportHasLocalEditsBody> | undefined;
        if (body?.error === "has_local_edits") {
          setDiscard({
            error: "has_local_edits",
            book,
            tn: body.tn ?? 0,
            tq: body.tq ?? 0,
            twl: body.twl ?? 0,
            verses: body.verses ?? 0,
          });
          return;
        }
      }
      const detail =
        e instanceof ApiError
          ? ((e.body as { message?: string; error?: string } | undefined)?.message ??
            (e.body as { error?: string } | undefined)?.error ??
            `HTTP ${e.status}`)
          : e instanceof Error
            ? e.message
            : String(e);
      setError(t("flowBooks.detail.importFailed", { book, error: detail }));
    },
    [book, t],
  );

  const handleConfirm = useCallback(async () => {
    setError(null);
    setRowIssues(new Map());
    const plan = planSourceWrites(rows);
    if (!plan.ok) {
      setRowIssues(new Map(plan.errors.map((e) => [e.index, e.code as RowIssue])));
      return;
    }

    // 1. Write each non-default override, in sheet order. Server-side range
    //    conflicts (against rows the book ALREADY has) come back as 409
    //    overlapping_range — pin them on the row that caused them.
    setPhase("saving");
    try {
      for (const write of plan.writes) {
        let verified: { org: string; repo: string } | undefined;
        if (write.kind === "url") {
          try {
            verified = await api.verifySource(write.url ?? "");
          } catch {
            setRowIssues(new Map([[write.index, "url_verify_failed"]]));
            return;
          }
        }
        try {
          await api.setBookSource(book, setBookSourceBody(write, verified));
        } catch (e) {
          if (e instanceof ApiError) {
            const code = (e.body as { error?: string } | undefined)?.error;
            if (code === "overlapping_range") {
              setRowIssues(new Map([[write.index, "overlap_server"]]));
              return;
            }
            if (e.status === 403) {
              setError(t("import.sources.adminOnly"));
              return;
            }
          }
          setError(t("import.sources.saveFailed"));
          return;
        }
      }
    } finally {
      setPhase("idle");
    }

    // 2. Import.
    try {
      const res = await runImport(false);
      handleImportOutcome(res, plan.writes.length > 0);
    } catch (e) {
      handleImportError(e);
    }
  }, [rows, book, runImport, handleImportOutcome, handleImportError, t]);

  const handleForce = useCallback(async () => {
    setNeedsForce(false);
    try {
      const res = await runImport(true);
      onSuccess(res);
      onClose();
    } catch (e) {
      handleImportError(e);
    }
  }, [runImport, onSuccess, onClose, handleImportError]);

  const discardTotal = discard ? discard.tn + discard.tq + discard.twl + discard.verses : 0;

  const renderResourceRows = (resource: OverridableResource) => {
    const indices = rows.map((r, i) => (r.resource === resource ? i : -1)).filter((i) => i >= 0);
    return (
      <Box key={resource}>
        <Typography
          variant="caption"
          sx={{
            display: "block",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "text.secondary",
            mb: 0.5,
          }}
        >
          {resource === "tn" ? t("import.sources.resourceTn") : t("import.sources.resourceTq")}
        </Typography>
        <Stack spacing={1}>
          {indices.map((index) => {
            const row = rows[index];
            const issue = rowIssues.get(index);
            return (
              <Box key={index}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: "wrap", rowGap: 1 }}>
                  <Select
                    size="small"
                    value={row.kind}
                    disabled={busy}
                    onChange={(e) => patchRow(index, { kind: e.target.value as SheetRow["kind"] })}
                    sx={{ minWidth: 220, flex: "1 1 220px", maxWidth: 340 }}
                  >
                    <MenuItem value="default">{t("flowBooks.sheet.sourceDefault")}</MenuItem>
                    <MenuItem value="upstream">
                      {t("import.sources.sourceUpstream", {
                        org: UW_UPSTREAM_ORG,
                        repo: upstreamSourceForResource(resource).repo,
                      })}
                    </MenuItem>
                    {resource === "tn" && (
                      <MenuItem value="aquifer">{t("import.sources.sourceTypeAquifer")}</MenuItem>
                    )}
                    <MenuItem value="url">{t("import.sources.sourceOther")}</MenuItem>
                  </Select>
                  <TextField
                    size="small"
                    type="number"
                    label={t("import.sources.fromChapter")}
                    value={row.fromCh}
                    disabled={busy || row.kind === "default"}
                    onChange={(e) => patchRow(index, { fromCh: e.target.value })}
                    sx={{ width: 88 }}
                  />
                  <TextField
                    size="small"
                    type="number"
                    label={t("import.sources.toChapter")}
                    value={row.toCh}
                    disabled={busy || row.kind === "default"}
                    onChange={(e) => patchRow(index, { toCh: e.target.value })}
                    sx={{ width: 88 }}
                  />
                  {indices.length > 1 && (
                    <IconButton
                      size="small"
                      aria-label={t("import.sources.remove")}
                      disabled={busy}
                      onClick={() => removeRow(index)}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  )}
                </Stack>
                {row.kind === "upstream" && (
                  <Box sx={{ mt: 0.5 }}>
                    <RepoRef
                      org={upstreamSourceForResource(resource).org}
                      repo={upstreamSourceForResource(resource).repo}
                    />
                  </Box>
                )}
                {row.kind === "url" && (
                  <TextField
                    size="small"
                    fullWidth
                    sx={{ mt: 1, maxWidth: 480 }}
                    label={t("import.sources.urlLabel")}
                    placeholder="https://git.door43.org/BibleAquifer/ar_tn"
                    value={row.url}
                    disabled={busy}
                    onChange={(e) => patchRow(index, { url: e.target.value })}
                  />
                )}
                {issue && (
                  <Alert severity="error" variant="outlined" sx={{ py: 0, mt: 0.75 }}>
                    {t(ROW_ISSUE_KEYS[issue])}
                  </Alert>
                )}
              </Box>
            );
          })}
        </Stack>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          disabled={busy}
          onClick={() => addRow(resource)}
          sx={{ mt: 0.5, textTransform: "none" }}
        >
          {t("flowBooks.sheet.addRange")}
        </Button>
      </Box>
    );
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("flowBooks.sheet.title", { book })}</DialogTitle>
      <DialogContent>
        {discard ? (
          // ── Scary discard-and-reimport confirm (has_local_edits 409) ──────
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <Alert severity="error" variant="filled">
              {t("flowBooks.sheet.discardBody", {
                book,
                tn: discard.tn,
                tq: discard.tq,
                twl: discard.twl,
                verses: discard.verses,
              })}
            </Alert>
            <Typography variant="body2" color="text.secondary">
              {t("flowBooks.sheet.discardIrreversible")}
            </Typography>
          </Stack>
        ) : needsForce ? (
          // ── Already imported: overrides saved, not applied ─────────────────
          <Alert severity="warning" variant="outlined" sx={{ mt: 0.5 }}>
            {t("flowBooks.sheet.alreadyImportedSources", { book })}
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {t("flowBooks.sheet.intro")}
            </Typography>

            {/* Intent — the same translate/load choice the panel used to host. */}
            <Box>
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  mb: 0.75,
                }}
              >
                {t("flowBooks.detail.intent")}
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={intent}
                onChange={(_, v) => {
                  if (v) setIntent(v as ImportIntent);
                }}
                disabled={busy}
                sx={{ flexWrap: "wrap" }}
              >
                <ToggleButton value="translate" sx={{ textTransform: "none", px: 2, minHeight: 36 }}>
                  {t("import.intentTranslate")}
                </ToggleButton>
                <ToggleButton value="load" sx={{ textTransform: "none", px: 2, minHeight: 36 }}>
                  {t("import.intentLoad")}
                </ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                {intent === "translate" ? t("import.intentTranslateDesc") : t("import.intentLoadDesc")}
              </Typography>
            </Box>

            {/* Overrides already saved for this book (read-only; edited on Admin → Setup). */}
            {existingFailed && (
              <Alert severity="warning" variant="outlined" sx={{ py: 0 }}>
                {t("import.sources.loadFailed")}
              </Alert>
            )}
            {existing && existing.length > 0 && (
              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    mb: 0.5,
                  }}
                >
                  {t("flowBooks.sheet.existingHeading")}
                </Typography>
                <Stack spacing={0.5}>
                  {existing.map((o) => (
                    <Stack
                      key={`${o.resource}:${o.chapter_start}`}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{ flexWrap: "wrap", rowGap: 0.5 }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 32 }}>
                        {o.resource === "tn"
                          ? t("import.sources.resourceTn")
                          : t("import.sources.resourceTq")}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {isWholeBook(o)
                          ? t("import.sources.wholeBook")
                          : t("import.sources.chapterRange", {
                              start: o.chapter_start,
                              end: o.chapter_end,
                            })}
                      </Typography>
                      {o.kind === "aquifer" ? (
                        <Typography variant="body2">
                          {t("import.sources.sourceAquifer", { lang: o.repo })}
                        </Typography>
                      ) : (
                        <RepoRef org={o.org} repo={o.repo} />
                      )}
                    </Stack>
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
                  {t("flowBooks.sheet.existingNote")}
                </Typography>
              </Box>
            )}

            {/* The editable sheet: one compact row list per overridable resource. */}
            {OVERRIDABLE_RESOURCES.map(renderResourceRows)}
          </Stack>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {busy && (
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1.5 }}>
            {phase === "saving"
              ? t("flowBooks.sheet.savingSources")
              : t("flowBooks.detail.importRunsServerSide")}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        {discard ? (
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={() => void handleForce()}
          >
            {t("flowBooks.sheet.discardConfirm", { n: discardTotal })}
          </Button>
        ) : needsForce ? (
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={() => void handleForce()}
          >
            {t("flowBooks.sheet.forceReimport")}
          </Button>
        ) : (
          <Button
            variant="contained"
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
            onClick={() => void handleConfirm()}
          >
            {phase === "importing"
              ? t("flowBooks.detail.importingBook", { book })
              : t("flowBooks.sheet.confirm", { book })}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
