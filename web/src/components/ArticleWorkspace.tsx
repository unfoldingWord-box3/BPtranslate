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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckIcon from "@mui/icons-material/Check";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import VisibilityIcon from "@mui/icons-material/Visibility";
import EditIcon from "@mui/icons-material/Edit";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";
import MenuIcon from "@mui/icons-material/Menu";
import { useTranslation } from "react-i18next";
import { api, ApiError, type ArticleUnit, type ArticleUnitMeta } from "../sync/api";
// Aliased: ArticleEditor has its own local `drafts` state (path → text), and an
// unaliased import would be shadowed by it inside that component.
import { drafts as draftStore, articleKey, type DraftRecord } from "../sync/drafts";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { pipelineStore, getSessionKey } from "../sync/pipelineStore";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { useArticles } from "../hooks/useArticles";
import { useArticleRailCollapsed } from "../lib/editorPrefs";
import { isAiProviderNotConfigured } from "../lib/aiProviderErrors";
import { MarkdownView } from "./MarkdownView";

type ArticleState = "ai_draft" | "edited" | "validated" | null;

// Aggregate the state of an article's parts into a single chip state, mirroring
// the QuestionCard precedence: any ai_draft wins, else any edited, else all
// validated, else none.
function aggregateState(states: ArticleState[]): ArticleState {
  if (states.some((s) => s === "ai_draft")) return "ai_draft";
  if (states.some((s) => s === "edited")) return "edited";
  // "validated" once every TRANSLATED part is validated — untranslated (NULL)
  // parts (e.g. a tA title/sub-title the bot didn't touch) don't block it.
  const translated = states.filter((s) => s != null);
  if (translated.length > 0 && translated.every((s) => s === "validated")) return "validated";
  return null;
}

// tA articles order title → sub-title → body; tw is body-only.
const PART_ORDER: Record<string, number> = { title: 0, "sub-title": 1, body: 2 };
function orderParts(list: ArticleUnit[]): ArticleUnit[] {
  return [...list].sort((a, b) => (PART_ORDER[a.part] ?? 9) - (PART_ORDER[b.part] ?? 9));
}

function useStateChip() {
  const { t } = useTranslation();
  return useCallback(
    (state: ArticleState): { label: string; color: string } | null => {
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

function StateChip({ state }: { state: ArticleState }) {
  const chipFor = useStateChip();
  const chip = chipFor(state);
  if (!chip) return null;
  return (
    <Chip
      label={chip.label}
      size="small"
      variant="outlined"
      sx={{
        height: 18,
        fontSize: 10,
        fontWeight: 600,
        color: chip.color,
        borderColor: chip.color,
      }}
    />
  );
}

interface Props {
  resource: "tw" | "ta";
  articleId: string | null;
  onNavigate: (resource: "tw" | "ta", articleId: string) => void;
  onBack: () => void;
}

export function ArticleWorkspace({ resource, articleId, onNavigate, onBack }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  const isTranslation = isTranslationProject(cfg);
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  // Compact whenever an article is open at the width where the editor's
  // source|target split is active — that's when the full 280px rail crowds
  // the "both mode" side-by-side view.
  const compact = isDesktop && !!articleId;
  const [railCollapsed, setRailCollapsed] = useArticleRailCollapsed();

  const { units, loading, refetch } = useArticles(isTranslation ? resource : null);

  // Group rail metadata by article_id, preserving first-seen order.
  const articles = useMemo(() => {
    const map = new Map<string, ArticleUnitMeta[]>();
    for (const u of units) {
      const arr = map.get(u.article_id);
      if (arr) arr.push(u);
      else map.set(u.article_id, [u]);
    }
    return Array.from(map.entries()).map(([id, parts]) => ({
      id,
      parts,
      state: aggregateState(parts.map((p) => p.translation_state)),
    }));
  }, [units]);

  const total = articles.length;
  const validatedCount = articles.filter((a) => a.state === "validated").length;

  const selectedPaths = useMemo(
    () => (articleId ? units.filter((u) => u.article_id === articleId).map((u) => u.path) : []),
    [units, articleId],
  );

  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [snack, setSnack] = useState<string | null>(null);

  const query = search.trim();
  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return q ? articles.filter((a) => a.id.toLowerCase().includes(q)) : articles;
  }, [articles, query]);

  // Add a single article by the typed id (e.g. "kt/grace") when the search
  // matches nothing locally — fetches its source and navigates to it.
  const handleAdd = useCallback(async () => {
    if (!query || busy) return;
    setBusy(true);
    setSnack(null);
    try {
      const res = await api.addArticle(resource, query);
      refetch();
      onNavigate(resource, res.article_id);
      setSearch("");
      setSnack(t("articles.articleAdded", { id: res.article_id }));
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
      setSnack(
        code === "source_not_found"
          ? t("articles.addUnknownId", { id: query })
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }, [query, busy, resource, refetch, onNavigate, t]);

  // Populate the workspace from the imported books' referenced articles. The
  // route processes one bounded chunk per call, so loop until nothing remains.
  const handlePopulate = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setSnack(null);
    try {
      let warnings = 0;
      let aborted = false;
      let guard = 0;
      for (;;) {
        const res = await api.populateArticles();
        warnings += res.warnings?.length ?? 0;
        if (res.aborted) aborted = true;
        if (res.skipped || res.aborted || res.remaining === 0 || ++guard > 200) break;
      }
      refetch();
      setSnack(
        aborted
          ? t("articles.populateAborted")
          : warnings > 0
            ? t("articles.populateWarnings", { n: warnings })
            : t("articles.populateDone"),
      );
    } catch (e) {
      setSnack(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refetch, t]);

  // Which articles hold unsaved typing. Drives the rail marker below so a
  // draft you left behind on another article is findable instead of invisible.
  // NOTE: must stay above the `!isTranslation` early return — a hook below it
  // would be conditional.
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => draftStore.subscribe(setDraftList), []);
  const dirtyArticleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "article" || d.meta.resource !== resource) continue;
      ids.add(d.meta.articleId);
    }
    return ids;
  }, [draftList, resource]);

  // Warn before a reload / tab close while article typing is unsaved. The hook
  // reads the drafts store itself, so persisted article drafts already arm it;
  // passing the local signal too covers the write-commit window.
  useUnsavedGuard(dirtyArticleIds.size > 0);

  if (!isTranslation) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }} spacing={1}>
        <Typography variant="h6">{t("articles.title")}</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 420 }}>
          {t("articles.glOnly")}
        </Typography>
      </Stack>
    );
  }

  return (
    <Box sx={{ height: "100%", display: "flex", minHeight: 0 }}>
      {/* ── Left rail ── */}
      {railCollapsed ? (
        <Box
          sx={{
            width: 40,
            flexShrink: 0,
            borderInlineEnd: "1px solid",
            borderColor: "divider",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            pt: 1,
          }}
        >
          <Tooltip title={t("articles.showList")}>
            <IconButton size="small" onClick={() => setRailCollapsed(false)}>
              <MenuIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("articles.backToScripture")}>
            <IconButton size="small" onClick={onBack}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      ) : (
      <Box
        sx={{
          width: compact ? 170 : 280,
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
            <Tooltip title={t("articles.backToScripture")}>
              <IconButton size="small" onClick={onBack} sx={{ ml: -0.5 }}>
                <ArrowBackIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1 }}>
              {t("articles.title")}
            </Typography>
            <Tooltip title={t("articles.hideList")}>
              <IconButton size="small" onClick={() => setRailCollapsed(true)}>
                <MenuOpenIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={resource}
            onChange={(_, v) => {
              if (v && v !== resource) onNavigate(v as "tw" | "ta", "");
            }}
          >
            <ToggleButton value="tw" sx={{ textTransform: "none", py: 0.25 }}>
              {t("articles.words")}
            </ToggleButton>
            <ToggleButton value="ta" sx={{ textTransform: "none", py: 0.25 }}>
              {t("articles.academy")}
            </ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            {t("articles.approved", { n: validatedCount, total })}
          </Typography>
          <TextField
            size="small"
            fullWidth
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("articles.searchPlaceholder")}
            inputProps={{ style: { fontSize: 13 } }}
          />
        </Stack>

        <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {loading && articles.length === 0 ? (
            <Stack alignItems="center" sx={{ p: 3 }}>
              <CircularProgress size={20} />
            </Stack>
          ) : articles.length === 0 ? (
            // Empty workspace — offer to populate from the imported books, and
            // (when the user has typed an id) to add that one article straight
            // from source. Without the Add option here, manual seeding would be
            // unreachable on a fresh resource — the case that needs it most.
            <Stack spacing={1.5} sx={{ p: 2 }} alignItems="flex-start">
              <Typography variant="body2" color="text.secondary">
                {t("articles.noArticles")}
              </Typography>
              <Button
                size="small"
                variant="contained"
                disabled={busy}
                startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                onClick={handlePopulate}
              >
                {t("articles.populateFromBooks")}
              </Button>
              {query && (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                  onClick={handleAdd}
                >
                  {t("articles.addArticle", { id: query })}
                </Button>
              )}
            </Stack>
          ) : filtered.length === 0 ? (
            // No local match — offer to add the typed id straight from source.
            <Stack spacing={1.5} sx={{ p: 2 }} alignItems="flex-start">
              <Typography variant="body2" color="text.secondary">
                {t("articles.noArticles")}
              </Typography>
              {query && (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
                  onClick={handleAdd}
                >
                  {t("articles.addArticle", { id: query })}
                </Button>
              )}
            </Stack>
          ) : (
            filtered.map((a) => {
              const selected = a.id === articleId;
              const unsaved = dirtyArticleIds.has(a.id);
              // Always the same element tree in both modes — an empty title
              // disables the Tooltip — so toggling compact doesn't remount the
              // list and lose its scroll position.
              return (
                <Tooltip key={a.id} title={compact ? a.id : ""}>
                <Box
                  onClick={() => onNavigate(resource, a.id)}
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
                  <Typography
                    variant="body2"
                    sx={{
                      flex: 1,
                      fontFamily: "monospace",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {compact ? a.id.split("/").pop() : a.id}
                  </Typography>
                  {unsaved && (
                    // Same warning colour (Kindle) the verse/row editors use for
                    // "unsaved typing lives here".
                    <Tooltip title={t("articles.unsavedDraft")}>
                      <Box
                        aria-label={t("articles.unsavedDraft")}
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
                  {!compact && <StateChip state={a.state} />}
                </Box>
                </Tooltip>
              );
            })
          )}
        </Box>
      </Box>
      )}

      {/* ── Main pane ── */}
      <Box sx={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {!articleId ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", px: 4 }}>
            <Typography variant="body2" color="text.secondary">
              {t("articles.selectArticle")}
            </Typography>
          </Stack>
        ) : (
          <ArticleEditor
            key={`${resource}/${articleId}`}
            resource={resource}
            articleId={articleId}
            paths={selectedPaths}
            direction={cfg?.direction ?? "ltr"}
            languageTitle={cfg?.languageTitle ?? ""}
            onServerChange={refetch}
          />
        )}
      </Box>

      <Snackbar
        open={snack !== null}
        autoHideDuration={6000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="info" onClose={() => setSnack(null)}>
          {snack}
        </Alert>
      </Snackbar>
    </Box>
  );
}

interface EditorProps {
  resource: "tw" | "ta";
  articleId: string;
  paths: string[];
  direction: "ltr" | "rtl";
  languageTitle: string;
  // Refetch the rail so its chips/counters reflect a save/validate/translate.
  onServerChange: () => void;
}

function ArticleEditor({
  resource,
  articleId,
  paths,
  direction,
  languageTitle,
  onServerChange,
}: EditorProps) {
  const { t } = useTranslation();
  const pathsKey = useMemo(() => [...paths].sort().join("|"), [paths]);

  const [parts, setParts] = useState<ArticleUnit[] | null>(null);
  const [loadingParts, setLoadingParts] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const bumpReload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Fetch every part's full unit for the selected article, then restore any
  // unsaved typing persisted for those parts. Article drafts used to live only
  // in this component's state, so every exit (Back, tab switch, picking another
  // article, a TopBar menu item, reload) silently discarded them. Hydrating
  // here — in the same effect that seeds `drafts`, so the two can't race — is
  // what makes leaving and coming back non-destructive.
  useEffect(() => {
    if (!articleId || paths.length === 0) {
      setParts(null);
      return;
    }
    let cancelled = false;
    setLoadingParts(true);
    // Clear any prior warning so it can't outlive the article/refetch that
    // raised it (this effect re-runs on reloadKey without a remount).
    setStaleDraft(false);
    Promise.all(paths.map((p) => api.getArticle(resource, p)))
      .then(async (list) => {
        if (cancelled) return;
        const ordered = orderParts(list);
        const seeded = Object.fromEntries(ordered.map((u) => [u.path, u.target_md ?? ""]));
        // Restore the draft even when the server version moved on while we were
        // away (e.g. a translate re-run landed) — stranding it would leave the
        // user with text they can't see and an "unsaved" marker they can't
        // clear. But flag it: Save sends the *freshly fetched* version as
        // If-Match, so it would succeed and quietly overwrite the newer server
        // text. Warning turns that into a choice the user can see and make.
        let stale = false;
        const stored = await Promise.all(
          ordered.map((u) =>
            draftStore
              .get(articleKey(resource, u.path))
              .then((rec) => ({ unit: u, rec }))
              .catch(() => ({ unit: u, rec: undefined })),
          ),
        );
        if (cancelled) return;
        for (const { unit, rec } of stored) {
          const text = (rec?.payload as { target_md?: string } | undefined)?.target_md;
          if (typeof text !== "string") continue;
          // The draft has become a no-op — the server now holds this exact text
          // (saved from another tab, or by someone else). Restoring it would
          // leave nothing dirty, so Save stays disabled and the user has no way
          // to clear the "N unsaved" chip it keeps arming. Drop it instead.
          if (text === (unit.target_md ?? "")) {
            void draftStore.clear(articleKey(resource, unit.path));
            continue;
          }
          if (rec && rec.expectedVersion !== unit.version) stale = true;
          seeded[unit.path] = text;
        }
        setParts(ordered);
        setDrafts(seeded);
        setPreviews({});
        setLoadingParts(false);
        if (stale) setStaleDraft(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setLoadingParts(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resource, articleId, pathsKey, reloadKey]);

  // A finished translate run (single-slot queue → one at a time) clears the
  // spinner and pulls in the fresh draft.
  useEffect(
    () =>
      pipelineStore.onComplete((job) => {
        if (job.pipeline_type !== "translate") return;
        setTranslating(false);
        if (job.state === "done") {
          bumpReload();
          onServerChange();
        }
      }),
    [bumpReload, onServerChange],
  );

  const applyServerUnit = useCallback(
    (u: ArticleUnit) => {
      setParts((prev) => (prev ? prev.map((p) => (p.path === u.path ? u : p)) : prev));
      setDrafts((prev) => ({ ...prev, [u.path]: u.target_md ?? "" }));
      // Drop the persisted draft only once the server actually holds this text.
      // After a save that's true and the draft is redundant. But this also runs
      // for validate/unvalidate responses, which carry the PRE-EXISTING
      // target_md — clearing there would delete the user's unsaved typing along
      // with the last copy of it. Comparing first makes the clear safe from
      // every call site rather than relying on the caller to know.
      const key = articleKey(resource, u.path);
      void draftStore.get(key).then((rec) => {
        const stored = (rec?.payload as { target_md?: string } | undefined)?.target_md;
        if (stored === undefined || stored === (u.target_md ?? "")) void draftStore.clear(key);
      });
    },
    [resource],
  );

  // Persist one part's in-progress text. Called on every keystroke, mirroring
  // the note/verse editors: nothing is sent to the server (that stays behind
  // the Save button), but the typing survives unmount, route changes and
  // reloads. Typing back to the server value clears the draft rather than
  // storing a no-op one, so the unsaved marker stays honest.
  const persistDraft = useCallback(
    (part: ArticleUnit, text: string) => {
      const key = articleKey(resource, part.path);
      if (text === (part.target_md ?? "")) {
        void draftStore.clear(key);
        return;
      }
      void draftStore.set(key, { target_md: text }, part.version, {
        kind: "article",
        resource,
        articleId: part.article_id,
        path: part.path,
        part: part.part,
      });
    },
    [resource],
  );

  const isDirtyPart = useCallback(
    (part: ArticleUnit) => (drafts[part.path] ?? "") !== (part.target_md ?? ""),
    [drafts],
  );
  const anyDirty = useMemo(() => (parts ?? []).some(isDirtyPart), [parts, isDirtyPart]);

  const aggregate = useMemo(
    () => aggregateState((parts ?? []).map((p) => p.translation_state ?? null)),
    [parts],
  );
  const isValidated = aggregate === "validated";
  const isDraftState = aggregate === "ai_draft" || aggregate === "edited";
  // Untranslated: no part carries a target draft or a translation state yet.
  const isUntranslated = useMemo(
    () => (parts ?? []).every((p) => !(p.target_md && p.target_md.trim()) && !p.translation_state),
    [parts],
  );

  useEffect(() => {
    if (!isValidated) setExpanded(false);
  }, [isValidated]);
  const collapsedValidated = isValidated && !expanded && !anyDirty;

  const handleSave = useCallback(async () => {
    if (!parts || !anyDirty) return;
    const dirty = parts.filter(isDirtyPart);
    setSaving(true);
    // Save every dirty part concurrently (independent PATCHes). allSettled so a
    // 409 on one part never aborts the others AND never discards their unsaved
    // drafts — successes are applied in place; the conflicting part keeps its
    // local edit and surfaces the reload banner (no silent data loss).
    const results = await Promise.allSettled(
      dirty.map((part) => api.patchArticle(resource, part.path, part.version, drafts[part.path] ?? "")),
    );
    let conflicted = false;
    let otherErr: string | null = null;
    for (const r of results) {
      if (r.status === "fulfilled") applyServerUnit(r.value);
      else if (r.reason instanceof ApiError && r.reason.status === 409) conflicted = true;
      else otherErr = r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
    if (conflicted) setConflict(true);
    if (otherErr) setErrorMsg(otherErr);
    setSaving(false);
    onServerChange();
  }, [parts, anyDirty, isDirtyPart, resource, drafts, applyServerUnit, onServerChange]);

  const handleValidate = useCallback(
    async (value: boolean) => {
      if (!parts) return;
      // Only parts the pipeline actually translated can be (un)validated — the
      // server guards on translation_state IS NOT NULL, so validating an
      // untranslated (NULL) tA part 404s. Skip them; run the rest concurrently.
      const targets = parts.filter((p) => p.translation_state != null);
      if (targets.length === 0) return;
      const results = await Promise.allSettled(
        targets.map((part) => api.validateArticle(resource, part.path, value)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") applyServerUnit(r.value);
        else setErrorMsg(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
      onServerChange();
    },
    [parts, resource, applyServerUnit, onServerChange],
  );

  const handleTranslate = useCallback(async () => {
    setTranslating(true);
    try {
      await pipelineStore.start({
        pipelineType: "translate",
        sessionKey: getSessionKey(),
        translate: { resourceType: resource, articleId },
      });
    } catch (e) {
      setTranslating(false);
      const body = (e as { body?: { error?: string } } | null)?.body;
      setErrorMsg(
        isAiProviderNotConfigured(e)
          ? t("pipeline.aiKeyNotConfigured")
          : (body?.error ?? (e instanceof Error ? e.message : String(e))),
      );
    }
  }, [resource, articleId, t]);

  const partLabel = useCallback(
    (part: ArticleUnit): string => {
      if (part.part === "title") return t("articles.partTitle");
      if (part.part === "sub-title") return t("articles.partSubTitle");
      return languageTitle || t("articles.partBody");
    },
    [t, languageTitle],
  );

  if (loadingParts && !parts) {
    return (
      <Stack alignItems="center" sx={{ p: 4 }}>
        <CircularProgress size={24} />
      </Stack>
    );
  }
  if (!parts) return null;

  return (
    <Box sx={{ p: { xs: 1.5, md: 2.5 }, maxWidth: 1400, mx: "auto" }}>
      {/* ── Article header + action bar ── */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 2, flexWrap: "wrap", rowGap: 0.75 }}
      >
        <Typography variant="h6" sx={{ fontFamily: "monospace" }}>
          {articleId}
        </Typography>
        <StateChip state={aggregate} />
        <Box sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          variant="contained"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon sx={{ fontSize: "18px !important" }} />}
          disabled={!anyDirty || saving}
          onClick={handleSave}
        >
          {t("articles.save")}
        </Button>
        {isDraftState && (
          <Button
            size="small"
            variant="contained"
            color="success"
            startIcon={<CheckIcon sx={{ fontSize: "18px !important" }} />}
            disabled={anyDirty}
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
            disabled={anyDirty}
            onClick={() => handleValidate(false)}
          >
            {t("translation.unapprove")}
          </Button>
        )}
        {(isUntranslated || isDraftState) && (
          <Button
            size="small"
            variant={isUntranslated ? "contained" : "outlined"}
            color={isUntranslated ? "secondary" : "inherit"}
            disabled={translating}
            startIcon={
              translating ? (
                <CircularProgress size={14} color="inherit" />
              ) : (
                <AutoAwesomeIcon sx={{ fontSize: "18px !important" }} />
              )
            }
            onClick={handleTranslate}
            sx={{ color: isUntranslated ? undefined : "text.secondary" }}
          >
            {translating
              ? t("translation.translating")
              : isUntranslated
                ? t("common.translate")
                : t("translation.reRun")}
          </Button>
        )}
      </Stack>

      {collapsedValidated ? (
        // Approved article: show the translated text read-only by default so a
        // finished article never renders as a blank page (#272). Only the
        // English source is collapsed, behind the full-width expander below;
        // clicking it (setExpanded) reveals the full source+target grid.
        <Stack spacing={2.5}>
          {parts.map((part) => (
            <Box
              key={part.path}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                overflow: "hidden",
                p: 2,
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
                {partLabel(part)}
              </Typography>
              <MarkdownView markdown={drafts[part.path] ?? part.target_md ?? ""} dir={direction} />
            </Box>
          ))}
          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            startIcon={<VisibilityIcon sx={{ fontSize: "18px !important" }} />}
            onClick={() => setExpanded(true)}
            sx={{ color: "text.secondary", minHeight: 44 }}
          >
            {t("translation.showSource")}
          </Button>
        </Stack>
      ) : (
        <Stack spacing={2.5}>
          {parts.map((part) => {
            const draft = drafts[part.path] ?? "";
            const preview = previews[part.path] ?? false;
            const dirty = isDirtyPart(part);
            return (
              <Box
                key={part.path}
                sx={{
                  border: dirty ? "1.5px solid" : "1px solid",
                  borderColor: dirty ? "warning.light" : "divider",
                  borderRadius: 1,
                  overflow: "hidden",
                }}
              >
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                  }}
                >
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
                    <MarkdownView markdown={part.source_md} dir="ltr" />
                  </Box>

                  {/* RIGHT: editable target draft (or rendered preview) */}
                  <Box sx={{ p: 2 }}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={1}
                      sx={{ mb: 1 }}
                    >
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
                        {partLabel(part)}
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
                        onClick={() =>
                          setPreviews((prev) => ({ ...prev, [part.path]: !preview }))
                        }
                        sx={{ py: 0, color: "text.secondary" }}
                      >
                        {preview ? t("articles.edit") : t("articles.preview")}
                      </Button>
                    </Stack>
                    {preview ? (
                      <MarkdownView markdown={draft} dir={direction} />
                    ) : (
                      <TextField
                        value={draft}
                        onChange={(e) => {
                          setDrafts((prev) => ({ ...prev, [part.path]: e.target.value }));
                          persistDraft(part, e.target.value);
                        }}
                        fullWidth
                        multiline
                        minRows={part.part === "body" ? 8 : 1}
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
            );
          })}
          {isDraftState && (
            <Typography variant="caption" sx={{ color: "text.disabled" }}>
              {t("translation.whyDraft")}
            </Typography>
          )}
        </Stack>
      )}

      <Snackbar
        // No autoHide: this one guards a save that would overwrite newer server
        // text without a 409 to stop it, so it must not disappear while the user
        // is looking elsewhere. They dismiss it deliberately.
        open={staleDraft}
        onClose={() => setStaleDraft(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setStaleDraft(false)}>
          {t("articles.staleDraft")}
        </Alert>
      </Snackbar>
      <Snackbar
        open={conflict}
        autoHideDuration={6000}
        onClose={() => setConflict(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setConflict(false)}>
          {t("articles.reloadConflict")}
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
