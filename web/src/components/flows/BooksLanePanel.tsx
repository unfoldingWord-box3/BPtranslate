// a2-import's "Scripture source replacement" panel. Port of the
// #laneReplacementPanel block in docs/flows/ui/a2-import.html, wired to the
// literal ("lit") lane only, exactly as the mockup was.
//
// Every call here is the real endpoint (web/src/sync/api.ts):
//   laneValidate · laneAffectedBooks · laneStartReplacement · laneGetJob ·
//   laneRetryBook · laneWaiveBook · laneActivate · laneBackOutJob · laneCancelJob
// The current/proposed source and the open job id come from the real
// GET /api/project-config laneState — never fabricated. Lifecycle text is
// derived from the job's own `status` field.
//
// NOT LaneReplacementDriver (never rendered; deleted in #593): that component
// was bound to the Setup wizard's
// per-lane edit/align choice — it patches the lane's textReadOnly /
// alignmentWritable after Activate and withholds completion until that patch is
// confirmed. This screen has no such choice to express, so embedding it would
// mean inventing a `desiredMode` and silently rewriting lane config from the
// Import screen. It shares the underlying api.lane* calls and the
// setupWizard helpers (defaultReplaceSelection / jobActionable /
// describeBookError) instead.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import {
  api,
  ApiError,
  type LaneReplacementBook,
  type LaneReplacementJobResponse,
} from "../../sync/api";
import { useProjectConfig, refreshProjectConfig } from "../../hooks/useProjectConfig";
import { defaultReplaceSelection, describeBookError, jobActionable } from "../../lib/setupWizard";
import { bookName } from "../../lib/bookNames";
import { FlowStatusChip } from "./FlowStatusChip";
import { Panel, PanelBody, PanelFoot, PanelTop, ListRow } from "./BooksPanel";

const LANE = "lit" as const;

// The four states a replacement walks through. `failed` / `cancelled` are
// terminal off-path states and are rendered as their raw label instead.
const LC_STEPS = ["reserved", "staging", "ready", "completed"] as const;

const LC_STEP_KEY: Record<(typeof LC_STEPS)[number], string> = {
  reserved: "flowBooks.lane.step.reserved",
  staging: "flowBooks.lane.step.staging",
  ready: "flowBooks.lane.step.ready",
  completed: "flowBooks.lane.step.completed",
};

const LC_NOTE_KEY: Record<string, string> = {
  reserved: "flowBooks.lane.note.reserved",
  staging: "flowBooks.lane.note.staging",
  ready: "flowBooks.lane.note.ready",
  completed: "flowBooks.lane.note.completed",
};

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { error?: string; message?: string } | undefined;
    return body?.message ?? body?.error ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

function bookChip(status: string, t: TFunction) {
  if (status === "artifact_ok") return { kind: "ok" as const, label: t("flowBooks.lane.chip.stagedOk") };
  if (status === "retryable_error" || status === "failed")
    return { kind: "warn" as const, label: t("flowBooks.lane.chip.failedRetryable") };
  if (status === "absent_authorized") return { kind: "skip" as const, label: t("flowBooks.lane.chip.waived") };
  return { kind: "draft" as const, label: status || t("flowBooks.lane.chip.waiting") };
}

function LifecycleStrip({ current }: { current: string | null }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const idx = current ? LC_STEPS.indexOf(current as (typeof LC_STEPS)[number]) : -1;
  return (
    <Box
      sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", marginBlock: "4px 10px" }}
      aria-label={t("flowBooks.lane.lifecycleAria")}
    >
      {LC_STEPS.map((step, i) => {
        const state = idx < 0 ? "pending" : i < idx ? "done" : i === idx ? "current" : "pending";
        const dotColor =
          state === "done"
            ? theme.palette.flows.ok.main
            : state === "current"
              ? theme.palette.primary.main
              : "transparent";
        const borderColor =
          state === "done"
            ? theme.palette.flows.ok.main
            : state === "current"
              ? theme.palette.primary.main
              : theme.palette.flows.skip.main;
        return (
          <Box key={step} sx={{ display: "flex", alignItems: "center" }}>
            {i > 0 && (
              <Box
                aria-hidden="true"
                sx={{
                  width: 30,
                  height: 2,
                  marginInline: 0.75,
                  flex: "none",
                  bgcolor: idx >= 0 && i <= idx ? theme.palette.flows.ok.main : "divider",
                }}
              />
            )}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                fontSize: "0.78rem",
                fontWeight: 700,
                color: state === "current" ? "primary.main" : "text.secondary",
              }}
            >
              <Box
                aria-hidden="true"
                sx={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  border: "2px solid",
                  borderColor,
                  bgcolor: dotColor,
                  flex: "none",
                }}
              />
              {t(LC_STEP_KEY[step])}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function BooksLanePanel() {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const laneState = cfg?.laneState?.[LANE] ?? null;
  const jobId = laneState?.replacementJobId ?? null;
  const pendingTarget = laneState?.pendingTarget ?? null;

  const [job, setJob] = useState<LaneReplacementJobResponse | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "start" | "activate" | "backout" | "cancel">(null);
  const [busyBook, setBusyBook] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<string | null>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [affectedBooks, setAffectedBooks] = useState<string[] | null>(null);
  const [affectedBooksError, setAffectedBooksError] = useState<string | null>(null);
  const [bookStats, setBookStats] = useState<Record<string, { verses: number; edited: number }>>({});
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());

  const loadJob = useCallback(async () => {
    if (!jobId) {
      setJob(null);
      return;
    }
    try {
      const res = await api.laneGetJob(LANE, jobId);
      setJob(res);
      setJobError(null);
    } catch (e) {
      setJobError(t("flowBooks.lane.jobLoadFailed", { jobId, error: errorText(e) }));
    }
  }, [jobId, t]);

  // Poll while a job is live so per-book staging and readiness stay current.
  // Stops on a terminal status and refreshes the shared project config (which
  // clears replacementJobId, so the poll can't re-arm).
  useEffect(() => {
    let cancelled = false;
    if (!jobId) {
      setJob(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await api.laneGetJob(LANE, jobId);
        if (cancelled) return;
        setJob(res);
        setJobError(null);
        const s = res.job.status;
        if (s === "completed" || s === "cancelled" || s === "failed") {
          await refreshProjectConfig().catch(() => {});
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  const runValidate = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setValidateResult(t("flowBooks.lane.enterUrlFirst"));
      return;
    }
    setValidating(true);
    try {
      const r = await api.laneValidate(LANE, trimmed);
      setValidateResult(
        t("flowBooks.lane.validated", {
          source: `${r.source.owner}/${r.source.repo}`,
          books: r.impactBooks,
          verses: r.impactVerses,
          current: `${r.currentSource.owner}/${r.currentSource.repo}`,
        }),
      );
    } catch (e) {
      setValidateResult(t("flowBooks.lane.validateFailed", { error: errorText(e) }));
    } finally {
      setValidating(false);
    }
  };

  const showAffected = async () => {
    try {
      const r = await api.laneAffectedBooks(LANE);
      setValidateResult(
        r.books.length
          ? t("flowBooks.lane.affectedList", { count: r.books.length, books: r.books.join(", ") })
          : t("flowBooks.lane.noBooksInLane"),
      );
    } catch (e) {
      setValidateResult(t("flowBooks.lane.affectedLoadFailed", { error: errorText(e) }));
    }
  };

  const openConfirm = async () => {
    if (!pendingTarget) return;
    setAck(false);
    setAffectedBooks(null);
    setAffectedBooksError(null);
    setConfirmOpen(true);
    try {
      const res = await api.laneAffectedBooks(LANE);
      setAffectedBooks(res.books);
      setBookStats(res.stats ?? {});
      // Same smart default as the Setup wizard: replace unedited books, keep
      // books that already carry translator work.
      setSelectedBooks(new Set(defaultReplaceSelection(res.books, res.stats)));
    } catch (e) {
      // Fail CLOSED: a failed lookup must never be read as "this lane is
      // empty." Leave affectedBooks null (Start stays disabled via the
      // `affectedBooks == null` check below) and surface a retryable error
      // instead of an empty-list claim.
      setAffectedBooksError(errorText(e));
      setBookStats({});
      setSelectedBooks(new Set());
    }
  };

  const confirmStart = async () => {
    if (!pendingTarget || affectedBooks == null) return;
    setConfirmOpen(false);
    setBusy("start");
    setError(null);
    try {
      // Always send an explicit selection — never `undefined`, which the
      // server (and api.ts's own truthiness check) reads as "replace every
      // book in the lane." An explicit array, even [], serializes and is
      // honored as the exact selection (a full selection is equivalent to
      // "replace all"; see planReplacementBooks in scriptureLane.ts).
      const replaceBooks = affectedBooks.filter((b) => selectedBooks.has(b));
      await api.laneStartReplacement(LANE, pendingTarget, true, replaceBooks);
      await refreshProjectConfig().catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    if (!jobId) return;
    setBusy("activate");
    setError(null);
    try {
      // A fresh fencing UUID per activation, matching the since-deleted LaneReplacementDriver —
      // the mockup prompted for one only because its preview had no way to mint it.
      await api.laneActivate(LANE, jobId, crypto.randomUUID());
      await refreshProjectConfig().catch(() => {});
      await loadJob();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const backOut = async () => {
    if (!jobId) return;
    if (!window.confirm(t("flowBooks.lane.confirmBackOut"))) return;
    setBusy("backout");
    setError(null);
    try {
      await api.laneBackOutJob(LANE, jobId);
      await refreshProjectConfig().catch(() => {});
      setJob(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const cancelJob = async () => {
    if (!jobId) return;
    if (!window.confirm(t("flowBooks.lane.confirmCancel"))) return;
    setBusy("cancel");
    setError(null);
    try {
      await api.laneCancelJob(LANE, jobId);
      await refreshProjectConfig().catch(() => {});
      setJob(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const retryBook = async (book: string) => {
    if (!jobId) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneRetryBook(LANE, jobId, book);
      await loadJob();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyBook(null);
    }
  };

  const waiveBook = async (book: string) => {
    if (!jobId) return;
    if (!window.confirm(t("flowBooks.lane.confirmWaive", { book }))) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneWaiveBook(LANE, jobId, book, true);
      await loadJob();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusyBook(null);
    }
  };

  const status = job?.job.status ?? null;
  const books: LaneReplacementBook[] = job?.books ?? [];
  // `mode` ('staged' | 'carry_forward') is on the wire (server SELECT *) but
  // not yet declared on the shared LaneReplacementBook type — widen locally
  // rather than touch web/src/sync/api.ts for this fix.
  const bookMode = (b: LaneReplacementBook): "staged" | "carry_forward" | undefined =>
    (b as LaneReplacementBook & { mode?: "staged" | "carry_forward" }).mode;
  const source = pendingTarget?.source ?? null;
  const currentSource = laneState?.config.source ?? null;

  const bookTooltip = (b: LaneReplacementBook): string => {
    if (b.status === "retryable_error" || b.status === "failed") {
      const info = describeBookError(b.error_json, source);
      if (info?.kind === "not_found") return t("flowBooks.lane.notFoundIn", { location: info.location });
      if (info?.kind === "other") return `${b.book}: ${info.detail}`;
    }
    return `${b.book}: ${b.status}`;
  };

  const nextAction =
    status === "ready"
      ? t("flowBooks.lane.nextActivate")
      : status === "completed"
        ? t("flowBooks.lane.nextNone")
        : status === "reserved" || status === "staging"
          ? t("flowBooks.lane.nextResolve")
          : "";

  return (
    <Panel>
      <PanelTop
        title={t("flowBooks.lane.title")}
        aside={<FlowStatusChip kind="edited" label={t("flowBooks.lane.literalLane")} />}
        sub={t("flowBooks.lane.sub")}
      />
      <PanelBody>
        {!cfg ? (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="body2">{t("flowBooks.lane.loadingConfig")}</Typography>
          </Stack>
        ) : !laneState ? (
          <Typography variant="body2" color="text.secondary">
            {t("flowBooks.lane.noLaneState")}
          </Typography>
        ) : (
          <>
            <Box
              sx={{
                display: "grid",
                gap: 2,
                gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1.25fr) minmax(0, 1fr)" },
                alignItems: "start",
              }}
            >
              <Box>
                <Box
                  component="dl"
                  sx={{
                    display: "grid",
                    gridTemplateColumns: "minmax(120px, 0.8fr) minmax(0, 1.6fr)",
                    gap: "6px 14px",
                    fontSize: "0.875rem",
                    m: 0,
                  }}
                >
                  <Box component="dt" sx={{ color: "text.secondary" }}>
                    {t("flowBooks.lane.currentSource")}
                  </Box>
                  <Box component="dd" sx={{ m: 0 }}>
                    {currentSource ? `${currentSource.owner}/${currentSource.repo}` : "—"}
                  </Box>
                  <Box component="dt" sx={{ color: "text.secondary" }}>
                    {t("flowBooks.lane.proposedSource")}
                  </Box>
                  <Box component="dd" sx={{ m: 0 }}>
                    {pendingTarget
                      ? `${pendingTarget.source.owner}/${pendingTarget.source.repo} (${pendingTarget.label})`
                      : t("flowBooks.lane.nonePrepared")}
                  </Box>
                </Box>

                <TextField
                  size="small"
                  fullWidth
                  sx={{ mt: 1.5 }}
                  label={t("flowBooks.lane.urlLabel")}
                  placeholder="https://git.door43.org/..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.5, rowGap: 1 }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => void runValidate()}
                    disabled={validating}
                    sx={{ minHeight: 36 }}
                  >
                    {validating ? <CircularProgress size={16} /> : t("flowBooks.lane.validate")}
                  </Button>
                  <Button size="small" onClick={() => void showAffected()} sx={{ minHeight: 36 }}>
                    {t("flowBooks.lane.viewAffected")}
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                  {validateResult ?? t("flowBooks.lane.notYetValidated")}
                </Typography>
              </Box>

              <Box>
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    mb: 0.625,
                  }}
                >
                  {t("flowBooks.lane.lifecycle")}
                </Typography>
                <LifecycleStrip current={status && LC_STEPS.includes(status as (typeof LC_STEPS)[number]) ? status : null} />
                <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                  {job
                    ? LC_NOTE_KEY[status ?? ""]
                      ? t(LC_NOTE_KEY[status ?? ""])
                      : t("flowBooks.lane.jobStatus", { status })
                    : t("flowBooks.lane.noJobLoaded")}
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.25, rowGap: 1 }}>
                  <Button
                    size="small"
                    variant="contained"
                    sx={{ minHeight: 36 }}
                    disabled={
                      busy !== null ||
                      !pendingTarget ||
                      (!!status && ["reserved", "staging", "ready"].includes(status))
                    }
                    onClick={() => void openConfirm()}
                  >
                    {busy === "start" ? <CircularProgress size={16} /> : t("flowBooks.lane.startReplacement")}
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ minHeight: 36 }}
                    disabled={busy !== null || status !== "ready"}
                    onClick={() => void activate()}
                  >
                    {busy === "activate" ? <CircularProgress size={16} /> : t("flowBooks.lane.activate")}
                  </Button>
                  <Button
                    size="small"
                    sx={{ minHeight: 36 }}
                    disabled={busy !== null || !jobId}
                    onClick={() => void backOut()}
                  >
                    {t("flowBooks.lane.backOut")}
                  </Button>
                  <Button
                    size="small"
                    sx={{ minHeight: 36 }}
                    disabled={busy !== null || !jobId}
                    onClick={() => void cancelJob()}
                  >
                    {t("common.cancel")}
                  </Button>
                </Stack>
                {!pendingTarget && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                    {t("flowBooks.lane.noPendingTarget")}
                  </Typography>
                )}
              </Box>
            </Box>

            <Box sx={{ mt: 2 }}>
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "text.secondary",
                  mb: 0.625,
                }}
              >
                {t("flowBooks.lane.perBookHeading")}
              </Typography>
              {books.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("flowBooks.lane.noJobInProgress")}
                </Typography>
              ) : (
                <>
                  {jobActionable(books) && (
                    <Alert severity="warning" variant="outlined" sx={{ mb: 1 }}>
                      {t("flowBooks.lane.needsDecision")}
                    </Alert>
                  )}
                  {books.map((b) => {
                    const chip = bookChip(b.status, t);
                    const retryable = b.status === "retryable_error" || b.status === "failed";
                    return (
                      <ListRow key={b.book}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Tooltip title={bookTooltip(b)}>
                            <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap" }}>
                              <Typography component="strong" sx={{ fontWeight: 700, fontSize: "0.875rem" }}>
                                {b.book}
                              </Typography>
                              <FlowStatusChip kind={chip.kind} label={chip.label} />
                            </Stack>
                          </Tooltip>
                        </Box>
                        {retryable && (
                          <Button
                            size="small"
                            sx={{ minHeight: 36 }}
                            disabled={busyBook === b.book}
                            onClick={() => void retryBook(b.book)}
                          >
                            {t("common.retry")}
                          </Button>
                        )}
                        {(retryable || b.status === "absent_authorized") && (
                          <Tooltip
                            title={
                              bookMode(b) === "carry_forward"
                                ? t("flowBooks.lane.carryForwardNoWaive")
                                : ""
                            }
                          >
                            <span>
                              <Button
                                size="small"
                                sx={{ minHeight: 36 }}
                                disabled={busyBook === b.book || bookMode(b) === "carry_forward"}
                                onClick={() => void waiveBook(b.book)}
                              >
                                {t("flowBooks.lane.waive")}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </ListRow>
                    );
                  })}
                </>
              )}
            </Box>

            {jobError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {jobError}
              </Alert>
            )}
            {error && (
              <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
          </>
        )}
      </PanelBody>
      <PanelFoot
        state={
          job
            ? t("flowBooks.lane.jobState", { jobId: job.job.job_id, status: job.job.status })
            : t("flowBooks.lane.noActiveJob")
        }
      >
        <Button size="small" sx={{ minHeight: 36 }} disabled={!jobId} onClick={() => void loadJob()}>
          {t("flowBooks.refreshStatus")}
        </Button>
        {nextAction && (
          <Typography variant="caption" color="text.secondary">
            {nextAction}
          </Typography>
        )}
      </PanelFoot>

      {/* Second confirmation before a lane's text is overwritten, listing the
          exact books and defaulting to KEEP any book with translator edits. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("flowBooks.lane.confirmTitle")}</DialogTitle>
        <DialogContent>
          {source && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("flowBooks.lane.newSource", { source: `${source.owner}/${source.repo}` })}
            </Typography>
          )}
          <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
            {t("flowBooks.lane.restageWarning")}
          </Alert>
          {affectedBooksError ? (
            <>
              <Alert severity="error" variant="outlined" sx={{ mb: 1 }}>
                {t("flowBooks.lane.affectedListError", { error: affectedBooksError })}
              </Alert>
              <Button size="small" onClick={() => void openConfirm()}>
                {t("common.retry")}
              </Button>
            </>
          ) : affectedBooks == null ? (
            <Stack direction="row" spacing={1} alignItems="center">
              <CircularProgress size={16} />
              <Typography variant="body2">{t("flowBooks.lane.loadingAffected")}</Typography>
            </Stack>
          ) : affectedBooks.length === 0 ? (
            <Typography variant="body2">
              {t("flowBooks.lane.noBooksNothingRestaged")}
            </Typography>
          ) : (
            <>
              <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                <Button size="small" onClick={() => setSelectedBooks(new Set(affectedBooks))}>
                  {t("flowBooks.lane.selectAll")}
                </Button>
                <Button size="small" onClick={() => setSelectedBooks(new Set())}>
                  {t("flowBooks.lane.selectNone")}
                </Button>
              </Stack>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                {affectedBooks.map((b) => {
                  const selected = selectedBooks.has(b);
                  const edited = bookStats[b]?.edited ?? 0;
                  return (
                    <Tooltip
                      key={b}
                      title={
                        bookStats[b]
                          ? t("flowBooks.lane.bookStats", { verses: bookStats[b].verses, edited })
                          : ""
                      }
                    >
                      <Chip
                        size="small"
                        label={edited > 0 ? `${bookName(b)} (${b}) ✎${edited}` : `${bookName(b)} (${b})`}
                        color={selected ? "warning" : "default"}
                        variant={selected ? "filled" : "outlined"}
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedBooks((prev) => {
                            const next = new Set(prev);
                            if (next.has(b)) next.delete(b);
                            else next.add(b);
                            return next;
                          })
                        }
                      />
                    </Tooltip>
                  );
                })}
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                {t("flowBooks.lane.selectionSummary", {
                  // NOT `replace`: that is i18next's reserved substitution-data
                  // option, and a truthy value silently blanks every placeholder.
                  replacing: affectedBooks.filter((b) => selectedBooks.has(b)).length,
                  kept: affectedBooks.filter((b) => !selectedBooks.has(b)).length,
                })}
              </Typography>
            </>
          )}
          <FormControlLabel
            sx={{ mt: 1.5 }}
            control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />}
            label={t("flowBooks.lane.ackLabel")}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t("common.cancel")}</Button>
          <Tooltip
            title={
              affectedBooks != null && affectedBooks.length > 0 && selectedBooks.size === 0
                ? t("flowBooks.lane.selectAtLeastOne")
                : ""
            }
          >
            <span>
              <Button
                variant="contained"
                color="warning"
                disabled={
                  !ack ||
                  affectedBooks == null ||
                  (affectedBooks.length > 0 && selectedBooks.size === 0)
                }
                onClick={() => void confirmStart()}
              >
                {t("flowBooks.lane.startReplacement")}
              </Button>
            </span>
          </Tooltip>
        </DialogActions>
      </Dialog>
    </Panel>
  );
}
