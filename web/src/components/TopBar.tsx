// Top bar — Option 1b ("two anchors + overflow") from the top-bar redesign.
// Left cluster (navigation) is unchanged. The right side collapses the old
// ~14 undifferentiated icon buttons into exactly four anchors: a merged
// Status indicator, the primary AI action, a "More" menu (content / resources
// / view settings), and an Account menu (identity, mode, org, preferences,
// sign out). The bar never wraps — a ResizeObserver on the bar's own width
// (not the viewport) hides the "go to ref" field and control labels below
// ~820px, matching the design's CSS container-query behavior. See
// design_handoff_topbar/README.md (bundled with the originating design doc)
// for the full spec.

import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Stack,
  Typography,
  IconButton,
  Tooltip,
  FormControl,
  Box,
  Autocomplete,
  TextField,
  InputAdornment,
  Button,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Divider,
  Switch,
} from "@mui/material";
import FormatSizeIcon from "@mui/icons-material/FormatSize";
import RemoveIcon from "@mui/icons-material/Remove";
import AddIcon from "@mui/icons-material/Add";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";
import MenuIcon from "@mui/icons-material/Menu";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import CloudDownloadOutlinedIcon from "@mui/icons-material/CloudDownloadOutlined";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import LanguageIcon from "@mui/icons-material/Language";
import CheckIcon from "@mui/icons-material/Check";
import ArticleOutlinedIcon from "@mui/icons-material/ArticleOutlined";
import NoteAltOutlinedIcon from "@mui/icons-material/NoteAltOutlined";
import TuneIcon from "@mui/icons-material/Tune";
import ViewQuiltIcon from "@mui/icons-material/ViewQuilt";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import TranslateIcon from "@mui/icons-material/Translate";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import AppsIcon from "@mui/icons-material/Apps";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import LogoutIcon from "@mui/icons-material/Logout";
import { useTranslation } from "react-i18next";
import { useProjectConfig, isTranslationProject, setProjectMode } from "../hooks/useProjectConfig";
import { UI_LANGUAGES } from "../i18n";
import { UiLangContext } from "../i18n/UiLangContext";
import { api, isAdmin, type BookListEntry, type BookSummary, type BookLintIssue } from "../sync/api";
import type { LayoutSpec } from "../lib/layoutSpec";
import { BOOKS, bookName, bookAbbr, resolveBook } from "../lib/bookNames";
import { parseReference } from "../lib/referenceParser";
import {
  ThemeModeContext,
  FontScaleContext,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
  FONT_SCALE_STEP,
} from "../theme";
import { StatusIndicator } from "./StatusIndicator";
import { SyncStatusBar } from "./SyncStatusBar";
import { PipelineStatusBar, type ToastMsg } from "./PipelineStatusBar";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { LogosSyncToggle, useLogosSyncVisible } from "./LogosSyncToggle";

// UI-chrome language switcher. Changing the language re-renders every t()
// string AND flips the whole chrome's direction when the language is RTL
// (document.dir + MUI theme.direction + the emotion RTL cache — see main.tsx).
// Kept as a standalone icon-button+menu control — PreferencesWorkspace embeds
// this directly. The TopBar's own "More ▸ View ▸ Interface language" row is a
// separate, menu-item-styled control below (renderLanguageRow) that shares
// the same UiLangContext/UI_LANGUAGES data but a different presentation.
export function UiLanguageControl() {
  const { t } = useTranslation();
  const { lang, setLang } = useContext(UiLangContext);
  // The button element, held in state (callback ref) so the Menu can anchor on
  // it without reading a ref during render.
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip title={t("topbar.uiLanguage")}>
        <IconButton
          ref={setAnchorEl}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={t("topbar.uiLanguage")}
        >
          <LanguageIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu open={open} anchorEl={anchorEl} onClose={() => setOpen(false)}>
        {UI_LANGUAGES.map((l) => (
          <MenuItem
            key={l.code}
            selected={l.code === lang}
            onClick={() => {
              setLang(l.code);
              setOpen(false);
            }}
          >
            <ListItemIcon sx={{ visibility: l.code === lang ? "visible" : "hidden" }}>
              <CheckIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{l.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

// Workspace-layout switcher: a menu of the built-in layouts (Classic + presets),
// then a "My layouts" section for user-saved layouts (Phase 5), then the
// "Save current as…" / "Manage layouts…" actions. The active layout is checked.
// Built-in layout names render in English for now (i18n Phase 3+); user layout
// names stay in whatever language the user typed. Selecting routes through
// Shell's dirty gate + mode/versions sync (see selectLayout).
function LayoutSwitcher({
  layouts,
  userLayouts = [],
  activeLayoutId,
  onSelectLayout,
  onSaveLayoutAs,
  onManageLayouts,
  onResetArrangement,
  closedRegions = [],
  onRestoreRegion,
  onRestoreAllRegions,
}: {
  layouts: LayoutSpec[];
  userLayouts?: LayoutSpec[];
  activeLayoutId: string;
  onSelectLayout: (id: string) => void;
  onSaveLayoutAs?: () => void;
  onManageLayouts?: () => void;
  // Discard the user's dragged-panel arrangement for the ACTIVE layout. Shell
  // passes it only when the active layout is non-Classic AND actually has a tree
  // override, so the item's presence is itself the availability test.
  onResetArrangement?: () => void;
  // The SECOND restore path for closed regions (the first is the in-flow reopen
  // strip in WorkspaceLayout). Both exist on purpose: the strip is adjacent to
  // the workspace and so the more discoverable, but it can only show an icon +
  // tooltip per region, and it is easy to miss when only one narrow section is
  // closed. This menu names each closed section in full and is where a user
  // already goes to undo arrangement changes ("Reset arrangement" lives here).
  closedRegions?: { id: string; label: string }[];
  onRestoreRegion?: (regionId: string) => void;
  onRestoreAllRegions?: () => void;
}) {
  const { t } = useTranslation();
  // The button element, held in state (callback ref) so the Menu can anchor on
  // it without reading a ref during render.
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  if (layouts.length === 0) return null;

  const renderLayoutItem = (l: LayoutSpec) => (
    <MenuItem
      key={l.id}
      selected={l.id === activeLayoutId}
      onClick={() => {
        onSelectLayout(l.id);
        setOpen(false);
      }}
    >
      <ListItemIcon sx={{ visibility: l.id === activeLayoutId ? "visible" : "hidden" }}>
        <CheckIcon fontSize="small" />
      </ListItemIcon>
      {/* i18n Phase 3+ : built-in layout names are English until localized. */}
      <ListItemText>{l.name}</ListItemText>
    </MenuItem>
  );

  return (
    <>
      <Tooltip title={t("topbar.layouts")}>
        <IconButton
          ref={setAnchorEl}
          size="small"
          onClick={() => setOpen(true)}
          aria-label={t("topbar.layouts")}
        >
          <ViewQuiltIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu open={open} anchorEl={anchorEl} onClose={() => setOpen(false)}>
        {layouts.map(renderLayoutItem)}
        {userLayouts.length > 0 && (
          <ListSubheader sx={{ lineHeight: 2, bgcolor: "transparent" }}>
            {t("layout.myLayouts")}
          </ListSubheader>
        )}
        {userLayouts.map(renderLayoutItem)}
        <Divider />
        {/* Entry into the Books landing page (replaces flexible mode at
            merge; classic stays). Books is now the app's default screen for
            every role. */}
        <MenuItem
          onClick={() => {
            setOpen(false);
            location.hash = "#/books";
          }}
        >
          <ListItemIcon>
            <MenuBookIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("flowBooks.title")}</ListItemText>
        </MenuItem>
        {closedRegions.length > 0 && onRestoreRegion && [
          <Divider key="closed-divider" />,
          <ListSubheader key="closed-header" sx={{ lineHeight: 2, bgcolor: "transparent" }}>
            {t("layout.closedRegions")}
          </ListSubheader>,
          ...closedRegions.map((r) => (
            <MenuItem
              key={r.id}
              onClick={() => {
                onRestoreRegion(r.id);
                setOpen(false);
              }}
            >
              <ListItemIcon>
                <VisibilityOutlinedIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t("layout.restoreRegion", { name: r.label })}</ListItemText>
            </MenuItem>
          )),
          ...(closedRegions.length > 1 && onRestoreAllRegions
            ? [
                <MenuItem
                  key="restore-all"
                  onClick={() => {
                    onRestoreAllRegions();
                    setOpen(false);
                  }}
                >
                  <ListItemIcon>
                    <VisibilityOutlinedIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText>{t("layout.restoreAllRegions")}</ListItemText>
                </MenuItem>,
              ]
            : []),
        ]}
        {(onSaveLayoutAs || onResetArrangement) && <Divider />}
        {onResetArrangement && (
          <MenuItem
            onClick={() => {
              onResetArrangement();
              setOpen(false);
            }}
          >
            <ListItemIcon>
              <RestartAltIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("layout.resetArrangement")}</ListItemText>
          </MenuItem>
        )}
        {onSaveLayoutAs && (
          <MenuItem
            onClick={() => {
              onSaveLayoutAs();
              setOpen(false);
            }}
          >
            <ListItemIcon>
              <SaveOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("layout.saveAs")}</ListItemText>
          </MenuItem>
        )}
        {onManageLayouts && (
          <MenuItem
            onClick={() => {
              onManageLayouts();
              setOpen(false);
            }}
          >
            <ListItemIcon>
              <SettingsOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t("layout.manage")}</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  );
}

// The bar collapses (never wraps) below this width. Matches the design's
// `@container (max-width: 820px)` breakpoint, measured against the bar's own
// width via ResizeObserver rather than the viewport — the rail can eat space
// independent of window size.
const NARROW_BREAKPOINT_PX = 820;

function useContainerNarrow(breakpointPx: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width < breakpointPx);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [breakpointPx]);
  return [ref, narrow] as const;
}

interface Props {
  book: string;
  chapter: number;
  verse?: number;
  // Scoped override, same shape as ResourceColumn's visibleTabs/initialTab:
  // omitted means "unchanged" (the full navigation cluster shows). Pass false
  // on non-scripture routes — today the tW/tA article workspace — to keep the
  // bar's chrome (status · AI · layouts · More · account) while dropping the
  // book picker, chapter/verse stepper, reference field and prev/next, none of
  // which mean anything for an article. `book`/`chapter` stay required and are
  // fed the last scripture position, so the controls that legitimately outlive
  // the route (status, export scope) still have a scope to name.
  showNavigation?: boolean;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
  // AI pipeline trigger — Shell renders <PipelineMenu/> and passes it through
  // unchanged; TopBar just makes it the filled primary action.
  pipelineMenu?: ReactNode;
  pipelineToast?: ToastMsg | null;
  onPipelineToastClear?: () => void;
  lintFlagIssues?: BookLintIssue[];
  lintFlagCount?: number;
  lintEscalateCount?: number;
  onGoToLintIssue?: (issue: BookLintIssue) => void;
  // Opens ExportUsfmButton's scope/version Menu anchored to the given
  // element. Shell mounts the actual (trigger-less) <ExportUsfmButton/> and
  // wires this to its imperative handle.
  onOpenExportMenu?: (anchorEl: HTMLElement) => void;
  username?: string | null;
  onLogout?: () => void;
  railCollapsed?: boolean;
  onToggleRail?: () => void;
  onRequestReload?: () => void;
  // Workspace-layout switcher (Phase 3). Omitted on the no-data branch.
  layouts?: LayoutSpec[];
  activeLayoutId?: string;
  onSelectLayout?: (id: string) => void;
  // User-saved layouts + their actions (Phase 5). Also omitted on the no-data branch.
  userLayouts?: LayoutSpec[];
  onSaveLayoutAs?: () => void;
  onManageLayouts?: () => void;
  onResetArrangement?: () => void;
  // Regions the user has closed in the ACTIVE (non-Classic) layout, in tree
  // order, with a human label. Empty/omitted hides the whole menu section.
  closedRegions?: { id: string; label: string }[];
  onRestoreRegion?: (regionId: string) => void;
  onRestoreAllRegions?: () => void;
}

export function TopBar({
  book,
  chapter,
  verse,
  showNavigation = true,
  onNavigate,
  pipelineMenu,
  pipelineToast,
  onPipelineToastClear,
  lintFlagIssues = [],
  lintFlagCount = 0,
  lintEscalateCount = 0,
  onGoToLintIssue,
  onOpenExportMenu,
  username,
  onLogout,
  railCollapsed,
  onToggleRail,
  onRequestReload,
  layouts,
  activeLayoutId,
  onSelectLayout,
  userLayouts,
  onSaveLayoutAs,
  onManageLayouts,
  onResetArrangement,
  closedRegions,
  onRestoreRegion,
  onRestoreAllRegions,
}: Props) {
  const { t } = useTranslation();
  const [books, setBooks] = useState<BookListEntry[]>([]);
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [refInput, setRefInput] = useState("");
  const [refError, setRefError] = useState<string | null>(null);
  const { mode: themeMode, toggle: toggleTheme } = useContext(ThemeModeContext);
  const { scale, setScale } = useContext(FontScaleContext);
  const { lang, setLang } = useContext(UiLangContext);
  const [logosVisible, setLogosVisible] = useLogosSyncVisible();
  const projectConfig = useProjectConfig();
  const showArticles = isTranslationProject(projectConfig);
  const [containerRef, isNarrow] = useContainerNarrow(NARROW_BREAKPOINT_PX);

  // Editor/Translator mode: an admin gets an interactive toggle, everyone else
  // a read-only indicator. `isTranslationProject` already reads cfg.mode, so the
  // rest of the app (articles, memory panels) reacts once setProjectMode lands.
  const isTranslatorMode = showArticles;
  const [modePending, setModePending] = useState(false);
  const flipMode = async () => {
    if (modePending) return;
    setModePending(true);
    try {
      await setProjectMode(isTranslatorMode ? "authoring" : "translation");
    } catch {
      /* soft-fail: leave the current mode; a later fetch reconciles */
    } finally {
      setModePending(false);
    }
  };

  useEffect(() => {
    api.getBooks().then((r) => setBooks(r.books)).catch(() => setBooks([]));
  }, []);

  useEffect(() => {
    setSummary(null);
    // Only the (hidden) navigation cluster reads `summary` — skip the fetch on
    // routes that don't show it rather than firing a request per mount.
    if (!showNavigation) return;
    api.getBookSummary(book).then(setSummary).catch(() => setSummary(null));
  }, [book, showNavigation]);

  // Un-imported books are no longer silently bootstrapped from here. Selecting
  // one routes to the Books screen with that book selected (#/books/:book),
  // where "Bring in this book" makes the user pick sources and an intent before
  // any destructive import runs. Already-imported books navigate as before.
  //
  // The retired #/import surface used to carry the requested chapter[:verse]
  // through the route so "MAT 5:3" for an un-imported book landed at 5:3 after
  // import. The Books screen opens a book at its package hub (#/package/:book),
  // which is not verse-addressable, so the tail is no longer carried and the
  // signature keeps only the book.
  const goToImport = (code: string) => {
    location.hash = `#/books/${code}`;
  };

  // Front matter included on purpose: chapter 0 renders as "Intro" in the
  // selector below and must stay reachable by prev/next. See
  // web/src/lib/bookSummary.ts for where chapter 0 IS filtered out.
  const chapterList = (summary?.chapters ?? []).map((c) => c.chapter);
  const idx = chapterList.indexOf(chapter);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < chapterList.length - 1;

  // Canonical 66-book list — unimported books surface in the dropdown with
  // a download hint, and selecting one routes to the IMPORT surface. Keeping the
  // canonical order means books always land in their familiar slot.
  const importedSet = useMemo(() => new Set(books.map((b) => b.book)), [books]);
  const bookOptions = useMemo(() => BOOKS.map((b) => b.code), []);

  const chapterOptions = useMemo(
    () => (chapterList.length > 0 ? chapterList.map(String) : [String(chapter)]),
    [chapterList, chapter],
  );

  const submitRef = () => {
    const result = parseReference(refInput);
    if (!result.ok) {
      setRefError(result.error);
      return;
    }
    const { book: refBook, chapter: refChapter, verse: refVerse } = result.ref;
    const targetBook = refBook ?? book;
    const targetChapter = refChapter ?? chapter;
    setRefError(null);
    setRefInput("");
    if (importedSet.has(targetBook)) {
      onNavigate(targetBook, targetChapter, refVerse);
    } else {
      goToImport(targetBook);
    }
  };

  // ── "More" menu ────────────────────────────────────────────────────────
  const [moreAnchor, setMoreAnchor] = useState<null | HTMLElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const [langSubmenuAnchor, setLangSubmenuAnchor] = useState<null | HTMLElement>(null);
  const closeMore = () => setMoreAnchor(null);
  const readingScalePct = Math.round(scale * 100);

  // ── Account menu ───────────────────────────────────────────────────────
  const [accountAnchor, setAccountAnchor] = useState<null | HTMLElement>(null);
  const orgLanguageLabel = projectConfig
    ? projectConfig.languageTitle || projectConfig.languageName || projectConfig.languageCode
    : null;

  const modeControl = projectConfig && (
    <Box sx={{ px: 1.75, pt: 0.5, pb: 1 }}>
      <Typography
        variant="caption"
        sx={{
          display: "block",
          mb: 0.5,
          fontWeight: 700,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          color: "text.disabled",
        }}
      >
        {t("topbar.account.mode")}
      </Typography>
      {isAdmin() ? (
        <Stack
          direction="row"
          sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}
        >
          <Button
            fullWidth
            disabled={modePending}
            onClick={() => {
              if (isTranslatorMode) void flipMode();
            }}
            startIcon={<EditOutlinedIcon fontSize="small" />}
            sx={{
              borderRadius: 0,
              textTransform: "none",
              bgcolor: !isTranslatorMode ? "#014263" : "transparent",
              color: !isTranslatorMode ? "#fff" : "text.secondary",
              "&:hover": { bgcolor: !isTranslatorMode ? "#014263" : "action.hover" },
            }}
          >
            {t("topbar.mode.editor")}
          </Button>
          <Button
            fullWidth
            disabled={modePending}
            onClick={() => {
              if (!isTranslatorMode) void flipMode();
            }}
            startIcon={<TranslateIcon fontSize="small" />}
            sx={{
              borderRadius: 0,
              textTransform: "none",
              bgcolor: isTranslatorMode ? "#014263" : "transparent",
              color: isTranslatorMode ? "#fff" : "text.secondary",
              "&:hover": { bgcolor: isTranslatorMode ? "#014263" : "action.hover" },
            }}
          >
            {t("topbar.mode.translator")}
          </Button>
        </Stack>
      ) : (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "text.disabled", px: 1, py: 0.75 }}>
          {isTranslatorMode ? <TranslateIcon fontSize="small" /> : <EditOutlinedIcon fontSize="small" />}
          <Typography variant="body2">
            {isTranslatorMode ? t("topbar.mode.translator") : t("topbar.mode.editor")}
          </Typography>
        </Box>
      )}
    </Box>
  );

  return (
    <Stack
      ref={containerRef}
      direction="row"
      alignItems="center"
      spacing={{ xs: 0.75, md: 1.5 }}
      sx={{
        px: { xs: 1, md: 2 },
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexWrap: "nowrap",
        overflow: "hidden",
        // A flex child's default min-width is `auto` (its content's intrinsic
        // size), which lets it overflow ITS OWN parent rather than shrink —
        // silently clipping the right-hand cluster (account button and
        // beyond) once content stopped fitting, and starving the
        // ResizeObserver below of a real "available width" to measure (it
        // was reading the bar's self-inflated content width, which never
        // drops below the narrow breakpoint). width:100% + minWidth:0 pins
        // the bar to its actual parent width so both the clipping and the
        // measurement are correct.
        width: "100%",
        minWidth: 0,
      }}
    >
      {/* ── Left cluster: navigation (book · chapter/verse · reference) ──
          Hidden wholesale when `showNavigation` is false: the article route
          (#/articles/tw|ta) keeps the bar's chrome but has no book or chapter
          to navigate, so every control here would be meaningless there. */}
      {showNavigation && (
        <>
        {onToggleRail && (
          <Tooltip title={railCollapsed ? t("topbar.showVerseList") : t("topbar.hideVerseList")}>
            <IconButton size="small" onClick={onToggleRail} sx={{ ml: -0.5, flexShrink: 0 }}>
              {railCollapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        )}
        <FormControl size="small" sx={{ flexShrink: 0 }}>
          <Autocomplete<string, false, true, false>
            size="small"
            value={book}
            options={bookOptions.includes(book) ? bookOptions : [book, ...bookOptions]}
            disableClearable
            onChange={(_, v) => {
              if (!v || v === book) return;
              if (importedSet.has(v)) {
                onNavigate(v, 1);
              } else {
                goToImport(v);
              }
            }}
            selectOnFocus
            openOnFocus
            filterOptions={(options, state) => {
              const q = state.inputValue.trim().toLowerCase();
              // When the input is empty OR still matches the current value
              // (user just opened the dropdown without typing), show every
              // book so they can pick a new one. Filtering only kicks in
              // once they actually type something else.
              if (!q || q === book.toLowerCase()) return options;
              const resolved = resolveBook(q);
              return options.filter((opt) => {
                if (opt.toLowerCase().startsWith(q)) return true;
                if (resolved && opt === resolved) return true;
                if (bookName(opt).toLowerCase().includes(q)) return true;
                if (bookAbbr(opt).toLowerCase().includes(q)) return true;
                // Also match the bundled English name so typing/pasting an
                // English book name still finds it under a non-English UI
                // language, not just the currently-active translation.
                const english = BOOKS.find((b) => b.code === opt)?.name;
                return !!english && english.toLowerCase().includes(q);
              });
            }}
            getOptionLabel={(opt) => opt}
            renderOption={(props, opt) => {
              const isImported = importedSet.has(opt);
              return (
                <li
                  {...props}
                  key={opt}
                  style={{ fontFamily: "monospace", opacity: isImported ? 1 : 0.6 }}
                >
                  <span style={{ minWidth: 40, display: "inline-block" }}>{opt}</span>
                  <Box
                    component="span"
                    sx={{ color: "text.secondary", fontSize: 12, ml: 1, flex: 1 }}
                  >
                    {bookName(opt)}
                    {bookAbbr(opt) !== bookName(opt) && ` (${bookAbbr(opt)})`}
                  </Box>
                  {!isImported && (
                    <Tooltip title={t("topbar.notImportedHint")}>
                      <CloudDownloadIcon
                        fontSize="inherit"
                        sx={{ ml: 1, color: "text.disabled", fontSize: 14 }}
                      />
                    </Tooltip>
                  )}
                </li>
              );
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                inputProps={{
                  ...params.inputProps,
                  style: { fontFamily: "monospace", textTransform: "uppercase" },
                }}
              />
            )}
            sx={{ width: 112 }}
          />
        </FormControl>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0 }}>
          <Tooltip title={t("topbar.previousChapter")}>
            <span>
              <IconButton
                size="small"
                disabled={!canPrev}
                onClick={() => canPrev && onNavigate(book, chapterList[idx - 1])}
              >
                <NavigateBeforeIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Typography
            variant="caption"
            sx={{ fontFamily: "monospace", color: "text.secondary", userSelect: "none" }}
          >
            {t("topbar.chapterAbbrev")}
          </Typography>
          <FormControl size="small">
            <Autocomplete<string, false, true, false>
              size="small"
              value={String(chapter)}
              options={chapterOptions}
              disableClearable
              onChange={(_, v) => {
                if (v) onNavigate(book, parseInt(v, 10));
              }}
              getOptionLabel={(opt) => (opt === "0" ? t("topbar.intro") : opt)}
              filterOptions={(options, state) => {
                const q = state.inputValue.trim();
                if (!q) return options;
                return options.filter((opt) =>
                  opt === "0" ? "intro".startsWith(q.toLowerCase()) : opt.startsWith(q),
                );
              }}
              renderOption={(props, opt) => (
                <li {...props} key={opt} style={{ fontFamily: "monospace" }}>
                  {opt === "0" ? t("topbar.intro") : opt}
                </li>
              )}
              renderInput={(params) => (
                <TextField
                  {...params}
                  inputProps={{
                    ...params.inputProps,
                    style: { fontFamily: "monospace", textAlign: "center" },
                  }}
                />
              )}
              sx={{ width: 76 }}
            />
          </FormControl>
          <Tooltip title={t("topbar.nextChapter")}>
            <span>
              <IconButton
                size="small"
                disabled={!canNext}
                onClick={() => canNext && onNavigate(book, chapterList[idx + 1])}
              >
                <NavigateNextIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
        {!isNarrow && (
          <Tooltip title={refError ?? t("topbar.goToRefHint")} open={refError ? true : undefined}>
            <TextField
              size="small"
              placeholder={t("topbar.goToRefPlaceholder")}
              value={refInput}
              onChange={(e) => {
                setRefInput(e.target.value);
                if (refError) setRefError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitRef();
                } else if (e.key === "Escape") {
                  setRefInput("");
                  setRefError(null);
                }
              }}
              error={Boolean(refError)}
              inputProps={{ style: { fontFamily: "monospace", fontSize: 13 } }}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title={t("common.go")}>
                      <span>
                        <IconButton
                          size="small"
                          onClick={submitRef}
                          disabled={!refInput.trim()}
                          edge="end"
                        >
                          <ArrowForwardIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </InputAdornment>
                ),
              }}
              sx={{ width: 170, flexShrink: 0 }}
            />
          </Tooltip>
        )}
        {logosVisible && !isNarrow && (
          <LogosSyncToggle book={book} chapter={chapter} verse={verse ?? 1} />
        )}
        </>
      )}

      <Box sx={{ flex: 1, minWidth: 8 }} />

      {/* ── Right cluster: Status · AI · More · Account ───────────────── */}
      <StatusIndicator
        book={book}
        flagIssues={lintFlagIssues}
        flagCount={lintFlagCount}
        escalateCount={lintEscalateCount}
        onGoToIssue={onGoToLintIssue ?? (() => {})}
        onNavigate={onNavigate}
        onRequestReload={onRequestReload}
      />

      {pipelineMenu}

      {layouts && activeLayoutId && onSelectLayout && (
        <LayoutSwitcher
          layouts={layouts}
          userLayouts={userLayouts}
          activeLayoutId={activeLayoutId}
          onSelectLayout={onSelectLayout}
          onSaveLayoutAs={onSaveLayoutAs}
          onManageLayouts={onManageLayouts}
          onResetArrangement={onResetArrangement}
          closedRegions={closedRegions}
          onRestoreRegion={onRestoreRegion}
          onRestoreAllRegions={onRestoreAllRegions}
        />
      )}

      <Button
        ref={moreButtonRef}
        variant="outlined"
        size="small"
        onClick={(e) => setMoreAnchor(e.currentTarget)}
        startIcon={<AppsIcon fontSize="small" />}
        endIcon={!isNarrow ? <ArrowDropDownIcon fontSize="small" sx={{ color: "text.disabled" }} /> : undefined}
        sx={{
          textTransform: "none",
          color: "text.secondary",
          borderColor: "divider",
          minWidth: 0,
          px: isNarrow ? 1 : 1.5,
          flexShrink: 0,
        }}
      >
        {!isNarrow && t("topbar.more.title")}
      </Button>
      <Menu
        anchorEl={moreAnchor}
        open={Boolean(moreAnchor)}
        onClose={closeMore}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 280 } } }}
      >
        {projectConfig && (
          <ListSubheader sx={{ lineHeight: "2em", bgcolor: "transparent" }}>
            {t("topbar.more.content")}
          </ListSubheader>
        )}
        {projectConfig && (
          <MenuItem
            onClick={() => {
              closeMore();
              location.hash = "#/books";
            }}
          >
            <ListItemIcon>
              <CloudDownloadOutlinedIcon fontSize="small" sx={{ color: "primary.main" }} />
            </ListItemIcon>
            <ListItemText primary={t("topbar.more.importTitle")} secondary={t("topbar.more.importSecondary")} />
          </MenuItem>
        )}
        {/* Export is chapter/book-scoped and lives on Shell's imperative
            handle. Without that handle the row was still rendered and simply
            did nothing when clicked, so it's gated on the callback now —
            which also removes it from the article route. */}
        {projectConfig && onOpenExportMenu && (
          <MenuItem
            onClick={() => {
              closeMore();
              // Anchor to the persistent "More" trigger button, not this
              // MenuItem — the More Menu unmounts its content (including this
              // node) after its ~195ms close transition, which would leave
              // ExportUsfmButton's scope/version Menu anchored to a detached
              // element if the user scrolled/resized while it was still open.
              if (moreButtonRef.current) onOpenExportMenu?.(moreButtonRef.current);
            }}
          >
            <ListItemIcon>
              <FileDownloadIcon fontSize="small" sx={{ color: "primary.main" }} />
            </ListItemIcon>
            <ListItemText primary={t("topbar.more.exportTitle")} secondary={t("topbar.more.exportSecondary")} />
          </MenuItem>
        )}

        {showArticles && <Divider />}
        {showArticles && (
          <ListSubheader sx={{ lineHeight: "2em", bgcolor: "transparent" }}>
            {t("topbar.more.resources")}
          </ListSubheader>
        )}
        {showArticles && (
          <MenuItem
            onClick={() => {
              closeMore();
              location.hash = "#/articles/tw";
            }}
          >
            <ListItemIcon>
              <ArticleOutlinedIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("articles.title")} />
          </MenuItem>
        )}
        {showArticles && (
          <MenuItem
            onClick={() => {
              closeMore();
              location.hash = "#/templates";
            }}
          >
            <ListItemIcon>
              <NoteAltOutlinedIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("templates.title")} />
          </MenuItem>
        )}

        <Divider />
        <ListSubheader sx={{ lineHeight: "2em", bgcolor: "transparent" }}>
          {t("topbar.more.view")}
        </ListSubheader>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 0.75 }}>
          <FormatSizeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          <Typography variant="body2" sx={{ flex: 1 }}>
            {t("topbar.readingTextSize")}
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}
          >
            <IconButton
              size="small"
              onClick={() => setScale(scale - FONT_SCALE_STEP)}
              disabled={scale <= FONT_SCALE_MIN + 1e-6}
              aria-label={t("topbar.decreaseReadingTextSize")}
            >
              <RemoveIcon sx={{ fontSize: 14 }} />
            </IconButton>
            <Typography
              variant="caption"
              sx={{ px: 0.5, fontFamily: "monospace", minWidth: 34, textAlign: "center" }}
            >
              {readingScalePct}%
            </Typography>
            <IconButton
              size="small"
              onClick={() => setScale(scale + FONT_SCALE_STEP)}
              disabled={scale >= FONT_SCALE_MAX - 1e-6}
              aria-label={t("topbar.increaseReadingTextSize")}
            >
              <AddIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Stack>
        </Box>

        <MenuItem autoFocus onClick={toggleTheme}>
          <ListItemIcon>
            <DarkModeIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText primary={t(themeMode === "dark" ? "topbar.switchToLight" : "topbar.switchToDark")} />
          <Switch size="small" checked={themeMode === "dark"} sx={{ pointerEvents: "none" }} />
        </MenuItem>

        <MenuItem onClick={(e) => setLangSubmenuAnchor(e.currentTarget)}>
          <ListItemIcon>
            <LanguageIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText
            primary={t("topbar.uiLanguage")}
            secondary={UI_LANGUAGES.find((l) => l.code === lang)?.label}
          />
        </MenuItem>
        <Menu
          anchorEl={langSubmenuAnchor}
          open={Boolean(langSubmenuAnchor)}
          onClose={() => setLangSubmenuAnchor(null)}
        >
          {UI_LANGUAGES.map((l) => (
            <MenuItem
              key={l.code}
              selected={l.code === lang}
              onClick={() => {
                setLang(l.code);
                setLangSubmenuAnchor(null);
                closeMore();
              }}
            >
              <ListItemIcon sx={{ visibility: l.code === lang ? "visible" : "hidden" }}>
                <CheckIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{l.label}</ListItemText>
            </MenuItem>
          ))}
        </Menu>

        {/* This toggle's only effect is showing/hiding the Logos control in
            the navigation cluster, which is book+verse-scoped. With navigation
            hidden the row would flip a switch with no visible consequence, so
            it hides with the cluster it governs. */}
        {showNavigation && (
          <MenuItem onClick={() => setLogosVisible(!logosVisible)}>
            <ListItemIcon>
              <OpenInNewIcon fontSize="small" sx={{ color: "text.secondary" }} />
            </ListItemIcon>
            <ListItemText primary={t("topbar.more.showLogosSync")} />
            <Switch size="small" checked={logosVisible} sx={{ pointerEvents: "none" }} />
          </MenuItem>
        )}
      </Menu>

      <Divider orientation="vertical" flexItem sx={{ my: 0.5 }} />

      <IconButton
        size="small"
        onClick={(e) => setAccountAnchor(e.currentTarget)}
        sx={{
          width: 32,
          height: 32,
          flexShrink: 0,
          bgcolor: "#014263",
          color: "#fff",
          fontSize: 13,
          fontWeight: 700,
          "&:hover": { bgcolor: "#014263", opacity: 0.9 },
        }}
      >
        {(username?.[0] ?? "?").toUpperCase()}
      </IconButton>
      <Menu
        anchorEl={accountAnchor}
        open={Boolean(accountAnchor)}
        onClose={() => setAccountAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        {(username || orgLanguageLabel) && (
          <Box sx={{ px: 1.75, pt: 1.25, pb: 1 }}>
            {username && <Typography variant="subtitle2">{`@${username}`}</Typography>}
            {orgLanguageLabel && (
              <Typography variant="caption" color="text.secondary">
                {projectConfig?.org} ({orgLanguageLabel})
              </Typography>
            )}
          </Box>
        )}
        {projectConfig && <Divider />}
        {modeControl}
        <WorkspaceSwitcher variant="menuItem" />
        <MenuItem
          autoFocus
          onClick={() => {
            setAccountAnchor(null);
            location.hash = "#/preferences";
          }}
        >
          <ListItemIcon>
            <TuneIcon fontSize="small" sx={{ color: "text.secondary" }} />
          </ListItemIcon>
          <ListItemText primary={t("preferences.title")} />
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            setAccountAnchor(null);
            onLogout?.();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" sx={{ color: "#B4462B" }} />
          </ListItemIcon>
          <ListItemText primary={t("shell.signOut")} sx={{ color: "#B4462B" }} />
        </MenuItem>
      </Menu>

      {/* Always-live, invisible instances: the conflict/failed floating panel
          and discard dialog (SyncStatusBar) and the toast (PipelineStatusBar)
          must keep working regardless of whether the Status popover above is
          open. Their own inline chip/trigger is suppressed — StatusIndicator
          shows a second, popover-embedded instance of each for interactive
          detail while it's open. */}
      <SyncStatusBar hideInlineChip />
      <PipelineStatusBar toast={pipelineToast} onToastClear={onPipelineToastClear} hideChip />
    </Stack>
  );
}
