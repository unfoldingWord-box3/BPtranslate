// Editor pane for CurateScreen.tsx (l3-templates). Reuses the exact server
// contract and drafts-store wiring TemplateWorkspace.tsx already established
// for note templates — this is a re-skin (flows chrome, mobile Back arrow,
// always-visible-but-honestly-disabled Approve) rather than a second
// implementation of the save/draft/approve machinery.
//
// Note save semantics (CLAUDE.md): nothing leaves the browser until Save is
// clicked. Every keystroke is stashed in the IndexedDB drafts store keyed by
// templateKey() and restored on mount, so leaving and coming back — or a
// reload — never silently discards typing. Templates are book-agnostic
// (DraftMeta carries no book/chapter/verse), same as tW/tA articles.

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CheckIcon from "@mui/icons-material/Check";
import HistoryIcon from "@mui/icons-material/History";
import SaveIcon from "@mui/icons-material/Save";

import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { MarkdownView } from "../MarkdownView";
import { TemplateHistoryDialog } from "../TemplateHistoryDialog";
import { useTemplateAiDraft } from "../../hooks/useTemplateAiDraft";
import { drafts as draftStore, templateKey } from "../../sync/drafts";
import { ApiError, api, type TemplateUnit } from "../../sync/api";
import { formatEpochSecondsDateTime } from "../../lib/formatDate";

export const CURATE_STATE_LABEL_KEYS: Record<string, string> = {
  ai_draft: "moreTools.curate.stateAiDraft",
  edited: "moreTools.curate.stateEdited",
  validated: "moreTools.curate.stateValidated",
};

export function curateStateChipKind(state: TemplateUnit["translation_state"]): FlowStatusKind {
  if (state === "validated") return "approved";
  if (state === "edited") return "edited";
  if (state === "ai_draft") return "draft";
  return "skip";
}

export function curateStateLabel(state: TemplateUnit["translation_state"], t: TFunction): string {
  if (!state) return t("moreTools.curate.stateNotStarted");
  const key = CURATE_STATE_LABEL_KEYS[state];
  return key ? t(key) : state;
}

export interface CurateEditorProps {
  templateId: string;
  direction: "ltr" | "rtl";
  approvedTally: string;
  aiDisabledGlobal: boolean;
  onAiDisabled: () => void;
  onServerChange: () => void;
  /** Present only below the desktop band — renders the mobile Back arrow. */
  onBack?: () => void;
}

export function CurateEditor({
  templateId,
  direction,
  approvedTally,
  aiDisabledGlobal,
  onAiDisabled,
  onServerChange,
  onBack,
}: CurateEditorProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [unit, setUnit] = useState<TemplateUnit | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch the unit, then restore any unsaved typing persisted for it — same
  // hydrate-on-mount pattern as TemplateWorkspace.tsx, so nothing is lost by
  // navigating away and back (or reloading) before Save.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStaleDraft(false);
    api
      .getTemplate(templateId)
      .then(async (u) => {
        if (cancelled) return;
        const server = u.target_md ?? "";
        const rec = await draftStore.get(templateKey(templateId)).catch(() => undefined);
        if (cancelled) return;
        const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
        let seeded = server;
        if (typeof stored === "string") {
          if (stored === server) {
            void draftStore.clear(templateKey(templateId));
          } else {
            seeded = stored;
            if (rec && rec.expectedVersion !== u.version) setStaleDraft(true);
          }
        }
        setUnit(u);
        setDraft(seeded);
        setPreview(false);
        setExpanded(false);
        setLoading(false);
        setErrorMsg(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setUnit(null);
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const applyServerUnit = useCallback((u: TemplateUnit) => {
    setUnit(u);
    setDraft(u.target_md ?? "");
    const key = templateKey(u.template_id);
    void draftStore.get(key).then((rec) => {
      const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
      if (stored === undefined || stored === (u.target_md ?? "")) void draftStore.clear(key);
    });
  }, []);

  const persistDraft = useCallback((u: TemplateUnit, text: string) => {
    const key = templateKey(u.template_id);
    if (text === (u.target_md ?? "")) {
      void draftStore.clear(key);
      return;
    }
    void draftStore.set(key, { target_md: text }, u.version, {
      kind: "template",
      templateId: u.template_id,
      supportRef: u.support_ref,
    });
  }, []);

  const dirty = unit != null && draft !== (unit.target_md ?? "");
  const state = unit?.translation_state ?? null;
  const isValidated = state === "validated";
  const isDraftState = state === "ai_draft" || state === "edited";
  const collapsedValidated = isValidated && !expanded && !dirty;

  useEffect(() => {
    if (!isValidated) setExpanded(false);
  }, [isValidated]);

  const {
    drafting: aiDrafting,
    error: aiDraftError,
    errorCode: aiDraftErrorCode,
    clearError: clearAiDraftError,
    conflictUnit: aiConflictUnit,
    clearConflict: clearAiConflict,
    draft: requestAiDraft,
  } = useTemplateAiDraft();

  useEffect(() => {
    if (!aiDraftError) return;
    setErrorMsg(aiDraftError);
    // The 503 body classifies as this code (useTemplateAiDraft's
    // classifyTemplateDraftError) — detect it once and disable AI drafting for
    // the rest of the screen, matching the mockup's aiDisabled flag rather than
    // re-asking the server per unit. Keyed off the stable `errorCode`, NOT the
    // message: `error` is localized, so prefix-matching its English prose
    // stopped working the moment the UI language changed.
    if (aiDraftErrorCode === "disabled") onAiDisabled();
    clearAiDraftError();
  }, [aiDraftError, aiDraftErrorCode, clearAiDraftError, onAiDisabled]);

  useEffect(() => {
    if (!aiConflictUnit) return;
    applyServerUnit(aiConflictUnit);
    clearAiConflict();
    onServerChange();
  }, [aiConflictUnit, clearAiConflict, applyServerUnit, onServerChange]);

  const handleDraftWithAi = useCallback(async () => {
    if (!unit) return;
    const updated = await requestAiDraft(unit);
    if (updated) {
      applyServerUnit(updated);
      onServerChange();
    }
  }, [unit, requestAiDraft, applyServerUnit, onServerChange]);

  const handleSave = useCallback(async () => {
    if (!unit || !dirty) return;
    setSaving(true);
    try {
      const updated = await api.patchTemplate(templateId, unit.version, draft);
      applyServerUnit(updated);
      onServerChange();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const fresh = (e.body as { current?: TemplateUnit } | undefined)?.current;
        if (fresh) setUnit(fresh);
        setConflict(true);
        onServerChange();
      } else {
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setSaving(false);
    }
  }, [unit, dirty, templateId, draft, applyServerUnit, onServerChange]);

  const handleValidate = useCallback(
    async (value: boolean) => {
      if (!unit) return;
      try {
        const updated = await api.validateTemplate(templateId, value);
        applyServerUnit(updated);
        onServerChange();
      } catch (e) {
        // The 404 case (translation_state NULL) is prevented client-side by
        // disabling the button below — a 404 reaching here would mean the
        // unit changed server-side between render and click.
        setErrorMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [unit, templateId, applyServerUnit, onServerChange],
  );

  if (loading && !unit) {
    return (
      <Stack alignItems="center" sx={{ p: 4 }}>
        <CircularProgress size={24} />
      </Stack>
    );
  }
  if (!unit) {
    return (
      <Box sx={{ p: 3 }}>
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mb: 1, minWidth: 44, minHeight: 44 }} aria-label={t("moreTools.curate.backToList")}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Alert severity="error">
          {errorMsg ?? t("moreTools.curate.unitLoadFailed", { id: templateId })}
        </Alert>
      </Box>
    );
  }

  // Findings §2.14: POST /api/templates/unit/validate 404s when
  // translation_state is NULL — true for every untouched unit (194/194 in a
  // fresh seed). Approve stays visible so the feature doesn't look missing,
  // but is disabled with the real reason rather than left always-on.
  const approveDisabledReason = dirty
    ? t("moreTools.curate.saveFirst")
    : saving
      ? null
      : state === null
        ? t("moreTools.curate.nothingToApprove")
        : null;

  return (
    <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1000, mx: "auto" }}>
      <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 2 }}>
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mt: 0.25, minWidth: 44, minHeight: 44 }} aria-label={t("moreTools.curate.backToList")}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontFamily: "monospace", wordBreak: "break-word" }}>
            {unit.template_id}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5, flexWrap: "wrap" }}>
            <FlowStatusChip kind={curateStateChipKind(state)} label={curateStateLabel(state, t)} />
            <Typography variant="caption" color="text.secondary">
              {approvedTally}
            </Typography>
          </Stack>
        </Box>
        <Tooltip title={t("moreTools.curate.versionHistory")}>
          <IconButton size="small" onClick={() => setHistoryOpen(true)} sx={{ color: "text.secondary", minWidth: 44, minHeight: 44 }}>
            <HistoryIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {aiDisabledGlobal && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t("moreTools.curate.aiUnavailableInfo")}
        </Alert>
      )}

      {collapsedValidated ? (
        <Box
          role="button"
          tabIndex={0}
          onClick={() => setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setExpanded(true);
          }}
          sx={{
            cursor: "pointer",
            borderRadius: "9px",
            border: `1px solid ${theme.palette.flows.ok.main}`,
            background: theme.palette.flows.ok.soft,
            color: theme.palette.flows.ok.ink,
            px: 2,
            py: 1.5,
            mb: 2,
          }}
        >
          {t("moreTools.curate.validatedExpand")}
        </Box>
      ) : (
        <Box
          sx={{
            border: dirty ? "1.5px solid" : "1px solid",
            borderColor: dirty ? "warning.light" : "divider",
            borderRadius: 1,
            overflow: "hidden",
            mb: 1,
          }}
        >
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            {/* LEFT: English source, read-only, forced LTR */}
            <Box
              dir="ltr"
              sx={{
                p: 2,
                borderInlineEnd: { md: "1px solid" },
                borderBottom: { xs: "1px solid", md: "none" },
                borderColor: "divider",
                bgcolor: (t) => alpha(t.palette.text.primary, 0.02),
              }}
            >
              <Typography
                variant="caption"
                sx={{ display: "block", mb: 1, fontFamily: "monospace", color: "text.disabled", textTransform: "uppercase", fontSize: 10, fontWeight: 600, letterSpacing: "0.09em" }}
              >
                {t("moreTools.curate.sourceLabel")}
              </Typography>
              <MarkdownView markdown={unit.source_md} dir="ltr" />
            </Box>

            {/* RIGHT: editable target draft, or its rendered preview */}
            <Box sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{ flex: 1, fontFamily: "monospace", color: "text.disabled", textTransform: "uppercase", fontSize: 10, fontWeight: 600, letterSpacing: "0.09em" }}
                >
                  {t("moreTools.curate.targetLabel")}
                </Typography>
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  value={preview ? "preview" : "edit"}
                  onChange={(_, v) => {
                    if (v) setPreview(v === "preview");
                  }}
                  sx={{ "& .MuiToggleButton-root": { py: 0.25, px: 1.25, minHeight: 32 } }}
                >
                  <ToggleButton value="edit">{t("common.edit")}</ToggleButton>
                  <ToggleButton value="preview">{t("moreTools.common.preview")}</ToggleButton>
                </ToggleButtonGroup>
              </Stack>
              {preview ? (
                <MarkdownView markdown={draft} dir={direction} />
              ) : (
                <TextField
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    persistDraft(unit, e.target.value);
                  }}
                  fullWidth
                  multiline
                  minRows={8}
                  spellCheck={false}
                  variant="outlined"
                  inputProps={{
                    dir: direction,
                    style: {
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                      fontSize: 14,
                      lineHeight: 1.6,
                      ...(direction === "rtl" ? { textAlign: "right" as const } : {}),
                    },
                  }}
                />
              )}
            </Box>
          </Box>
        </Box>
      )}
      {isDraftState && !collapsedValidated && (
        <Typography variant="caption" sx={{ color: "text.disabled", display: "block", mb: 1.5 }}>
          {t("moreTools.curate.aiDraftReview")}
        </Typography>
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {dirty
            ? t("moreTools.curate.oneUnsaved")
            : unit.updated_at
              ? t("moreTools.curate.savedAt", { time: formatEpochSecondsDateTime(unit.updated_at) })
              : t("moreTools.curate.notSavedYet")}
        </Typography>
        <Tooltip title={isValidated ? t("moreTools.curate.approvedNoRedraft") : aiDisabledGlobal ? t("moreTools.curate.aiNotConfigured") : ""}>
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={aiDrafting ? <CircularProgress size={14} color="inherit" /> : <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />}
              disabled={dirty || saving || aiDrafting || isValidated || aiDisabledGlobal}
              onClick={handleDraftWithAi}
              sx={{ minHeight: 44 }}
            >
              {t("moreTools.curate.draftWithAi")}
            </Button>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="contained"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon sx={{ fontSize: "18px !important" }} />}
          disabled={!dirty || saving}
          onClick={handleSave}
          sx={{ minHeight: 44 }}
        >
          {t("common.save")}
        </Button>
        {isValidated ? (
          <Tooltip title={dirty ? t("moreTools.curate.saveFirst") : ""}>
            <span>
              <Button size="small" variant="text" color="warning" disabled={dirty} onClick={() => handleValidate(false)} sx={{ minHeight: 44 }}>
                {t("moreTools.curate.unapprove")}
              </Button>
            </span>
          </Tooltip>
        ) : (
          <Tooltip title={approveDisabledReason ?? ""}>
            <span>
              <Button
                size="small"
                variant="contained"
                color="success"
                startIcon={<CheckIcon sx={{ fontSize: "18px !important" }} />}
                disabled={Boolean(approveDisabledReason) || saving}
                onClick={() => handleValidate(true)}
                sx={{ minHeight: 44 }}
              >
                {t("common.approve")}
              </Button>
            </span>
          </Tooltip>
        )}
      </Stack>

      <TemplateHistoryDialog
        open={historyOpen}
        templateId={templateId}
        currentVersion={unit.version}
        direction={direction}
        onClose={() => setHistoryOpen(false)}
        onUseVersion={(md) => {
          setDraft(md);
          persistDraft(unit, md);
        }}
      />

      <Snackbar open={staleDraft} onClose={() => setStaleDraft(false)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="warning" onClose={() => setStaleDraft(false)}>
          {t("moreTools.curate.staleDraftWarning")}
        </Alert>
      </Snackbar>
      <Snackbar open={conflict} autoHideDuration={10000} onClose={() => setConflict(false)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="warning" onClose={() => setConflict(false)}>
          {t("moreTools.curate.saveConflict")}
        </Alert>
      </Snackbar>
      <Snackbar open={errorMsg !== null} autoHideDuration={6000} onClose={() => setErrorMsg(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="error" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
