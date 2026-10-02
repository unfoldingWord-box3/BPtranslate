// i18n: user-visible strings use t() with keys under the `adminPages`
// namespace (en/ar values pending merge into web/src/i18n/locales/*.json).
//
// AdminWorkflowScreen — the redesigned admin "Workflow" screen, rendered inside
// the coordinator-owned AdminDesk chrome (route #/admin/workflow). Desktop-first
// per Benjamin's 2026-08-10 direction, translated from the published mockup
// artifact "Workflow · unfoldingWord Admin" into the MUI/sx idiom the flow
// screens use (TranslateNotesScreen is the token reference; Panel / table sx
// mirror AdminTeamScreen.tsx:170-272, the first desk screen to translate the
// artifact's .panel/.dtable primitives).
//
// ── What shipped vs. the mockup (honesty rule: Today only) ──────────────────
//
// The artifact tiers its five sections Today / Phase 2 / Later. Only the three
// "Today" sections are wired to real data; the 8-step rail is kept as
// explicitly DESCRIPTIVE chrome (see below). Verb → endpoint evidence:
//
//   * Pipeline job list    → pipelineStore.subscribe (web/src/sync/pipelineStore.ts:295)
//                            backed by GET /api/pipelines (api/src/pipelines.ts:1545,
//                            requireEditor; active+queued visible to all, terminal
//                            rows owner-scoped, foreign rows sanitized :1616-1626).
//                            The store polls every 120s (pipelineStore.ts:33,:210);
//                            Refresh calls pipelineStore.reload().
//   * Cancel a queued job  → pipelineStore.cancel (pipelineStore.ts:402) →
//                            POST /api/pipelines/:id/cancel (api/src/pipelines.ts:1671).
//                            Server accepts ONLY state === "queued" (:1684-1686)
//                            and only the owner's job, so the button renders only
//                            for own queued rows (same gate as ObserveScreen.tsx:767).
//   * Lane state (source, textReadOnly, alignmentWritable, pendingTarget,
//     replacement job id)  → api.getProjectConfig (web/src/sync/api.ts:1625) →
//                            GET /api/project-config (api/src/projectConfigRoutes.ts:28);
//                            laneState overlay from api/src/scriptureLane.ts:943-954.
//                            Fetched FRESH here (not useProjectConfig) because
//                            lanePatch CAS-checks configRevision — the hook's
//                            localStorage cache would hand us a stale revision.
//   * Text read-only /
//     alignment writable   → api.lanePatch (web/src/sync/api.ts:2238) →
//                            PATCH /api/project-config/lanes/:lane
//                            (api/src/scriptureLaneRoutes.ts:374, requireAdmin,
//                            409 config_revision_mismatch :393-398, 409 lane_frozen
//                            :402). Behind a confirm dialog — flipping textReadOnly
//                            blocks/unblocks every scripture edit in the lane
//                            (assertLaneWritable, api/src/scriptureLane.ts:422-430).
//   * Replacement job view → api.laneGetJob (web/src/sync/api.ts:2192) →
//                            GET /api/project-config/lanes/:lane/replacements/:jobId
//                            (api/src/scriptureLaneRoutes.ts:217). Polled at 5s only
//                            while reserved/staging (BooksLanePanel.tsx:190-218 is
//                            the 3s precedent; this is a monitoring desk, not the
//                            staging driver, so it polls a little slower).
//   * Activate replacement → api.laneActivate (web/src/sync/api.ts:2232) →
//                            POST .../replacements/:jobId/activate
//                            (api/src/scriptureLaneRoutes.ts:282, requireAdmin).
//                            Enabled only on status === "ready", behind a confirm
//                            dialog with an explicit acknowledgement checkbox —
//                            the existing surfaces fire it bare (BooksLanePanel.tsx:305),
//                            but source activation swaps what translators read, so
//                            this screen adds the confirm step deliberately.
//                            Fencing token = crypto.randomUUID(), same as
//                            BooksLanePanel.tsx:305.
//   * Export history       → GET /api/exports?limit=12 (api/src/exports.ts:83,
//                            requireAdmin), via api.exportsList(12).
//   * Run export now       → POST /api/exports/run (api/src/exports.ts:37,
//                            requireAdmin, 202 {id,status} :72; manual runs leave
//                            validateAndMerge unset — no auto-merge — unlike the
//                            05:30 cron, api/src/index.ts:388). Behind a confirm
//                            dialog. Double-submit within the same second collides
//                            into the server's 409 workflow_create_failed
//                            (deterministic workflowRunId, exports.ts:18-20).
//   * Check run status     → GET /api/exports/instance/:id (api/src/exports.ts:114)
//                            — only valid for the id just returned by /run;
//                            export_snapshots rows don't store instance ids
//                            (ObserveScreen.tsx:714-720 documents the same gap).
//
// Omitted from the mockup, and why:
//   * The 8 steps' package counts, current-step highlighting, and click-to-
//     configure — there is NO step-state model anywhere in the API (the
//     ObserveScreen header's "Workflow stages → no backend" note, docs/flows/
//     02-architecture.md D2). The rail renders as labeled DESCRIPTIVE chrome
//     with zero counts rather than fake ones.
//   * Step settings panel  — Phase 2 in the artifact ("nothing here is enforced
//     by the app yet"); proposal panels must not ship inert.
//   * Pipeline "Retry"     — NO retry endpoint exists in api/src (verified:
//     the only pipeline "retry" anywhere is AiScreen.tsx:246-269 fabricating a
//     fresh POST /api/pipelines/start with a new sessionKey, which can't retry
//     translate jobs). Hidden here rather than faked; future wiring = the same
//     re-submission AiScreen does, or a real retry route.
//   * Pipeline "Rows touched" column — no such field on PipelineJobRow
//     (api.ts:1386-1434); output_json isn't parsed into row counts (Phase 1,
//     pipelineStore.ts:15-16). Progress (current_status/skill, queue position)
//     is shown instead — that data is real.
//   * "Stage replacement" form (URL input, per-book keep/replace, Stage button)
//     — the endpoints exist (laneValidate/laneAffectedBooks/laneStartReplacement)
//     but the full guarded flow (verify URL → affected-books diff → per-book
//     checklist → ack) already ships in PreferencesWorkspace.tsx:534-628 and
//     BooksLanePanel.tsx:228-305. Duplicating a THIRD copy of the most dangerous
//     admin flow in the app was judged conservative-wrong; this screen links the
//     reader to where staging starts and shows the resulting job honestly.
//     Future: extract a shared LaneReplacementDriver-style component (note the
//     existing web/src/components/LaneReplacementDriver.tsx is dead code — never
//     rendered) and mount it here.
//   * Cancel / Back out / per-book Retry / Waive on the replacement job —
//     real endpoints (scriptureLaneRoutes.ts:228-359) but they belong to the
//     staging driver surfaces above; this desk shows state and offers only the
//     one verb a "ready" job is waiting for (Activate).
//   * "Hold publishing while final validation is open" switch — the artifact
//     itself labels it Phase 2 ("saves a preference with no effect today").
//     No preference endpoint for it exists; omitted, not faked.
//
// RTL: logical properties only (paddingInline/Block, borderBlockEnd,
// marginInlineStart, textAlign:start). Wide tables sit in their own
// overflow-x:auto wrapper so the page body never scrolls horizontally.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormLabel,
  Link,
  MenuItem,
  Radio,
  RadioGroup,
  Snackbar,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import RefreshIcon from "@mui/icons-material/Refresh";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import { pipelineStore, type PipelineJob } from "../../sync/pipelineStore";
import {
  api,
  ApiError,
  type BookListEntry,
  type ExportRunResource,
  type ExportSnapshot,
  type LanePublicState,
  type LaneReplacementJobResponse,
  type ProjectConfig,
} from "../../sync/api";
import { bookName } from "../../lib/bookNames";
import { formatEpochSecondsDateTime } from "../../lib/formatDate";
import { parseChapterRange } from "../../lib/refParser";

export interface AdminWorkflowScreenProps extends FlowScreenContext {}

const INSPIRE = "#31ADE3";
const INSPIRE_DEEP = "#1B84B8";
const OCEAN = "#014263";

// ── formatting helpers ───────────────────────────────────────────────────────

function fmtDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  return formatEpochSecondsDateTime(unixSeconds) || "—";
}

// ── the 8 steps (descriptive only — no backend state, see header) ───────────

// i18n key names only — translated at render via t().
const STEPS: Array<{ nameKey: string; blurbKey: string }> = [
  { nameKey: "adminPages.workflow.stepDraft", blurbKey: "adminPages.workflow.stepDraftBlurb" },
  { nameKey: "adminPages.workflow.stepPeerCheck", blurbKey: "adminPages.workflow.stepPeerCheckBlurb" },
  { nameKey: "adminPages.workflow.stepSourceCheck", blurbKey: "adminPages.workflow.stepSourceCheckBlurb" },
  { nameKey: "adminPages.workflow.stepAlign", blurbKey: "adminPages.workflow.stepAlignBlurb" },
  {
    nameKey: "adminPages.workflow.stepTranslateResources",
    blurbKey: "adminPages.workflow.stepTranslateResourcesBlurb",
  },
  { nameKey: "adminPages.workflow.stepHarmonize", blurbKey: "adminPages.workflow.stepHarmonizeBlurb" },
  {
    nameKey: "adminPages.workflow.stepFinalValidation",
    blurbKey: "adminPages.workflow.stepFinalValidationBlurb",
  },
  { nameKey: "adminPages.workflow.stepPublish", blurbKey: "adminPages.workflow.stepPublishBlurb" },
];

// ── shared chrome (Panel / table sx — mirrors AdminTeamScreen.tsx:170-272) ──

function Panel({
  title,
  chip,
  sub,
  topAction,
  flush,
  children,
  foot,
}: {
  title: string;
  chip?: ReactNode;
  sub?: string;
  topAction?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  return (
    <Box
      component="section"
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        boxShadow: dark
          ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
          : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
        overflow: "hidden",
        mb: 2,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1.5,
          paddingInline: 2,
          paddingBlock: 1.5,
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          {title}
        </Typography>
        {chip}
        {topAction && <Box sx={{ marginInlineStart: "auto" }}>{topAction}</Box>}
        {sub && (
          <Typography variant="body2" color="text.secondary" sx={{ width: "100%", mt: 0.25 }}>
            {sub}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: flush ? 0 : 2 }}>{children}</Box>
      {foot && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.5,
            paddingInline: 2,
            paddingBlock: 1.25,
            borderBlockStart: "1px solid",
            borderColor: "divider",
            bgcolor: "action.hover",
            fontSize: "0.8125rem",
            color: "text.secondary",
          }}
        >
          {foot}
        </Box>
      )}
    </Box>
  );
}

const thSx = {
  position: "sticky" as const,
  insetBlockStart: 0,
  zIndex: 2,
  bgcolor: "action.hover",
  textAlign: "start" as const,
  fontSize: "0.6875rem",
  fontWeight: 700,
  letterSpacing: "0.07em",
  textTransform: "uppercase" as const,
  color: "text.secondary",
  paddingBlock: 1.125,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  whiteSpace: "nowrap" as const,
};

const tdSx = {
  paddingBlock: 1.375,
  paddingInline: 1.75,
  borderBlockEnd: "1px solid",
  borderColor: "divider",
  verticalAlign: "middle" as const,
};

// Key/value definition rows (the artifact's .kv).
function Kv({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
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
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: "contents" }}>
          <Box component="dt" sx={{ color: "text.secondary" }}>
            {k}
          </Box>
          <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere" }}>
            {v}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// Lane replacement lifecycle strip (the artifact's .lifecycle). Renders the
// four forward states; failed/cancelled render as a chip instead (they aren't
// positions on the forward path).
const LIFECYCLE_STEPS = ["reserved", "staging", "ready", "completed"] as const;

// Display labels for the lifecycle statuses — the status values themselves are
// API enums and stay untranslated in logic.
const LIFECYCLE_LABEL_KEYS: Record<(typeof LIFECYCLE_STEPS)[number], string> = {
  reserved: "adminPages.workflow.lifecycleReserved",
  staging: "adminPages.workflow.lifecycleStaging",
  ready: "adminPages.workflow.lifecycleReady",
  completed: "adminPages.workflow.lifecycleCompleted",
};

function LifecycleStrip({ status }: { status: string }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { ok, skip } = theme.palette.flows;
  const curIdx = (LIFECYCLE_STEPS as readonly string[]).indexOf(status);
  if (curIdx === -1) {
    return <FlowStatusChip kind="warn" label={t("adminPages.workflow.replacementStatusChip", { status })} />;
  }
  return (
    <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", rowGap: 0.5 }}>
      {LIFECYCLE_STEPS.map((s, i) => {
        const done = i < curIdx;
        const current = i === curIdx;
        return (
          <Box key={s} sx={{ display: "flex", alignItems: "center" }}>
            {i > 0 && (
              <Box
                sx={{
                  width: 24,
                  height: 2,
                  bgcolor: i <= curIdx ? ok.ink : "divider",
                  marginInline: 0.75,
                  flex: "none",
                }}
              />
            )}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
              <Box
                sx={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  flex: "none",
                  bgcolor: done ? ok.ink : current ? INSPIRE : "background.paper",
                  border: "2px solid",
                  borderColor: done ? ok.ink : current ? INSPIRE : skip.ink,
                }}
              />
              <Typography
                component="span"
                sx={{
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  color: current ? INSPIRE_DEEP : "text.secondary",
                }}
              >
                {t(LIFECYCLE_LABEL_KEYS[s])}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Terminal-OK book statuses during a replacement (api/src/scriptureLaneReplacement.ts:585-589).
const BOOK_OK_STATUSES = new Set(["artifact_ok", "carried_forward", "absent_authorized"]);
const BOOK_FAILED_STATUSES = new Set(["retryable_error", "failed"]);

// The nightly export records one synthetic snapshot per run under book/resource
// "CONTEXT"/"ctx" (exportWorkflow.ts) — the translation-context pack that seeds
// AI drafting, not a published book. Rendered raw it reads as "CONTEXT · ctx",
// which means nothing to a partner; give it a human label instead.
const CONTEXT_SNAPSHOT_BOOK = "CONTEXT";
function snapshotTargetLabel(book: string, resource: string, contextLabel: string): string {
  return book === CONTEXT_SNAPSHOT_BOOK ? contextLabel : `${book} · ${resource}`;
}

// ── export scope (resource + chapter range) ──────────────────────────────────

type ExportRunResourceOption = "all" | ExportRunResource;
type ExportRunMode = "merge" | "overwrite";
const EXPORT_RESOURCE_OPTIONS: ExportRunResourceOption[] = ["all", "tn", "tq", "twl", "ult", "ust"];
// Chapter scoping is a server-side restriction (api/src/exports.ts) — only
// these three resources are per-verse rows a chapter range can slice.
const CHAPTER_SCOPABLE_RESOURCES = new Set<ExportRunResourceOption>(["tn", "tq", "twl"]);

interface ChapterScope {
  chapterStart?: number;
  chapterEnd?: number;
}

// Empty input means "whole book" (ok, no scope). Non-empty input is parsed
// with the same helper the AI pipeline's chapter-range field uses
// (refParser.ts) — the returned book is ignored, since the book here comes
// from the separate book select, not from this field.
function parseChapterScope(input: string, book: string): { ok: true; scope: ChapterScope } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, scope: {} };
  const parsed = parseChapterRange(trimmed, book);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, scope: { chapterStart: parsed.range.startChapter, chapterEnd: parsed.range.endChapter } };
}

function ExportScopeFields({
  book,
  resource,
  onResourceChange,
  chapterInput,
  onChapterInputChange,
  shrinkOverride,
  onShrinkOverrideChange,
  mode,
  onModeChange,
  disabled,
}: {
  book: string;
  resource: ExportRunResourceOption;
  onResourceChange: (r: ExportRunResourceOption) => void;
  chapterInput: string;
  onChapterInputChange: (v: string) => void;
  shrinkOverride: boolean;
  onShrinkOverrideChange: (v: boolean) => void;
  mode: ExportRunMode;
  onModeChange: (v: ExportRunMode) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const chapterAllowed = book !== "all" && CHAPTER_SCOPABLE_RESOURCES.has(resource);
  const chapterProvided = chapterInput.trim() !== "";
  const chapterScope = chapterAllowed ? parseChapterScope(chapterInput, book) : null;

  let helperText: string;
  let fieldError = false;
  if (!chapterAllowed) {
    helperText = t("adminPages.workflow.chapterScopeUnavailableHint");
  } else if (!chapterProvided) {
    helperText = t("adminPages.workflow.chapterScopeWholeBookHint");
  } else if (chapterScope && !chapterScope.ok) {
    fieldError = true;
    helperText = chapterScope.error;
  } else if (chapterScope && chapterScope.ok) {
    const { chapterStart, chapterEnd } = chapterScope.scope;
    helperText =
      chapterStart === chapterEnd
        ? t("adminPages.workflow.chapterScopeSingle", { chapter: chapterStart })
        : t("adminPages.workflow.chapterScopeRange", { start: chapterStart, end: chapterEnd });
  } else {
    helperText = "";
  }

  return (
    <>
      <TextField
        select
        fullWidth
        size="small"
        label={t("adminPages.workflow.resourceScopeLabel")}
        value={resource}
        disabled={disabled}
        onChange={(e) => onResourceChange(e.target.value as ExportRunResourceOption)}
        sx={{ mt: 2 }}
      >
        {EXPORT_RESOURCE_OPTIONS.map((r) => (
          <MenuItem key={r} value={r}>
            {r === "all" ? t("adminPages.workflow.resourceAllOption") : r}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        fullWidth
        size="small"
        label={t("adminPages.workflow.chapterScopeLabel")}
        placeholder={t("adminPages.workflow.chapterScopePlaceholder")}
        value={chapterInput}
        disabled={disabled || !chapterAllowed}
        onChange={(e) => onChapterInputChange(e.target.value.replace(/[^\d-]/g, ""))}
        error={fieldError}
        helperText={helperText}
        inputProps={{ inputMode: "numeric", pattern: "[0-9-]*" }}
        sx={{ mt: 2 }}
      />
      {chapterAllowed && chapterProvided && (
        <>
          <FormLabel component="legend" sx={{ mt: 1.5, fontSize: "0.8125rem" }}>
            {t("adminPages.workflow.exportModeLabel")}
          </FormLabel>
          <RadioGroup
            value={mode}
            onChange={(e) => onModeChange(e.target.value as ExportRunMode)}
            sx={{ mt: 0.25 }}
          >
            <FormControlLabel
              value="merge"
              disabled={disabled}
              control={<Radio size="small" />}
              label={
                <Box>
                  <Typography variant="body2">{t("adminPages.workflow.exportModeMergeLabel")}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {t("adminPages.workflow.exportModeMergeHelp")}
                  </Typography>
                </Box>
              }
              sx={{ alignItems: "flex-start", mt: 0.5 }}
            />
            <FormControlLabel
              value="overwrite"
              disabled={disabled}
              control={<Radio size="small" />}
              label={
                <Box>
                  <Typography variant="body2">{t("adminPages.workflow.exportModeOverwriteLabel")}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                    {t("adminPages.workflow.exportModeOverwriteHelp")}
                  </Typography>
                </Box>
              }
              sx={{ alignItems: "flex-start", mt: 0.5 }}
            />
          </RadioGroup>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                checked={shrinkOverride}
                disabled={disabled}
                onChange={(e) => onShrinkOverrideChange(e.target.checked)}
              />
            }
            label={<Typography variant="body2">{t("adminPages.workflow.chapterScopeShrinkOverrideLabel")}</Typography>}
          />
        </>
      )}
    </>
  );
}

// ── screen ───────────────────────────────────────────────────────────────────

type LaneKey = "lit" | "sim";
const LANES: LaneKey[] = ["lit", "sim"];

// Load errors are stored as i18n key + params and translated at render, so
// (a) the message live-updates on language switch and (b) the load callbacks
// don't depend on `t` — t's identity changes per language, and having it in
// the dep arrays refired the fetches on every language switch.
interface LoadErrorRef {
  key: string;
  params?: Record<string, unknown>;
}

export default function AdminWorkflowScreen({ role, me }: AdminWorkflowScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";

  const isAdmin = role === "admin";

  // ── state ──
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const [cfgError, setCfgError] = useState<LoadErrorRef | null>(null);

  const [jobs, setJobs] = useState<PipelineJob[]>([]);
  const [pipelineRefreshing, setPipelineRefreshing] = useState(false);

  const [laneJobs, setLaneJobs] = useState<Partial<Record<LaneKey, LaneReplacementJobResponse>>>({});
  const [laneBusy, setLaneBusy] = useState<LaneKey | null>(null);

  const [snapshots, setSnapshots] = useState<ExportSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = useState<LoadErrorRef | null>(null);
  const [runInfo, setRunInfo] = useState<{ id: string; status: string } | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [instanceStatus, setInstanceStatus] = useState<string | null>(null);

  // Confirm dialogs — every mutating verb on this screen goes through one.
  const [confirmToggle, setConfirmToggle] = useState<{
    lane: LaneKey;
    field: "textReadOnly" | "alignmentWritable";
    next: boolean;
  } | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<{ lane: LaneKey; jobId: string } | null>(null);
  const [activateAck, setActivateAck] = useState(false);
  const [confirmRun, setConfirmRun] = useState(false);
  const [exportBook, setExportBook] = useState<string>("all");
  const [exportBooks, setExportBooks] = useState<BookListEntry[] | null>(null);
  const [exportResource, setExportResource] = useState<ExportRunResourceOption>("all");
  const [exportChapterInput, setExportChapterInput] = useState("");
  const [exportShrinkOverride, setExportShrinkOverride] = useState(false);
  const [exportMode, setExportMode] = useState<ExportRunMode>("merge");

  const [msg, setMsg] = useState<string | null>(null);

  // ── loads ──

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.getProjectConfig();
      setCfg(res.config);
      setCfgError(null);
    } catch (e) {
      setCfgError(
        e instanceof ApiError
          ? { key: "adminPages.workflow.configLoadFailedHttp", params: { status: e.status } }
          : { key: "adminPages.workflow.configLoadFailed" },
      );
    }
  }, []);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await api.exportsList(12);
      setSnapshots(res.snapshots);
      setSnapshotsError(null);
    } catch (e) {
      setSnapshots(null);
      setSnapshotsError(
        e instanceof ApiError && e.status === 403
          ? { key: "adminPages.workflow.exportHistoryAdminOnly" }
          : { key: "adminPages.workflow.exportHistoryLoadFailed" },
      );
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadConfig();
    void loadSnapshots();
  }, [isAdmin, loadConfig, loadSnapshots]);

  // Live pipeline jobs: the store handles list + 120s polling + visibility.
  useEffect(() => {
    if (!isAdmin) return;
    return pipelineStore.subscribe(setJobs);
  }, [isAdmin]);

  // Replacement job fetch + slow poll while a lane is staging.
  const litJobId = cfg?.laneState?.lit.replacementJobId ?? null;
  const simJobId = cfg?.laneState?.sim.replacementJobId ?? null;
  useEffect(() => {
    if (!isAdmin) return;
    const targets: Array<{ lane: LaneKey; jobId: string }> = [];
    if (litJobId) targets.push({ lane: "lit", jobId: litJobId });
    if (simJobId) targets.push({ lane: "sim", jobId: simJobId });
    if (targets.length === 0) {
      setLaneJobs({});
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const fetchAll = async () => {
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            return [t.lane, await api.laneGetJob(t.lane, t.jobId)] as const;
          } catch {
            return [t.lane, null] as const; // transient / 404 — leave prior value
          }
        }),
      );
      if (!alive) return;
      let stillMoving = false;
      for (const [, res] of results) {
        if (res && (res.job.status === "reserved" || res.job.status === "staging")) stillMoving = true;
      }
      setLaneJobs((prev) => {
        const next = { ...prev };
        for (const [lane, res] of results) {
          if (res) next[lane] = res;
        }
        return next;
      });
      if (!stillMoving && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    void fetchAll();
    timer = setInterval(() => void fetchAll(), 5000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [isAdmin, litJobId, simJobId]);

  // ── verbs ──

  const handleToggleConfirmed = async () => {
    if (!confirmToggle || !cfg?.laneState) return;
    const { lane, field, next } = confirmToggle;
    const state = cfg.laneState[lane];
    setLaneBusy(lane);
    try {
      const patch = field === "textReadOnly" ? { textReadOnly: next } : { alignmentWritable: next };
      const res = await api.lanePatch(lane, state.configRevision, patch);
      setCfg((prev) =>
        prev?.laneState ? { ...prev, laneState: { ...prev.laneState, [lane]: res.laneState } } : prev,
      );
      setMsg(
        field === "textReadOnly"
          ? next
            ? t("adminPages.workflow.msgTextReadOnly")
            : t("adminPages.workflow.msgTextEditingEnabled")
          : next
            ? t("adminPages.workflow.msgAlignmentEnabled")
            : t("adminPages.workflow.msgAlignmentReadOnly"),
      );
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      if (body?.error === "config_revision_mismatch") {
        setMsg(t("adminPages.workflow.msgRevisionMismatch"));
        await loadConfig();
      } else if (body?.error === "lane_frozen") {
        setMsg(t("adminPages.workflow.msgLaneFrozen"));
      } else {
        setMsg(
          e instanceof ApiError
            ? t("adminPages.workflow.msgUpdateFailedHttp", { status: e.status })
            : t("adminPages.workflow.msgUpdateFailed"),
        );
      }
    } finally {
      setLaneBusy(null);
      setConfirmToggle(null);
    }
  };

  const handleActivateConfirmed = async () => {
    if (!confirmActivate) return;
    const { lane, jobId } = confirmActivate;
    setLaneBusy(lane);
    try {
      // Fencing token guards a split-brain export completing a stale render
      // after the flip (api.ts:2230-2231); same pattern as BooksLanePanel.tsx:305.
      await api.laneActivate(lane, jobId, crypto.randomUUID());
      setMsg(t("adminPages.workflow.msgReplacementActivated"));
      await loadConfig();
      try {
        const res = await api.laneGetJob(lane, jobId);
        setLaneJobs((prev) => ({ ...prev, [lane]: res }));
      } catch {
        /* job row may already be settled/pruned — config reload is the truth */
      }
    } catch (e) {
      setMsg(
        e instanceof ApiError
          ? t("adminPages.workflow.msgActivateFailedHttp", { status: e.status })
          : t("adminPages.workflow.msgActivateFailed"),
      );
    } finally {
      setLaneBusy(null);
      setConfirmActivate(null);
      setActivateAck(false);
    }
  };

  const handleOpenRunConfirm = () => {
    setExportBook("all");
    setExportResource("all");
    setExportChapterInput("");
    setExportShrinkOverride(false);
    setExportMode("merge");
    setConfirmRun(true);
    // Refetch on every open: a failed or stale list would otherwise stick
    // until remount (imports elsewhere add books while this screen is up).
    api
      .getBooks()
      .then((res) => setExportBooks(res.books))
      .catch(() => setExportBooks((cur) => cur ?? []));
  };

  // Chapter scoping is only meaningful for a specific book + tn/tq/twl (server
  // requires both — api/src/exports.ts). Recomputed from the same state
  // ExportScopeFields renders from, so the Run button's disabled state and the
  // submitted payload never disagree.
  const chapterScopeAllowed = exportBook !== "all" && CHAPTER_SCOPABLE_RESOURCES.has(exportResource);
  const exportChapterProvided = exportChapterInput.trim() !== "";
  const exportChapterScope = chapterScopeAllowed ? parseChapterScope(exportChapterInput, exportBook) : null;
  // Blocked only when chapter scope is actually allowed and the typed range
  // fails to parse. A stale chapter value left over from a book/resource combo
  // that no longer supports chapter scope can never block Run — the change
  // handlers below clear the field the moment it stops being allowed, and this
  // check is belt-and-braces in case anything else leaves a stale value behind.
  const chapterScopeBlocked =
    chapterScopeAllowed && exportChapterProvided && exportChapterScope != null && !exportChapterScope.ok;

  // Clears the chapter range (and its shrink-override) the instant a book or
  // resource change makes chapter scope unavailable, so the field can never be
  // left holding a value the user has no way to edit or clear (it disables
  // when scope isn't allowed) — see chapterScopeBlocked above.
  const handleExportBookChange = (next: string) => {
    setExportBook(next);
    if (!(next !== "all" && CHAPTER_SCOPABLE_RESOURCES.has(exportResource))) {
      setExportChapterInput("");
      setExportShrinkOverride(false);
      setExportMode("merge");
    }
  };

  const handleExportResourceChange = (next: ExportRunResourceOption) => {
    setExportResource(next);
    if (!(exportBook !== "all" && CHAPTER_SCOPABLE_RESOURCES.has(next))) {
      setExportChapterInput("");
      setExportShrinkOverride(false);
      setExportMode("merge");
    }
  };

  const handleExportChapterInputChange = (v: string) => {
    setExportChapterInput(v);
    if (v.trim() === "") {
      setExportShrinkOverride(false);
      setExportMode("merge");
    }
  };

  const handleRunConfirmed = async () => {
    setRunBusy(true);
    try {
      const opts: {
        book?: string;
        resource?: ExportRunResource;
        chapterStart?: number;
        chapterEnd?: number;
        shrinkOverride?: boolean;
        mode?: ExportRunMode;
      } = {};
      if (exportBook !== "all") opts.book = exportBook;
      if (exportResource !== "all") opts.resource = exportResource;
      if (chapterScopeAllowed && exportChapterProvided && exportChapterScope?.ok) {
        opts.chapterStart = exportChapterScope.scope.chapterStart;
        opts.chapterEnd = exportChapterScope.scope.chapterEnd;
        if (exportShrinkOverride) opts.shrinkOverride = true;
        opts.mode = exportMode;
      }
      const res = await api.exportsRun(Object.keys(opts).length > 0 ? opts : undefined);
      setRunInfo(res);
      setInstanceStatus(null);
      setMsg(t("adminPages.workflow.msgExportQueued", { id: res.id }));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      setMsg(
        body?.error === "workflow_create_failed"
          ? t("adminPages.workflow.msgExportRunExists")
          : body?.error === "chapter_scope_requires_book_and_resource"
            ? t("adminPages.workflow.msgChapterScopeRequiresBookAndResource")
            : body?.error === "chapter_scope_unsupported_resource"
              ? t("adminPages.workflow.msgChapterScopeUnsupportedResource")
              : body?.error === "invalid_chapter_range"
                ? t("adminPages.workflow.msgInvalidChapterRange")
                : body?.error === "overwrite_requires_chapter_scope"
                  ? t("adminPages.workflow.msgOverwriteRequiresChapterScope")
                  : e instanceof ApiError
                    ? t("adminPages.workflow.msgExportStartFailedHttp", { status: e.status })
                    : t("adminPages.workflow.msgExportStartFailed"),
      );
    } finally {
      setRunBusy(false);
      setConfirmRun(false);
    }
  };

  const handleCheckInstance = async () => {
    if (!runInfo) return;
    try {
      const res = await api.exportsInstance(runInfo.id);
      const s = res.status as { status?: string } | null;
      setInstanceStatus(typeof s?.status === "string" ? s.status : JSON.stringify(res.status));
    } catch {
      setInstanceStatus(t("adminPages.workflow.statusLookupFailed"));
    }
  };

  // ── derived ──

  const jobCounts = useMemo(() => {
    const c = { running: 0, queued: 0, paused: 0, failed: 0, done: 0 };
    for (const j of jobs) {
      if (j.state === "running" || j.state === "dispatching") c.running += 1;
      else if (j.state === "queued") c.queued += 1;
      else if (j.state === "paused_for_outage" || j.state === "paused_for_usage_limit") c.paused += 1;
      else if (j.state === "failed") c.failed += 1;
      else if (j.state === "done") c.done += 1;
    }
    return c;
  }, [jobs]);

  const lastCommitted = useMemo(() => {
    if (!snapshots || snapshots.length === 0) return null;
    return snapshots.reduce((a, b) => (b.committed_at > a.committed_at ? b : a));
  }, [snapshots]);

  if (!isAdmin) {
    return (
      <AdminDesk current="workflow">
        <Alert severity="info">{t("adminPages.workflow.adminOnlyAlert", { role })}</Alert>
      </AdminDesk>
    );
  }

  // ── lane card ──

  const laneCard = (lane: LaneKey) => {
    if (!cfg?.laneState) return null;
    const state: LanePublicState = cfg.laneState[lane];
    const label =
      state.config.label ||
      (lane === "lit"
        ? cfg.litLabel || t("adminPages.workflow.laneLiteral")
        : cfg.simLabel || t("adminPages.workflow.laneSimplified"));
    const src = state.config.source;
    const pending = state.pendingTarget;
    const job = laneJobs[lane]?.job ?? null;
    const books = laneJobs[lane]?.books ?? [];
    const okBooks = books.filter((b) => BOOK_OK_STATUSES.has(b.status));
    const failedBooks = books.filter((b) => BOOK_FAILED_STATUSES.has(b.status));
    const busy = laneBusy === lane;
    const frozen = state.replacementJobId != null;

    return (
      <Box
        key={lane}
        sx={{
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "9px",
          p: 2,
          minWidth: 0,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <Typography sx={{ fontWeight: 700, fontSize: "0.95rem" }}>{label}</Typography>
          <Typography component="span" sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
            {lane === "lit"
              ? t("adminPages.workflow.laneLiteralTag")
              : t("adminPages.workflow.laneSimplifiedTag")}
          </Typography>
          {state.replacementRequired && (
            <FlowStatusChip kind="warn" label={t("adminPages.workflow.replacementRequired")} />
          )}
          {frozen && <FlowStatusChip kind="edited" label={t("adminPages.workflow.replacementInProgress")} />}
        </Box>

        <Kv
          rows={[
            [t("adminPages.workflow.kvCurrentSource"), `${src.owner}/${src.repo} @ ${src.ref}`],
            [
              t("adminPages.workflow.kvExportTarget"),
              state.config.export
                ? `${state.config.export.owner}/${state.config.export.repo} (base ${state.config.export.baseRef})`
                : t("adminPages.workflow.kvNoExportConfigured"),
            ],
            ...(pending
              ? ([
                  [
                    t("adminPages.workflow.kvStagedTarget"),
                    `${pending.source.owner}/${pending.source.repo} @ ${pending.source.ref}`,
                  ],
                ] as Array<[string, ReactNode]>)
              : []),
          ]}
        />

        {/* Lane write toggles — real server enforcement (scriptureLane.ts:422-430). */}
        <Box sx={{ mt: 1.5 }}>
          {(
            [
              {
                field: "textReadOnly" as const,
                label: t("adminPages.workflow.toggleTextReadOnly"),
                help: t("adminPages.workflow.toggleTextReadOnlyHelp"),
                on: state.config.textReadOnly,
              },
              {
                field: "alignmentWritable" as const,
                label: t("adminPages.workflow.toggleAlignmentWritable"),
                help: t("adminPages.workflow.toggleAlignmentWritableHelp"),
                on: state.config.alignmentWritable,
              },
            ]
          ).map((row) => (
            <Box
              key={row.field}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 1.5,
                paddingBlock: 1,
                borderBlockStart: "1px solid",
                borderColor: "divider",
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: "0.875rem", fontWeight: 600 }}>{row.label}</Typography>
                <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{row.help}</Typography>
              </Box>
              <Tooltip
                title={
                  frozen
                    ? t("adminPages.workflow.toggleLockedTip")
                    : row.on
                      ? t("adminPages.workflow.toggleTurnOffTip")
                      : t("adminPages.workflow.toggleTurnOnTip")
                }
              >
                <Box component="span" sx={{ display: "inline-flex" }}>
                  <Switch
                    size="small"
                    checked={row.on}
                    disabled={busy || frozen}
                    onChange={() => setConfirmToggle({ lane, field: row.field, next: !row.on })}
                    inputProps={{ "aria-label": `${row.label} — ${label}` }}
                  />
                </Box>
              </Tooltip>
            </Box>
          ))}
        </Box>

        {/* Replacement job status — read-only view + the one verb a ready job waits for. */}
        {job && (
          <Box sx={{ mt: 1.5, paddingBlockStart: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }}>
            <Typography
              sx={{
                fontSize: "0.72rem",
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "text.secondary",
                mb: 1,
              }}
            >
              {t("adminPages.workflow.stagedReplacementHeading", { generation: job.generation })}
            </Typography>
            <LifecycleStrip status={job.status} />
            {books.length > 0 && (
              <Typography sx={{ fontSize: "0.8125rem", color: "text.secondary", mt: 1 }}>
                {t("adminPages.workflow.booksStaged", { ok: okBooks.length, total: books.length })}
                {failedBooks.length > 0 && (
                  <>
                    {" · "}
                    <Box component="span" sx={{ color: theme.palette.flows.warn.ink, fontWeight: 600 }}>
                      {t("adminPages.workflow.failedBooks", {
                        books: failedBooks.map((b) => b.book).join(", "),
                      })}
                    </Box>
                  </>
                )}
              </Typography>
            )}
            <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", mt: 0.5 }}>
              {job.status === "ready"
                ? t("adminPages.workflow.jobReadyHint")
                : job.status === "staging" || job.status === "reserved"
                  ? t("adminPages.workflow.jobStagingHint")
                  : job.status === "completed"
                    ? t("adminPages.workflow.jobCompletedHint")
                    : t("adminPages.workflow.jobNeedsAttentionHint")}
            </Typography>
            {job.status === "ready" && (
              <Button
                variant="contained"
                size="small"
                disabled={busy}
                onClick={() => setConfirmActivate({ lane, jobId: job.job_id })}
                sx={{ mt: 1.25, bgcolor: theme.palette.flows.ok.ink, fontWeight: 700 }}
              >
                {t("adminPages.workflow.activateButton")}
              </Button>
            )}
          </Box>
        )}
      </Box>
    );
  };

  return (
    <AdminDesk current="workflow">
      <AdminPageHeader
        eyebrow={
          cfg
            ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
            : t("adminPages.common.workspace")
        }
        title={t("adminPages.workflow.title")}
        subtitle={t("adminPages.workflow.subtitle")}
      />

      {/* ── The 8 steps — descriptive chrome only (no step-state backend) ── */}
      <Panel
        title={t("adminPages.workflow.stepsTitle")}
        chip={<FlowStatusChip kind="skip" label={t("adminPages.workflow.chipDescriptive")} />}
        sub={t("adminPages.workflow.stepsSub")}
        foot={
          <Typography variant="caption">
            {t("adminPages.workflow.stepsFoot")}
          </Typography>
        }
      >
        <Box
          role="list"
          aria-label={t("adminPages.workflow.stepsAria")}
          sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}
        >
          {STEPS.map((s, i) => (
            <Box
              key={s.nameKey}
              role="listitem"
              sx={{
                flex: "none",
                width: { xs: "100%", sm: "calc(50% - 4px)", md: "calc(25% - 6px)" },
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "action.hover",
                borderRadius: "9px",
                paddingBlock: 0.75,
                paddingInline: 1,
                display: "flex",
                flexDirection: "column",
                gap: 0.25,
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                <Box
                  aria-hidden
                  sx={{
                    width: 16,
                    height: 16,
                    borderRadius: "50%",
                    bgcolor: dark ? INSPIRE_DEEP : OCEAN,
                    color: "#fff",
                    fontSize: "0.625rem",
                    fontWeight: 700,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flex: "none",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {i + 1}
                </Box>
                <Typography sx={{ fontSize: "0.8125rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
                  {t(s.nameKey)}
                </Typography>
              </Box>
              <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t(s.blurbKey)}</Typography>
            </Box>
          ))}
        </Box>
      </Panel>

      {/* ── AI pipeline — live jobs from the shared store ── */}
      <Panel
        title={t("adminPages.workflow.aiPipelineTitle")}
        chip={<FlowStatusChip kind="ok" label={t("adminPages.workflow.chipLive")} />}
        sub={t("adminPages.workflow.aiPipelineSub")}
        topAction={
          <Button
            size="small"
            startIcon={pipelineRefreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
            disabled={pipelineRefreshing}
            onClick={() => {
              setPipelineRefreshing(true);
              void pipelineStore.reload().finally(() => setPipelineRefreshing(false));
            }}
          >
            {t("adminPages.common.refresh")}
          </Button>
        }
      >
        <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
          {t("adminPages.workflow.jobCounts", {
            running: jobCounts.running,
            queued: jobCounts.queued,
            paused: jobCounts.paused,
            failed: jobCounts.failed,
            done: jobCounts.done,
          })}
        </Typography>
        <Link component="button" type="button" variant="body2" onClick={() => { location.hash = "#/admin/ai"; }} sx={{ mt: 1, display: "inline-block" }}>
          {t("adminPages.workflow.openAiStudio")}
        </Link>
      </Panel>

      {/* ── Scripture source — real lane state, conservative verbs ── */}
      <Panel
        title={t("adminPages.workflow.scriptureSourceTitle")}
        chip={<FlowStatusChip kind="ok" label={t("adminPages.workflow.chipLive")} />}
        sub={t("adminPages.workflow.scriptureSourceSub")}
        foot={
          <>
            <Typography variant="caption">
              {cfg?.laneState
                ? [
                    cfg.laneState.lit.replacementJobId
                      ? t("adminPages.workflow.litReplacementInFlight")
                      : null,
                    cfg.laneState.sim.replacementJobId
                      ? t("adminPages.workflow.simReplacementInFlight")
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("adminPages.workflow.noReplacementInFlight")
                : "—"}
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Typography variant="caption">{t("adminPages.workflow.sourceSwapsGuarded")}</Typography>
          </>
        }
      >
        {cfgError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void loadConfig()}>
                {t("common.retry")}
              </Button>
            }
          >
            {t(cfgError.key, cfgError.params)}
          </Alert>
        ) : !cfg ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : !cfg.laneState ? (
          <Alert severity="info">
            {t("adminPages.workflow.noLaneStateReported")}
          </Alert>
        ) : (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" },
              gap: 2,
              alignItems: "start",
            }}
          >
            {LANES.map((lane) => laneCard(lane))}
          </Box>
        )}
      </Panel>

      {/* ── Publishing — nightly export, real history, manual run ── */}
      <Panel
        title={t("adminPages.workflow.publishingTitle")}
        chip={<FlowStatusChip kind="ok" label={t("adminPages.workflow.chipLive")} />}
        sub={t("adminPages.workflow.publishingSub")}
        foot={
          <>
            <Typography variant="caption">
              {lastCommitted
                ? t("adminPages.workflow.latestCommit", {
                    target: snapshotTargetLabel(
                      lastCommitted.book,
                      lastCommitted.resource,
                      t("adminPages.workflow.contextSnapshotLabel"),
                    ),
                    date: fmtDateTime(lastCommitted.committed_at),
                  })
                : snapshotsError
                  ? t("adminPages.workflow.historyUnavailable")
                  : t("adminPages.workflow.noExportHistory")}
            </Typography>
            <Box sx={{ marginInlineStart: "auto" }} />
            <Typography variant="caption">
              {me?.nightlyExportsEnabled
                ? t("adminPages.workflow.exportsRunAutomatically")
                : t("adminPages.workflow.nightlyExportsDisabled")}
            </Typography>
          </>
        }
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap", mb: 2 }}>
          <Button variant="contained" size="small" disabled={runBusy} onClick={handleOpenRunConfirm}>
            {t("adminPages.workflow.runExportNow")}
          </Button>
          {runInfo && (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                {t("adminPages.workflow.runStatusLine", {
                  id: runInfo.id,
                  status: instanceStatus ?? runInfo.status,
                })}
              </Typography>
              <Link component="button" type="button" variant="caption" onClick={() => void handleCheckInstance()}>
                {t("adminPages.workflow.checkStatus")}
              </Link>
              <Link component="button" type="button" variant="caption" onClick={() => void loadSnapshots()}>
                {t("adminPages.workflow.reloadHistory")}
              </Link>
            </>
          )}
        </Box>

        {snapshotsError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void loadSnapshots()}>
                {t("common.retry")}
              </Button>
            }
          >
            {t(snapshotsError.key, snapshotsError.params)}
          </Alert>
        ) : snapshots === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={22} />
          </Box>
        ) : snapshots.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("adminPages.workflow.noSnapshotsYet")}
          </Typography>
        ) : (
          <Box sx={{ overflowX: "auto", border: "1px solid", borderColor: "divider", borderRadius: "9px" }}>
            <Table size="small" sx={{ minWidth: 640 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={thSx}>{t("adminPages.workflow.colBookResource")}</TableCell>
                  <TableCell sx={thSx}>{t("adminPages.workflow.colState")}</TableCell>
                  <TableCell sx={{ ...thSx, textAlign: "end" }}>{t("adminPages.workflow.colRows")}</TableCell>
                  <TableCell sx={thSx}>{t("adminPages.workflow.colBranch")}</TableCell>
                  <TableCell sx={thSx}>{t("adminPages.workflow.colCommitted")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {snapshots.map((s) => {
                  const bad = Boolean(s.error || s.pr_error);
                  return (
                    <TableRow key={s.id} hover>
                      <TableCell sx={{ ...tdSx, fontWeight: 600, whiteSpace: "nowrap" }}>
                        {s.book === CONTEXT_SNAPSHOT_BOOK ? (
                          <Tooltip title={t("adminPages.workflow.contextSnapshotHint")}>
                            <span>{t("adminPages.workflow.contextSnapshotLabel")}</span>
                          </Tooltip>
                        ) : (
                          `${s.book} · ${s.resource}${
                            s.chapters ? ` · ${t("adminPages.workflow.chaptersSuffix", { chapters: s.chapters })}` : ""
                          }`
                        )}
                      </TableCell>
                      <TableCell sx={tdSx}>
                        <FlowStatusChip
                          kind={bad ? "warn" : "ok"}
                          label={
                            bad
                              ? t("adminPages.workflow.chipNeedsAttention")
                              : t("adminPages.workflow.chipCommitted")
                          }
                        />
                        {bad && (
                          <Typography
                            variant="caption"
                            sx={{ display: "block", color: theme.palette.flows.warn.ink, maxWidth: 320, overflowWrap: "anywhere" }}
                          >
                            {s.error ?? s.pr_error}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, textAlign: "end", fontVariantNumeric: "tabular-nums" }}>
                        {s.rows_exported}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary", whiteSpace: "nowrap" }}>
                        {s.branch ?? "—"}
                        {s.pr_number != null
                          ? ` · ${t("adminPages.workflow.prNumber", { number: s.pr_number })}`
                          : ""}
                      </TableCell>
                      <TableCell sx={{ ...tdSx, color: "text.secondary", whiteSpace: "nowrap" }}>
                        {fmtDateTime(s.committed_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </Panel>

      {/* ── confirm dialogs ── */}

      <Dialog open={confirmToggle != null} onClose={() => setConfirmToggle(null)}>
        <DialogTitle>
          {confirmToggle?.field === "textReadOnly"
            ? confirmToggle.next
              ? t("adminPages.workflow.confirmTextReadOnlyTitle")
              : t("adminPages.workflow.confirmTextEditTitle")
            : confirmToggle?.next
              ? t("adminPages.workflow.confirmAlignmentEditTitle")
              : t("adminPages.workflow.confirmAlignmentReadOnlyTitle")}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {confirmToggle?.field === "textReadOnly"
              ? confirmToggle.next
                ? t("adminPages.workflow.confirmTextReadOnlyBody")
                : t("adminPages.workflow.confirmTextEditBody")
              : confirmToggle?.next
                ? t("adminPages.workflow.confirmAlignmentEditBody")
                : t("adminPages.workflow.confirmAlignmentReadOnlyBody")}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmToggle(null)}>{t("adminPages.workflow.keepAsIs")}</Button>
          <Button variant="contained" disabled={laneBusy != null} onClick={() => void handleToggleConfirmed()}>
            {t("adminPages.workflow.applyButton")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={confirmActivate != null}
        onClose={() => {
          setConfirmActivate(null);
          setActivateAck(false);
        }}
      >
        <DialogTitle>{t("adminPages.workflow.activateDialogTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            {t("adminPages.workflow.activateDialogBody", {
              lane:
                confirmActivate?.lane === "sim"
                  ? t("adminPages.workflow.laneWordSimplified")
                  : t("adminPages.workflow.laneWordLiteral"),
            })}
          </Typography>
          <FormControlLabel
            control={<Checkbox checked={activateAck} onChange={(e) => setActivateAck(e.target.checked)} />}
            label={
              <Typography variant="body2">
                {t("adminPages.workflow.activateAckLabel")}
              </Typography>
            }
          />
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmActivate(null);
              setActivateAck(false);
            }}
          >
            {t("adminPages.workflow.notNow")}
          </Button>
          <Button
            variant="contained"
            disabled={!activateAck || laneBusy != null}
            onClick={() => void handleActivateConfirmed()}
            sx={{ bgcolor: theme.palette.flows.ok.ink, fontWeight: 700 }}
          >
            {t("adminPages.workflow.activateConfirmButton")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRun} onClose={() => setConfirmRun(false)}>
        <DialogTitle>{t("adminPages.workflow.runDialogTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {t("adminPages.workflow.runDialogBody")}
          </Typography>
          <TextField
            select
            fullWidth
            size="small"
            label={t("adminPages.workflow.exportScopeLabel")}
            value={exportBook}
            onChange={(e) => handleExportBookChange(e.target.value)}
            sx={{ mt: 2 }}
          >
            <MenuItem value="all">{t("adminPages.workflow.allBooks")}</MenuItem>
            {(exportBooks ?? []).map((b) => (
              <MenuItem key={b.book} value={b.book}>
                {bookName(b.book)}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            {t("adminPages.workflow.scopeHint")}
          </Typography>
          <ExportScopeFields
            book={exportBook}
            resource={exportResource}
            onResourceChange={handleExportResourceChange}
            chapterInput={exportChapterInput}
            onChapterInputChange={handleExportChapterInputChange}
            shrinkOverride={exportShrinkOverride}
            onShrinkOverrideChange={setExportShrinkOverride}
            mode={exportMode}
            onModeChange={setExportMode}
            disabled={runBusy}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmRun(false)}>{t("adminPages.workflow.notNow")}</Button>
          <Button variant="contained" disabled={runBusy || chapterScopeBlocked} onClick={() => void handleRunConfirmed()}>
            {chapterScopeAllowed && exportChapterProvided && exportMode === "overwrite"
              ? t("adminPages.workflow.runExportButtonOverwrite")
              : t("adminPages.workflow.runExportButton")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={msg != null}
        autoHideDuration={6000}
        onClose={() => setMsg(null)}
        message={msg ?? ""}
      />
    </AdminDesk>
  );
}
