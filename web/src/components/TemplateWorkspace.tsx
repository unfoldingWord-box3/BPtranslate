import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Snackbar,
  Alert,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import SaveIcon from "@mui/icons-material/Save";
import HistoryIcon from "@mui/icons-material/History";
import VisibilityIcon from "@mui/icons-material/Visibility";
import EditIcon from "@mui/icons-material/Edit";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useTranslation } from "react-i18next";
import { api, ApiError, type TemplateUnit, type TemplateUnitMeta } from "../sync/api";
// Aliased for symmetry with ArticleWorkspace, where an unaliased `drafts`
// import would be shadowed by the editor's own local draft state.
import { drafts as draftStore, templateKey, type DraftRecord } from "../sync/drafts";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { useTemplates } from "../hooks/useTemplates";
import { useTemplateAiDraft } from "../hooks/useTemplateAiDraft";
import { useTemplateBulkDraft } from "../hooks/useTemplateBulkDraft";
import { AI_NEEDS_ORG_KEY, QUICK_DRAFTS_NEED_ORG_KEY } from "../lib/aiProviderErrors";
import { MarkdownView } from "./MarkdownView";
import { TemplateHistoryDialog } from "./TemplateHistoryDialog";

type TemplateState = "ai_draft" | "edited" | "validated" | null;

// Reuse the shared translation.state* chip labels/colors (same precedence as
// the tW/tA ArticleWorkspace) so a template reads identically to an article.
function useStateChip() {
  const { t } = useTranslation();
  return useCallback(
    (state: TemplateState): { label: string; color: string } | null => {
      switch (state) {
        case "ai_draft":
          return { label: t("translation.stateAiDraft"), color: "warning.main" };
        case "edited":
          return { label: t("translation.stateEdited"), color: "info.main" };
        case "validated":
          return { label: t("translation.stateApproved"), color: "success.main" };
        default:
          return null;
      }
    },
    [t],
  );
}

function StateChip({ state }: { state: TemplateState }) {
  const chipFor = useStateChip();
  const chip = chipFor(state);
  if (!chip) return null;
  return (
    <Chip
      label={chip.label}
      size="small"
      variant="outlined"
      sx={{ height: 18, fontSize: 10, fontWeight: 600, color: chip.color, borderColor: chip.color }}
    />
  );
}

interface Props {
  templateId: string | null;
  onNavigate: (templateId: string) => void;
  onBack: () => void;
}

export function TemplateWorkspace({ templateId, onNavigate, onBack }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);

  const { units, loading, error, refetch } = useTemplates(isTranslation);

  const [search, setSearch] = useState("");
  const query = search.trim();

  const total = units.length;
  const validatedCount = units.filter((u) => u.translation_state === "validated").length;

  // Filter, then group by `type` (sheet column B) preserving server order
  // (support_ref, sheet_order). Untyped rows fall under a generic header.
  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const matches = q
      ? units.filter(
          (u) =>
            u.template_id.toLowerCase().includes(q) ||
            u.support_ref.toLowerCase().includes(q) ||
            (u.type ?? "").toLowerCase().includes(q),
        )
      : units;
    const map = new Map<string, TemplateUnitMeta[]>();
    for (const u of matches) {
      const key = u.type ?? "";
      const arr = map.get(key);
      if (arr) arr.push(u);
      else map.set(key, [u]);
    }
    return Array.from(map.entries()).map(([type, rows]) => ({ type, rows }));
  }, [units, query]);

  const hasMatches = groups.some((g) => g.rows.length > 0);

  // Which templates hold unsaved typing. Drives the rail marker below so a
  // draft you left behind on another template is findable instead of invisible.
  // NOTE: must stay above the `!isTranslation` early return — a hook below it
  // would be conditional.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => draftStore.subscribe(setDraftList), []);
  const dirtyTemplateIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "template") continue;
      ids.add(d.meta.templateId);
    }
    return ids;
  }, [draftList]);

  // Warn before a reload / tab close while template typing is unsaved. The hook
  // arms itself from the drafts store — both an async subscription and a
  // synchronous read that covers the write-commit window — so persisted
  // template drafts already trigger it and this argument is belt-and-braces
  // (it derives from the same subscription, so it can't be stricter).
  useUnsavedGuard(dirtyTemplateIds.size > 0);

  // "Draft all with AI" — pre-translate every template that has no translation
  // yet. Deliberately narrow: an approved translation is never touched (the
  // server 409s anyway), a unit that already has a target is left for the
  // per-template button, and a unit holding unsaved typing is skipped so the
  // run can't clobber it — the same guard the single-unit button applies via
  // its `dirty` disable.
  const { running: bulkRunning, progress: bulkProgress, result: bulkResult, clearResult: clearBulkResult, cancel: cancelBulk, draftAll } = useTemplateBulkDraft();
  const draftableUnits = useMemo(
    () =>
      units.filter(
        (u) =>
          u.has_target === 0 &&
          u.translation_state !== "validated" &&
          !dirtyTemplateIds.has(u.template_id),
      ),
    [units, dirtyTemplateIds],
  );
  const handleDraftAll = useCallback(async () => {
    if (bulkRunning || draftableUnits.length === 0) return;
    await draftAll(draftableUnits);
    // Versions moved server-side for every drafted unit, so the rail list must
    // be refetched before another run can send correct If-Match values.
    refetch();
  }, [bulkRunning, draftableUnits, draftAll, refetch]);

  const bulkMessage = useMemo(() => {
    if (!bulkResult) return null;
    const { drafted, failed, reason, lastErrorCode } = bulkResult;
    if (reason === "disabled")
      return lastErrorCode === AI_NEEDS_ORG_KEY ? t("ai.needsOrgKey") : t("templates.draftAllDisabled");
    if (reason === "aborted_failures")
      return t("templates.draftAllFailed", { n: drafted, code: lastErrorCode ?? "unknown" });
    if (reason === "cancelled") return t("templates.draftAllCancelled", { n: drafted });
    return failed > 0
      ? t("templates.draftAllDonePartial", { n: drafted, failed })
      : t("templates.draftAllDone", { n: drafted });
  }, [bulkResult, t]);

  if (!isTranslation) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }} spacing={1}>
        <Typography variant="h6">{t("templates.title")}</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 420 }}>
          {t("templates.glOnly")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail ── */}
      <Box
        sx={{
          width: 280,
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
            <Tooltip title={t("templates.backToScripture")}>
              <IconButton size="small" onClick={onBack} sx={{ ml: -0.5 }}>
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {t("templates.title")}
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {t("templates.approved", { n: validatedCount, total })}
          </Typography>
          {bulkRunning ? (
            <Stack direction="row" alignItems="center" spacing={1}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                {t("templates.draftAllProgress", {
                  n: bulkProgress?.done ?? 0,
                  total: bulkProgress?.total ?? 0,
                })}
              </Typography>
              <Button size="small" onClick={cancelBulk} sx={{ fontSize: 11, minWidth: 0 }}>
                {t("templates.draftAllCancel")}
              </Button>
            </Stack>
          ) : draftableUnits.length > 0 ? (
            // #551: template drafting can't use the org's own AI key yet.
            <Tooltip title={QUICK_DRAFTS_NEED_ORG_KEY ? t("ai.needsOrgKey") : ""}>
              <span style={{ alignSelf: "flex-start" }}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AutoAwesomeIcon fontSize="small" />}
                  onClick={handleDraftAll}
                  disabled={QUICK_DRAFTS_NEED_ORG_KEY}
                  sx={{ fontSize: 11 }}
                >
                  {t("templates.draftAll", { n: draftableUnits.length })}
                </Button>
              </span>
            </Tooltip>
          ) : null}
          {bulkMessage ? (
            <Alert
              severity={bulkResult?.reason === "completed" ? "success" : "warning"}
              onClose={clearBulkResult}
              sx={{ py: 0, fontSize: 11, "& .MuiAlert-message": { py: 0.5 } }}
            >
              {bulkMessage}
            </Alert>
          ) : null}
          <TextField
            size="small"
            fullWidth
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("templates.searchPlaceholder")}
            inputProps={{ style: { fontSize: 13 } }}
          />
        </Stack>

        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {loading && units.length === 0 ? (
            <Stack alignItems="center" sx={{ p: 3 }}>
              <CircularProgress size={20} />
            </Stack>
          ) : error ? (
            <Stack spacing={1.5} sx={{ p: 2 }} alignItems="flex-start">
              <Typography variant="body2" color="error">
                {t("templates.loadError")}
              </Typography>
            </Stack>
          ) : !hasMatches ? (
            <Stack spacing={1.5} sx={{ p: 2 }} alignItems="flex-start">
              <Typography variant="body2" color="text.secondary">
                {t("templates.noTemplates")}
              </Typography>
            </Stack>
          ) : (
            groups.map((g) => (
              <Box key={g.type || "__untyped"}>
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    px: 1.5,
                    pt: 1.25,
                    pb: 0.5,
                    color: "text.disabled",
                    textTransform: "uppercase",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                  }}
                >
                  {g.type || t("templates.untyped")}
                </Typography>
                {g.rows.map((u) => {
                  const selected = u.template_id === templateId;
                  return (
                    <Box
                      key={u.template_id}
                      onClick={() => onNavigate(u.template_id)}
                      sx={{
                        px: 1.5,
                        py: 0.75,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        borderInlineStart: "3px solid",
                        borderColor: selected ? "primary.main" : "transparent",
                        bgcolor: selected
                          ? (theme) => alpha(theme.palette.primary.main, 0.08)
                          : "transparent",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <Box sx={{ flex: 1, overflow: "hidden" }}>
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: "monospace",
                            fontSize: 12,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {u.template_id}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            display: "block",
                            color: "text.secondary",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {u.support_ref}
                        </Typography>
                      </Box>
                      {u.stale_source === 1 && (
                        <Tooltip title={t("templates.staleSource")}>
                          <Box
                            component="span"
                            sx={{
                              width: 7,
                              height: 7,
                              borderRadius: "50%",
                              bgcolor: "warning.main",
                              flexShrink: 0,
                            }}
                          />
                        </Tooltip>
                      )}
                      {dirtyTemplateIds.has(u.template_id) && (
                        // Same warning colour (Kindle) the verse/row/article
                        // editors use for "unsaved typing lives here".
                        <Tooltip title={t("templates.unsavedDraft")}>
                          <Box
                            component="span"
                            aria-label={t("templates.unsavedDraft")}
                            sx={{
                              width: 8,
                              height: 8,
                              borderRadius: "50%",
                              bgcolor: "#E59D33",
                              flexShrink: 0,
                            }}
                          />
                        </Tooltip>
                      )}
                      <StateChip state={u.translation_state} />
                    </Box>
                  );
                })}
              </Box>
            ))
          )}
        </Box>
      </Box>

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {!templateId ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }}>
            <Typography variant="body2" color="text.secondary">
              {t("templates.selectTemplate")}
            </Typography>
          </Stack>
        ) : (
          <TemplateEditor
            key={templateId}
            templateId={templateId}
            direction={cfg?.direction ?? "ltr"}
            onServerChange={refetch}
          />
        )}
      </Box>
    </Box>
  );
}

interface EditorProps {
  templateId: string;
  direction: "ltr" | "rtl";
  // Refetch the rail so its chips/counters reflect a save/validate.
  onServerChange: () => void;
}

function TemplateEditor({ templateId, direction, onServerChange }: EditorProps) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<TemplateUnit | null>(null);
  // Starts true: this editor is always mounted keyed by its template (see the
  // callers), so the load effect below runs once per mount and needs no
  // synchronous loading/staleDraft reset of its own.
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch the unit, then restore any unsaved typing persisted for it. Template
  // drafts used to live only in this component's state, so every exit (Back,
  // picking another template, a TopBar menu item, reload) silently discarded
  // them. Hydrating here — in the same effect that seeds `draft`, so the two
  // can't race — is what makes leaving and coming back non-destructive.
  useEffect(() => {
    let cancelled = false;
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
            // The draft has become a no-op — the server now holds this exact
            // text (saved from another tab, or by someone else). Restoring it
            // would leave nothing dirty, so Save stays disabled and the user
            // has no way to clear the "N unsaved" chip it keeps arming.
            void draftStore.clear(templateKey(templateId));
          } else {
            // Restore even when the server version moved on while we were away
            // — stranding the draft would leave the user with text they can't
            // see and an "unsaved" marker they can't clear. But flag it: Save
            // sends the freshly fetched version as If-Match, so it would
            // succeed and quietly overwrite the newer server text.
            seeded = stored;
            if (rec && rec.expectedVersion !== u.version) setStaleDraft(true);
          }
        }
        setUnit(u);
        setDraft(seeded);
        setPreview(false);
        setExpanded(false);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
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
    // Drop the persisted draft only once the server actually holds this text.
    // After a save that's true and the draft is redundant. But this also runs
    // for validate/unvalidate and 409-rebase responses, which carry the
    // PRE-EXISTING target_md — clearing there would delete the user's unsaved
    // typing along with the last copy of it. Comparing first makes the clear
    // safe from every call site rather than relying on the caller to know.
    const key = templateKey(u.template_id);
    void draftStore.get(key).then((rec) => {
      const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
      if (stored === undefined || stored === (u.target_md ?? "")) void draftStore.clear(key);
    });
  }, []);

  // Persist the in-progress text. Called on every keystroke, mirroring the
  // note/verse/article editors: nothing is sent to the server (that stays
  // behind the Save button), but the typing survives unmount, route changes
  // and reloads. Typing back to the server value clears the draft rather than
  // storing a no-op one, so the unsaved marker stays honest.
  const persistDraft = useCallback(
    (u: TemplateUnit, text: string) => {
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
    },
    [],
  );

  const dirty = unit != null && draft !== (unit.target_md ?? "");
  const state = unit?.translation_state ?? null;
  const isValidated = state === "validated";
  const isDraftState = state === "ai_draft" || state === "edited";

  // Collapse again once the unit leaves the validated state (adjusted during
  // render; the expander only exists while validated).
  const [prevValidated, setPrevValidated] = useState(isValidated);
  if (isValidated !== prevValidated) {
    setPrevValidated(isValidated);
    if (!isValidated) setExpanded(false);
  }
  const collapsedValidated = isValidated && !expanded && !dirty;

  const {
    drafting: aiDrafting,
    error: aiDraftError,
    clearError: clearAiDraftError,
    conflictUnit: aiConflictUnit,
    clearConflict: clearAiConflict,
    draft: requestAiDraft,
  } = useTemplateAiDraft();

  useEffect(() => {
    if (aiDraftError) {
      setErrorMsg(aiDraftError);
      clearAiDraftError();
    }
  }, [aiDraftError, clearAiDraftError]);

  useEffect(() => {
    // A 409 rebase (someone else's edit/validate won the CAS, or the unit was
    // validated out from under us) — apply the fresh row so a retry uses the
    // current version instead of resubmitting the stale one and 409ing again.
    if (aiConflictUnit) {
      applyServerUnit(aiConflictUnit);
      clearAiConflict();
      onServerChange();
    }
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
        // Non-destructive conflict: someone else's save won the CAS. REBASE the
        // version (and state/target) from the 409 body's fresh unit so a re-save
        // succeeds as last-write-wins, but KEEP the translator's draft exactly as
        // typed — never silently reload it away (that was the data-loss bug).
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
  if (!unit) return null;

  return (
    <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1400, mx: "auto" }}>
      {/* ── Header + action bar ── */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2, flexWrap: "wrap", rowGap: 0.75 }}>
        <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
          {unit.template_id}
        </Typography>
        <Chip
          label={unit.support_ref}
          size="small"
          variant="outlined"
          sx={{ height: 20, fontFamily: "monospace" }}
        />
        <StateChip state={state} />
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={t("templates.history")}>
          <IconButton size="small" onClick={() => setHistoryOpen(true)} sx={{ color: "text.secondary" }}>
            <HistoryIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip
          title={
            QUICK_DRAFTS_NEED_ORG_KEY
              ? t("ai.needsOrgKey") // #551: can't use the org's own AI key yet
              : isValidated
                ? t("templates.draftDisabledValidated")
                : ""
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              startIcon={
                aiDrafting ? (
                  <CircularProgress size={14} color="inherit" />
                ) : (
                  <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />
                )
              }
              disabled={QUICK_DRAFTS_NEED_ORG_KEY || dirty || saving || aiDrafting || isValidated}
              onClick={handleDraftWithAi}
            >
              {t("templates.draftWithAi")}
            </Button>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="contained"
          startIcon={
            saving ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <SaveIcon sx={{ fontSize: "18px !important" }} />
            )
          }
          disabled={!dirty || saving}
          onClick={handleSave}
        >
          {t("templates.save")}
        </Button>
        {isDraftState && (
          <Button
            size="small"
            variant="contained"
            color="success"
            startIcon={<CheckIcon sx={{ fontSize: "18px !important" }} />}
            disabled={dirty}
            onClick={() => handleValidate(true)}
          >
            {t("common.approve")}
          </Button>
        )}
        {isValidated && (
          <Button
            size="small"
            variant="text"
            color="warning"
            // Gated like Approve above: the validate response carries the
            // pre-existing target_md, so running it with unsaved typing in the
            // box would replace what the user just wrote with the older text.
            disabled={dirty}
            onClick={() => handleValidate(false)}
          >
            {t("translation.unapprove")}
          </Button>
        )}
      </Stack>

      {collapsedValidated ? (
        <Box
          onClick={() => setExpanded(true)}
          title={t("translation.showSource")}
          sx={{
            cursor: "pointer",
            border: "1.5px solid",
            borderColor: "success.main",
            bgcolor: (theme) => alpha(theme.palette.success.main, 0.09),
            borderRadius: 1,
            px: 2,
            py: 1.5,
            color: "text.secondary",
          }}
        >
          {t("translation.stateApproved")} — {t("translation.showSource")}
        </Box>
      ) : (
        <Box
          sx={{
            border: dirty ? "1.5px solid" : "1px solid",
            borderColor: dirty ? "warning.light" : "divider",
            borderRadius: 1,
            overflow: "hidden",
          }}
        >
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" } }}>
            {/* LEFT: English source (read-only, forced LTR) */}
            <Box
              dir="ltr"
              sx={{
                p: 2,
                borderInlineEnd: { md: "1px solid" },
                borderBottom: { xs: "1px solid", md: "none" },
                borderColor: { xs: "divider", md: "divider" },
                bgcolor: (theme) => alpha(theme.palette.text.primary, 0.02),
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  mb: 1,
                  fontFamily: "monospace",
                  color: "text.disabled",
                  textTransform: "uppercase",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.09em",
                }}
              >
                {t("translation.sourceLabel")}
              </Typography>
              <MarkdownView markdown={unit.source_md} dir="ltr" />
            </Box>

            {/* RIGHT: editable target draft (or rendered preview) */}
            <Box sx={{ p: 2 }}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography
                  variant="caption"
                  sx={{
                    flex: 1,
                    fontFamily: "monospace",
                    color: "text.disabled",
                    textTransform: "uppercase",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.09em",
                  }}
                >
                  {t("translation.draftLabel")}
                </Typography>
                <Button
                  size="small"
                  variant="text"
                  startIcon={
                    preview ? (
                      <EditIcon sx={{ fontSize: "16px !important" }} />
                    ) : (
                      <VisibilityIcon sx={{ fontSize: "16px !important" }} />
                    )
                  }
                  onClick={() => setPreview((p) => !p)}
                  sx={{ py: 0, color: "text.secondary" }}
                >
                  {preview ? t("templates.edit") : t("templates.preview")}
                </Button>
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
                  spellCheck
                  variant="outlined"
                  inputProps={{
                    dir: direction,
                    style: {
                      fontSize: `calc(14px * var(--be-reading-scale, 1))`,
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
        <Typography variant="caption" sx={{ color: "text.disabled", mt: 1, display: "block" }}>
          {t("translation.whyDraft")}
        </Typography>
      )}

      <TemplateHistoryDialog
        open={historyOpen}
        templateId={templateId}
        currentVersion={unit.version}
        direction={direction}
        onClose={() => setHistoryOpen(false)}
        // Pulling an old version into the box is unsaved typing like any other
        // — persist it too, or restoring a version and leaving would lose it.
        onUseVersion={(md) => {
          setDraft(md);
          persistDraft(unit, md);
        }}
      />

      <Snackbar
        // No autoHide (unlike the conflict snackbar below): this one guards a
        // save that would overwrite newer server text without a 409 to stop it,
        // so it shouldn't time out while the user is reading the diff. It still
        // closes on click-away — MUI's Snackbar default — matching the
        // identical warning in ArticleWorkspace.
        open={staleDraft}
        onClose={() => setStaleDraft(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setStaleDraft(false)}>
          {t("templates.staleDraft")}
        </Alert>
      </Snackbar>
      <Snackbar
        open={conflict}
        autoHideDuration={10000}
        onClose={() => setConflict(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {/* Non-destructive: the version was already rebased in handleSave, so the
            draft is preserved and the next Save wins. No reload action — that was
            the button that discarded the translator's unsaved edit. */}
        <Alert severity="warning" onClose={() => setConflict(false)}>
          {t("templates.saveConflict")}
        </Alert>
      </Snackbar>
      <Snackbar
        open={errorMsg !== null}
        autoHideDuration={6000}
        onClose={() => setErrorMsg(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="error" onClose={() => setErrorMsg(null)}>
          {errorMsg}
        </Alert>
      </Snackbar>
    </Box>
  );
}
