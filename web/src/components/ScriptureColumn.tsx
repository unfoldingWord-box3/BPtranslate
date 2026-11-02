import { lazy, Suspense, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Box, Stack, Typography, Paper, IconButton, Tooltip, ToggleButton, ToggleButtonGroup, Button, Chip, Menu, MenuItem, ListItemIcon, ListItemText } from "@mui/material";
import HistoryIcon from "@mui/icons-material/History";
import { AlignLinkButton } from "./AlignLinkButton";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import ViewStreamIcon from "@mui/icons-material/ViewStream";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import SearchIcon from "@mui/icons-material/Search";
import UndoIcon from "@mui/icons-material/Undo";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { ChapterPayload, TnRow, TwlRow, VerseDto } from "../sync/api";
import { drafts, verseKey } from "../sync/drafts";
import {
  getLaneFreezeEpoch,
  isLaneFrozen,
  subscribeLaneFreeze,
} from "../sync/laneFreeze";
import { DocColumn } from "./DocColumn";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionLabel, versionIsRtl } from "../lib/versionLabels";
import type { TextLaneCheck } from "../lib/laneChecks";
import type { FindMatch } from "./FindReplaceOverlay";
import { HebrewLine } from "./HebrewLine";
import type { LexiconEntry } from "../hooks/useLexicon";
import type { ChapterState } from "../hooks/useBook";
import { highlightsFor, overlayFindMarks, renderEditableHTML, renderHighlightedHTML, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
import { extractEditableText, extractTrailingMarkers, stripTrailingMarkers, splitSectionHeaders, type SectionHeader } from "../lib/usfm";
import { SectionHeaderBand } from "./SectionHeaderBand";
import { buildVerseIndex, formatVerseLabel, isFirstOfRange, isRangeRow } from "../lib/verseRange";
import {
  classifySourceQuery,
  matchSourceVerse,
  renderFindMatchesByOffsets,
  type SourceQueryKind,
  type SourceTokenMatch,
} from "../lib/sourceSearch";

interface SearchState {
  re: RegExp | null;
  sourceQuery: SourceQueryKind;
}

export interface FindQuery {
  find: string;
  regex: boolean;
  caseSensitive: boolean;
  // User has opted in to interpreting bare-digit queries as Strong's numbers
  // (toggle in the find overlay). Has no effect on H/G-prefixed or non-digit
  // queries — those classify unambiguously.
  strongs: boolean;
}

export type ScriptureMode = "stacked" | "columns" | "book";

interface Props {
  book: string;
  chapter: number;
  versesByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  // Transient reorder "stoplight": while a note is dragged (or for ~3s after an
  // arrow move) the active verse also lights the moved note's candidate
  // predecessor (green underline) and successor (red overline) on channels
  // separate from the yellow active fill. Null during normal editing.
  reorderHighlight?: ReorderHighlight | null;
  mode: ScriptureMode;
  enabledVersions: string[];
  availableVersions: string[];
  // Book-mode props: present only when mode === 'book'. The book view drives
  // (chapter, verse) navigation, so its callbacks carry the chapter.
  bookChapterList?: number[];
  bookChapters?: Map<number, ChapterState>;
  onLoadBookChapter?: (ch: number) => void;
  onSelectBookVerse?: (chapter: number, verse: number) => void;
  onEditBookVerse?: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Per-verse save callback for book mode. Same semantics as onSaveVerse but
  // chapter is variable (book view spans the whole book).
  onSaveBookVerse?: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onOpenBookAligner?: (chapter: number, verse: number, bibleVersion: string) => void;
  // Find/replace target. Used in all three modes — book mode passes a
  // chapter from the book cache; stacked/columns always pass the current
  // chapter. Shell dual-applies to useChapter when the chapter is loaded.
  onReplaceVerse: (chapter: number, verse: number, bibleVersion: string, newContent: unknown, newPlainText: string, base: VerseDto) => void;
  // Find/replace target for translation notes (body only). Forwarded to the
  // overlay; Shell carries the live row version into the outbox If-Match.
  onReplaceNote: (row: TnRow, newNote: string) => void;
  // Shared with the rest of the shell — bumped here on the "go to active"
  // click, and shipped to ResourceColumn so it can scroll the active
  // note/word/verse-group into view alongside the scripture.
  scrollNonce: number;
  onRequestScrollToActive: () => void;
  // Find-overlay TN search: a stable getter for the notes currently in scope
  // (forwarded to the overlay), plus a callback to navigate to + activate a
  // matched note. Stable identities so this component's memo still skips
  // re-renders on every note keystroke.
  searchNotes: () => TnRow[];
  onScrollToNoteMatch: (chapter: number, verse: number, noteId: string) => void;
  // Lift the TN find query + active body match so note cards can highlight
  // matches (forwarded straight to the overlay).
  onNoteQueryChange: (query: { find: string; regex: boolean; caseSensitive: boolean } | null) => void;
  onActiveNoteMatchChange: (match: { noteId: string; occurrence: number } | null) => void;
  // Pre-loaded UHB strong → entry map (Shell collects from useChapter +
  // useBook) so per-word hover tooltips don't shimmer.
  lexiconMap: Map<string, LexiconEntry | null>;
  // This chapter's TWL rows — fed to the UHB \w hover tooltips so they show
  // the same "tW" link the aligner does. Book mode sources its own per-chapter
  // TWL from bookChapters instead.
  twl: TwlRow[];
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
  onModeChange: (mode: ScriptureMode) => void;
  onEnabledVersionsChange: (versions: string[]) => void;
  onEditVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Persist a draft to outbox: takes the row's current local plain text,
  // runs it through smartEditVerse, and enqueues. Shell wires this; both
  // stacked rows and the column-style modes call it on Save click.
  onSaveVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Restore a ULT/UST verse to a previously-saved version: re-saves the exact
  // stored content tree (alignment included) through the normal verse pipe.
  // Stacked-mode only (the version chip lives on the active stacked card).
  onRestoreVerse: (
    verseNum: number,
    bibleVersion: string,
    content: unknown,
    plainText: string | null,
    base: VerseDto,
  ) => void;
  // Section-band edit / delete. Splice the new (tag, text) into the
  // verse's verseObjects.sections (filtered by splitSectionHeaders) and
  // save via outbox. tag === null deletes the band entirely. Used by
  // chapter-scoped modes (stacked, columns).
  onEditSection?: (
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  // Book-mode variant — chapter is variable because BookView spans the
  // whole book. Same splice/save semantics as onEditSection above.
  onEditBookSection?: (
    chapter: number,
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  // Chapter is mid-flight for an AI pipeline. Renders all editable bibles
  // (ULT/UST) as read-only too — UHB/UGNT already are by virtue of
  // READ_ONLY_VERSIONS. The banner above the column tells the user why.
  locked?: boolean;
  // Per-verse Text-lane checkoff, forwarded to the column/book scripture views.
  textCheck?: TextLaneCheck;
}

const READ_ONLY_VERSIONS = new Set(["UHB", "UGNT"]);

// Stable empty column so a missing version (`indexByVersion["ULT"] ?? …`)
// doesn't hand InactiveVerseRow a fresh `{}` each render and defeat its memo.
const EMPTY_COLUMN: Record<number, VerseDto> = {};

const BookView = lazy(() =>
  import("./BookView").then((m) => ({ default: m.BookView })),
);
const FindReplaceOverlay = lazy(() =>
  import("./FindReplaceOverlay").then((m) => ({ default: m.FindReplaceOverlay })),
);
const VerseHistoryDialog = lazy(() =>
  import("./VerseHistoryDialog").then((m) => ({ default: m.VerseHistoryDialog })),
);

function ScriptureColumnInner({
  book,
  chapter,
  versesByVersion,
  verseNumbers,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  mode,
  enabledVersions,
  availableVersions,
  bookChapterList,
  bookChapters,
  onLoadBookChapter,
  onSelectBookVerse,
  onEditBookVerse,
  onSaveBookVerse,
  onOpenBookAligner,
  onReplaceVerse,
  onReplaceNote,
  scrollNonce,
  onRequestScrollToActive,
  searchNotes,
  onScrollToNoteMatch,
  onNoteQueryChange,
  onActiveNoteMatchChange,
  lexiconMap,
  twl,
  onSelectVerse,
  onOpenAligner,
  onModeChange,
  onEnabledVersionsChange,
  onEditVerse,
  onSaveVerse,
  onRestoreVerse,
  onEditSection,
  onEditBookSection,
  locked = false,
  textCheck,
}: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  // Local freeze flag covers the WS→config-refresh window so editors lock
  // immediately (projectConfig.replacementJobId may still be null).
  const freezeEpoch = useSyncExternalStore(
    subscribeLaneFreeze,
    getLaneFreezeEpoch,
    getLaneFreezeEpoch,
  );
  // Versions whose text is locked — lane textReadOnly, or a freeze /
  // replacement_required quarantine. Fed into find/replace and editors so
  // users can't keep typing until the server 409s.
  const textLockedVersions = useMemo(() => {
    const s = new Set<string>();
    const lit = projectConfig?.laneState?.lit;
    const sim = projectConfig?.laneState?.sim;
    if (
      isLaneFrozen("ULT") ||
      lit?.config?.textReadOnly ||
      lit?.replacementJobId ||
      lit?.replacementRequired
    ) {
      s.add("ULT");
    }
    if (
      isLaneFrozen("UST") ||
      sim?.config?.textReadOnly ||
      sim?.replacementJobId ||
      sim?.replacementRequired
    ) {
      s.add("UST");
    }
    return s;
    // freezeEpoch is the subscription signal — isLaneFrozen reads the module Set.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- freezeEpoch drives recompute
  }, [projectConfig?.laneState?.lit, projectConfig?.laneState?.sim, freezeEpoch]);
  const activeRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  // Anchor for the compact view-mode menu (replaces the three always-visible
  // rows/columns/book buttons — same `mode` / `onModeChange` contract).
  const [modeMenuAnchor, setModeMenuAnchor] = useState<HTMLElement | null>(null);
  const openFind = useCallback(() => {
    setFindOpen(true);
  }, []);
  const [findQuery, setFindQuery] = useState<FindQuery | null>(null);
  // Set only when the overlay reports a user-initiated scroll target; the
  // BookView's scroll effect (book mode) and the bodyRef scroll effect
  // (stacked/columns) key off this so external content changes don't yank
  // the user to the next match.
  const [findScrollTarget, setFindScrollTarget] = useState<FindMatch | null>(null);

  // Ctrl/Cmd+F opens the find overlay in any mode. Esc inside the
  // overlay closes it via the overlay's own handler.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFind]);

  // Closing the overlay should drop the query so cells stop painting find
  // marks (otherwise the previous query lingers as highlights).
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery(null);
    setFindScrollTarget(null);
  }, []);

  // Stable callback identities so the overlay's effect deps don't churn.
  const onFindQueryChange = useCallback((q: FindQuery | null) => setFindQuery(q), []);
  const onFindScrollToMatch = useCallback((m: FindMatch | null) => setFindScrollTarget(m), []);

  // Synthesize a one-chapter cache for stacked/columns modes so the
  // overlay's existing collectMatches logic works without bookHook. Only
  // `verses` is consulted — the row stubs satisfy the ChapterPayload type.
  const singleChapterCache = useMemo<Map<number, ChapterState>>(() => {
    const m = new Map<number, ChapterState>();
    m.set(chapter, {
      kind: "ready",
      data: {
        book,
        chapter,
        verses: versesByVersion,
        tn: [],
        tq: [],
        twl: [],
        verseStatuses: [],
        verseLaneChecks: [],
      } as ChapterPayload,
    });
    return m;
  }, [book, chapter, versesByVersion]);

  const overlayChapters = mode === "book" && bookChapters ? bookChapters : singleChapterCache;
  const overlayChapterList = mode === "book" && bookChapterList ? bookChapterList : [chapter];
  const overlayLoadChapter = useCallback(
    (ch: number) => {
      if (mode === "book" && onLoadBookChapter) onLoadBookChapter(ch);
    },
    [mode, onLoadBookChapter],
  );

  // Compile the regex + classify the source-language query once and feed both
  // to stacked/columns cells for in-line mark painting. Book mode rebuilds
  // its own copy inside BookView.
  const search = useMemo<SearchState | null>(() => {
    if (!findQuery) return null;
    const sourceQuery: SourceQueryKind = findQuery.regex
      ? { kind: "english" }
      : classifySourceQuery(findQuery.find, book, findQuery.strongs);
    try {
      const pattern = findQuery.regex
        ? findQuery.find
        : findQuery.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(pattern, findQuery.caseSensitive ? "g" : "gi");
      return { re, sourceQuery };
    } catch {
      return { re: null, sourceQuery };
    }
  }, [findQuery, book]);

  // Stacked/columns scroll-to-match: BookView handles book mode internally.
  // In stacked mode also promote the match verse to "active" so its full card
  // expands (otherwise non-active rows collapse to a one-line grid). The
  // active-verse useEffect below handles the scroll once expansion lands.
  useEffect(() => {
    if (!findScrollTarget || mode === "book") return;
    if (findScrollTarget.chapter !== chapter) return;
    if (mode === "stacked" && findScrollTarget.verse !== activeVerse) {
      onSelectVerse(findScrollTarget.verse);
      return;
    }
    const sel = `[data-find-cell="${findScrollTarget.chapter}-${findScrollTarget.verse}-${findScrollTarget.bibleVersion}"]`;
    const el = bodyRef.current?.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [findScrollTarget, mode, chapter, activeVerse, onSelectVerse]);

  useEffect(() => {
    if (mode === "stacked") {
      activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeVerse, mode]);

  // Stacked mode does its own activeRef scroll; columns/book modes react to
  // the shared scrollNonce. The button asks the shell to bump the nonce, and
  // we mirror that here for stacked so all three modes behave the same.
  const prevNonceRef = useRef(scrollNonce);
  useEffect(() => {
    if (prevNonceRef.current === scrollNonce) return;
    prevNonceRef.current = scrollNonce;
    if (mode === "stacked") {
      activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [scrollNonce, mode]);

  const isHebrew = !!versesByVersion["UHB"];

  // Per-version expansion: verses[bv][7] resolves to the 6-9 range row when
  // the user navigates to verse 7 inside a UST multi-verse block. The wire
  // shape (versesByVersion) keys only on the start of a range; this index
  // makes lookups by-any-verse-in-range work. See web/src/lib/verseRange.ts.
  const indexByVersion = useMemo(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    for (const bv of Object.keys(versesByVersion)) {
      out[bv] = buildVerseIndex(versesByVersion[bv]);
    }
    return out;
  }, [versesByVersion]);

  // The active verse's source (UHB/UGNT) verse content, used to OL-anchor
  // ULT/UST note highlights in DocColumn (columns) and BookView (book). The
  // active verse always lives in the active chapter (the route is
  // book/chapter/verse), so the current chapter's index covers it for every
  // mode. StackedBody reads its own uhbV inline.
  const activeSourceContent = useMemo(
    () => (indexByVersion["UHB"] ?? indexByVersion["UGNT"])?.[activeVerse]?.content,
    [indexByVersion, activeVerse],
  );

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 2,
          py: 0.25,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
          flexWrap: "wrap",
        }}
      >
        <Tooltip title={t("shell.viewModeTooltip")}>
          <Button
            size="small"
            variant="outlined"
            startIcon={
              mode === "stacked" ? (
                <ViewStreamIcon fontSize="small" />
              ) : mode === "columns" ? (
                <ViewColumnIcon fontSize="small" />
              ) : (
                <MenuBookIcon fontSize="small" />
              )
            }
            endIcon={<ArrowDropDownIcon fontSize="small" />}
            aria-label={t("shell.viewMode")}
            aria-haspopup="menu"
            onClick={(e) => setModeMenuAnchor(e.currentTarget)}
            sx={{ textTransform: "none" }}
          >
            {mode === "stacked"
              ? t("shell.rows")
              : mode === "columns"
                ? t("shell.colCount", { count: enabledVersions.length })
                : t("shell.book")}
          </Button>
        </Tooltip>
        <Menu
          anchorEl={modeMenuAnchor}
          open={Boolean(modeMenuAnchor)}
          onClose={() => setModeMenuAnchor(null)}
          MenuListProps={{ dense: true, "aria-label": t("shell.viewMode") }}
        >
          {(
            [
              ["stacked", t("shell.rows"), t("shell.tooltipRows"), <ViewStreamIcon fontSize="small" />],
              ["columns", t("shell.columns"), t("shell.tooltipColumns"), <ViewColumnIcon fontSize="small" />],
              ["book", t("shell.book"), t("shell.tooltipBook"), <MenuBookIcon fontSize="small" />],
            ] as [ScriptureMode, string, string, ReactNode][]
          ).map(([value, label, hint, icon]) => (
            <MenuItem
              key={value}
              selected={mode === value}
              sx={{ maxWidth: 340, whiteSpace: "normal", alignItems: "flex-start" }}
              onClick={() => {
                setModeMenuAnchor(null);
                if (value !== mode) onModeChange(value);
              }}
            >
              <ListItemIcon>{icon}</ListItemIcon>
              <ListItemText primary={label} secondary={hint} />
            </MenuItem>
          ))}
        </Menu>
        <Tooltip
          title={
            mode === "book"
              ? t("shell.tooltipFindBook")
              : t("shell.tooltipFindChapter")
          }
        >
          <Button
            size="small"
            variant={findOpen ? "contained" : "outlined"}
            startIcon={<SearchIcon fontSize="small" />}
            onClick={() => {
              if (findOpen) closeFind();
              else openFind();
            }}
            sx={{ textTransform: "none" }}
          >
            {t("shell.find")}
          </Button>
        </Tooltip>
        {(mode === "columns" || mode === "book") && (
          <ToggleButtonGroup
            size="small"
            value={enabledVersions}
            onChange={(_e, next) => {
              if (Array.isArray(next) && next.length > 0 && next.length <= 3) {
                onEnabledVersionsChange(next);
              }
            }}
            aria-label={t("shell.visibleVersions")}
          >
            {availableVersions.map((v) => (
              <ToggleButton key={v} value={v} sx={{ px: 1, py: 0.25, textTransform: "none", fontSize: 11 }}>
                {versionLabel(projectConfig, v)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t("shell.tooltipGoToActive")}>
          <Button
            size="small"
            startIcon={<UndoIcon fontSize="small" />}
            onClick={onRequestScrollToActive}
            sx={{ textTransform: "none" }}
          >
            {t("shell.goToActive")}
          </Button>
        </Tooltip>
        <Typography variant="caption" color="text.secondary">
          {book} {chapter}:{activeVerse === 0 ? t("shell.intro") : activeVerse}
        </Typography>
        {/* Book mode's lazy-load status. Used to occupy its own band inside
            BookView; folded in here so it costs no extra row. */}
        {mode === "book" && bookChapterList && bookChapters && (
          <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: "nowrap" }}>
            {t("shell.bookLoadStatus", {
              chapters: bookChapterList.length,
              loaded: countReadyChapters(bookChapters),
            })}
          </Typography>
        )}
      </Stack>
      <Box ref={bodyRef} sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {findOpen && (
          <Suspense fallback={null}>
            <FindReplaceOverlay
              open
              onClose={closeFind}
              book={book}
              activeChapter={chapter}
              chapters={overlayChapters}
              chapterList={overlayChapterList}
              onLoadChapter={overlayLoadChapter}
              enabledVersions={enabledVersions}
              onReplaceVerse={onReplaceVerse}
              onReplaceNote={onReplaceNote}
              onScrollToMatch={onFindScrollToMatch}
              onQueryChange={onFindQueryChange}
              searchNotes={searchNotes}
              onScrollToNoteMatch={onScrollToNoteMatch}
              onNoteQueryChange={onNoteQueryChange}
              onActiveNoteMatchChange={onActiveNoteMatchChange}
              textLockedVersions={textLockedVersions}
            />
          </Suspense>
        )}
        {mode === "stacked" ? (
          <StackedBody
            book={book}
            indexByVersion={indexByVersion}
            verseNumbers={verseNumbers}
            activeVerse={activeVerse}
            activeRef={activeRef}
            chapter={chapter}
            isHebrew={isHebrew}
            activeNoteQuote={activeNoteQuote}
            activeNoteOccurrence={activeNoteOccurrence}
            reorderHighlight={reorderHighlight ?? null}
            lexiconMap={lexiconMap}
            twl={twl}
            search={search}
            findActiveMatch={findScrollTarget}
            onSelectVerse={onSelectVerse}
            onOpenAligner={onOpenAligner}
            onEditVerse={onEditVerse}
            onSaveVerse={onSaveVerse}
            onRestoreVerse={onRestoreVerse}
            onEditSection={onEditSection}
            locked={locked}
            textLockedVersions={textLockedVersions}
          />
        ) : mode === "book" && bookChapterList && bookChapters && onLoadBookChapter && onSelectBookVerse && onEditBookVerse && onSaveBookVerse && onOpenBookAligner ? (
          <Suspense fallback={null}>
            <BookView
              book={book}
              chapterList={bookChapterList}
              chapters={bookChapters}
              enabledVersions={enabledVersions}
              activeChapter={chapter}
              activeVerse={activeVerse}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              reorderHighlight={reorderHighlight ?? null}
              activeSourceContent={activeSourceContent}
              scrollNonce={scrollNonce}
              findQuery={findQuery}
              findActiveMatch={findScrollTarget}
              lexiconMap={lexiconMap}
              onLoadChapter={onLoadBookChapter}
              onSelectVerse={onSelectBookVerse}
              onEditVerse={onEditBookVerse}
              onSaveColumn={(bv, payload) => {
                for (const item of payload) {
                  onSaveBookVerse(item.chapter, item.verse, bv, item.plain, item.base);
                }
              }}
              onOpenAligner={onOpenBookAligner}
              onEditSection={onEditBookSection}
              locked={locked}
              textLockedVersions={textLockedVersions}
              textCheck={textCheck}
            />
          </Suspense>
        ) : (
          <Box sx={{ flex: 1, display: "flex", gap: 1, p: 1, overflow: "hidden" }}>
            {enabledVersions.map((v) => (
              <DocColumn
                key={v}
                book={book}
                bibleVersion={v}
                versesByVerseNum={indexByVersion[v] ?? {}}
                sourceByVerseNum={indexByVersion["UHB"] ?? indexByVersion["UGNT"]}
                verseNumbers={verseNumbers}
                chapter={chapter}
                activeVerse={activeVerse}
                readOnly={READ_ONLY_VERSIONS.has(v) || locked || textLockedVersions.has(v)}
                textCheck={READ_ONLY_VERSIONS.has(v) || textLockedVersions.has(v) ? undefined : textCheck}
                rtl={versionIsRtl(projectConfig, v)}
                activeNoteQuote={activeNoteQuote}
                activeNoteOccurrence={activeNoteOccurrence}
                reorderHighlight={reorderHighlight ?? null}
                activeSourceContent={activeSourceContent}
                scrollNonce={scrollNonce}
                lexiconMap={v === "UHB" ? lexiconMap : undefined}
                twl={v === "UHB" ? twl : undefined}
                search={search}
                findActiveMatch={findScrollTarget}
                onSelectVerse={onSelectVerse}
                onEditVerse={(verseNum, plain, base) => onEditVerse(verseNum, v, plain, base)}
                onSaveColumn={(payload) => {
                  for (const item of payload) {
                    onSaveVerse(item.verseNum, v, item.plain, item.base);
                  }
                }}
                onOpenAligner={(verseNum) => onOpenAligner(verseNum, v)}
              onEditSection={
                onEditSection
                  ? (verseNum, change, base) => onEditSection(verseNum, v, change, base)
                  : undefined
              }
              />
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
}

// Skip re-rendering the scripture column when only resource rows (TN/TQ/TWL)
// changed. After the Shell-side memo work (stable verseNumbers / version lists
// / lexiconMap), every value prop below is referentially stable across row
// edits, so this comparator returns true and the verse list + highlight
// subtree is left intact. Callback props are treated as stable — they close
// over Shell state that doesn't change what's rendered here while the compared
// inputs hold. versesByVersion / bookChapters change (new ref) on any real
// verse-content edit, so genuine scripture changes still re-render.
function areScriptureColumnPropsEqual(a: Props, b: Props): boolean {
  return (
    a.book === b.book &&
    a.chapter === b.chapter &&
    a.versesByVersion === b.versesByVersion &&
    a.verseNumbers === b.verseNumbers &&
    a.activeVerse === b.activeVerse &&
    a.activeNoteQuote === b.activeNoteQuote &&
    a.activeNoteOccurrence === b.activeNoteOccurrence &&
    a.reorderHighlight === b.reorderHighlight &&
    a.mode === b.mode &&
    a.enabledVersions === b.enabledVersions &&
    a.availableVersions === b.availableVersions &&
    a.bookChapterList === b.bookChapterList &&
    a.bookChapters === b.bookChapters &&
    a.scrollNonce === b.scrollNonce &&
    a.lexiconMap === b.lexiconMap &&
    // twl feeds the UHB hover tooltips' tW hint; a new ref means a TWL edit,
    // so re-render to keep the hint current (the row subtrees stay memoized,
    // so only the active UHB line actually re-renders).
    a.twl === b.twl &&
    a.locked === b.locked &&
    a.textCheck === b.textCheck
  );
}

export const ScriptureColumn = memo(ScriptureColumnInner, areScriptureColumnPropsEqual);

// Book mode's "loaded n" counter. useBook replaces the chapters Map on every
// load transition, so `bookChapters` gets a new ref and the memo comparator
// above lets this recompute.
function countReadyChapters(chapters: Map<number, ChapterState>): number {
  let n = 0;
  for (const s of chapters.values()) if (s.kind === "ready") n++;
  return n;
}

// Find the row immediately preceding `verseNum` in this version's verse
// map. Multi-verse rows live at their verse_start in the index, so we
// scan back looking for the first row whose end-of-range is < verseNum.
function findPrevRowInColumn(
  column: Record<number, VerseDto>,
  verseNum: number,
): VerseDto | null {
  for (let v = verseNum - 1; v >= 0; v--) {
    const dto = column[v];
    if (!dto) continue;
    if ((dto.verse_end ?? dto.verse) < verseNum) return dto;
  }
  return null;
}

function StackedBody({
  book,
  indexByVersion,
  verseNumbers,
  activeVerse,
  activeRef,
  chapter,
  isHebrew,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  lexiconMap,
  twl,
  search,
  findActiveMatch,
  onSelectVerse,
  onOpenAligner,
  onEditVerse,
  onSaveVerse,
  onRestoreVerse,
  onEditSection,
  locked,
  textLockedVersions,
}: {
  book: string;
  indexByVersion: Record<string, Record<number, VerseDto>>;
  verseNumbers: number[];
  activeVerse: number;
  activeRef: React.MutableRefObject<HTMLDivElement | null>;
  chapter: number;
  isHebrew: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  reorderHighlight: ReorderHighlight | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  twl: TwlRow[];
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  onSelectVerse: (v: number) => void;
  onOpenAligner: (verse: number, bibleVersion: string) => void;
  onEditVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onSaveVerse: (verseNum: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onRestoreVerse: (
    verseNum: number,
    bibleVersion: string,
    content: unknown,
    plainText: string | null,
    base: VerseDto,
  ) => void;
  onEditSection?: (
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  locked: boolean;
  textLockedVersions: Set<string>;
}) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const ult = indexByVersion["ULT"] ?? EMPTY_COLUMN;
  const ust = indexByVersion["UST"] ?? EMPTY_COLUMN;
  const uhb = indexByVersion["UHB"] ?? indexByVersion["UGNT"] ?? {};
  // Role code (drives `bibleVersion`, highlightsFor, lookups); the display
  // label is derived from it per project.
  const uhbLabel = isHebrew ? "UHB" : "UGNT";
  const uhbDisplay = versionLabel(projectConfig, uhbLabel);
  const ultDisplay = versionLabel(projectConfig, "ULT");
  const ustDisplay = versionLabel(projectConfig, "UST");
  return (
    <Box
      sx={(theme) => ({
        flex: 1,
        overflowY: "auto",
        px: 2,
        py: 1,
        ...markHighlightSx(theme.palette.mode),
      })}
    >
      {verseNumbers.map((v) => {
        const isActive = v === activeVerse;
        const ultV = ult[v];
        const ustV = ust[v];
        const uhbV = uhb[v];
        if (isActive) {
          // OL-anchor the ULT/UST highlights on the active verse's source
          // (UHB/UGNT) verse so reordered translations still light up.
          // During a preview the yellow follows the MOVED note (so a hover over
          // a non-selected note's grip still lights it); otherwise the active note.
          const ro = reorderHighlight;
          const aQuote = ro?.movedQuote ?? activeNoteQuote;
          const aOcc = ro?.movedQuote ? ro.movedOccurrence : activeNoteOccurrence;
          const ultHL = highlightsFor("ULT", ultV?.content, aQuote, aOcc, uhbV?.content);
          const ustHL = highlightsFor("UST", ustV?.content, aQuote, aOcc, uhbV?.content);
          const uhbHL = highlightsFor(uhbLabel, uhbV?.content, aQuote, aOcc);
          // Reorder stoplight: the moved note's candidate neighbours, resolved
          // per version (ULT/UST OL-anchored on UHB, like the active set).
          // Undefined unless a drag / hover / recent arrow-move is in flight.
          const ultPrevHL = ro?.prevQuote ? highlightsFor("ULT", ultV?.content, ro.prevQuote, ro.prevOccurrence, uhbV?.content) : undefined;
          const ultNextHL = ro?.nextQuote ? highlightsFor("ULT", ultV?.content, ro.nextQuote, ro.nextOccurrence, uhbV?.content) : undefined;
          const ustPrevHL = ro?.prevQuote ? highlightsFor("UST", ustV?.content, ro.prevQuote, ro.prevOccurrence, uhbV?.content) : undefined;
          const ustNextHL = ro?.nextQuote ? highlightsFor("UST", ustV?.content, ro.nextQuote, ro.nextOccurrence, uhbV?.content) : undefined;
          const uhbPrevHL = ro?.prevQuote ? highlightsFor(uhbLabel, uhbV?.content, ro.prevQuote, ro.prevOccurrence) : undefined;
          const uhbNextHL = ro?.nextQuote ? highlightsFor(uhbLabel, uhbV?.content, ro.nextQuote, ro.nextOccurrence) : undefined;
          // For multi-verse blocks, PATCH and find/replace target the canonical
          // row at verse_start (e.g. 6 for a 6-9 range), not the active integer.
          const ultStart = ultV?.verse ?? v;
          const ustStart = ustV?.verse ?? v;
          const uhbStart = uhbV?.verse ?? v;
          // Find the predecessor row in each column so its trailing
          // markers can drift down to lead this verse visually.
          const ultPrev = findPrevRowInColumn(ult, ultStart);
          const ustPrev = findPrevRowInColumn(ust, ustStart);
          const uhbPrev = findPrevRowInColumn(uhb, uhbStart);
          return (
            <Paper
              ref={activeRef}
              key={v}
              elevation={0}
              sx={{
                p: 1.5,
                my: 1,
                border: "1.5px solid",
                borderColor: "primary.main",
                bgcolor: "primary.50",
                borderRadius: 1,
              }}
            >
              {v === 0 ? (
                <Tooltip title={t("shell.introTooltip")} placement="right">
                  <Typography
                    component="span"
                    variant="caption"
                    sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700, mr: 1, cursor: "help" }}
                  >
                    {t("shell.intro")}
                  </Typography>
                </Tooltip>
              ) : (
                <Typography
                  variant="caption"
                  sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700, mr: 1 }}
                >
                  {`${chapter}:${v}`}
                </Typography>
              )}
              <ActiveLine
                book={book}
                bibleVersion="ULT"
                rtl={versionIsRtl(projectConfig, "ULT")}
                label={ultV && isRangeRow(ultV) ? `${ultDisplay} ${formatVerseLabel(ultV)}` : ultDisplay}
                chapter={chapter}
                verseNum={ultStart}
                text={ultV?.plain_text ?? ""}
                content={ultV?.content}
                sourceContent={uhbV?.content}
                prevContent={ultPrev?.content}
                highlights={ultHL}
                prevHighlights={ultPrevHL}
                nextHighlights={ultNextHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable={!locked && !textLockedVersions.has("ULT")}
                onOpenAligner={() => onOpenAligner(ultStart, "ULT")}
                onEditPlain={
                  ultV && !textLockedVersions.has("ULT")
                    ? (plain) => onEditVerse(ultStart, "ULT", plain, ultV)
                    : undefined
                }
                onSave={
                  ultV && !textLockedVersions.has("ULT")
                    ? (plain) => onSaveVerse(ultStart, "ULT", plain, ultV)
                    : undefined
                }
                version={ultV?.version}
                onRestoreVersion={
                  ultV && !textLockedVersions.has("ULT")
                    ? (content, plainText) => onRestoreVerse(ultStart, "ULT", content, plainText, ultV)
                    : undefined
                }
                onEditSection={
                  ultV && onEditSection && !textLockedVersions.has("ULT")
                    ? (change) => onEditSection(ultStart, "ULT", change, ultV)
                    : undefined
                }
              />
              <ActiveLine
                book={book}
                bibleVersion="UST"
                rtl={versionIsRtl(projectConfig, "UST")}
                label={ustV && isRangeRow(ustV) ? `${ustDisplay} ${formatVerseLabel(ustV)}` : ustDisplay}
                chapter={chapter}
                verseNum={ustStart}
                text={ustV?.plain_text ?? ""}
                content={ustV?.content}
                sourceContent={uhbV?.content}
                prevContent={ustPrev?.content}
                highlights={ustHL}
                prevHighlights={ustPrevHL}
                nextHighlights={ustNextHL}
                search={search}
                findActiveMatch={findActiveMatch}
                editable={!locked && !textLockedVersions.has("UST")}
                onOpenAligner={() => onOpenAligner(ustStart, "UST")}
                onEditPlain={
                  ustV && !textLockedVersions.has("UST")
                    ? (plain) => onEditVerse(ustStart, "UST", plain, ustV)
                    : undefined
                }
                onSave={
                  ustV && !textLockedVersions.has("UST")
                    ? (plain) => onSaveVerse(ustStart, "UST", plain, ustV)
                    : undefined
                }
                version={ustV?.version}
                onRestoreVersion={
                  ustV && !textLockedVersions.has("UST")
                    ? (content, plainText) => onRestoreVerse(ustStart, "UST", content, plainText, ustV)
                    : undefined
                }
                onEditSection={
                  ustV && onEditSection && !textLockedVersions.has("UST")
                    ? (change) => onEditSection(ustStart, "UST", change, ustV)
                    : undefined
                }
              />
              {uhbV && (
                <ActiveLine
                  book={book}
                  bibleVersion={uhbLabel}
                  label={isRangeRow(uhbV) ? `${uhbDisplay} ${formatVerseLabel(uhbV)}` : uhbDisplay}
                  chapter={chapter}
                  verseNum={uhbStart}
                  text={uhbV.plain_text ?? ""}
                  content={uhbV.content}
                  prevContent={uhbPrev?.content}
                  highlights={uhbHL}
                  prevHighlights={uhbPrevHL}
                  nextHighlights={uhbNextHL}
                  search={search}
                  findActiveMatch={findActiveMatch}
                  rtl={isHebrew}
                  readOnly
                  lexiconMap={lexiconMap}
                  twl={twl}
                />
              )}
            </Paper>
          );
        }
        // Inactive rows are memoized (InactiveVerseRow) so selecting a verse
        // re-renders only the two rows whose active state actually flips — the
        // rest of the chapter's verse list is skipped.
        return (
          <InactiveVerseRow
            key={v}
            v={v}
            chapter={chapter}
            ult={ult}
            ust={ust}
            search={search}
            findActiveMatch={findActiveMatch}
            onSelectVerse={onSelectVerse}
          />
        );
      })}
    </Box>
  );
}

// Inactive (non-selected) verse row in stacked mode. Memoized so changing the
// active verse — the common navigation — re-renders only the two rows whose
// active state flips, not the whole chapter's verse list. Compared by the data
// that affects its render; onSelectVerse is treated as stable (it only ever
// calls onSelectVerse(v) for this row's own verse). ult / ust are stable column
// maps, so they change ref only on a real verse-content edit.
const InactiveVerseRow = memo(
  function InactiveVerseRow({
    v,
    chapter,
    ult,
    ust,
    search,
    findActiveMatch,
    onSelectVerse,
  }: {
    v: number;
    chapter: number;
    ult: Record<number, VerseDto>;
    ust: Record<number, VerseDto>;
    search: SearchState | null;
    findActiveMatch: FindMatch | null;
    onSelectVerse: (v: number) => void;
  }) {
    const { t } = useTranslation();
    const projectConfig = useProjectConfig();
    const ultDisplay = versionLabel(projectConfig, "ULT");
    const ustDisplay = versionLabel(projectConfig, "UST");
    // ULT/UST are the project's own language, so an RTL project reads these
    // inactive rows right-to-left too.
    const targetRtl = projectConfig?.direction === "rtl";
    const ultV = ult[v];
    const ustV = ust[v];
    // Only render this version's cell when it's the start of its row's span —
    // keeps a UST 6-9 block from re-rendering on every verse 7,8,9 row
    // underneath it. For singletons, dto.verse === v always.
    const showUlt = ultV && isFirstOfRange(ultV, v);
    const showUst = ustV && isFirstOfRange(ustV, v);
    return (
      <Box
        onClick={() => onSelectVerse(v)}
        sx={{
          display: "grid",
          // Narrow gutter for ULT/UST labels (right-aligned) + the
          // wide text column. Verse-number gets its own row spanning
          // both columns so it doesn't compete with the version
          // labels for vertical space — the resulting extra row is
          // tiny (10 px-ish) and pays for clean label/text baselines.
          gridTemplateColumns: "28px 1fr",
          columnGap: 0.75,
          rowGap: 0,
          alignItems: "baseline",
          px: 1,
          py: 0.5,
          my: 0.25,
          borderRadius: 1,
          cursor: "pointer",
          color: "text.secondary",
          fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
          fontSize: `calc(14.5px * var(--be-reading-scale, 1))`,
          lineHeight: 1.45,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        {v === 0 ? (
          <Tooltip title={t("shell.introTooltip")} placement="right">
            <Typography
              component="span"
              variant="caption"
              sx={{
                gridColumn: "1 / -1",
                gridRow: 1,
                fontFamily: "monospace",
                color: "text.disabled",
                fontSize: 10,
                lineHeight: 1.2,
                mb: 0.25,
                cursor: "help",
                width: "fit-content",
              }}
            >
              {t("shell.intro")}
            </Typography>
          </Tooltip>
        ) : (
          <Typography
            component="span"
            variant="caption"
            sx={{
              gridColumn: "1 / -1",
              gridRow: 1,
              fontFamily: "monospace",
              color: "text.disabled",
              fontSize: 10,
              lineHeight: 1.2,
              mb: 0.25,
            }}
          >
            {`${chapter}:${v}`}
          </Typography>
        )}
        {showUlt && (
          <>
            <Typography
              component="span"
              variant="caption"
              sx={{
                gridColumn: 1,
                gridRow: 2,
                fontFamily: "monospace",
                color: "text.disabled",
                fontWeight: 600,
                fontSize: 10,
                textAlign: "right",
              }}
            >
              {isRangeRow(ultV) ? `${ultDisplay} ${formatVerseLabel(ultV)}` : ultDisplay}
            </Typography>
            <Box
              data-find-cell={`${chapter}-${ultV.verse}-ULT`}
              dir={targetRtl ? "rtl" : "ltr"}
              sx={(theme) => ({
                gridColumn: 2,
                gridRow: 2,
                minWidth: 0,
                ...(targetRtl ? { textAlign: "start" } : {}),
                ...markHighlightSx(theme.palette.mode),
              })}
            >
              <StackedRowBody
                dto={ultV}
                prevDto={findPrevRowInColumn(ult, ultV.verse)}
                search={search}
                activeRange={
                  findActiveMatch &&
                  findActiveMatch.chapter === chapter &&
                  findActiveMatch.verse === ultV.verse &&
                  findActiveMatch.bibleVersion === "ULT"
                    ? { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex }
                    : null
                }
              />
              <NonActiveSections verse={ultV} column="ULT" />
            </Box>
          </>
        )}
        {showUst && (
          <>
            <Typography
              component="span"
              variant="caption"
              sx={{
                gridColumn: 1,
                gridRow: 3,
                fontFamily: "monospace",
                color: "text.disabled",
                fontWeight: 600,
                fontSize: 10,
                textAlign: "right",
              }}
            >
              {isRangeRow(ustV) ? `${ustDisplay} ${formatVerseLabel(ustV)}` : ustDisplay}
            </Typography>
            <Box
              data-find-cell={`${chapter}-${ustV.verse}-UST`}
              dir={targetRtl ? "rtl" : "ltr"}
              sx={(theme) => ({
                gridColumn: 2,
                gridRow: 3,
                minWidth: 0,
                ...(targetRtl ? { textAlign: "start" } : {}),
                ...markHighlightSx(theme.palette.mode),
              })}
            >
              <StackedRowBody
                dto={ustV}
                prevDto={findPrevRowInColumn(ust, ustV.verse)}
                search={search}
                activeRange={
                  findActiveMatch &&
                  findActiveMatch.chapter === chapter &&
                  findActiveMatch.verse === ustV.verse &&
                  findActiveMatch.bibleVersion === "UST"
                    ? { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex }
                    : null
                }
              />
              <NonActiveSections verse={ustV} column="UST" />
            </Box>
          </>
        )}
      </Box>
    );
  },
  (a, b) =>
    a.v === b.v &&
    a.chapter === b.chapter &&
    a.ult === b.ult &&
    a.ust === b.ust &&
    a.search === b.search &&
    a.findActiveMatch === b.findActiveMatch,
);

function ActiveLine({
  book,
  bibleVersion,
  label,
  chapter,
  verseNum,
  text,
  content,
  sourceContent,
  prevContent,
  highlights,
  prevHighlights,
  nextHighlights,
  search,
  findActiveMatch,
  rtl,
  readOnly,
  editable,
  onOpenAligner,
  onEditPlain,
  onSave,
  onEditSection,
  version,
  onRestoreVersion,
  lexiconMap,
  twl,
}: {
  // book + bibleVersion identify the verse for draft keying and find-cell
  // targeting. bibleVersion is the bare code ("ULT") not the rendered label
  // ("ULT 6-9") — FindMatch.bibleVersion carries the bare code, so every
  // find compare / selector must use it; `label` is display-only.
  book?: string;
  bibleVersion: string;
  label: string;
  chapter: number;
  verseNum: number;
  text: string;
  content?: unknown;
  // The matching UHB/UGNT verse content_json — lets the align button flag a
  // broken link when any source word lacks a target. Only passed for ULT/UST.
  sourceContent?: unknown;
  // Previous verse's content_json. Its trailing in-flow markers (\q1,
  // \p ...) are surfaced as read-only chip bands above this verse's
  // editable area — usfm-js stores those markers on the prior verse
  // because USFM places them before \v, but they conceptually
  // introduce THIS verse. To edit them, navigate to the prior verse.
  prevContent?: unknown;
  highlights?: Set<HighlightKey>;
  // Reorder stoplight neighbour sets (green underline / red overline). Only
  // passed for the active verse while a drag / recent arrow-move is live.
  prevHighlights?: Set<HighlightKey>;
  nextHighlights?: Set<HighlightKey>;
  search?: SearchState | null;
  findActiveMatch?: FindMatch | null;
  rtl?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  onOpenAligner?: () => void;
  // Called on every keystroke. Implementation stashes a draft; no
  // PATCH fires until onSave is invoked.
  onEditPlain?: (plain: string) => void;
  // Click-to-save. Shell consumes the current plain text, runs smartEditVerse,
  // and enqueues. Only rendered when editable && draft exists.
  onSave?: (plain: string) => void;
  // Section header band edited / removed. Index is the position in
  // splitSectionHeaders(verseObjects).sections at render time. tag === null
  // means delete the section header at that index. Shell mutates the
  // verseObjects tree directly and re-saves.
  onEditSection?: (change: { index: number; tag: string | null; text: string }) => void;
  // The verse row's monotonic version — drives the `v{N}` history chip
  // (editable ULT/UST only). Absent ⇒ no chip.
  version?: number;
  // Restore a previously-saved version: re-saves the exact stored content tree
  // (alignment included) through the normal verse pipe. Wired only for editable
  // ULT/UST lines; the chip + dialog mount only when this is present.
  onRestoreVersion?: (content: unknown, plainText: string | null) => void;
  lexiconMap?: Map<string, LexiconEntry | null>;
  twl?: TwlRow[];
}) {
  const { t } = useTranslation();
  const isSource = bibleVersion === "UHB" || bibleVersion === "UGNT";
  // Hebrew original: enlarged SBL-Hebrew font + read-only lexicon line, and no
  // editing chrome. RTL direction alone (an Arabic ULT/UST) keeps the normal
  // reading font and full editing toolbar.
  const hebrewSource = bibleVersion === "UHB";
  const [historyOpen, setHistoryOpen] = useState(false);
  // The version chip + history are editable-ULT/UST only — read-only source
  // lines and any line without a known version/restore handler get nothing.
  const showHistory =
    !!book && !!editable && !readOnly && !isSource && version != null && !!onRestoreVersion;
  const draftKey = useMemo(
    () =>
      book && bibleVersion ? verseKey(book, chapter, verseNum, bibleVersion) : null,
    [book, bibleVersion, chapter, verseNum],
  );
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== bibleVersion) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, bibleVersion]);
  const elRef = useRef<HTMLDivElement | null>(null);
  // Tracks the last value we wrote into the contenteditable DOM. The DOM
  // reset effect (further down) skips when its target string matches this,
  // so a parent re-render with the same text doesn't blow away the caret.
  // Hoisted above the draft subscription so the hydration path can update
  // it in lockstep with the DOM write.
  const lastSetRef = useRef<string | null>(null);
  // Synchronous mirror of "this cell has unsaved typing." `hasDraft` is React
  // state set asynchronously from the draft-store subscription, so between a
  // keystroke and that state catching up there's a window where `hasDraft` is
  // still false. The DOM-reset effect guards on it; if a parent re-render
  // (e.g. a WebSocket `onVerseUpdate` → applyLocalVerse, which gives the verse
  // a new `content`/`text` prop) lands in that window, the effect re-applies
  // the server render and wipes the in-progress edit — so the next Save reads
  // the reverted text and the edit silently "reverts". Set this true
  // synchronously on input so the reset effect can never wipe unsaved typing.
  const dirtyRef = useRef(false);
  // Subscribe to the draft store so the row knows whether it's dirty and
  // hydrates from any saved draft on mount. The subscription fires once
  // immediately with the current list, and again on each set/clear.
  const [hasDraft, setHasDraft] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (!draftKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears hasDraft when the row has no draft key and skips the drafts-store subscription; drafts.subscribe has no getSnapshot, and its callback also hydrates the DOM once, so useSyncExternalStore would not be equivalent.
      setHasDraft(false);
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey);
      setHasDraft(!!rec);
      // Keep the synchronous dirty mirror in lockstep with draft existence:
      // true while a draft exists (unsaved typing), false once it's cleared
      // (saved / undone / no-op). onInput also flips it true ahead of the
      // async draft write so the reset effect is protected in the meantime.
      dirtyRef.current = !!rec;
      if (
        !hydratedFromDraftRef.current &&
        rec &&
        typeof (rec.payload as { plainText?: unknown }).plainText === "string" &&
        elRef.current
      ) {
        const plain = (rec.payload as { plainText: string }).plainText;
        if (elRef.current.textContent !== plain) {
          elRef.current.textContent = plain;
          lastSetRef.current = plain;
        }
        hydratedFromDraftRef.current = true;
      }
    });
  }, [draftKey]);

  // Source-language token matches for this line. Only meaningful for UHB/
  // UGNT lines in non-english find modes. Drives the offset painter (UGNT)
  // and the HebrewLine findHighlights set (UHB).
  const sourceHits = useMemo<SourceTokenMatch[] | null>(() => {
    if (!isSource || !search || search.sourceQuery.kind === "english") return null;
    const vo = (content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(vo)) return null;
    return matchSourceVerse(vo, search.sourceQuery);
  }, [isSource, search, content]);

  const findHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!sourceHits || sourceHits.length === 0) return null;
    const set = new Set<HighlightKey>();
    for (const h of sourceHits) set.add(`${h.text}|${h.occurrence}`);
    return set;
  }, [sourceHits]);

  const activeFindKey = useMemo<HighlightKey | null>(() => {
    if (!activeRange || !sourceHits) return null;
    const hit = sourceHits.find((h) => h.start === activeRange.start && h.end === activeRange.end);
    return hit ? `${hit.text}|${hit.occurrence}` : null;
  }, [activeRange, sourceHits]);

  // Find marks override note highlights while the overlay is active —
  // matches BookView's behaviour so users see search results cleanly.
  const findHTML = useMemo(() => {
    if (!text) return null;
    // Source-language query: ULT/UST cells stay clean; source cells use the
    // offset painter (UHB renders via HebrewLine and ignores findHTML).
    if (search && search.sourceQuery.kind !== "english") {
      if (!isSource || !sourceHits || sourceHits.length === 0) return null;
      return renderFindMatchesByOffsets(text, sourceHits, activeRange);
    }
    if (!search?.re) return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, sourceHits, text, isSource, activeRange]);

  // Editable representation: paragraph / poetry / blank markers surfaced
  // as literal "\p" / "\q1" tokens inline. Used as the contentEditable's
  // textContent target so when the user types, the markers appear as
  // visible chips (via renderEditableHTML) and the diff in saveVerseDraft
  // can see / preserve them. Falls back to plain `text` for source rows
  // (Hebrew/Greek) or rows with no verseObjects tree.
  const verseObjects = useMemo(
    () => (content as { verseObjects?: unknown[] } | null)?.verseObjects,
    [content],
  );
  const editableText = useMemo(() => {
    if (!Array.isArray(verseObjects)) return text;
    return extractEditableText(verseObjects);
  }, [verseObjects, text]);
  const sections = useMemo<SectionHeader[]>(() => {
    if (!Array.isArray(verseObjects)) return [];
    return splitSectionHeaders(verseObjects).sections;
  }, [verseObjects]);
  // Markers attached to the previous verse that visually introduce
  // THIS verse — usfm-js stores `\q1 \v N+1` markers on verse N. We
  // render them as read-only chip bands above the editable area so
  // users see the correct paragraph / poetry structure. Editing them
  // requires navigating to the previous verse (where the data lives).
  const driftedMarkers = useMemo<Array<{ tag: string }>>(() => {
    const prevVo = (prevContent as { verseObjects?: unknown[] } | null)?.verseObjects;
    return extractTrailingMarkers(prevVo).map((n) => ({
      tag: String((n as Record<string, unknown>)["tag"] ?? ""),
    }));
  }, [prevContent]);

  // Stoplight role sets → render channels. undefined when neither neighbour
  // resolves, so the common non-reorder render takes the exact pre-feature path.
  const roles = useMemo(() => {
    if (!prevHighlights?.size && !nextHighlights?.size) return undefined;
    return { prev: prevHighlights, next: nextHighlights };
  }, [prevHighlights, nextHighlights]);

  const noteHTML = useMemo(() => {
    // Editable cells need this even while Find is open — see `html` below.
    if (findHTML && !(editable && !readOnly)) return null;
    if (!Array.isArray(verseObjects)) return null;
    // Find marks take precedence over note highlights while the overlay has a
    // hit in this cell — BookView / DocColumn state that by nulling their
    // `highlights` outright. It is not cosmetic here: a `<mark class="be-hl">`
    // wrapper splits the chip render into separate text runs, and
    // overlayFindMarks refuses to split a match across a run boundary, so a
    // multi-word query spanning a highlighted word would paint nothing at all.
    const findLive = !!findHTML;
    const hlSet = findLive
      ? (new Set() as Set<HighlightKey>)
      : (highlights ?? (new Set() as Set<HighlightKey>));
    const roleSets = findLive ? undefined : roles;
    // Edit mode surfaces paragraph / poetry markers as literal chips; read-only
    // emits block layout. Both render even with an empty active set so the
    // paragraph structure still shows; `roles` adds the prev/next channels when
    // a reorder is live (the parent uses FindAwareText for pure inactive rows).
    if (editable && !readOnly) {
      return renderEditableHTML(verseObjects, hlSet, roleSets);
    }
    return renderHighlightedHTML(verseObjects, hlSet, roleSets);
  }, [findHTML, verseObjects, highlights, editable, readOnly, roles]);
  // The editable cell stays contentEditable throughout, and whatever HTML is
  // painted here is exactly what a keystroke's `textContent` capture reads
  // back on save. `findHTML` is built from marker-free `text`, so letting it
  // win here (as it safely can for read-only/inactive cells) would delete
  // every `\q`/`\p` chip from the capture the moment Find is open (#642).
  // Paint find matches onto the chip render instead of substituting it; when
  // there's no chip tree to protect (no verseObjects), fall back to the old
  // precedence since there's nothing for it to destroy.
  const html = useMemo(() => {
    if (editable && !readOnly) {
      if (noteHTML) {
        if (search?.re && (!isSource || search.sourceQuery.kind === "english")) {
          return overlayFindMarks(noteHTML, search.re, activeRange);
        }
        return noteHTML;
      }
      return findHTML;
    }
    return findHTML ?? noteHTML;
  }, [editable, readOnly, noteHTML, findHTML, search, isSource, activeRange]);

  // Only resync the DOM when the highlight/content state actually changes —
  // not on every keystroke. This lets the user type freely; clicking a
  // different note triggers a re-set that includes the new highlights.
  // Setting lastSetRef before flushing an edit keeps this effect from
  // resetting textContent (and the caret with it) when the parent
  // applyLocalVerse round-trips back as the new `text` prop.
  const domBaseline = editable && !readOnly ? editableText : text;
  useEffect(() => {
    if (!elRef.current) return;
    // If the user has unsaved typing in here, leave their text alone —
    // a parent re-render (e.g. notes panel reflow re-passes `text` from
    // server state, or a WebSocket onVerseUpdate applies a new verse prop)
    // must not stomp the draft. dirtyRef is the synchronous guard; hasDraft
    // (async state) can still be false in the window right after a keystroke.
    if (hasDraft || dirtyRef.current) return;
    const next = html ?? domBaseline;
    if (next === lastSetRef.current) return;
    if (html === null) {
      elRef.current.textContent = domBaseline;
    } else {
      elRef.current.innerHTML = html;
    }
    lastSetRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `hasDraft` is read only as a guard. Listing it would resync the DOM when a draft clears, which can reset the caret; the resync is meant to follow content and highlight changes only (see above).
  }, [html, domBaseline]);

  return (
    <Box sx={{ py: 0.5 }}>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ mb: 0.25, minHeight: 18 }}
      >
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            color: "text.secondary",
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontSize: 10,
            fontWeight: 600,
            flexGrow: 1,
          }}
        >
          {label}
        </Typography>
        {showHistory && (
          <Tooltip title={t("shell.tooltipVersionHistory")}>
            <Chip
              icon={<HistoryIcon sx={{ fontSize: 14 }} />}
              label={`v${version}`}
              size="small"
              variant="outlined"
              onClick={() => setHistoryOpen(true)}
              sx={{
                height: 20,
                fontSize: 11,
                fontFamily: "monospace",
                cursor: "pointer",
                "& .MuiChip-icon": { ml: 0.5 },
              }}
            />
          </Tooltip>
        )}
        {onOpenAligner && (
          <AlignLinkButton
            targetContent={content}
            sourceContent={sourceContent}
            tooltip={t("shell.alignLabel", { label })}
            iconSize={22}
            sx={{ p: 0.5 }}
            onClick={onOpenAligner}
          />
        )}
        {editable && !readOnly && onSave && (
          <Tooltip title={hasDraft ? t("shell.saveEdits") : t("shell.noUnsavedEdits")}>
            <span>
              <IconButton
                size="small"
                aria-label={t("shell.saveEdits")}
                disabled={!hasDraft}
                onClick={() => onSave(elRef.current?.textContent ?? "")}
                sx={{
                  p: 0.5,
                  color: hasDraft ? "primary.main" : "action.disabled",
                }}
              >
                {hasDraft ? (
                  <SaveIcon sx={{ fontSize: 22 }} />
                ) : (
                  <SaveOutlinedIcon sx={{ fontSize: 22 }} />
                )}
              </IconButton>
            </span>
          </Tooltip>
        )}
        {editable && !readOnly && hasDraft && draftKey && (
          <Tooltip title={t("shell.undoEdits")}>
            <IconButton
              size="small"
              aria-label={t("shell.undoEdits")}
              onClick={() => {
                void drafts.clear(draftKey);
                dirtyRef.current = false;
                hydratedFromDraftRef.current = false;
                if (elRef.current) {
                  // Re-render from the editable baseline so chips are
                  // restored, not just plain text.
                  elRef.current.innerHTML = html ?? "";
                  if (!html) elRef.current.textContent = editableText;
                  lastSetRef.current = html ?? editableText;
                }
              }}
              sx={{ p: 0.5, color: "warning.main" }}
            >
              <UndoIcon sx={{ fontSize: 22 }} />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {editable && !readOnly && !hebrewSource && (
        <ParagraphToolbar elRef={elRef} onEditPlain={onEditPlain} />
      )}
      {driftedMarkers.length > 0 && !hebrewSource && (
        <Stack spacing={0} sx={{ mb: 0.25 }}>
          {driftedMarkers.map((m, i) => (
            <Tooltip
              key={`drift-${i}`}
              title={t("shell.fromPreviousVerse")}
              placement="left"
            >
              <Box
                sx={{
                  display: "block",
                  pl: m.tag === "q2" ? "2.5em" : m.tag === "q3" ? "3.75em" : m.tag === "q4" ? "5em" : m.tag.startsWith("q") ? "1.25em" : 0,
                  fontSize: 11,
                  opacity: 0.55,
                  fontFamily: "Consolas, Menlo, monospace",
                  color: "primary.main",
                }}
              >
                <Box
                  component="span"
                  sx={{
                    display: "inline-block",
                    px: 0.5,
                    border: "1px dashed",
                    borderColor: "primary.main",
                    borderRadius: 0.5,
                    bgcolor: "rgba(49, 173, 227, 0.06)",
                  }}
                >
                  {m.tag === "ts" ? "\\ts\\*" : `\\${m.tag}`}
                </Box>
              </Box>
            </Tooltip>
          ))}
        </Stack>
      )}
      {hebrewSource && lexiconMap ? (
        <Box
          data-find-cell={`${chapter}-${verseNum}-${bibleVersion}`}
          dir="rtl"
          sx={{
            flex: 1,
            bgcolor: "grey.100",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 0.5,
            px: 1,
            py: 0.5,
            fontSize: `calc(21px * var(--be-reading-scale, 1))`,
            lineHeight: 1.5,
            textAlign: "start",
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
          }}
        >
          <HebrewLine
            verseObjects={(content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            twl={twl}
            verseNum={verseNum}
            highlights={highlights}
            prevHighlights={prevHighlights}
            nextHighlights={nextHighlights}
            findHighlights={findHighlights}
            activeFindKey={activeFindKey}
            fallbackText={text}
          />
        </Box>
      ) : (
        <Box
          ref={elRef}
          data-find-cell={`${chapter}-${verseNum}-${bibleVersion}`}
          data-dirty={hasDraft ? "true" : undefined}
          contentEditable={editable && !readOnly}
          suppressContentEditableWarning
          spellCheck={!rtl}
          dir={rtl ? "rtl" : "ltr"}
          onInput={(e) => {
            if (readOnly || !editable || !onEditPlain) return;
            const value = (e.currentTarget as HTMLDivElement).textContent ?? "";
            // Record what we'd write back if the parent passes the same value
            // as the next `text` prop — keeps the DOM reset effect quiet.
            lastSetRef.current = value;
            // Mark dirty synchronously — before the async draft write resolves
            // and flips `hasDraft` — so a parent re-render in that window can't
            // reset the DOM and wipe this keystroke.
            dirtyRef.current = true;
            onEditPlain(value);
          }}
          sx={(theme) => ({
            flex: 1,
            bgcolor: readOnly ? "grey.100" : "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 0.5,
            px: 1,
            py: 0.5,
            fontSize: `calc(${hebrewSource ? 21 : 14.5}px * var(--be-reading-scale, 1))`,
            lineHeight: 1.5,
            textAlign: "start",
            fontFamily: hebrewSource
              ? '"Times New Roman","SBL Hebrew","Cardo",serif'
              : '"Source Serif Pro","Cambria","Times New Roman",serif',
            outline: "none",
            ...markHighlightSx(theme.palette.mode),
            // Orange border when this row has unsaved typing and isn't
            // currently focused — quiet while typing, loud after you click
            // away. Inset box-shadow so the layout doesn't shift.
            "&[data-dirty='true']:not(:focus)": {
              boxShadow: `inset 0 0 0 2px ${theme.palette.warning.main}`,
            },
            "&:focus": readOnly
              ? {}
              : {
                  borderColor: "primary.main",
                  boxShadow: "0 0 0 2px rgba(49,173,227,0.2)",
                },
          })}
        />
      )}
      {sections.length > 0 && (
        <Stack spacing={0.25} sx={{ mt: 0.5 }}>
          {sections.map((s, i) => (
            <SectionHeaderBand
              key={`${s.tag}-${i}`}
              tag={s.tag}
              text={s.text}
              editable={!!editable && !readOnly}
              onChange={(next) => {
                // Splice the updated/removed section back into verseObjects
                // and let Shell handle the smart save via onEditContent.
                // Wire-up handled in the parent Shell; this component just
                // surfaces edits. For v1 we mutate textContent inline via
                // a side channel — see Shell's onEditSection handler.
                onEditSection?.({ index: i, tag: next.tag, text: next.text });
              }}
            />
          ))}
        </Stack>
      )}
      {historyOpen && book && version != null && (
        <Suspense fallback={null}>
          <VerseHistoryDialog
            open={historyOpen}
            book={book}
            chapter={chapter}
            verseNum={verseNum}
            bibleVersion={bibleVersion}
            currentVersion={version}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={(content, plainText) => onRestoreVersion?.(content, plainText)}
          />
        </Suspense>
      )}
    </Box>
  );
}

// Small toolbar above the active editable verse with one button per
// common paragraph / poetry marker. Clicking inserts a literal-USFM
// chip (`<span class="be-tok" contenteditable="false">\p</span>` plus
// a trailing space) at the current selection inside elRef. After the
// chip is inserted we manually call onEditPlain with the updated
// textContent so the draft fires — the synthetic edit doesn't trigger
// a normal `input` event.
const TOOLBAR_MARKERS: Array<{ tag: string; label: string; title: string }> = [
  { tag: "p", label: "\\p", title: "shell.markerParagraph" },
  { tag: "m", label: "\\m", title: "shell.markerMarginParagraph" },
  { tag: "q1", label: "\\q1", title: "shell.markerPoetryIndent1" },
  { tag: "q2", label: "\\q2", title: "shell.markerPoetryIndent2" },
  { tag: "q3", label: "\\q3", title: "shell.markerPoetryIndent3" },
  { tag: "b", label: "\\b", title: "shell.markerBlankLine" },
  { tag: "ts", label: "\\ts\\*", title: "shell.markerChunkDivider" },
];

function ParagraphToolbar({
  elRef,
  onEditPlain,
}: {
  elRef: React.RefObject<HTMLDivElement | null>;
  onEditPlain?: (plain: string) => void;
}) {
  const { t } = useTranslation();
  const insert = useCallback(
    (tag: string) => {
      const el = elRef.current;
      if (!el) return;
      const chipText = tag === "ts" ? "\\ts\\*" : `\\${tag}`;
      const chipHtml = `<span class="be-tok be-tok-${tag}" data-tag="${tag}">${chipText}</span>&nbsp;`;
      el.focus();
      const sel = window.getSelection();
      // If the caret isn't already in this contenteditable, place it at
      // the end before inserting — feels less surprising than nothing
      // happening when the user clicks the toolbar without first clicking
      // into the verse.
      if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      const ok = document.execCommand("insertHTML", false, chipHtml);
      if (!ok) {
        // execCommand is deprecated; the Selection API fallback inserts
        // the chip as DOM nodes instead. Same end result.
        const range = window.getSelection()?.getRangeAt(0);
        if (range) {
          const tmpl = document.createElement("template");
          tmpl.innerHTML = chipHtml;
          range.deleteContents();
          const frag = tmpl.content;
          range.insertNode(frag);
          range.collapse(false);
        }
      }
      // Fire the same path as a real keystroke so the draft captures.
      onEditPlain?.(el.textContent ?? "");
    },
    [elRef, onEditPlain],
  );
  return (
    <Stack direction="row" spacing={0.25} sx={{ mb: 0.5, flexWrap: "wrap" }}>
      {TOOLBAR_MARKERS.map((m) => (
        <Tooltip key={m.tag} title={t(m.title)}>
          <Button
            size="small"
            variant="outlined"
            onMouseDown={(e) => {
              // Prevent the editor losing focus when clicking the toolbar.
              e.preventDefault();
            }}
            onClick={() => insert(m.tag)}
            sx={{
              minWidth: 0,
              px: 0.75,
              py: 0.1,
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 11,
              textTransform: "none",
              color: "primary.main",
              borderColor: "divider",
            }}
          >
            {m.label}
          </Button>
        </Tooltip>
      ))}
    </Stack>
  );
}

// Inactive stacked rows: render paragraph / poetry layout (block-level
// `\q1` indents etc.) when the verse has markers, with drifted leading
// markers from the previous verse composed at the front. Falls back to
// plain text + find marks via FindAwareText when there's nothing
// marker-worthy to show — that path preserves find/replace highlighting
// for normal prose verses.
// Read-only section header bands for non-active stacked rows. The active
// card renders them editable through ActiveLine; here we surface them so
// the heading is visible at all times — click the row to activate it and
// edit via the active card. Rendered AFTER the verse body (the caller
// places <NonActiveSections> below <StackedRowBody>): a `\s*` heading is
// stored in this verse's trailing verseObjects but introduces the NEXT
// verse, so it belongs at the verse's end — same place as a trailing
// `\p`/`\q` marker, not floating above the verse it's attached to.
function NonActiveSections({ verse, column }: { verse: VerseDto; column: string }) {
  const verseObjects = (verse.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  const sections: SectionHeader[] = Array.isArray(verseObjects)
    ? splitSectionHeaders(verseObjects).sections
    : [];
  if (sections.length === 0) return null;
  return (
    <Stack spacing={0.25} sx={{ mb: 0.25 }}>
      {sections.map((s, i) => (
        <SectionHeaderBand key={`${column}-${verse.verse}-sec-${i}`} tag={s.tag} text={s.text} />
      ))}
    </Stack>
  );
}

function StackedRowBody({
  dto,
  prevDto,
  search,
  activeRange,
}: {
  dto: VerseDto;
  prevDto: VerseDto | null;
  search: SearchState | null;
  activeRange?: { start: number; end: number } | null;
}) {
  const verseObjects = (dto.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  const drift = useMemo(
    () =>
      extractTrailingMarkers(
        (prevDto?.content as { verseObjects?: unknown[] } | null)?.verseObjects,
      ),
    [prevDto?.content],
  );
  const html = useMemo(() => {
    // Find marks win over poetry/paragraph layout while the overlay is open —
    // the same precedence DocColumn/BookView use. Without this, structured
    // (poetry) verses fall to renderHighlightedHTML below, which ignores
    // `search`, so their matches paint no highlight and "disappear" from an
    // inactive row (only the active card + plain-prose rows lit up). The flat
    // text loses its indents while searching — an accepted trade so every
    // match is visible. Source-language queries never match ULT/UST cells, so
    // this is gated to English mode.
    if (search?.re && search.sourceQuery.kind === "english") {
      const text = dto.plain_text ?? "";
      if (text) {
        const findHtml = renderFindMatchesHTML(text, search.re, activeRange);
        if (findHtml.includes("be-find")) return findHtml;
      }
    }
    if (!Array.isArray(verseObjects)) return null;
    // Strip THIS verse's own trailing markers — they drift to the next verse,
    // so rendering them here too would double a text-bearing `\qa` acrostic.
    const body = stripTrailingMarkers(verseObjects);
    const composed = drift.length > 0 ? [...drift, ...body] : body;
    // Skip the marker renderer if there's no structure to show — the
    // FindAwareText fallback below paints find marks for plain prose.
    const hasStructure =
      drift.length > 0 ||
      verseObjects.some((n) => {
        const o = n as Record<string, unknown> | null;
        if (!o) return false;
        const t = o["type"];
        return t === "paragraph" || t === "quote" || t === "section";
      });
    if (!hasStructure) return null;
    return renderHighlightedHTML(composed, new Set());
  }, [verseObjects, drift, search, activeRange, dto.plain_text]);

  if (html !== null) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <FindAwareText text={dto.plain_text ?? ""} search={search} activeRange={activeRange} />;
}

// Render plain text with find-match marks for non-active stacked rows. We
// use innerHTML when there are matches so the <mark> tags paint; otherwise
// render the raw string so React handles escaping the normal way.
function FindAwareText({
  text,
  search,
  activeRange,
}: {
  text: string;
  search: SearchState | null;
  activeRange?: { start: number; end: number } | null;
}) {
  const html = useMemo(() => {
    if (!text || !search?.re) return null;
    // Source-language queries don't match ULT/UST cells — return null so the
    // non-active stacked rows stay clean.
    if (search.sourceQuery.kind !== "english") return null;
    const out = renderFindMatchesHTML(text, search.re, activeRange);
    return out.includes("be-find") ? out : null;
  }, [search, text, activeRange]);
  if (html === null) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderFindMatchesHTML(
  plainText: string,
  re: RegExp,
  activeRange?: { start: number; end: number } | null,
): string {
  let html = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const local = new RegExp(re.source, re.flags);
  while ((m = local.exec(plainText)) !== null) {
    const isActive = !!activeRange && m.index === activeRange.start && m.index + m[0].length === activeRange.end;
    const cls = isActive ? "be-find be-find-active" : "be-find";
    html += escapeHtml(plainText.slice(lastIdx, m.index));
    html += `<mark class="${cls}">${escapeHtml(m[0])}</mark>`;
    lastIdx = m.index + m[0].length;
    if (m[0].length === 0) local.lastIndex++;
  }
  html += escapeHtml(plainText.slice(lastIdx));
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}
