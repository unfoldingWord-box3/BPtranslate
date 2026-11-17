// Verse fidelity overview — "is this verse coherent?" — ported from
// docs/mockups/book-package/verse.html onto the app's real chapter data.
//
// THE ONE DESIGN IDEA (docs/mockups/book-package/README.md): the literal and
// simplified texts are each already aligned to the SAME original words, so they
// can be JOINED on that alignment instead of merely shown side by side. Click a
// word anywhere and the same place lights up in all three texts; an original
// word that no target words render is a hole the join can simply report.
//
// Two modes, exactly as the mockup: Read (three texts as prose) and Audit (one
// row per original word, with what each lane made of it).
//
// WHAT CHANGES FROM THE MOCKUP:
//   - The mockup declared itself desktop-only below 1100px. That is a defect to
//     inherit, not a decision: here the detail area moves below the text on the
//     narrow bands (system bands only — tablet=560, md=900) and every part
//     stays reachable.
//   - Article prose (tA / tW) is not snapshotted. The mockup carried a
//     build-time snapshot of en_ta / en_tw; here the detail pane's "Read the
//     article" link opens the live Door43 article read-only IN PLACE of the
//     resource list (AssociatedArticlePanel, issue #478), with a way back to
//     the list and a link on to the full article editor.
//   - Nothing here writes. This is a reading and checking surface; the flags
//     are observations computed from the alignment, never stored statuses and
//     never verdicts — a word the simplified text does not render is often
//     correct.
//
// `role` / `me` / `onNavigate` arrive with the shared flow-screen contract;
// verse movement stays on this screen's own hash route, so none is read here.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { alpha, useTheme } from "@mui/material/styles";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CropPortraitOutlinedIcon from "@mui/icons-material/CropPortraitOutlined";
import ViewAgendaOutlinedIcon from "@mui/icons-material/ViewAgendaOutlined";

import { FlowHeader } from "./FlowHeader";
import {
  ORIGINAL_FONT_STACK,
  VerseDetailPane,
  type VerseArticle,
  type VerseSelection,
} from "./VerseDetailPane";
import { AssociatedArticlePanel } from "../AssociatedArticlePanel";
import {
  buildLane,
  buildResources,
  coherence,
  collectOriginalWords,
  laneTextFor,
  type CoherenceFlag,
  type LaneModel,
  type OriginalWord,
  type ResourceItem,
} from "./VerseSpineModel";
import type { FlowScreenContext } from "./types";
import {
  chapterSpans,
  currentIndexAt,
  rowsOverlapping,
  spanFor,
  spanIndexOf,
  type VerseSpan,
} from "./verseSpans";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import {
  isTranslationProject,
  retryProjectConfig,
  useProjectConfig,
  useProjectConfigLoadFailed,
} from "../../hooks/useProjectConfig";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import type { ChapterPayload, VerseDto } from "../../sync/api";
import { nextRealChapter } from "../../lib/bookSummary";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionDirection, versionLabel } from "../../lib/versionLabels";
import { buildVerseIndex, noteOverlapsRange, verseObjectsOf } from "../../lib/verseRange";

export interface VerseScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
}

type Mode = "read" | "audit";

// "One verse" steps verse by verse (the original screen); "Scroll" lays the
// whole chapter out as one list you scroll through freely.
type Layout = "single" | "scroll";
const LAYOUT_KEY = "be:verseViewLayout";
// Scroll layout: how long the top verse must hold before it goes into the
// address bar, and before the rest of the app is told (which costs a render).
const URL_WRITE_MS = 300;
const ROUTE_SYNC_MS = 2000;
// How long an arrow press counts as still gliding to its verse.
const GLIDE_MS = 700;

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "scroll" ? "scroll" : "single";
  } catch {
    return "single";
  }
}

function writeLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // Private window or blocked storage: the choice just isn't remembered.
  }
}

// One lane's verseObjects for a whole verse span, concatenated in verse order —
// the same join `concatSourceRange` performs for the aligner (see
// web/src/lib/verseRange.ts), done here over the EXPANDED index so a lane whose
// row starts before the span edge still resolves. Returns null when the lane
// has no content at all over the span, which is what makes `buildLane` report
// the lane as absent rather than empty.
function spanVerseObjects(
  index: Record<number, VerseDto>,
  start: number,
  end: number,
): unknown[] | null {
  const rows = rowsOverlapping(index, start, end);
  if (rows.length === 0) return null;
  if (rows.length === 1) return verseObjectsOf(rows[0]);
  const combined: unknown[] = [];
  for (const row of rows) {
    const vo = verseObjectsOf(row);
    if (!vo) continue;
    // Same light separator concatSourceRange uses, so consecutive verses do
    // not run together visually.
    if (combined.length > 0) combined.push({ type: "text", text: " " });
    combined.push(...vo);
  }
  return combined.length > 0 ? combined : null;
}

function activeGroupIds(lane: LaneModel, positions: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const p of positions) {
    for (const r of lane.byPosition.get(p) ?? []) out.add(r.groupId);
  }
  return out;
}

function selectedPositionsFor(selection: VerseSelection | null, resources: ResourceItem[]): Set<number> {
  if (!selection) return new Set<number>();
  if (selection.kind === "word") return new Set(selection.positions);
  const item = resources.find((r) => r.key === selection.key);
  return new Set(item?.positions ?? []);
}

interface SpanModel {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  resources: ResourceItem[];
  flags: CoherenceFlag[];
  /** Words carrying a note or a term link: a quiet underline shows where the helps attach. */
  markedPositions: Set<number>;
}

// Everything the screen derives for one verse span: the original words, the
// two lanes joined on them, the helps that touch the span, and the coherence
// observations. Pure derivation, no fetch. The one-verse layout runs it once;
// the scrolling list runs it per section, only while that section is near the
// viewport.
function useSpanModel(
  data: ChapterPayload | null,
  sourceIndex: Record<number, VerseDto>,
  litIndex: Record<number, VerseDto>,
  simIndex: Record<number, VerseDto>,
  start: number,
  end: number,
): SpanModel {
  const { t } = useTranslation();
  const sourceVO = useMemo(
    () => spanVerseObjects(sourceIndex, start, end),
    [sourceIndex, start, end],
  );
  // `t` is a dep because collectOriginalWords bakes translated morphology
  // glosses into each word; without it a language switch leaves them stale in
  // the previous language until the verse data changes. Safe here — this memo
  // is pure derivation, no fetch (contrast the loader effects, which must NOT
  // depend on `t` or they refire on every language change).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is a deliberate recompute signal (see above); the linter cannot see that collectOriginalWords reads the active language.
  const words = useMemo(() => collectOriginalWords(sourceVO), [sourceVO, t]);

  const lit = useMemo(
    () => buildLane("ULT", spanVerseObjects(litIndex, start, end), sourceVO, words),
    [litIndex, start, end, sourceVO, words],
  );
  const sim = useMemo(
    () => buildLane("UST", spanVerseObjects(simIndex, start, end), sourceVO, words),
    [simIndex, start, end, sourceVO, words],
  );

  const resources = useMemo(() => {
    if (!data) return [] as ResourceItem[];
    // The words on screen are the whole span's, so the helps that belong with
    // them are every note/link/question touching any verse in the span.
    const here = (row: { verse: number; ref_raw?: string | null }) =>
      noteOverlapsRange(row, start, end);
    return buildResources(
      data.tn.filter((r) => here(r) && !r.trashed_at),
      data.twl.filter(here),
      data.tq.filter(here),
      sourceVO,
      words,
    );
  }, [data, start, end, sourceVO, words]);

  // Display-only derivation, so `t` belongs in the deps: the flag chips must
  // re-render in the new language. Nothing here fetches or mutates.
  const flags = useMemo(
    () => coherence(words, lit, sim, resources, t),
    [words, lit, sim, resources, t],
  );

  const markedPositions = useMemo(() => {
    const s = new Set<number>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) s.add(p);
    }
    return s;
  }, [resources]);

  return useMemo(
    () => ({ words, lit, sim, resources, flags, markedPositions }),
    [words, lit, sim, resources, flags, markedPositions],
  );
}

export default function VerseScreen({ book, chapter, verse }: VerseScreenProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  // System bands only (web/src/lib/layoutBands.ts): tablet=560, md=900.
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const isTablet = useMediaQuery(theme.breakpoints.up("tablet"));

  const { status, data, error, refetch } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  const [layout, setLayout] = useState<Layout>(readLayout);
  const scrolling = layout === "scroll";
  // The book's chapter list, only for the scroll layout's "Continue to chapter
  // N" after the last verse: one summary fetch, none in the one-verse layout.
  const { summary } = useBook(book, scrolling);
  const [mode, setMode] = useState<Mode>("read");
  const [selection, setSelection] = useState<VerseSelection | null>(null);
  // In the scrolling list every section has its own words, so a selection
  // also names the section (by its span's first verse) it was made in.
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  // The tA / tW article shown in place of the resource list (issue #478). Kept
  // apart from `selection` so closing it returns to the list with the same row
  // still selected.
  const [article, setArticle] = useState<VerseArticle | null>(null);
  // Scroll layout: the first verse of the section at the top of the view.
  const [currentStart, setCurrentStart] = useState(verse);
  // The list's latest report, ahead of the render that carries it.
  const latestCurrentRef = useRef(verse);
  const onCurrentChange = useCallback((start: number) => {
    latestCurrentRef.current = start;
    setCurrentStart(start);
  }, []);
  // A request for the scrolling list to bring a verse into view. `n` makes a
  // repeat request for the same verse count as new.
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest>({ start: verse, smooth: false, n: 0 });
  const requestScroll = useCallback((start: number, smooth: boolean) => {
    setScrollRequest((prev) => ({ start, smooth, n: prev.n + 1 }));
  }, []);

  // A selection names words of THIS verse; stepping verses invalidates it, and
  // the article opened from it. Reset during render (the React "adjust state
  // when a prop changes" pattern) so the new verse never paints with the old
  // verse's selection. In the scroll layout the list follows the new verse.
  const verseKey = `${book}|${chapter}|${verse}`;
  const [prevVerseKey, setPrevVerseKey] = useState(verseKey);
  if (verseKey !== prevVerseKey) {
    setPrevVerseKey(verseKey);
    // While scrolling, this screen writes the verse at the top of the list into
    // the route, which comes back here as a new `verse`. That is not a move:
    // the verse is already in view. (Leaving the scroll layout reports the
    // verse being read the same way, and keeps the selection made in it.)
    const echo = verse === currentStart && prevVerseKey.startsWith(`${book}|${chapter}|`);
    if (!echo) {
      setSelection(null);
      setSelectionStart(null);
      setArticle(null);
      setCurrentStart(verse);
      if (scrolling) setScrollRequest((prev) => ({ start: verse, smooth: false, n: prev.n + 1 }));
    }
  }

  // Crossing the desk breakpoint swaps what scrolls the list (the text column
  // on the desk, the page on a phone), and the new scroller starts at its top.
  // Bring the verse being read back into view.
  const [prevIsDesktop, setPrevIsDesktop] = useState(isDesktop);
  if (isDesktop !== prevIsDesktop) {
    setPrevIsDesktop(isDesktop);
    if (scrolling) setScrollRequest((prev) => ({ start: currentStart, smooth: false, n: prev.n + 1 }));
  }

  // The article belongs to the selection it was opened from: picking any other
  // word or resource closes it, so a stale article never sits beside a new
  // selection. Opening the article does not change the selection.
  const selectionKey = !selection
    ? ""
    : selection.kind === "word"
      ? `${selectionStart}|w:${selection.positions.join(",")}`
      : `${selectionStart}|r:${selection.key}`;
  const [prevSelectionKey, setPrevSelectionKey] = useState(selectionKey);
  if (selectionKey !== prevSelectionKey) {
    setPrevSelectionKey(selectionKey);
    setArticle(null);
  }

  // Closing the article (Back or Escape) hands focus back to the control that
  // opened it, or to the selected resource row if that control is gone, instead
  // of dropping it to <body>.
  const articleOpenerRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const openArticle = useCallback((a: VerseArticle) => {
    const el = document.activeElement;
    articleOpenerRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    setArticle(a);
  }, []);
  const closeArticle = useCallback(() => {
    restoreFocusRef.current = true;
    setArticle(null);
  }, []);
  useEffect(() => {
    if (article || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const opener = articleOpenerRef.current;
    articleOpenerRef.current = null;
    const target =
      opener && opener.isConnected
        ? opener
        : document.querySelector<HTMLElement>('[data-resource-row][aria-current="true"]');
    target?.focus();
  }, [article]);

  const sourceLane = isHebrewBook(book) ? "UHB" : "UGNT";
  const rtl = sourceLane === "UHB";
  const originalLabel = versionLabel(projectConfig, sourceLane);
  const litLabel = versionLabel(projectConfig, "ULT");
  const simLabel = versionLabel(projectConfig, "UST");
  // Target-lane direction follows the PROJECT's language (versionIsRtl), never
  // the UI chrome: an English lane must read LTR even under an Arabic UI (whose
  // document dir is rtl), and an Arabic lane must read RTL. Without an explicit
  // dir the ULT/UST word rows inherit the page direction and lay out backwards
  // (issue #449). ULT and UST share the project direction, but keep them
  // separate for parity with ScriptureColumn.
  //
  // Until the config arrives the target direction is unknown (null), and the
  // body waits on it rather than guessing LTR, which painted Arabic lanes
  // backwards on first load and stuck that way offline (issue #451).
  const litDir = versionDirection(projectConfig, "ULT");
  const simDir = versionDirection(projectConfig, "UST");
  const litRtl = litDir === "rtl";
  const simRtl = simDir === "rtl";
  const directionKnown = litDir !== null && simDir !== null;
  const configLoadFailed = useProjectConfigLoadFailed();
  // While the "could not be loaded" warning shows, retry on its own when the
  // connection comes back.
  const showConfigFailed = !directionKnown && configLoadFailed;
  useEffect(() => {
    if (!showConfigFailed) return;
    window.addEventListener("online", retryProjectConfig);
    return () => window.removeEventListener("online", retryProjectConfig);
  }, [showConfigFailed]);

  const sourceIndex = useMemo(
    () => buildVerseIndex(data?.verses?.[sourceLane]),
    [data, sourceLane],
  );
  const litIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data]);
  const simIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data]);
  const laneIndexes = useMemo(() => [sourceIndex, litIndex, simIndex], [sourceIndex, litIndex, simIndex]);

  // The routed verse's span: a bridged row (`\v 15-16`) widens it (spanFor).
  const span = useMemo(() => spanFor(verse, laneIndexes), [laneIndexes, verse]);

  // Verse list for the stepper + picker. The source lane anchors "which verses
  // exist" (it is present even when a target lane is mid-replacement); ULT is
  // the fallback.
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);
  // The scrolling list's sections, one per span.
  const spans = useMemo(() => chapterSpans(verseNums, laneIndexes), [verseNums, laneIndexes]);

  // The span the header names: the routed one, or in the scroll layout the
  // section at the top of the view.
  const shown = scrolling ? (spans[spanIndexOf(spans, currentStart)] ?? span) : span;
  // The span the detail pane describes: in the scroll layout, the section the
  // selection was made in, else the one at the top of the view.
  const focus = scrolling
    ? (spans[spanIndexOf(spans, selectionStart ?? currentStart)] ?? span)
    : span;
  const bridged = span.end > span.start;
  const model = useSpanModel(data, sourceIndex, litIndex, simIndex, focus.start, focus.end);
  const { words, lit, sim, resources, flags, markedPositions } = model;

  const strongs = useMemo(
    () => [...new Set(words.map((w) => w.strong).filter(Boolean))],
    [words],
  );
  const lexicon = useLexicon(strongs);

  // The address bar follows the verse at the top of the scrolling list, with
  // no history entry, so a reload or a bookmark lands where the reader is.
  const writeVerseUrl = useCallback(
    (v: number) => {
      history.replaceState(null, "", `${location.pathname}${location.search}#/verse/${book}/${chapter}/${v}`);
    },
    [book, chapter],
  );
  // Tells the router too, so the rest of the app (the classic-editor link, the
  // last-position memory) knows the verse. That re-renders the whole app, so
  // it waits until the reader has stopped on a verse.
  const reportVerse = useCallback(
    (v: number) => {
      writeVerseUrl(v);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    },
    [writeVerseUrl],
  );
  useEffect(() => {
    if (!scrolling) return;
    const url = window.setTimeout(() => writeVerseUrl(currentStart), URL_WRITE_MS);
    const moved = currentStart < span.start || currentStart > span.end;
    // The list may already have moved on (its update not yet rendered) when
    // the timer fires; telling the router a verse the reader has left would
    // read as navigation and pull the list back to it.
    const route = moved
      ? window.setTimeout(() => {
          if (latestCurrentRef.current === currentStart) reportVerse(currentStart);
        }, ROUTE_SYNC_MS)
      : 0;
    return () => {
      window.clearTimeout(url);
      window.clearTimeout(route);
    };
  }, [scrolling, currentStart, span, writeVerseUrl, reportVerse]);

  const changeLayout = (next: Layout) => {
    if (next === layout) return;
    writeLayout(next);
    setLayout(next);
    if (next === "scroll") {
      // The one-verse selection belongs to the routed span's section.
      setSelectionStart(selection ? span.start : null);
      setCurrentStart(span.start);
      requestScroll(span.start, false);
    } else {
      // Land the one-verse layout on the verse being read (or the one the
      // selection was made in, so the selection stays meaningful).
      const target = selectionStart ?? currentStart;
      if (target < span.start || target > span.end) {
        setCurrentStart(target);
        reportVerse(target);
      }
    }
  };

  // Scroll layout: the verse the arrows last asked for. A glide takes a moment
  // to bring it to the top, and a second press in that time steps on from it.
  const lastGoRef = useRef<{ start: number; at: number } | null>(null);

  // Step off the SPAN, not the routed verse: on a bridged 15-16 row, "next"
  // from 15 must reach 17, not 16 — 16 renders the identical span.
  const go = useCallback(
    (delta: number) => {
      if (verseNums.length === 0) return;
      let from = shown;
      const last = lastGoRef.current;
      if (scrolling && last && performance.now() - last.at < GLIDE_MS) {
        from = spans[spanIndexOf(spans, last.start)] ?? shown;
      }
      const next =
        delta < 0
          ? [...verseNums].reverse().find((n) => n < from.start)
          : verseNums.find((n) => n > from.end);
      if (next == null) return;
      if (scrolling) {
        lastGoRef.current = { start: next, at: performance.now() };
        requestScroll(next, true);
      } else location.hash = `#/verse/${book}/${chapter}/${next}`;
    },
    [verseNums, shown, spans, scrolling, requestScroll, book, chapter],
  );

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectionStart(null);
  }, []);

  // ← / → step verses, r / a switch mode, Esc clears — the mockup's keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      // MUI Select renders its trigger as a div[role="combobox"] (not a real
      // <select>) and its open popper as role="listbox"/"option" — neither is
      // caught by the tag check above.
      if (el?.closest('[role="combobox"], [role="listbox"], [role="option"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      } else if (e.key === "Escape") {
        // Escape backs out one step: an open article first, then the selection.
        if (article) closeArticle();
        else clearSelection();
      } else if (e.key === "r" || e.key === "a") {
        setMode(e.key === "a" ? "audit" : "read");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, article, closeArticle, clearSelection]);

  // --- selection → highlight sets (one-verse layout) -----------------------
  const selectedPositions = useMemo(
    () => selectedPositionsFor(selection, resources),
    [selection, resources],
  );

  const litOn = useMemo(() => activeGroupIds(lit, selectedPositions), [lit, selectedPositions]);
  const simOn = useMemo(() => activeGroupIds(sim, selectedPositions), [sim, selectedPositions]);

  // Every selection names the section it came from; the one-verse layout has
  // only the routed span.
  const selectIn = useCallback((start: number, sel: VerseSelection | null) => {
    setSelection(sel);
    setSelectionStart(sel ? start : null);
  }, []);

  const selectWord = useCallback(
    (positions: number[]) => {
      selectIn(focus.start, positions.length ? { kind: "word", positions } : null);
    },
    [selectIn, focus.start],
  );

  const selectGroup = useCallback(
    (lane: LaneModel, groupId: string | null) => {
      if (!groupId) {
        // A supplied word — no original behind it, so nothing to anchor to.
        selectIn(focus.start, null);
        return;
      }
      selectWord(lane.positionsByGroup.get(groupId) ?? []);
    },
    [selectIn, selectWord, focus.start],
  );

  const selectResource = useCallback(
    (sel: VerseSelection | null) => selectIn(focus.start, sel),
    [selectIn, focus.start],
  );

  // Everything a scrolling section needs that is the same for every section.
  // Held in one memo so a section re-renders only when it truly changes.
  const sectionCtx = useMemo<SectionContext>(
    () => ({
      book,
      chapter,
      data,
      sourceIndex,
      litIndex,
      simIndex,
      mode,
      setMode,
      litLabel,
      simLabel,
      originalLabel,
      rtl,
      litRtl,
      simRtl,
      compact: !isTablet,
      stacked: !isDesktop,
      onSelect: selectIn,
      closeArticle,
    }),
    [
      book,
      chapter,
      data,
      sourceIndex,
      litIndex,
      simIndex,
      mode,
      litLabel,
      simLabel,
      originalLabel,
      rtl,
      litRtl,
      simRtl,
      isTablet,
      isDesktop,
      selectIn,
      closeArticle,
    ],
  );

  // --- states ---------------------------------------------------------------
  // "ZEC 1:15-16" when a row bridges — the label must name what is on screen.
  const spanLabel = (s: VerseSpan) => `${chapter}:${s.end > s.start ? `${s.start}-${s.end}` : s.start}`;
  const refLabel = `${book} ${spanLabel(scrolling ? focus : span)}`;

  const { skip } = theme.palette.flows;
  // Chevrons point along the reading direction, so they flip under an RTL UI
  // (the scripture screen's scaleX pattern).
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;
  // "ZEC 1:3 · EN to العربية" — the shared flow-screen subtitle, with the verse
  // (or the bridged span) in the chapter slot so the title row names what is
  // on screen.
  const chapterVerse = spanLabel(shown);
  const targetLabel = projectConfig?.languageName || t("flowTranslate.targetFallback");
  const sub = isTranslationProject(projectConfig)
    ? t("flowTranslate.subtitleTranslation", {
        book,
        chapter: chapterVerse,
        source: (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase(),
        target: targetLabel,
      })
    : t("flowTranslate.subtitle", { book, chapter: chapterVerse, target: targetLabel });
  const verseIndex = verseNums.indexOf(shown.start);
  const pickerVerse = scrolling ? shown.start : verse;

  const verseSelect = (
    <Select
      size="small"
      value={verseNums.includes(pickerVerse) ? String(pickerVerse) : ""}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!v) return;
        if (scrolling) requestScroll(v, false);
        else location.hash = `#/verse/${book}/${chapter}/${v}`;
      }}
      displayEmpty
      inputProps={{ "aria-label": t("flowVerse.verse.goToVerse") }}
      sx={{ flex: "none", fontSize: "0.82rem", "& .MuiSelect-select": { paddingBlock: 0.5 } }}
    >
      {verseNums.length === 0 && (
        <MenuItem value="">
          <em>{t("flowVerse.verse.noVersesLoaded")}</em>
        </MenuItem>
      )}
      {verseNums.map((v) => (
        <MenuItem key={v} value={String(v)}>
          {book} {chapter}:{v}
        </MenuItem>
      ))}
    </Select>
  );

  const modeToggle = (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={mode}
      onChange={(_e, v) => v && setMode(v as Mode)}
      aria-label={t("flowVerse.verse.viewAria")}
      sx={{ flex: "none" }}
    >
      <ToggleButton value="read" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
        {t("flowVerse.verse.modeRead")}
      </ToggleButton>
      <ToggleButton value="audit" sx={{ minBlockSize: 32, paddingInline: 1.5, fontSize: "0.78rem" }}>
        {t("flowVerse.verse.modeAudit")}
      </ToggleButton>
    </ToggleButtonGroup>
  );

  // One verse at a time, or the whole chapter as one scrolling list. Icons
  // only on a phone, where the row has no room for the words.
  const layoutToggle = (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={layout}
      onChange={(_e, v) => v && changeLayout(v as Layout)}
      aria-label={t("flowVerse.verse.layoutAria")}
      sx={{ flex: "none" }}
    >
      {(
        [
          ["single", t("flowVerse.verse.layoutSingle"), t("flowVerse.verse.layoutSingleTitle"), <CropPortraitOutlinedIcon key="i" fontSize="small" />],
          ["scroll", t("flowVerse.verse.layoutScroll"), t("flowVerse.verse.layoutScrollTitle"), <ViewAgendaOutlinedIcon key="i" fontSize="small" />],
        ] as [Layout, string, string, ReactNode][]
      ).map(([value, label, title, icon]) => (
        <ToggleButton
          key={value}
          value={value}
          aria-label={label}
          title={title}
          sx={{ minBlockSize: 32, paddingInline: isTablet ? 1.25 : 1, fontSize: "0.78rem", gap: 0.5 }}
        >
          {icon}
          {isTablet && <span>{label}</span>}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );

  // One title row, rendered into the global flow bar via FlowHeader (#299) —
  // the same idiom as TranslateNotesScreen / PackageHubScreen, replacing the
  // retired pill-bar nav and the old bespoke toolbar. The verse stepper stays in
  // the row at every width; the verse picker and the Read/Audit switch join it
  // on the desk (md+) and move to the top of the text column below that, where
  // the shared row has no room to spare.
  const header = (
    <FlowHeader>
      <Box sx={{ maxWidth: 1440, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <IconButton
            aria-label={t("flowTranslate.backToPackage", { book })}
            onClick={() => {
              location.hash = `#/package/${book}`;
            }}
            sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
          >
            <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
          </IconButton>
          <Box sx={{ minWidth: 0 }}>
            <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
              {t("flowVerse.hub.verseView")}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {sub}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {isTablet && verseIndex >= 0 && (
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {t("flowScripture.verseOfTotal", { n: verseIndex + 1, total: verseNums.length })}
            </Typography>
          )}
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flex: "none" }}>
            <IconButton
              aria-label={t("flowScripture.prevVerse")}
              title={t("flowVerse.verse.prevTitle")}
              size="small"
              onClick={() => go(-1)}
              disabled={verseNums.length === 0 || shown.start <= verseNums[0]}
              sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
            {isDesktop && verseSelect}
            <IconButton
              aria-label={t("flowScripture.nextVerse")}
              title={t("flowVerse.verse.nextTitle")}
              size="small"
              onClick={() => go(1)}
              disabled={verseNums.length === 0 || shown.end >= verseNums[verseNums.length - 1]}
              sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
            >
              <ChevronRightIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
          </Stack>
          {isDesktop && layoutToggle}
          {isDesktop && modeToggle}
        </Stack>
      </Box>
    </FlowHeader>
  );

  // Below md the verse picker and the Read/Audit switch sit above the body in
  // EVERY load state (loading, retrying, error, ready), exactly as they did in
  // the old toolbar — a phone user must never lose them while a chapter loads.
  const narrowControls = !isDesktop && (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        paddingBlockStart: 2,
        paddingInline: { xs: 1.5, tablet: 2.5 },
      }}
    >
      {verseSelect}
      <Box sx={{ flex: 1 }} />
      {layoutToggle}
      {modeToggle}
    </Box>
  );

  // The mode hint and the observation chips open the text column, instead of
  // stacking a second bordered band under the title row. In the scroll layout
  // each section carries its own chips.
  const modeLine = (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap", marginBlockEnd: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem" }}>
        {mode === "read" ? t("flowVerse.verse.readHint") : t("flowVerse.verse.auditHint")}
      </Typography>
      <Box sx={{ flex: 1 }} />
      {!scrolling && (
        <FlagRow flags={flags} onPick={(f) => {
          if (!f.positions.length) return;
          setMode("audit");
          selectWord(f.positions);
        }} />
      )}
    </Box>
  );

  // Scroll layout: after the chapter's last verse, go on to the next chapter,
  // still scrolling. None after the book's last chapter, nor before the
  // chapter list has loaded (nextRealChapter is null without it).
  const nextChapter = scrolling ? nextRealChapter(summary, chapter) : null;
  const continueNext = nextChapter != null && (
    <Box sx={{ display: "flex", justifyContent: "center", paddingBlock: 3 }}>
      <Button
        variant="contained"
        disableElevation
        endIcon={<ChevronRightIcon sx={chevronFlip} />}
        onClick={() => {
          location.hash = `#/verse/${book}/${nextChapter}/1`;
        }}
        sx={{ fontWeight: 700 }}
      >
        {t("flowVerse.verse.continueToChapter", { chapter: nextChapter })}
      </Button>
    </Box>
  );

  let body: ReactNode;
  if (status === "loading" || status === "retrying" || (status === "idle" && !data)) {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Skeleton variant="text" width={180} height={22} />
        <Skeleton variant="rectangular" height={72} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
        <Skeleton variant="text" width={140} height={22} />
        <Skeleton variant="rectangular" height={56} sx={{ my: 1.5, borderRadius: 1 }} />
      </Box>
    );
  } else if (status === "error") {
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void refetch()}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("flowVerse.verse.loadError", {
            book,
            chapter,
            details: error ? ` (${error})` : "",
          })}
        </Alert>
      </Box>
    );
  } else if (showConfigFailed) {
    // Offline with no cached project config: say so rather than spin forever
    // or guess a direction (issue #451).
    body = (
      <Box sx={{ padding: 2.5 }}>
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={retryProjectConfig}>
              {t("common.retry")}
            </Button>
          }
        >
          {t("flowVerse.verse.directionLoadFailed")}
        </Alert>
      </Box>
    );
  } else if (!directionKnown) {
    // The target lanes' direction comes from the project config. Wait for it
    // so Arabic lanes never paint LTR first (issue #451).
    body = (
      <Box
        role="status"
        sx={{ padding: 5, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}
      >
        <CircularProgress size={28} aria-hidden />
        <Typography variant="body2" color="text.secondary">
          {t("flowVerse.verse.directionLoading")}
        </Typography>
      </Box>
    );
  } else {
    const detailPane = (
      <VerseDetailPane
        refLabel={refLabel}
        selection={selection}
        words={words}
        lit={lit}
        sim={sim}
        litLabel={litLabel}
        simLabel={simLabel}
        originalLabel={originalLabel}
        resources={resources}
        lexicon={lexicon}
        rtl={rtl}
        onSelect={selectResource}
        onOpenArticle={openArticle}
      />
    );

    const textColumn = scrolling ? (
      <Box
        data-verse-scroller={isDesktop ? "" : undefined}
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.5 },
          paddingBlockEnd: 5,
        }}
      >
        {modeLine}
        <VerseScrollList
          spans={spans}
          request={scrollRequest}
          onCurrentChange={onCurrentChange}
          ctx={sectionCtx}
          selection={selection}
          selectionStart={selectionStart}
          article={article}
          inlineDetail={isDesktop || !selection ? null : detailPane}
          after={continueNext}
        />
      </Box>
    ) : (
      <Box
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.5 },
          paddingBlockEnd: 5,
        }}
      >
        {modeLine}
        {bridged && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("flowVerse.verse.bridgedNotice", { start: span.start, end: span.end })}
          </Alert>
        )}
        {words.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {t("flowVerse.verse.noOriginalText", { label: originalLabel, ref: refLabel })}
          </Alert>
        )}
        {mode === "read" ? (
          <ReadMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            originalLabel={originalLabel}
            rtl={rtl}
            litRtl={litRtl}
            simRtl={simRtl}
            selectedPositions={selectedPositions}
            markedPositions={markedPositions}
            litOn={litOn}
            simOn={simOn}
            onSelectWord={selectWord}
            onSelectGroup={selectGroup}
          />
        ) : (
          <AuditMode
            words={words}
            lit={lit}
            sim={sim}
            litLabel={litLabel}
            simLabel={simLabel}
            resources={resources}
            rtl={rtl}
            litRtl={litRtl}
            simRtl={simRtl}
            compact={!isTablet}
            selectedPositions={selectedPositions}
            onSelectWord={selectWord}
          />
        )}
        {article ? (
          <VerseArticleView article={article} stacked={!isDesktop} onClose={closeArticle} />
        ) : (
          <ResourceList
            resources={resources}
            selection={selection}
            rtl={rtl}
            compact={!isTablet}
            onSelect={selectResource}
          />
        )}
      </Box>
    );

    const detailColumn = (
      <Box
        component="aside"
        aria-label={t("flowVerse.verse.detailAria")}
        sx={{
          minInlineSize: 0,
          overflowY: "auto",
          bgcolor: "background.paper",
          borderInlineStart: isDesktop ? "1px solid" : "none",
          borderBlockStart: isDesktop ? "none" : "1px solid",
          borderColor: "divider",
          paddingBlock: 2,
          paddingInline: { xs: 1.5, tablet: 2.25 },
          paddingBlockEnd: 5,
        }}
      >
        {detailPane}
      </Box>
    );

    body = isDesktop ? (
      <Box
        component="main"
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 440px",
          minBlockSize: 520,
          // The shared title bar (~70px) and the footer note sit outside this
          // grid; the two bands that used to stack above it are gone (#477).
          blockSize: "calc(100dvh - 150px)",
        }}
      >
        {textColumn}
        {detailColumn}
      </Box>
    ) : scrolling ? (
      // On a phone the page scrolls the list, so a detail column after it would
      // sit below the whole chapter: the selected section shows it in place.
      <Box component="main">{textColumn}</Box>
    ) : (
      <Box component="main">
        {textColumn}
        {detailColumn}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minBlockSize: "100%" }}>
      {header}
      {narrowControls}
      {body}
      <Typography
        variant="caption"
        component="p"
        color="text.secondary"
        sx={{ paddingBlock: 2, paddingInline: { xs: 1.5, tablet: 2.5 }, maxInlineSize: 900 }}
      >
        {t("flowVerse.verse.footerNote")}
      </Typography>
    </Box>
  );
}

// ─── flags ──────────────────────────────────────────────────────────────────

function FlagRow({
  flags,
  onPick,
}: {
  flags: CoherenceFlag[];
  onPick: (f: CoherenceFlag) => void;
}) {
  const theme = useTheme();
  if (flags.length === 0) return null;
  const paint = (level: CoherenceFlag["level"]) => {
    if (level === "ok") return { bg: theme.palette.flows.ok.soft, fg: theme.palette.flows.ok.ink };
    if (level === "attention")
      return { bg: theme.palette.flows.warn.soft, fg: theme.palette.flows.warn.ink };
    return {
      bg: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18),
      fg: theme.palette.mode === "dark" ? theme.palette.primary.light : theme.palette.primary.dark,
    };
  };
  return (
    <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
      {flags.map((f) => {
        const { bg, fg } = paint(f.level);
        const clickable = f.positions.length > 0;
        return (
          <Tooltip key={f.id} title={f.detail}>
            <Box
              component="button"
              type="button"
              onClick={() => onPick(f)}
              aria-disabled={!clickable}
              sx={{
                appearance: "none",
                border: 0,
                font: "inherit",
                fontSize: "0.72rem",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: 0.625,
                minBlockSize: 24,
                paddingBlock: 0.375,
                paddingInline: 1.125,
                borderRadius: 999,
                bgcolor: bg,
                color: fg,
                cursor: clickable ? "pointer" : "default",
                textAlign: "start",
              }}
            >
              {f.level === "ok" ? `✓ ${f.label}` : f.label}
              {clickable ? ` · ${f.positions.length}` : ""}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

// ─── read mode ──────────────────────────────────────────────────────────────

function LaneLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="caption"
      component="p"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "text.secondary",
        marginBlockEnd: 0.75,
      }}
    >
      {children}
    </Typography>
  );
}

function ReadMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  originalLabel,
  rtl,
  litRtl,
  simRtl,
  selectedPositions,
  markedPositions,
  litOn,
  simOn,
  onSelectWord,
  onSelectGroup,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  rtl: boolean;
  litRtl: boolean;
  simRtl: boolean;
  selectedPositions: Set<number>;
  markedPositions: Set<number>;
  litOn: Set<string>;
  simOn: Set<string>;
  onSelectWord: (positions: number[]) => void;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  return (
    <Box sx={{ marginBlockEnd: 3 }}>
      {/* The original is the SOURCE the two lanes below translate, not a third
          translation: a bordered panel with a heavier rule under it and a
          wider gap (32px against the 20px between the lanes) keeps it from
          reading as just another lane (#477). The panel is deliberately NOT
          tinted with action.hover — that is the word buttons' hover/focus
          colour, and the feedback would vanish inside it. */}
      <Box
        sx={{
          bgcolor: "background.paper",
          borderRadius: 1.5,
          border: "1px solid",
          borderBlockEndWidth: 2,
          borderColor: "divider",
          paddingBlock: 1.5,
          paddingInline: 1.5,
          marginBlockEnd: 4,
        }}
      >
        <LaneLabel>{t("flowVerse.section.original", { label: originalLabel })}</LaneLabel>
        {words.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
            {t("flowVerse.verse.noOriginalWords")}
          </Typography>
        ) : (
          <Box
            dir={rtl ? "rtl" : "ltr"}
            sx={{
              fontFamily: ORIGINAL_FONT_STACK,
              fontSize: "1.55rem",
              lineHeight: 2.05,
              textAlign: "start",
            }}
          >
            {words.map((w) => (
              <Box
                key={w.position}
                component="button"
                type="button"
                data-original-word=""
                onClick={() => onSelectWord([w.position])}
                title={[w.lemma, w.glosses.join(" · ")].filter(Boolean).join("  ·  ")}
                sx={{
                  appearance: "none",
                  border: 0,
                  background: selectedPositions.has(w.position) ? hl : "transparent",
                  boxShadow: selectedPositions.has(w.position)
                    ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                    : markedPositions.has(w.position)
                      ? `inset 0 -2px 0 ${theme.palette.flows.ok.main}`
                      : "none",
                  font: "inherit",
                  color: "text.primary",
                  cursor: "pointer",
                  borderRadius: 1,
                  paddingInline: 0.375,
                  marginInlineEnd: 0.5,
                  "&:hover, &:focus-visible": { bgcolor: "action.hover" },
                }}
              >
                {w.text}
              </Box>
            ))}
          </Box>
        )}
      </Box>

      <LaneLabel>{t("flowVerse.section.literal", { label: litLabel })}</LaneLabel>
      <Prose lane={lit} on={litOn} onSelectGroup={onSelectGroup} laneName={litLabel} rtl={litRtl} />

      <LaneLabel>{t("flowVerse.section.simplified", { label: simLabel })}</LaneLabel>
      <Prose lane={sim} on={simOn} onSelectGroup={onSelectGroup} laneName={simLabel} rtl={simRtl} />
    </Box>
  );
}

function Prose({
  lane,
  on,
  laneName,
  rtl,
  onSelectGroup,
}: {
  lane: LaneModel;
  on: Set<string>;
  laneName: string;
  rtl: boolean;
  onSelectGroup: (lane: LaneModel, groupId: string | null) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  if (!lane.present) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowScripture.laneNoText", { lane: laneName })}
      </Typography>
    );
  }
  if (lane.prose.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowVerse.verse.laneRowNoText", { lane: laneName })}
      </Typography>
    );
  }

  return (
    <Box
      dir={rtl ? "rtl" : "ltr"}
      sx={{
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.06rem",
        lineHeight: 1.62,
        textAlign: "start",
        marginBlockEnd: 2.5,
      }}
    >
      {lane.prose.map((tok, i) =>
        tok.kind === "text" ? (
          <span key={`t${i}`}>{tok.text}</span>
        ) : (
          <Box
            key={tok.id}
            component="button"
            type="button"
            onClick={() => onSelectGroup(lane, tok.groupId)}
            sx={{
              appearance: "none",
              border: 0,
              font: "inherit",
              // A word with no original behind it — supplied by the
              // translator. Marked quietly, because it is information, not a
              // fault.
              color: tok.groupId ? "text.primary" : "text.secondary",
              background: tok.groupId && on.has(tok.groupId) ? hl : "transparent",
              boxShadow:
                tok.groupId && on.has(tok.groupId)
                  ? `inset 0 -2px 0 ${theme.palette.primary.main}`
                  : "none",
              borderRadius: 0.5,
              padding: 0,
              cursor: "pointer",
              "&:hover, &:focus-visible": { bgcolor: "action.hover" },
            }}
          >
            {tok.text}
          </Box>
        ),
      )}
    </Box>
  );
}

// ─── audit mode ─────────────────────────────────────────────────────────────

function AuditMode({
  words,
  lit,
  sim,
  litLabel,
  simLabel,
  resources,
  rtl,
  litRtl,
  simRtl,
  compact,
  selectedPositions,
  onSelectWord,
}: {
  words: OriginalWord[];
  lit: LaneModel;
  sim: LaneModel;
  litLabel: string;
  simLabel: string;
  resources: ResourceItem[];
  rtl: boolean;
  litRtl: boolean;
  simRtl: boolean;
  compact: boolean;
  selectedPositions: Set<number>;
  onSelectWord: (positions: number[]) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);

  const notesAt = useMemo(() => {
    const m = new Map<number, ResourceItem[]>();
    for (const r of resources) {
      if (r.kind === "tq") continue;
      for (const p of r.positions) {
        const list = m.get(p);
        if (list) list.push(r);
        else m.set(p, [r]);
      }
    }
    return m;
  }, [resources]);

  if (words.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", mb: 2.5 }}>
        {t("flowVerse.verse.noSpineRows")}
      </Typography>
    );
  }

  const th = {
    textAlign: "start" as const,
    fontSize: "0.66rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: theme.palette.text.secondary,
    paddingBlock: 0.75,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    position: "sticky" as const,
    insetBlockStart: 0,
    background: theme.palette.background.default,
  };
  const td = {
    paddingBlock: 0.875,
    paddingInline: 1.25,
    borderBlockEnd: `1px solid ${theme.palette.divider}`,
    verticalAlign: "baseline" as const,
  };
  // The original column is the source the other two translate: a rule and
  // extra room on the side facing the literal column set it apart (#477).
  // That side is the TABLE's inline-end, but a cell carrying its own `dir`
  // (the original column does) resolves logical sides against that dir — so
  // when the cell's direction differs from the page's, the side flips.
  const sourceCol = (cellRtl: boolean) =>
    cellRtl === (theme.direction === "rtl")
      ? { borderInlineEnd: `1px solid ${theme.palette.divider}`, paddingInlineEnd: 2 }
      : { borderInlineStart: `1px solid ${theme.palette.divider}`, paddingInlineStart: 2 };

  // Each lane's text per source word, so a row can compare against the row
  // above it (cell's "same phrase" marker) without mutating during the map.
  const litTexts = words.map((w) => (lit.present ? laneTextFor(lit, w.position) : ""));
  const simTexts = words.map((w) => (sim.present ? laneTextFor(sim, w.position) : ""));

  const cell = (text: string, prev: string | null) => {
    if (!text) {
      return (
        <Box
          component="span"
          sx={{
            fontSize: "0.72rem",
            fontWeight: 600,
            color: theme.palette.flows.warn.ink,
            bgcolor: theme.palette.flows.warn.soft,
            borderRadius: 999,
            paddingBlock: "1px",
            paddingInline: 1,
          }}
        >
          {t("flowVerse.notRendered")}
        </Box>
      );
    }
    // A rendering repeated from the row above is a restructure, not a second
    // translation — say so instead of printing the same phrase twice.
    if (text === prev) {
      return (
        <Box component="span" sx={{ fontSize: "0.7rem", fontStyle: "italic", color: "text.secondary" }}>
          {t("flowVerse.verse.samePhrase")}
        </Box>
      );
    }
    return text;
  };

  return (
    <Box sx={{ marginBlockEnd: 3, overflowX: "auto" }}>
      <Box component="table" sx={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr>
            <Box component="th" sx={{ ...th, ...sourceCol(theme.direction === "rtl"), inlineSize: "24%" }}>
              {t("flowVerse.verse.colOriginal")}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "30%" }}>
              {t("flowVerse.section.literal", { label: litLabel })}
            </Box>
            <Box component="th" sx={{ ...th, inlineSize: "34%" }}>
              {t("flowVerse.section.simplified", { label: simLabel })}
            </Box>
            {/* Visible on tablet+. On a phone the column holds only a bare
                count and the words "Notes and terms" would push the table past
                360px, so there it keeps the accessible name without a label. */}
            <Box
              component="th"
              sx={{ ...th, inlineSize: "12%", textAlign: "end" }}
              aria-label={compact ? t("flowVerse.verse.notesAndTermsAria") : undefined}
            >
              {compact ? null : t("flowVerse.verse.notesAndTermsAria")}
            </Box>
          </tr>
        </thead>
        <tbody>
          {words.map((w, i) => {
            const litCell = lit.present ? cell(litTexts[i], i > 0 ? litTexts[i - 1] : null) : "—";
            const simCell = sim.present ? cell(simTexts[i], i > 0 ? simTexts[i - 1] : null) : "—";
            const marks = notesAt.get(w.position) ?? [];
            const selected = selectedPositions.has(w.position);
            return (
              <Box
                component="tr"
                key={w.position}
                onClick={() => onSelectWord([w.position])}
                aria-selected={selected}
                sx={{
                  cursor: "pointer",
                  "& > td": { background: selected ? hl : "transparent" },
                  "&:hover > td": { background: selected ? hl : theme.palette.action.hover },
                }}
              >
                <Box
                  component="td"
                  dir={rtl ? "rtl" : "ltr"}
                  sx={{
                    ...td,
                    ...sourceCol(rtl),
                    fontFamily: ORIGINAL_FONT_STACK,
                    fontSize: "1.18rem",
                    lineHeight: 1.7,
                    textAlign: "start",
                  }}
                >
                  {w.text}
                </Box>
                <Box
                  component="td"
                  dir={litRtl ? "rtl" : "ltr"}
                  sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK, textAlign: "start" }}
                >
                  {litCell}
                </Box>
                <Box
                  component="td"
                  dir={simRtl ? "rtl" : "ltr"}
                  sx={{ ...td, fontFamily: SCRIPTURE_FONT_STACK, textAlign: "start", color: "text.secondary" }}
                >
                  {simCell}
                </Box>
                <Box component="td" sx={{ ...td, textAlign: "end", whiteSpace: "nowrap" }}>
                  {compact
                    ? marks.length > 0 && (
                        <Box component="span" sx={{ fontSize: "0.66rem", color: "text.secondary" }}>
                          {marks.length}
                        </Box>
                      )
                    : marks.map((r) => (
                        <Box
                          key={r.key}
                          component="span"
                          title={r.tag}
                          sx={{
                            display: "inline-block",
                            fontSize: "0.66rem",
                            fontWeight: 700,
                            paddingBlock: "1px",
                            paddingInline: 0.75,
                            borderRadius: 999,
                            marginInlineStart: 0.5,
                            bgcolor:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.soft
                                : alpha(
                                    theme.palette.primary.main,
                                    theme.palette.mode === "dark" ? 0.26 : 0.18,
                                  ),
                            color:
                              r.kind === "twl"
                                ? theme.palette.flows.ok.ink
                                : theme.palette.mode === "dark"
                                  ? theme.palette.primary.light
                                  : theme.palette.primary.dark,
                          }}
                        >
                          {r.kind === "twl" ? "W" : "N"}
                        </Box>
                      ))}
                </Box>
              </Box>
            );
          })}
        </tbody>
      </Box>

      {(lit.supplied.length > 0 || sim.supplied.length > 0) && (
        <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.78rem", mt: 1.25 }}>
          {t("flowVerse.verse.suppliedPrefix")}{" "}
          {lit.supplied.length > 0 &&
            t("flowVerse.verse.suppliedLiteral", { words: lit.supplied.join(" · ") })}
          {lit.supplied.length > 0 && sim.supplied.length > 0 && " · "}
          {sim.supplied.length > 0 &&
            t("flowVerse.verse.suppliedSimplified", { words: sim.supplied.join(" · ") })}
        </Typography>
      )}
    </Box>
  );
}

// ─── in-place article ───────────────────────────────────────────────────────

// The tA / tW article opened from the detail pane, in the resource list's spot
// at every width band (issue #478): read-only, with a way back to the list and
// a link on to the full article editor for anyone who wants to edit it.
function VerseArticleView({
  article,
  stacked,
  onClose,
}: {
  article: VerseArticle;
  /** Below md: the detail column (and the link) sits stacked under this spot. */
  stacked: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const backRef = useRef<HTMLButtonElement>(null);
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;
  const heading =
    article.resource === "ta" ? t("flowVerse.article.headingTa") : t("flowVerse.article.headingTw");

  // Put focus on the way back. Below md the link sits in the detail column
  // stacked under this spot, so also bring the article into view there; on the
  // desk both columns are on screen and the text column must not jump.
  useEffect(() => {
    if (stacked) backRef.current?.scrollIntoView({ block: "nearest" });
    backRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article.resource, article.id]);

  return (
    <Box
      component="section"
      data-verse-article=""
      aria-label={heading}
      sx={{
        mt: 3,
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1.5,
        bgcolor: "background.paper",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1,
          paddingBlock: 1,
          paddingInline: 1,
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Button
          ref={backRef}
          size="small"
          onClick={onClose}
          startIcon={<ChevronLeftIcon fontSize="small" sx={chevronFlip} />}
          sx={{ flex: "none" }}
        >
          {t("flowVerse.article.back")}
        </Button>
        <Typography variant="body2" sx={{ fontWeight: 700, minInlineSize: 0 }}>
          {heading}
          {" · "}
          <Box component="span" dir="ltr" sx={{ fontFamily: "monospace", fontWeight: 400 }}>
            {article.id}
          </Box>
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Link
          href={`#/articles/${article.resource}/${encodeURIComponent(article.id)}`}
          sx={{ fontSize: "0.8rem", paddingInline: 1 }}
        >
          {t("flowVerse.article.openInEditor")}
        </Link>
      </Box>
      <AssociatedArticlePanel resource={article.resource} articleRef={article.id} selected />
    </Box>
  );
}

// ─── resource list ──────────────────────────────────────────────────────────

function ResourceList({
  resources,
  selection,
  rtl,
  compact,
  onSelect,
}: {
  resources: ResourceItem[];
  selection: VerseSelection | null;
  rtl: boolean;
  compact: boolean;
  onSelect: (sel: VerseSelection) => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const hl = alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.26 : 0.18);
  const currentKey = selection?.kind === "resource" ? selection.key : null;

  // `kind` is the identity (it filters the rows and keys the React list);
  // `labelKey` is display only, translated at render.
  const groups: Array<{ kind: ResourceItem["kind"]; labelKey: string }> = [
    { kind: "tn", labelKey: "shell.notes" },
    { kind: "twl", labelKey: "flowVerse.verse.groupWordLinks" },
    { kind: "tq", labelKey: "shell.questions" },
  ];

  if (resources.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.82rem", mt: 3 }}>
        {t("flowVerse.verse.noResources")}
      </Typography>
    );
  }

  return (
    // ONE grid for the whole list, not one per row (#477): the tag, text and
    // warning tracks are defined once here and every row lays its cells into
    // them through `subgrid`, so the tag, the note text and the trailing
    // warning start at the same x on every row of every group, whatever the
    // width of one row's tag. Group labels span all three tracks. On a phone
    // the warning track is capped so its text wraps instead of taking the
    // note text's width from every row.
    <Box
      sx={{
        mt: 3,
        display: "grid",
        gridTemplateColumns: `max-content minmax(0, 1fr) ${compact ? "fit-content(72px)" : "auto"}`,
        columnGap: 1.25,
      }}
    >
      {groups.map(({ kind, labelKey }) => {
        const list = resources.filter((r) => r.kind === kind);
        if (list.length === 0) return null;
        return (
          <Box
            key={kind}
            sx={{
              gridColumn: "1 / -1",
              display: "grid",
              gridTemplateColumns: "subgrid",
              marginBlockEnd: 2.5,
            }}
          >
            <Box sx={{ gridColumn: "1 / -1" }}>
              <LaneLabel>
                {t("flowVerse.verse.groupHeading", { label: t(labelKey), n: list.length })}
              </LaneLabel>
            </Box>
            {list.map((r) => (
              <Box
                key={r.key}
                component="button"
                type="button"
                data-resource-row=""
                onClick={() => onSelect({ kind: "resource", key: r.key })}
                aria-current={currentKey === r.key}
                sx={{
                  gridColumn: "1 / -1",
                  display: "grid",
                  gridTemplateColumns: "subgrid",
                  alignItems: "baseline",
                  textAlign: "start",
                  appearance: "none",
                  border: 0,
                  borderBlockEnd: "1px solid",
                  borderColor: "divider",
                  background: currentKey === r.key ? hl : "transparent",
                  color: "inherit",
                  font: "inherit",
                  fontSize: "0.85rem",
                  minBlockSize: 34,
                  paddingBlock: 0.875,
                  paddingInline: 1,
                  cursor: "pointer",
                  "&:hover, &:focus-visible": {
                    bgcolor: currentKey === r.key ? undefined : "action.hover",
                  },
                }}
              >
                <Box
                  component="span"
                  data-resource-col="tag"
                  sx={{
                    fontSize: "0.66rem",
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                  }}
                >
                  {r.tag}
                </Box>
                {/* The original-language quote sits on its own line above the
                    English summary: different script, font and direction, so
                    running them together on one line left no visible seam. */}
                <Box component="span" data-resource-col="text" sx={{ minInlineSize: 0, overflowWrap: "anywhere" }}>
                  {r.quote && (
                    // The block line follows the page direction, so the quote
                    // starts where the summary starts; the inner span isolates
                    // the original's own direction.
                    <Box component="span" sx={{ display: "block", marginBlockEnd: 0.25 }}>
                      <Box
                        component="span"
                        dir={rtl ? "rtl" : "ltr"}
                        sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1rem" }}
                      >
                        {r.quote.replace(/&/g, " … ")}
                      </Box>
                    </Box>
                  )}
                  <Box component="span" dir="auto" sx={{ display: "block", color: "text.secondary" }}>
                    {r.summary}
                  </Box>
                </Box>
                <Box
                  component="span"
                  data-resource-col="warn"
                  sx={{ fontSize: "0.72rem", color: theme.palette.flows.warn.ink }}
                >
                  {r.kind !== "tq" && r.quote && r.positions.length === 0
                    ? t("flowVerse.verse.quoteNotAnchored")
                    : ""}
                </Box>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

// --- Scroll layout --------------------------------------------------------
//
// The whole chapter as one list, one section per verse span. Memory stays flat
// however long the chapter: only the sections within LOAD_MARGIN_PX of the
// view are built (their joined lanes, resources and DOM). Every other section
// is an empty box at its last measured height, or an estimate before it has
// been seen, so the scrollbar and the reading position hold steady while
// sections load and unload. Chrome's scroll anchoring absorbs the difference
// when an estimated box above the view turns into the real verse.

interface ScrollRequest {
  start: number;
  smooth: boolean;
  n: number;
}

interface SectionContext {
  book: string;
  chapter: number;
  data: ChapterPayload | null;
  sourceIndex: Record<number, VerseDto>;
  litIndex: Record<number, VerseDto>;
  simIndex: Record<number, VerseDto>;
  mode: Mode;
  setMode: (m: Mode) => void;
  litLabel: string;
  simLabel: string;
  originalLabel: string;
  rtl: boolean;
  litRtl: boolean;
  simRtl: boolean;
  compact: boolean;
  stacked: boolean;
  onSelect: (start: number, sel: VerseSelection | null) => void;
  closeArticle: () => void;
}

// Build sections this far above and below the view (CSS px), so a section is
// ready before it scrolls in, even on a fast fling.
const LOAD_MARGIN_PX = 1600;
// The line, below the top of the view, that decides which section is current.
const CURRENT_LINE_PX = 96;
// Room left above a section brought into view by the stepper or the picker.
const SCROLL_TO_GAP_PX = 8;
// How long a far jump holds its target in place while sections around it build.
const PIN_MS = 1000;
// Height of a section never yet built, until real ones have been measured.
const INITIAL_ESTIMATE_PX = 420;

// What scrolls the list: on the desk the text column (marked
// data-verse-scroller), on a phone the page (null).
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  return el?.closest<HTMLElement>("[data-verse-scroller]") ?? null;
}

function VerseScrollList({
  spans,
  request,
  onCurrentChange,
  ctx,
  selection,
  selectionStart,
  article,
  inlineDetail,
  after,
}: {
  spans: VerseSpan[];
  request: ScrollRequest;
  onCurrentChange: (start: number) => void;
  ctx: SectionContext;
  selection: VerseSelection | null;
  selectionStart: number | null;
  article: VerseArticle | null;
  /** Phone only: the detail pane, shown inside the section the selection is in. */
  inlineDetail: ReactNode;
  /** Shown in the room after the last verse (the way on to the next chapter). */
  after: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const elsRef = useRef(new Map<number, HTMLElement>());
  const [live, setLive] = useState<Set<number>>(() => new Set());
  // Running average of measured section heights, for boxes not yet built.
  const measuredRef = useRef(new Map<number, number>());
  const [estimate, setEstimate] = useState(INITIAL_ESTIMATE_PX);

  const registerEl = useCallback((start: number, el: HTMLElement | null) => {
    if (el) elsRef.current.set(start, el);
    else elsRef.current.delete(start);
  }, []);

  const onMeasured = useCallback((start: number, h: number) => {
    const m = measuredRef.current;
    m.set(start, h);
    let sum = 0;
    for (const v of m.values()) sum += v;
    // Rounded so the estimate settles instead of re-rendering on every pixel.
    const next = Math.max(120, Math.round(sum / m.size / 40) * 40);
    setEstimate((prev) => (prev === next ? prev : next));
  }, []);

  // Load and unload sections as they near or leave the view, and track which
  // one is current.
  useEffect(() => {
    const root = scrollParentOf(listRef.current);
    const io = new IntersectionObserver(
      (entries) => {
        setLive((prev) => {
          let next: Set<number> | null = null;
          for (const e of entries) {
            const start = Number((e.target as HTMLElement).dataset.verseStart);
            if (e.isIntersecting === prev.has(start)) continue;
            next ??= new Set(prev);
            if (e.isIntersecting) next.add(start);
            else next.delete(start);
          }
          return next ?? prev;
        });
      },
      { root, rootMargin: `${LOAD_MARGIN_PX}px 0px` },
    );
    for (const s of spans) {
      const el = elsRef.current.get(s.start);
      if (el) io.observe(el);
    }

    let raf = 0;
    let last = -1;
    const compute = () => {
      raf = 0;
      if (spans.length === 0) return;
      const line = (root ? root.getBoundingClientRect().top : 0) + CURRENT_LINE_PX;
      const tops = spans.map((s) => elsRef.current.get(s.start)?.getBoundingClientRect().top ?? Infinity);
      const start = spans[currentIndexAt(tops, line)].start;
      if (start !== last) {
        last = start;
        onCurrentChange(start);
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const target: HTMLElement | Window = root ?? window;
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      io.disconnect();
      target.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // `ctx.stacked` flips at the desk breakpoint, which swaps what scrolls.
  }, [spans, onCurrentChange, ctx.stacked]);

  // Bring a requested verse into view: once on arrival, and again for each
  // stepper / picker use. Held until the chapter's sections exist.
  const handledRef = useRef(-1);
  // Ends the current hold. Kept apart from the effect's cleanup: a chapter
  // refetch re-runs the effect, and must not cut a hold short. On unmount the
  // request counts as unhandled again, so a remount (StrictMode runs one in
  // development) brings the verse into view once more.
  const stopHoldRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopHoldRef.current?.();
      handledRef.current = -1;
    },
    [],
  );
  useEffect(() => {
    if (handledRef.current === request.n) return;
    const i = spanIndexOf(spans, request.start);
    const el = i >= 0 ? elsRef.current.get(spans[i].start) : undefined;
    if (!el) return;
    handledRef.current = request.n;
    stopHoldRef.current?.();
    const root = scrollParentOf(listRef.current);
    const target: HTMLElement | Window = root ?? window;
    const offset = () =>
      el.getBoundingClientRect().top - (root ? root.getBoundingClientRect().top : 0) - SCROLL_TO_GAP_PX;
    // Glide only over a short distance. A long glide crosses sections not yet
    // measured, which change height as it passes and leave it short.
    const viewH = root ? root.clientHeight : window.innerHeight;
    if (request.smooth && Math.abs(offset()) < 2 * viewH) {
      target.scrollBy({ top: offset(), behavior: "smooth" });
      return;
    }
    // A far jump lands among boxes still at their estimated height. As the
    // sections around the target build, the ones above it change height, and
    // scroll anchoring can't hold the target because the target box itself
    // changes too. So hold it in place for a moment, until the reader scrolls.
    target.scrollBy({ top: offset() });
    const until = performance.now() + PIN_MS;
    let raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      for (const t of ["wheel", "touchstart", "keydown", "mousedown"]) window.removeEventListener(t, stop, true);
    };
    const hold = () => {
      if (!el.isConnected) {
        stop();
        return;
      }
      const off = offset();
      if (Math.abs(off) > 1) target.scrollBy({ top: off });
      if (performance.now() < until) raf = requestAnimationFrame(hold);
      else stop();
    };
    for (const t of ["wheel", "touchstart", "keydown", "mousedown"]) window.addEventListener(t, stop, true);
    raf = requestAnimationFrame(hold);
    stopHoldRef.current = stop;
  }, [request, spans]);

  return (
    <Box ref={listRef}>
      {spans.map((s) => {
        const owns = selectionStart === s.start;
        return (
          <VerseSection
            key={s.start}
            span={s}
            live={live.has(s.start)}
            estimate={estimate}
            ctx={ctx}
            selection={owns ? selection : null}
            article={owns ? article : null}
            inlineDetail={owns ? inlineDetail : null}
            registerEl={registerEl}
            onMeasured={onMeasured}
          />
        );
      })}
      {/* Room after the last verse, so it too can scroll up to the top and
          count as the verse being read. What comes after the chapter sits at
          its top: the room is shorter than the view, so at the end of the list
          that is in view (placed before the room, it scrolled out of sight). */}
      <Box sx={{ minBlockSize: "calc(100dvh - 200px)" }}>{after}</Box>
    </Box>
  );
}

const VerseSection = memo(function VerseSection({
  span,
  live,
  estimate,
  ctx,
  selection,
  article,
  inlineDetail,
  registerEl,
  onMeasured,
}: {
  span: VerseSpan;
  live: boolean;
  estimate: number;
  ctx: SectionContext;
  selection: VerseSelection | null;
  article: VerseArticle | null;
  inlineDetail: ReactNode;
  registerEl: (start: number, el: HTMLElement | null) => void;
  onMeasured: (start: number, h: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      registerEl(span.start, el);
    },
    [registerEl, span.start],
  );

  // Remember the built height, so the empty box left behind on unload is the
  // same size and nothing below it moves.
  useEffect(() => {
    const el = boxRef.current;
    if (!live || !el) return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(entries[0]?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight);
      setHeight(h);
      onMeasured(span.start, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [live, onMeasured, span.start]);

  return (
    <Box
      ref={setRef}
      data-verse-start={span.start}
      data-verse-live={live ? "" : undefined}
      sx={{
        boxSizing: "border-box",
        borderBlockEnd: "1px solid",
        borderColor: "divider",
        paddingBlock: 2,
      }}
      style={live ? undefined : { blockSize: height ?? estimate }}
    >
      {live && (
        <VerseSectionBody
          span={span}
          ctx={ctx}
          selection={selection}
          article={article}
          inlineDetail={inlineDetail}
        />
      )}
    </Box>
  );
});

const VerseSectionBody = memo(function VerseSectionBody({
  span,
  ctx,
  selection,
  article,
  inlineDetail,
}: {
  span: VerseSpan;
  ctx: SectionContext;
  selection: VerseSelection | null;
  article: VerseArticle | null;
  inlineDetail: ReactNode;
}) {
  const { t } = useTranslation();
  const { book, chapter, onSelect } = ctx;
  const { start, end } = span;
  const model = useSpanModel(ctx.data, ctx.sourceIndex, ctx.litIndex, ctx.simIndex, start, end);
  const { words, lit, sim, resources, flags, markedPositions } = model;

  const selectedPositions = useMemo(
    () => (selection ? selectedPositionsFor(selection, resources) : EMPTY_POSITIONS),
    [selection, resources],
  );
  const litOn = useMemo(() => activeGroupIds(lit, selectedPositions), [lit, selectedPositions]);
  const simOn = useMemo(() => activeGroupIds(sim, selectedPositions), [sim, selectedPositions]);

  const selectWord = useCallback(
    (positions: number[]) => onSelect(start, positions.length ? { kind: "word", positions } : null),
    [onSelect, start],
  );
  const selectGroup = useCallback(
    (lane: LaneModel, groupId: string | null) => {
      if (!groupId) {
        onSelect(start, null);
        return;
      }
      selectWord(lane.positionsByGroup.get(groupId) ?? []);
    },
    [onSelect, selectWord, start],
  );
  const selectResource = useCallback((sel: VerseSelection) => onSelect(start, sel), [onSelect, start]);

  const bridged = end > start;
  const label = `${book} ${chapter}:${bridged ? `${start}-${end}` : start}`;

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap", marginBlockEnd: 1.5 }}>
        <Typography component="h2" sx={{ fontSize: "0.95rem", fontWeight: 700, m: 0 }}>
          {label}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <FlagRow
          flags={flags}
          onPick={(f) => {
            if (!f.positions.length) return;
            ctx.setMode("audit");
            selectWord(f.positions);
          }}
        />
      </Box>
      {bridged && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t("flowVerse.verse.bridgedNotice", { start, end })}
        </Alert>
      )}
      {words.length === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t("flowVerse.verse.noOriginalText", { label: ctx.originalLabel, ref: label })}
        </Alert>
      )}
      {ctx.mode === "read" ? (
        <ReadMode
          words={words}
          lit={lit}
          sim={sim}
          litLabel={ctx.litLabel}
          simLabel={ctx.simLabel}
          originalLabel={ctx.originalLabel}
          rtl={ctx.rtl}
          litRtl={ctx.litRtl}
          simRtl={ctx.simRtl}
          selectedPositions={selectedPositions}
          markedPositions={markedPositions}
          litOn={litOn}
          simOn={simOn}
          onSelectWord={selectWord}
          onSelectGroup={selectGroup}
        />
      ) : (
        <AuditMode
          words={words}
          lit={lit}
          sim={sim}
          litLabel={ctx.litLabel}
          simLabel={ctx.simLabel}
          resources={resources}
          rtl={ctx.rtl}
          litRtl={ctx.litRtl}
          simRtl={ctx.simRtl}
          compact={ctx.compact}
          selectedPositions={selectedPositions}
          onSelectWord={selectWord}
        />
      )}
      {inlineDetail && (
        <Box
          sx={{
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 1.5,
            paddingInline: 1.5,
            marginBlockEnd: 2,
          }}
        >
          {inlineDetail}
        </Box>
      )}
      {article ? (
        <VerseArticleView article={article} stacked={ctx.stacked} onClose={ctx.closeArticle} />
      ) : (
        <ResourceList
          resources={resources}
          selection={selection}
          rtl={ctx.rtl}
          compact={ctx.compact}
          onSelect={selectResource}
        />
      )}
    </>
  );
});

const EMPTY_POSITIONS = new Set<number>();
