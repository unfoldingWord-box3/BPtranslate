import { useEffect, useState } from "react";
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
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SaveIcon from "@mui/icons-material/Save";
import VisibilityIcon from "@mui/icons-material/Visibility";
import { useTranslation } from "react-i18next";
import {
  api,
  ApiError,
  isAdmin,
  isReadOnly,
  REGISTERS,
  type LanePublicState,
  type Register,
  type TranslationPrefs,
  type ProjectConfig,
  type Role,
  type LaneReplacementJobResponse,
  type LaneReplacementBook,
} from "../sync/api";
import {
  useProjectConfig,
  isTranslationProject,
  refreshProjectConfig,
} from "../hooks/useProjectConfig";
import {
  useTranslationPrefs,
  useExamples,
  useContextExportStatus,
} from "../hooks/useTranslationMemory";
import { currentPrefsFromConflict } from "../sync/prefsConflict";
import { bookName } from "../lib/bookNames";
import { MarkdownView } from "./MarkdownView";
import { defaultReplaceSelection } from "../lib/setupWizard";
import { SetupWizard } from "./SetupWizard";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { UserManagementSection } from "./UserManagementSection";
import { AiServiceSection } from "./AiServiceSection";
import { UiLanguageControl } from "./TopBar";
import { LocalizationSection } from "./LocalizationSection";
import { TerminologySection } from "./TerminologySection";
import { useSaveState } from "./useSaveState";

const EXPORT_STATUS_I18N_KEY: Record<string, string> = {
  running: "preferences.exportStatus.running",
  failed: "preferences.exportStatus.failed",
  queued: "preferences.exportStatus.queued",
  shrink_refused: "preferences.exportStatus.shrink_refused",
  no_content: "preferences.exportStatus.no_content",
  dry_run: "preferences.exportStatus.dry_run",
};

// Lane replacement/activation errors arrive from the server as bare codes. A few
// (e.g. `lane_busy:sim`) carry a `:detail` suffix; the split below tolerates that
// shape generically. Map known codes to translated copy; fall back to the raw
// string for anything unrecognized so nothing is hidden.
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

export type Section =
  | "brief"
  | "instructions"
  | "commonIssues"
  | "terminology"
  | "examples"
  | "setup"
  | "localization"
  | "users"
  | "aiService";
// Memory sections shown in the rail when a translation project + memory are
// available. "setup", "localization", "users", and "aiService" are admin-only
// and gated separately (they must show regardless of project type / memory),
// so they aren't listed.
export const SECTIONS: Section[] = ["brief", "instructions", "commonIssues", "terminology", "examples"];
// Every routable section (memory + the admin-only setup wizard, localization
// editor, user management, and AI service config) — used for hash-route
// validation in App.tsx.
export const ALL_SECTIONS: Section[] = [...SECTIONS, "setup", "localization", "users", "aiService"];

// Memory is now one long scrollable page; the rail items and deep links jump to
// a section by scrolling its wrapper (id `pref-sec-<key>`) into view rather than
// swapping panes. Guarded so a missing element (section not mounted / memory not
// available) is a no-op.
function scrollToSection(key: Section) {
  document.getElementById(`pref-sec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

interface Props {
  onNavigate: (section: Section) => void;
  onBack: () => void;
  section: Section;
  role: Role;
}

export function PreferencesWorkspace({ onNavigate, onBack, section, role }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);
  const memoryAvailable = isTranslation && !isReadOnly();
  // Lifted here (not per-section): Brief / Instructions / Common issues all
  // save against the SAME TranslationPrefs row/version. One shared hook means
  // every save reads the same `prefs.version` for If-Match, so a sibling
  // section's save can't leave another section holding a stale version that
  // self-409s on its very next save.
  const prefsState = useTranslationPrefs(memoryAvailable);

  // Deep-link / rail-driven anchor scroll: when the routed section is a memory
  // section and the long page is available, scroll it into view. Runs on mount
  // and whenever `section` changes (a rail click rewrites the hash → new prop).
  useEffect(() => {
    if (memoryAvailable && SECTIONS.includes(section)) {
      scrollToSection(section);
    }
  }, [section, memoryAvailable]);

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail ── */}
      <Box
        sx={{
          width: 240,
          flexShrink: 0,
          borderInlineEnd: "1px solid",
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Stack spacing={1} sx={{ p: 1.5, borderBottom: "1px solid", borderColor: "divider" }}>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Tooltip title={t("preferences.backToScripture")}>
              <IconButton
                size="small"
                onClick={onBack}
                sx={{ ml: -0.5 }}
              >
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>
              {t("preferences.title")}
            </Typography>
            <UiLanguageControl />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {cfg?.languageTitle ?? cfg?.languageName ?? cfg?.languageCode}
          </Typography>
          <ContextPackStatusControls />
        </Stack>
        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0, py: 0.5 }}>
          {memoryAvailable && SECTIONS.map((s) => {
            const selected = s === section;
            return (
              <Box
                key={s}
                onClick={() => {
                  onNavigate(s);
                  scrollToSection(s);
                }}
                sx={{
                  px: 1.5,
                  py: 0.9,
                  cursor: "pointer",
                  borderInlineStart: "3px solid",
                  borderColor: selected ? "primary.main" : "transparent",
                  bgcolor: selected ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: selected ? 700 : 400 }}>
                  {t(`preferences.section.${s}`)}
                </Typography>
              </Box>
            );
          })}
          {role === "admin" && (
            <Box
              onClick={() => onNavigate("setup")}
              sx={{
                px: 1.5,
                py: 0.9,
                cursor: "pointer",
                borderInlineStart: "3px solid",
                borderColor: section === "setup" ? "primary.main" : "transparent",
                bgcolor: section === "setup" ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: section === "setup" ? 700 : 400 }}>
                {t("setup.railLabel")}
              </Typography>
            </Box>
          )}
          {role === "admin" && (
            <Box
              onClick={() => onNavigate("localization")}
              sx={{
                px: 1.5,
                py: 0.9,
                cursor: "pointer",
                borderInlineStart: "3px solid",
                borderColor: section === "localization" ? "primary.main" : "transparent",
                bgcolor:
                  section === "localization" ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: section === "localization" ? 700 : 400 }}>
                {t("preferences.section.localization")}
              </Typography>
            </Box>
          )}
          {role === "admin" && (
            <Box
              onClick={() => onNavigate("users")}
              sx={{
                px: 1.5,
                py: 0.9,
                cursor: "pointer",
                borderInlineStart: "3px solid",
                borderColor: section === "users" ? "primary.main" : "transparent",
                bgcolor: section === "users" ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: section === "users" ? 700 : 400 }}>
                {t("preferences.section.users")}
              </Typography>
            </Box>
          )}
          {role === "admin" && (
            <Box
              onClick={() => onNavigate("aiService")}
              sx={{
                px: 1.5,
                py: 0.9,
                cursor: "pointer",
                borderInlineStart: "3px solid",
                borderColor: section === "aiService" ? "primary.main" : "transparent",
                bgcolor:
                  section === "aiService" ? (theme) => alpha(theme.palette.primary.main, 0.08) : "transparent",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: section === "aiService" ? 700 : 400 }}>
                {t("preferences.section.aiService")}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <Box sx={{ maxWidth: 900, mx: "auto", p: 3 }}>
          {/* Org switcher — the single canonical spot, visible to ALL roles.
              Non-admins have no Setup rail entry, so this is their only route to
              switch orgs; it self-fetches and renders read-only for single-org. */}
          <WorkspaceSwitcher variant="expanded" />
          {section === "setup" && role === "admin" ? (
            // Setup is the single home for project configuration — the Setup
            // wizard + scripture-lane controls live here (moved out of the
            // memory pages, where they used to repeat on every section).
            <Stack spacing={3}>
              <SetupWizard />
              {cfg && <ScriptureLanesSection cfg={cfg} />}
            </Stack>
          ) : section === "localization" && role === "admin" ? (
            <LocalizationSection />
          ) : section === "users" && role === "admin" ? (
            <UserManagementSection />
          ) : section === "aiService" && role === "admin" ? (
            <AiServiceSection />
          ) : cfg === null ? null : !isTranslation ? (
            <Alert severity="info" variant="outlined">
              {t("preferences.glOnly")}
            </Alert>
          ) : !memoryAvailable ? (
            <Alert severity="info" variant="outlined">
              {t("preferences.editorOnly")}
            </Alert>
          ) : (
            // One long scrollable memory page. Every section is always mounted
            // and anchored by `id="pref-sec-<key>"`; the rail items + deep links
            // scroll to these anchors (see scrollToSection). Each section renders
            // its own heading (preferences.section.*), which serves as the
            // visible anchor label — no duplicate heading needed.
            <Stack spacing={4} divider={<Divider />}>
              <Box id="pref-sec-brief" sx={{ scrollMarginTop: "16px" }}>
                <BriefSection prefsState={prefsState} />
              </Box>
              <Box id="pref-sec-instructions" sx={{ scrollMarginTop: "16px" }}>
                <InstructionsSection prefsState={prefsState} />
              </Box>
              <Box id="pref-sec-commonIssues" sx={{ scrollMarginTop: "16px" }}>
                <CommonIssuesSection prefsState={prefsState} />
              </Box>
              <Box id="pref-sec-terminology" sx={{ scrollMarginTop: "16px" }}>
                <TerminologySection direction={cfg?.direction ?? "ltr"} />
              </Box>
              <Box id="pref-sec-examples" sx={{ scrollMarginTop: "16px" }}>
                <ExamplesSection />
              </Box>
            </Stack>
          )}
        </Box>
      </Box>
    </Box>
  );
}

// ── Scripture Lanes admin section ──────────────────────────────────────────

function ScriptureLanesSection({ cfg }: { cfg: ProjectConfig }) {
  const { t } = useTranslation();
  const lanes: Array<{ key: "lit" | "sim"; label: string }> = [
    {
      key: "lit",
      label:
        (cfg.laneState?.lit?.config?.label && cfg.laneState.lit.config.label !== "LEGACY"
          ? cfg.laneState.lit.config.label
          : null) ||
        (cfg.laneState?.lit?.pendingTarget)?.label ||
        cfg.litLabel ||
        "ULT",
    },
    {
      key: "sim",
      label:
        (cfg.laneState?.sim?.config?.label && cfg.laneState.sim.config.label !== "LEGACY"
          ? cfg.laneState.sim.config.label
          : null) ||
        (cfg.laneState?.sim?.pendingTarget)?.label ||
        cfg.simLabel ||
        "UST",
    },
  ];

  return (
    <Box
      component="section"
      aria-labelledby="scripture-lanes-heading"
      sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, mb: 3 }}
    >
      <Typography id="scripture-lanes-heading" variant="h6" gutterBottom>
        {t("preferences.scriptureLanes.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("preferences.scriptureLanes.intro")}
      </Typography>
      <Stack spacing={2}>
          {lanes.map(({ key, label }) => (
          <LaneCard key={key} lane={key} label={label} cfg={cfg} />
        ))}
      </Stack>
    </Box>
  );
}

function LaneCard({ lane, label, cfg }: { lane: "lit" | "sim"; label: string; cfg: ProjectConfig }) {
  const { t } = useTranslation();
  const state: LanePublicState | undefined = cfg.laneState?.[lane];
  const [saving, setSaving] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [job, setJob] = useState<LaneReplacementJobResponse | null>(null);
  const [activating, setActivating] = useState(false);
  const [busyBook, setBusyBook] = useState<string | null>(null);
  // Confirm dialog + up-front source validation (issue #97).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [affectedBooks, setAffectedBooks] = useState<string[] | null>(null);
  // Per-book replace/keep selection (issue #94). A checked book is re-staged from
  // the new source; unchecking keeps its current content (carried forward).
  // Defaults to all-checked = replace all (unchanged whole-lane behavior).
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set());
  // Per-book existing-content stats (issue #94): verses + translator-edit count,
  // shown so the user can see which books hold edits before overwriting them.
  const [bookStats, setBookStats] = useState<Record<string, { verses: number; edited: number }>>({});
  const [pendingSource, setPendingSource] = useState<{ owner: string; repo: string; ref: string } | null>(null);
  const [impact, setImpact] = useState<{ books: number; verses: number } | null>(null);
  // A transient DCS content-check failure ("couldn't check") is retryable, not a
  // hard block — surfaced as a Retry affordance rather than a dead end.
  const [sourceRetryable, setSourceRetryable] = useState(false);
  // Set when the up-front source check couldn't confirm book presence (transient
  // DCS failure omitted `hasBooks`). Not a block (issue #97) — the confirm dialog
  // just cautions that presence is unverified; Cancel/back-out is the safety net.
  const [sourceUnverified, setSourceUnverified] = useState(false);

  const replacementJobId = state?.replacementJobId ?? null;

  // Poll the job while one is running so per-book staging status + readiness
  // stay live without a manual reload. Stops on a terminal status and refreshes
  // the shared config (which clears replacementJobId, so the poll won't re-arm).
  useEffect(() => {
    if (!replacementJobId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the job when replacementJobId goes away; without it the finished job's staging status stays on screen after the config no longer points at it.
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
          return; // terminal — stop polling
        }
      } catch {
        // transient — keep polling
      }
      if (!cancelled) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [lane, replacementJobId]);

  if (!state) {
    return (
      <Box sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {t("preferences.scriptureLanes.noState", { lane: label })}
        </Typography>
      </Box>
    );
  }

  const { config, replacementRequired, configRevision } = state;

  const handleToggle = async (field: "textReadOnly" | "alignmentWritable", value: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await api.lanePatch(lane, configRevision, { [field]: value });
      await refreshProjectConfig();
      setSuccessMsg(t("preferences.scriptureLanes.saved"));
      setTimeout(() => setSuccessMsg(null), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Step 1: validate the pasted URL up front (issue #97, item 3). Before staging
  // anything we confirm the source repo actually CONTAINS book files — an empty
  // scaffolding-only repo is a trap. `hasBooks: false` is a hard block; a missing
  // `hasBooks` (transient DCS content-API failure) is retryable, never a block.
  // This check lives ONLY in this migration tool, not the configure wizard (a
  // brand-new org's target repos are legitimately empty at configure time).
  const handleChangeSource = async () => {
    const url = sourceUrl.trim();
    if (!url) return;
    setValidating(true);
    setError(null);
    setSourceRetryable(false);
    setSourceUnverified(false);
    try {
      let hasBooks: boolean | undefined;
      try {
        const verified = await api.verifySource(url, { checkBooks: true });
        hasBooks = verified.hasBooks;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setError(t("preferences.scriptureLanes.sourceNoRepo"));
          return;
        }
        if (e instanceof ApiError && e.status === 400) {
          setError(t("preferences.scriptureLanes.sourceInvalidUrl"));
          return;
        }
        // 503 dcs_unavailable or network — transient, retryable (not a block).
        setSourceRetryable(true);
        setError(t("preferences.scriptureLanes.sourceCheckUnavailable"));
        return;
      }
      if (hasBooks === false) {
        setError(t("preferences.scriptureLanes.sourceNoBooks"));
        return;
      }
      // `hasBooks === undefined` means the content check couldn't complete (a
      // transient DCS content-API failure). Per issue #97 this is NOT a hard
      // block — only a confirmed `false` blocks. Proceed to the confirm dialog,
      // flagging the source as unverified so the dialog cautions the user; they
      // can back out with Cancel if the books turn out to be missing.
      setSourceUnverified(hasBooks === undefined);

      // Resolve the source and open the confirm dialog (item 1).
      const result = await api.laneValidate(lane, url);
      setPendingSource(result.source);
      setImpact({ books: result.impactBooks, verses: result.impactVerses });
      setAck(false);
      setAffectedBooks(null);
      setConfirmOpen(true);
      // List the exact books this lane will re-stage — from the lane's snapshot,
      // never getBooks(). Best-effort: on failure the dialog still confirms.
      api
        .laneAffectedBooks(lane)
        .then((r) => {
          setAffectedBooks(r.books);
          // Default: replace unedited books, KEEP books with work done (#94).
          setSelectedBooks(new Set(defaultReplaceSelection(r.books, r.stats)));
          setBookStats(r.stats ?? {});
        })
        .catch(() => {
          setAffectedBooks([]);
          setSelectedBooks(new Set());
          setBookStats({});
        });
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
    } finally {
      setValidating(false);
    }
  };

  // Step 2: user acknowledged the affected-books list → start the replacement.
  const handleConfirmStart = async () => {
    if (!pendingSource) return;
    // Never submit before the book list + stats have loaded: affectedBooks==null
    // would collapse to replaceBooks=undefined (replace all) and overwrite the
    // edited books the smart default keeps. The Confirm button is also disabled
    // in this state; this guard is the belt-and-suspenders.
    if (affectedBooks == null) return;
    setConfirmOpen(false);
    setValidating(true);
    setError(null);
    try {
      // When the lane is in BSOJ transitional freeze, the mandatory pending
      // target carries the correct AVD/NAV locks/export — do not inherit the
      // quarantined LEGACY config's false locks / null export.
      const base = replacementRequired && state.pendingTarget ? state.pendingTarget : config;
      const exportCfg =
        base.export ??
        ({
          owner: pendingSource.owner,
          repo: pendingSource.repo,
          baseRef: pendingSource.ref,
          branchPolicy: "contributor_book_branch" as const,
        });
      // Resolve the per-book selection. undefined → replace all (unchanged path);
      // a subset (including empty = keep everything) is sent explicitly and the
      // un-selected books are carried forward server-side.
      const books = affectedBooks ?? [];
      const allSelected = books.length > 0 && books.every((b) => selectedBooks.has(b));
      const replaceBooks =
        books.length === 0 || allSelected ? undefined : books.filter((b) => selectedBooks.has(b));
      await api.laneStartReplacement(lane, {
        label: base.label === "LEGACY" ? `${pendingSource.repo}` : base.label,
        source: pendingSource,
        export: exportCfg,
        textReadOnly: base.textReadOnly,
        alignmentWritable: base.alignmentWritable,
      }, true, replaceBooks);
      await refreshProjectConfig();
      setSourceUrl("");
      setSuccessMsg(t("preferences.scriptureLanes.replacementStarted"));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
    } finally {
      setValidating(false);
    }
  };

  // Full back-out (issue #97, item 2): abort the in-progress job AND revert the
  // lane to its prior source. Unlike the old cancel, this clears
  // replacement_required + pendingTarget so a lane stuck spinning on staging
  // failures is fully unfrozen — gen-1 content is never overwritten.
  const handleBackOut = async () => {
    if (!replacementJobId) return;
    if (!window.confirm(t("preferences.scriptureLanes.confirmBackOut"))) return;
    setSaving(true);
    setError(null);
    try {
      await api.laneBackOutJob(lane, replacementJobId);
      await refreshProjectConfig();
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
    } finally {
      setSaving(false);
    }
  };

  const handleActivate = async () => {
    if (!replacementJobId) return;
    setActivating(true);
    setError(null);
    try {
      // The fencing token guards against a split-brain export completing a
      // stale render after the flip; a fresh UUID per activation is sufficient.
      await api.laneActivate(lane, replacementJobId, crypto.randomUUID());
      await refreshProjectConfig();
      setSuccessMsg(t("preferences.scriptureLanes.replacementActivated"));
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (e) {
      const raw = e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : String(e);
      setError(laneErrorMessage(t, raw));
    } finally {
      setActivating(false);
    }
  };

  const handleRetryBook = async (book: string) => {
    if (!replacementJobId) return;
    setBusyBook(book);
    setError(null);
    try {
      await api.laneRetryBook(lane, replacementJobId, book);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusyBook(null);
    }
  };

  const handleWaiveBook = async (book: string) => {
    if (!replacementJobId) return;
    if (!window.confirm(t("preferences.scriptureLanes.confirmWaiveBook", { book }))) {
      return;
    }
    setBusyBook(book);
    setError(null);
    try {
      await api.laneWaiveBook(lane, replacementJobId, book, true);
      const res = await api.laneGetJob(lane, replacementJobId);
      setJob(res);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusyBook(null);
    }
  };

  const jobStatus = job?.job.status;
  const jobBooks: LaneReplacementBook[] = job?.books ?? [];
  const pendingBooks = jobBooks.filter(
    (b) => b.status !== "artifact_ok" && b.status !== "absent_authorized",
  );

  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle1" fontWeight="bold">
            {label}
          </Typography>
          <Chip size="small" label={`${config.source.owner}/${config.source.repo}`} />
          {replacementRequired && (
            <Chip size="small" color="warning" label={t("preferences.scriptureLanes.replacementRequired")} />
          )}
          {replacementJobId && (
            <Chip size="small" color="info" label={t("preferences.scriptureLanes.replacementActive")} />
          )}
        </Stack>

        {replacementRequired && !replacementJobId && state.pendingTarget != null && (
          <Alert severity="warning" sx={{ mb: 1 }}>
            {t("preferences.scriptureLanes.pendingTargetBanner")}
          </Alert>
        )}

        <Stack direction="row" spacing={2} alignItems="center">
          <FormControlLabel
            control={
              <Switch
                checked={config.textReadOnly}
                onChange={(_, v) => handleToggle("textReadOnly", v)}
                disabled={saving || !!replacementJobId}
                size="small"
              />
            }
            label={t("preferences.scriptureLanes.textReadOnly")}
          />
          <FormControlLabel
            control={
              <Switch
                checked={config.alignmentWritable}
                onChange={(_, v) => handleToggle("alignmentWritable", v)}
                disabled={saving || !!replacementJobId}
                size="small"
              />
            }
            label={t("preferences.scriptureLanes.alignmentWritable")}
          />
        </Stack>

        {replacementJobId && (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              {jobStatus !== "ready" && <CircularProgress size={16} />}
              <Typography variant="body2">
                {jobStatus
                  ? t(`preferences.scriptureLanes.jobStatus.${jobStatus}`)
                  : t("preferences.scriptureLanes.jobRunning")}
              </Typography>
              {jobStatus === "ready" && (
                <Button
                  size="small"
                  variant="contained"
                  color="primary"
                  onClick={handleActivate}
                  disabled={activating}
                >
                  {activating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.activate")}
                </Button>
              )}
              <Tooltip title={t("preferences.scriptureLanes.backOutHint")}>
                <Button size="small" color="error" onClick={handleBackOut} disabled={saving}>
                  {t("preferences.scriptureLanes.backOut")}
                </Button>
              </Tooltip>
            </Stack>

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
                      <Tooltip
                        key={b.book}
                        title={
                          retryable
                            ? t("preferences.scriptureLanes.bookRetryHint", { book: bookName(b.book) })
                            : `${bookName(b.book)} (${b.book}): ${b.status}`
                        }
                      >
                        <Chip
                          size="small"
                          color={color}
                          variant={b.status === "artifact_ok" ? "filled" : "outlined"}
                          label={
                            busyBook === b.book ? `${b.book}…` : b.book
                          }
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

        {!replacementJobId && (
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              size="small"
              label={t("preferences.scriptureLanes.sourceUrlLabel")}
              placeholder="https://git.door43.org/owner/repo"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              sx={{ flex: 1, maxWidth: 500 }}
              disabled={validating}
            />
            <Button
              size="small"
              variant="outlined"
              onClick={handleChangeSource}
              disabled={!sourceUrl.trim() || validating}
            >
              {validating ? <CircularProgress size={16} /> : t("preferences.scriptureLanes.changeSource")}
            </Button>
          </Stack>
        )}

        {error && (
          <Alert
            severity={sourceRetryable ? "warning" : "error"}
            onClose={() => setError(null)}
            action={
              sourceRetryable ? (
                <Button color="inherit" size="small" onClick={handleChangeSource} disabled={validating}>
                  {t("preferences.scriptureLanes.sourceRetry")}
                </Button>
              ) : undefined
            }
          >
            {error}
          </Alert>
        )}
        {successMsg && <Alert severity="success" onClose={() => setSuccessMsg(null)}>{successMsg}</Alert>}
      </Stack>

      {/* Confirm dialog listing the exact books this lane will re-stage (item 1). */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("preferences.scriptureLanes.confirmTitle", { lane: label })}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {pendingSource && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                {t("preferences.scriptureLanes.confirmSource", {
                  owner: pendingSource.owner,
                  repo: pendingSource.repo,
                })}
              </Typography>
            )}
            <Alert severity="warning" variant="outlined" sx={{ mb: 1.5 }}>
              {t("preferences.scriptureLanes.confirmWarning", {
                books: impact?.books ?? 0,
                verses: impact?.verses ?? 0,
              })}
            </Alert>
            {sourceUnverified && (
              <Alert severity="info" variant="outlined" sx={{ mb: 1.5 }}>
                {t("preferences.scriptureLanes.confirmSourceUnverified")}
              </Alert>
            )}
            {affectedBooks == null ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={16} />
                <Typography variant="body2">{t("preferences.scriptureLanes.confirmLoadingBooks")}</Typography>
              </Stack>
            ) : affectedBooks.length > 0 ? (
              <>
                <Typography variant="body2" sx={{ mb: 0.5 }}>
                  {t("preferences.scriptureLanes.confirmBooksSelectLead", { count: affectedBooks.length })}
                </Typography>
                <Stack direction="row" spacing={1} sx={{ mb: 0.75 }}>
                  <Button size="small" onClick={() => setSelectedBooks(new Set(affectedBooks))}>
                    {t("preferences.scriptureLanes.confirmBooksSelectAll")}
                  </Button>
                  <Button size="small" onClick={() => setSelectedBooks(new Set())}>
                    {t("preferences.scriptureLanes.confirmBooksSelectNone")}
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
                          stat
                            ? t("preferences.scriptureLanes.bookStatTip", { verses: stat.verses, edited })
                            : ""
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
                  {t("preferences.scriptureLanes.confirmBooksSummary", {
                    // NOT `replace`: that is i18next's reserved substitution-data
                    // option, and a truthy value silently blanks every placeholder.
                    replacing: affectedBooks.filter((b) => selectedBooks.has(b)).length,
                    keep: affectedBooks.filter((b) => !selectedBooks.has(b)).length,
                  })}
                </Typography>
                {affectedBooks.some((b) => (bookStats[b]?.edited ?? 0) > 0) && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.25 }}>
                    {t("preferences.scriptureLanes.confirmBooksEditedHint")}
                  </Typography>
                )}
              </>
            ) : (
              <Typography variant="body2">{t("preferences.scriptureLanes.confirmNoBookList")}</Typography>
            )}
          </DialogContentText>
          <FormControlLabel
            sx={{ mt: 1.5 }}
            control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} />}
            label={t("preferences.scriptureLanes.confirmAck")}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t("preferences.scriptureLanes.confirmBack")}</Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!ack || affectedBooks == null}
            onClick={handleConfirmStart}
          >
            {t("preferences.scriptureLanes.confirmButton")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

// Context-pack sync status. Saves auto-queue an export (the API does this),
// so there is no toggle any more — the pack feeds the AI whenever a successful
// export exists. The manual "Export now" button remains for admins, plus a
// force option when the shrink guard refused an intentional reduction.
function ContextPackStatusControls() {
  const { t } = useTranslation();
  const { status, refetch: refetchStatus } = useContextExportStatus(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const admin = isAdmin();

  const onExport = async (shrinkOverride = false) => {
    if (!admin) return;
    setBusy(true);
    try {
      await api.runContextExport(shrinkOverride ? { shrinkOverride: true } : undefined);
      setMsg(t("preferences.exportQueued"));
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        refetchStatus();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg(t("preferences.saveForbidden"));
      else setMsg(t("preferences.actionFailed"));
    } finally {
      setBusy(false);
    }
  };

  const statusKey = status ? EXPORT_STATUS_I18N_KEY[status.status] : undefined;
  const statusLabel =
    !status || status.status === "never"
      ? t("preferences.exportStatusNever")
      : status.status === "success" && status.sha
        ? t("preferences.exportStatusSuccess", { sha: status.sha.slice(0, 8) })
        : statusKey
          ? t(statusKey)
          : t("preferences.exportStatusOther", { status: status.status });

  return (
    <Stack spacing={0.75}>
      <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
        {statusLabel}
      </Typography>
      {status?.status === "shrink_refused" && admin && (
        <>
          {status.failureReason && (
            <Typography variant="caption" color="warning.main" sx={{ lineHeight: 1.3 }}>
              {status.failureReason}
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            color="warning"
            disabled={busy}
            onClick={() => void onExport(true)}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("preferences.exportForce")}
          </Button>
        </>
      )}
      {!admin && (
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.3 }}>
          {t("preferences.exportAdminOnly")}
        </Typography>
      )}
      <Tooltip title={admin ? "" : t("preferences.exportAdminOnly")}>
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={!admin || busy}
            onClick={() => void onExport()}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("preferences.exportNow")}
          </Button>
        </span>
      </Tooltip>
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg} />
    </Stack>
  );
}



// Shared shape returned by the single useTranslationPrefs() lifted to
// PreferencesWorkspace and passed down to every section that saves against
// the one TranslationPrefs row (brief / instructions / common issues).
type PrefsState = ReturnType<typeof useTranslationPrefs>;

// ── Brief ──────────────────────────────────────────────────────────────────
function BriefSection({ prefsState }: { prefsState: PrefsState }) {
  const { t } = useTranslation();
  const { prefs, loading, apply, refetch } = prefsState;
  const [draft, setDraft] = useState<TranslationPrefs | null>(() => prefs);
  const save = useSaveState();

  // Seed once: a sibling section's save PUTs only its own fields (the server
  // partial-merges), so it can't change anything Brief owns. If this re-seeded
  // on every `prefs` change, a sibling's save (which also updates `prefs` via
  // apply()) would silently overwrite whatever the user is still typing here.
  // Seeded during render once prefs arrive, when they weren't loaded at mount.
  if (draft === null && prefs) setDraft(prefs);

  const onSave = async () => {
    if (!draft || !prefs) return;
    save.setSaving(true);
    try {
      const res = await api.putTranslationPrefs(prefs.version, {
        audience: draft.audience,
        purpose: draft.purpose,
        register: draft.register,
        script_notes: draft.script_notes,
        notes: draft.notes,
        // brief section doesn't own instructions/assisted — omit so the server
        // merges the existing values.
      });
      apply(res.prefs);
      save.setMsg(t("preferences.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else saved first (another section, or another admin).
        // Adopt the server's fresh row directly from the 409 body so the
        // next save has the right If-Match; fall back to a refetch only if
        // the body didn't carry one. Our draft is left untouched — seed-once
        // means this can't clobber unsaved typing, and a re-save only ever
        // sends Brief's own fields, so it overwrites at most the concurrent
        // change to THOSE fields.
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg(t("preferences.conflictKeptEdits"));
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("preferences.saveForbidden"));
      } else {
        save.setMsg(t("preferences.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  if (loading && !draft) return <CircularProgress size={22} />;
  if (!draft) return null;

  return (
    <Stack spacing={2}>
      <Typography variant="h6">{t("preferences.section.brief")}</Typography>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.briefIntro")}
      </Typography>
      <TextField
        label={t("preferences.audience")}
        value={draft.audience ?? ""}
        onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        label={t("preferences.purpose")}
        value={draft.purpose ?? ""}
        onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <TextField
        select
        label={t("preferences.register")}
        value={draft.register}
        onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
        sx={{ maxWidth: 240 }}
        size="small"
        helperText={t("preferences.registerHelp")}
      >
        {REGISTERS.map((r) => (
          <MenuItem key={r} value={r}>
            {t(`preferences.registerOption.${r}`)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        label={t("preferences.scriptNotes")}
        value={draft.script_notes ?? ""}
        onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
        multiline
        minRows={2}
        fullWidth
        size="small"
      />
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

// ── Instructions / Common issues (shared markdown-pref editor) ────────────────
// Server caps: instructions_md 20000 chars, common_issues_md 50000 chars
// (see PutPrefsBody in api/src/translationMemory.ts) — keep maxChars below in sync.
function MarkdownPrefSection({
  field,
  titleKey,
  introKey,
  placeholderKey,
  maxChars,
  prefsState,
}: {
  field: "instructions_md" | "common_issues_md";
  titleKey: string;
  introKey: string;
  placeholderKey: string;
  maxChars: number;
  prefsState: PrefsState;
}) {
  const { t } = useTranslation();
  const { prefs, error, apply, refetch } = prefsState;
  // null = not yet seeded from `prefs` (loading gate below); seeded once so a
  // sibling section's save (which also updates `prefs` via apply()) can't
  // reset text the user is mid-typing here.
  const [value, setValue] = useState<string | null>(() => (prefs ? (prefs[field] ?? "") : null));
  const [preview, setPreview] = useState(false);
  const save = useSaveState();

  // Seed ONLY once prefs actually loaded (during render when they weren't
  // loaded at mount). Without the `prefs` gate this would coalesce the initial
  // null prefs into "" on mount — the editor would render empty instead of the
  // saved content, and a Save from that state would silently null the field
  // on the server.
  if (value === null && prefs) setValue(prefs[field] ?? "");

  const overLimit = (value ?? "").length > maxChars;

  const onSave = async () => {
    if (!prefs || value === null) return;
    save.setSaving(true);
    try {
      const res = await api.putTranslationPrefs(prefs.version, { [field]: value || null });
      apply(res.prefs);
      save.setMsg(t("preferences.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // See BriefSection's onSave: adopt the server's fresh row from the
        // conflict body rather than refetching, so this section's unsaved
        // text (kept as-is; seed-once means it was never at risk) survives
        // and the next save re-sends it against the right version.
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg(t("preferences.conflictKeptEdits"));
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("preferences.saveForbidden"));
      } else if (e instanceof ApiError && e.status === 400) {
        save.setMsg(t("preferences.saveTooLong"));
      } else {
        save.setMsg(t("preferences.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  if (value === null) {
    // Prefs GET failed: surface it instead of spinning forever (the seed
    // effect above never fires without a loaded prefs row).
    if (error) return <Alert severity="error">{t("preferences.actionFailed")}</Alert>;
    return <CircularProgress size={22} />;
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">{t(titleKey)}</Typography>
        <ToggleButton
          size="small"
          value="preview"
          selected={preview}
          onChange={() => setPreview((p) => !p)}
          sx={{ textTransform: "none", py: 0.25 }}
        >
          <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
          {t("preferences.preview")}
        </ToggleButton>
      </Stack>
      <Alert severity="info" variant="outlined" sx={{ py: 0.25 }}>
        {t(introKey)}
      </Alert>
      {preview ? (
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, minHeight: 200 }}>
          <MarkdownView markdown={value || "_" + t("preferences.empty") + "_"} />
        </Box>
      ) : (
        <TextField
          value={value}
          onChange={(e) => setValue(e.target.value)}
          multiline
          minRows={10}
          fullWidth
          placeholder={t(placeholderKey)}
          error={overLimit}
          helperText={
            overLimit
              ? t("preferences.charCountOver", { count: value.length, max: maxChars })
              : t("preferences.charCount", { count: value.length, max: maxChars })
          }
          slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
        />
      )}
      <Box>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={onSave} disabled={save.saving || overLimit}>
          {t("preferences.save")}
        </Button>
      </Box>
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}

function InstructionsSection({ prefsState }: { prefsState: PrefsState }) {
  return (
    <MarkdownPrefSection
      field="instructions_md"
      titleKey="preferences.section.instructions"
      introKey="preferences.instructionsIntro"
      placeholderKey="preferences.instructionsPlaceholder"
      maxChars={20000}
      prefsState={prefsState}
    />
  );
}

function CommonIssuesSection({ prefsState }: { prefsState: PrefsState }) {
  return (
    <MarkdownPrefSection
      field="common_issues_md"
      titleKey="preferences.section.commonIssues"
      introKey="preferences.commonIssuesIntro"
      placeholderKey="preferences.commonIssuesPlaceholder"
      maxChars={50000}
      prefsState={prefsState}
    />
  );
}


// ── Examples ─────────────────────────────────────────────────────────────────
function ExamplesSection() {
  const { t } = useTranslation();
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { examples, loading, refetch } = useExamples(true, { resource, q: debouncedQ || undefined, limit: 200 });
  const { status } = useContextExportStatus(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // 4-char row IDs are only unique per book (migration 0015's composite PK) —
  // /examples browses across all books, so both the React key and the busy
  // token below must be `book:id`, not bare `id`.
  const revoke = async (id: string, book: string) => {
    setBusyId(`${book}:${id}`);
    try {
      if (resource === "tn") await api.validateNote(id, book, false);
      else await api.validateQuestion(id, book, false);
      refetch();
    } catch {
      save.setMsg(t("preferences.actionFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const count = examples.length;
  const feedingAi = status?.status === "success" && !!status.sha;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h6">{t("preferences.section.examples")}</Typography>
        <Chip
          size="small"
          label={feedingAi ? t("preferences.feedingAi") : t("preferences.notFeedingAi")}
          color={feedingAi ? "success" : "default"}
          variant="outlined"
          sx={{ height: 18, fontSize: 10, fontWeight: 600 }}
        />
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {t("preferences.examplesIntro")}
      </Typography>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={resource}
          onChange={(_, v) => v && setResource(v)}
        >
          <ToggleButton value="tn" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.notes")}
          </ToggleButton>
          <ToggleButton value="tq" sx={{ textTransform: "none", py: 0.25 }}>
            {t("preferences.questions")}
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder={t("preferences.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <Typography variant="caption" color="text.secondary">
          {t("preferences.examplesCount", { n: count })}
        </Typography>
      </Stack>

      {loading && examples.length === 0 ? (
        <CircularProgress size={22} />
      ) : examples.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("preferences.noExamples")}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {examples.map((ex) => (
            <Box
              key={`${ex.book}:${ex.id}`}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                p: 1.25,
                borderInlineStart: "3px solid",
                borderInlineStartColor: "success.main",
                bgcolor: (theme) => alpha(theme.palette.success.main, 0.05),
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1}>
                <Chip
                  label={`${ex.book} ${ex.ref_raw}`}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: 11 }}
                />
                {ex.support_reference && (
                  <Chip label={ex.support_reference} size="small" sx={{ height: 20, fontSize: 10 }} />
                )}
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => revoke(ex.id, ex.book)}
                  disabled={busyId === `${ex.book}:${ex.id}`}
                >
                  {t("preferences.revoke")}
                </Button>
              </Stack>
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>
                {resource === "tn" ? ex.note : `${ex.question ?? ""}\n${ex.response ?? ""}`}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={3000} onClose={save.clear} message={save.msg ?? ""} />
    </Stack>
  );
}
