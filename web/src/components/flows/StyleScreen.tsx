// l2-style: "Teach the AI our style" (Lead). Port of docs/flows/ui/l2-style.html.
//
// The memory sections (Brief / Instructions / Common issues / Terminology /
// Examples) moved here from the admin Setup page per Benjamin's post-#187 IA
// review: Setup is configuration-only, and "teach the AI" content belongs on
// the Style screen. Gating mirrors what AdminSetupScreen used to do
// (memoryAvailable = admin && isTranslationProject(cfg) && !isReadOnly()) —
// classic PreferencesWorkspace keeps its own copy until classic retires.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import SaveIcon from "@mui/icons-material/Save";
import VisibilityIcon from "@mui/icons-material/Visibility";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import { FlowStatusChip } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  isReadOnly,
  REGISTERS,
  type ContextExportStatus,
  type Register,
  type TranslationPrefs,
} from "../../sync/api";
import { currentPrefsFromConflict } from "../../sync/prefsConflict";
import { setProjectMode, useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import {
  useContextExportStatus,
  useTranslationPrefs,
  useExamples,
} from "../../hooks/useTranslationMemory";
import { MarkdownView } from "../MarkdownView";
import { TerminologySection } from "../TerminologySection";
import { bookName } from "../../lib/bookNames";
import { formatNumber } from "../../lib/formatDate";

export interface StyleScreenProps extends FlowScreenContext {}

type SectionKey = "brief" | "instructions" | "commonIssues" | "terminology" | "examples" | "qa" | "templates";

const MEMORY_SECTION_LABELS: Array<{ key: SectionKey; labelKey: string }> = [
  { key: "brief", labelKey: "moreTools.style.sectionBrief" },
  { key: "instructions", labelKey: "moreTools.style.sectionInstructions" },
  { key: "commonIssues", labelKey: "moreTools.style.sectionCommonIssues" },
  { key: "terminology", labelKey: "moreTools.style.sectionTerminology" },
  { key: "examples", labelKey: "moreTools.style.sectionExamples" },
];

const ALWAYS_SECTION_LABELS: Array<{ key: SectionKey; labelKey: string }> = [
  { key: "qa", labelKey: "moreTools.style.sectionQaRules" },
  { key: "templates", labelKey: "moreTools.style.sectionTemplates" },
];

// Per-panel save feedback, mirror of useSaveState (PreferencesWorkspace.tsx
// :1081-1085 / formerly AdminSetupScreen.tsx).
function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return { saving, setSaving, msg, setMsg, clear: () => setMsg(null) };
}

type PrefsState = ReturnType<typeof useTranslationPrefs>;

// Server-reported export states, spelled out in plain language. Anything not
// in this map is shown verbatim rather than being smoothed into a friendly lie.
const EXPORT_STATUS_LABEL_KEYS: Record<string, string> = {
  success: "moreTools.style.exportStatus.success",
  never: "moreTools.style.exportStatus.never",
  queued: "moreTools.style.exportStatus.queued",
  running: "moreTools.style.exportStatus.running",
  failed: "moreTools.style.exportStatus.failed",
  shrink_refused: "moreTools.style.exportStatus.shrinkRefused",
  no_content: "moreTools.style.exportStatus.noContent",
  dry_run: "moreTools.style.exportStatus.dryRun",
};

function scrollToSection(key: SectionKey) {
  document.getElementById(`style-sec-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── Panel chrome (mirrors .panel / .panel-top / .panel-body / .panel-foot) ──
function Panel({
  id,
  title,
  intro,
  headerExtra,
  footState,
  footActions,
  flush,
  children,
}: {
  id: SectionKey;
  title: string;
  intro: string;
  headerExtra?: ReactNode;
  footState?: ReactNode;
  footActions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
}) {
  return (
    <Box
      component="section"
      id={`style-sec-${id}`}
      aria-labelledby={`style-sec-${id}-heading`}
      sx={{
        scrollMarginBlockStart: "16px",
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
        overflow: "hidden",
      }}
    >
      <Box sx={{ p: 2, borderBlockEnd: 1, borderColor: "divider" }}>
        <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
          <Typography id={`style-sec-${id}-heading`} variant="h6" sx={{ fontSize: "1rem" }}>
            {title}
          </Typography>
          {headerExtra}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {intro}
        </Typography>
      </Box>
      <Box sx={{ p: flush ? 0 : 2 }}>{children}</Box>
      {(footState || footActions) && (
        <Stack
          direction="row"
          alignItems="center"
          flexWrap="wrap"
          gap={1.5}
          sx={{ px: 2, py: 1.25, borderBlockStart: 1, borderColor: "divider", bgcolor: "action.hover" }}
        >
          <Typography variant="caption" color="text.secondary">
            {footState}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {footActions}
        </Stack>
      )}
    </Box>
  );
}

// ── Brief ───────────────────────────────────────────────────────────────────
// Faithful re-presentation of BriefSection (PreferencesWorkspace.tsx:1376-1488):
// same fields, same seed-once draft, same PUT field set (audience / purpose /
// register / script_notes / notes — instructions/assisted omitted so the
// server merges them), same 409/403 handling.
function BriefPanel({ prefsState }: { prefsState: PrefsState }) {
  const { t } = useTranslation();
  const { prefs, loading, apply, refetch } = prefsState;
  const [draft, setDraft] = useState<TranslationPrefs | null>(null);
  const save = useSaveState();

  // Seed once — a sibling section's save PUTs only its own fields, so it can't
  // change anything Brief owns; re-seeding on every prefs change would clobber
  // in-progress typing (see PreferencesWorkspace.tsx:1382-1386).
  useEffect(() => {
    setDraft((d) => d ?? prefs);
  }, [prefs]);

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
      });
      apply(res.prefs);
      save.setMsg(t("moreTools.style.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone else saved first. Adopt the fresh row from the 409 body so
        // the next save carries the right If-Match; the local draft is kept.
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg(t("moreTools.style.saveConflict"));
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("moreTools.style.saveAdminOnly"));
      } else {
        save.setMsg(t("moreTools.style.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  return (
    <Panel
      id="brief"
      title={t("moreTools.style.sectionBrief")}
      intro={t("moreTools.style.briefIntro")}
      footState={prefs ? t("moreTools.style.version", { version: prefs.version }) : undefined}
      footActions={
        <Button
          variant="contained"
          size="small"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={save.saving || !draft}
        >
          {t("common.save")}
        </Button>
      }
    >
      {loading && !draft ? (
        <CircularProgress size={22} />
      ) : !draft ? null : (
        <Stack spacing={2}>
          <TextField
            label={t("moreTools.style.audience")}
            value={draft.audience ?? ""}
            onChange={(e) => setDraft({ ...draft, audience: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
          <TextField
            label={t("moreTools.style.purpose")}
            value={draft.purpose ?? ""}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
          <TextField
            select
            label={t("moreTools.style.register")}
            value={draft.register}
            onChange={(e) => setDraft({ ...draft, register: e.target.value as Register })}
            sx={{ maxWidth: 240 }}
            size="small"
            helperText={t("moreTools.style.registerHelper")}
          >
            {REGISTERS.map((r) => (
              <MenuItem key={r} value={r}>
                {r === "default"
                  ? t("moreTools.style.registerDefault")
                  : r === "formal"
                    ? t("moreTools.style.registerFormal")
                    : t("moreTools.style.registerInformal")}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label={t("moreTools.style.scriptNotes")}
            value={draft.script_notes ?? ""}
            onChange={(e) => setDraft({ ...draft, script_notes: e.target.value || null })}
            multiline
            minRows={2}
            fullWidth
            size="small"
          />
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </Panel>
  );
}

// ── Instructions / Common issues (shared markdown editor) ───────────────────
// Faithful re-presentation of MarkdownPrefSection (PreferencesWorkspace.tsx
// :1493-1610). Server caps (keep in sync with PutPrefsBody in
// api/src/translationMemory.ts): instructions_md 20000, common_issues_md 50000.
function MarkdownPrefPanel({
  id,
  field,
  title,
  sub,
  placeholder,
  maxChars,
  prefsState,
}: {
  id: SectionKey;
  field: "instructions_md" | "common_issues_md";
  title: string;
  sub: string;
  placeholder: string;
  maxChars: number;
  prefsState: PrefsState;
}) {
  const { t } = useTranslation();
  const { prefs, error, apply, refetch } = prefsState;
  // null = not yet seeded (loading gate below). Seed ONLY once prefs actually
  // loaded — coalescing null prefs into "" would render empty over saved
  // content, and a Save from that state would null the field on the server
  // (see PreferencesWorkspace.tsx:1517-1523).
  const [value, setValue] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const save = useSaveState();

  useEffect(() => {
    if (prefs) setValue((v) => v ?? (prefs[field] ?? ""));
  }, [prefs, field]);

  const overLimit = (value ?? "").length > maxChars;

  const onSave = async () => {
    if (!prefs || value === null) return;
    save.setSaving(true);
    try {
      const res = await api.putTranslationPrefs(prefs.version, { [field]: value || null });
      apply(res.prefs);
      save.setMsg(t("moreTools.style.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const current = currentPrefsFromConflict(e.body);
        if (current) apply(current);
        else refetch();
        save.setMsg(t("moreTools.style.saveConflict"));
      } else if (e instanceof ApiError && e.status === 403) {
        save.setMsg(t("moreTools.style.saveAdminOnly"));
      } else if (e instanceof ApiError && e.status === 400) {
        save.setMsg(t("moreTools.style.saveTooLong"));
      } else {
        save.setMsg(t("moreTools.style.saveFailed"));
      }
    } finally {
      save.setSaving(false);
    }
  };

  return (
    <Panel
      id={id}
      title={title}
      intro={sub}
      footState={
        value === null
          ? undefined
          : overLimit
            ? t("moreTools.style.charCountOver", {
                used: formatNumber(value.length),
                max: formatNumber(maxChars),
              })
            : t("moreTools.style.charCount", {
                used: formatNumber(value.length),
                max: formatNumber(maxChars),
              })
      }
      footActions={
        <Button
          variant="contained"
          size="small"
          startIcon={<SaveIcon />}
          onClick={onSave}
          disabled={save.saving || overLimit || value === null}
        >
          {t("common.save")}
        </Button>
      }
    >
      {value === null ? (
        error ? (
          <Alert severity="error">{t("moreTools.style.prefsLoadFailed")}</Alert>
        ) : (
          <CircularProgress size={22} />
        )
      ) : (
        <Stack spacing={1.5}>
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <ToggleButton
              size="small"
              value="preview"
              selected={preview}
              onChange={() => setPreview((p) => !p)}
              sx={{ textTransform: "none", py: 0.25 }}
            >
              <VisibilityIcon fontSize="small" sx={{ marginInlineEnd: 0.5 }} />
              {t("moreTools.common.preview")}
            </ToggleButton>
          </Box>
          {preview ? (
            <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2, minHeight: 180 }}>
              <MarkdownView markdown={value || t("moreTools.style.emptyMarkdown")} />
            </Box>
          ) : (
            <TextField
              value={value}
              onChange={(e) => setValue(e.target.value)}
              multiline
              minRows={8}
              fullWidth
              placeholder={placeholder}
              error={overLimit}
              slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: 13 } } }}
            />
          )}
        </Stack>
      )}
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </Panel>
  );
}

// ── Examples ────────────────────────────────────────────────────────────────
function ExamplesPanel({
  enabled,
  status,
}: {
  enabled: boolean;
  status: ContextExportStatus | null;
}) {
  const { t } = useTranslation();
  const [resource, setResource] = useState<"tn" | "tq">("tn");
  const [query, setQuery] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const { examples, loading, refetch } = useExamples(enabled, {
    resource,
    q: debouncedQ || undefined,
    limit: 200,
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const save = useSaveState();

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(query.trim()), 300);
    return () => clearTimeout(h);
  }, [query]);

  // 4-char row IDs are only unique per book — busy token and React key must be
  // `book:id` (PreferencesWorkspace.tsx:2469-2471).
  const revoke = async (id: string, book: string) => {
    setBusyId(`${book}:${id}`);
    try {
      if (resource === "tn") await api.validateNote(id, book, false);
      else await api.validateQuestion(id, book, false);
      refetch();
    } catch {
      save.setMsg(t("moreTools.style.revokeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const feedingAi = status?.status === "success" && !!status.sha;

  return (
    <Panel
      id="examples"
      title={t("moreTools.style.sectionExamples")}
      intro={t("moreTools.style.examplesIntro")}
      footState={t("moreTools.style.validatedExamples", { count: examples.length })}
      footActions={
        <Chip
          size="small"
          label={feedingAi ? t("moreTools.style.feedingAi") : t("moreTools.style.notFeedingAi")}
          color={feedingAi ? "success" : "default"}
          variant="outlined"
          sx={{ height: 18, fontSize: 10, fontWeight: 600 }}
        />
      }
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup size="small" exclusive value={resource} onChange={(_, v) => v && setResource(v)}>
            <ToggleButton value="tn" sx={{ textTransform: "none", py: 0.25 }}>
              {t("moreTools.style.notesToggle")}
            </ToggleButton>
            <ToggleButton value="tq" sx={{ textTransform: "none", py: 0.25 }}>
              {t("moreTools.style.questionsToggle")}
            </ToggleButton>
          </ToggleButtonGroup>
          <TextField
            size="small"
            placeholder={t("moreTools.style.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            sx={{ minWidth: 220 }}
          />
        </Stack>

        {loading && examples.length === 0 ? (
          <CircularProgress size={22} />
        ) : examples.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("moreTools.style.noExamples")}
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
                    label={`${bookName(ex.book)} ${ex.ref_raw}`}
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
                    {t("moreTools.style.revoke")}
                  </Button>
                </Stack>
                <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: "pre-wrap" }}>
                  {resource === "tn" ? ex.note : `${ex.question ?? ""}\n${ex.response ?? ""}`}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Stack>
      <Snackbar open={!!save.msg} autoHideDuration={4000} onClose={save.clear} message={save.msg ?? ""} />
    </Panel>
  );
}

// ── Screen ──────────────────────────────────────────────────────────────────
export default function StyleScreen({ role, me }: StyleScreenProps) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const admin = role === "admin";
  const isTranslation = isTranslationProject(cfg);
  const memoryAvailable = admin && isTranslation && !isReadOnly();
  // ONE shared prefs hook for Brief / Instructions / Common issues — all three
  // save against the same TranslationPrefs row/version, so a shared hook keeps
  // every save's If-Match current (PreferencesWorkspace.tsx:185-190).
  const prefsState = useTranslationPrefs(memoryAvailable);
  // Lifted once (issue #206): PackStatusBar and ExamplesPanel both read
  // context-export status. A hook call per consumer meant two GETs on mount
  // and a stale "Feeding AI" chip in ExamplesPanel after PackStatusBar's own
  // "Export now" refetched only its own instance. One call here, passed down
  // as props, so both consumers share a single fetch/refetch. `enabled`
  // reconciles the two original conditions (`role !== "viewer"` for
  // PackStatusBar, `memoryAvailable` for ExamplesPanel) so the hook still
  // fires whenever either consumer previously needed it.
  const exportStatusState = useContextExportStatus(role !== "viewer" || memoryAvailable);

  const [current, setCurrent] = useState<SectionKey>("qa");

  const sectionLabels: Array<{ key: SectionKey; labelKey: string }> = [
    ...(memoryAvailable ? MEMORY_SECTION_LABELS : []),
    ...ALWAYS_SECTION_LABELS,
  ];

  const eyebrow = cfg
    ? `${cfg.languageTitle || cfg.languageName || cfg.languageCode} · ${cfg.org}`
    : t("moreTools.common.workspace");

  return (
    <AdminDesk current="style">
    <Box sx={{ pb: 8 }}>
      <Box sx={{ maxWidth: 1180, marginInline: "auto", px: 2, pt: 2 }}>
        <AdminPageHeader
          eyebrow={eyebrow}
          title={t("moreTools.style.title")}
          subtitle={t("moreTools.style.subtitle")}
        />
        <PackStatusBar
          role={role}
          status={exportStatusState.status}
          loading={exportStatusState.loading}
          error={exportStatusState.error}
          refetch={exportStatusState.refetch}
        />

        <Box
          sx={{
            display: "grid",
            gap: 2.5,
            gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "220px minmax(0, 1fr)" },
            alignItems: "start",
          }}
        >
          {/* Rail: sticky column at ≥900px, horizontally scrollable strip below. */}
          <Box
            component="nav"
            aria-label={t("moreTools.style.sectionsNav")}
            sx={{
              position: { xs: "static", md: "sticky" },
              insetBlockStart: { md: 16 },
              display: { xs: "none", md: "flex" },
              flexDirection: { xs: "row", md: "column" },
              overflowX: { xs: "auto", md: "visible" },
              gap: 0.5,
              p: 1,
              bgcolor: "background.paper",
              border: 1,
              borderColor: "divider",
              borderRadius: 1.5,
            }}
          >
            {sectionLabels.map(({ key, labelKey }) => {
              const selected = key === current;
              return (
                <Box
                  key={key}
                  component="button"
                  type="button"
                  onClick={() => {
                    setCurrent(key);
                    scrollToSection(key);
                  }}
                  aria-current={selected ? "true" : undefined}
                  sx={{
                    appearance: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    minHeight: 40,
                    whiteSpace: "nowrap",
                    textAlign: "start",
                    borderRadius: 1,
                    paddingBlock: 1,
                    paddingInline: 1.375,
                    fontSize: "0.875rem",
                    fontWeight: 600,
                    fontFamily: "inherit",
                    bgcolor: selected ? "action.selected" : "transparent",
                    color: selected ? "text.primary" : "text.secondary",
                    "&:hover": { bgcolor: "action.hover", color: "text.primary" },
                  }}
                >
                  {t(labelKey)}
                </Box>
              );
            })}
          </Box>

          <Stack spacing={2}>
            {cfg === null ? (
              <CircularProgress size={22} />
            ) : !isTranslation ? (
              <Alert severity="info" variant="outlined">
                {t("moreTools.style.sourceProjectOnly")}
              </Alert>
            ) : !memoryAvailable ? (
              <Alert severity="info" variant="outlined">
                {t("moreTools.style.readOnlyHere")}
              </Alert>
            ) : (
              <>
                <BriefPanel prefsState={prefsState} />
                <MarkdownPrefPanel
                  id="instructions"
                  field="instructions_md"
                  title={t("moreTools.style.sectionInstructions")}
                  sub={t("moreTools.style.instructionsSub")}
                  placeholder={t("moreTools.style.instructionsPlaceholder")}
                  maxChars={20000}
                  prefsState={prefsState}
                />
                <MarkdownPrefPanel
                  id="commonIssues"
                  field="common_issues_md"
                  title={t("moreTools.style.sectionCommonIssues")}
                  sub={t("moreTools.style.commonIssuesSub")}
                  placeholder={t("moreTools.style.commonIssuesPlaceholder")}
                  maxChars={50000}
                  prefsState={prefsState}
                />
                <Panel
                  id="terminology"
                  title={t("moreTools.style.sectionTerminology")}
                  intro={t("moreTools.style.terminologyIntro")}
                  flush
                >
                  <TerminologySection direction={cfg?.direction ?? "ltr"} />
                </Panel>
                <ExamplesPanel enabled={memoryAvailable} status={exportStatusState.status} />
              </>
            )}

            <QaRulesSection />
            <TemplatesSection />

            {me?.workspace && (
              <Typography variant="caption" color="text.secondary">
                {t("moreTools.style.workspaceLabel", { workspace: me.workspace })}
              </Typography>
            )}
          </Stack>
        </Box>
      </Box>
    </Box>
    </AdminDesk>
  );
}

// ── Context-pack export status ──────────────────────────────────────────────
// The trust indicator. Everything here is the server's own report; when there
// is no committed pack (the dev workspace reports
// `status: "dry_run", failureReason: "no_service_token"`) we say exactly that
// rather than implying the AI has a pack to read.
function PackStatusBar({
  role,
  status,
  loading,
  error,
  refetch,
}: {
  role: "admin" | "editor" | "viewer";
  status: ContextExportStatus | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}) {
  const { t } = useTranslation();
  const admin = role === "admin";
  const cfg = useProjectConfig();
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const runExport = async (shrinkOverride: boolean) => {
    setBusy(true);
    // Clear any earlier 403 verdict before asking again — a role change (or a
    // workspace switch) can make this allowed, and a latched flag would keep
    // claiming the status isn't visible forever.
    setForbidden(false);
    try {
      const res = await api.runContextExport(shrinkOverride ? { shrinkOverride: true } : undefined);
      setMsg(t("moreTools.style.exportQueued", { id: res.id }));
      // The workflow is async; poll a few times so the chip converges without a
      // manual reload. No claim is made about success until the status says so.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        refetch();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setMsg(t("moreTools.style.exportsAdminOnly"));
      else if (e instanceof ApiError && e.status === 409) setMsg(t("moreTools.style.exportJustQueued"));
      else setMsg(t("moreTools.style.exportStartFailed"));
    } finally {
      setBusy(false);
    }
  };

  const toggleMode = async (next: "authoring" | "translation") => {
    setModeBusy(true);
    try {
      const updated = await setProjectMode(next);
      setMsg(t("moreTools.style.modeSet", { mode: updated.mode }));
    } catch (e) {
      // Never flip the switch optimistically: on failure it keeps showing the
      // server's actual mode (cfg is unchanged), not the opposite of it.
      if (e instanceof ApiError && e.status === 403) setMsg(t("moreTools.style.modeAdminOnly"));
      else setMsg(t("moreTools.style.modeChangeFailed"));
    } finally {
      setModeBusy(false);
    }
  };

  // Two-way, not latching: the hook clears `error` at the start of every fetch,
  // so a later successful read must also clear this flag.
  useEffect(() => {
    setForbidden(error instanceof ApiError && error.status === 403);
  }, [error]);

  let chipText: string;
  if (role === "viewer" || forbidden) chipText = t("moreTools.style.statusNotVisible");
  else if (loading && !status) chipText = t("moreTools.style.statusLoading");
  else if (!status) chipText = t("moreTools.style.statusUnavailable");
  else if (status.sha) chipText = t("moreTools.style.packReady", { sha: status.sha.slice(0, 8) });
  else
    chipText = t("moreTools.style.noPackYet", {
      status: EXPORT_STATUS_LABEL_KEYS[status.status] ? t(EXPORT_STATUS_LABEL_KEYS[status.status]) : status.status,
    });

  const detailBits: string[] = [];
  if (status) {
    detailBits.push(t("moreTools.style.termsCount", { count: status.terms }));
    detailBits.push(t("moreTools.style.tnExamplesCount", { count: status.examplesTn }));
    detailBits.push(t("moreTools.style.tqExamplesCount", { count: status.examplesTq }));
    if (status.failureReason) detailBits.push(t("moreTools.style.blocked", { reason: status.failureReason }));
  }

  const mode = cfg?.mode ?? null;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 1.25,
        p: 1.75,
        mb: 2,
        bgcolor: "background.paper",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 1,
      }}
    >
      <Chip
        size="small"
        label={chipText}
        sx={{
          fontWeight: 600,
          borderRadius: 999,
          bgcolor: "action.selected",
          color: "text.primary",
          height: "auto",
          py: 0.5,
          "& .MuiChip-label": { whiteSpace: "normal" },
        }}
      />

      <Box sx={{ flex: 1, minWidth: 8 }} />

      <FormControlLabel
        sx={{ mr: 0 }}
        control={
          <Switch
            size="small"
            checked={mode === "translation"}
            disabled={!admin || mode === null || modeBusy}
            onChange={(_, checked) => void toggleMode(checked ? "translation" : "authoring")}
          />
        }
        label={
          <Typography variant="body2">
            {t("moreTools.style.projectMode", { mode: mode ?? t("moreTools.style.modeLoading") })}
            {!admin && ` ${t("moreTools.style.adminOnlySuffix")}`}
          </Typography>
        }
      />

      <Tooltip title={admin ? "" : t("moreTools.style.exportsAdminOnly")}>
        <span>
          <Button size="small" variant="outlined" disabled={!admin || busy} onClick={() => void runExport(false)}>
            {t("moreTools.style.exportNow")}
          </Button>
        </span>
      </Tooltip>
      {/* Force is not a hidden double-click easter egg like the mockup — it
          appears exactly when the server says the shrink guard refused. */}
      {admin && status?.status === "shrink_refused" && (
        <Button size="small" variant="outlined" color="warning" disabled={busy} onClick={() => void runExport(true)}>
          {t("moreTools.style.exportForce")}
        </Button>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ flexBasis: "100%" }}>
        {t("moreTools.style.packCaption")}
        {detailBits.length > 0 && ` ${t("moreTools.style.lastSnapshot", { details: detailBits.join(", ") })}`}
      </Typography>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}



// ── QA rules ────────────────────────────────────────────────────────────────
// Designed, not built. The structural tN checks named here really do run at
// apply time in the server code; what does not exist is any endpoint for
// enabling, tuning, or adding rules — so this section reads its own state
// honestly instead of pretending to be a live config surface.
const QA_RULES: Array<{ nameKey: string; severity: "error" | "warning" }> = [
  { nameKey: "moreTools.style.qaRuleQuoteUntouched", severity: "error" },
  { nameKey: "moreTools.style.qaRuleEmptyTranslation", severity: "error" },
  { nameKey: "moreTools.style.qaRuleRepeatedWord", severity: "warning" },
  { nameKey: "moreTools.style.qaRuleTerminology", severity: "warning" },
];

function QaRulesSection() {
  const { t } = useTranslation();
  return (
    <Panel
      id="qa"
      title={t("moreTools.style.sectionQaRules")}
      intro={t("moreTools.style.qaIntro")}
      headerExtra={<FlowStatusChip kind="edited" label={t("moreTools.style.comingSoon")} />}
      footState={t("moreTools.style.comingSoon")}
    >
      <Stack spacing={1}>
        {QA_RULES.map((rule) => (
          <Stack key={rule.nameKey} direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" sx={{ flex: 1 }}>
              {t(rule.nameKey)}
            </Typography>
            <FlowStatusChip
              kind={rule.severity === "error" ? "warn" : "edited"}
              label={rule.severity === "error" ? t("moreTools.style.severityError") : t("moreTools.style.severityWarning")}
            />
          </Stack>
        ))}
      </Stack>
    </Panel>
  );
}

// ── Templates pointer ───────────────────────────────────────────────────────
function TemplatesSection() {
  const { t } = useTranslation();
  const [units, setUnits] = useState<{ support_ref: string; has_target: 0 | 1 }[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getTemplates()
      .then((res) => {
        if (!cancelled) setUnits(res.units.map((u) => ({ support_ref: u.support_ref, has_target: u.has_target })));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const coverage = useMemo(() => {
    if (!units) return null;
    const byRef = new Map<string, boolean>();
    for (const u of units) {
      byRef.set(u.support_ref, (byRef.get(u.support_ref) ?? false) || u.has_target === 1);
    }
    const total = byRef.size;
    const translated = [...byRef.values()].filter(Boolean).length;
    return { total, translated, units: units.length };
  }, [units]);

  return (
    <Panel
      id="templates"
      title={t("moreTools.style.sectionTemplates")}
      intro={t("moreTools.style.templatesIntro")}
      footState={t("moreTools.style.curateFoot")}
      footActions={
        <Button size="small" variant="contained" href="#/admin/curate">
          {t("moreTools.style.openCuration")}
        </Button>
      }
    >
      {failed ? (
        <Alert severity="error">{t("moreTools.style.coverageLoadFailed")}</Alert>
      ) : !coverage ? (
        <CircularProgress size={22} />
      ) : (
        <Stack spacing={0.5}>
          <Typography variant="body2">
            {t("moreTools.style.coverageSummary", { translated: coverage.translated, total: coverage.total })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("moreTools.style.unitCount", { count: coverage.units })}
          </Typography>
        </Stack>
      )}
    </Panel>
  );
}
