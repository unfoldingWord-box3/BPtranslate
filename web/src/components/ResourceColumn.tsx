import { Fragment, type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, Stack, Typography } from "@mui/material";
import { api, isReadOnly, type TnRow, type TqRow, type TwlRow, type VerseDto, type TwlSuggestion } from "../sync/api";
import { NoteCard, type DropPosition } from "./NoteCard";
import { type WordDropPosition } from "./WordsTable";
import { WordsPanelBody } from "./WordsPanel";
import { QuestionsPanelBody } from "./QuestionsPanel";
import { AlignmentPanel, type AlignmentPanelHandle } from "./AlignmentPanel";
import { noteOverlapsRange } from "../lib/verseRange";
import { resolveSourceRef } from "../lib/sourceRef";
import { canonicalTwlOrder } from "../lib/twlCanonicalOrder";
import { liveRowCount, reviewStats } from "../lib/reviewApproval";
import { NotesPanelBody } from "./NotesPanel";
import { useProjectConfig, isTranslationProject } from "../hooks/useProjectConfig";
import { useSourceNotes } from "../hooks/useSourceNotes";
import { useSourceQuestions } from "../hooks/useSourceQuestions";
import {
  DropIndicator,
  sortBySortOrder,
  groupByVerse,
  type PinKey,
  type ResourceCheckoff,
} from "./resourcePanelShared";
import { SEARCH_IFRAME_URL } from "./SearchPanel";

export type PanelMode = "resources" | "alignment" | "search";

export type { ResourceLane, ResourceCheckoff } from "./resourcePanelShared";

// Candidate slot for the reorder "stoplight" — the moved note plus the note
// ids that would become its predecessor / successor at the current drag target
// (or after an arrow move). Shell resolves these ids to quotes and lights the
// active verse green (prev) / red (next). null prev/next means "no neighbour on
// that side" (moved note is first / last in its verse).
export interface ReorderPreview {
  verse: number;
  movedId: string;
  prevId: string | null;
  nextId: string | null;
}

export interface AlignmentTabProps {
  book: string;
  chapter: number;
  verseNum: number;
  bibleVersion: string;
  verse: VerseDto | null;
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  twlForVerse: TwlRow[];
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  // Confirm-before-save when the edit would unalign a previously aligned word
  // (forwarded to AlignmentPanel; see its onConfirmUnalign prop).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  panelRef?: Ref<AlignmentPanelHandle>;
  onOpenDual?: () => void;
  // Restore a previously-saved verse version from the panel's history button.
  onRestoreVersion?: (content: unknown, plainText: string | null) => void;
}

export type ResourceColumnProps = Props;

interface Props {
  // Active location — needed by the per-verse TWL suggestions fetch.
  book: string;
  chapter: number;
  activeVerse: number;
  // Inclusive [start, end] of verses to surface in TN/TQ/TWL panels. Equals
  // [activeVerse, activeVerse] for the common singleton case; widens to the
  // span of any multi-verse row (e.g. UST 6-9) that covers activeVerse so
  // notes/words for verses 6,7,8,9 all show when the user navigates to v=7.
  displayVerseRange: readonly [number, number];
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  activeNoteId: string | null;
  activeWordId: string | null;
  // Find-in-notes highlight: query marks every match in each note body; the
  // active match (by note id + occurrence index) is emphasized + scrolled to.
  findNoteQuery?: { find: string; regex: boolean; caseSensitive: boolean } | null;
  activeNoteMatch?: { noteId: string; occurrence: number } | null;
  // Bumped by Shell's "go to active" button so the resource column can
  // recentre on the active note / word / verse group alongside the
  // scripture column.
  scrollNonce: number;
  onNoteChange: (id: string, patch: Partial<TnRow>) => void;
  onNoteSave: (
    id: string,
    patch: Partial<TnRow>,
    opts?: { restoredFromVersion?: number },
  ) => void;
  // Resolves false when the trash request failed — NoteCard keeps the user's
  // unsaved text in that case (see NoteCard.handleDelete).
  onNoteDelete: (id: string) => void | Promise<boolean | void>;
  onNoteRestore: (id: string) => void;
  onNoteInsertAfter: (refId: string) => void;
  onNoteReorder: (draggedId: string, refId: string, position: DropPosition) => void;
  // Verse numbers in the loaded chapter, offered in each note's reference
  // picker; onNoteChangeVerse retargets a note to a different verse.
  verseOptions: number[];
  onNoteChangeVerse: (id: string, verse: number, verseEnd?: number) => void;
  // Report the moved note's candidate neighbours so Shell can paint the
  // active-verse stoplight. Fired live as a drag hovers each slot (sticky =
  // false; cleared on drop), and once after an arrow move (sticky = true,
  // auto-clears in Shell after ~3s). null clears the preview.
  onReorderPreview?: (preview: ReorderPreview | null, sticky?: boolean) => void;
  onNoteFocus: (row: TnRow) => void;
  onNoteCreate: () => void;
  // Async AI-draft wiring. All optional — when absent, sparkles hides.
  // start fires the request (returns immediately); the result lands
  // later via the row patch pipeline. The two read-only accessors let
  // each NoteCard show its spinner / pulse independently. Visibility
  // bubbles up to Shell so it can route completions to either the
  // in-place pulse or the off-screen toast stack.
  onNoteStartAi?: (
    row: TnRow,
    live: { quote: string; note: string; support_reference: string | null },
  ) => void;
  isNoteAiPending?: (rowId: string) => boolean;
  noteAiRecentlyCompletedAt?: (rowId: string) => number | null;
  onNoteVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  onWordSave: (id: string, patch: Partial<TwlRow>) => void;
  onWordDelete: (id: string) => void;
  onWordCreate: () => void;
  onWordFocus: (row: TwlRow) => void;
  onWordReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  onQuestionSave: (id: string, patch: Partial<TqRow>) => void;
  onQuestionDelete: (id: string) => void;
  onQuestionCreate: () => void;
  // Chapter is locked for editing because an AI pipeline is mid-flight.
  // Hides "new" buttons, propagates read-only to children.
  locked?: boolean;
  // Toggle the TN's preserve bit ("survive future AI pipeline sweeps").
  // Threaded through to NoteCard. Always available, regardless of lock.
  onSetNotePreserve?: (id: string, value: boolean) => void;
  // Toggle the TN's hint bit ("queue as AI-pipeline directive"). Threaded
  // through to NoteCard.
  onSetNoteHint?: (id: string, value: boolean) => void;
  // ── Translation mode (gateway-language projects) ── Approve/un-approve a
  // draft (validate value 1/0) and single-note Translate. Absent in the English
  // root project.
  onNoteApprove?: (id: string, value: boolean) => void;
  // Sequential batch approve for every approvable tN row in the chapter (see
  // isApprovableRow), with end-of-batch failure reporting — see
  // Shell.tsx's handleApproveAllNotes.
  onApproveAllNotes?: () => Promise<void> | void;
  onNoteTranslate?: (id: string) => void;
  // Rows with an in-flight single-note / chapter translate run (spinner).
  translatingNoteIds?: Set<string>;
  // ── Translation mode, tQ analogues ── Approve/un-approve + single-question
  // Translate for translationQuestions. Absent in the English root project.
  onQuestionApprove?: (id: string, value: boolean) => void;
  // tQ analogue of onApproveAllNotes.
  onApproveAllQuestions?: () => Promise<void> | void;
  onQuestionTranslate?: (id: string) => void;
  translatingQuestionIds?: Set<string>;
  // Translate English in a note's quote field to source-language text using
  // ULT alignment. Returns null when no alignment match is found.
  onNoteTranslateQuote?: (row: TnRow, english: string) => string | null;
  // Same translate flow but for the TWL quote (orig_words) column.
  onWordTranslateQuote?: (row: TwlRow, english: string) => string | null;
  // Read-only English (ULT) gloss for a TWL row's saved orig_words (alignment-
  // derived). Shell owns the verse objects, so it computes the gloss.
  onWordGloss?: (row: TwlRow) => string;
  // Quote-builder session. Shell owns the selection state + the picker
  // popup; the note cards / word rows just surface a button that opens it.
  quoteBuildActiveNoteId?: string | null;
  // Same session, but when the active target is a TWL word row instead of a note.
  quoteBuildActiveWordId?: string | null;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: (noteId: string) => void;
  // Open the quote-builder for a TWL word row (writes orig_words + occurrence).
  onStartWordQuoteBuild?: (wordId: string) => void;
  // Promote a per-verse TWL suggestion to a real link (resolve + createRow). When
  // absent, the Suggestions section hides.
  onAddTwlSuggestion?: (suggestion: TwlSuggestion, chosenArticleId: string) => void;
  // Drop suggestions already linked on the active verse (resolved-OL identity).
  isTwlSuggestionExcluded?: (suggestion: TwlSuggestion) => boolean;
  // ULT verse objects for a given verse (current chapter), used to order TWL
  // links canonically by Hebrew/Greek word position. Stable identity (useCallback
  // in Shell keyed on the verse index) so the twl memos recompute only when the
  // ULT alignment changes, not on every render. Null when unavailable → order
  // falls back to sort_order.
  ultVerseObjectsFor?: (verse: number) => unknown[] | null;
  // Hover a Words row's "locate" spot → preview where its word is highlighted in
  // the scripture (pass the row id; null on leave). No click / verse jump.
  onWordHoverPreview?: (id: string | null) => void;
  // Report the raw (pre-exclusion) suggestion list up to Shell so it can merge
  // the matcher's candidates onto committed rows (twlRowAlternatives).
  onTwlSuggestions?: (suggestions: TwlSuggestion[]) => void;
  // Extra TW article ids the matcher proposes for a committed row's source word,
  // keyed by row id — merged into that row's disambiguation badge.
  twlRowAlternatives?: Map<string, string[]>;
  // Article ids the unlinked deny-list blocks for a suggestion's resolved quote
  // — pruned from its picker; the whole suggestion hides when all are blocked.
  twlBlockedArticleIds?: (suggestion: TwlSuggestion, candidateIds?: string[]) => Set<string>;
  // Whether the TWL deny-lists have settled (loaded or failed). Suggestions hold
  // off rendering until then so a blocked link can't show before filters arrive.
  twlFiltersReady?: boolean;
  // Per-note commit signal — its nonce bumps when a quote-build commits for
  // that note, telling the matching card to land the built quote in the box.
  quoteBuildAppliedTo?: { noteId: string; nonce: number } | null;
  // Tab + alignment-panel wiring. When mode === "alignment", the Resources
  // column body swaps to the AlignmentPanel; the Notes/Words/Questions tabs
  // stay in the strip but their click acts as a scroll-to in resources mode.
  panelMode?: PanelMode;
  onSetPanelMode?: (mode: PanelMode) => void;
  alignmentProps?: AlignmentTabProps;
  alignmentBadge?: string;
  // Per-resource checkoff for the active verse (in-context "done" + bulk).
  checkoff?: ResourceCheckoff;
  // Flexible-layout support (Phase 3). When set, only these resource tabs
  // render (notes/words/questions) and the active tab is clamped into the set;
  // `initialTab` seeds the first shown tab. Omitting BOTH is byte-identical to
  // the classic all-tabs column. Alignment/Search tabs are orthogonal
  // (panelMode) and unaffected.
  visibleTabs?: ResourceTab[];
  initialTab?: ResourceTab;
  // Switch to `tab` after mount, once per new `nonce` (#535): a ?twl= link
  // reached while the column is already open must show Words. The value
  // present at mount is ignored (initialTab covers mount), and so is a tab
  // this layout doesn't show.
  requestTab?: { tab: ResourceTab; nonce: number } | null;
}

type Pinned = Record<PinKey, boolean>;
export type ResourceTab = "notes" | "words" | "questions";

const PINNED_KEY = "be:pinned";

// Drag auto-scroll: begin scrolling when the pointer is within this many px of
// the list's top/bottom edge, advancing this many px per animation frame.
const DRAG_SCROLL_EDGE_PX = 56;
const DRAG_SCROLL_SPEED_PX = 12;

function loadPinned(): Pinned {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Pinned>;
      return {
        notes: !!parsed.notes,
        words: !!parsed.words,
        questions: !!parsed.questions,
      };
    }
  } catch {
    /* ignore */
  }
  return { notes: false, words: false, questions: false };
}

function savePinned(p: Pinned) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function ResourceColumn({
  book,
  chapter,
  activeVerse,
  displayVerseRange,
  tn,
  tq,
  twl,
  activeNoteId,
  activeWordId,
  findNoteQuery,
  activeNoteMatch,
  scrollNonce,
  onNoteChange,
  onNoteSave,
  onNoteDelete,
  onNoteRestore,
  onNoteInsertAfter,
  onNoteReorder,
  verseOptions,
  onNoteChangeVerse,
  onReorderPreview,
  onNoteFocus,
  onNoteCreate,
  onNoteStartAi,
  isNoteAiPending,
  noteAiRecentlyCompletedAt,
  onNoteVisibilityChange,
  onWordSave,
  onWordDelete,
  onWordCreate,
  onWordFocus,
  onWordReorder,
  onQuestionSave,
  onQuestionDelete,
  onQuestionCreate,
  locked = false,
  onSetNotePreserve,
  onSetNoteHint,
  onNoteApprove,
  onApproveAllNotes,
  onNoteTranslate,
  translatingNoteIds,
  onQuestionApprove,
  onApproveAllQuestions,
  onQuestionTranslate,
  translatingQuestionIds,
  onNoteTranslateQuote,
  onWordTranslateQuote,
  onWordGloss,
  quoteBuildActiveNoteId,
  quoteBuildActiveWordId,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  onStartWordQuoteBuild,
  onAddTwlSuggestion,
  isTwlSuggestionExcluded,
  ultVerseObjectsFor,
  onWordHoverPreview,
  onTwlSuggestions,
  twlRowAlternatives,
  twlBlockedArticleIds,
  twlFiltersReady,
  quoteBuildAppliedTo,
  panelMode = "resources",
  onSetPanelMode,
  alignmentProps,
  alignmentBadge,
  checkoff,
  visibleTabs,
  initialTab,
  requestTab,
}: Props) {
  const { t } = useTranslation();
  // Translation mode: only gateway-language projects (translationSource != null)
  // show state-based cards, the source pane, and Approve/Translate affordances.
  // The English root project sees the unchanged card.
  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  // translationSource.repos is PARTIAL and PER-RESOURCE: a resource left blank in
  // Setup has no upstream source, and a resource may point at a DIFFERENT org.
  // resolveSourceRef returns { org, repo } | null; null (no tN source) makes
  // useSourceNotes short-circuit (no `${org}/undefined/...` fetch) and the source
  // block cleanly omit — distinct from a genuine 404. Null here means "no tN
  // source configured", NOT "not a translation project" (translationMode stays true).
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tn"),
    [projectConfig],
  );
  // Published source-language tN for this book, indexed by row id (matched
  // byte-identically to each draft). Empty in the English root project.
  const sourceNotes = useSourceNotes(translationMode ? book : null, sourceProjection);
  // Chapter-scoped translation progress. `examples` (validated count) doubles
  // as the language-memory chip's example count — the honest, in-view figure
  // until the context-repo feedback loop lands a global tally. Terms are not
  // tracked yet (stub 0). Draft ids feed "Approve all". The counting rule lives
  // once in reviewStats (web/src/lib/reviewApproval.ts) — see #238; this file
  // and StackedResourcePanel used to carry byte-identical copies of it.
  const tnStats = useMemo(
    () => reviewStats(translationMode ? tn : []),
    [tn, translationMode],
  );
  // Live terminology count for the language-memory chip (was hard-coded 0).
  // Cheap COUNT endpoint; best-effort — a failure leaves it at 0. The route is
  // editor-only server-side, so skip it for viewers — they'd only get a 403.
  const [termsCount, setTermsCount] = useState(0);
  useEffect(() => {
    if (!translationMode || isReadOnly()) return;
    let cancelled = false;
    api
      .getTermsCount()
      .then((res) => {
        if (!cancelled) setTermsCount(res.count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [translationMode, book]);
  // tQ analogues of the source projection + stats above.
  // Same partial/per-resource guard as sourceProjection above (tQ): null when the
  // tQ source repo is absent → no undefined fetch, source block cleanly omitted.
  const sourceQuestionProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tq"),
    [projectConfig],
  );
  const sourceQuestions = useSourceQuestions(translationMode ? book : null, sourceQuestionProjection);
  // Same helper: tQ has no trashed_at column, so its trashed arm is inert here.
  const tqStats = useMemo(
    () => reviewStats(translationMode ? tq : []),
    [tq, translationMode],
  );
  const [pinned, setPinned] = useState<Pinned>(() => loadPinned());
  const togglePinned = (k: PinKey) => {
    const next = { ...pinned, [k]: !pinned[k] };
    setPinned(next);
    savePinned(next);
  };

  // Which resource the body shows when panelMode === "resources". Splitting
  // Notes / Words / Questions into separate views keeps the Notes column free
  // of TWL/TQ clutter; the tabs now switch the view instead of scroll-jumping
  // within one stacked body.
  const [resourceTab, setResourceTab] = useState<ResourceTab>(() => {
    const vt = visibleTabs && visibleTabs.length > 0 ? visibleTabs : (["notes", "words", "questions"] as ResourceTab[]);
    return initialTab && vt.includes(initialTab) ? initialTab : vt[0];
  });
  // The resource tabs this layout exposes (classic = all three). Clamp the
  // active tab into the set so a stale/last selection outside this layout
  // (e.g. after a layout switch) falls back to the first visible tab.
  const tabs: ResourceTab[] =
    visibleTabs && visibleTabs.length > 0 ? visibleTabs : ["notes", "words", "questions"];
  const activeResourceTab: ResourceTab = tabs.includes(resourceTab) ? resourceTab : tabs[0];
  const showResource = (tab: ResourceTab) => {
    if (panelMode !== "resources") onSetPanelMode?.("resources");
    setResourceTab(tab);
  };
  const seenTabRequest = useRef(requestTab?.nonce);
  useEffect(() => {
    if (!requestTab || requestTab.nonce === seenTabRequest.current) return;
    seenTabRequest.current = requestTab.nonce;
    if (tabs.includes(requestTab.tab)) setResourceTab(requestTab.tab);
  }, [requestTab?.nonce]);

  // Lazily mount the Search iframe on first visit, then keep it alive (the body
  // toggles its visibility rather than unmounting). Avoids loading the external
  // tool on every page load for users who never open the tab.
  const [searchVisited, setSearchVisited] = useState(false);
  useEffect(() => {
    if (panelMode === "search") setSearchVisited(true);
  }, [panelMode]);

  const [rangeStart, rangeEnd] = displayVerseRange;
  // When a UST verse bridge widens the range to span multiple verses (e.g. ISA
  // 33:15-16, UST row verse=15/verse_end=16 while UHB/ULT keep them separate),
  // the union must render grouped by verse — all of v15 then all of v16 — not
  // interleaved by sort_order. Each verse numbers sort_order from 100
  // independently, so a flat sort scrambles them (v15@100, v16@100, v15@200…).
  // groupByVerse orders the buckets by verse ascending; within a verse each
  // resource sorts by sort_order (the per-verse ordinal assigned in TSV file
  // order at import). Singletons (the common case) reduce to the prior behavior.
  // Notes/questions filter on their ref_raw span (noteOverlapsRange), not just
  // the leading `verse`, so a bridged note ("1:2-3") shows on every verse it
  // covers — not only its leading verse. Singletons reduce to the old test.
  const tnForVerse = useMemo(
    () =>
      groupByVerse(tn.filter((r) => noteOverlapsRange(r, rangeStart, rangeEnd))).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tn, rangeStart, rangeEnd],
  );
  const tqForVerse = useMemo(
    () =>
      groupByVerse(tq.filter((r) => noteOverlapsRange(r, rangeStart, rangeEnd))).flatMap(
        ([, rows]) => sortBySortOrder(rows),
      ),
    [tq, rangeStart, rangeEnd],
  );
  // TWL links are ordered CANONICALLY — by the position of the Hebrew/Greek word
  // in the aligned ULT verse — not by stored sort_order. This is the same
  // ordering the nightly export + reimport compute (twlCanonicalOrder mirrors the
  // server), so the live UX always matches what lands in DCS. sort_order is only
  // the fallback for links whose word isn't found in the ULT alignment.
  const twlForVerse = useMemo(
    () =>
      groupByVerse(twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd)).flatMap(
        ([v, rows]) => canonicalTwlOrder(rows, ultVerseObjectsFor?.(v) ?? null),
      ),
    [twl, rangeStart, rangeEnd, ultVerseObjectsFor],
  );

  // Pinned sections show the whole chapter, grouped by verse. Within each
  // verse the row order matches the unpinned view.
  const tnGroups = useMemo(
    () =>
      pinned.notes
        ? groupByVerse(tn).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TnRow[]])
        : null,
    [pinned.notes, tn],
  );
  const tqGroups = useMemo(
    () =>
      pinned.questions
        ? groupByVerse(tq).map(([v, rows]) => [v, sortBySortOrder(rows)] as [number, TqRow[]])
        : null,
    [pinned.questions, tq],
  );
  const twlGroups = useMemo(
    () =>
      pinned.words
        ? groupByVerse(twl).map(
            ([v, rows]) =>
              [v, canonicalTwlOrder(rows, ultVerseObjectsFor?.(v) ?? null)] as [number, TwlRow[]],
          )
        : null,
    [pinned.words, twl, ultVerseObjectsFor],
  );

  // Badge denominators. These count LIVE rows only — a trashed note is still
  // rendered (grayed out, at the bottom of its verse, with Restore), but it no
  // longer inflates the number beside the tab, which is what made classic read
  // "Notes 153" next to a "4 / 152" meter and a 152 package hub (#238). The
  // trashed tail is surfaced as a "· N trashed" label instead of vanishing.
  const tnCount = useMemo(
    () => liveRowCount(pinned.notes ? tn : tnForVerse),
    [pinned.notes, tn, tnForVerse],
  );
  const tqCount = useMemo(
    () => liveRowCount(pinned.questions ? tq : tqForVerse),
    [pinned.questions, tq, tqForVerse],
  );
  const totalTn = tnCount.live;
  const totalTwl = pinned.words ? twl.length : twlForVerse.length;
  const totalTq = tqCount.live;

  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: DropPosition } | null
  >(null);

  // Arrow-reorder focus + visible hint (mirrors WordsTable). React preserves
  // the moved card's keyed DOM node, so focus already rides along and Enter/
  // Space repeats the move — but a mouse click shows no focus ring, so we
  // re-assert focus on the moved note's arrow and flash a ring to make that
  // discoverable. tnRowsRef/scrollBodyRef are the query root.
  const noteFocusRef = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  const [recentNoteMove, setRecentNoteMove] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const noteFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const pending = noteFocusRef.current;
    if (!pending) return;
    noteFocusRef.current = null;
    const root = scrollBodyRef.current;
    if (!root) return;
    const find = (d: "up" | "down") =>
      root.querySelector<HTMLButtonElement>(
        `[data-note-id="${pending.id}"] [data-reorder-arrow="${d}"]`,
      );
    const btn = find(pending.dir);
    // Reached the top/bottom: the arrow we were moving with is now disabled.
    // Don't hop focus to the opposite arrow — that turns repeated Space into an
    // endless up-to-top-then-down-to-bottom loop. Drop focus instead so the run
    // simply stops at the edge.
    if (!btn || btn.disabled) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    btn.focus();
    setRecentNoteMove({ id: pending.id, dir: pending.dir });
    if (noteFlashTimer.current) clearTimeout(noteFlashTimer.current);
    noteFlashTimer.current = setTimeout(() => setRecentNoteMove(null), 1600);
  });
  useEffect(() => () => { if (noteFlashTimer.current) clearTimeout(noteFlashTimer.current); }, []);

  // Resolve the moved note's candidate neighbours at a given drop target —
  // shared by the live drag hover and the arrow moves. Scoped to the moved
  // note's verse, excluding the moved note and any trashed notes (the same
  // per-verse, non-trashed ordering the reorder itself renumbers).
  const computeNeighbors = useCallback(
    (movedId: string, targetId: string, position: DropPosition): ReorderPreview | null => {
      const moved = tn.find((r) => r.id === movedId);
      if (!moved) return null;
      const list = sortBySortOrder(
        tn.filter((r) => r.verse === moved.verse && r.trashed_at == null && r.id !== movedId),
      );
      const ti = list.findIndex((r) => r.id === targetId);
      const insertion = ti < 0 ? list.length : position === "before" ? ti : ti + 1;
      return {
        verse: moved.verse,
        movedId,
        prevId: list[insertion - 1]?.id ?? null,
        nextId: list[insertion]?.id ?? null,
      };
    },
    [tn],
  );

  // Live drag preview: as the dragged card hovers each slot, report the
  // neighbours it would land between. dragOver only changes ref when the slot
  // actually changes (see onCardDragOver), so this fires once per slot. The
  // preview is cleared on dragend (onDragEnd below), not here — returning early
  // when the drag stops avoids wiping a sticky arrow-move preview.
  useEffect(() => {
    if (!onReorderPreview || !dragId || !dragOver) return;
    const preview = computeNeighbors(dragId, dragOver.targetId, dragOver.position);
    if (preview) onReorderPreview(preview, false);
  }, [dragId, dragOver, computeNeighbors, onReorderPreview]);

  const scrollBodyRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the list while a reorder drag hovers near its top/bottom edge.
  // Native HTML5 DnD only auto-scrolls the window, never a nested overflow
  // container, so without this a note/word can't be dropped onto a card that
  // started scrolled out of view. Direction lives in a ref the rAF loop reads;
  // a drag can end on a card, outside the list, or via Esc, but the global
  // `dragend` always fires, so it's the reliable place to kill the loop.
  const autoScrollRaf = useRef<number | null>(null);
  const autoScrollDir = useRef(0);
  useEffect(() => {
    const stop = () => {
      if (autoScrollRaf.current != null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
      autoScrollDir.current = 0;
    };
    window.addEventListener("dragend", stop);
    return () => {
      window.removeEventListener("dragend", stop);
      stop();
    };
  }, []);
  const handleDragAutoScroll = (e: React.DragEvent) => {
    const el = scrollBodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    autoScrollDir.current =
      e.clientY < rect.top + DRAG_SCROLL_EDGE_PX
        ? -1
        : e.clientY > rect.bottom - DRAG_SCROLL_EDGE_PX
          ? 1
          : 0;
    if (autoScrollDir.current !== 0 && autoScrollRaf.current == null) {
      const step = () => {
        const node = scrollBodyRef.current;
        if (!node || autoScrollDir.current === 0) {
          autoScrollRaf.current = null;
          return;
        }
        node.scrollTop += autoScrollDir.current * DRAG_SCROLL_SPEED_PX;
        autoScrollRaf.current = requestAnimationFrame(step);
      };
      autoScrollRaf.current = requestAnimationFrame(step);
    }
  };

  // Keep the resource column lined up with the active selection. We fire on:
  //   - scrollNonce (Shell's "go to active" button)
  //   - activeNoteId / activeWordId (focus shifts that came from elsewhere)
  //   - activeVerse (timeline click, especially relevant when a section is
  //     pinned and the user wants to jump into that verse's group)
  //   - pinned.* (pin toggles, so the user lands on the same conceptual
  //     spot they were viewing before the layout reshuffled)
  // Priority: active note > active word > active-verse group in any pinned
  // section. Without any of those, no scroll.
  const prevNonceRef = useRef(scrollNonce);
  const prevVerseRef = useRef(activeVerse);
  const prevPinnedRef = useRef(pinned);
  useEffect(() => {
    const root = scrollBodyRef.current;
    if (!root) return;
    const fromButton = prevNonceRef.current !== scrollNonce;
    prevNonceRef.current = scrollNonce;
    const verseChanged = prevVerseRef.current !== activeVerse;
    prevVerseRef.current = activeVerse;
    const pinChanged =
      prevPinnedRef.current.notes !== pinned.notes ||
      prevPinnedRef.current.words !== pinned.words ||
      prevPinnedRef.current.questions !== pinned.questions;
    prevPinnedRef.current = pinned;
    // The verse-group / verse-end fallbacks below reposition the whole list to
    // a verse boundary. They're meant for navigation (button, verse change, pin
    // toggle) — NOT for incidental re-runs like clearing the active note when a
    // card is trashed, which would otherwise jerk the list back to the top of
    // the verse's note group.
    const navTriggered = fromButton || verseChanged || pinChanged;
    let target: HTMLElement | null = null;
    let isVerseGroup = false;
    if (activeNoteId) {
      target = root.querySelector<HTMLElement>(`[data-note-id="${activeNoteId}"]`);
    } else if (activeWordId) {
      // Escaped: activeWordId can come from the URL (#/{book}/{ch}/{vs}?twl=).
      target = root.querySelector<HTMLElement>(`[data-word-id="${CSS.escape(activeWordId)}"]`);
    }
    if (navTriggered && !target && (pinned.notes || pinned.words || pinned.questions)) {
      target = root.querySelector<HTMLElement>(`[data-verse-group="${activeVerse}"]`);
      isVerseGroup = !!target;
    }
    // Pinned notes, active verse has no notes of its own: there's no group
    // head to land on, so fall back to the end of the previous verse's notes
    // (the last note card before the active verse's slot in the chapter).
    let atVerseEnd = false;
    if (navTriggered && !target && pinned.notes) {
      const heads = [...root.querySelectorAll<HTMLElement>('[data-vg-section="notes"]')];
      const prevHead = heads
        .filter((el) => Number(el.dataset.verseGroup) < activeVerse)
        .at(-1);
      if (prevHead) {
        // Walk forward over the previous verse's note cards, stopping at the
        // next verse group head; the last card is the end of that verse.
        let lastNote = prevHead;
        for (
          let el = prevHead.nextElementSibling;
          el && !el.hasAttribute("data-verse-group");
          el = el.nextElementSibling
        ) {
          if (el.hasAttribute("data-note-id")) lastNote = el as HTMLElement;
        }
        target = lastNote;
        atVerseEnd = true;
      }
    }
    // Individual-verse mode (nothing pinned): the list only ever shows the
    // active verse's resources, so a verse change swaps the whole list and
    // there's no target to land on. Reset to the top instead of stranding the
    // scroll wherever the previous verse left it.
    if (!target && verseChanged && !pinned.notes && !pinned.words && !pinned.questions) {
      root.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    target?.scrollIntoView({
      behavior: "smooth",
      block: isVerseGroup ? "start" : atVerseEnd ? "end" : fromButton ? "center" : "nearest",
    });
  }, [
    scrollNonce,
    activeNoteId,
    activeWordId,
    activeVerse,
    pinned.notes,
    pinned.words,
    pinned.questions,
  ]);

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
        spacing={0.25}
        alignItems="center"
        sx={{
          px: 1.5,
          pt: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
        }}
      >
        <Typography
          variant="subtitle2"
          sx={{ fontSize: 12, color: "text.secondary", mr: 0.5 }}
        >
          {t("shell.resources")} · {activeVerse === 0 ? "i" : activeVerse}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {tabs.includes("notes") && (
          <PanelTab
            label={t("shell.notes")}
            count={totalTn}
            countSuffix={pinned.notes ? " · ch" : ""}
            active={panelMode === "resources" && activeResourceTab === "notes"}
            accent={false}
            onClick={() => showResource("notes")}
          />
        )}
        {tabs.includes("words") && (
          <PanelTab
            label={t("shell.words")}
            count={totalTwl}
            countSuffix={pinned.words ? " · ch" : ""}
            active={panelMode === "resources" && activeResourceTab === "words"}
            accent={false}
            onClick={() => showResource("words")}
          />
        )}
        {tabs.includes("questions") && (
          <PanelTab
            label={t("shell.questions")}
            count={totalTq}
            countSuffix={pinned.questions ? " · ch" : ""}
            active={panelMode === "resources" && activeResourceTab === "questions"}
            accent={false}
            onClick={() => showResource("questions")}
          />
        )}
        <PanelTab
          label={t("shell.alignment")}
          countLabel={alignmentBadge}
          active={panelMode === "alignment"}
          accent
          onClick={() => onSetPanelMode?.("alignment")}
        />
        <PanelTab
          label={t("shell.searchExternal")}
          active={panelMode === "search"}
          accent={false}
          onClick={() => onSetPanelMode?.("search")}
        />
      </Stack>
      {panelMode === "alignment" ? (
        alignmentProps ? (
          <AlignmentPanel
            // Remount on any target change (version OR verse). Without a key,
            // React reuses the instance and the panel's `state` only resets via
            // a passive useEffect that runs AFTER paint — leaving a window where
            // `state` still holds the PREVIOUS version's alignment while `verse`
            // / `onSave` are already bound to the new target. A save landing in
            // that window writes the old content to the new row (e.g. UST
            // alignment saved onto the ULT verse). Keying forces a fresh mount
            // whose useState(computedInitial) seeds the correct state
            // synchronously, closing the race.
            key={`${alignmentProps.bibleVersion}:${alignmentProps.chapter}:${alignmentProps.verseNum}`}
            ref={alignmentProps.panelRef}
            book={alignmentProps.book}
            chapter={alignmentProps.chapter}
            verseNum={alignmentProps.verseNum}
            bibleVersion={alignmentProps.bibleVersion}
            verse={alignmentProps.verse}
            sourceVerse={alignmentProps.sourceVerse}
            sourceLabel={alignmentProps.sourceLabel}
            twlForVerse={alignmentProps.twlForVerse}
            onSave={alignmentProps.onSave}
            onConfirmUnalign={alignmentProps.onConfirmUnalign}
            onCancel={alignmentProps.onCancel}
            onDirtyChange={alignmentProps.onDirtyChange}
            onOpenDual={alignmentProps.onOpenDual}
            onRestoreVersion={alignmentProps.onRestoreVersion}
          />
        ) : (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              {t("shell.clickLinkToAlign")}
            </Typography>
          </Box>
        )
      ) : panelMode === "resources" ? (
      <Box
        ref={scrollBodyRef}
        onDragOver={handleDragAutoScroll}
        // scrollbarGutter:stable reserves the scrollbar's width whether or not
        // it's showing, so the cards' content width never changes as the
        // scrollbar appears/disappears. Without it, a card header sitting right
        // at its flex-wrap boundary can flip-flop a line as the gutter toggles.
        sx={{ flex: 1, overflowY: "auto", scrollbarGutter: "stable", px: 2, py: 1 }}
      >
        {activeResourceTab === "notes" && (
          <NotesPanelBody
            activeVerse={activeVerse}
            tnForVerse={tnForVerse}
            tnGroups={tnGroups}
            totalTn={totalTn}
            trashedTn={tnCount.trashed}
            pinned={pinned.notes}
            onTogglePin={() => togglePinned("notes")}
            onNoteCreate={onNoteCreate}
            locked={locked}
            checkoff={checkoff}
            translationMode={translationMode}
            tnStats={tnStats}
            termsCount={termsCount}
            onNoteApprove={onNoteApprove}
            onApproveAllNotes={onApproveAllNotes}
            renderNoteCard={renderNoteCard}
          />
        )}

        {activeResourceTab === "words" && (
          <WordsPanelBody
            book={book}
            chapter={chapter}
            activeVerse={activeVerse}
            twlForVerse={twlForVerse}
            twlGroups={twlGroups}
            totalTwl={totalTwl}
            pinned={pinned.words}
            onTogglePin={() => togglePinned("words")}
            onWordCreate={onWordCreate}
            locked={locked}
            checkoff={checkoff}
            activeWordId={activeWordId}
            onWordSave={onWordSave}
            onWordDelete={onWordDelete}
            onWordFocus={onWordFocus}
            onWordReorder={onWordReorder}
            onWordHoverPreview={onWordHoverPreview}
            onWordTranslateQuote={onWordTranslateQuote}
            onWordGloss={onWordGloss}
            twlRowAlternatives={twlRowAlternatives}
            quoteBuildActiveWordId={quoteBuildActiveWordId}
            quoteBuildSelectionCount={quoteBuildSelectionCount}
            onStartWordQuoteBuild={onStartWordQuoteBuild}
            onAddTwlSuggestion={onAddTwlSuggestion}
            isTwlSuggestionExcluded={isTwlSuggestionExcluded}
            onTwlSuggestions={onTwlSuggestions}
            twlBlockedArticleIds={twlBlockedArticleIds}
            twlFiltersReady={twlFiltersReady}
          />
        )}

        {activeResourceTab === "questions" && (
          <QuestionsPanelBody
            activeVerse={activeVerse}
            tqForVerse={tqForVerse}
            tqGroups={tqGroups}
            totalTq={totalTq}
            pinned={pinned.questions}
            onTogglePin={() => togglePinned("questions")}
            onQuestionCreate={onQuestionCreate}
            locked={locked}
            checkoff={checkoff}
            translationMode={translationMode}
            tqStats={tqStats}
            sourceQuestions={sourceQuestions}
            onQuestionSave={onQuestionSave}
            onQuestionDelete={onQuestionDelete}
            onQuestionApprove={onQuestionApprove}
            onApproveAllQuestions={onApproveAllQuestions}
            onQuestionTranslate={onQuestionTranslate}
            translatingQuestionIds={translatingQuestionIds}
          />
        )}
      </Box>
      ) : null}
      {/* Search tab: external tool in an iframe. Kept mounted once first
          visited (toggled via display, not unmount) so switching to Notes and
          back doesn't reload the page and lose an in-progress search. */}
      {searchVisited && (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: panelMode === "search" ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ px: 1, py: 0.5, flexShrink: 0 }}
          >
            {t("shell.searchExternalDisclosure")}
          </Typography>
          <iframe
            src={SEARCH_IFRAME_URL}
            title={t("shell.searchExternal")}
            // sandbox grants only what a search tool needs (its own scripts,
            // storage, forms, and opening result links in a new tab);
            // referrerPolicy keeps our URL out of the external site's logs.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            style={{ width: "100%", flex: 1, minHeight: 0, border: 0 }}
          />
        </Box>
      )}
    </Box>
  );

  function renderNoteCard(r: TnRow, peers: TnRow[]) {
    const showBefore =
      dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "before";
    const showAfter =
      dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "after";
    // Only navigate within the same verse — displayVerseRange can span multiple
    // verses, but onNoteReorder in Shell operates per-verse via sortedForVerse.
    const samePeers = peers.filter((p) => p.verse === r.verse);
    const idx = samePeers.indexOf(r);
    const prevNote = idx > 0 ? samePeers[idx - 1] : null;
    const nextNote = idx < samePeers.length - 1 ? samePeers[idx + 1] : null;
    return (
      <Fragment key={r.id}>
        {showBefore && <DropIndicator />}
        <NoteCard
          row={r}
          active={r.id === activeNoteId}
          // Only the active-match note needs the query (it's the only one that
          // renders the highlight read view) — scoping it here keeps a find
          // keystroke from re-rendering every note card.
          findQuery={activeNoteMatch && activeNoteMatch.noteId === r.id ? (findNoteQuery ?? null) : null}
          activeMatchOccurrence={
            activeNoteMatch && activeNoteMatch.noteId === r.id ? activeNoteMatch.occurrence : null
          }
          dragging={dragId === r.id}
          isDropTarget={dragId !== null && dragId !== r.id}
          onChange={(p) => onNoteChange(r.id, p)}
          onSave={(p, opts) => onNoteSave(r.id, p, opts)}
          onDelete={() => onNoteDelete(r.id)}
          onRestore={() => onNoteRestore(r.id)}
          onInsertAfter={() => onNoteInsertAfter(r.id)}
          verseOptions={verseOptions}
          onChangeVerse={(v, vEnd) => onNoteChangeVerse(r.id, v, vEnd)}
          onFocus={() => onNoteFocus(r)}
          onGripDragStart={() => setDragId(r.id)}
          onMoveUp={
            prevNote
              ? () => {
                  noteFocusRef.current = { id: r.id, dir: "up" };
                  onNoteReorder(r.id, prevNote.id, "before");
                  onReorderPreview?.(computeNeighbors(r.id, prevNote.id, "before"), true);
                }
              : undefined
          }
          onMoveDown={
            nextNote
              ? () => {
                  noteFocusRef.current = { id: r.id, dir: "down" };
                  onNoteReorder(r.id, nextNote.id, "after");
                  onReorderPreview?.(computeNeighbors(r.id, nextNote.id, "after"), true);
                }
              : undefined
          }
          flashArrow={recentNoteMove?.id === r.id ? recentNoteMove.dir : null}
          onReorderHover={
            onReorderPreview
              ? (entering) =>
                  onReorderPreview(
                    entering
                      ? { verse: r.verse, movedId: r.id, prevId: prevNote?.id ?? null, nextId: nextNote?.id ?? null }
                      : null,
                    false,
                  )
              : undefined
          }
          onDragEnd={() => {
            setDragId(null);
            setDragOver(null);
            onReorderPreview?.(null, false);
          }}
          onCardDragOver={(position) => {
            setDragOver((cur) =>
              cur && cur.targetId === r.id && cur.position === position
                ? cur
                : { targetId: r.id, position },
            );
          }}
          onCardDragLeave={() => {
            // Don't clear on leave — the next onDragOver from the
            // adjacent card or the same card's other half will
            // immediately overwrite this. Clearing here causes flicker.
          }}
          onCardDrop={(position) => {
            if (dragId && dragId !== r.id) {
              onNoteReorder(dragId, r.id, position);
            }
            setDragId(null);
            setDragOver(null);
          }}
          onStartAi={onNoteStartAi ? (live) => onNoteStartAi(r, live) : undefined}
          isAiPending={isNoteAiPending?.(r.id) ?? false}
          aiRecentlyCompletedAt={noteAiRecentlyCompletedAt?.(r.id) ?? null}
          onVisibilityChange={onNoteVisibilityChange}
          locked={locked}
          onSetPreserve={
            onSetNotePreserve ? (value) => onSetNotePreserve(r.id, value) : undefined
          }
          onSetHint={onSetNoteHint ? (value) => onSetNoteHint(r.id, value) : undefined}
          onTranslateQuote={
            onNoteTranslateQuote ? (english) => onNoteTranslateQuote(r, english) : undefined
          }
          quoteBuildMode={quoteBuildActiveNoteId === r.id}
          quoteBuildSelectionCount={
            quoteBuildActiveNoteId === r.id ? quoteBuildSelectionCount : 0
          }
          quoteBuildAppliedAt={
            quoteBuildAppliedTo?.noteId === r.id ? quoteBuildAppliedTo.nonce : null
          }
          onStartQuoteBuild={onStartQuoteBuild ? () => onStartQuoteBuild(r.id) : undefined}
          translationMode={translationMode}
          sourceNote={translationMode ? (sourceNotes.get(r.id) ?? null) : null}
          onApprove={onNoteApprove ? () => onNoteApprove(r.id, true) : undefined}
          onUnapprove={onNoteApprove ? () => onNoteApprove(r.id, false) : undefined}
          onTranslate={onNoteTranslate ? () => onNoteTranslate(r.id) : undefined}
          isTranslating={translatingNoteIds?.has(r.id) ?? false}
        />
        {showAfter && <DropIndicator />}
      </Fragment>
    );
  }
}

function PanelTab({
  label,
  count,
  countLabel,
  countSuffix,
  active,
  accent,
  onClick,
}: {
  label: string;
  count?: number;
  countLabel?: string;
  countSuffix?: string;
  active: boolean;
  accent: boolean;
  onClick: () => void;
}) {
  const showCount =
    countLabel !== undefined ? countLabel : count !== undefined ? `${count}${countSuffix ?? ""}` : null;
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        px: 1,
        pt: 0.75,
        pb: 1,
        border: 0,
        background: "transparent",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active && accent ? "primary.main" : active ? "text.primary" : "text.secondary",
        borderBottom: "2px solid",
        borderColor: active ? (accent ? "primary.main" : "text.primary") : "transparent",
        marginBottom: "-1px",
        "&:hover": { color: accent ? "primary.main" : "text.primary" },
      }}
    >
      {label}
      {showCount !== null && (
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            px: 0.75,
            py: "1px",
            borderRadius: 999,
            fontFamily: "monospace",
            fontSize: 10,
            fontWeight: 600,
            bgcolor: active && accent ? "primary.main" : "transparent",
            color: active && accent ? "primary.contrastText" : "text.disabled",
            border: active && accent ? "none" : "1px solid",
            borderColor: "divider",
            letterSpacing: "0.02em",
            lineHeight: 1.4,
          }}
        >
          {showCount}
        </Box>
      )}
    </Box>
  );
}
