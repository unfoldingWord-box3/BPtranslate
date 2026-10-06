// BookView — whole-book scroll, multi-version columns aligned per verse.
// Lazy-loads chapters via IntersectionObserver: a placeholder row for each
// unloaded chapter, and when it scrolls within ~one viewport of view we ask
// useBook to fetch it. Once loaded, the placeholder is replaced with the
// rendered verse rows.
//
// Layout uses CSS grid so a verse row stays aligned across the N enabled
// versions; this trades off the "doc-flow" feel of DocColumn for tight
// column alignment, which is what makes find/replace and side-by-side
// comparison readable when the scroll spans an entire book.

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Typography, IconButton, Tooltip, CircularProgress } from "@mui/material";
import SaveIcon from "@mui/icons-material/Save";
import UndoIcon from "@mui/icons-material/Undo";
import CheckIcon from "@mui/icons-material/Check";
import type { TwlRow, VerseDto } from "../sync/api";
import { type ChapterCopyBlock } from "../lib/chapterCopy";
import { CopyChapterButton } from "./CopyChapterButton";
import { LANE_FILL, type TextLaneCheck } from "../lib/laneChecks";
import type { ChapterState } from "../hooks/useBook";
import { highlightsFor, overlayFindMarks, renderEditableHTML, renderHighlightedHTML, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { markHighlightSx } from "../lib/highlightStyles";
import { extractTrailingMarkers, stripTrailingMarkers, splitSectionHeaders, type SectionHeader } from "../lib/usfm";
import { SectionHeaderBand } from "./SectionHeaderBand";
import { AlignLinkButton } from "./AlignLinkButton";
import { drafts, verseKey, draftDirtyBorderSx } from "../sync/drafts";
import type { FindMatch } from "./FindReplaceOverlay";
import type { FindQuery } from "./ScriptureColumn";
import { HebrewLine } from "./HebrewLine";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionLabel, versionIsRtl } from "../lib/versionLabels";
import type { LexiconEntry } from "../hooks/useLexicon";
import { formatVerseLabel, isRangeRow } from "../lib/verseRange";
import {
  classifySourceQuery,
  matchSourceVerse,
  renderFindMatchesByOffsets,
  type SourceQueryKind,
  type SourceTokenMatch,
} from "../lib/sourceSearch";

// Compiled find state passed down through the verse-cell tree. `re` is the
// English/regex-mode pattern; `sourceQuery` covers Strong's / Hebrew / Greek.
// When sourceQuery.kind === "english" the `re` path runs; otherwise per-verse
// token matching runs only on UHB/UGNT cells.
interface SearchState {
  re: RegExp | null;
  sourceQuery: SourceQueryKind;
}

const READ_ONLY = new Set(["UHB", "UGNT"]);

// Stable placeholder so `chapters.get(ch) ?? UNLOADED_STATE` doesn't hand
// ChapterBlock a fresh object every render and defeat its memo.
const UNLOADED_STATE: ChapterState = { kind: "unloaded" };

interface Props {
  book: string;
  chapterList: number[];
  chapters: Map<number, ChapterState>;
  enabledVersions: string[];
  activeChapter: number;
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  // Transient reorder stoplight for the active verse (drag held / ~3s after an
  // arrow move): the moved note's candidate prev (green) + next (red).
  reorderHighlight?: ReorderHighlight | null;
  // Active verse's UHB/UGNT verse content — OL-anchors ULT/UST note highlights
  // (resolve the OL quote against the source, then map via alignment) so a
  // reordered English translation still highlights. Ignored for UHB/UGNT.
  activeSourceContent?: unknown;
  scrollNonce?: number;
  findQuery: FindQuery | null;
  findActiveMatch: FindMatch | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  onLoadChapter: (ch: number) => void;
  onSelectVerse: (chapter: number, verse: number) => void;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  // Flush all drafts in one bibleVersion column. Triggered by the header
  // Save button; each item maps to a single PATCH.
  onSaveColumn: (
    bibleVersion: string,
    payload: Array<{ chapter: number; verse: number; plain: string; base: VerseDto }>,
  ) => void;
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
  // Section-band edit/delete for book mode. Splices verseObjects and saves
  // via outbox (Shell.saveSectionEdit). Omitted on read-only versions and
  // locked chapters → band stays read-only.
  onEditSection?: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  // The active chapter is mid-pipeline. Locks editing on every chapter
  // displayed in book mode — simplest defensive choice; AI typically scopes
  // to one chapter so other chapters in view are still safe, but explaining
  // "chapter X is locked, others aren't" is more confusing than it's worth.
  locked?: boolean;
  // Bible versions whose text is locked by their scripture lane (textReadOnly).
  // A cell for one of these renders read-only even when `locked` is false and
  // the version isn't UHB/UGNT. Referentially stable (a Set built once in
  // ScriptureColumn) so the memoized subtrees still skip.
  textLockedVersions?: Set<string>;
  // Optional per-verse Text-lane check. When present and canCheck, each verse
  // cell gets a small check control + a tinted verse-number underline. Wired
  // from Shell; absent in standalone use. Same value for every cell, so it
  // stays referentially stable and the memoized subtrees still skip.
  textCheck?: TextLaneCheck;
}

export function BookView({
  book,
  chapterList,
  chapters,
  enabledVersions,
  activeChapter,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  activeSourceContent,
  scrollNonce,
  findQuery,
  findActiveMatch,
  lexiconMap,
  onLoadChapter,
  onSelectVerse,
  onEditVerse,
  onSaveColumn,
  onOpenAligner,
  onEditSection,
  locked = false,
  textLockedVersions,
  textCheck,
}: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const emptyLocked = useMemo(() => new Set<string>(), []);
  const lockedVersions = textLockedVersions ?? emptyLocked;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  // Set on any deliberate scroll-to-active request (navigation or the
  // toolbar button). Held until the active chapter is loaded and centered —
  // see the scroll effect below.
  const [scrollPending, setScrollPending] = useState(false);

  const handleSaveVerse = useCallback((bv: string, ch: number, v: number, plain: string, base: VerseDto) => {
    onSaveColumn(bv, [{ chapter: ch, verse: v, plain, base }]);
  }, [onSaveColumn]);

  // Scroll the active verse into view — on navigation (activeChapter /
  // activeVerse) and on the toolbar "go to active" click (scrollNonce).
  // Book mode lazy-loads chapters, so the active chapter's row may not be
  // mounted yet; a bare scrollIntoView would no-op against a null ref. Mark
  // the request pending and let the effect below load + center it.
  useEffect(() => {
    setScrollPending(true);
  }, [activeChapter, activeVerse, scrollNonce]);

  // Resolve a pending scroll-to-active. Eagerly load the active chapter plus
  // the two rows above it so the rows above the target render at full height.
  // Crucially, wait until nothing is still loading before scrolling: a chapter
  // that grows mid-scroll would shove the target down and we'd land short
  // (the "go to active does nothing / lands at the wrong chapter" bug). Once
  // in-flight loads settle, heights are stable and a single scroll lands true.
  useEffect(() => {
    if (!scrollPending) return;
    for (const c of [activeChapter - 2, activeChapter - 1, activeChapter, activeChapter + 1]) {
      if (!chapterList.includes(c)) continue;
      const s = chapters.get(c);
      if (!s || s.kind === "unloaded") onLoadChapter(c);
    }
    const active = chapters.get(activeChapter);
    if (!active || active.kind === "unloaded" || active.kind === "loading") return;
    const anyLoading = [...chapters.values()].some((s) => s.kind === "loading");
    if (anyLoading) return; // re-runs when `chapters` next updates
    // Instant, not smooth: smooth scrollIntoView is silently dropped in this
    // lazy-loaded scroll container (the original "go to active" no-op). Since
    // we only scroll once heights have settled, the jump lands true.
    activeRowRef.current?.scrollIntoView({ behavior: "auto", block: "center" });
    setScrollPending(false);
  }, [scrollPending, chapters, activeChapter, activeVerse, chapterList, onLoadChapter]);

  // Scroll to find's active match without changing the actual active verse —
  // navigation between matches shouldn't blow away the user's editing focus.
  // Instant (not smooth) for the same reason as the scroll-to-active effect:
  // smooth scrollIntoView is silently dropped in this lazy-loaded container.
  useEffect(() => {
    if (!findActiveMatch || !containerRef.current) return;
    const sel = `[data-find-cell="${findActiveMatch.chapter}-${findActiveMatch.verse}-${findActiveMatch.bibleVersion}"]`;
    const el = containerRef.current.querySelector<HTMLElement>(sel);
    el?.scrollIntoView({ behavior: "auto", block: "center" });
  }, [findActiveMatch]);

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

  const cols = enabledVersions.length;
  const gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  // Where the front-matter header sends you: the first real chapter's intro tile,
  // which is where the notes column lists the book introduction.
  const introChapter = chapterList.find((c) => c >= 1);

  return (
    <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* The old `{book} · book` / `n ch · loaded m` status band lived here.
          It now rides along in the scripture toolbar (ScriptureColumn), so book
          mode spends one fewer row before the first verse. */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns,
          gap: 1,
          px: 1.5,
          py: 0.25,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "primary.50",
          flexShrink: 0,
        }}
      >
        {enabledVersions.map((v) => {
          const isReadOnly = READ_ONLY.has(v) || locked || lockedVersions.has(v);
          return (
            <Typography
              key={v}
              variant="caption"
              sx={{
                fontFamily: "monospace",
                color: isReadOnly ? "text.secondary" : "primary.main",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {versionLabel(projectConfig, v)}{isReadOnly ? t("widgets.bookView.roSuffix") : ""}
            </Typography>
          );
        })}
      </Box>
      <Box
        ref={containerRef}
        sx={(theme) => ({
          flex: 1,
          overflowY: "auto",
          ...markHighlightSx(theme.palette.mode),
          ...draftDirtyBorderSx(),
          // Each verse is its own grid cell led by an inline reference label.
          // When a verse's content opens with a paragraph / poetry block (its
          // own \p or one drifted from the previous verse), that block breaks
          // to the next line, so some verses' text starts beside the label and
          // others below it. Flatten a verse's FIRST block to inline so every
          // verse's text begins on the reference's line; internal breaks
          // (segments 2+) still lay out as blocks.
          "& .be-verse-span > div.be-para:first-of-type, & .be-verse-span > div.be-line:first-of-type, & .be-verse-span > div.be-q:first-of-type, & .be-verse-span > div.be-blank:first-of-type":
            { display: "inline", marginTop: 0, paddingLeft: 0 },
        })}
      >
        <Box sx={{ display: "grid", gridTemplateColumns, gap: 1, px: 1.5, py: 1 }}>
          {chapterList.map((ch) => (
            <ChapterBlock
              key={ch}
              book={book}
              chapter={ch}
              state={chapters.get(ch) ?? UNLOADED_STATE}
              enabledVersions={enabledVersions}
              cols={cols}
              activeChapter={activeChapter}
              activeVerse={activeVerse}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              reorderHighlight={reorderHighlight ?? null}
              activeSourceContent={activeSourceContent}
              activeRowRef={activeRowRef}
              search={search}
              findActiveMatch={findActiveMatch}
              lexiconMap={lexiconMap}
              onLoadChapter={onLoadChapter}
              onSelectVerse={onSelectVerse}
              introChapter={introChapter}
              onEditVerse={onEditVerse}
              onSaveVerse={handleSaveVerse}
              onOpenAligner={onOpenAligner}
              onEditSection={onEditSection}
              locked={locked}
              textLockedVersions={lockedVersions}
              textCheck={textCheck}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

// Memoized (with VerseRow / VerseCell below) so the per-keystroke BookView
// re-render — every draft write rebuilds draftsByVersion — skips the chapter
// subtrees, whose props are all referentially stable during typing. Callback
// props are passed through raw (no per-chapter/per-verse lambdas) so the
// default shallow compare holds.
const ChapterBlock = memo(function ChapterBlock({
  book,
  chapter,
  state,
  enabledVersions,
  cols,
  activeChapter,
  activeVerse,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  activeSourceContent,
  activeRowRef,
  search,
  findActiveMatch,
  lexiconMap,
  onLoadChapter,
  onSelectVerse,
  introChapter,
  onEditVerse,
  onSaveVerse,
  onOpenAligner,
  onEditSection,
  locked,
  textLockedVersions,
  textCheck,
}: {
  book: string;
  chapter: number;
  state: ChapterState;
  enabledVersions: string[];
  cols: number;
  activeChapter: number;
  activeVerse: number;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  reorderHighlight: ReorderHighlight | null;
  activeSourceContent?: unknown;
  activeRowRef: React.MutableRefObject<HTMLDivElement | null>;
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  onLoadChapter: (ch: number) => void;
  onSelectVerse: (chapter: number, verse: number) => void;
  // Chapter-0 block only: the chapter whose intro tile shows the book introduction.
  introChapter?: number;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onSaveVerse: (bv: string, chapter: number, verse: number, plain: string, base: VerseDto) => void;
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
  onEditSection?: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  locked: boolean;
  textLockedVersions: Set<string>;
  textCheck?: TextLaneCheck;
}) {
  const { t } = useTranslation();
  // Sentinel observed by IntersectionObserver — fires loadChapter when the
  // chapter is near (within ~one viewport of) the visible area.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const isUnloaded = state.kind === "unloaded";
  useEffect(() => {
    if (!isUnloaded) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            onLoadChapter(chapter);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: "800px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [isUnloaded, chapter, onLoadChapter]);

  // Verse-number list pulled from the ready payload — unconditional so the
  // hook count stays stable across loading/error/ready transitions.
  const readyData = state.kind === "ready" ? state.data : null;
  const verseNums = useMemo(() => {
    if (!readyData) return [] as number[];
    const set = new Set<number>();
    for (const v of enabledVersions) {
      const m = readyData.verses[v];
      if (!m) continue;
      for (const k of Object.keys(m)) set.add(parseInt(k, 10));
    }
    return [...set].sort((a, b) => a - b);
  }, [readyData, enabledVersions]);

  if (state.kind === "unloaded" || state.kind === "loading") {
    return (
      <Box
        ref={sentinelRef}
        sx={{
          gridColumn: `1 / span ${cols}`,
          py: 4,
          textAlign: "center",
          color: "text.disabled",
          borderTop: "1px dashed",
          borderBottom: "1px dashed",
          borderColor: "divider",
          my: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
        }}
      >
        {state.kind === "loading" ? <CircularProgress size={14} /> : null}
        <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
          {state.kind === "loading"
            ? t("widgets.bookView.chapterLoading", { chapter })
            : t("widgets.bookView.chapterScrollToLoad", { chapter })}
        </Typography>
      </Box>
    );
  }
  if (state.kind === "error") {
    return (
      <Box
        sx={{
          gridColumn: `1 / span ${cols}`,
          py: 1,
          px: 2,
          bgcolor: "error.50",
          color: "error.dark",
          borderRadius: 0.5,
          my: 1,
        }}
      >
        <Typography variant="caption">
          {t("widgets.bookView.chapterFailed", { chapter, error: state.error })}
        </Typography>
      </Box>
    );
  }

  const data = state.data;
  const goToIntro =
    chapter === 0 && introChapter !== undefined ? () => onSelectVerse(introChapter, 0) : undefined;

  return (
    <Fragment>
      <Box
        sx={{
          gridColumn: `1 / span ${cols}`,
          mt: 2,
          mb: 0.5,
          py: 0.75,
          px: 1.5,
          bgcolor: "primary.50",
          borderRadius: 0.5,
          borderBottom: "1px solid",
          borderColor: "primary.main",
          display: "flex",
          alignItems: "center",
          ...(goToIntro && { cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }),
        }}
        {...(goToIntro && {
          role: "button",
          tabIndex: 0,
          onClick: goToIntro,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              goToIntro();
            }
          },
        })}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontFamily: "monospace", color: "primary.main", fontWeight: 700, letterSpacing: 0.5, flex: 1 }}
        >
          {chapter === 0
            ? t("widgets.bookView.bookFront", { book })
            : t("widgets.bookView.bookChapter", { book, chapter })}
        </Typography>
        {chapter !== 0 && (
          <CopyChapterButton
            book={book}
            chapter={chapter}
            blocks={() => {
              const blocks: ChapterCopyBlock[] = [];
              for (const v of enabledVersions) {
                const byVerse = data.verses[v];
                if (byVerse) blocks.push({ version: v, verses: Object.values(byVerse) });
              }
              return blocks;
            }}
          />
        )}
      </Box>
      {verseNums.map((v) => {
        const isActive = chapter === activeChapter && v === activeVerse;
        return (
          <VerseRow
            key={`${chapter}-${v}`}
            book={book}
            chapter={chapter}
            verseNum={v}
            enabledVersions={enabledVersions}
            versesByVersion={data.verses}
            isActive={isActive}
            activeNoteQuote={isActive ? activeNoteQuote : null}
            activeNoteOccurrence={isActive ? activeNoteOccurrence : null}
            reorderHighlight={isActive ? reorderHighlight : null}
            activeSourceContent={isActive ? activeSourceContent : undefined}
            rowRef={isActive ? activeRowRef : null}
            search={search}
            findActiveMatch={findActiveMatch}
            lexiconMap={lexiconMap}
            twl={data.twl}
            onSelectVerse={onSelectVerse}
            onEditVerse={onEditVerse}
            onSaveVerse={onSaveVerse}
            onOpenAligner={onOpenAligner}
            onEditSection={onEditSection}
            locked={locked}
            textLockedVersions={textLockedVersions}
            textCheck={textCheck}
          />
        );
      })}
    </Fragment>
  );
});

// Raw top-level handlers (chapter / verse / bibleVersion supplied at call
// time from this row's own props) keep the memo's shallow compare honest.
const VerseRow = memo(function VerseRow({
  book,
  chapter,
  verseNum,
  enabledVersions,
  versesByVersion,
  isActive,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  activeSourceContent,
  rowRef,
  search,
  findActiveMatch,
  lexiconMap,
  twl,
  onSelectVerse,
  onEditVerse,
  onSaveVerse,
  onOpenAligner,
  onEditSection,
  locked,
  textLockedVersions,
  textCheck,
}: {
  book: string;
  chapter: number;
  verseNum: number;
  enabledVersions: string[];
  versesByVersion: Record<string, Record<number, VerseDto>>;
  isActive: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  reorderHighlight: ReorderHighlight | null;
  activeSourceContent?: unknown;
  rowRef: React.MutableRefObject<HTMLDivElement | null> | null;
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  twl: TwlRow[];
  onSelectVerse: (chapter: number, verse: number) => void;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onSaveVerse: (bv: string, chapter: number, verse: number, plain: string, base: VerseDto) => void;
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
  onEditSection?: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  locked: boolean;
  textLockedVersions: Set<string>;
  textCheck?: TextLaneCheck;
}) {
  // Render is intentionally a row of N independent cells driven by the same
  // grid container above — placement is via CSS grid auto-flow.
  return (
    <Fragment>
      {enabledVersions.map((bv, colIdx) => {
        const dto = versesByVersion[bv]?.[verseNum];
        // Walk back through prior verseNum slots in the same column to
        // find the actual predecessor row (multi-verse ranges share a
        // single row, so [v-1] might still point at the same dto).
        let prevDto: VerseDto | undefined;
        for (let pv = verseNum - 1; pv >= 0; pv--) {
          const candidate = versesByVersion[bv]?.[pv];
          if (!candidate) continue;
          if ((candidate.verse_end ?? candidate.verse) < verseNum) {
            prevDto = candidate;
            break;
          }
        }
        return (
          <Box
            key={bv}
            ref={colIdx === 0 ? rowRef : null}
            data-find-cell={`${chapter}-${verseNum}-${bv}`}
            onClick={() => onSelectVerse(chapter, verseNum)}
            sx={{
              p: 0.5,
              borderRadius: 0.5,
              cursor: "pointer",
              bgcolor: isActive ? "primary.50" : "transparent",
              boxShadow: isActive && colIdx === 0 ? "inset 2px 0 0 0 #31ADE3" : "none",
            }}
          >
            <VerseCell
              book={book}
              chapter={chapter}
              verseNum={verseNum}
              bibleVersion={bv}
              dto={dto}
              prevDto={prevDto}
              sourceContent={
                versesByVersion["UHB"]?.[verseNum]?.content ??
                versesByVersion["UGNT"]?.[verseNum]?.content
              }
              isActive={isActive}
              activeNoteQuote={activeNoteQuote}
              activeNoteOccurrence={activeNoteOccurrence}
              reorderHighlight={reorderHighlight}
              activeSourceContent={activeSourceContent}
              search={search}
              findActiveMatch={findActiveMatch}
              lexiconMap={lexiconMap}
              twl={twl}
              onOpenAligner={onOpenAligner}
              onEditVerse={onEditVerse}
              onSaveVerse={onSaveVerse}
              onEditSection={onEditSection}
              locked={locked}
              textLockedVersions={textLockedVersions}
              textCheck={textCheck}
            />
          </Box>
        );
      })}
    </Fragment>
  );
});

const VerseCell = memo(function VerseCell({
  book,
  chapter,
  verseNum,
  bibleVersion,
  dto,
  prevDto,
  sourceContent,
  isActive,
  activeNoteQuote,
  activeNoteOccurrence,
  reorderHighlight,
  activeSourceContent,
  search,
  findActiveMatch,
  lexiconMap,
  twl,
  onOpenAligner,
  onEditVerse,
  onSaveVerse,
  onEditSection,
  locked,
  textLockedVersions,
  textCheck,
}: {
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  dto: VerseDto | undefined;
  // The verse row immediately preceding this one in the same column.
  // Its trailing markers (`\q1`, `\p`) drift down to lead this verse
  // visually, matching USFM convention. Storage stays untouched.
  prevDto: VerseDto | undefined;
  // The matching UHB/UGNT verse content_json so the align button flags a
  // broken link when a source word lacks a target. Absent on source columns.
  sourceContent?: unknown;
  isActive: boolean;
  activeNoteQuote: string | null;
  activeNoteOccurrence: number | null;
  reorderHighlight: ReorderHighlight | null;
  activeSourceContent?: unknown;
  search: SearchState | null;
  findActiveMatch: FindMatch | null;
  lexiconMap: Map<string, LexiconEntry | null>;
  twl: TwlRow[];
  onOpenAligner: (chapter: number, verse: number, bibleVersion: string) => void;
  onEditVerse: (chapter: number, verse: number, bibleVersion: string, plain: string, base: VerseDto) => void;
  onSaveVerse: (bv: string, chapter: number, verse: number, plain: string, base: VerseDto) => void;
  onEditSection?: (
    chapter: number,
    verse: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => void;
  locked: boolean;
  textLockedVersions: Set<string>;
  textCheck?: TextLaneCheck;
}) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const readOnly = READ_ONLY.has(bibleVersion) || locked || textLockedVersions.has(bibleVersion);
  const isSource = bibleVersion === "UHB" || bibleVersion === "UGNT";
  // Hebrew original keeps its enlarged SBL-Hebrew treatment; every other pane
  // follows the project's own direction (via versionIsRtl), so an Arabic AVD/NAV
  // pane reads RTL in the normal reading font even when the UI chrome is LTR.
  const hebrewSource = bibleVersion === "UHB";
  const rtl = versionIsRtl(projectConfig, bibleVersion);
  // The active match is at most one cell; this is non-null only on that cell.
  const activeRange = useMemo<{ start: number; end: number } | null>(() => {
    if (!findActiveMatch) return null;
    if (findActiveMatch.chapter !== chapter) return null;
    if (findActiveMatch.verse !== verseNum) return null;
    if (findActiveMatch.bibleVersion !== bibleVersion) return null;
    return { start: findActiveMatch.startIndex, end: findActiveMatch.endIndex };
  }, [findActiveMatch, chapter, verseNum, bibleVersion]);
  const elRef = useRef<HTMLSpanElement | null>(null);
  const lastTextRef = useRef(dto?.plain_text ?? "");
  const lastSetRef = useRef<string | null>(null);
  // Synchronous mirror of "this cell has unsaved typing." `hasDraft` is React
  // state set asynchronously from the draft subscription, so there's a window
  // right after a keystroke where it's still false. The DOM-reset effect below
  // guards on it; a parent re-render in that window (e.g. a WebSocket verse
  // update giving this verse a new prop) would otherwise re-apply the server
  // render and wipe the in-progress edit. Set true synchronously on input.
  const dirtyRef = useRef(false);
  const draftKey = useMemo(
    () => verseKey(book, chapter, verseNum, bibleVersion),
    [book, chapter, verseNum, bibleVersion],
  );
  const [hasDraft, setHasDraft] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (readOnly) {
      setHasDraft(false);
      return;
    }
    return drafts.subscribe((all) => {
      const rec = all.find((d) => d.key === draftKey);
      setHasDraft(!!rec);
      // Keep the synchronous dirty mirror in lockstep with draft existence.
      dirtyRef.current = !!rec;
      // Hydrate from a PRE-EXISTING draft exactly once, on the first
      // (mount-snapshot) callback — never from a draft the user is creating
      // by typing right now. Writing to the live element mid-input resets the
      // caret, and in Firefox `textContent` set here would clobber the verse
      // the user is editing. Restore-on-mount (reload / chapter nav) is the
      // only legitimate reason to push draft text into the DOM.
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      if (
        rec &&
        typeof (rec.payload as { plainText?: unknown }).plainText === "string" &&
        elRef.current
      ) {
        const plain = (rec.payload as { plainText: string }).plainText;
        if (elRef.current.textContent !== plain) {
          elRef.current.textContent = plain;
          lastSetRef.current = plain;
          lastTextRef.current = plain;
        }
      }
    });
  }, [draftKey, readOnly]);

  // Source-language matches for this cell. Only meaningful for UHB/UGNT in
  // non-english find modes. Drives both the offset painter (UGNT) and the
  // HebrewLine findHighlights set (UHB).
  const sourceHits = useMemo<SourceTokenMatch[] | null>(() => {
    if (!isSource || !search || search.sourceQuery.kind === "english") return null;
    const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(vo)) return null;
    return matchSourceVerse(vo, search.sourceQuery);
  }, [isSource, search, dto?.content]);

  const findHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (!sourceHits || sourceHits.length === 0) return null;
    const set = new Set<HighlightKey>();
    for (const h of sourceHits) set.add(`${h.text}|${h.occurrence}`);
    return set;
  }, [sourceHits]);

  // For the UHB HebrewLine path: which token corresponds to the active
  // match (so it can paint with the stronger be-find-active style).
  const activeFindKey = useMemo<HighlightKey | null>(() => {
    if (!activeRange || !sourceHits) return null;
    const hit = sourceHits.find((h) => h.start === activeRange.start && h.end === activeRange.end);
    return hit ? `${hit.text}|${hit.occurrence}` : null;
  }, [activeRange, sourceHits]);

  // Find marks override note highlights while the overlay is open — fewer
  // visual layers, easier to scan results. Note highlights resume when the
  // overlay closes.
  const findHTML = useMemo(() => {
    if (!dto?.plain_text) return null;
    // Source-language query: ULT/UST cells stay clean; UGNT uses the offset
    // painter (UHB renders via HebrewLine, ignoring findHTML).
    if (search && search.sourceQuery.kind !== "english") {
      if (!isSource || !sourceHits || sourceHits.length === 0) return null;
      return renderFindMatchesByOffsets(dto.plain_text, sourceHits, activeRange);
    }
    // English / regex path — unchanged.
    if (!search?.re) return null;
    const html = renderFindMatchesHTML(dto.plain_text, search.re, activeRange);
    return html.includes("be-find") ? html : null;
  }, [search, sourceHits, dto?.plain_text, isSource, activeRange]);

  const highlights = useMemo<Set<HighlightKey> | null>(() => {
    if (findHTML || !isActive || !dto?.content) return null;
    // During a preview the yellow follows the moved/hovered note; else active.
    const aQuote = reorderHighlight?.movedQuote ?? activeNoteQuote;
    const aOcc = reorderHighlight?.movedQuote ? reorderHighlight.movedOccurrence : activeNoteOccurrence;
    if (!aQuote) return null;
    return highlightsFor(bibleVersion, dto.content, aQuote, aOcc, activeSourceContent);
  }, [findHTML, isActive, activeNoteQuote, activeNoteOccurrence, reorderHighlight, bibleVersion, dto?.content, activeSourceContent]);

  // Reorder stoplight neighbour sets (green underline / red overline), active
  // verse only and only while a drag / recent arrow-move is live.
  const prevHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (findHTML || !isActive || !reorderHighlight?.prevQuote || !dto?.content) return null;
    return highlightsFor(bibleVersion, dto.content, reorderHighlight.prevQuote, reorderHighlight.prevOccurrence, activeSourceContent);
  }, [findHTML, isActive, reorderHighlight, bibleVersion, dto?.content, activeSourceContent]);
  const nextHighlights = useMemo<Set<HighlightKey> | null>(() => {
    if (findHTML || !isActive || !reorderHighlight?.nextQuote || !dto?.content) return null;
    return highlightsFor(bibleVersion, dto.content, reorderHighlight.nextQuote, reorderHighlight.nextOccurrence, activeSourceContent);
  }, [findHTML, isActive, reorderHighlight, bibleVersion, dto?.content, activeSourceContent]);
  const roles = useMemo(() => {
    if (!prevHighlights?.size && !nextHighlights?.size) return undefined;
    return { prev: prevHighlights, next: nextHighlights };
  }, [prevHighlights, nextHighlights]);

  const html = useMemo(() => {
    const verseObjects = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    // Active editable verse: surface paragraph / poetry markers as literal
    // "\p" / "\q1" chips so they can be seen and adjusted in place — same as
    // the rows view active line. Render the verse's OWN objects (not the
    // drifted-composed set) so the contentEditable's textContent matches
    // extractEditableText and the smartEditVerse save diff lines up. Only the
    // active verse gets chips; the rest of the book stays clean.
    //
    // This must win over `findHTML` even while Find is open: this cell stays
    // contentEditable throughout, and findHTML is built from marker-free
    // plain_text, so letting it win here would delete every `\q`/`\p` chip
    // from the DOM a keystroke's save capture reads (#642). Paint find
    // matches onto the chip render instead of substituting it.
    if (isActive && !readOnly && Array.isArray(verseObjects)) {
      const chipHtml = renderEditableHTML(verseObjects, highlights ?? new Set(), roles);
      if (search?.re && (!isSource || search.sourceQuery.kind === "english")) {
        return overlayFindMarks(chipHtml, search.re, activeRange);
      }
      return chipHtml;
    }
    if (findHTML) return findHTML;
    if (!Array.isArray(verseObjects)) return null;
    // Drift trailing `\q1`/`\p` etc. from the previous verse so the
    // visual break introduces this verse — usfm-js attaches markers
    // to the prior verse (per USFM convention `\q1 \v N+1`).
    const drifted = extractTrailingMarkers(
      (prevDto?.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    // Strip THIS verse's own trailing markers — they drift to the next verse,
    // so rendering them here too would double a text-bearing `\qa` acrostic.
    const body = stripTrailingMarkers(verseObjects);
    const composed = drifted.length > 0 ? [...drifted, ...body] : body;
    // Render unconditionally so paragraph / poetry markers turn into
    // visual breaks / indents in book view even without active highlights.
    return renderHighlightedHTML(composed, highlights ?? new Set(), roles);
  }, [findHTML, dto?.content, highlights, prevDto?.content, isActive, readOnly, roles, search, isSource, activeRange]);

  // splitSectionHeaders walks the whole verseObjects tree — memoize on the
  // content reference so re-renders without a content change skip the walk.
  const sections = useMemo<SectionHeader[]>(() => {
    const verseObjects = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    return Array.isArray(verseObjects) ? splitSectionHeaders(verseObjects).sections : [];
  }, [dto?.content]);

  useEffect(() => {
    if (!elRef.current) return;
    // Never reset the DOM while a draft is in flight — the user's typing is
    // the source of truth between mount/save. dirtyRef is the synchronous
    // guard; hasDraft (async state) can still be false in the window right
    // after a keystroke, so a WebSocket-driven prop change could slip through.
    if (hasDraft || dirtyRef.current) return;
    const text = dto?.plain_text ?? "";
    const dom = elRef.current.textContent;
    if (html !== null) {
      if (html !== lastSetRef.current) {
        // Caret-preserving: activating this verse flips `html` to chip HTML and
        // would otherwise wipe the selection the activating click just placed.
        setInnerHtmlPreservingCaret(elRef.current, html);
        lastSetRef.current = html;
        lastTextRef.current = text;
      }
      return;
    }
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      elRef.current.textContent = text;
      lastSetRef.current = text;
    }
    lastTextRef.current = text;
  }, [dto?.plain_text, html, hasDraft]);

  if (!dto) {
    return (
      <Typography variant="caption" color="text.disabled" sx={{ fontStyle: "italic" }}>
        —
      </Typography>
    );
  }

  // Text-lane check state for this cell (when wired). The tinted underline on
  // the verse marker keeps the checked state visible even with controls hidden.
  const textShade = textCheck ? textCheck.shade(verseNum) : "open";
  const showTextCheck = !!textCheck?.canCheck && !readOnly;

  return (
    <Box dir={rtl ? "rtl" : "ltr"} sx={{ lineHeight: 1.6, ...(rtl ? { textAlign: "start" } : {}) }}>
      <Typography
        component="span"
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontSize: 10,
          fontWeight: isRangeRow(dto) ? 700 : 600,
          color: isRangeRow(dto) ? "#014263" : "#9aa0a6",
          mr: 0.5,
          borderBottom:
            textShade !== "open" ? `2px solid ${LANE_FILL[textShade].bg}` : undefined,
        }}
      >
        {verseNum === 0 ? t("shell.intro") : `${chapter}:${formatVerseLabel(dto)}`}
      </Typography>
      {!readOnly && (
        <AlignLinkButton
          targetContent={dto.content}
          sourceContent={sourceContent}
          tooltip={t("widgets.verse.alignVerse", { verse: verseNum })}
          iconSize={14}
          sx={{ p: 0.25, verticalAlign: "-3px" }}
          onClick={(e) => {
            e.stopPropagation();
            onOpenAligner(chapter, verseNum, bibleVersion);
          }}
        />
      )}
      {showTextCheck && (
        <Tooltip
          title={t("widgets.verse.textCheck", { attribution: textCheck!.attribution(verseNum) })}
        >
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              textCheck!.onToggle(verseNum);
            }}
            size="small"
            sx={{
              p: 0.25,
              verticalAlign: "-3px",
              borderRadius: 0.5,
              border: textShade === "open" ? "1px solid" : "none",
              borderColor: "divider",
              bgcolor: textShade === "open" ? "transparent" : LANE_FILL[textShade].bg,
              color: textShade === "open" ? "text.disabled" : LANE_FILL[textShade].fg,
              "&:hover": {
                bgcolor: textShade === "open" ? "action.hover" : LANE_FILL[textShade].bg,
              },
            }}
          >
            <CheckIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {!readOnly && hasDraft && (
        <Tooltip title={t("widgets.verse.undoVerse", { verse: verseNum })}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              // Leave the hydration guard set — hydration is a mount-only
              // concern (a fresh mount gets a fresh ref); re-arming it here
              // would let the next keystroke's draft stomp the live DOM again.
              void drafts.clear(draftKey);
              dirtyRef.current = false;
              const text = dto?.plain_text ?? "";
              if (elRef.current) {
                // Re-render from `html` when present (active verse) so the
                // USFM-code chips come back, not just marker-free plain text.
                if (html !== null) {
                  elRef.current.innerHTML = html;
                  lastSetRef.current = html;
                } else {
                  elRef.current.textContent = text;
                  lastSetRef.current = text;
                }
                lastTextRef.current = text;
              }
            }}
            size="small"
            sx={{ color: "warning.main", p: 0.25, verticalAlign: "-3px" }}
          >
            <UndoIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
      {!readOnly && hasDraft && dto && (
        <Tooltip title={t("widgets.verse.saveVerse", { verse: verseNum })}>
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onSaveVerse(bibleVersion, chapter, verseNum, lastTextRef.current, dto);
            }}
            size="small"
            sx={{ color: "primary.main", p: 0.25, ml: 0.75, verticalAlign: "-3px" }}
          >
            <SaveIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}{" "}
      {readOnly && hebrewSource ? (
        <span
          style={{
            fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
            fontSize: 19,
            direction: "rtl",
            unicodeBidi: "isolate",
          }}
        >
          <HebrewLine
            verseObjects={(dto.content as { verseObjects?: unknown[] } | null)?.verseObjects}
            lexiconMap={lexiconMap}
            twl={twl}
            verseNum={verseNum}
            highlights={highlights ?? undefined}
            prevHighlights={prevHighlights ?? undefined}
            nextHighlights={nextHighlights ?? undefined}
            findHighlights={findHighlights}
            activeFindKey={activeFindKey}
            fallbackText={dto.plain_text ?? ""}
          />
        </span>
      ) : (
      <span
        ref={(node) => {
          elRef.current = node;
        }}
        data-dirty={hasDraft ? "true" : undefined}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={!rtl}
        dir={rtl ? "rtl" : "ltr"}
        onInput={(e) => {
          if (readOnly) return;
          // textContent, not innerText: in Firefox `innerText` read inside the
          // input handler returns a stale/truncated value (layout not flushed),
          // which then corrupts the stored draft and the verse. textContent is
          // synchronous and reliable in both browsers (matches the rows editor).
          const value = (e.currentTarget as HTMLSpanElement).textContent ?? "";
          onEditVerse(chapter, verseNum, bibleVersion, value, dto);
          lastTextRef.current = value;
          lastSetRef.current = value;
          // Mark dirty synchronously, ahead of the async draft write, so a
          // parent re-render can't reset the DOM and wipe this keystroke.
          dirtyRef.current = true;
        }}
        style={{
          outline: "none",
          background: "transparent",
          fontSize: `calc(${hebrewSource ? 19 : 14.5}px * var(--be-reading-scale, 1))`,
          fontFamily: hebrewSource
            ? '"Times New Roman","SBL Hebrew","Cardo",serif'
            : '"Source Serif Pro","Cambria","Times New Roman",serif',
        }}
        className="be-verse-span"
      />
      )}
      {/* `\s*` headings live in this verse's trailing verseObjects but
          introduce the NEXT verse — render the band AFTER the verse body
          so it sits at the verse end (like a trailing `\p`/`\q`), not
          glued above the verse it's attached to. */}
      {sections.map((s, i) => (
        <SectionHeaderBand
          key={`bv-sec-${i}`}
          tag={s.tag}
          text={s.text}
          editable={!readOnly && !!onEditSection}
          onChange={
            onEditSection
              ? (next) =>
                  onEditSection(chapter, verseNum, bibleVersion, { index: i, tag: next.tag, text: next.text }, dto)
              : undefined
          }
        />
      ))}
    </Box>
  );
});

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

// Caret-preserving innerHTML swap for the editable verse span. Activating a
// verse flips the `html` memo from clean text to chip-rendered HTML, and the
// resync effect rewrites innerHTML — which destroys the caret/selection the
// activating click just placed (the "click twice to type" bug in poetry
// chapters). Capture the caret as a character offset within textContent before
// the swap, then re-walk the new text nodes to restore a collapsed range at the
// same offset. Only acts when the element is focused and the selection lives
// inside it; otherwise it's a plain assignment, leaving IME/composition and the
// Firefox first-keystroke draft hydration untouched.
function setInnerHtmlPreservingCaret(el: HTMLElement, html: string): void {
  const sel = window.getSelection();
  const focused = document.activeElement === el;
  const inEl =
    focused &&
    sel &&
    sel.rangeCount > 0 &&
    sel.anchorNode != null &&
    el.contains(sel.anchorNode);
  if (!inEl) {
    el.innerHTML = html;
    return;
  }
  const offset = caretOffsetWithin(el, sel.getRangeAt(0));
  el.innerHTML = html;
  restoreCaretWithin(el, offset, sel);
}

// Number of textContent characters before the caret (anchor) within `el`.
function caretOffsetWithin(el: HTMLElement, range: Range): number {
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

// Place a collapsed caret `offset` characters into `el`'s text, clamped to the
// available text length.
function restoreCaretWithin(el: HTMLElement, offset: number, sel: Selection): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node: Node | null = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    last = node as Text;
    if (remaining <= len) {
      const r = document.createRange();
      r.setStart(node, remaining);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    remaining -= len;
    node = walker.nextNode();
  }
  // Offset ran past the end (text shrank) — drop the caret at the end.
  const r = document.createRange();
  if (last) {
    r.setStart(last, last.textContent?.length ?? 0);
  } else {
    r.selectNodeContents(el);
  }
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
