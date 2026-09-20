// l1-ai: Lead — run AI pipelines. Port of docs/flows/ui/l1-ai.html. The menu,
// confirm dialog, and 409 "already running" dialog are NOT re-implemented here
// — they're the real, already-tested PipelineMenu (web/src/components/
// PipelineMenu.tsx), which already does mode-gating (isTranslationProject),
// models "Translate questions" as pipelineType "translate" +
// translate.resourceType:"tq" (the real backend shape — see
// docs/flows/05-functional-preview-findings.md §2.13), and shows the real 409
// conflict dialog from the server's `existing` payload.
//
// This file supplies what the mockup's menu doesn't: the book/chapter picker,
// the chapter-locked / drafts-ready banners, the "AI not configured" calm
// state (detected the same side-effect-free way the mockup does — a GET
// against a bogus jobId; GET /api/pipelines/:jobId is gated by BT_API_TOKEN,
// GET /api/pipelines the list is NOT — §2.17), and the two run tables driven
// live off pipelineStore.

import { useEffect, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { LockBanner, ReadyBanner } from "./FlowBanners";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { PipelineMenu } from "../PipelineMenu";
import { AiServiceSection } from "../AiServiceSection";
import { pipelineStore, type PipelineJob } from "../../sync/pipelineStore";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import {
  api,
  ApiError,
  type BookListEntry,
  type PipelineErrorKind,
  type PipelineState,
  type PipelineType,
} from "../../sync/api";

export interface AiScreenProps extends FlowScreenContext {}

const DEFAULT_BOOK = "OBA";
const DEFAULT_CHAPTER = 1;

// Real backend enum (api/src/pipelines.ts PIPELINE_TYPES). PipelineJobRow
// carries no resourceType field, so a "translate" job that was actually a tQ
// translate can't be told apart from a tN one here — both get this one
// generic label, matching PipelineStatusBar.tsx's TYPE_LABEL (same
// limitation, same choice, not new).
const TYPE_LABEL_KEY: Record<PipelineType, string> = {
  generate: "pipeline.generateUltUst",
  notes: "pipeline.writeTranslationNotes",
  tqs: "pipeline.writeTranslationQuestions",
  translate: "translation.translateChapter",
};

function typeLabel(type: PipelineType, t: TFunction): string {
  const key = TYPE_LABEL_KEY[type] as string | undefined;
  return key ? t(key) : type;
}

// Friendly PipelineErrorKind copy — mirrors docs/flows/ui/l1-ai.html's
// ERROR_COPY verbatim (same enum, same intent: no bare enum string in front
// of a translator).
const ERROR_COPY_KEY: Record<PipelineErrorKind, string> = {
  transient_outage: "aiStudio.errors.transient_outage",
  auth_error: "aiStudio.errors.auth_error",
  usage_limit: "aiStudio.errors.usage_limit",
  sdk_error: "aiStudio.errors.sdk_error",
  non_success_result: "aiStudio.errors.non_success_result",
  missing_output: "aiStudio.errors.missing_output",
  stale_output: "aiStudio.errors.stale_output",
  interrupted: "aiStudio.errors.interrupted",
  import_failed: "aiStudio.errors.import_failed",
};

function errorCopy(kind: PipelineErrorKind | null, t: TFunction): string {
  const key = kind ? (ERROR_COPY_KEY[kind] as string | undefined) : undefined;
  return key ? t(key) : t("aiStudio.unrecognizedError", { kind });
}

// Human-readable display of the PipelineState enum. The enum values themselves
// (used in logic and sent to the API) are never translated — only what the
// user sees.
const STATE_LABEL_KEY: Record<PipelineState, string> = {
  queued: "aiStudio.status.queued",
  dispatching: "aiStudio.status.dispatching",
  running: "aiStudio.status.running",
  paused_for_outage: "aiStudio.status.paused_for_outage",
  paused_for_usage_limit: "aiStudio.status.paused_for_usage_limit",
  failed: "aiStudio.status.failed",
  cancelled: "aiStudio.status.cancelled",
  done: "aiStudio.status.done",
};

function stateLabel(state: PipelineState, t: TFunction): string {
  const key = STATE_LABEL_KEY[state] as string | undefined;
  return key ? t(key) : state;
}

function scopeOf(job: PipelineJob, t: TFunction): string {
  if (!job.book) return typeLabel(job.pipeline_type, t); // article (tw/ta) jobs carry no book/chapter
  return job.start_chapter === job.end_chapter
    ? `${job.book} ${job.start_chapter}`
    : `${job.book} ${job.start_chapter}–${job.end_chapter}`;
}

function timeAgo(unixSeconds: number | null | undefined, t: TFunction): string {
  if (!unixSeconds) return "—";
  const deltaMs = Date.now() - unixSeconds * 1000;
  const mins = Math.round(deltaMs / 60000);
  if (mins < 1) return t("aiStudio.justNow");
  if (mins < 60) return t("aiStudio.minutesAgo", { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return t("aiStudio.hoursAgo", { count: hrs });
  return t("aiStudio.daysAgo", { count: Math.round(hrs / 24) });
}

function stateChipKind(state: PipelineState): "ok" | "warn" | "skip" {
  if (state === "done") return "ok";
  if (state === "failed") return "warn";
  return "skip"; // queued / dispatching / running / paused_* / cancelled
}

function progressText(job: PipelineJob, t: TFunction): string {
  if (job.state === "queued") {
    return job.queue_position != null
      ? t("aiStudio.inLine", { n: job.queue_position })
      : stateLabel("queued", t);
  }
  return job.current_status || job.current_skill || stateLabel(job.state, t);
}

export default function AiScreen({ role, me, onNavigate }: AiScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560: table rather than stacked cards

  const book = me?.lastBook || DEFAULT_BOOK;
  const chapter = me?.lastChapter || DEFAULT_CHAPTER;
  const verse = me?.lastVerse || 1;

  const cfg = useProjectConfig();
  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : t("aiStudio.workspace");

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState(false);
  const [pickedBook, setPickedBook] = useState<string>("");
  const [chapterInput, setChapterInput] = useState(String(chapter));
  const pickedChapter = Math.max(1, parseInt(chapterInput, 10) || 1);

  const [jobs, setJobs] = useState<PipelineJob[]>([]);
  const [jobsUnavailable, setJobsUnavailable] = useState(false);
  const [aiDisabled, setAiDisabled] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  // Real book list — GET /api/books returns only books actually imported into
  // this workspace. Defaults to the user's last book once loaded, if it's one
  // of the imported ones; otherwise the first imported book.
  useEffect(() => {
    let cancelled = false;
    api
      .getBooks()
      .then((res) => {
        if (cancelled) return;
        setBooks(res.books);
        setPickedBook((prev) => {
          if (prev) return prev;
          if (res.books.some((b) => b.book === book)) return book;
          return res.books[0]?.book ?? "";
        });
      })
      .catch(() => {
        if (!cancelled) setBooksError(true);
      });
    return () => {
      cancelled = true;
    };
    // book is only used as a one-time default seed, not a live dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pipelines are gated `requireEditor` server-side — a viewer gets a 403.
  // Treat that as "not visible for your role", not an error, and skip the
  // rest of the AI machinery for that role.
  useEffect(() => {
    if (role === "viewer") {
      setJobsUnavailable(true);
      return;
    }
    setJobsUnavailable(false);
    return pipelineStore.subscribe(setJobs);
  }, [role]);

  // Real, side-effect-free detection of the "AI not configured" state: GET
  // /api/pipelines/:jobId is gated by the same BT_API_TOKEN check as start —
  // a bogus id is safe to probe because the route is read-only and 503s
  // before any existence check (verified live, see 05-functional-preview-
  // findings.md §2.17). GET /api/pipelines (the list above) is NOT gated, so
  // the runs table keeps working either way.
  useEffect(() => {
    if (role === "viewer") return;
    let cancelled = false;
    api
      .pipelineStatus("__availability_probe__")
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          const body = err.body as { error?: string } | undefined;
          if (body?.error === "pipeline_api_disabled") setAiDisabled(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Drafts-ready banner for the currently-picked scope.
  useEffect(() => {
    if (!pickedBook || role === "viewer") {
      setPendingCount(0);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getPendingImports(pickedBook, pickedChapter, controller.signal)
        .then((res) => {
          if (!cancelled) setPendingCount(res.items.length);
        })
        .catch(() => {
          if (!cancelled) setPendingCount(0);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [pickedBook, pickedChapter, role]);

  // Chapter-locked banner for the currently-picked scope: a running/
  // dispatching job whose range covers it.
  const lockingJob = useMemo(
    () =>
      jobs.find(
        (j) =>
          j.book === pickedBook &&
          pickedChapter >= j.start_chapter &&
          pickedChapter <= j.end_chapter &&
          (j.state === "running" || j.state === "dispatching"),
      ) ?? null,
    [jobs, pickedBook, pickedChapter],
  );

  const failedCount = jobs.filter((j) => j.state === "failed").length;
  const dismissableJobs = jobs.filter(
    (j) => j.state === "done" || j.state === "failed" || j.state === "cancelled",
  );

  async function handleRetry(job: PipelineJob) {
    if (aiDisabled || retrying) return;
    setRetrying(job.job_id);
    const sessionKey = `retry-${job.pipeline_type}-${Date.now()}`;
    try {
      await pipelineStore.start({
        pipelineType: job.pipeline_type,
        ...(job.book ? { book: job.book, startChapter: job.start_chapter, endChapter: job.end_chapter } : {}),
        sessionKey,
      });
      setNotice(t("aiStudio.retryQueuedFor", { scope: scopeOf(job, t) }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) {
        setAiDisabled(true);
        setNotice(t("aiStudio.retryUnavailable"));
      } else if (e instanceof ApiError && e.status === 409) {
        setNotice(t("aiStudio.alreadyRunningElsewhere"));
      } else {
        setNotice(t("aiStudio.retryFailed"));
      }
    } finally {
      setRetrying(null);
    }
  }

  async function handleCancel(job: PipelineJob) {
    if (cancelling) return; // no double-submit while a cancel is in flight
    setCancelling(job.job_id);
    try {
      const res = await pipelineStore.cancel(job.job_id);
      if (!res.ok) setNotice(t("aiStudio.cancelTooLate"));
    } catch {
      // pipelineStore.cancel only handles 409 itself; 403/404/5xx/network
      // rethrow and must not become an unhandled rejection with a silent no-op.
      setNotice(t("aiStudio.cancelFailed"));
    } finally {
      setCancelling(null);
    }
  }

  function handleDismiss(job: PipelineJob) {
    pipelineStore.dismiss(job.job_id);
  }

  async function handleRefresh() {
    await pipelineStore.reload();
  }

  function handleDismissAll() {
    if (dismissableJobs.length === 0) return;
    pipelineStore.dismissResolved();
  }

  if (role === "viewer") {
    return (
      <AdminDesk current="ai">
        <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
          <AdminPageHeader eyebrow={eyebrow} title={t("aiStudio.title")} />
          <Typography color="text.secondary" sx={{ mt: 1 }}>
            {t("aiStudio.notVisibleForRole")}
          </Typography>
        </Box>
      </AdminDesk>
    );
  }

  return (
    <AdminDesk current="ai">
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2, pb: 8 }}>
        <AdminPageHeader
          eyebrow={eyebrow}
          title={t("aiStudio.title")}
          subtitle={t("aiStudio.subtitle")}
        />

      <Stack spacing={1} sx={{ mb: 2 }}>
        {aiDisabled && (
          <Alert severity="info" icon={<AutoAwesomeIcon fontSize="small" />}>
            <Typography sx={{ fontWeight: 700, fontSize: "0.9rem" }}>{t("aiStudio.notConfiguredTitle")}</Typography>
            <Typography variant="body2" sx={{ mt: 0.25 }}>
              {t("aiStudio.notConfiguredBodyBefore")}
              <code>BT_API_TOKEN</code>
              {t("aiStudio.notConfiguredBodyAfter")}
            </Typography>
          </Alert>
        )}
        {lockingJob && (
          <LockBanner
            pipelineType={lockingJob.pipeline_type}
            startedAt={lockingJob.created_at}
          />
        )}
        {pendingCount > 0 && (
          <ReadyBanner count={pendingCount} onReview={() => onNavigate(pickedBook, pickedChapter, verse)} />
        )}
        {jobsUnavailable && (
          <Typography variant="caption" color="text.secondary">
            {t("aiStudio.runStatusNotVisible")}
          </Typography>
        )}
      </Stack>

      <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" sx={{ mb: 2.5 }}>
        <Box sx={{ minWidth: 140 }}>
          <Typography variant="caption" component="label" htmlFor="ai-pick-book" sx={{ display: "block", mb: 0.5, color: "text.secondary" }}>
            {t("aiStudio.bookLabel")}
          </Typography>
          {books === null && !booksError ? (
            <Skeleton variant="rounded" width={140} height={40} />
          ) : (
            <Select
              id="ai-pick-book"
              size="small"
              value={pickedBook}
              onChange={(e) => setPickedBook(e.target.value)}
              displayEmpty
              sx={{ minWidth: 140 }}
              disabled={booksError || (books?.length ?? 0) === 0}
            >
              {books && books.length > 0 ? (
                books.map((b) => (
                  <MenuItem key={b.book} value={b.book}>
                    {b.book}
                  </MenuItem>
                ))
              ) : (
                <MenuItem value="">{booksError ? t("aiStudio.booksLoadFailed") : t("aiStudio.noBooksImported")}</MenuItem>
              )}
            </Select>
          )}
        </Box>
        <TextField
          label={t("aiStudio.chapterLabel")}
          size="small"
          value={chapterInput}
          onChange={(e) => setChapterInput(e.target.value.replace(/[^\d]/g, ""))}
          sx={{ width: 90 }}
          inputProps={{ inputMode: "numeric", pattern: "[0-9]*" }}
        />
        {pickedBook ? (
          <PipelineMenu
            book={pickedBook}
            chapter={pickedChapter}
            onMessage={setNotice}
            onImported={() => {
              void api
                .getPendingImports(pickedBook, pickedChapter)
                .then((res) => setPendingCount(res.items.length))
                .catch(() => {});
            }}
          />
        ) : (
          <Tooltip title={t("aiStudio.pickBookFirst")}>
            <span>
              <Button size="small" variant="outlined" startIcon={<AutoAwesomeIcon fontSize="small" />} disabled>
                {t("pipeline.aiButton")}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      <Box
        sx={{
          bgcolor: "background.paper",
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          boxShadow: 1,
          mb: 2.5,
          overflow: "hidden",
        }}
      >
        <Box sx={{ p: 2, borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="h6" sx={{ fontSize: "1rem" }}>
            {t("aiStudio.runsTitle")}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
            {t("aiStudio.runsExplainer")}
          </Typography>
        </Box>

        {jobsUnavailable ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {t("aiStudio.runStatusNotVisible")}
            </Typography>
          </Box>
        ) : jobs.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {t("aiStudio.noRuns")}
            </Typography>
          </Box>
        ) : isTabletUp ? (
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("aiStudio.colType")}</TableCell>
                  <TableCell>{t("aiStudio.colScope")}</TableCell>
                  <TableCell>{t("aiStudio.colState")}</TableCell>
                  <TableCell>{t("aiStudio.colProgress")}</TableCell>
                  <TableCell>{t("aiStudio.colStarted")}</TableCell>
                  <TableCell>{t("aiStudio.colRequestedBy")}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {jobs.map((job) => (
                  <JobRow
                    key={job.job_id}
                    job={job}
                    me={me}
                    aiDisabled={aiDisabled}
                    retrying={retrying === job.job_id}
                    cancelling={cancelling === job.job_id}
                    onRetry={() => void handleRetry(job)}
                    onCancel={() => void handleCancel(job)}
                    onDismiss={() => handleDismiss(job)}
                  />
                ))}
              </TableBody>
            </Table>
          </Box>
        ) : (
          <Stack divider={<Box sx={{ borderBottom: 1, borderColor: "divider" }} />}>
            {jobs.map((job) => (
              <JobCard
                key={job.job_id}
                job={job}
                me={me}
                aiDisabled={aiDisabled}
                retrying={retrying === job.job_id}
                cancelling={cancelling === job.job_id}
                onRetry={() => void handleRetry(job)}
                onCancel={() => void handleCancel(job)}
                onDismiss={() => handleDismiss(job)}
              />
            ))}
          </Stack>
        )}

        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}
        >
          <Typography variant="caption" color="text.secondary">
            {jobsUnavailable
              ? ""
              : t("aiStudio.jobCount", { count: jobs.length }) +
                (failedCount ? t("aiStudio.needsAttentionSuffix", { count: failedCount }) : "")}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button size="small" onClick={() => void handleRefresh()} disabled={jobsUnavailable}>
            {t("pipeline.refresh")}
          </Button>
          <Button size="small" onClick={handleDismissAll} disabled={jobsUnavailable || dismissableJobs.length === 0}>
            {t("pipeline.dismissAll")}
          </Button>
        </Stack>
      </Box>

      {/* AI service (provider / model / BYO key) — moved here from the admin
          Setup desk (#479) so configuring the AI and using it live on one
          screen. AiServiceSection is dependency-free by design and renders its
          own heading. Admin-only: AiScreen admits editors too (they run
          pipelines, requireEditor), but the AI-provider routes are
          requireAdmin — ungated, an editor would only collect 403s. */}
      {role === "admin" && (
        <Box
          sx={{
            bgcolor: "background.paper",
            border: 1,
            borderColor: "divider",
            borderRadius: 1.5,
            boxShadow: 1,
            overflow: "hidden",
            p: 2,
          }}
        >
          <AiServiceSection />
        </Box>
      )}

      <Snackbar open={Boolean(notice)} autoHideDuration={6000} onClose={() => setNotice(null)} message={notice ?? ""} />
      </Box>
    </AdminDesk>
  );
}

interface JobRowProps {
  job: PipelineJob;
  me: FlowScreenContext["me"];
  aiDisabled: boolean;
  retrying: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}

function isMine(job: PipelineJob, me: FlowScreenContext["me"]): boolean {
  return me != null && job.user_id === me.userId;
}

function requestedByLabel(job: PipelineJob, me: FlowScreenContext["me"], t: TFunction): string {
  if (isMine(job, me)) return t("aiStudio.you");
  return t("aiStudio.requestedBy", { name: job.started_by_username || t("aiStudio.someoneElse") });
}

function JobRow({ job, me, aiDisabled, retrying, cancelling, onRetry, onCancel, onDismiss }: JobRowProps) {
  const { t } = useTranslation();
  const mine = isMine(job, me);
  return (
    <TableRow hover>
      <TableCell>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {typeLabel(job.pipeline_type, t)}
        </Typography>
      </TableCell>
      <TableCell>{scopeOf(job, t)}</TableCell>
      <TableCell>
        <FlowStatusChip kind={stateChipKind(job.state)} label={stateLabel(job.state, t)} />
      </TableCell>
      <TableCell sx={{ minWidth: 160 }}>
        {job.state === "failed" ? (
          <Box>
            <Typography
              variant="caption"
              sx={{ textDecoration: "line-through", color: "text.secondary", display: "block" }}
            >
              {job.error_kind ?? "unknown_error"}
            </Typography>
            <Typography variant="caption" color="warning.main" sx={{ display: "block" }}>
              {errorCopy(job.error_kind, t)}
            </Typography>
          </Box>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {progressText(job, t)}
          </Typography>
        )}
      </TableCell>
      <TableCell>
        <Typography variant="caption" color="text.secondary">
          {timeAgo(job.created_at, t)}
        </Typography>
      </TableCell>
      <TableCell>
        <Typography variant="caption" color="text.secondary">
          {requestedByLabel(job, me, t)}
        </Typography>
      </TableCell>
      <TableCell>
        <JobRowActions
          job={job}
          mine={mine}
          aiDisabled={aiDisabled}
          retrying={retrying}
          cancelling={cancelling}
          onRetry={onRetry}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </TableCell>
    </TableRow>
  );
}

function JobRowActions({
  job,
  mine,
  aiDisabled,
  retrying,
  cancelling,
  onRetry,
  onCancel,
  onDismiss,
}: {
  job: PipelineJob;
  mine: boolean;
  aiDisabled: boolean;
  retrying: boolean;
  cancelling: boolean;
  onRetry: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap">
      {job.state === "queued" && mine && (
        <Button
          size="small"
          onClick={onCancel}
          disabled={cancelling}
          startIcon={cancelling ? <CircularProgress size={12} /> : undefined}
        >
          {t("common.cancel")}
        </Button>
      )}
      {job.state === "failed" && mine && (
        <>
          <Tooltip
            title={
              aiDisabled
                ? t("aiStudio.notConfiguredTitle")
                : job.pipeline_type === "translate"
                  ? t("aiStudio.cantRetryTranslate")
                  : ""
            }
          >
            <span>
              <Button
                size="small"
                onClick={onRetry}
                disabled={aiDisabled || retrying || job.pipeline_type === "translate"}
                startIcon={retrying ? <CircularProgress size={12} /> : undefined}
              >
                {t("common.retry")}
              </Button>
            </span>
          </Tooltip>
          <Button size="small" color="inherit" onClick={onDismiss}>
            {t("pipeline.dismiss")}
          </Button>
        </>
      )}
      {(job.state === "cancelled" || job.state === "done") && (
        <Button size="small" color="inherit" onClick={onDismiss}>
          {t("pipeline.dismiss")}
        </Button>
      )}
    </Stack>
  );
}

function JobCard({ job, me, aiDisabled, retrying, cancelling, onRetry, onCancel, onDismiss }: JobRowProps) {
  const { t } = useTranslation();
  const mine = isMine(job, me);
  return (
    <Box sx={{ p: 1.75 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {typeLabel(job.pipeline_type, t)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {scopeOf(job, t)} · {timeAgo(job.created_at, t)} · {requestedByLabel(job, me, t)}
          </Typography>
        </Box>
        <FlowStatusChip kind={stateChipKind(job.state)} label={stateLabel(job.state, t)} />
      </Stack>
      <Box sx={{ mt: 1 }}>
        {job.state === "failed" ? (
          <Typography variant="caption" color="warning.main">
            {errorCopy(job.error_kind, t)}
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {progressText(job, t)}
          </Typography>
        )}
      </Box>
      <Box sx={{ mt: 1 }}>
        <JobRowActions
          job={job}
          mine={mine}
          aiDisabled={aiDisabled}
          retrying={retrying}
          cancelling={cancelling}
          onRetry={onRetry}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      </Box>
    </Box>
  );
}
