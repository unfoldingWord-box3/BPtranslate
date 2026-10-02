// TranslateAlignScreen — the redesigned per-book Alignment screen (Benjamin,
// 2026-08-10: "alignment next, with the other widths"). No dedicated artifact
// exists; the chrome is synthesized from the design system exactly as the
// sibling screens do (TranslateWordsScreen's topbar / progress / desk /
// pane conventions; TranslateNotesScreen's queue conventions).
//
// Routes (App.tsx wires them; mode lives in the route so back/forward work):
//   #/alignment/{book}/{chapter}            → verse 1, single
//   #/alignment/{book}/{chapter}/{verse}    → that verse, single
//   #/alignment/{book}/{chapter}/{verse}/dual → that verse, dual
// Back chevron → #/package/{book}. In-screen nav only rewrites location.hash.
//
// ── The one rule that matters: the aligner is REUSED, never rebuilt ────────
// Every aligner surface and every save path here is lifted verbatim from the
// flows AlignScreen (web/src/components/flows/AlignScreen.tsx), which is
// itself the audited port of Shell's aligner wiring:
//
//   * Drag canvas   = <AlignmentPanel> (AlignScreen.tsx:823-843), the shipped
//     drag aligner with its own crash drafts, ghosts, and action bar.
//   * Tap-to-pair   = <AlignTapView> over the same lib/alignment model, with
//     the same crash-draft store + guards (AlignScreen.tsx:201-266).
//   * Dual mode     = <SideBySideAligner> — the app's real dual aligner, a
//     fullscreen Dialog (SideBySideAligner.tsx:187). Because it is fullscreen
//     by construction, the "should dual collapse the list pane?" question is
//     moot: dual always takes the whole viewport, the desk stays beneath it.
//   * Saves         = guardBlocksSave → outbox.enqueueVerse with
//     alignment_intent:"alignment_edit" + sourceGeneration, then
//     applyLocalVerse — byte-for-byte the shape of AlignScreen.tsx:345-368
//     (enqueueAlignment) and :426-465 (handleSaveReading via smartEditVerse).
//     NOTHING here hand-builds verse JSON.
//
// ── What this screen adds over AlignScreen ─────────────────────────────────
//   * Sibling-screen chrome: back-chevron topbar, title/sub, "Verse N of M",
//     thin progress bar (TranslateWordsScreen.tsx:799-855). The count carries
//     compact icon-only prev/next chevrons on both widths (Benjamin
//     2026-08-10: screens with prev/next get controls at top and bottom) —
//     same goVerse hash rewrite and same disabled logic as the detail
//     header's pair.
//   * md+ (>=900): 1440px desk, verse-list pane minmax(340px,380px) +
//     panel-chromed detail pane (TranslateWordsScreen.tsx:857-930). Phone
//     (<900): one centred column with Prev/Next (notes-screen pattern). The
//     phone column is 720px, wider than the notes screens' 480 — the drag
//     canvas and tap cards are width-hungry, and 480 would squeeze them for
//     no design reason. The phone column closes with a bottom Previous/Next
//     row (TranslateScriptureScreen's phone footer pattern), so a top AND a
//     bottom affordance exist on phone: topbar chevrons up top, buttons at
//     the end of the column.
//   * Lane picker: BOTH lanes are alignable — AlignScreen fixes single mode
//     to ULT (AlignScreen.tsx:98) but aligns ULT and UST in its dual dialog,
//     through the same enqueueAlignment(bibleVersion) path — so single mode
//     here gets a small segmented control (ULT/UST), defaulting to ULT.
//     Lane choice is component state, not route (route contract is fixed).
//   * Honest per-verse status: lib/alignment.ts:550-558 (verseHasUnalignedWork)
//     defines "alignment work remains" = unaligned target words OR source
//     groups with no targets. The list needs the unaligned COUNT too, so it
//     calls parseAlignment once per verse and applies those same two checks
//     (with the source side supplied, so uncovered source words surface as
//     empty coverage groups). "Done" additionally requires the verse to have
//     target content — an undrafted verse is empty, not aligned. The topbar
//     progress bar shows fully-aligned verses / all verses.
//
// ── Interaction-mode policy (docs/flows/04-mobile-alignment, via
//    AlignScreen.tsx:193-199) ────────────────────────────────────────────────
//   <560 tap only · 560-899 tap default · >=900 drag default, toggleable.
//   The drag canvas genuinely cannot operate below 560 (drag targets too
//   small — the mobile-alignment findings), so the phone band renders the
//   tap-to-pair aligner, which is the real aligner over the same model, not
//   a limit message.
//
// ── Deliberate omissions ───────────────────────────────────────────────────
//   * No pill bar — the redesigned screens navigate by back-chevron + hash
//     (TranslateWordsScreen.tsx:12-14 precedent).
//   * No read-only "reference" panel (AlignScreen.tsx:741-808) — not in the
//     redesign spec; the verse list's status chips carry that signal now.
//   * `me` / `onNavigate` from FlowScreenContext are accepted but unused,
//     same as AlignScreen.tsx:164-166: verse movement stays on this screen
//     by moving the hash.
//   * NO swipe navigation — deliberate exception to the 2026-08-10 "prev/next
//     screens also get swipe" direction. Every content surface here is a
//     gesture surface: the drag canvas is HTML5-draggable words edge to edge,
//     and tap mode is wall-to-wall tap targets where a horizontal drag is
//     indistinguishable from the start of an alignment gesture. The shared
//     ./useSwipeNav hook (what the sibling queue screens use) guards
//     [draggable]/[data-no-swipe] starts, which here would exempt nearly the
//     whole column — leaving a swipe that "sometimes works", worse than none.
//     If a safe gesture area is ever found (e.g. the topbar strip alone),
//     wire it through ./useSwipeNav rather than a bespoke handler.
//
// RTL: logical properties only; scripture-direction handling is whatever the
// aligner components already do (AlignTapView takes sourceRtl/targetRtl from
// the same isHebrewBook/versionIsRtl derivations AlignScreen uses; the list
// snippet sets a dir attribute, never a CSS direction flip). Directional
// chevrons mirror under RTL via scaleX(-1), the TranslateScriptureScreen.tsx
// chevronFlip convention.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowHeader, PHONE_COUNT_SX, PHONE_TITLE_SX } from "./FlowHeader";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Skeleton,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import { useTranslation } from "react-i18next";

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip } from "./FlowStatusChip";
import { AlignTapView } from "./AlignTapView";
import {
  buildSourceIndexMap,
  collectStrongKeys,
  orderDisplayGroups,
  streamWordsOf,
} from "./AlignSourceModel";
import type { FlowScreenContext } from "./types";

import { AlignmentPanel, type AlignmentPanelHandle } from "../AlignmentPanel";
import {
  SideBySideAligner,
  type PanelSlot,
  type ReadingLineHandle,
} from "../SideBySideAligner";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { useChapter } from "../../hooks/useChapter";
import { useLexicon } from "../../hooks/useLexicon";
import { useProjectConfig } from "../../hooks/useProjectConfig";
import { useAlignmentSuggestions } from "../../hooks/useAlignmentSuggestions";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { alignmentDrafts, alignmentDraftKey } from "../../sync/alignmentDrafts";
import { isLaneFrozen } from "../../sync/laneFreeze";
import type { ChapterLockedBody, ChapterPayload, TwlRow, VerseDto } from "../../sync/api";
import {
  alignmentPlainText,
  parseAlignment,
  serializeAlignment,
  type AlignmentState,
} from "../../lib/alignment";
import { computeGhosts, dismissedGhostKey, type Ghost } from "../../lib/alignmentSuggest";
import { analyzeAlignmentDelta, guardBlocksSave, lostAlignedWords } from "../../lib/alignmentDelta";
import {
  buildVerseIndex,
  concatSourceRange,
  formatVerseLabel,
  verseObjectsOf,
} from "../../lib/verseRange";
import { isHebrewBook } from "../../lib/sourceSearch";
import { versionIsRtl, versionLabel } from "../../lib/versionLabels";
import { extractEditableText, extractPlainText, normalizeEditable } from "../../lib/usfm";
import { smartEditVerse } from "../../lib/replace";
import { collectSourceWordNodes } from "../../lib/quoteBuilder";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateAlignScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  verse: number;
  mode: "single" | "dual";
}

// The two alignable lanes (AlignScreen.tsx:98-99 uses the same role codes:
// ULT = the "lit" lane, UST = the "sim" lane).
const LANE_LEFT = "ULT";
const LANE_RIGHT = "UST";
type Lane = typeof LANE_LEFT | typeof LANE_RIGHT;

// Phone column. Wider than the notes screens' 480 — see file header.
const COLUMN_PX = 720;

// Stable empty list so `twlForVerse` identity doesn't churn AlignmentPanel's
// memos on every render when the slice is missing (AlignScreen.tsx:101-103).
const EMPTY_TWL: TwlRow[] = [];

interface Slice {
  targetVerse: VerseDto | null;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  rangeStart: number;
  rangeEnd: number;
}

// Per-version slice — copied verbatim from AlignScreen.tsx:117-132 (itself a
// mirror of Shell's private buildAlignerSlice). Resolving through
// buildVerseIndex is what lets v7 of a 6-9 range row find its row.
function buildSlice(
  data: ChapterPayload,
  verse: number,
  bibleVersion: string,
  sourceLane: string,
): Slice {
  const targetVerse = buildVerseIndex(data.verses[bibleVersion])[verse] ?? null;
  const rangeStart = targetVerse?.verse ?? verse;
  const rangeEnd = targetVerse?.verse_end ?? targetVerse?.verse ?? verse;
  const sourceVerse =
    rangeEnd > rangeStart
      ? concatSourceRange(data.verses[sourceLane] ?? {}, rangeStart, rangeEnd)
      : (data.verses[sourceLane]?.[rangeStart] ?? null);
  const twlForVerse = data.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
  return { targetVerse, sourceVerse, twlForVerse, rangeStart, rangeEnd };
}

// Source word-token count of one row — offsets the side-by-side panels into
// the shared strip's union span. Same one-liner as AlignScreen/Shell: both
// project off quoteBuilder's shared `collectSourceWordNodes` so every offset
// counts exactly the words UhbStrip positions (#370).
function countSourceWords(row: VerseDto | undefined): number {
  const verseObjects = (row?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return collectSourceWordNodes(verseObjects ?? []).length;
}

interface PendingLoss {
  ref: string;
  lostWords: string[];
  commit: () => void;
}

// One verse-list row's honest status — see the file header for why these are
// exactly the verseHasUnalignedWork checks (lib/alignment.ts:550-558) plus a
// has-target requirement and the unaligned count.
interface VerseRowStatus {
  verse: number;
  row: VerseDto | null;
  hasTarget: boolean;
  unaligned: number;
  sourceGaps: boolean;
  done: boolean;
  snippet: string;
}

export default function TranslateAlignScreen({
  role,
  book,
  chapter,
  verse,
  mode,
}: TranslateAlignScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const INSPIRE = "#31ADE3";
  const { skip } = theme.palette.flows;
  // Interaction-band breakpoints, same as AlignScreen.tsx:167-169.
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet")); // >=560
  const isDesktop = useMediaQuery(theme.breakpoints.up("md")); // >=900
  const wide = isDesktop; // md+ master-detail, the sibling screens' breakpoint
  // Chevron glyphs don't flip with CSS direction on their own — mirror them
  // under RTL (TranslateScriptureScreen.tsx chevronFlip convention).
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;

  const { status, data, applyLocalVerse } = useChapter(book, chapter);
  const projectConfig = useProjectConfig();

  // Viewers must not be able to start a save (AlignScreen.tsx:174-178: below
  // the UI, alignmentDrafts.set early-returns and outbox.enqueueVerse no-ops
  // for a viewer, so an ungated screen would look saved while dropping work).
  const canEdit = role === "admin" || role === "editor";

  const sourceLane = isHebrewBook(book) ? "UHB" : "UGNT";
  const sourceRtl = sourceLane === "UHB";

  // ── lane picker (single mode) ─────────────────────────────────────────────
  const [lane, setLane] = useState<Lane>(LANE_LEFT);
  const targetRtl = versionIsRtl(projectConfig, lane);
  const laneLabel = versionLabel(projectConfig, lane);

  const slice = useMemo<Slice | null>(
    () => (data ? buildSlice(data, verse, lane, sourceLane) : null),
    [data, verse, lane, sourceLane],
  );
  const targetVerse = slice?.targetVerse ?? null;
  const sourceVerse = slice?.sourceVerse ?? null;
  const twlForVerse = slice?.twlForVerse ?? EMPTY_TWL;

  // ── interaction mode (form-factor policy; AlignScreen.tsx:193-199) ───────
  const [interactionChoice, setInteractionChoice] = useState<"drag" | "tap" | null>(null);
  useEffect(() => {
    setInteractionChoice(null); // band change resets to the band's default
  }, [isDesktop, isTabletUp]);
  const interaction: "drag" | "tap" = !isTabletUp
    ? "tap"
    : (interactionChoice ?? (isDesktop ? "drag" : "tap"));

  // ── tap-to-pair state over the SAME parsed model the drag canvas uses ────
  // (AlignScreen.tsx:201-266, parameterized by `lane` instead of fixed ULT —
  // the draft key carries the lane, so per-lane drafts never collide.)
  const sourceVerseObjects = useMemo(() => verseObjectsOf(sourceVerse), [sourceVerse]);
  const computedInitial = useMemo<AlignmentState | null>(() => {
    const vo = verseObjectsOf(targetVerse);
    return vo ? parseAlignment(vo, sourceVerseObjects) : null;
  }, [targetVerse, sourceVerseObjects]);

  const [tapState, setTapState] = useState<AlignmentState | null>(computedInitial);

  const draftKey = alignmentDraftKey(book, chapter, verse, lane);

  // Which draft key the current tapState's edits belong to. On verse nav the
  // persist effect below re-runs once with the NEW draftKey while tapState is
  // still the OLD verse's edited state (the reset effect's setTapState hasn't
  // committed yet); without this provenance check that mixed run schedules —
  // and its cleanup flushes — the old verse's alignment under the new verse's
  // key. Set at every real edit and at draft rehydration; nulled on reset.
  const tapEditKeyRef = useRef<string | null>(null);

  // Reset to the freshly parsed baseline on verse/lane/content change, then
  // re-hydrate a crash-saved alignment draft — same store, same key shape and
  // the same three guards the drag canvas uses (AlignScreen.tsx:220-248).
  useEffect(() => {
    tapEditKeyRef.current = null;
    setTapState(computedInitial);
    if (!computedInitial || !targetVerse) return;
    const baseVersion = targetVerse.version;
    const baseGen = targetVerse.source_generation;
    let cancelled = false;
    void alignmentDrafts.get(draftKey).then((rec) => {
      if (cancelled || !rec) return;
      if (rec.quarantined || isLaneFrozen(lane)) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      if (rec.expectedVersion !== baseVersion) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      if (rec.sourceGeneration == null || (baseGen != null && rec.sourceGeneration !== baseGen)) {
        void alignmentDrafts.clear(draftKey);
        return;
      }
      // "User already edited" guard, race-free: edits stamp tapEditKeyRef with
      // this verse's key synchronously in the onChange handler, so it can't
      // lose to a fast IndexedDB get() the way the old tapState-ref compare
      // did (that ref synced in a passive effect, which made same-mount verse
      // re-entry silently skip rehydration).
      if (tapEditKeyRef.current === draftKey) return;
      const vo = (rec.content as { verseObjects?: unknown[] }).verseObjects;
      if (!Array.isArray(vo)) return;
      tapEditKeyRef.current = draftKey; // rehydrated edits belong to this key
      setTapState(parseAlignment(vo, sourceVerseObjects));
    });
    return () => {
      cancelled = true;
    };
  }, [computedInitial, targetVerse, draftKey, sourceVerseObjects, lane]);

  const tapDirty = tapState !== null && tapState !== computedInitial;

  // Persist in-progress tap edits (debounced) so a crash doesn't lose them
  // (AlignScreen.tsx:252-266). The cleanup below flushes synchronously
  // whenever this effect run's timer hasn't fired yet — this covers BOTH
  // unmount and same-screen verse navigation (prev/next chevrons, list-row
  // click), neither of which unmount TranslateAlignScreen. Verse nav changes
  // `draftKey`/`targetVerse`, which are deps here, so React tears down this
  // effect run (and its pending timer) before the next one starts; without
  // an explicit flush in the cleanup, a pairing made <400ms before
  // navigating was silently dropped. The flush uses only this closure's
  // captured key/content/version — never a mutable ref — so a later render
  // can't repoint or null out what gets written.
  useEffect(() => {
    if (!tapDirty || !tapState || !targetVerse) return;
    // Provenance guard: skip the one mid-transition run where the new
    // draftKey is paired with the previous verse's still-uncommitted state.
    if (tapEditKeyRef.current !== draftKey) return;
    const baseVersion = targetVerse.version;
    const gen = targetVerse.source_generation;
    const content = { verseObjects: serializeAlignment(tapState) };
    const key = draftKey;
    let fired = false;
    const t = setTimeout(() => {
      fired = true;
      void alignmentDrafts.set(key, content, baseVersion, { sourceGeneration: gen });
    }, 400);
    return () => {
      clearTimeout(t);
      if (!fired) {
        void alignmentDrafts.set(key, content, baseVersion, { sourceGeneration: gen });
      }
    };
  }, [tapState, tapDirty, targetVerse, draftKey]);

  // ── suggestions (the same scorer the drag canvas uses; AlignScreen.tsx:268-297)
  const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);
  const strongKeys = useMemo(
    () => collectStrongKeys(tapState, sourceVerse),
    [tapState, sourceVerse],
  );
  const lexiconMap = useLexicon(strongKeys.strongs);
  const suggestions = useAlignmentSuggestions(lane, strongKeys.keys);
  const displayCards = useMemo(
    () => orderDisplayGroups(tapState, sourceIndexMap),
    [tapState, sourceIndexMap],
  );
  const streamWords = useMemo(() => streamWordsOf(tapState), [tapState]);
  const [dismissedGhosts, setDismissedGhosts] = useState<Set<string>>(new Set());
  useEffect(() => {
    setDismissedGhosts(new Set());
  }, [verse]);
  const ghosts = useMemo(
    () => computeGhosts(displayCards, streamWords, suggestions, dismissedGhosts),
    [displayCards, streamWords, suggestions, dismissedGhosts],
  );
  const handleDismissGhost = useCallback(
    (ghost: Ghost) => {
      const g = displayCards.find((x) => x.id === ghost.groupId);
      if (!g) return;
      const key = dismissedGhostKey(g, ghost.text);
      setDismissedGhosts((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    },
    [displayCards],
  );

  // ── chrome state ──────────────────────────────────────────────────────────
  const [dragDirty, setDragDirty] = useState(false);
  // The snackbar holds an i18n KEY, not a rendered sentence: the setters below
  // sit inside data-mutating useCallbacks, and adding `t` to their deps would
  // give them a new identity on every language change (react-i18next rebinds
  // `t`), re-firing saves. Translating at render keeps the notice reactive to
  // a language switch without dragging `t` into a save path.
  const [notice, setNotice] = useState<string | null>(null);
  const [lock, setLock] = useState<ChapterLockedBody | null>(null);
  const [pendingLoss, setPendingLoss] = useState<PendingLoss | null>(null);

  const panelRef = useRef<AlignmentPanelHandle | null>(null);
  const dualLeftRef = useRef<AlignmentPanelHandle | null>(null);
  const dualRightRef = useRef<AlignmentPanelHandle | null>(null);
  const dualLeftReadingRef = useRef<ReadingLineHandle | null>(null);
  const dualRightReadingRef = useRef<ReadingLineHandle | null>(null);
  // Dual-dialog dirty tracking + gate — AlignScreen.tsx:316-325 verbatim.
  const [dualLeftDirty, setDualLeftDirty] = useState(false);
  const [dualRightDirty, setDualRightDirty] = useState(false);
  const [dualLeftReadingDirty, setDualLeftReadingDirty] = useState(false);
  const [dualRightReadingDirty, setDualRightReadingDirty] = useState(false);
  const [pendingDualAction, setPendingDualAction] = useState<{ run: () => void } | null>(null);
  const dualDirty =
    dualLeftDirty || dualRightDirty || dualLeftReadingDirty || dualRightReadingDirty;
  // Full-page unloads bypass the in-app gate; the browser confirm covers them.
  useUnsavedGuard(dualDirty);

  // Reactive lock banner — an alignment save's 409 chapter_locked arrives as
  // an outbox result, never a throw here (AlignScreen.tsx:327-337).
  useEffect(() => {
    return onOutboxResult((op, result) => {
      if (result.kind !== "locked") return;
      if (op.target.kind !== "verse" || op.target.book !== book) return;
      setLock(result.lockBody);
    });
  }, [book]);

  // ── the save path (AlignScreen.tsx:339-368, identical) ───────────────────
  const enqueueAlignment = useCallback(
    (row: VerseDto, bibleVersion: string, content: unknown, plain: string, expectedVersion: number) => {
      if (!canEdit) {
        setNotice("flowAlign.notice.viewOnlyAlignment");
        return;
      }
      const delta = analyzeAlignmentDelta(row.content, content);
      if (guardBlocksSave(delta, "alignment_edit")) {
        setNotice("flowAlign.notice.saveBlocked");
        return;
      }
      void outbox.enqueueVerse(
        book,
        chapter,
        row.verse,
        bibleVersion,
        expectedVersion,
        { content, plain_text: plain, alignment_intent: "alignment_edit" },
        { sourceGeneration: row.source_generation },
      );
      applyLocalVerse({ ...row, content, plain_text: plain } as VerseDto);
    },
    [book, chapter, applyLocalVerse, canEdit],
  );

  const confirmUnalignFor = useCallback(
    (row: VerseDto | null, bibleVersion: string) => (lostWords: string[], commit: () => void) =>
      setPendingLoss({
        ref: `${book} ${chapter}:${row?.verse ?? verse} ${bibleVersion}`,
        lostWords,
        commit,
      }),
    [book, chapter, verse],
  );

  const handlePanelSave = useCallback(
    (content: unknown, plain: string, expectedVersion: number) => {
      if (!targetVerse) return;
      enqueueAlignment(targetVerse, lane, content, plain, expectedVersion);
    },
    [targetVerse, lane, enqueueAlignment],
  );

  // Tap-mode save — serializeAlignment + alignmentPlainText are the library's
  // own writers, so the \zaln tree is rebuilt by the tested code path
  // (AlignScreen.tsx:388-409).
  const handleTapSave = useCallback(() => {
    if (!canEdit) {
      setNotice("flowAlign.notice.viewOnlyAlignment");
      return;
    }
    if (!tapState || !targetVerse) return;
    const content = { verseObjects: serializeAlignment(tapState) };
    const plain = alignmentPlainText(tapState);
    const commit = () => {
      enqueueAlignment(targetVerse, lane, content, plain, targetVerse.version);
      void alignmentDrafts.clear(draftKey);
    };
    const lost = lostAlignedWords(targetVerse.content, content);
    if (lost.length > 0) {
      setPendingLoss({ ref: `${book} ${chapter}:${targetVerse.verse} ${lane}`, lostWords: lost, commit });
      return;
    }
    commit();
  }, [canEdit, tapState, targetVerse, lane, enqueueAlignment, draftKey, book, chapter]);

  const handleTapReset = useCallback(() => {
    tapEditKeyRef.current = null;
    setTapState(computedInitial);
    void alignmentDrafts.clear(draftKey);
  }, [computedInitial, draftKey]);

  // ── dual mode (the real dual aligner; AlignScreen.tsx:416-521) ───────────
  const litSlice = useMemo<Slice | null>(
    () => (data ? buildSlice(data, verse, LANE_LEFT, sourceLane) : null),
    [data, verse, sourceLane],
  );
  const simSlice = useMemo<Slice | null>(
    () => (data ? buildSlice(data, verse, LANE_RIGHT, sourceLane) : null),
    [data, verse, sourceLane],
  );

  // Reading-line save inside the dual aligner: scripture text edits go through
  // smartEditVerse, the alignment-preserving edit engine (AlignScreen.tsx:422-465).
  const handleSaveReading = useCallback(
    (bibleVersion: string, plain: string, base: VerseDto) => {
      if (!canEdit) {
        setNotice("flowAlign.notice.viewOnlyText");
        return;
      }
      const oldEditable = extractEditableText(base.content);
      if (oldEditable === normalizeEditable(plain)) return;
      const result = smartEditVerse(base.content, oldEditable, plain);
      const newPlainText = extractPlainText(result.content);
      const enqueueText = (intent: "text_edit" | "alignment_edit") => {
        void outbox.enqueueVerse(
          book,
          chapter,
          base.verse,
          bibleVersion,
          base.version,
          { content: result.content, plain_text: newPlainText, alignment_intent: intent },
          { sourceGeneration: base.source_generation },
        );
        applyLocalVerse({ ...base, content: result.content, plain_text: newPlainText } as VerseDto);
      };
      const delta = analyzeAlignmentDelta(base.content, result.content);
      if (guardBlocksSave(delta, "text_edit")) {
        setPendingLoss({
          ref: `${book} ${chapter}:${base.verse} ${bibleVersion}`,
          lostWords: delta.unexpectedLosses.map((l) => l.text),
          commit: () => enqueueText("alignment_edit"),
        });
        return;
      }
      enqueueText("text_edit");
    },
    [book, chapter, applyLocalVerse, canEdit],
  );

  const dualProps = useMemo(() => {
    if (!data || !litSlice || !simSlice) return null;
    if (!litSlice.targetVerse && !simSlice.targetVerse) return null;
    const rangeStart = Math.min(litSlice.rangeStart, simSlice.rangeStart);
    const rangeEnd = Math.max(litSlice.rangeEnd, simSlice.rangeEnd);
    const byStart = data.verses[sourceLane] ?? {};
    const unionSource =
      rangeEnd > rangeStart
        ? concatSourceRange(byStart, rangeStart, rangeEnd)
        : (byStart[rangeStart] ?? null);
    const offsetFor = (ownStart: number) => {
      let off = 0;
      for (let v = rangeStart; v < ownStart; v++) off += countSourceWords(byStart[v]);
      return off;
    };
    const saveFor = (bibleVersion: string, row: VerseDto | null) =>
      (content: unknown, plain: string, expectedVersion: number) => {
        if (!row) return;
        enqueueAlignment(row, bibleVersion, content, plain, expectedVersion);
      };
    const left: PanelSlot = {
      bibleVersion: LANE_LEFT,
      verse: litSlice.targetVerse,
      sourceVerse: litSlice.sourceVerse,
      twlForVerse: litSlice.twlForVerse,
      posOffset: offsetFor(litSlice.rangeStart),
      onSave: saveFor(LANE_LEFT, litSlice.targetVerse),
      onConfirmUnalign: confirmUnalignFor(litSlice.targetVerse, LANE_LEFT),
      onDirtyChange: setDualLeftDirty,
      panelRef: dualLeftRef,
      onReadingDirtyChange: setDualLeftReadingDirty,
      readingRef: dualLeftReadingRef,
    };
    const right: PanelSlot = {
      bibleVersion: LANE_RIGHT,
      verse: simSlice.targetVerse,
      sourceVerse: simSlice.sourceVerse,
      twlForVerse: simSlice.twlForVerse,
      posOffset: offsetFor(simSlice.rangeStart),
      onSave: saveFor(LANE_RIGHT, simSlice.targetVerse),
      onConfirmUnalign: confirmUnalignFor(simSlice.targetVerse, LANE_RIGHT),
      onDirtyChange: setDualRightDirty,
      panelRef: dualRightRef,
      onReadingDirtyChange: setDualRightReadingDirty,
      readingRef: dualRightReadingRef,
    };
    const labelVerse = litSlice.targetVerse ?? simSlice.targetVerse;
    return {
      sourceVerse: unionSource,
      twlForVerse: data.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd),
      vref: `${book} ${chapter}:${labelVerse ? formatVerseLabel(labelVerse) : verse}`,
      left,
      right,
    };
  }, [data, litSlice, simSlice, sourceLane, book, chapter, verse, enqueueAlignment, confirmUnalignFor]);

  // ── route-driven navigation (mode is in the hash, so back/forward work) ──
  const hashFor = useCallback(
    (v: number, m: "single" | "dual") =>
      `#/alignment/${book}/${chapter}/${v}${m === "dual" ? "/dual" : ""}`,
    [book, chapter],
  );

  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.[LANE_LEFT] ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);
  const verseIdx = verseNums.indexOf(verse);
  const prevVerse = verseIdx > 0 ? verseNums[verseIdx - 1] : null;
  const nextVerse = verseIdx >= 0 && verseIdx < verseNums.length - 1 ? verseNums[verseIdx + 1] : null;
  const goVerse = useCallback(
    (n: number | null) => {
      if (n == null) return;
      location.hash = hashFor(n, mode);
    },
    [hashFor, mode],
  );
  const setRouteMode = useCallback(
    (m: "single" | "dual") => {
      if (m !== mode) location.hash = hashFor(verse, m);
    },
    [hashFor, verse, mode],
  );

  // Anything that leaves or re-targets the dual aligner asks first when either
  // panel holds unsaved work (AlignScreen.tsx:539-577 verbatim, with "close"
  // now meaning "route back to single mode").
  const requestDualAction = (run: () => void) => {
    if (dualDirty) setPendingDualAction({ run });
    else run();
  };
  const requestCloseDual = () => requestDualAction(() => setRouteMode("single"));
  const dualNavTo = (n: number | null) =>
    requestDualAction(() => {
      if (n != null) location.hash = hashFor(n, "dual");
    });
  const resolveDualAction = (choice: "save" | "discard") => {
    const action = pendingDualAction;
    setPendingDualAction(null);
    if (choice === "discard") {
      if (dualLeftDirty) dualLeftRef.current?.discard();
      if (dualRightDirty) dualRightRef.current?.discard();
      if (dualLeftReadingDirty) dualLeftReadingRef.current?.discard();
      if (dualRightReadingDirty) dualRightReadingRef.current?.discard();
      action?.run();
      return;
    }
    // Reading-line edits are synchronous; alignment panels may defer behind
    // the unalign confirm, so CHAIN them (see AlignScreen.tsx:562-576).
    if (dualLeftReadingDirty) dualLeftReadingRef.current?.save();
    if (dualRightReadingDirty) dualRightReadingRef.current?.save();
    const finish = () => action?.run();
    const saveRight = () => {
      if (dualRightDirty && dualRightRef.current) dualRightRef.current.save(finish);
      else finish();
    };
    if (dualLeftDirty && dualLeftRef.current) dualLeftRef.current.save(saveRight);
    else saveRight();
  };

  const dirty = interaction === "drag" ? dragDirty : tapDirty;

  // ── per-verse honest status for the list + progress bar ──────────────────
  // Same two checks as verseHasUnalignedWork (lib/alignment.ts:550-558), via
  // one parseAlignment call per verse so the unaligned COUNT is available too.
  // Source verseObjects are supplied so uncovered source words surface as
  // empty coverage groups. Recomputed per lane — status is a lane property.
  const verseRows = useMemo<VerseRowStatus[]>(() => {
    if (!data) return [];
    const targetIndex = buildVerseIndex(data.verses[lane]);
    const sourceByStart = data.verses[sourceLane] ?? {};
    return verseNums.map((n) => {
      const row = targetIndex[n] ?? null;
      const tvo = verseObjectsOf(row);
      if (!row || !tvo) {
        return { verse: n, row, hasTarget: false, unaligned: 0, sourceGaps: false, done: false, snippet: "" };
      }
      const start = row.verse;
      const end = row.verse_end ?? row.verse;
      const src =
        end > start ? concatSourceRange(sourceByStart, start, end) : (sourceByStart[start] ?? null);
      const st = parseAlignment(tvo, verseObjectsOf(src));
      const unaligned = st.unaligned.length;
      const sourceGaps = st.groups.some((g) => g.targets.length === 0);
      return {
        verse: n,
        row,
        hasTarget: true,
        unaligned,
        sourceGaps,
        done: unaligned === 0 && !sourceGaps,
        snippet: (row.plain_text ?? "").trim(),
      };
    });
  }, [data, lane, sourceLane, verseNums]);
  const alignedCount = verseRows.filter((r) => r.done).length;
  const totalVerses = verseNums.length;

  // ── shared chrome bits ────────────────────────────────────────────────────
  const sub = t("flowAlign.desk.sub", {
    book,
    chapter,
    source: sourceLane,
    target: laneLabel,
  });

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
      : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
    paddingBlock: 1.25,
    paddingInline: 2,
    textAlign: "start" as const,
  };

  // Segmented control in the sibling screens' language
  // (TranslateWordsScreen.tsx:1317-1345 segButton, sized for a header row).
  // `keyId` is a stable English/id token — the React key must never be the
  // translated label, or every button in these groups remounts on a language
  // switch. Callers that pass an untranslated code (the lane picker's ULT/UST
  // display labels) can let it fall back to `label`.
  const segButton = (
    active: boolean,
    label: string,
    onClick: () => void,
    opts?: { disabled?: boolean; title?: string; ariaLabel?: string; keyId?: string },
  ) => (
    <Button
      key={opts?.keyId ?? label}
      onClick={onClick}
      aria-pressed={active}
      aria-label={opts?.ariaLabel}
      disabled={opts?.disabled}
      title={opts?.title}
      sx={{
        flex: 1,
        height: 34,
        minHeight: 34,
        maxHeight: 34,
        borderRadius: "8px",
        fontWeight: 600,
        fontSize: "0.8rem",
        textTransform: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        color: active ? "text.primary" : "text.secondary",
        bgcolor: active ? "background.paper" : "transparent",
        boxShadow: active ? "0 1px 3px rgba(1,66,99,0.15)" : "none",
        "&:hover": { bgcolor: active ? "background.paper" : "transparent" },
      }}
    >
      {label}
    </Button>
  );

  const topbar = (
    <FlowHeader>
      <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: isTabletUp ? 2 : 1, paddingBlock: 1.5 }}>
        {/* Phone: tighter gaps and no "fully aligned" caption, so the row
            fits beside the account controls it now shares (#299). */}
        <Stack direction="row" alignItems="center" spacing={isTabletUp ? 1.25 : 0.5}>
          <IconButton
            aria-label={t("flowAlign.desk.backToPackage", { book })}
            onClick={() => {
              location.hash = `#/package/${book}`;
            }}
            sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
          >
            <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
          </IconButton>
          {/* Phone: the passage reference is the title and the screen name the
              caption, so the row keeps its orientation beside the account
              controls (#517). */}
          <Box sx={isTabletUp ? { minWidth: 0 } : PHONE_TITLE_SX}>
            <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
              {isTabletUp ? t("flowAlign.desk.title") : t("common.passageRef", { book, chapter })}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {isTabletUp ? sub : t("flowAlign.desk.title")}
            </Typography>
          </Box>
          {/* jump to the scripture screen for this chapter — the package
              back-chevron above only returns to the package hub, not
              scripture itself. Dropped on phones, where the row has no room
              for it; the package hub still reaches scripture (#517). */}
          {isTabletUp && (
            <Button
              size="small"
              startIcon={<MenuBookIcon fontSize="small" />}
              onClick={() => {
                location.hash = `#/scripture/${book}/${chapter}`;
              }}
              sx={{ flex: "none", minHeight: 34, textTransform: "none", fontWeight: 600 }}
            >
              {t("flowScripture.title")}
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          {/* compact prev/next flanking the count (top-and-bottom controls,
              Benjamin 2026-08-10) — same goVerse hash rewrite and disabled
              logic as the detail header's pair */}
          <IconButton
            aria-label={t("flowScripture.prevVerse")}
            onClick={() => goVerse(prevVerse)}
            disabled={prevVerse == null}
            sx={{ width: isTabletUp ? 34 : 30, height: isTabletUp ? 34 : 30, flex: "none" }}
          >
            <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
          </IconButton>
          <Box sx={{ textAlign: "end", ...(isTabletUp ? {} : { minWidth: 0, flexShrink: PHONE_COUNT_SX.flexShrink }) }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                ...(isTabletUp ? {} : PHONE_COUNT_SX),
              }}
            >
              {t("flowScripture.verseOfTotal", {
                n: verseIdx >= 0 ? verseIdx + 1 : "—",
                total: totalVerses || "—",
              })}
            </Typography>
            {isTabletUp && (
              <Typography
                variant="caption"
                color="text.secondary"
                component="p"
                sx={{ m: 0, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
              >
                {t("flowAlign.desk.fullyAligned", { n: alignedCount, total: totalVerses || 0 })}
              </Typography>
            )}
          </Box>
          <IconButton
            aria-label={t("flowScripture.nextVerse")}
            onClick={() => goVerse(nextVerse)}
            disabled={nextVerse == null}
            sx={{ width: isTabletUp ? 34 : 30, height: isTabletUp ? 34 : 30, flex: "none" }}
          >
            <ChevronRightIcon fontSize="small" sx={chevronFlip} />
          </IconButton>
        </Stack>
        {/* thin progress bar: fully-aligned verses over all verses — the
            honest signal (see file header); position alone would carry no
            completion semantics, and this does. */}
        <Box sx={{ height: 4, borderRadius: "2px", bgcolor: skip.soft, mt: 1.25, overflow: "hidden" }}>
          <Box
            sx={{
              height: "100%",
              borderRadius: "2px",
              bgcolor: INSPIRE,
              transition: "width 0.35s ease",
              width: totalVerses === 0 ? "0%" : `${(alignedCount / totalVerses) * 100}%`,
            }}
          />
        </Box>
      </Box>
    </FlowHeader>
  );

  // ── loading / error states (topbar chrome + sibling-style body) ──────────
  if (projectConfig === null || status === "idle" || status === "loading" || status === "retrying") {
    return (
      <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
        {topbar}
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 2 }}>
          <Skeleton variant="rounded" height={44} />
          <Skeleton variant="rounded" height={280} sx={{ mt: 2 }} />
        </Box>
      </Box>
    );
  }

  if (status === "error" || !data) {
    return (
      <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
        {topbar}
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 2 }}>
          <Alert severity="error">{t("flowAlign.screen.loadError", { book, chapter })}</Alert>
        </Box>
      </Box>
    );
  }

  // ── verse list (md+ pane) ─────────────────────────────────────────────────
  const chipForRow = (r: VerseRowStatus) => {
    if (!r.hasTarget) return <FlowStatusChip kind="skip" label={t("flowAlign.desk.notDrafted")} />;
    if (r.unaligned > 0)
      return (
        <FlowStatusChip kind="warn" label={t("aligner.unalignedCount", { count: r.unaligned })} />
      );
    if (r.sourceGaps) return <FlowStatusChip kind="warn" label={t("flowAlign.desk.sourceGaps")} />;
    return <FlowStatusChip kind="ok" label={t("flowAlign.desk.aligned")} />;
  };

  const listRow = (r: VerseRowStatus) => {
    const isCurrent = r.verse === verse;
    return (
      <Box
        key={r.verse}
        component="button"
        type="button"
        aria-current={isCurrent ? "true" : undefined}
        onClick={() => goVerse(r.verse)}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          width: "100%",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          ...(isCurrent ? { borderColor: INSPIRE, bgcolor: alpha(INSPIRE, dark ? 0.12 : 0.06) } : {}),
          "&:hover": { borderColor: INSPIRE },
        }}
      >
        <Typography
          sx={{ fontWeight: 700, fontSize: "0.9rem", fontVariantNumeric: "tabular-nums", flex: "none", minWidth: 26 }}
        >
          {r.verse}
        </Typography>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          {r.hasTarget ? (
            <Typography
              dir="auto"
              sx={{
                fontFamily: SCRIPTURE_FONT_STACK,
                fontSize: "0.88rem",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textAlign: "start",
              }}
            >
              {r.snippet || t("flowAlign.desk.empty")}
            </Typography>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic" }}>
              {t("flowAlign.desk.noLaneText", { lane: laneLabel })}
            </Typography>
          )}
          {r.row && (r.row.verse_end ?? r.row.verse) > r.row.verse && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {t("flowAlign.desk.partOfVerses", { range: formatVerseLabel(r.row) })}
            </Typography>
          )}
        </Box>
        {chipForRow(r)}
      </Box>
    );
  };

  // ── detail (the aligner, single mode; dual is the fullscreen dialog) ─────
  const noTarget = !targetVerse;
  const noSource = !sourceVerse;
  // The pending-replacement signal for the selected lane. ULT is the "lit"
  // lane, UST the "sim" lane in ProjectConfig.laneState (AlignScreen.tsx:650-655
  // reads lit; sync/api.ts:1549-1552 carries both).
  const targetLanePending = Boolean(
    projectConfig?.laneState?.[lane === LANE_LEFT ? "lit" : "sim"]?.pendingTarget,
  );

  const detailHeader = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        paddingBlock: 1.25,
        paddingInline: wide ? 2 : 0,
        ...(wide ? { borderBlockEnd: "1px solid", borderColor: "divider" } : {}),
      }}
    >
      <IconButton
        aria-label={t("flowScripture.prevVerse")}
        onClick={() => goVerse(prevVerse)}
        disabled={prevVerse == null}
        sx={{ width: 34, height: 34, flex: "none" }}
      >
        <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
      </IconButton>
      <Typography
        component="h2"
        sx={{ fontSize: "0.95rem", fontWeight: 700, m: 0, fontVariantNumeric: "tabular-nums" }}
      >
        {book} {chapter}:{targetVerse ? formatVerseLabel(targetVerse) : verse}
      </Typography>
      <IconButton
        aria-label={t("flowScripture.nextVerse")}
        onClick={() => goVerse(nextVerse)}
        disabled={nextVerse == null}
        sx={{ width: 34, height: 34, flex: "none" }}
      >
        <ChevronRightIcon fontSize="small" sx={chevronFlip} />
      </IconButton>
      <Box sx={{ flex: 1 }} />
      {/* lane picker — single mode aligns one lane at a time; dual always
          shows both, so the picker only drives single mode. Disabled while
          the current lane holds unsaved work (same protection as the
          drag/tap toggle, AlignScreen.tsx:699-729). */}
      <Stack
        direction="row"
        spacing={0.5}
        role="group"
        aria-label={t("flowAlign.desk.laneGroupAria")}
        sx={{ bgcolor: skip.soft, borderRadius: "10px", p: 0.5 }}
      >
        {([LANE_LEFT, LANE_RIGHT] as Lane[]).map((l) =>
          segButton(lane === l, versionLabel(projectConfig, l), () => setLane(l), {
            disabled: lane !== l && dirty,
            title:
              lane !== l && dirty ? t("flowAlign.desk.laneSwitchBlocked") : undefined,
            keyId: l,
          }),
        )}
      </Stack>
      {/* single/dual — mode lives in the route, so this rewrites the hash */}
      <Stack
        direction="row"
        spacing={0.5}
        role="group"
        aria-label={t("flowAlign.desk.viewGroupAria")}
        sx={{ bgcolor: skip.soft, borderRadius: "10px", p: 0.5 }}
      >
        {segButton(mode === "single", t("flowAlign.desk.single"), () => setRouteMode("single"), {
          keyId: "single",
        })}
        {segButton(mode === "dual", t("flowAlign.desk.dual"), () => setRouteMode("dual"), {
          disabled: !dualProps,
          title: dualProps
            ? t("flowAlign.desk.dualTitle", {
                left: versionLabel(projectConfig, LANE_LEFT),
                right: versionLabel(projectConfig, LANE_RIGHT),
              })
            : t("flowAlign.screen.noDualContent"),
          keyId: "dual",
        })}
      </Stack>
    </Box>
  );

  const detailBody = (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: wide ? "auto" : "visible",
        display: "flex",
        flexDirection: "column",
        gap: 1.5,
        paddingInline: wide ? 2 : 0,
        paddingBlockStart: wide ? 1.5 : 0,
        paddingBlockEnd: 2,
      }}
    >
      {lock && <LockBanner pipelineType={lock.pipelineType} startedAt={lock.startedAt} />}

      {mode === "dual" && !dualProps && (
        <Alert severity="info">{t("flowAlign.desk.nothingToCompare")}</Alert>
      )}

      {!canEdit && (
        <Alert severity="info">{t("flowAlign.screen.viewOnly")}</Alert>
      )}

      {noTarget || noSource ? (
        <Alert severity="info">
          {noTarget
            ? targetLanePending
              ? t("flowAlign.screen.lanePending", { lane: laneLabel })
              : t("flowAlign.screen.noTargetText", { lane: laneLabel, book, chapter, verse })
            : t("flowAlign.screen.noSourceText", { source: sourceLane, book, chapter, verse })}
        </Alert>
      ) : (
        <>
          {/* drag/tap toggle — hidden below 560, where drag isn't offered at
              all (form-factor policy; AlignScreen.tsx:699-739) */}
          {isTabletUp ? (
            <Box
              role="group"
              aria-label={t("flowAlign.screen.modeGroupAria")}
              sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}
            >
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ bgcolor: skip.soft, borderRadius: "10px", p: 0.5, overflow: "hidden" }}
              >
                {segButton(
                  interaction === "drag",
                  t("flowAlign.screen.dragCanvas"),
                  () => setInteractionChoice("drag"),
                  {
                    disabled: interaction !== "drag" && dirty,
                    title: t("flowAlign.desk.dragCanvasTitle"),
                    ariaLabel: t("flowAlign.desk.dragCanvasTitle"),
                    keyId: "drag",
                  },
                )}
                {segButton(
                  interaction === "tap",
                  t("flowAlign.desk.tapMode"),
                  () => setInteractionChoice("tap"),
                  {
                    disabled: interaction !== "tap" && dirty,
                    title: t("flowAlign.desk.tapModeTitle"),
                    ariaLabel: t("flowAlign.desk.tapModeTitle"),
                    keyId: "tap",
                  },
                )}
              </Stack>
              {dirty && (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {t("flowAlign.screen.switchBlocked")}
                </Typography>
              )}
            </Box>
          ) : (
            <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
              {t("flowAlign.screen.dragNeedsLarger")}
            </Typography>
          )}

          {/* ── the aligner (reused, never rebuilt) ─────────────────────── */}
          {interaction === "drag" ? (
            <Box
              sx={{
                minHeight: 420,
                display: "flex",
                flexDirection: "column",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              <AlignmentPanel
                // Fresh mount per lane+verse so the panel's state is seeded
                // synchronously for the right target (the stale-state race
                // AlignScreen.tsx:824-827 keys against, plus the lane axis).
                key={`${lane}:${chapter}:${verse}`}
                ref={panelRef}
                book={book}
                chapter={chapter}
                verseNum={verse}
                bibleVersion={lane}
                verse={targetVerse}
                sourceVerse={sourceVerse}
                sourceLabel={sourceLane}
                twlForVerse={twlForVerse}
                onSave={handlePanelSave}
                onConfirmUnalign={confirmUnalignFor(targetVerse, lane)}
                onCancel={() => setInteractionChoice("tap")}
                hideCancel
                onDirtyChange={setDragDirty}
                onOpenDual={dualProps ? () => setRouteMode("dual") : undefined}
              />
            </Box>
          ) : tapState ? (
            <Box
              sx={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "12px",
                // Sticky save bar below binds to THIS box only when it's the
                // nearest scroll container, which is true on wide (height-
                // constrained desk pane) but not on phone: there the column
                // is unconstrained-height, this box never scrolls, and
                // overflowY:auto would silently degrade sticky to static —
                // stranding Save at the page bottom on a long verse. Phone
                // instead leaves scrolling to the page column so sticky
                // rebinds to the viewport (Benjamin/design review 2026-08-15).
                ...(wide
                  ? { minHeight: 420, overflowY: "auto" }
                  : { overflowY: "visible" }),
              }}
            >
              <AlignTapView
                // Fresh mount per lane+verse: the view's own local state
                // (selection, skipped ghosts) must not carry across a target
                // change (AlignScreen.tsx:847-853).
                key={`tap:${lane}:${chapter}:${verse}`}
                state={tapState}
                onChange={(next) => {
                  tapEditKeyRef.current = draftKey;
                  setTapState(next);
                }}
                canEdit={canEdit}
                sourceIndexMap={sourceIndexMap}
                sourceRtl={sourceRtl}
                targetRtl={targetRtl}
                ghosts={ghosts}
                onDismissGhost={handleDismissGhost}
              />
              {/* tap save bar — sticky at the pane/column bottom, the sibling
                  screens' action-bar convention (TranslateWordsScreen.tsx:
                  1718-1741 pane variant) */}
              <Box
                sx={{
                  position: "sticky",
                  insetBlockEnd: 0,
                  zIndex: 5,
                  marginBlockStart: "auto",
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                  display: "flex",
                  gap: 1,
                  alignItems: "center",
                  flexWrap: "wrap",
                  paddingBlock: 1,
                }}
              >
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {tapDirty
                    ? t("flowAlign.screen.unsavedOne")
                    : t("flowAlign.screen.noUnsaved")}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Button onClick={handleTapReset} disabled={!tapDirty} sx={{ minHeight: 44 }}>
                  {t("aligner.reset")}
                </Button>
                <Button
                  variant="contained"
                  onClick={handleTapSave}
                  disabled={!tapDirty || !canEdit}
                  sx={{ minHeight: 44, fontWeight: 700 }}
                >
                  {t("flowAlign.screen.saveAlignment")}
                </Button>
              </Box>
            </Box>
          ) : (
            <Alert severity="info">
              {t("flowAlign.screen.noParsable", { lane: laneLabel })}
            </Alert>
          )}
        </>
      )}
    </Box>
  );

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        textAlign: "start",
        ...(wide
          ? { display: "flex", flexDirection: "column", overflow: "hidden" }
          : { overflowY: "auto" }),
      }}
    >
      {topbar}

      {wide ? (
        /* desk (docs/mockups/desktop-first/_design.css .desk/.rail/.panel via
           TranslateWordsScreen.tsx:857-930): 1440px centred grid — verse-list
           pane inline-start, panel-chromed detail pane filling the rest. Grid
           column order follows the document direction, so RTL-safe as-is. */
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            maxWidth: 1440,
            mx: "auto",
            display: "grid",
            gridTemplateColumns: "minmax(340px, 380px) minmax(0, 1fr)",
            gap: 2.5,
            paddingInline: 2,
            paddingBlockStart: 1.5,
            paddingBlockEnd: 2,
          }}
        >
          {/* verse-list pane */}
          <Box
            sx={{
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              paddingInline: 0.25,
              paddingBlockEnd: 2,
            }}
          >
            {verseRows.map(listRow)}
          </Box>
          {/* detail pane */}
          <Box
            sx={{
              minHeight: 0,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: "14px",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {detailHeader}
            {detailBody}
          </Box>
        </Box>
      ) : (
        /* phone/tablet: one centred column; Prev/Next lives in the detail
           header (notes-screen queue pattern) AND in a bottom row, so both a
           top and a bottom affordance exist on phone (Benjamin 2026-08-10;
           TranslateScriptureScreen's phone footer pattern) */
        <Box
          sx={{
            maxWidth: COLUMN_PX,
            mx: "auto",
            paddingInline: 2,
            paddingBlockStart: 0.5,
            paddingBlockEnd: 4,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {detailHeader}
          {detailBody}
          <Stack direction="row" justifyContent="space-between" spacing={1.25}>
            <Button
              startIcon={<ChevronLeftIcon sx={chevronFlip} />}
              disabled={prevVerse == null}
              onClick={() => goVerse(prevVerse)}
              sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
            >
              {t("flowScripture.previous")}
            </Button>
            <Button
              endIcon={<ChevronRightIcon sx={chevronFlip} />}
              disabled={nextVerse == null}
              onClick={() => goVerse(nextVerse)}
              sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
            >
              {t("flowScripture.next")}
            </Button>
          </Stack>
        </Box>
      )}

      {/* dual mode — the real dual aligner, fullscreen by construction. The
          single layout above stays mounted beneath it, so closing lands back
          on a warm screen. */}
      {mode === "dual" && dualProps && (
        <SideBySideAligner
          open
          onClose={requestCloseDual}
          book={book}
          chapter={chapter}
          verseNum={verse}
          vref={dualProps.vref}
          sourceLabel={sourceLane}
          sourceVerse={dualProps.sourceVerse}
          twlForVerse={dualProps.twlForVerse}
          lexiconMap={lexiconMap}
          left={dualProps.left}
          right={dualProps.right}
          onSaveReading={handleSaveReading}
          onPrevVerse={prevVerse != null ? () => dualNavTo(prevVerse) : undefined}
          onNextVerse={nextVerse != null ? () => dualNavTo(nextVerse) : undefined}
        />
      )}

      {/* save-or-discard gate for the dual aligner (AlignScreen.tsx:912-935) */}
      <Dialog open={pendingDualAction !== null} onClose={() => setPendingDualAction(null)}>
        <DialogTitle>{t("shell.unsavedChanges")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("flowAlign.screen.dualUnsavedBody")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDualAction(null)} sx={{ minHeight: 44 }}>
            {t("common.cancel")}
          </Button>
          <Button color="error" onClick={() => resolveDualAction("discard")} sx={{ minHeight: 44 }}>
            {t("shell.discard")}
          </Button>
          <Button variant="contained" onClick={() => resolveDualAction("save")} sx={{ minHeight: 44 }}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* unalign confirm — the same gate Shell puts in front of the aligner
          (AlignScreen.tsx:937-965) */}
      <Dialog open={pendingLoss !== null} onClose={() => setPendingLoss(null)}>
        <DialogTitle>{t("flowAlign.screen.lossTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {t("flowAlign.screen.lossBody", {
              ref: pendingLoss?.ref ?? "",
              count: pendingLoss?.lostWords.length ?? 0,
            })}
            <Box component="p" sx={{ fontWeight: 700, marginBlockStart: 1 }}>
              {pendingLoss?.lostWords.slice(0, 12).join(", ")}
              {(pendingLoss?.lostWords.length ?? 0) > 12 ? " …" : ""}
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingLoss(null)} sx={{ minHeight: 44 }}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              pendingLoss?.commit();
              setPendingLoss(null);
            }}
            sx={{ minHeight: 44 }}
          >
            {t("flowScripture.saveAnyway")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        message={notice ? t(notice) : ""}
      />
    </Box>
  );
}
