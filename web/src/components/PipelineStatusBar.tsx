// Pill summarizing active AI pipeline runs. Rendered inline in the TopBar's
// status cluster (via the `pipelineStatus` prop) so it sits in normal flow
// instead of floating over the resource-column tab strip; the popover opens
// downward from the chip. Click expands to list each job with its state,
// current skill, and (for resumable failures) a Retry button. The transient
// start/complete toast rides a bottom-center Snackbar, matching the import
// toasts in TopBar.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Chip,
  Stack,
  Tooltip,
  Popover,
  Typography,
  Button,
  Divider,
  CircularProgress,
  Snackbar,
  Alert,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import PauseCircleOutlineIcon from "@mui/icons-material/PauseCircleOutline";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import BlockIcon from "@mui/icons-material/Block";
import type { PipelineJobRow, PipelineState } from "../sync/api";
import { pipelineStore } from "../sync/pipelineStore";
import { currentPipelineUserId } from "../sync/pipelineSession";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

// A job requested by another user. The shared queue shows everyone's active /
// queued runs, but only the owner can cancel one, and its requester is
// attributed in the row. Nothing is foreign until the user id is bound.
function isForeign(job: PipelineJobRow): boolean {
  const me = currentPipelineUserId();
  return me != null && job.user_id !== me;
}

// Whether this bar would render anything for the given jobs: any active,
// queued, recently-done (<24h) or failed run. Shared with StatusIndicator so
// its "No AI pipelines running" idle text can't disagree with whether the
// embedded PipelineStatusBar actually shows something. `nowSec` is injected so
// callers computing other time-derived values reuse one clock read.
export function pipelineHasAnything(jobs: PipelineJobRow[], nowSec = Math.floor(Date.now() / 1000)): boolean {
  return jobs.some(
    (j) =>
      j.state === "running" ||
      j.state === "dispatching" ||
      j.state === "queued" ||
      j.state === "paused_for_outage" ||
      j.state === "paused_for_usage_limit" ||
      j.state === "failed" ||
      (j.state === "done" && nowSec - j.updated_at < 24 * 3600),
  );
}

const TYPE_LABEL: Record<PipelineJobRow["pipeline_type"], string> = {
  generate: "pipeline.generateUltUst",
  notes: "pipeline.translationNotes",
  tqs: "pipeline.translationQuestions",
  translate: "translation.translateChapter",
};

// Coarse stage milestones reported via current.skill. For generate, the
// contract documents the 3 transitions explicitly. For notes/tqs the
// skill name comes through directly; we list the ones we expect so the
// stepper has something to anchor to. Unknown skills fall through and
// the bar still shows the pipeline as "running" without a position.
const STAGES: Record<PipelineJobRow["pipeline_type"], string[]> = {
  generate: ["initial-pipeline", "align-all-parallel", "door43-push"],
  notes: ["tn-writer", "parallel-batch", "repo-insert"],
  tqs: ["tq-writer", "repo-insert"],
  // translate skill milestones aren't finalized upstream (INTEGRATION.md §5);
  // unknown skills fall through and the bar still shows "running".
  translate: ["tn-translate", "repo-insert"],
};

const STAGE_LABEL: Record<string, string> = {
  "initial-pipeline": "pipeline.stageDraft",
  "align-all-parallel": "pipeline.stageAlign",
  "door43-push": "pipeline.stagePush",
  "tn-writer": "pipeline.stageDraft",
  "parallel-batch": "pipeline.stageBatch",
  "tq-writer": "pipeline.stageDraft",
  "repo-insert": "pipeline.stagePush",
};

function StageBar({
  pipelineType,
  currentSkill,
  state,
}: {
  pipelineType: PipelineJobRow["pipeline_type"];
  currentSkill: string | null;
  state: PipelineState;
}) {
  const { t } = useTranslation();
  const stages = STAGES[pipelineType];
  if (!stages || stages.length === 0) return null;
  const currentIdx = currentSkill ? stages.indexOf(currentSkill) : -1;
  // Treat "done" as all stages complete; unknown current_skill while
  // running falls through to "no stage highlighted" (-1) without making
  // the bar lie.
  return (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5, ml: 3 }}>
      {stages.map((skill, i) => {
        const isDone = state === "done" || (currentIdx >= 0 && i < currentIdx);
        const isCurrent = state !== "done" && i === currentIdx;
        return (
          <Stack key={skill} direction="row" alignItems="center" spacing={0.5}>
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                bgcolor: isDone
                  ? "success.main"
                  : isCurrent
                    ? "primary.main"
                    : "transparent",
                border: 1,
                borderColor: isDone
                  ? "success.main"
                  : isCurrent
                    ? "primary.main"
                    : "divider",
              }}
            />
            <Typography
              variant="caption"
              sx={{
                fontSize: 10,
                fontFamily: "monospace",
                color: isCurrent
                  ? "primary.main"
                  : isDone
                    ? "success.main"
                    : "text.disabled",
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {STAGE_LABEL[skill] ? t(STAGE_LABEL[skill]) : skill}
            </Typography>
            {i < stages.length - 1 && (
              <Box
                sx={{
                  width: 10,
                  height: 1,
                  bgcolor: isDone ? "success.main" : "divider",
                }}
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

// Upstream jobIds are UUIDs (~36 chars); a short tail is plenty to
// distinguish two sibling jobs without bloating the panel.
function shortJobId(jobId: string): string {
  return jobId.length > 8 ? `…${jobId.slice(-6)}` : jobId;
}

function relativeTime(seconds: number, t: TFunction): string {
  const diff = Math.floor(Date.now() / 1000) - seconds;
  if (diff < 60) return t("appShell.time.secondsAgo", { n: diff });
  if (diff < 3600) return t("appShell.time.minutesShortAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("appShell.time.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("appShell.time.daysAgo", { n: Math.floor(diff / 86400) });
}

// Key names, not text — translated at render so a language switch repaints.
const STATE_LABEL: Record<PipelineState, string> = {
  queued: "appShell.pipelineState.queued",
  dispatching: "appShell.pipelineState.dispatching",
  running: "appShell.pipelineState.running",
  paused_for_outage: "appShell.pipelineState.pausedOutage",
  paused_for_usage_limit: "appShell.pipelineState.pausedUsageLimit",
  failed: "appShell.pipelineState.failed",
  cancelled: "appShell.pipelineState.cancelled",
  done: "appShell.pipelineState.done",
};

function stateLabel(state: PipelineState, t: TFunction): string {
  return t(STATE_LABEL[state]);
}

function StateIcon({ state }: { state: PipelineState }) {
  if (state === "queued") return <HourglassEmptyIcon fontSize="small" color="disabled" />;
  if (state === "dispatching" || state === "running") return <CircularProgress size={14} />;
  if (state === "done") return <CheckCircleOutlineIcon fontSize="small" color="success" />;
  if (state === "failed") return <ErrorOutlineIcon fontSize="small" color="error" />;
  if (state === "cancelled") return <BlockIcon fontSize="small" color="disabled" />;
  return <PauseCircleOutlineIcon fontSize="small" color="warning" />;
}

export interface ToastMsg {
  id: number;
  text: string;
  kind: "success" | "error" | "info";
  // Optional inline button (e.g. "Save & refresh" after an AI apply lands new
  // rows in the open chapter). When present, the toast stays until dismissed or
  // the action is taken rather than auto-expiring.
  action?: { label: string; onClick: () => void };
}

interface Props {
  toast?: ToastMsg | null;
  onToastClear?: () => void;
  // The merged TopBar "Status" indicator mounts an always-live instance with
  // hideChip so the Snackbar toast keeps firing regardless of whether the
  // Status popover is open; the popover's own "AI pipelines" row mounts a
  // second, normal instance (no toast — the always-live one already owns
  // that) for the interactive running/queued/failed job list. Known trade-off:
  // the "already running — let me point you at it" auto-focus (see
  // pipelineStore.onFocusRequest) needs a live chip to anchor to, so it only
  // fires from the popover-embedded instance while that popover is open.
  hideChip?: boolean;
}

export function PipelineStatusBar({ toast, onToastClear, hideChip }: Props = {}) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<PipelineJobRow[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // When pipelineStore.requestFocus(jobId) fires (e.g. on already_running),
  // we stash the request and let the next render — once hasAnything flips
  // true and the chip mounts — anchor the popover to the chip.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);

  // When the current job list arrived, in epoch seconds. Sampled here rather
  // than with Date.now() during render; the store emits a fresh array on every
  // change, so this is the same moment the "done in the last 24h" filter below
  // used to read the clock.
  const [jobsAtSec, setJobsAtSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(
    () =>
      pipelineStore.subscribe((list) => {
        setJobs(list);
        setJobsAtSec(Math.floor(Date.now() / 1000));
      }),
    [],
  );
  useEffect(
    () =>
      pipelineStore.onFocusRequest((jobId) => {
        setPendingFocus(jobId);
      }),
    [],
  );

  const { active, queued, doneRecent, failed } = useMemo(() => {
    return {
      // 'dispatching' counts as active — it's claimed the bot slot and locks
      // the chapter, same as running.
      active: jobs.filter(
        (j) =>
          j.state === "running" ||
          j.state === "dispatching" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit",
      ),
      queued: jobs.filter((j) => j.state === "queued"),
      doneRecent: jobs.filter((j) => j.state === "done" && jobsAtSec - j.updated_at < 24 * 3600),
      failed: jobs.filter((j) => j.state === "failed"),
    };
  }, [jobs, jobsAtSec]);

  const hasAnything = active.length + queued.length + doneRecent.length + failed.length > 0;

  // The user's own in-flight work, used to gate dismissal: another user's run
  // being active shouldn't stop you from clearing your own finished items.
  const ownActive = active.filter((j) => !isForeign(j));
  const ownQueued = queued.filter((j) => !isForeign(j));
  const canDismissResolved =
    ownActive.length === 0 && ownQueued.length === 0 && doneRecent.length + failed.length > 0;

  // Global queue context (the single running job, possibly another user's),
  // refreshed by the store on load/visibility. Drives the "running ahead" note
  // shown when the user has something waiting in line.
  const queueSummary = pipelineStore.getQueueSummary();

  // Map child job_id -> parent job_id. Used to render the reciprocal "after
  // <parent>" line under follow-up rows; the data is in place because the
  // parent row already carries follow_up_job_id pointing at the child.
  const parentByChildId = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of jobs) {
      if (j.follow_up_job_id) m.set(j.follow_up_job_id, j.job_id);
    }
    return m;
  }, [jobs]);

  // Resolve a pending focus request once the chip mounts. We can't anchor
  // earlier — Popover needs a real DOM node — and a pending focus from
  // PipelineMenu.start() races with React committing the new jobs state.
  useEffect(() => {
    if (!pendingFocus) return;
    if (!chipRef.current) return;
    if (!anchorEl) setAnchorEl(chipRef.current);
    setPendingFocus(null);
  }, [pendingFocus, hasAnything, anchorEl]);

  const cancel = async (job: PipelineJobRow) => {
    setCancelling(job.job_id);
    try {
      await pipelineStore.cancel(job.job_id);
    } catch {
      // The store re-polls on a 409 (already started) so the row reflects its
      // real state; other failures are transient — leave the row as-is.
    } finally {
      setCancelling(null);
    }
  };

  if (!hasAnything && !toast) return null;

  return (
    <>
      {hasAnything && !hideChip && (
        <Box ref={chipRef} sx={{ display: "inline-flex" }}>
          <Chip
            icon={<AutoAwesomeIcon />}
            label={
              active.length > 0
                ? `${t("pipeline.pipelinesRunning", { count: active.length })}${
                    queued.length > 0 ? ` · ${t("pipeline.queuedCount", { n: queued.length })}` : ""
                  }`
                : queued.length > 0
                  ? t("pipeline.queuedCount", { n: queued.length })
                  : failed.length > 0
                    ? t("pipeline.failedCount", { n: failed.length })
                    : t("pipeline.aiReadyToReview")
            }
            size="small"
            variant="outlined"
            color={
              active.length > 0
                ? "primary"
                : queued.length > 0
                  ? "default"
                  : failed.length > 0
                    ? "error"
                    : "success"
            }
            onClick={(e) => setAnchorEl(e.currentTarget)}
            // Dismissable once nothing is in flight — done and failed runs can
            // both be marked as seen. Running / queued states still need user
            // attention, so no delete icon there.
            onDelete={
              canDismissResolved
                ? () => {
                    pipelineStore.dismissResolved();
                    setAnchorEl(null);
                  }
                : undefined
            }
          />
        </Box>
      )}
      <Snackbar
        open={Boolean(toast)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        // Lifecycle is owned by Shell's 8s timer; only dismiss on the explicit
        // close action, not on click-away.
        onClose={(_, reason) => reason !== "clickaway" && onToastClear?.()}
      >
        {toast ? (
          <Alert
            severity={toast.kind}
            variant="filled"
            onClose={onToastClear}
            action={
              toast.action ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    toast.action?.onClick();
                    onToastClear?.();
                  }}
                >
                  {toast.action.label}
                </Button>
              ) : undefined
            }
          >
            {toast.text}
          </Alert>
        ) : undefined}
      </Snackbar>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Box sx={{ p: 1.5, minWidth: 320, maxWidth: 420 }}>
          <Typography variant="caption" color="text.secondary">
            {t("pipeline.aiPipelines")}
          </Typography>
          {queued.length > 0 && queueSummary?.activeJob && (
            <Typography
              variant="caption"
              color="text.secondary"
              display="block"
              sx={{ mt: 0.5, fontStyle: "italic" }}
            >
              {t("pipeline.onlyOneRuns")}{" "}
              {queueSummary.activeJob.started_by_username ?? t("pipeline.someone")} ·{" "}
              {t(TYPE_LABEL[queueSummary.activeJob.pipeline_type])}{" "}
              {queueSummary.activeJob.book} {queueSummary.activeJob.start_chapter}
              {` (${relativeTime(queueSummary.activeJob.updated_at, t)})`}
            </Typography>
          )}
          <Stack spacing={1} sx={{ mt: 1 }}>
            {jobs.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t("pipeline.noPipelinesRunning")}
              </Typography>
            )}
            {jobs.map((job, i) => {
              const parentId = parentByChildId.get(job.job_id);
              const childId = job.follow_up_job_id;
              return (
              <Box key={job.job_id}>
                {i > 0 && <Divider sx={{ my: 1 }} />}
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ pt: 0.5 }}>
                    <StateIcon state={job.state} />
                  </Box>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      {t(TYPE_LABEL[job.pipeline_type])} — {job.book} {job.start_chapter}
                      {job.end_chapter !== job.start_chapter ? `–${job.end_chapter}` : ""}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {stateLabel(job.state, t)}
                      {job.state === "queued" && job.queue_position
                        ? t("pipeline.queuePositionInLine", { position: job.queue_position })
                        : ""}
                      {job.current_skill && !STAGES[job.pipeline_type]?.includes(job.current_skill)
                        ? ` · ${job.current_skill}`
                        : ""}
                      {t("appShell.pipeline.updatedSuffix", { time: relativeTime(job.updated_at, t) })}
                    </Typography>
                    {isForeign(job) && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        {t("pipeline.requestedBy", { user: job.started_by_username ?? t("pipeline.anotherUser") })}
                      </Typography>
                    )}
                    {parentId && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        {t("pipeline.step2After", { id: shortJobId(parentId) })}
                      </Typography>
                    )}
                    {childId && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ fontStyle: "italic" }}>
                        {t("pipeline.step1FollowUp", { id: shortJobId(childId) })}
                      </Typography>
                    )}
                    {job.error_message && (
                      <Typography variant="caption" color="error" display="block">
                        {job.error_message}
                      </Typography>
                    )}
                  </Box>
                  {job.state === "queued" && !isForeign(job) && (
                    <Tooltip title={t("pipeline.removeFromQueueTooltip")}>
                      <span>
                        <Button
                          size="small"
                          color="inherit"
                          onClick={() => void cancel(job)}
                          disabled={cancelling === job.job_id}
                          startIcon={cancelling === job.job_id ? <CircularProgress size={12} /> : undefined}
                        >
                          {t("pipeline.cancel")}
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                  {(job.state === "failed" || job.state === "cancelled") && (
                    <Tooltip title={t("pipeline.markAsSeenTooltip")}>
                      <Button size="small" color="inherit" onClick={() => pipelineStore.dismiss(job.job_id)}>
                        {t("pipeline.dismiss")}
                      </Button>
                    </Tooltip>
                  )}
                </Stack>
                {job.state !== "queued" && job.state !== "dispatching" && job.state !== "cancelled" && (
                  <StageBar
                    pipelineType={job.pipeline_type}
                    currentSkill={job.current_skill}
                    state={job.state}
                  />
                )}
                {job.state === "done" && (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 3, mt: 0.5 }} display="block">
                    {t("pipeline.aiOutputApplied", { book: job.book, chapter: job.start_chapter })}
                  </Typography>
                )}
              </Box>
              );
            })}
          </Stack>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
            <Button
              size="small"
              disabled={refreshing || jobs.length === 0}
              startIcon={refreshing ? <CircularProgress size={12} /> : undefined}
              onClick={async () => {
                setRefreshing(true);
                try {
                  // Reconcile the whole shared queue (own + others' jobs);
                  // per-id refresh can't touch other users' runs.
                  await pipelineStore.reload();
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? t("pipeline.refreshing") : t("pipeline.refresh")}
            </Button>
            {canDismissResolved && (
              <Button
                size="small"
                color="inherit"
                onClick={() => {
                  pipelineStore.dismissResolved();
                  setAnchorEl(null);
                }}
              >
                {t("pipeline.dismissAll")}
              </Button>
            )}
          </Stack>
        </Box>
      </Popover>
    </>
  );
}
