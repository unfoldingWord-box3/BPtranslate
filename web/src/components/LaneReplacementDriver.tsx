import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  type LanePublicState,
  type LaneReplacementJobResponse,
  type LaneReplacementBook,
} from "../sync/api";
import { refreshProjectConfig } from "../hooks/useProjectConfig";
import { bookName } from "../lib/bookNames";
import {
  jobActionable,
  replacementSpinnerVisible,
  describeBookError,
  laneModeMatches,
  defaultReplaceSelection,
} from "../lib/setupWizard";
import type { LaneEditMode } from "./LaneTargetModeStep";

// Known lane error codes (mirrors PreferencesWorkspace's LaneCard). Codes may
// carry a `:detail` suffix (e.g. lane_busy:sim); split tolerates that.
const LANE_ERROR_CODES = new Set([
  "replacement_already_active",
  "lane_lease_held",
  "confirmation_required",
  "lane_replacement_required",
  "job_not_found",
  "job_not_ready",
  "export_lease_held",
  "export_lease_grace",
  "activation_cas_failed",
]);

function laneErrorMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  raw: string,
): string {
  const sep = raw.indexOf(":");
  const code = sep === -1 ? raw : raw.slice(0, sep);
  const book = sep === -1 ? undefined : raw.slice(sep + 1);
  if (LANE_ERROR_CODES.has(code)) {
    return t(`preferences.scriptureLanes.errors.${code}`, book !== undefined ? { book } : undefined);
  }
  return raw;
}

function rawError(e: unknown): string {
  return e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
}

// Step 4b — "Finish replacing a lane's text". Extracted from LaneCard's job
// driver so the wizard and Preferences share one implementation. For a
// quarantined lane it stages the pendingTarget source (laneStartReplacement),
// polls per-book progress, offers retry/waive per book, and — once ready —
// exposes an EXPLICIT Activate. Never auto-activates (owner decision): nothing
// changes for editors until Activate is pressed.
//
// Two safety additions over the raw LaneCard driver:
//   • A prominent SECOND confirmation (distinct from Apply) that lists the exact
//     books whose text+alignment will be overwritten, gated on an explicit ack.
//   • After Activate, the lane's Step-3 edit/align choice is (re)applied AND
//     CONFIRMED against the live config. If that patch silently fails, the lane
//     is NOT reported done (onComplete is withheld) — an explicit error + Retry
//     is shown and the wizard's Continue stays blocked, so an "Aligning only"
//     lane can never be left text-editable.
export function LaneReplacementDriver({
  lane,
  label,
  laneState,
  desiredMode,
  onComplete,
}: {
  lane: "lit" | "sim";
  label: string;
  laneState: LanePublicState;
  desiredMode: LaneEditMode;
  // Called once the lane is fully done: activated AND its edit/align mode
  // confirmed applied. Gates the wizard's Continue.
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const [starting, setStarting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [busyBook, setBusyBook] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<LaneReplacementJobResponse | null>(null);
  // Post-activation edit/align confirmation phase.
  const [modeStatus, setModeStatus] = useState<"idle" | "confirming" | "confirmed" | "error">("idle");
  // Keep onComplete out of confirmMode's dep set (parent passes an inline arrow).
  // Synced after every commit (no deps); confirmMode only calls it after an await.
  const onCompleteRef = useRef(onComplete);
  useLayoutEffect(() => {
    onCompleteRef.current = onComplete;
  });

  // Confirm dialog state (item 9).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [affectedBooks, setAffectedBooks] = useState<string[] | null>(null);
  // Per-book replace/keep selection (issue #94): checked → re-staged from the new
  // source; unchecked → kept unchanged (carried forward). Defaults to replace-all.
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  // Per-book existing-content stats (verses + translator-edit count).
  const [bookStats, setBookStats] = useState<Record<string, { verses: number; edited: number }>>({});

  const replacementJobId = laneState.replacementJobId ?? null;
  const pendingTarget = laneState.pendingTarget;
  const source = pendingTarget?.source ?? null;

  // Poll the job while one runs so per-book staging + readiness stay live.
  // Stops on a terminal status and refreshes the shared config (which clears
  // replacementJobId, so the poll won't re-arm).
  useEffect(() => {
    if (!replacementJobId) {
      setJob(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const res = await api.laneGetJob(lane, replacementJobId);
        if (cancelled) return;
        setJob(res);
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
  }, [lane, replacementJobId]);

  const openConfirm = async () => {
    if (!pendingTarget) return;
    setAck(false);
    setAffectedBooks(null);
    setConfirmOpen(true);
    // List the books whose text will be overwritten — the exact set this lane
    // will re-stage, from the lane's required-books snapshot (issue #97), NOT
    // getBooks() (which reflects the whole DB, not this lane's imported
    // generation, and can fail independently). Best-effort: on a failure the
    // dialog still confirms, just without the itemized list.
    try {
      const res = await api.laneAffectedBooks(lane);
      setAffectedBooks(res.books);
      // Default: replace unedited books, KEEP books with work done (#94).
      setSelectedBooks(new Set(defaultReplaceSelection(res.books, res.stats)));
      setBookStats(res.stats ?? {});
    } catch {
      setAffectedBooks([]);
      setSelectedBooks(new Set());
      setBookStats({});
    }
  };

  const handleConfirmStart = async () => {
    if (!pendingTarget) return;
    // Never submit before the book list + stats have loaded: affectedBooks==null
    // would collapse to replaceBooks=undefined (replace all) and overwrite the
    // edited books the smart default keeps. The Confirm button is also disabled
    // in this state; this guard is the belt-and-suspenders.
    if (affectedBooks == null) return;
    setConfirmOpen(false);
    setStarting(true);
    setError(null);
    try {
      // undefined → replace all (unchanged); a subset (incl. empty = keep all) is
      // sent explicitly and the un-selected books are carried forward server-side.
      const books = affectedBooks ?? [];
      const allSelected = books.length > 0 && books.every((b) => selectedBooks.has(b));
      const replaceBooks =
        books.length === 0 || allSelected ? undefined : books.filter((b) => selectedBooks.has(b));
      await api.laneStartReplacement(lane, pendingTarget, true, replaceBooks);
      await refreshProjectConfig().catch(() => {});
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setStarting(false);
    }
  };

  // Apply the Step-3 edit/align choice once the lane exists again post-activate,
  // then CONFIRM the live config actually matches. Only a confirmed match reports
  // the lane done (onComplete); a failed patch → error state (blocks Continue).
  const confirmMode = useCallback(async () => {
    setModeStatus("confirming");
    try {
      let cfg = await refreshProjectConfig();
      let ls = cfg.laneState?.[lane];
      // Patch only if the live config doesn't already match the desired mode.
      if (ls && !ls.replacementRequired && !laneModeMatches(ls.config, desiredMode)) {
        await api.lanePatch(lane, ls.configRevision, {
          textReadOnly: desiredMode === "align",
          alignmentWritable: true,
        });
        cfg = await refreshProjectConfig();
        ls = cfg.laneState?.[lane];
      }
      if (ls && !ls.replacementRequired && laneModeMatches(ls.config, desiredMode)) {
        setModeStatus("confirmed");
        onCompleteRef.current();
      } else {
        // Patch didn't take (or lane still quarantined) — do NOT report success.
        setModeStatus("error");
      }
    } catch {
      setModeStatus("error");
    }
  }, [lane, desiredMode]);

  const handleActivate = async () => {
    if (!replacementJobId) return;
    setActivating(true);
    setError(null);
    try {
      // A fresh fencing UUID per activation guards against a split-brain export
      // completing a stale render after the flip.
      await api.laneActivate(lane, replacementJobId, crypto.randomUUID());
      // Re-apply + confirm the lane's edit/align choice (dropped by the flip).
      await confirmMode();
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setActivating(false);
    }
  };

  // Safety net: if the lane is already activated (no longer quarantined, no job)
  // but the mode hasn't been confirmed yet, run confirmation once. Covers a
  // config refetch that cleared quarantine outside the Activate button.
  const autoConfirmed = useRef(false);
  useEffect(() => {
    if (
      !laneState.replacementRequired &&
      !laneState.replacementJobId &&
      modeStatus === "idle" &&
      !activating &&
      !autoConfirmed.current
    ) {
      autoConfirmed.current = true;
      void confirmMode();
    }
  }, [laneState.replacementRequired, laneState.replacementJobId, modeStatus, activating, confirmMode]);

  const handleRetryBook = async (book: string) => {
    if (!replacementJobId) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneRetryBook(lane, replacementJobId, book);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setBusyBook(null);
    }
  };

  const handleWaiveBook = async (book: string) => {
    if (!replacementJobId) return;
    if (!window.confirm(t("preferences.scriptureLanes.confirmWaiveBook", { book }))) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneWaiveBook(lane, replacementJobId, book, true);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(laneErrorMessage(t, rawError(e)));
    } finally {
      setBusyBook(null);
    }
  };

  const jobStatus = job?.job.status;
  const jobBooks: LaneReplacementBook[] = job?.books ?? [];
  // Activated = generation flipped (no longer quarantined, no live job); the
  // edit/align confirmation phase runs here.
  const activated = !laneState.replacementRequired && !replacementJobId;
  const modeLabel = t(`setup.laneEditMode.${desiredMode}`);
  const pendingBooks = jobBooks.filter(
    (b) => b.status !== "artifact_ok" && b.status !== "absent_authorized",
  );
  const actionable = jobActionable(jobBooks);
  const spinning = replacementSpinnerVisible(jobStatus, jobBooks);

  // Resolve a per-book tooltip: for a stuck book, say WHY (e.g. not found in the
  // source) rather than a bare status.
  const bookTooltip = (b: LaneReplacementBook): string => {
    const retryable = b.status === "retryable_error" || b.status === "failed";
    if (retryable) {
      const info = describeBookError(
        b.error_json,
        source ? { owner: source.owner, repo: source.repo, ref: source.ref } : null,
      );
      if (info?.kind === "not_found") return t("setup.bookError.notFound", { location: info.location });
      if (info?.kind === "other") return `${b.book}: ${info.detail}`;
      return t("preferences.scriptureLanes.bookRetryHint", { book: b.book });
    }
    return `${b.book}: ${b.status}`;
  };

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {label}
          </Typography>
          {source && <Chip size="small" label={`${source.owner}/${source.repo}`} />}
        </Stack>

        <Typography variant="body2" color="text.secondary">
          {t("setup.replacementIntro")}
        </Typography>

        {laneState.replacementRequired && !replacementJobId && (
          <Box>
            <Button variant="contained" onClick={openConfirm} disabled={starting || !pendingTarget}>
              {starting ? <CircularProgress size={16} color="inherit" /> : t("setup.replacementStart")}
            </Button>
          </Box>
        )}

        {activated && (
          <Stack spacing={1}>
            {(modeStatus === "confirming" || modeStatus === "idle") && (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="body2">{t("setup.laneModeConfirming")}</Typography>
              </Stack>
            )}
            {modeStatus === "confirmed" && (
              <Alert severity="success" variant="outlined">
                {t("setup.laneModeConfirmed", { mode: modeLabel })}
              </Alert>
            )}
            {modeStatus === "error" && (
              <Alert
                severity="error"
                action={
                  <Button color="inherit" size="small" onClick={() => void confirmMode()}>
                    {t("setup.upstreamOrgRetry")}
                  </Button>
                }
              >
                {t("setup.laneModeRetryError", { lane: label, mode: modeLabel })}
              </Alert>
            )}
          </Stack>
        )}

        {replacementJobId && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              {spinning && <CircularProgress size={16} />}
              <Typography variant="body2">
                {jobStatus
                  ? t(`preferences.scriptureLanes.jobStatus.${jobStatus}`)
                  : t("preferences.scriptureLanes.jobRunning")}
              </Typography>
              {jobStatus === "ready" && (
                <Button size="small" variant="contained" onClick={handleActivate} disabled={activating}>
                  {activating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.activate")}
                </Button>
              )}
            </Stack>

            {actionable && (
              <Alert severity="warning" variant="outlined">
                {t("setup.replacementActionRequired")}
              </Alert>
            )}

            {jobBooks.length > 0 && (
              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  {t("preferences.scriptureLanes.booksProgress", {
                    done: jobBooks.length - pendingBooks.length,
                    total: jobBooks.length,
                  })}
                </Typography>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {jobBooks.map((b) => {
                    const retryable = b.status === "retryable_error" || b.status === "failed";
                    const color =
                      b.status === "artifact_ok"
                        ? "success"
                        : retryable
                          ? "error"
                          : b.status === "absent_authorized"
                            ? "default"
                            : "warning";
                    return (
                      <Tooltip key={b.book} title={bookTooltip(b)}>
                        <Chip
                          size="small"
                          color={color}
                          variant={b.status === "artifact_ok" ? "filled" : "outlined"}
                          label={busyBook === b.book ? `${b.book}…` : b.book}
                          onClick={retryable && busyBook !== b.book ? () => void handleRetryBook(b.book) : undefined}
                          onDelete={retryable && busyBook !== b.book ? () => void handleWaiveBook(b.book) : undefined}
                        />
                      </Tooltip>
                    );
                  })}
                </Box>
              </Stack>
            )}
          </Stack>
        )}

        {error && (
          <Alert severity="error" onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
      </Stack>

      {/* Second confirmation (distinct from Apply) — item 9. */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("setup.replacementConfirmTitle", { lane: label })}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {source && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {t("setup.replacementConfirmSource", { owner: source.owner, repo: source.repo })}
              </Typography>
            )}
            <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
              {t("setup.replacementConfirmWarning")}
            </Alert>
            {affectedBooks == null ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="body2">{t("setup.replacementConfirmLoadingBooks")}</Typography>
              </Stack>
            ) : affectedBooks.length > 0 ? (
              <>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {t("setup.replacementConfirmBooksSelectLead", { count: affectedBooks.length })}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mb: 0.75 }}>
                  <Button size="small" onClick={() => setSelectedBooks(new Set(affectedBooks))}>
                    {t("setup.replacementConfirmBooksSelectAll")}
                  </Button>
                  <Button size="small" onClick={() => setSelectedBooks(new Set())}>
                    {t("setup.replacementConfirmBooksSelectNone")}
                  </Button>
                </Stack>
                <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                  {affectedBooks.map((b) => {
                    const selected = selectedBooks.has(b);
                    const stat = bookStats[b];
                    const edited = stat?.edited ?? 0;
                    const label = edited > 0 ? `${bookName(b)} (${b}) ✎${edited}` : `${bookName(b)} (${b})`;
                    return (
                      <Tooltip
                        key={b}
                        title={
                          stat ? t("setup.replacementConfirmBookStatTip", { verses: stat.verses, edited }) : ""
                        }
                      >
                        <Chip
                          size="small"
                          label={label}
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
                <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                  {t("setup.replacementConfirmBooksSummary", {
                    // NOT `replace`: that is i18next's reserved substitution-data
                    // option, and a truthy value silently blanks every placeholder.
                    replacing: affectedBooks.filter((b) => selectedBooks.has(b)).length,
                    keep: affectedBooks.filter((b) => !selectedBooks.has(b)).length,
                  })}
                </Typography>
                {affectedBooks.some((b) => (bookStats[b]?.edited ?? 0) > 0) && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
                    {t("setup.replacementConfirmBooksEditedHint")}
                  </Typography>
                )}
              </>
            ) : (
              <Typography variant="body2">{t("setup.replacementConfirmNoBookList")}</Typography>
            )}
          </DialogContentText>
          <FormControlLabel
            sx={{ mt: 1.5 }}
            control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />}
            label={t("setup.replacementConfirmAck")}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t("setup.back")}</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!ack || affectedBooks == null}
            onClick={handleConfirmStart}
          >
            {t("setup.replacementConfirmButton")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
