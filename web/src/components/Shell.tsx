import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Button,
  Tooltip,
  IconButton,
} from "@mui/material";
import GridViewIcon from "@mui/icons-material/GridView";
import CloseIcon from "@mui/icons-material/Close";
import { useChapter } from "../hooks/useChapter";
import { useChapterRoom } from "../hooks/useChapterRoom";
import type { UseBookReturn } from "../hooks/useBook";
import { useBookLint } from "../hooks/useBookLint";
import { useLexicon } from "../hooks/useLexicon";
import { useAiDrafts } from "../hooks/useAiDrafts";
import { useTwlFilters } from "../hooks/useTwlFilters";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { useLayoutBand } from "../hooks/useLayoutBand";
import { outbox } from "../sync/outbox";
import { api, ApiError, CHECK_LANES } from "../sync/api";
import type { BookLintIssue, ChapterPayload, CheckLane, TnRow, TqRow, TwlRow, VerseDto, TwlSuggestion, LaneReplacementEvent } from "../sync/api";
import { refreshProjectConfig, useProjectConfig, useWorkflowLayouts } from "../hooks/useProjectConfig";
import {
  indexLaneChecks,
  laneKey,
  laneApplicable,
  laneAttribution,
  shadeFromCheckers,
  type LaneShade,
  type TextLaneCheck,
} from "../lib/laneChecks";
import { ChapterBoard } from "./ChapterBoard";
import { drafts, rowKey, verseKey } from "../sync/drafts";
import { generationForSavedPlain } from "../sync/draftSaveState";
import { alignmentDrafts, alignmentDraftKey } from "../sync/alignmentDrafts";
import {
  clearLaneFrozen,
  isLaneFrozen,
  markLaneFrozen,
} from "../sync/laneFreeze";
import { smartEditVerse } from "../lib/replace";
import { extractEditableText, extractPlainText, normalizeEditable, SECTION_HEADER_TAGS } from "../lib/usfm";
import { verseHasUnalignedWork, countUnalignedTargetWords } from "../lib/alignment";
import {
  analyzeAlignmentDelta,
  guardBlocksSave,
  type AlignmentIntent,
} from "../lib/alignmentDelta";
import { buildVerseIndex, concatSourceRange, formatVerseLabel, noteCoveredVerses } from "../lib/verseRange";
import { buildTnQuickRequest } from "../lib/tnQuickRequest";
import { isApprovableRow } from "../lib/reviewApproval";
import { reviewStatePatches, reviewStateSnapshot } from "../lib/reviewStateSweep";
import { versionLabel } from "../lib/versionLabels";
import { findSourceForTargetText, extractTargetSelectionText, type HighlightKey, type ReorderHighlight } from "../lib/highlight";
import { buildQuoteFromSelection, collectSourceWordNodes, selectionFromQuote } from "../lib/quoteBuilder";
import { resolveSpanToSource } from "../lib/twlResolve";
import { canonicalTwlOrder } from "../lib/twlCanonicalOrder";
import { nfc } from "../lib/hebrew";
import { TimelineRail, type VerseTile, type VerseTileLane } from "./TimelineRail";
import { ScriptureColumn, type ScriptureMode } from "./ScriptureColumn";
import { ResourceColumn, type AlignmentTabProps, type PanelMode, type ReorderPreview, type ResourceCheckoff, type ResourceColumnProps, type ResourceLane, type ResourceTab } from "./ResourceColumn";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { StackedResourcePanel } from "./StackedResourcePanel";
import { AssociatedArticlePanel } from "./AssociatedArticlePanel";
import { SearchPanel } from "./SearchPanel";
import { OriginalLanguagePanel } from "./OriginalLanguagePanel";
import { LayoutMenu } from "./LayoutMenu";
import { PanelChrome } from "./PanelChrome";
import { RegionDropZone } from "./RegionDropZone";
import { LayoutDragProvider, type LayoutDragValue } from "./LayoutDragContext";
import { CLASSIC_LAYOUT_ID } from "../lib/builtinLayouts";
import { validateLayoutAgainstRegistry } from "../lib/panelRegistry";
import {
  canHideRegion,
  collectRegions,
  effectiveRoot,
  hiddenRegions,
  movePanel,
  pruneSizes,
  resolveHidden,
  type DropTarget,
} from "../lib/layoutTree";
import { resolveBandHidden } from "../lib/layoutBands";
import {
  loadLayoutStore,
  mergeOverride,
  setLayoutHidden,
  setLayoutTree,
  setClassicSplitRatio,
  upsertUserLayout,
  deleteUserLayout,
  setActiveLayoutId as persistActiveLayoutId,
} from "../lib/layoutStore";
import { normalizeSizes, validateLayoutSpec } from "../lib/layoutSpec";
import type { LayoutNode, LayoutSpec, PanelInstance, PanelRegion } from "../lib/layoutSpec";
import type { AlignmentPanelHandle } from "./AlignmentPanel";
import {
  SideBySideAligner,
  type PanelSlot,
  type ReadingLineHandle,
} from "./SideBySideAligner";
import { TopBar } from "./TopBar";
import { ExportUsfmButton, type ExportUsfmButtonHandle } from "./ExportUsfmButton";
import { PipelineMenu } from "./PipelineMenu";
import { pipelineStore, getSessionKey, type PipelineJob } from "../sync/pipelineStore";
import { onOutboxResult } from "../sync/outbox";
import { AiCompletionToasts } from "./AiCompletionToasts";
import { UnsavedToasts } from "./UnsavedToasts";
import { QuoteBuilderPopper } from "./QuoteBuilderPopper";
import { collectStrongs } from "./HebrewLine";

interface AlignerTarget {
  chapter: number;
  verse: number;
  bibleVersion: string;
}

// Per-version slice of the alignment props: target verse, the source for the
// verses that target covers (concatenated across a multi-verse range), and the
// TWL rows for that span. Used by both the single-panel aligner and the
// side-by-side popup. Resolves through buildVerseIndex so a verse INSIDE a
// range row (e.g. v7 of a UST 6-9 block) finds its covering row — the wire
// map is keyed by verse_start only.
function buildAlignerSlice(sourceData: ChapterPayload, verse: number, bibleVersion: string) {
  const sourceLabel = sourceData.verses["UHB"] ? "UHB" : "UGNT";
  const targetVerse = buildVerseIndex(sourceData.verses[bibleVersion])[verse] ?? null;
  const rangeEnd = targetVerse?.verse_end ?? targetVerse?.verse ?? verse;
  const rangeStart = targetVerse?.verse ?? verse;
  const sourceVerse =
    rangeEnd > rangeStart
      ? concatSourceRange(sourceData.verses[sourceLabel] ?? {}, rangeStart, rangeEnd)
      : sourceData.verses[sourceLabel]?.[rangeStart] ?? null;
  const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
  return { sourceLabel, targetVerse, sourceVerse, twlForVerse, rangeStart, rangeEnd };
}

// Word-token count of one source verse row — text/punctuation nodes excluded,
// matching the position enumeration in UhbStrip/buildSourceIndexMap. Used to
// compute each dual panel's posOffset within the union span.
//
// Projected off quoteBuilder's shared `collectSourceWordNodes` so the descent
// rule (zaln milestones, `\qs` character wrappers, `\d` superscriptions) is the
// single one in usfm.ts. The hand-rolled walk this replaced descended ANY
// milestone and no wrapper, so a `\qs`-wrapped word both mis-counted here and
// mis-positioned in UhbStrip — the offset and the strip drifted apart (#370).

// Classic-editor twin of ReviewQueue.tsx's private refFor — used only by
// handleApproveAllNotes/handleApproveAllQuestions to name the first failure
// in the batch summary toast.
function refForRow(book: string, row: { chapter: number; verse: number }): string {
  return row.verse === 0 ? `${book} ${row.chapter} intro` : `${book} ${row.chapter}:${row.verse}`;
}

function countSourceWords(row: VerseDto | undefined): number {
  const verseObjects = (row?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
  return collectSourceWordNodes(verseObjects ?? []).length;
}

const SCRIPTURE_MODE_KEY = "be:scriptureMode";
const ENABLED_VERSIONS_KEY = "be:enabledVersions";
const RAIL_COLLAPSED_KEY = "be:railCollapsed";
const ENABLED_LANES_KEY = "be:enabledLanes";

function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

// Cross-chapter TN-find jump carry. A find-overlay match in another chapter
// (book mode) navigates via the hash, which can't encode a note id, and Shell
// is keyed on book/chapter/verse so it fully remounts on arrival. Stash the
// target here just before navigating; the freshly-mounted Shell consumes it
// once its chapter payload (with that note row) has loaded, then activates +
// scrolls to the note. Module-level so it survives the remount; cleared on
// consume so a later same-location mount doesn't re-grab a stale note.
let pendingNoteJump: { book: string; chapter: number; noteId: string } | null = null;

// First scripture panel in a layout tree, depth-first — its `config` drives the
// mode/versions sync when a layout is selected.
function findScripturePanel(node: LayoutNode): PanelInstance | null {
  if (node.kind === "region") return node.panels.find((p) => p.type === "scripture") ?? null;
  for (const child of node.children) {
    const found = findScripturePanel(child);
    if (found) return found;
  }
  return null;
}

// Bake the active layout's live size overrides into a cloned tree's node `size`
// fields (Phase 5 "Save current as…"). Mirrors WorkspaceLayout's childId path
// scheme so the persisted sizes line up: split children use their region id, or
// a `split:<path>` synthetic id. `path` seeds from the source layout id (as
// WorkspaceLayout seeds `renderNode(spec.root, spec.id)`). Mutates `node`, which
// must be a deep clone — never a built-in spec's tree. Because sizes land in the
// tree itself (not a fresh override), the saved layout reproduces the current
// proportions without depending on the source layout's override id.
function applyEffectiveSizes(
  node: LayoutNode,
  sizes: Record<string, number>,
  path: string,
): void {
  if (node.kind !== "split") return;
  node.children.forEach((child, i) => {
    const cpath = `${path}.${i}`;
    const id = child.kind === "region" ? child.id : `split:${cpath}`;
    const eff = sizes[id];
    if (eff !== undefined) child.size = eff;
    applyEffectiveSizes(child, sizes, cpath);
  });
  // Renormalize after baking. Resizing a divider while a SIBLING REGION IS CLOSED
  // persists renormalized fractions for the survivors only (the closed region
  // keeps its old share and is not in the Group), so the baked set can sum to
  // more than 1. Nothing downstream fixes that — layoutSpec's validator
  // preserves `size` verbatim — so a saved layout would render wrong proportions
  // forever. Normalizing here includes the closed region and restores the sum.
  node.children = normalizeSizes(node.children);
}

// The resource tabs a layout region exposes, in panel order.
const RESOURCE_PANEL_TYPES: readonly ResourceTab[] = ["notes", "words", "questions"];

interface Props {
  book: string;
  chapter: number;
  initialVerse?: number;
  // A word-links (twl) row to select (#/{book}/{ch}/{vs}?twl={id}), set by the
  // drafts menu in the new UI and by retired #/words bookmarks (#173). On mount
  // the resource column also starts on its Words tab; a later change while
  // mounted selects the row through the chapter-reset effect but leaves the tab.
  initialWordId?: string | null;
  onNavigate?: (book: string, chapter: number, verse?: number) => void;
  bookHook?: UseBookReturn;
  onLogout?: () => void;
  // Current signed-in user id, for the checkoff lane shading (you vs others).
  meUserId?: number | null;
  // Current signed-in username, for the TopBar Account menu's identity line.
  meUsername?: string | null;
}

export function Shell({
  book,
  chapter,
  initialVerse = 1,
  initialWordId = null,
  onNavigate,
  bookHook,
  onLogout,
  meUserId = null,
  meUsername = null,
}: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const {
    status,
    data,
    error,
    retryAttempts,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
    applyLocalVerse,
    applyLocalVerseStatus,
    applyLocalLaneCheck,
    applyLaneCheckers,
    replaceLaneChecksForLane,
  } = useChapter(book, chapter);

  // Live cross-tab updates. The server broadcasts row writes via the
  // ChapterRoom DO; we dedupe by version so the originating user's tab
  // (whose state was already updated by the PATCH response) is a no-op.
  // NoteCard's session guard already shields an in-progress edit from
  // being clobbered when the underlying row prop changes — so we can
  // apply unconditionally here.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  // The "save & refresh" prompt helper is defined further down (it depends on
  // toast state declared after this hook), so the WS handler reaches it through
  // a ref, mirroring dataRef above.
  const promptRefreshRef = useRef<(pipelineType: string) => void>(() => {});
  const sweepSeqRef = useRef({ tn: 0, tq: 0 });
  // Lane freeze/settled handlers reach state declared further down (toast,
  // aligner) through refs, same as promptRefreshRef above.
  const laneFreezeRef = useRef<(event: LaneReplacementEvent) => void>(() => {});
  const laneSettledRef = useRef<(event: LaneReplacementEvent) => void>(() => {});
  useChapterRoom(book, chapter, {
    onUpsert: (kind, row) => {
      const list = dataRef.current?.[kind] as Array<TnRow | TqRow | TwlRow> | undefined;
      const existing = list?.find((r) => r.id === row.id);
      if (!existing) {
        applyLocalRowInsert(kind, row);
      } else if (row.version > existing.version) {
        applyLocalRowReplacement(kind, row);
      } else if (
        // Preserve/hint/trash toggles on TN rows don't bump version (they're
        // state flips, not content — see api/src/rows.ts setTnBit /
        // setTnTrashed). The version > existing.version guard above would drop
        // these broadcasts, leaving other tabs stale until refetch. Same-
        // version replace when an intent bit or the trash state differs.
        kind === "tn" &&
        row.version === existing.version &&
        ((row as TnRow).preserve !== (existing as TnRow).preserve ||
          (row as TnRow).hint !== (existing as TnRow).hint ||
          (row as TnRow).trashed_at !== (existing as TnRow).trashed_at)
      ) {
        applyLocalRowReplacement(kind, row);
      }
      // This room is scoped to the open {book, chapter}, so any row.upserted
      // here is for this book. The server may have flipped lint-relevant state
      // without moving row content or version — e.g. a no-op review-flag clear
      // (see api/src/rows.ts), which the version guard above drops. The review
      // chip is drawn from a separate fetch (useBookLint), so nudge it via the
      // same debounced refetch the outbox listener below uses.
      //
      // Only TN upserts can change the lint set: the book-lint endpoint reads
      // TN + ULT/UST rows only (api/src/bookImport.ts), and ULT/UST are verses
      // handled by onVerseUpdate, not here. So gate on TN — a TQ/TWL broadcast
      // would otherwise trigger a book-wide fetch+parse that can never move the
      // report. This mirrors the outbox listener below (t.rowKind === "tn"), and
      // the review-flag clear noted above is TN-only, so it still refetches.
      if (kind === "tn") scheduleLintRefetch();
    },
    onDelete: (kind, id) => applyLocalRowDelete(kind, id),
    onVerseUpdate: (verse) => {
      const existing = dataRef.current?.verses[verse.bible_version]?.[verse.verse];
      if (!existing || verse.version > existing.version) {
        applyLocalVerse(verse);
      }
    },
    onVerseStatusUpdate: (status) => {
      applyLocalVerseStatus(status.verse, status.done === 1);
    },
    onLaneCheckUpdate: (check) => {
      applyLaneCheckers(check.verse, check.lane, check.checkers);
    },
    onLaneCheckBulkUpdate: (lane, checks) => {
      replaceLaneChecksForLane(lane, checks);
    },
    onPipelineApplied: (_book, _chapter, pipelineType) => {
      // This socket only carries events for the chapter in view, so any hint
      // that arrives is for the open chapter — offer a refresh. Covers
      // collaborators too (their tab gets no pipeline-completion event).
      promptRefreshRef.current(pipelineType);
      // The server writes the job's terminal state to D1 *before* broadcasting
      // this event, so reconcile the pipelineStore now instead of waiting for
      // the 2-min poll. Without this, the "AI running" chapter-lock banner
      // stays stuck and the completion toast doesn't fire until the next poll
      // or a manual reload. reload() is idempotent and self-dedupes the toast.
      void pipelineStore.reload();
    },
    onReviewStateSwept: (event) => {
      // An admin bulk-set this chapter's review state (#296/#395). The sweep
      // changes translation_state only — never content or version — so patch
      // just that field onto the rows on screen instead of a full refetch that
      // would flash the chapter and replace rows a translator is looking at.
      // Only the newest sweep's refetch (per resource) may patch: an older one can resolve
      // last with a pre-sweep read (approve, then reopen in quick succession).
      const kind = event.resource;
      const seq = ++sweepSeqRef.current[kind];
      const since = reviewStateSnapshot(dataRef.current?.[kind] ?? []);
      void api
        .getChapter(event.book, event.chapter)
        .then((fresh) => {
          if (seq !== sweepSeqRef.current[kind]) return;
          const cur = dataRef.current;
          if (!cur || cur.book !== fresh.book || cur.chapter !== fresh.chapter) return;
          for (const p of reviewStatePatches(cur[kind], fresh[kind], since)) {
            applyLocalRowPatch(kind, p.id, { translation_state: p.translation_state });
          }
        })
        .catch(() => {
          // A hint, never the source of truth: the next load picks the state up.
        });
    },
    onLaneFreeze: (event) => laneFreezeRef.current(event),
    onLaneSettled: (event) => laneSettledRef.current(event),
  });
  // Book-level DCS-validation summary for the topbar "issues to clean up"
  // indicator. Keyed on book, so it fetches once per book change — never on
  // chapter/verse navigation within a book.
  const bookLint = useBookLint(book, true);
  // TWL suggestion deny-lists (unlinked word+article pairs + this book's deleted
  // reference+quotes). Keyed on book, fetched once per book change. Drives the
  // deleted-here exclusion + unlinked article-pruning for per-verse suggestions.
  const twlFilters = useTwlFilters(book);
  // The lint report is otherwise fetched once per book, so a translator who
  // fixes a flagged note (e.g. unbalanced brackets around an Alternate
  // translation) would keep seeing the stale count until a reload. Refetch when
  // a TN-row or verse write for THIS book lands successfully — those are the
  // only edits the lint covers (TN flags + ULT/UST footnote integrity) —
  // debounced so a burst of saves coalesces into one request.
  const bookLintRefetch = bookLint.refetch;
  const lintRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounced lint refetch — coalesces a burst of edits into one request.
  // Used by the outbox listener below AND by the trash/restore handlers, which
  // bypass the outbox (direct API calls) yet change the lint set: the lint
  // endpoint filters `trashed_at IS NULL`, so trashing a flagged note drops the
  // count and restoring one adds it back.
  const scheduleLintRefetch = useCallback(() => {
    if (lintRefetchTimer.current) clearTimeout(lintRefetchTimer.current);
    lintRefetchTimer.current = setTimeout(() => {
      lintRefetchTimer.current = null;
      bookLintRefetch();
    }, 1000);
  }, [bookLintRefetch]);
  useEffect(() => {
    const unsub = onOutboxResult((op, result) => {
      if (result.kind !== "ok") return;
      const t = op.target;
      const touchesLint =
        (t.kind === "row" && t.rowKind === "tn" && t.book === book) ||
        (t.kind === "verse" && t.book === book);
      if (touchesLint) scheduleLintRefetch();
    });
    return () => {
      unsub();
      if (lintRefetchTimer.current) {
        clearTimeout(lintRefetchTimer.current);
        lintRefetchTimer.current = null;
      }
    };
  }, [book, scheduleLintRefetch]);
  // Self-heal a stale "issues to clean up" chip: when the tab regains focus or
  // becomes visible, re-pull the lint. A tab left open while edits land (here,
  // in another tab, on another device, or via an out-of-band fix) otherwise
  // shows a frozen count until a manual reload — the symptom that flagged-note
  // saves "weren't clearing." Reuses the debounced refetch, so a quick blur/
  // focus flurry coalesces into one request.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") scheduleLintRefetch();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [scheduleLintRefetch]);
  const [activeVerse, setActiveVerse] = useState(initialVerse);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeWordId, setActiveWordId] = useState<string | null>(initialWordId);
  // One-shot: the resource column first renders once `data` arrives (the
  // early return below), and reads initialTab only then. Clear the flag after
  // that commit so a later remount (e.g. a layout switch) opens as usual.
  const [openOnWords, setOpenOnWords] = useState(initialWordId !== null);
  useEffect(() => {
    if (data && openOnWords) setOpenOnWords(false);
  }, [data, openOnWords]);
  // The same request for a column that is already mounted (#535): bumped by the
  // chapter-reset effect below when a ?twl= navigation lands without a remount.
  const [wordsTabRequest, setWordsTabRequest] = useState<{ tab: ResourceTab; nonce: number } | null>(null);
  // Transient hover preview: hovering a Words row's "locate" spot lights up where
  // its Hebrew/Greek word sits in the scripture, without clicking (no active
  // switch, no verse jump). Feeds the same activeQuote/activeOccurrence highlight
  // path below and takes precedence while set; cleared on mouse-leave / nav.
  const [hoveredWordId, setHoveredWordId] = useState<string | null>(null);
  const handleWordHoverPreview = useCallback((id: string | null) => setHoveredWordId(id), []);
  const [mode, setMode] = useState<ScriptureMode>(() =>
    loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"),
  );
  const [enabledVersions, setEnabledVersions] = useState<string[]>(() =>
    loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]),
  );
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() =>
    loadFromStorage<boolean>(RAIL_COLLAPSED_KEY, false),
  );
  const toggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      saveToStorage(RAIL_COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  // Which checkoff lanes show as columns in the timeline rail. Defaults to all
  // four; users hide lanes they don't track (rail then narrows) and re-enable
  // them from the Board dialog. Persisted; normalized to canonical order so a
  // stale/corrupt value can't reorder or smuggle in unknown lane keys. An empty
  // array (all lanes hidden) is a valid, intentional state.
  const [enabledLanes, setEnabledLanes] = useState<CheckLane[]>(() => {
    const saved = loadFromStorage<CheckLane[]>(ENABLED_LANES_KEY, [...CHECK_LANES]);
    return CHECK_LANES.filter((l) => saved.includes(l));
  });
  const toggleLaneVisible = useCallback((lane: CheckLane) => {
    setEnabledLanes((prev) => {
      const next = prev.includes(lane)
        ? prev.filter((l) => l !== lane)
        : CHECK_LANES.filter((l) => l === lane || prev.includes(l));
      saveToStorage(ENABLED_LANES_KEY, next);
      return next;
    });
  }, []);
  // Layout band (phone / tablet / desktop), driven by the theme's breakpoints
  // (see theme.ts). This is the responsive-layout foundation: below desktop
  // width, the workspace shows fewer regions at once instead of squeezing
  // everything into unusable slivers — see the bandHiddenRegionIds useMemo
  // below and WorkspaceLayout's region switcher.
  const { band } = useLayoutBand();
  // Which region the user is currently focused on for band-driven hiding.
  // Render-time only — never persisted. Persisting this would mean shrinking
  // the window could permanently narrow what's visible after resizing back up;
  // it is a viewport constraint, not the user's own arrangement (that's
  // `closedRegions` / layoutStore, a completely separate concept — see the
  // CRITICAL note where bandHiddenRegionIds is passed to WorkspaceLayout).
  const [focusedRegionId, setFocusedRegionId] = useState<string | null>(null);
  // Rail width tracks the visible lane count (verse column + ~25px per lane),
  // floored so the "Board" button label stays readable. 0 when collapsed.
  // Below desktop width the rail is force-collapsed, giving its ~100px back to
  // the text. Driven through this single `effectiveRailCollapsed` value (rather
  // than special-casing width) because the Classic divider drag math in
  // WorkspaceLayout depends on `railWidth` agreeing with what's actually
  // rendered.
  //
  // This is also what makes the TABLET band distinct for Classic. Classic has
  // only two regions, so the region cap (2 at tablet) never hides anything
  // there and a 768px window would otherwise render identically to 1400px.
  // Dropping the rail is the smallest change that makes tablet meaningfully
  // narrower, and the rail — a verse-number list — is the least useful thing on
  // a narrow screen: the TopBar's chapter/verse pickers and "go to ref" box
  // still cover navigation.
  //
  // The TopBar's rail toggle is SUPPRESSED in these bands (see the
  // `onToggleRail` prop at its call site) rather than left visible: a control
  // that can't win against a forced value is a dead control.
  const effectiveRailCollapsed = railCollapsed || band !== "desktop";
  const railWidth = effectiveRailCollapsed ? 0 : Math.max(96, 48 + enabledLanes.length * 25);
  const [alignerTarget, setAlignerTarget] = useState<AlignerTarget | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("resources");
  const [alignmentDirty, setAlignmentDirty] = useState(false);
  const alignmentPanelRef = useRef<AlignmentPanelHandle | null>(null);
  // Queued action that should run after the user resolves the dirty-confirm
  // popup. Verse / version changes attempted while the alignment panel has
  // unsaved drags stash their apply() here; the dialog decides which branch
  // to invoke.
  const [pendingNav, setPendingNav] = useState<{ run: () => void } | null>(null);
  // Side-by-side aligner popup: which verse it targets (ULT + UST at once),
  // per-panel handles for the save/discard gate, and per-panel dirty flags.
  const [dualTarget, setDualTarget] = useState<{ chapter: number; verse: number } | null>(null);
  const dualLeftRef = useRef<AlignmentPanelHandle | null>(null);
  const dualRightRef = useRef<AlignmentPanelHandle | null>(null);
  const [dualLeftDirty, setDualLeftDirty] = useState(false);
  const [dualRightDirty, setDualRightDirty] = useState(false);
  // Same machinery for the editable reading lines, so the gate prompts before a
  // close/nav drops an unsaved reading-text edit.
  const dualLeftReadingRef = useRef<ReadingLineHandle | null>(null);
  const dualRightReadingRef = useRef<ReadingLineHandle | null>(null);
  const [dualLeftReadingDirty, setDualLeftReadingDirty] = useState(false);
  const [dualRightReadingDirty, setDualRightReadingDirty] = useState(false);
  // Queued action (close / verse-nav) awaiting the user's save-or-discard
  // choice when a dual panel has unsaved drags.
  const [pendingDualAction, setPendingDualAction] = useState<{ run: () => void } | null>(null);
  // Confirm gate for an aligner save that would leave a previously-aligned word
  // bare. alignment_edit is exempt from the collateral-loss save guard, so this
  // is the "out loud" surface for an accidental unlink (the JER 30:1 incident):
  // commit runs only if the user proceeds.
  const [pendingAlignmentLoss, setPendingAlignmentLoss] = useState<
    { ref: string; lostWords: string[]; commit: () => void } | null
  >(null);
  // Shared by the scripture + resource columns so a single "go to active"
  // click re-centers both. Bumped via requestScrollToActive (and elsewhere
  // when the active selection changes through other paths).
  const [scrollNonce, setScrollNonce] = useState(0);
  const requestScrollToActive = useCallback(() => setScrollNonce((n) => n + 1), []);

  // Classic's manual scripture/resources split. Seeded from the persisted layout
  // store so a drag survives reloads (issue #373); `null` until the user first
  // drags (or after a double-click reset), when the shell uses its computed
  // `autoSplit` instead. Persisted on drag-commit / reset via the handlers wired
  // into WorkspaceLayout below — never on every mousemove tick.
  const [splitRatio, setSplitRatio] = useState<number | null>(
    () => loadLayoutStore().overrides[CLASSIC_LAYOUT_ID]?.scriptureSplit ?? null,
  );
  const commitSplitRatio = useCallback((ratio: number) => {
    setSplitRatio(ratio);
    setClassicSplitRatio(CLASSIC_LAYOUT_ID, ratio);
  }, []);
  const resetSplitRatio = useCallback(() => {
    setSplitRatio(null);
    setClassicSplitRatio(CLASSIC_LAYOUT_ID, null);
  }, []);
  // TopBar's "More ▸ Export USFM" menu item opens this component's scope/
  // version Menu via its imperative handle — see the trigger-less
  // <ExportUsfmButton hideTrigger /> mounted below.
  const exportUsfmRef = useRef<ExportUsfmButtonHandle>(null);

  // Active workspace layout (Phase 3). Seeded from the persisted store; resolved
  // to a spec against the config-gated built-ins + the panel registry, falling
  // back to Classic on any miss so a stale/unavailable id can never break the
  // shell. Built-ins only this phase (user layouts land in Phase 5).
  const [activeLayoutId, setActiveLayoutIdState] = useState<string>(
    () => loadLayoutStore().activeLayoutId,
  );
  // User-saved layouts (Phase 5), held in state so a save / rename / delete
  // re-renders the switcher and active-layout resolution. The store is the
  // source of truth; every mutation writes it and mirrors the result here.
  const [userLayouts, setUserLayouts] = useState<LayoutSpec[]>(
    () => loadLayoutStore().userLayouts,
  );
  // Save-current-as… / Manage-layouts… dialog visibility (mounted via LayoutMenu).
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // The panel currently being dragged by its grip (tiled docking), or null.
  // Lives here because the drag SOURCE (PanelChrome) and the drop TARGETS
  // (RegionDropZone) are built by renderRegion but land in unrelated branches of
  // WorkspaceLayout's tree — see LayoutDragContext.
  const [draggedPanelId, setDraggedPanelId] = useState<string | null>(null);
  // The layout override record (tree / sizes / minimized) is read fresh out of
  // localStorage on every render, matching the existing `sizes` pattern — it is
  // not React state. Bumping this counter is how a drop / minimize / reset
  // re-renders. Kept deliberately coarse: a topology change is a rare,
  // user-initiated event.
  const [layoutRev, setLayoutRev] = useState(0);
  // Server-shipped built-in layouts (with a bundled fallback when the server
  // omits them or a spec fails validation). Was a direct getBuiltinLayouts call
  // in Phase 3; the switcher list + active-layout resolution below are unchanged.
  const builtinLayouts = useWorkflowLayouts();
  // The full switcher list: built-ins first, then user layouts. `.find` below
  // therefore prefers a built-in on an id collision (ids never actually collide —
  // "builtin:*" vs "user:*").
  const allLayouts = useMemo<LayoutSpec[]>(
    () => [...builtinLayouts, ...userLayouts],
    [builtinLayouts, userLayouts],
  );
  const activeLayout = useMemo<LayoutSpec>(() => {
    const found = allLayouts.find((l) => l.id === activeLayoutId);
    const validated = found ? validateLayoutAgainstRegistry(found, projectConfig) : null;
    return (
      validated ??
      allLayouts.find((l) => l.id === CLASSIC_LAYOUT_ID) ??
      allLayouts[0]
    );
  }, [allLayouts, activeLayoutId, projectConfig]);
  const isClassic = activeLayout.id === CLASSIC_LAYOUT_ID;
  // The active layout's live override (tree / sizes / minimized), re-read from
  // localStorage rather than held in React state — the existing `sizes` pattern.
  // `layoutRev` is what forces that re-read after a drop / minimize / reset.
  //
  // MUST stay above the `if (!data)` early return further down: every hook below
  // that return is conditional, so declaring this there made the loading render
  // and the loaded render disagree on hook count and crashed the Shell.
  const layoutOverride = useMemo(
    () => loadLayoutStore().overrides[activeLayout.id],
    [activeLayout.id, layoutRev],
  );

  // Band-driven region hiding (render-time overlay ONLY — see the CRITICAL
  // note at the WorkspaceLayout call site). Uses the same effective tree the
  // rest of the layout machinery resolves further down (effectiveRoot), so
  // band-hidden ids agree with what's actually on screen; recomputed here
  // (rather than reusing the `effRoot` computed later) because this must live
  // above the `if (!data)` early return, same reason as `layoutOverride`.
  //
  // CRITICAL: resolveBandHidden is fed ONLY the OPEN regions (`openRegionIds`
  // below), never every region in the tree. Feeding it every region ignores
  // which ones the user already closed, and the union of user-closed ids and
  // band-hidden-over-ALL-regions ids can cover every region that exists —
  // renderNode's `visible.length === 0` guard then returns null and the whole
  // workspace goes blank. It also means the band wastes a visible slot on a
  // region that's already closed, and the switcher can point a tab at one.
  // `openRegionIds` is also what the switcher's tab strip uses (via
  // `bandRegions` below) — closed regions are restored through the separate
  // closed-region reopen strip, not the switcher.
  const { openRegionIds, bandHiddenRegionIds } = useMemo(() => {
    const rootForBand = effectiveRoot(activeLayout, layoutOverride);
    const resolvedHidden = resolveHidden(rootForBand, layoutOverride?.hidden);
    const openRegions = collectRegions(rootForBand).filter((r) => !resolvedHidden[r.id]);
    const openIds = openRegions.map((r) => r.id);
    // PIN the region holding a dirty aligner. Narrowing the window is the ONE
    // unmount trigger that cannot be gated: every other path that unmounts a
    // region (setRegionHidden, selectLayout, handleSetPanelMode, and the
    // switcher's focusRegionWithGate) runs runWithDirtyGate first, but a resize
    // is not an action we can interpose a prompt on. Unsaved aligner drags live
    // in component state only — they never reach the outbox or the drafts store
    // — so letting the band unmount that region would discard them silently,
    // and this responsive work is what made a resize able to unmount anything
    // at all. resolveBandHidden always keeps the focused region, so pinning is
    // just overriding the focus. Tapping another tab still works: that path
    // goes through the dirty gate, which clears the dirty state and releases
    // the pin. Persisting the drags is the real fix and is tracked separately.
    const pinnedId =
      panelMode === "alignment" && alignmentDirty
        ? (openRegions.find((r) =>
            r.panels.some((p) =>
              (RESOURCE_PANEL_TYPES as readonly string[]).includes(p.type),
            ),
          )?.id ?? null)
        : null;
    return {
      openRegionIds: openIds,
      bandHiddenRegionIds: resolveBandHidden(openIds, band, pinnedId ?? focusedRegionId),
    };
  }, [activeLayout, layoutOverride, band, focusedRegionId, panelMode, alignmentDirty]);

  // Toast state shared between the pipeline trigger menu and the status bar.
  // Cleared on dismiss or after a short auto-timeout.
  const [pipelineToast, setPipelineToast] = useState<
    { id: number; text: string; kind: "success" | "error" | "info"; action?: { label: string; onClick: () => void } } | null
  >(null);
  const pipelineToastIdRef = useRef(0);
  const pushPipelineToast = useCallback(
    (text: string, kind: "success" | "error" | "info" = "info", action?: { label: string; onClick: () => void }) => {
      pipelineToastIdRef.current += 1;
      setPipelineToast({ id: pipelineToastIdRef.current, text, kind, action });
    },
    [],
  );
  useEffect(() => {
    if (!pipelineToast) return;
    // Actionable toasts (e.g. "save & refresh") stay put until the user acts or
    // dismisses — auto-expiring them would hide the affordance mid-decision.
    if (pipelineToast.action) return;
    const id = pipelineToast.id;
    const t = setTimeout(() => {
      setPipelineToast((cur) => (cur && cur.id === id ? null : cur));
    }, 8000);
    return () => clearTimeout(t);
  }, [pipelineToast]);

  // A pipeline just wrote new rows into the chapter the user is looking at. The
  // rows landed out of band (no per-row broadcast), so offer an explicit refresh
  // rather than refetching silently — the copy tells them to save first so an
  // in-progress edit is never lost. Shared by the requester's completion event
  // and the WS hint (which also reaches collaborators with the chapter open).
  const promptChapterRefresh = useCallback(
    (pipelineType: string) => {
      pushPipelineToast(
        t("shell.aiReady", { pipelineType }),
        "info",
        { label: t("shell.refresh"), onClick: () => void refetch() },
      );
    },
    [pushPipelineToast, refetch, t],
  );
  useEffect(() => {
    promptRefreshRef.current = promptChapterRefresh;
  }, [promptChapterRefresh]);

  // A scripture lane just froze for a replacement (source swap): the active
  // generation is about to flip, so any queued edit for that lane's version is
  // now against soon-to-be-superseded content. Order matters:
  //   1) set local freeze flag SYNCHRONOUSLY (blocks drafts/enqueue/aligner)
  //   2) quarantine outbox + drafts
  //   3) serialize dirty aligner state into quarantined drafts, then close
  //   4) refresh project config (async — flag covers the window)
  // Verse content refreshes when the settled event arrives.
  const onLaneFreeze = useCallback(
    (event: LaneReplacementEvent) => {
      const bibleVersion = event.lane === "lit" ? "ULT" : "UST";
      const reason = t("shell.laneFrozenQuarantine", { version: bibleVersion });
      markLaneFrozen(bibleVersion, reason);
      void outbox.quarantineLaneOps(bibleVersion, reason);
      void drafts.quarantineByVersion(bibleVersion, reason);

      const quarantineAlignerSnapshot = (
        panel: AlignmentPanelHandle | null | undefined,
        chapterNum: number,
        verseNum: number,
        bv: string,
      ) => {
        if (!panel?.isDirty()) {
          void alignmentDrafts.clear(alignmentDraftKey(book, chapterNum, verseNum, bv));
          return;
        }
        panel.flushCrashDraft();
        const snap = panel.getDirtySnapshot();
        if (snap) {
          void drafts.set(
            verseKey(book, chapterNum, verseNum, bv),
            { content: snap.content, plainText: snap.plainText },
            snap.expectedVersion,
            { kind: "verse", book, chapter: chapterNum, verse: verseNum, bibleVersion: bv },
            { quarantined: reason },
          );
        }
        // Remove the live crash-draft so a post-activation reopen cannot restore
        // pre-freeze alignment onto a new generation that reused version=1.
        void alignmentDrafts.clear(alignmentDraftKey(book, chapterNum, verseNum, bv));
      };

      if (alignerTarget?.bibleVersion === bibleVersion) {
        quarantineAlignerSnapshot(
          alignmentPanelRef.current,
          alignerTarget.chapter,
          alignerTarget.verse,
          bibleVersion,
        );
        setAlignerTarget(null);
        setPanelMode("resources");
      }

      // Dual aligner (ULT left / UST right) — close whenever either lane freezes
      // (popup always involves both). Serialize the frozen side into quarantined
      // drafts; flush the other side's crash-draft so force-close doesn't drop it.
      if (dualTarget) {
        const flushDualSide = (
          panel: AlignmentPanelHandle | null | undefined,
          bv: "ULT" | "UST",
          readingDirty: boolean,
          readingRef: { current: ReadingLineHandle | null },
        ) => {
          if (bv === bibleVersion) {
            quarantineAlignerSnapshot(panel, dualTarget.chapter, dualTarget.verse, bv);
          } else if (panel?.isDirty()) {
            panel.flushCrashDraft();
          }
          if (readingDirty) readingRef.current?.save();
        };
        flushDualSide(dualLeftRef.current, "ULT", dualLeftReadingDirty, dualLeftReadingRef);
        flushDualSide(dualRightRef.current, "UST", dualRightReadingDirty, dualRightReadingRef);
        setDualTarget(null);
        setDualLeftDirty(false);
        setDualRightDirty(false);
        setDualLeftReadingDirty(false);
        setDualRightReadingDirty(false);
      }

      // Re-quarantine after aligner serialization so any just-written draft
      // (and reading-line stash) is marked too.
      void drafts.quarantineByVersion(bibleVersion, reason);
      void refreshProjectConfig().catch(() => {});
      pushPipelineToast(t("shell.laneFrozen", { version: bibleVersion }), "info");
    },
    [
      t,
      book,
      alignerTarget,
      dualTarget,
      dualLeftReadingDirty,
      dualRightReadingDirty,
      pushPipelineToast,
    ],
  );
  useEffect(() => {
    laneFreezeRef.current = onLaneFreeze;
  }, [onLaneFreeze]);

  // The replacement settled (activated / cancelled / failed) and the freeze
  // lifted: clear the local freeze flag, refresh the config (lane state) and
  // reload the open chapter so its verses reflect the new generation (or the
  // reverted state on cancel/fail).
  const onLaneSettled = useCallback(
    (event: LaneReplacementEvent) => {
      const bibleVersion = event.lane === "lit" ? "ULT" : "UST";
      clearLaneFrozen(bibleVersion);
      void refreshProjectConfig().catch(() => {});
      void refetch();
      pushPipelineToast(t("shell.laneSettled", { version: bibleVersion }), "info");
    },
    [t, refetch, pushPipelineToast],
  );
  useEffect(() => {
    laneSettledRef.current = onLaneSettled;
  }, [onLaneSettled]);

  useEffect(
    () =>
      pipelineStore.onComplete((job, prev) => {
        const where = `${job.book} ${job.start_chapter}`;
        // A finished translate run clears the per-note / per-question spinners
        // it drove. The single-slot queue runs one translate at a time, so
        // clearing both sets on any translate completion is safe.
        if (job.pipeline_type === "translate") {
          setTranslatingRowIds((prev) => (prev.size ? new Set() : prev));
          setTranslatingQuestionIds((prev) => (prev.size ? new Set() : prev));
        }
        if (job.state === "done") {
          // Viewing the chapter this job wrote? Offer refresh instead of a plain
          // "applied" toast, since its new rows aren't in the open list yet.
          const inView = job.book === book && chapter >= job.start_chapter && chapter <= job.end_chapter;
          if (inView) promptChapterRefresh(job.pipeline_type);
          else pushPipelineToast(t("shell.aiApplied", { pipelineType: job.pipeline_type, where }), "success");
        } else if (job.state === "failed" && prev !== "failed") {
          pushPipelineToast(t("shell.aiFailed", { pipelineType: job.pipeline_type, where, error: job.error_kind ?? t("shell.error") }), "error");
        }
      }),
    [pushPipelineToast, promptChapterRefresh, book, chapter, t],
  );

  // Surface a toast when the outbox drops an op because the chapter was
  // locked. The user's edit was rejected by the server (409 chapter_locked)
  // and discarded — retrying would race the auto-apply step.
  useEffect(
    () =>
      onOutboxResult((_op, result) => {
        if (result.kind === "locked") {
          pushPipelineToast(
            t("shell.editDroppedLocked"),
            "error",
          );
        }
      }),
    [pushPipelineToast, t],
  );

  // Derive the chapter lock from active pipeline jobs. Any non-terminal job
  // whose scope covers this (book, chapter) locks the editor; the banner
  // surfaces the started-at time and the TN cards switch to keep-mode.
  const [activeJobs, setActiveJobs] = useState<PipelineJob[]>([]);
  useEffect(() => pipelineStore.subscribe(setActiveJobs), []);
  const chapterLock = useMemo(() => {
    const found = activeJobs.find(
      (j) =>
        j.book === book &&
        j.start_chapter <= chapter &&
        j.end_chapter >= chapter &&
        (j.state === "running" ||
          j.state === "paused_for_outage" ||
          j.state === "paused_for_usage_limit" ||
          j.state === "dispatching"),
    );
    if (!found) return null;
    return {
      jobId: found.job_id,
      pipelineType: found.pipeline_type,
      startedAt: found.created_at,
    };
  }, [activeJobs, book, chapter]);

  const handleSetNotePreserve = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setPreserveNote(id, book, value);
        // Mirror server state locally so the card's chip + checkbox flip on
        // the next render without waiting for a chapter refetch.
        applyLocalRowPatch("tn", id, {
          preserve: updated.preserve,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : t("appShell.common.unknownError");
        pushPipelineToast(t("shell.couldntUpdatePreserve", { message: msg }), "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast, t],
  );

  const handleSetNoteHint = useCallback(
    async (id: string, value: boolean) => {
      try {
        const updated = await api.setHintNote(id, book, value);
        applyLocalRowPatch("tn", id, {
          hint: updated.hint,
          updated_at: updated.updated_at,
        });
      } catch (e) {
        // Prefer the server's human-readable message (e.g. the note_required
        // 400) over the bare "HTTP 400" the ApiError carries as its message.
        const serverMsg = (e as { body?: { message?: string } } | null)?.body?.message;
        const msg = (typeof serverMsg === "string" && serverMsg) || (e instanceof Error ? e.message : t("appShell.common.unknownError"));
        pushPipelineToast(t("shell.couldntUpdateHint", { message: msg }), "error");
      }
    },
    [applyLocalRowPatch, pushPipelineToast, t],
  );

  // ── Translation mode: Approve (validate) + single-note Translate ──
  // Approve marks a reviewed draft human-validated (non-version-bumping); the
  // returned row carries the new translation_state so the card collapses.
  const handleApproveNote = useCallback(
    async (id: string, value = true) => {
      try {
        const updated = await api.validateNote(id, book, value);
        applyLocalRowReplacement("tn", updated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : t("appShell.common.unknownError");
        pushPipelineToast(t("shell.couldntApproveNote", { message: msg }), "error");
      }
    },
    [book, applyLocalRowReplacement, pushPipelineToast, t],
  );

  // Rows with an in-flight single-note translate. Cleared when the chapter's
  // translate job reaches a terminal state (see the onComplete effect).
  const [translatingRowIds, setTranslatingRowIds] = useState<Set<string>>(() => new Set());

  const handleTranslateNote = useCallback(
    async (id: string) => {
      setTranslatingRowIds((prev) => new Set(prev).add(id));
      try {
        await pipelineStore.start({
          pipelineType: "translate",
          book,
          startChapter: chapter,
          endChapter: chapter,
          sessionKey: getSessionKey(),
          translate: { rowIds: [id] },
        });
      } catch (e) {
        setTranslatingRowIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        const body = (e as { body?: { error?: string } } | null)?.body;
        const msg = body?.error ?? (e instanceof Error ? e.message : t("appShell.common.unknownError"));
        pushPipelineToast(t("shell.couldntTranslateNote", { message: msg }), "error");
      }
    },
    [book, chapter, pushPipelineToast, t],
  );

  // ── Translation mode: tQ analogues of the tN Approve + Translate handlers ──
  const handleApproveQuestion = useCallback(
    async (id: string, value = true) => {
      try {
        const updated = await api.validateQuestion(id, book, value);
        applyLocalRowReplacement("tq", updated);
      } catch (e) {
        const msg = e instanceof Error ? e.message : t("appShell.common.unknownError");
        pushPipelineToast(t("shell.couldntApproveNote", { message: msg }), "error");
      }
    },
    [book, applyLocalRowReplacement, pushPipelineToast, t],
  );

  // ── Translation mode: classic "Approve all" (tN + tQ) ──
  // Mirrors ReviewQueue.tsx's handleApproveAll (#408): sequential per-row
  // validate calls (not fire-and-forget) so a batch-fatal 401/403 stops the
  // loop instead of firing dozens more doomed requests, plus an end-of-batch
  // summary via the classic toast surface instead of an inline banner. Only
  // rows isApprovableRow lets through are attempted — see its comment for why
  // (#238: a pristine/trashed row 404s and halts the whole run).
  const approveAllNotesInFlightRef = useRef(false);
  const handleApproveAllNotes = useCallback(async () => {
    if (!data || approveAllNotesInFlightRef.current) return;
    const list = data.tn.filter(isApprovableRow);
    if (list.length === 0) return;
    approveAllNotesInFlightRef.current = true;
    let approved = 0;
    let firstFailure: { row: TnRow; status: number | null } | null = null;
    for (const row of list) {
      try {
        const updated = await api.validateNote(row.id, book, true);
        applyLocalRowReplacement("tn", updated);
        approved += 1;
      } catch (e) {
        const status = e instanceof ApiError ? e.status : null;
        if (!firstFailure) firstFailure = { row, status };
        if (status === 401 || status === 403) break;
      }
    }
    approveAllNotesInFlightRef.current = false;
    if (firstFailure) {
      const total = list.length;
      const failed = total - approved;
      const extra = firstFailure.status === 404 ? t("flowReview.queue.approveAllExtraNoDraft") : "";
      pushPipelineToast(
        t("flowReview.queue.approveAllPartial", {
          ref: refForRow(book, firstFailure.row),
          status: firstFailure.status ?? t("flowReview.common.errorWord"),
          extra,
          approved,
          failed,
          total,
        }),
        "error",
      );
    }
  }, [data, book, applyLocalRowReplacement, pushPipelineToast, t]);

  const approveAllQuestionsInFlightRef = useRef(false);
  const handleApproveAllQuestions = useCallback(async () => {
    if (!data || approveAllQuestionsInFlightRef.current) return;
    const list = data.tq.filter(isApprovableRow);
    if (list.length === 0) return;
    approveAllQuestionsInFlightRef.current = true;
    let approved = 0;
    let firstFailure: { row: TqRow; status: number | null } | null = null;
    for (const row of list) {
      try {
        const updated = await api.validateQuestion(row.id, book, true);
        applyLocalRowReplacement("tq", updated);
        approved += 1;
      } catch (e) {
        const status = e instanceof ApiError ? e.status : null;
        if (!firstFailure) firstFailure = { row, status };
        if (status === 401 || status === 403) break;
      }
    }
    approveAllQuestionsInFlightRef.current = false;
    if (firstFailure) {
      const total = list.length;
      const failed = total - approved;
      const extra = firstFailure.status === 404 ? t("flowReview.queue.approveAllExtraNoDraft") : "";
      pushPipelineToast(
        t("flowReview.queue.approveAllPartial", {
          ref: refForRow(book, firstFailure.row),
          status: firstFailure.status ?? t("flowReview.common.errorWord"),
          extra,
          approved,
          failed,
          total,
        }),
        "error",
      );
    }
  }, [data, book, applyLocalRowReplacement, pushPipelineToast, t]);

  const [translatingQuestionIds, setTranslatingQuestionIds] = useState<Set<string>>(() => new Set());

  const handleTranslateQuestion = useCallback(
    async (id: string) => {
      setTranslatingQuestionIds((prev) => new Set(prev).add(id));
      try {
        await pipelineStore.start({
          pipelineType: "translate",
          book,
          startChapter: chapter,
          endChapter: chapter,
          sessionKey: getSessionKey(),
          translate: { resourceType: "tq", rowIds: [id] },
        });
      } catch (e) {
        setTranslatingQuestionIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        const body = (e as { body?: { error?: string } } | null)?.body;
        const msg = body?.error ?? (e instanceof Error ? e.message : t("appShell.common.unknownError"));
        pushPipelineToast(t("shell.couldntTranslateNote", { message: msg }), "error");
      }
    },
    [book, chapter, pushPipelineToast, t],
  );

  // The note delete button. Trash is a reversible, visible soft-delete (the
  // card grays out, drops to the bottom of the verse, gains a Restore button)
  // — the safety net that stands in for a confirmation dialog. Optimistic flip
  // so the card grays instantly; reconcile from the server row; revert on
  // error. Clearing the active note (functional update, no dep on activeNoteId)
  // drops the active highlight off the now-trashed card.
  const handleTrashNote = useCallback(
    async (id: string) => {
      applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
      setActiveNoteId((cur) => (cur === id ? null : cur));
      try {
        const updated = await api.trashNote(id, book);
        applyLocalRowReplacement("tn", updated);
        // Trash discards unsaved edits — drop any orphan draft record for the
        // row so it stops counting toward the "N unsaved" reminder (issue
        // #359). This is the ONLY drafts.clear on the trash path, deliberately
        // on the success side: a failed trash must leave the user's unsaved
        // text intact. NoteCard.handleDelete waits on the boolean below before
        // snapping its own editor buffer to server truth (and the card is
        // already `readOnly` from the optimistic trashed_at, so its persist
        // effect can't re-create this record in between).
        void drafts.clear(rowKey("tn", book, id));
        // Trash bypasses the outbox, so refresh the lint chip directly — a
        // trashed note leaves the lint set (trashed_at IS NULL filter).
        scheduleLintRefetch();
        return true;
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: null });
        const msg = e instanceof Error ? e.message : t("appShell.common.unknownError");
        pushPipelineToast(t("shell.couldntDeleteNote", { message: msg }), "error");
        return false;
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast, scheduleLintRefetch, t],
  );

  const handleRestoreNote = useCallback(
    async (id: string) => {
      applyLocalRowPatch("tn", id, { trashed_at: null });
      try {
        const updated = await api.restoreNote(id, book);
        applyLocalRowReplacement("tn", updated);
        // Restore re-adds the note to the lint set — refresh the chip (the
        // outbox listener won't fire for this direct API call).
        scheduleLintRefetch();
      } catch (e) {
        applyLocalRowPatch("tn", id, { trashed_at: Math.floor(Date.now() / 1000) });
        const msg = e instanceof Error ? e.message : t("appShell.common.unknownError");
        pushPipelineToast(t("shell.couldntRestoreNote", { message: msg }), "error");
      }
    },
    [book, applyLocalRowPatch, applyLocalRowReplacement, pushPipelineToast, scheduleLintRefetch, t],
  );

  // Async AI-draft lifecycle. State outlives any single NoteCard so the
  // user can scroll away / edit a different note while one is in flight.
  // visibleRowIdsRef tracks which TN cards are currently in viewport so
  // we can route arriving results to either the in-place pulse (visible)
  // or the persistent toast stack (off-screen).
  const aiDrafts = useAiDrafts();
  const visibleRowIdsRef = useRef<Set<string>>(new Set());
  const handleNoteVisibilityChange = useCallback((rowId: string, isVisible: boolean) => {
    if (isVisible) visibleRowIdsRef.current.add(rowId);
    else visibleRowIdsRef.current.delete(rowId);
  }, []);

  // Whether ANY resource row sits on verse 0 (the intro tile). The cheap
  // `.some` re-runs on every edit, but it yields a *stable boolean* so the
  // expensive tileSet below doesn't re-run when a row's text changes.
  const introHasResource = useMemo(
    () =>
      !!data &&
      (data.tn.some((r) => r.verse === 0) ||
        data.tq.some((r) => r.verse === 0) ||
        data.twl.some((r) => r.verse === 0)),
    [data],
  );
  // Does the intro tile actually have Words (TWL) rows? The tw lane is otherwise
  // "always applicable", but verse 0 outside the Psalms usually has none, so the
  // rail should show a "nothing to check" dash there rather than a checkbox.
  const introHasTwl = useMemo(() => !!data && data.twl.some((r) => r.verse === 0), [data]);

  // tileSet runs verseHasUnalignedWork (a full alignment parse) for EVERY
  // verse, so it must not recompute when only a TN/TQ/TWL row changed. Keying
  // it on the verse map + statuses + the intro flag means a note keystroke or
  // save — which leaves data.verses untouched — skips the rescan entirely (and
  // keeps verseNumbers referentially stable, so ScriptureColumn can memo-skip).
  const versesForTiles = data?.verses;
  const verseLaneChecksForTiles = data?.verseLaneChecks;
  const tnRowsForTiles = data?.tn;
  const tqRowsForTiles = data?.tq;
  // verse:lane -> checker user ids, for shading the lane cells.
  const laneIndex = useMemo(
    () => indexLaneChecks(verseLaneChecksForTiles ?? []),
    [verseLaneChecksForTiles],
  );
  // Which verses actually have notes / questions — drives "nothing to check"
  // (N/A) vs an unchecked lane.
  // Add every verse a row covers, not just its leading verse, so a bridged note
  // ("1:2-3") makes the Notes/Questions checkoff lane applicable on each verse
  // it renders under — matching noteOverlapsRange in ResourceColumn. Singletons
  // contribute one verse, the common case.
  const versesWithTn = useMemo(() => {
    const s = new Set<number>();
    for (const r of tnRowsForTiles ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [tnRowsForTiles]);
  const versesWithTq = useMemo(() => {
    const s = new Set<number>();
    for (const r of tqRowsForTiles ?? []) for (const v of noteCoveredVerses(r)) s.add(v);
    return s;
  }, [tqRowsForTiles]);
  const tileSet = useMemo<VerseTile[]>(() => {
    if (!versesForTiles) return [];
    const versesWithSomething = new Set<number>();
    Object.values(versesForTiles).forEach((byVerse) => {
      Object.keys(byVerse).forEach((v) => versesWithSomething.add(parseInt(v, 10)));
    });
    const sourceByVerse = versesForTiles.UHB ?? versesForTiles.UGNT ?? {};
    const ult = versesForTiles.ULT ?? {};
    const ust = versesForTiles.UST ?? {};
    const getVO = (dto: VerseDto | undefined) => {
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    const hasUnalignedFor = (verse: number) => {
      if (verse === 0) return false;
      const sourceVO = getVO(sourceByVerse[verse]);
      const ultVO = getVO(ult[verse]);
      if (ultVO && verseHasUnalignedWork(ultVO, sourceVO)) return true;
      const ustVO = getVO(ust[verse]);
      if (ustVO && verseHasUnalignedWork(ustVO, sourceVO)) return true;
      return false;
    };
    const introHasScripture = versesWithSomething.has(0);
    const buildLanes = (verse: number): VerseTileLane[] =>
      CHECK_LANES.map((lane) => {
        // text/tw are "always applicable" for real verses, but the intro tile
        // (verse 0) only has them when intro scripture / TWL rows actually exist.
        const applicable =
          verse === 0
            ? lane === "text"
              ? introHasScripture
              : lane === "tw"
                ? introHasTwl
                : laneApplicable(lane, versesWithTn.has(0), versesWithTq.has(0))
            : laneApplicable(lane, versesWithTn.has(verse), versesWithTq.has(verse));
        const checkers = laneIndex.get(laneKey(verse, lane));
        const shade: LaneShade = applicable ? shadeFromCheckers(checkers, meUserId) : "open";
        const title = `${t(`lanes.${lane}`)} — ${applicable ? laneAttribution(checkers, meUserId, t) : t("shell.nothingToCheck")}`;
        return { lane, shade, applicable, title };
      });
    // Chapter-front USFM content (Psalm \d superscriptions, leading \p before \v 1)
    // is stored as verse 0 in the verses table. Surface the intro tile when any of
    // those exist even if no TN/TQ/TWL row is attached to verse 0.
    const tiles: VerseTile[] = [];
    // The book-intro chapter (chapter 0) always gets the intro tile: the book
    // summary now lists chapter 0 even when its only note is trashed or gone
    // (see api/src/chapterSummary.ts, #756), and without a tile the rail is
    // blank and activeVerse stays at a verse 1 that does not exist there.
    if (chapter === 0 || introHasResource || introHasScripture)
      tiles.push({ verse: 0, has: false, lanes: buildLanes(0) });
    const verseNums = [...versesWithSomething].filter((v) => v > 0).sort((a, b) => a - b);
    for (const v of verseNums) tiles.push({ verse: v, has: hasUnalignedFor(v), lanes: buildLanes(v) });
    return tiles;
  }, [chapter, versesForTiles, laneIndex, versesWithTn, versesWithTq, meUserId, introHasResource, introHasTwl, t]);

  // Toggle MY checkoff stamp on a (verse, lane): optimistic + outbox (offline-safe).
  const toggleLane = useCallback(
    (verse: number, lane: CheckLane) => {
      if (meUserId == null) return;
      const checkers = laneIndex.get(laneKey(verse, lane));
      const next = !(checkers?.includes(meUserId));
      applyLocalLaneCheck(verse, lane, meUserId, next);
      void outbox.enqueueLaneCheck(book, chapter, verse, lane, next);
    },
    [book, chapter, meUserId, laneIndex, applyLocalLaneCheck],
  );

  // Bulk "all this chapter" for a lane. A fat-finger guard: clicking "all" only
  // REQUESTS the action (opens a confirm); nothing is written until confirmed.
  // Direction: check every applicable verse unless I've already checked them
  // all, in which case clear mine.
  const [pendingBulk, setPendingBulk] = useState<{ lane: CheckLane; checked: boolean; verses: number[] } | null>(null);
  const bulkLaneToggle = useCallback(
    (lane: CheckLane) => {
      if (meUserId == null) return;
      const verses = tileSet
        .filter((t) => t.lanes.find((l) => l.lane === lane)?.applicable)
        .map((t) => t.verse);
      if (verses.length === 0) return;
      const allMine = verses.every((v) => laneIndex.get(laneKey(v, lane))?.includes(meUserId));
      setPendingBulk({ lane, checked: !allMine, verses });
    },
    [meUserId, tileSet, laneIndex],
  );
  // Run the confirmed bulk: optimistic apply + one direct PATCH (deliberate,
  // online action), reconciled from the server response.
  const confirmBulk = useCallback(() => {
    const p = pendingBulk;
    setPendingBulk(null);
    if (!p || meUserId == null) return;
    for (const v of p.verses) applyLocalLaneCheck(v, p.lane, meUserId, p.checked);
    void api
      .setLaneCheckBulk(book, chapter, p.lane, p.checked, p.verses)
      .then((res) => replaceLaneChecksForLane(p.lane, res.checks))
      .catch(() => {
        /* leave optimistic state; a later load reconciles */
      });
  }, [pendingBulk, book, chapter, meUserId, applyLocalLaneCheck, replaceLaneChecksForLane]);

  // In-context checkoff for the resource panels, scoped to the active verse.
  const resourceCheckoff = useMemo<ResourceCheckoff>(() => {
    const applic = (lane: ResourceLane) =>
      laneApplicable(lane, versesWithTn.has(activeVerse), versesWithTq.has(activeVerse));
    const checkersOf = (lane: ResourceLane) => laneIndex.get(laneKey(activeVerse, lane));
    return {
      canCheck: meUserId != null,
      applicable: applic,
      shade: (lane) => (applic(lane) ? shadeFromCheckers(checkersOf(lane), meUserId) : "open"),
      attribution: (lane) => laneAttribution(checkersOf(lane), meUserId, t),
      onToggle: (lane) => toggleLane(activeVerse, lane),
      onBulkToggle: (lane) => bulkLaneToggle(lane),
    };
  }, [activeVerse, laneIndex, versesWithTn, versesWithTq, meUserId, toggleLane, bulkLaneToggle, t]);

  // Text-lane checkoff for the column/book scripture views (per verse). Text is
  // always applicable. Memoized so BookView's memoized verse subtree is stable.
  const textLaneCheck = useMemo<TextLaneCheck>(
    () => ({
      canCheck: meUserId != null,
      shade: (verse) => shadeFromCheckers(laneIndex.get(laneKey(verse, "text")), meUserId),
      attribution: (verse) => laneAttribution(laneIndex.get(laneKey(verse, "text")), meUserId, t),
      onToggle: (verse) => toggleLane(verse, "text"),
    }),
    [laneIndex, meUserId, toggleLane, t],
  );

  // Chapter board (verses × lanes overview) dialog.
  const [boardOpen, setBoardOpen] = useState(false);

  const verseNumbers = useMemo(
    () => tileSet.map((t) => t.verse),
    [tileSet],
  );

  const availableVersions = useMemo(() => {
    const set = new Set<string>(versesForTiles ? Object.keys(versesForTiles) : []);
    // Book mode spans the whole book, so the version set must not collapse when
    // the active chapter is a front-matter chapter (chapter 0) that carries
    // notes but no scripture verses — Find can navigate there (the book-intro
    // note sorts first). Without the union, availableVersions is [] →
    // displayedVersions is [] → BookView renders no columns and every chapter's
    // verseNums is empty: a blank book view that looks like the app crashed.
    if (mode === "book" && bookHook) {
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind !== "ready") continue;
        for (const v of Object.keys(cs.data.verses)) set.add(v);
      }
    }
    return [...set];
  }, [versesForTiles, mode, bookHook?.chapters]);

  // Range-aware lookup: ChapterPayload.verses is keyed by verse_start, so a
  // row anchored mid-bridge (e.g. verse 9 of a `\v 8-9` row) misses a direct
  // verses[bv][row.verse] read. Built once per verses change and shared by
  // the quote-builder / note-anchoring lookups below.
  const verseIndexByVersion = useMemo(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    if (versesForTiles) {
      for (const bv of Object.keys(versesForTiles)) {
        out[bv] = buildVerseIndex(versesForTiles[bv]);
      }
    }
    return out;
  }, [versesForTiles]);

  // ULT verse objects for a verse in the current chapter — feeds ResourceColumn's
  // canonical TWL ordering (by Hebrew/Greek word position in the aligned ULT).
  // Stable identity (only changes when the verse index does) so the twl memos
  // recompute the ULT walk once per alignment change, not on every render.
  const ultVerseObjectsFor = useCallback(
    (verse: number): unknown[] | null => {
      const vo = (verseIndexByVersion["ULT"]?.[verse]?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    },
    [verseIndexByVersion],
  );

  // The widest range row across all versions that covers activeVerse. Used to
  // scope TN/TQ/TWL filtering in ResourceColumn — if UST 6-9 covers the active
  // verse, the user sees notes for verses 6-9, not just the navigated one.
  // For singletons (the common case) this reduces to [activeVerse, activeVerse].
  const displayVerseRange = useMemo<readonly [number, number]>(() => {
    if (!versesForTiles || activeVerse === 0) return [activeVerse, activeVerse] as const;
    let start = activeVerse;
    let end = activeVerse;
    for (const byVerse of Object.values(versesForTiles)) {
      for (const k of Object.keys(byVerse)) {
        const dto = byVerse[Number(k)];
        if (!dto) continue;
        const rEnd = dto.verse_end ?? dto.verse;
        if (dto.verse <= activeVerse && activeVerse <= rEnd) {
          if (dto.verse < start) start = dto.verse;
          if (rEnd > end) end = rEnd;
        }
      }
    }
    return [start, end] as const;
  }, [versesForTiles, activeVerse]);

  const visibleVersions = useMemo(
    () => enabledVersions.filter((v) => availableVersions.includes(v)),
    [enabledVersions, availableVersions],
  );

  // The version set actually shown (falls back to the first available when the
  // user has none enabled). Memoized so its identity is stable across row
  // edits — it's the `enabledVersions` prop ScriptureColumn's memo compares.
  const displayedVersions = useMemo(
    () => (visibleVersions.length > 0 ? visibleVersions : availableVersions.slice(0, 1)),
    [visibleVersions, availableVersions],
  );

  const colsVisible = displayedVersions.length;
  const autoSplit = mode === "columns" ? Math.min(0.75, 0.55 + (colsVisible - 1) * 0.05) : 0.5;
  const effectiveSplit = splitRatio ?? autoSplit;

  // Book-mode chapter list, memoized so ScriptureColumn isn't handed a fresh
  // array on every render (stacked / columns pass undefined — already stable).
  const bookChapterList = useMemo(
    () =>
      bookHook && mode === "book"
        // Chapter 0 included on purpose — BookView renders it as the book
        // front matter block.
        ? (bookHook.summary?.chapters ?? []).map((c) => c.chapter)
        : undefined,
    [bookHook, mode, bookHook?.summary],
  );

  // Pre-load lexicon entries for every UHB Strong's in the loaded chapter
  // AND every loaded chapter in book mode, so the per-word tooltips in the
  // scripture column don't have to fetch on first hover. useLexicon
  // dedupes at module level, so passing this repeatedly is cheap.
  const uhbStrongs = useMemo(() => {
    const set = new Set<string>();
    const collect = (verses: Record<number, VerseDto> | undefined) => {
      if (!verses) return;
      for (const v of Object.values(verses)) {
        const objs = (v.content as { verseObjects?: unknown[] } | null)?.verseObjects;
        if (Array.isArray(objs)) for (const s of collectStrongs(objs)) set.add(s);
      }
    };
    collect(data?.verses?.UHB);
    if (bookHook) {
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind !== "ready") continue;
        collect(cs.data.verses?.UHB);
      }
    }
    return [...set];
  }, [data?.verses, bookHook?.chapters]);
  const lexiconMapRaw = useLexicon(uhbStrongs);
  // useLexicon hands back a fresh Map every render; stabilize its identity so
  // ScriptureColumn's memo can compare it. The map's CONTENT only changes when
  // a Strong's entry resolves, which bumps lexiconLoadedCount and rebases it.
  const lexiconLoadedCount = useMemo(() => {
    let c = 0;
    for (const v of lexiconMapRaw.values()) if (v) c++;
    return c;
  }, [lexiconMapRaw]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const lexiconMap = useMemo(() => lexiconMapRaw, [uhbStrongs, lexiconLoadedCount]);

  // When a tn note OR a twl word row is "active", treat its quote as the
  // highlight source. Notes and words are mutually exclusive; clicking one
  // clears the other. Words use `orig_words` (Hebrew source words) which the
  // same matcher handles directly for UHB and via \zaln-s for ULT/UST.
  const { activeQuote, activeOccurrence } = useMemo(() => {
    if (!data) return { activeQuote: null, activeOccurrence: null };
    // Hover preview wins while it's set — light up the hovered word's location
    // over whatever is clicked-active, then fall back on mouse-leave.
    if (hoveredWordId) {
      const r = data.twl.find((r) => r.id === hoveredWordId);
      if (r) return { activeQuote: r.orig_words ?? null, activeOccurrence: r.occurrence ?? null };
    }
    if (activeNoteId) {
      const r = data.tn.find((r) => r.id === activeNoteId);
      return { activeQuote: r?.quote ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    if (activeWordId) {
      const r = data.twl.find((r) => r.id === activeWordId);
      return { activeQuote: r?.orig_words ?? null, activeOccurrence: r?.occurrence ?? null };
    }
    return { activeQuote: null, activeOccurrence: null };
  }, [activeNoteId, activeWordId, hoveredWordId, data]);

  // Drop a lingering hover preview if the row could unmount without a
  // mouse-leave (keyboard nav / verse change), so the highlight never sticks.
  useEffect(() => {
    setHoveredWordId(null);
  }, [activeVerse, chapter, book]);

  // Reorder "stoplight": while a note is dragged (or for ~3s after an arrow
  // move) ResourceColumn reports the moved note's candidate neighbours; we
  // resolve their quotes and hand them to the scripture column so the active
  // verse lights prev (green underline) / next (red overline) alongside the
  // moved note's existing yellow fill.
  const [reorderPreview, setReorderPreview] = useState<ReorderPreview | null>(null);
  const reorderPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderStickyRef = useRef(false);
  const handleReorderPreview = useCallback((preview: ReorderPreview | null, sticky?: boolean) => {
    // A live (non-sticky) clear — drag end or hover-leave — must not wipe a
    // sticky arrow-move preview that's still counting down.
    if (preview === null && !sticky && reorderStickyRef.current) return;
    if (reorderPreviewTimer.current) {
      clearTimeout(reorderPreviewTimer.current);
      reorderPreviewTimer.current = null;
    }
    reorderStickyRef.current = !!(preview && sticky);
    setReorderPreview(preview);
    // Live previews (drag held / grip-or-arrow hover) pass sticky=false and are
    // cleared on release/leave; arrow moves are momentary, so they linger 5s.
    if (preview && sticky) {
      reorderPreviewTimer.current = setTimeout(() => {
        setReorderPreview(null);
        reorderStickyRef.current = false;
        reorderPreviewTimer.current = null;
      }, 5000);
    }
  }, []);
  useEffect(
    () => () => {
      if (reorderPreviewTimer.current) clearTimeout(reorderPreviewTimer.current);
    },
    [],
  );
  const reorderHighlight = useMemo<ReorderHighlight | null>(() => {
    if (!data || !reorderPreview) return null;
    const find = (id: string | null) => (id ? data.tn.find((r) => r.id === id) ?? null : null);
    const moved = find(reorderPreview.movedId);
    const prev = find(reorderPreview.prevId);
    const next = find(reorderPreview.nextId);
    if (!moved && !prev && !next) return null;
    return {
      movedQuote: moved?.quote ?? null,
      movedOccurrence: moved?.occurrence ?? null,
      prevQuote: prev?.quote ?? null,
      prevOccurrence: prev?.occurrence ?? null,
      nextQuote: next?.quote ?? null,
      nextOccurrence: next?.occurrence ?? null,
    };
  }, [data, reorderPreview]);

  // Quote-builder session: when active, clicking Hebrew words in the UHB
  // row of the active verse toggles them into selectedKeys; "Use selection"
  // converts the set into the row's source quote + occurrence. The target is
  // either a TN note (writes quote/occurrence) or a TWL link (writes
  // orig_words/occurrence). Tied to a specific row so switching selection
  // cancels the session.
  const [quoteBuildTarget, setQuoteBuildTarget] = useState<
    { kind: "tn" | "twl"; id: string } | null
  >(null);
  const [quoteBuildSelectedKeys, setQuoteBuildSelectedKeys] = useState<Set<HighlightKey>>(
    () => new Set(),
  );
  // Commit signal handed to the note card. The card is still active when the
  // picker commits, so its row→quote sync effect is gated by the open session
  // guard; bumping this nonce after the optimistic row patch tells that card
  // to pull the built quote into its local state. nonce increments per commit
  // so re-building the same note twice still fires the effect. (TWL word rows
  // re-seed via their own row→state effect on the optimistic patch, so they
  // don't need this signal.)
  const [quoteBuildAppliedTo, setQuoteBuildAppliedTo] = useState<
    { noteId: string; nonce: number } | null
  >(null);
  useEffect(() => {
    if (!quoteBuildTarget) return;
    const stillActive =
      quoteBuildTarget.kind === "tn"
        ? activeNoteId === quoteBuildTarget.id
        : activeWordId === quoteBuildTarget.id;
    if (!stillActive) {
      setQuoteBuildTarget(null);
      setQuoteBuildSelectedKeys(new Set());
    }
  }, [activeNoteId, activeWordId, quoteBuildTarget]);
  const toggleQuoteBuildWord = useCallback(
    (key: HighlightKey) => {
      setQuoteBuildSelectedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [],
  );
  // Additive multi-select for shift-click range selection in the picker —
  // adds every key in the dragged range without toggling any already-selected
  // word back off (range select is "extend the selection," not "toggle each").
  const selectQuoteBuildWords = useCallback((keys: HighlightKey[]) => {
    setQuoteBuildSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const key of keys) next.add(key);
      return next;
    });
  }, []);
  const startQuoteBuild = useCallback(
    (target: { kind: "tn" | "twl"; id: string }) => {
      setQuoteBuildTarget(target);
      // Pre-seed the selection from the row's existing quote so the translator
      // can ADD to it instead of starting over. Resolves the stored quote +
      // occurrence against the UHB/UGNT verse; an unresolvable quote (e.g.
      // hand-typed English) yields an empty set and the picker starts fresh.
      const row =
        target.kind === "tn"
          ? data?.tn.find((r) => r.id === target.id)
          : data?.twl.find((r) => r.id === target.id);
      const uhb = row
        ? verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse]
        : undefined;
      const verseObjects = (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      // TN stores its source quote in `quote`; TWL stores it in `orig_words`.
      const existingQuote =
        target.kind === "tn" ? (row as TnRow | undefined)?.quote : (row as TwlRow | undefined)?.orig_words;
      setQuoteBuildSelectedKeys(
        row ? selectionFromQuote(verseObjects, existingQuote, row.occurrence) : new Set(),
      );
    },
    [data, verseIndexByVersion],
  );
  const cancelQuoteBuild = useCallback(() => {
    setQuoteBuildTarget(null);
    setQuoteBuildSelectedKeys(new Set());
  }, []);

  // Anchor element for the picker popup. Resolves via the data-note-id
  // attribute set on each NoteCard's Paper — the picker mounts at Shell
  // level so it isn't clipped by the resource column overflow.
  const [quoteBuildAnchor, setQuoteBuildAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!quoteBuildTarget) {
      setQuoteBuildAnchor(null);
      return;
    }
    const selector =
      quoteBuildTarget.kind === "tn"
        ? `[data-note-id="${quoteBuildTarget.id}"]`
        : `[data-word-id="${quoteBuildTarget.id}"]`;
    setQuoteBuildAnchor(document.querySelector<HTMLElement>(selector));
  }, [quoteBuildTarget]);

  // Verse objects bundled for the picker — UHB always; ULT/UST may be
  // absent for OT-only or NT-only deployments, so default to null and
  // let the picker show an empty-state hint.
  const quoteBuildContext = useMemo(() => {
    if (!quoteBuildTarget || !data) return null;
    const row =
      quoteBuildTarget.kind === "tn"
        ? data.tn.find((r) => r.id === quoteBuildTarget.id)
        : data.twl.find((r) => r.id === quoteBuildTarget.id);
    if (!row) return null;
    const grab = (bv: string): unknown[] | null => {
      const dto = verseIndexByVersion[bv]?.[row.verse];
      const vo = (dto?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
      return Array.isArray(vo) ? vo : null;
    };
    return {
      verse: row.verse,
      uhb: grab("UHB") ?? grab("UGNT"),
      ult: grab("ULT"),
      ust: grab("UST"),
    };
  }, [quoteBuildTarget, data, verseIndexByVersion]);

  // Materialize the in-flight quote-build selection into a row patch and
  // fire the existing note save pipe. Pulls UHB verseObjects for the
  // current verse — the buildQuoteFromSelection helper does the grouping
  // and " & " join + occurrence calculation.
  const commitQuoteBuild = useCallback(() => {
    if (!quoteBuildTarget || !data) return;
    const row =
      quoteBuildTarget.kind === "tn"
        ? data.tn.find((r) => r.id === quoteBuildTarget.id)
        : data.twl.find((r) => r.id === quoteBuildTarget.id);
    if (!row) return;
    const uhb = verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse];
    const verseObjects =
      (uhb?.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    const built = buildQuoteFromSelection(verseObjects, quoteBuildSelectedKeys);
    if (!built) return;
    // Only enqueue a save when the build actually changes the stored quote +
    // occurrence — re-running "build from source" over an unchanged selection
    // (or a quote that was itself built this way) must not bump the row version.
    // Compare quotes NFC-normalized: the builder emits raw UHB legacy
    // combining-mark order, while a stored quote may be NFC (typed / AI), so a
    // raw compare would false-positive on visually-identical text — same nfc()
    // rule the highlighter uses. A null stored occurrence means "first", == 1.
    if (quoteBuildTarget.kind === "tn") {
      const note = row as TnRow;
      const changed =
        nfc(built.quote) !== nfc(note.quote ?? "") || built.occurrence !== (note.occurrence ?? 1);
      if (changed) {
        // Optimistic row patch first so row.quote is current for the box-sync below.
        enqueueRow("tn", note, { quote: built.quote, occurrence: built.occurrence });
      }
      // Always signal the card (which stays active) to force the box to the
      // committed quote and rebaseline the session snapshot — the row→box sync
      // effect is otherwise gated by the open session. Idempotent on a true
      // no-op, and on a no-op over unsaved box edits it still lands the quote the
      // user just committed (don't gate this on `changed`).
      setQuoteBuildAppliedTo((prev) => ({ noteId: note.id, nonce: (prev?.nonce ?? 0) + 1 }));
    } else {
      // TWL: the source quote lives in orig_words. The WordRow re-seeds from the
      // optimistic patch (its row→state effect isn't session-gated), so no
      // applied-nonce signal is needed.
      const word = row as TwlRow;
      const changed =
        nfc(built.quote) !== nfc(word.orig_words ?? "") || built.occurrence !== (word.occurrence ?? 1);
      if (changed) {
        enqueueRow("twl", word, { orig_words: built.quote, occurrence: built.occurrence });
      }
    }
    setQuoteBuildTarget(null);
    setQuoteBuildSelectedKeys(new Set());
  }, [quoteBuildTarget, quoteBuildSelectedKeys, data, verseIndexByVersion]);

  // Promote a per-verse TWL suggestion to a real link. Resolve its matched ULT
  // English span to an OL quote + occurrence against the verse alignment
  // (best-effort), create the twl row, and — when the resolution is unsure or
  // empty — open the quote-builder on the new row so the editor confirms. Always
  // goes through createRow("twl") so chapter locks / concurrency are respected.
  const handleAddTwlSuggestion = useCallback(
    async (s: TwlSuggestion, chosenArticleId: string) => {
      if (!data) return;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const ult = grab("ULT");
      const uhb = grab("UHB") ?? grab("UGNT");
      const resolved = resolveSpanToSource(ult, uhb, s.matchedText, s.glOccurrence);

      const twLink = `rc://*/tw/dict/bible/${chosenArticleId}`;
      // Tag follows the CHOSEN article's category, not the server's primary — a
      // disambiguation pick can cross categories (e.g. kt/lawofmoses vs other/law),
      // and the TWL Tags column must match the link actually written.
      const chosenCategory = chosenArticleId.split("/")[0];
      const tag =
        chosenCategory === "kt" ? "keyterm" : chosenCategory === "names" ? "name" : "";
      // Drop the new link into its CANONICAL slot (by Hebrew word position in the
      // aligned ULT), not at the end. Display is already canonical, but assigning
      // a matching sort_order keeps D1 consistent with what export/reimport
      // compute — no churn. Place the stub among the verse's rows via the shared
      // canonical order, then pick a sort_order relative to its canonical
      // neighbour. Falls back to append-at-end when nothing resolves / no ULT.
      const list = sortedForVerse(data.twl, verse);
      const STUB = "__new_twl__";
      const newOrigWords = resolved?.orig_words ?? "";
      const newOccurrence = resolved?.occurrence ?? 1;
      const withNew = canonicalTwlOrder(
        [
          ...list.map((r) => ({
            id: r.id,
            orig_words: r.orig_words,
            occurrence: r.occurrence,
            sort_order: r.sort_order,
          })),
          { id: STUB, orig_words: newOrigWords, occurrence: newOccurrence, sort_order: null },
        ],
        ult ?? null,
      );
      const at = withNew.findIndex((r) => r.id === STUB);
      const prev = at > 0 ? withNew[at - 1] : null;
      const next = at >= 0 && at < withNew.length - 1 ? withNew[at + 1] : null;
      const canonicalExisting = canonicalTwlOrder(list, ult ?? null);
      const sort_order =
        list.length === 0
          ? 100
          : prev
            ? pickSortOrder(canonicalExisting, prev.id, "after")
            : next
              ? pickSortOrder(canonicalExisting, next.id, "before")
              : pickSortOrder(list, null, "after");
      const created = await api.createRow<TwlRow>("twl", {
        book,
        chapter,
        verse,
        ref_raw: verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`,
        orig_words: resolved?.orig_words ?? "",
        occurrence: resolved?.occurrence ?? 1,
        tw_link: twLink,
        ...(tag ? { tags: tag } : {}),
        sort_order,
      });
      applyLocalRowInsert("twl", created);
      setActiveWordId(created.id);
      setActiveNoteId(null);
      // Low-confidence (or nothing resolved) → open the picker on the new row so
      // the editor verifies/completes the quote. Seed the selection directly from
      // what DID resolve, NOT by re-finding the row via startQuoteBuild — the
      // just-inserted row isn't in `data` yet (applyLocalRowInsert's setState
      // hasn't flushed), so a row lookup would pre-seed empty. quoteBuildContext +
      // the anchor effect pick the row up on the next render.
      if (!resolved || !resolved.confident || !resolved.orig_words) {
        setQuoteBuildTarget({ kind: "twl", id: created.id });
        setQuoteBuildSelectedKeys(
          selectionFromQuote(uhb, resolved?.orig_words, resolved?.occurrence),
        );
      }
    },
    [data, activeVerse, verseIndexByVersion, book, chapter],
  );

  // Whether a per-verse suggestion is already covered on the active verse. Done
  // client-side (not on the suggest route) because the match is by RESOLVED
  // original-language identity, which the server can't derive from the English
  // text without the alignment. The tw_link is intentionally ignored: once a word
  // carries any TWL we don't suggest a second article for it. Single words match
  // by source key (occurrence-anchored, tolerant of aligner-folded particles), so
  // occurrence 2 still gets suggested when only occurrence 1 is linked; multi-word
  // phrases are kept unless the identical phrase quote is already linked.
  const isTwlSuggestionExcluded = useCallback(
    (s: TwlSuggestion): boolean => {
      if (!data) return false;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const uhb = grab("UHB") ?? grab("UGNT");
      const resolved = resolveSpanToSource(grab("ULT"), uhb, s.matchedText, s.glOccurrence);
      // Deleted deny-list: this reference + quote was deleted upstream (any
      // article — the table is article-agnostic). Applies regardless of whether
      // the verse currently carries any links, so it runs before the rows check.
      if (resolved && twlFilters.isDeletedHere(`${chapter}:${verse}`, resolved.orig_words)) {
        return true;
      }
      const rows = data.twl.filter((r) => r.verse === verse && r.deleted_at == null);
      if (rows.length === 0) return false;
      // Couldn't resolve to OL — conservatively drop only an exact tw_link repeat.
      if (!resolved) return rows.some((r) => r.tw_link === s.twLink);
      // A multi-word phrase (e.g. "Yahweh of Armies") is its own lexical unit:
      // suggest it even when a component word is already tagged. Only drop it when
      // the identical phrase quote is already linked.
      if (/\s/.test(s.matchedText.trim())) {
        const key = `${nfc(resolved.orig_words)}|${resolved.occurrence}`;
        return rows.some((r) => `${nfc(r.orig_words ?? "")}|${r.occurrence ?? 1}` === key);
      }
      // Single word: once THIS occurrence of the word carries any TWL we don't
      // suggest a second article for it (regardless of article). Compare by source
      // KEY (position/occurrence-anchored) rather than the quote string: the key
      // survives a particle the aligner folds into the quote ("אֶת־יִשְׂרָאֵל" vs the
      // stored "יִשְׂרָאֵל"), while still distinguishing occurrence 2 from occurrence 1.
      const sugKeys = selectionFromQuote(uhb, resolved.orig_words, resolved.occurrence);
      if (sugKeys.size === 0) return false;
      return rows.some((r) => {
        for (const k of selectionFromQuote(uhb, r.orig_words, r.occurrence ?? 1)) {
          if (sugKeys.has(k)) return true;
        }
        return false;
      });
    },
    [data, activeVerse, verseIndexByVersion, chapter, twlFilters],
  );

  // Raw per-verse TWL suggestions for the active verse, reported up from the
  // Suggestions panel (before its exclusion filter). Used to merge the matcher's
  // candidate articles back onto committed rows — see twlRowAlternatives.
  const [verseTwlSuggestions, setVerseTwlSuggestions] = useState<TwlSuggestion[]>([]);

  // Extra TW articles the per-verse matcher would propose for a committed row's
  // source word(s), keyed by row id. The committed-row disambiguation badge
  // otherwise only offers heading-synonym siblings of the current link (built
  // from article titles, variant-blind), so a wrong link like kt/love on
  // "lovers" can't reach the morphologically-correct other/lover. Matching the
  // matcher's suggestions back onto the row by source-key surfaces it. Values are
  // short article ids (e.g. "other/lover").
  const twlRowAlternatives = useMemo<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    if (!data || verseTwlSuggestions.length === 0) return map;
    const verse = activeVerse;
    const grab = (bv: string): unknown[] | undefined => {
      const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      return Array.isArray(vo) ? vo : undefined;
    };
    const ult = grab("ULT");
    const uhb = grab("UHB") ?? grab("UGNT");
    const rows = data.twl.filter((r) => r.verse === verse && r.deleted_at == null);
    if (rows.length === 0) return map;
    // Resolve each suggestion once to its source-key set + candidate ids, and
    // reapply the same deny-lists the Suggestions panel uses — otherwise a word
    // deleted-here, or a (word, article) pair a translator specifically
    // unlinked, would resurface as a "suggested" alternative on the row.
    const sugs = verseTwlSuggestions
      .map((s) => {
        const resolved = resolveSpanToSource(ult, uhb, s.matchedText, s.glOccurrence);
        if (!resolved) return null;
        if (twlFilters.isDeletedHere(`${chapter}:${verse}`, resolved.orig_words)) return null;
        const keys = selectionFromQuote(uhb, resolved.orig_words, resolved.occurrence);
        if (keys.size === 0) return null;
        const ids = s.disambiguation.filter(
          (id) => !twlFilters.isUnlinked(resolved.orig_words, `rc://*/tw/dict/bible/${id}`),
        );
        return ids.length > 0 ? { keys, ids } : null;
      })
      .filter((x): x is { keys: Set<string>; ids: string[] } => x != null);
    for (const r of rows) {
      const rowKeys = selectionFromQuote(uhb, r.orig_words, r.occurrence ?? 1);
      if (rowKeys.size === 0) continue;
      const ids = new Set<string>();
      for (const s of sugs) {
        let overlap = false;
        for (const k of s.keys) {
          if (rowKeys.has(k)) {
            overlap = true;
            break;
          }
        }
        if (overlap) for (const id of s.ids) ids.add(id);
      }
      if (ids.size > 0) map.set(r.id, [...ids]);
    }
    return map;
  }, [data, activeVerse, verseIndexByVersion, verseTwlSuggestions, twlFilters, chapter]);

  // Which of a suggestion's candidate articles the unlinked deny-list blocks for
  // its resolved OL quote. Returned to TwlSuggestions, which prunes them from the
  // picker (and drops the suggestion when all are blocked). The deny-list is
  // (word, article), so only the matching article is removed — e.g. kt/sonofgod
  // for a Hebrew "son" word, while kt/son survives. Unresolvable → block nothing.
  const twlBlockedArticleIds = useCallback(
    (s: TwlSuggestion, candidateIds?: string[]): Set<string> => {
      const blocked = new Set<string>();
      if (!data) return blocked;
      const verse = activeVerse;
      const grab = (bv: string): unknown[] | undefined => {
        const vo = (verseIndexByVersion[bv]?.[verse]?.content as { verseObjects?: unknown[] } | null)
          ?.verseObjects;
        return Array.isArray(vo) ? vo : undefined;
      };
      const resolved = resolveSpanToSource(
        grab("ULT"),
        grab("UHB") ?? grab("UGNT"),
        s.matchedText,
        s.glOccurrence,
      );
      if (!resolved) return blocked;
      // Check the full candidate set the picker will show (server disambiguation
      // plus any global-family siblings the UI merged in), not just
      // s.disambiguation — otherwise a family sibling on the unlinked deny-list
      // would slip past the block and be addable.
      for (const id of candidateIds ?? s.disambiguation) {
        if (twlFilters.isUnlinked(resolved.orig_words, `rc://*/tw/dict/bible/${id}`)) blocked.add(id);
      }
      return blocked;
    },
    [data, activeVerse, verseIndexByVersion, twlFilters],
  );

  // Routes any verse / version / aligner-target change through the dirty
  // gate when the alignment panel has unsaved drags. Plain wrapper around
  // setState if the gate is clear; otherwise queues for the popup.
  //
  // The gate reads panelMode / alignmentDirty through refs, NOT the state
  // values, so its identity is stable. Memoized children (ScriptureColumn,
  // InactiveVerseRow) deliberately skip comparing callback props, so a
  // callback that closed over the state would go stale inside them and let
  // navigation bypass the gate — silently dropping unsaved alignment drags.
  // Layout effect (not passive) so the refs are current before any
  // subsequent click can read them. Browser back/forward remounts the Shell
  // entirely, so that navigation path stays ungated here.
  const panelModeRef = useRef(panelMode);
  const alignmentDirtyRef = useRef(alignmentDirty);
  useLayoutEffect(() => {
    panelModeRef.current = panelMode;
    alignmentDirtyRef.current = alignmentDirty;
  }, [panelMode, alignmentDirty]);
  const runWithDirtyGate = useCallback((apply: () => void) => {
    if (panelModeRef.current === "alignment" && alignmentDirtyRef.current) {
      setPendingNav({ run: apply });
    } else {
      apply();
    }
  }, []);

  // Tapping a band-switcher tab unmounts the outgoing region exactly like
  // setRegionHidden's close does (see its dirty-gate comment further down): an
  // alignment panel's unsaved drags live only in component state and never
  // reach the outbox, so switching the switcher's focus without this gate
  // would silently drop them the same way an ungated close would.
  const focusRegionWithGate = useCallback(
    (id: string) => runWithDirtyGate(() => setFocusedRegionId(id)),
    [runWithDirtyGate],
  );

  const requestSelectVerse = useCallback(
    (v: number) => {
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
      });
    },
    [runWithDirtyGate],
  );

  // Notes the find overlay's TN scope searches. Single chapter in stacked /
  // columns mode; every loaded chapter in book mode. Reads dataRef so the
  // getter sees live notes (post-keystroke) without forcing the memoized
  // ScriptureColumn to re-render on every edit. Identity only churns on
  // mode / book-cache changes, both of which ScriptureColumn already re-renders
  // for, so the overlay always receives a current getter.
  // Find-in-notes highlight state, lifted from the overlay (which lives inside
  // ScriptureColumn) so the sibling ResourceColumn's note cards can paint
  // matches. `findNoteQuery` marks every match; `activeNoteMatch` emphasizes
  // the one the user is navigating to.
  const [findNoteQuery, setFindNoteQuery] = useState<
    { find: string; regex: boolean; caseSensitive: boolean } | null
  >(null);
  const [activeNoteMatch, setActiveNoteMatch] = useState<
    { noteId: string; occurrence: number } | null
  >(null);

  const getSearchNotes = useCallback((): TnRow[] => {
    if (mode === "book" && bookHook) {
      const out: TnRow[] = [];
      for (const cs of bookHook.chapters.values()) {
        if (cs.kind === "ready") out.push(...cs.data.tn);
      }
      return out;
    }
    return dataRef.current?.tn ?? [];
  }, [mode, bookHook]);

  // Navigate to + activate a TN match from the find overlay. Cross-chapter
  // (book mode) routes through the URL so the chapter payload reloads; the
  // common same-chapter case just focuses the verse + note, and the bumped
  // scrollNonce makes the resource column scroll it into view.
  const focusNoteMatch = useCallback(
    (ch: number, v: number, noteId: string) => {
      runWithDirtyGate(() => {
        if (ch !== chapter) {
          // The hash carries only book/chapter/verse; stash the note id so the
          // remounted Shell can activate + scroll to it once its payload loads.
          pendingNoteJump = { book, chapter: ch, noteId };
          onNavigate?.(book, ch, v);
          return;
        }
        setActiveVerse(v);
        setActiveWordId(null);
        setActiveNoteId(noteId);
        setScrollNonce((n) => n + 1);
      });
    },
    [runWithDirtyGate, chapter, book, onNavigate],
  );

  // Jump to a lint issue from the topbar indicator. `ref` is "chapter:verse"
  // (or bare "chapter"). TN findings carry a rowId, so reuse focusNoteMatch —
  // the same note-jump mechanism the find overlay uses (same-chapter focuses
  // the note; cross-chapter stashes pendingNoteJump and navigates). ULT/UST
  // findings have no row, so just navigate to the verse through the dirty gate.
  const goToLintIssue = useCallback(
    (issue: BookLintIssue) => {
      const [chStr, vStr] = issue.ref.split(":");
      const ch = parseInt(chStr, 10);
      if (Number.isNaN(ch)) return;
      const v = vStr ? parseInt(vStr, 10) : 1;
      const verse = Number.isNaN(v) ? 1 : v;
      if (issue.resource === "tn" && issue.rowId) {
        focusNoteMatch(ch, verse, issue.rowId);
        return;
      }
      runWithDirtyGate(() => {
        setActiveVerse(verse);
        setActiveNoteId(null);
        setActiveWordId(null);
        onNavigate?.(book, ch, verse);
      });
    },
    [focusNoteMatch, runWithDirtyGate, book, onNavigate],
  );

  // App keys Shell on book only, so a cross-chapter navigation (URL /
  // back-forward / TopBar / cross-chapter find) changes the chapter +
  // initialVerse props WITHOUT remounting — useChapter keeps the prior
  // chapter's data visible while the new payload loads, so there's no loading
  // flash and find/book-view state survive. This effect does what the old
  // remount used to: reset the per-chapter transient state. Keyed on
  // [chapter, initialVerse] — internal same-chapter verse selection sets
  // activeVerse directly without an URL push, so initialVerse doesn't change
  // and this won't clobber it. Skips the initial mount by comparing against the
  // mounted position rather than a "has run" flag: StrictMode's dev-only second
  // effect pass would otherwise read as a navigation and reset the mount state,
  // including a row seeded from initialWordId. initialWordId is part of the key
  // and becomes the active word, so a ?twl= navigation while Shell is already
  // mounted (back/forward, or a hash that changes only ?twl=) selects that row
  // instead of clearing it. ResourceColumn reads initialTab only when it
  // mounts, so such a change also sends it a requestTab to show Words (#535).
  const chapterResetKey = useRef(`${chapter}:${initialVerse}:${initialWordId ?? ""}`);
  useEffect(() => {
    const key = `${chapter}:${initialVerse}:${initialWordId ?? ""}`;
    if (chapterResetKey.current === key) return;
    chapterResetKey.current = key;
    setActiveVerse(initialVerse);
    setActiveNoteId(null);
    setActiveWordId(initialWordId);
    if (initialWordId !== null) setWordsTabRequest((r) => ({ tab: "words", nonce: (r?.nonce ?? 0) + 1 }));
    setAlignerTarget(null);
    setDualTarget(null);
    setPanelMode("resources");
    setAlignmentDirty(false);
    setDualLeftDirty(false);
    setDualRightDirty(false);
    setDualLeftReadingDirty(false);
    setDualRightReadingDirty(false);
    setPendingNav(null);
    setPendingDualAction(null);
  }, [chapter, initialVerse, initialWordId]);

  // A front-matter / intro chapter (chapter 0) has only the intro tile (verse 0)
  // and no real verses. Navigation defaults activeVerse to 1, which doesn't
  // exist there, so the intro note stayed hidden until the user clicked "i" on
  // the rail. Once this chapter's tiles are known, snap to verse 0 so the intro
  // note — the only thing in the chapter — shows on arrival.
  useEffect(() => {
    // Gate on data.chapter === chapter: useChapter keeps the *prior* chapter's
    // payload visible while the new one loads, so acting on stale tiles would
    // wrongly snap to 0 when navigating from an intro chapter into a real one.
    if (!data || data.chapter !== chapter || activeVerse === 0) return;
    if (verseNumbers.length > 0 && verseNumbers.every((v) => v === 0)) {
      setActiveVerse(0);
    }
  }, [data, chapter, verseNumbers, activeVerse]);

  // Consume a cross-chapter TN-find jump stashed before navigation. Waits for
  // this chapter's payload (and the target note row) to load, then activates +
  // scrolls to the note. Cleared on consume; ignored if the stash targets a
  // different book/chapter (e.g. the user navigated elsewhere in the meantime).
  useEffect(() => {
    const jump = pendingNoteJump;
    if (!jump) return;
    if (jump.book !== book || jump.chapter !== chapter) return;
    if (!data) return;
    if (!data.tn.some((r) => r.id === jump.noteId)) return;
    pendingNoteJump = null;
    setActiveWordId(null);
    setActiveNoteId(jump.noteId);
    setScrollNonce((n) => n + 1);
  }, [data, book, chapter]);

  // Keep the alignment target's verse in step with the active verse while
  // we're in alignment mode. Bible version is sticky — only LinkIcon clicks
  // change it. Effect, not direct setter, so it survives both rail clicks
  // and book-mode chapter swaps.
  useEffect(() => {
    if (panelMode !== "alignment") return;
    if (!alignerTarget) return;
    if (alignerTarget.verse === activeVerse && alignerTarget.chapter === chapter) return;
    setAlignerTarget({ ...alignerTarget, chapter, verse: activeVerse });
  }, [activeVerse, chapter, panelMode, alignerTarget]);

  const laneAllowsAlignment = useCallback(
    (bv: string): boolean => {
      // Local freeze flag covers the window before projectConfig refresh.
      if (isLaneFrozen(bv)) return false;
      if (bv === "ULT") {
        const lit = projectConfig?.laneState?.lit;
        if (lit?.replacementJobId || lit?.replacementRequired) return false;
        return lit?.config?.alignmentWritable !== false;
      }
      if (bv === "UST") {
        const sim = projectConfig?.laneState?.sim;
        if (sim?.replacementJobId || sim?.replacementRequired) return false;
        return sim?.config?.alignmentWritable !== false;
      }
      // Source versions (UHB/UGNT) are never alignment targets here.
      return true;
    },
    [projectConfig],
  );

  const openAligner = useCallback(
    (chapterNum: number, v: number, bv: string) => {
      if (!laneAllowsAlignment(bv)) {
        pushPipelineToast(t("shell.alignmentLocked", { version: bv }), "info");
        return;
      }
      runWithDirtyGate(() => {
        setAlignerTarget({ chapter: chapterNum, verse: v, bibleVersion: bv });
        setActiveVerse(v);
        setActiveNoteId(null);
        setActiveWordId(null);
        setPanelMode("alignment");
      });
    },
    [runWithDirtyGate, laneAllowsAlignment, pushPipelineToast, t],
  );

  // Open the side-by-side ULT/UST aligner on a verse. Layered over the UI as a
  // Dialog (orthogonal to panelMode), so it gates only on the single panel's
  // unsaved drags before opening.
  const openDualAligner = useCallback(
    (chapterNum: number, v: number) => {
      if (!laneAllowsAlignment("ULT") || !laneAllowsAlignment("UST")) {
        pushPipelineToast(t("shell.alignmentLocked", { version: "ULT/UST" }), "info");
        return;
      }
      runWithDirtyGate(() => {
        setActiveVerse(v);
        setDualTarget({ chapter: chapterNum, verse: v });
      });
    },
    [runWithDirtyGate, laneAllowsAlignment, pushPipelineToast, t],
  );
  // Any action that leaves or re-targets the dual aligner gates on unsaved work
  // — alignment drags OR reading-text edits in either panel (save/discard
  // prompt) — shared by close + verse nav.
  const dualDirty =
    dualLeftDirty || dualRightDirty || dualLeftReadingDirty || dualRightReadingDirty;
  // Guard full-page unloads (reload / tab close / external nav) against losing
  // unsaved work — the paths that bypass the in-app dirty gate below. Covers
  // in-memory alignment + reading dirtiness here plus unsaved drafts internally.
  useUnsavedGuard(alignmentDirty || dualDirty);

  // Save-aware reload for the "App update available" chip. A bare reload would
  // drop unsaved in-memory alignment drags (they only reach the durable outbox
  // on save). If the single alignment panel is dirty, save first, then wait for
  // the enqueue to commit to IndexedDB — outbox.list() opens a readonly tx that
  // IndexedDB serializes AFTER the save's write, so its resolution means the op
  // is durably queued (it survives the reload and drains after) — before
  // tearing the page down. Text/note/row drafts already persist across reload;
  // the beforeunload guard covers the other unload paths.
  const reloadForUpdate = useCallback(() => {
    const reload = () => window.location.reload();
    if (panelMode === "alignment" && alignmentDirty && alignmentPanelRef.current) {
      alignmentPanelRef.current.save(() => {
        void outbox.list().then(reload);
      });
    } else {
      reload();
    }
  }, [panelMode, alignmentDirty]);
  const requestDualAction = useCallback(
    (run: () => void) => {
      if (dualDirty) setPendingDualAction({ run });
      else run();
    },
    [dualDirty],
  );
  const requestCloseDual = useCallback(
    () => requestDualAction(() => setDualTarget(null)),
    [requestDualAction],
  );
  const dualNavTo = useCallback(
    (v: number) =>
      requestDualAction(() => {
        setActiveVerse(v);
        setDualTarget((t) => (t ? { ...t, verse: v } : t));
      }),
    [requestDualAction],
  );
  const resolveDualAction = useCallback(
    (choice: "save" | "discard") => {
      const action = pendingDualAction;
      setPendingDualAction(null);
      // Only touch the dirty panel(s): save() serializes + enqueues a PATCH
      // unconditionally, so calling it on the clean side would bump that
      // version row for nothing (and could 409 against a concurrent editor).
      if (choice === "discard") {
        if (dualLeftDirty) dualLeftRef.current?.discard();
        if (dualRightDirty) dualRightRef.current?.discard();
        if (dualLeftReadingDirty) dualLeftReadingRef.current?.discard();
        if (dualRightReadingDirty) dualRightReadingRef.current?.discard();
        action?.run();
        return;
      }
      // Save. Reading-line edits are plain text — synchronous, no unalign confirm.
      if (dualLeftReadingDirty) dualLeftReadingRef.current?.save();
      if (dualRightReadingDirty) dualRightReadingRef.current?.save();
      // Each alignment panel may defer behind the unalign confirm, so CHAIN them:
      // run the close/nav only after both have actually committed. Chaining (vs.
      // firing both saves up front) also guarantees at most one unalign confirm is
      // open at a time — the right panel's confirm opens only after the left one
      // resolves — so a second setPendingAlignmentLoss can't clobber the first
      // pending commit. A cancel anywhere in the chain stops the close entirely.
      const finish = () => action?.run();
      const saveRight = () => {
        if (dualRightDirty && dualRightRef.current) dualRightRef.current.save(finish);
        else finish();
      };
      if (dualLeftDirty && dualLeftRef.current) dualLeftRef.current.save(saveRight);
      else saveRight();
    },
    [pendingDualAction, dualLeftDirty, dualRightDirty, dualLeftReadingDirty, dualRightReadingDirty],
  );

  const handleSetPanelMode = useCallback(
    (mode: PanelMode) => {
      // Route through the dirty gate so leaving alignment mode with unsaved
      // drags (to Search or any sibling tab) prompts save/discard instead of
      // silently unmounting AlignmentPanel and dropping the edits. The gate is
      // a no-op unless we're currently in dirty alignment, so entering
      // alignment and all clean switches still apply immediately.
      runWithDirtyGate(() => {
        if (mode === "alignment" && !alignerTarget) {
          // Same freeze/lock gate as openAligner — don't open AVD/ULT during
          // a local freeze before projectConfig refresh lands.
          if (!laneAllowsAlignment("ULT")) {
            pushPipelineToast(t("shell.alignmentLocked", { version: "ULT" }), "info");
            return;
          }
          setAlignerTarget({ chapter, verse: activeVerse, bibleVersion: "ULT" });
        }
        setPanelMode(mode);
      });
    },
    [runWithDirtyGate, alignerTarget, chapter, activeVerse, laneAllowsAlignment, pushPipelineToast, t],
  );

  const dismissPendingNav = useCallback(() => setPendingNav(null), []);
  const resolvePendingNav = useCallback(
    (choice: "save" | "discard") => {
      const nav = pendingNav;
      setPendingNav(null);
      if (!nav) return;
      if (choice === "discard") {
        alignmentPanelRef.current?.discard();
        nav.run();
        return;
      }
      // Save: the panel may defer behind the unalign confirm, so DON'T navigate
      // up front. Pass nav.run as the afterCommit — save() runs it once the save
      // actually lands (immediately on a clean save, or after "Save anyway"), and
      // never if the user cancels the confirm. Without a panel, just navigate.
      const ref = alignmentPanelRef.current;
      if (ref) ref.save(nav.run);
      else nav.run();
    },
    [pendingNav],
  );

  const enqueueVerseSafely = useCallback((
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    base: VerseDto,
    content: unknown,
    plainText: string,
    intent: AlignmentIntent,
    expectedVersion = base.version,
    // Local-cache apply to run AFTER the save is committed. For the synchronous
    // success path the caller still applies it itself; this is invoked by the
    // confirm-commit below (text_edit) so a deferred "Save anyway" updates the
    // cache too.
    onConfirmedApply?: () => void,
    // Exact draft generation this save captured (see draftSaveState.ts) —
    // rides on the op so the eventual 200 clears only that draft, never newer
    // typing that landed while the request was in flight.
    draftGeneration?: string,
  ): boolean => {
    const delta = analyzeAlignmentDelta(base.content, content);
    // Block any save that collaterally de-aligns untouched words. The enforced
    // predicate lives in guardBlocksSave — DO NOT inline a narrowing such as
    // `delta.wordSequenceUnchanged` here. That narrowing (commit 6980fd72) is
    // exactly what let 1CH 4:21 / NUM 24 ship: a one-word spelling edit flips
    // wordSequenceUnchanged to false, so the narrowed guard never fired and the
    // collateral loss reached master. See guardBlocksSave for the full rationale.
    if (guardBlocksSave(delta, intent)) {
      const lost = delta.unexpectedLosses.map((loss) => loss.text);
      // text_edit: a reword/reorder the edit engine can't keep aligned (e.g.
      // relocating an aligned phrase across \q lines, or a verse whose UNCHANGED
      // region holds a split-unit word like "Yahweh's" that disqualifies the
      // occurrence-keyed reassembly tier — ZEC 9:1). Rather than DISCARD the
      // translator's keystroke draft, surface the same confirm the aligner uses;
      // on "Save anyway" re-enqueue with the alignment_edit intent — the only
      // guard-exempt intent, mirrored in the API (verses.ts), so the PATCH MUST
      // climb as alignment_edit or it is rejected there too. The affected words
      // land unaligned for the translator to re-align in the Alignment panel.
      if (intent === "text_edit") {
        setPendingAlignmentLoss({
          ref: `${book} ${chapterNum}:${verseNum} ${bibleVersion}`,
          lostWords: lost,
          commit: () => {
            void outbox.enqueueVerse(
              book,
              chapterNum,
              verseNum,
              bibleVersion,
              expectedVersion,
              { content, plain_text: plainText, alignment_intent: "alignment_edit" },
              { sourceGeneration: base.source_generation, draftGeneration },
            );
            onConfirmedApply?.();
          },
        });
        return false;
      }
      // find_replace / section_edit: keep the hard block + toast. There is no
      // keystroke draft to preserve, and find/replace-all can touch many verses
      // at once — a single shared confirm dialog would clobber across them.
      const sample = lost.slice(0, 3).join(", ");
      const ref = `${book} ${chapterNum}:${verseNum}`;
      pushPipelineToast(
        t("shell.cantPreserveAlignment", {
          ref,
          bibleVersion,
          affected: sample ? t("shell.affectedSuffix", { sample }) : "",
        }),
        "error",
      );
      return false;
    }
    void outbox.enqueueVerse(
      book,
      chapterNum,
      verseNum,
      bibleVersion,
      expectedVersion,
      { content, plain_text: plainText, alignment_intent: intent },
      { sourceGeneration: base.source_generation, draftGeneration },
    );
    return true;
  }, [book, pushPipelineToast, t]);

  // Compute the alignment panel's props from the current chapter cache.
  // Memoized so identity stays stable when the chapter hasn't changed under
  // it; the panel uses verse identity to re-init its internal state.
  const alignmentTabProps = useMemo<AlignmentTabProps | undefined>(() => {
    if (!alignerTarget) return undefined;
    if (!data) return undefined;
    const sameChapter = alignerTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(alignerTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    // Multi-verse target (e.g. UST 6-9): buildAlignerSlice expands the source
    // side by concatenating per-verse UHB/UGNT rows across the span and widens
    // the TWL list to every verse the range covers.
    const { sourceLabel, targetVerse, sourceVerse, twlForVerse } = buildAlignerSlice(
      sourceData,
      alignerTarget.verse,
      alignerTarget.bibleVersion,
    );
    return {
      book,
      chapter: alignerTarget.chapter,
      verseNum: alignerTarget.verse,
      bibleVersion: alignerTarget.bibleVersion,
      verse: targetVerse,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave: (content, plain, _expectedVersion) => {
        // Key the PATCH by the resolved row's verse_start — alignerTarget.verse
        // may sit INSIDE a range row (v7 of a UST 6-9 block) now that the
        // slice resolves through buildVerseIndex.
        if (targetVerse) {
          enqueueVerseSafely(
            alignerTarget.chapter,
            targetVerse.verse,
            alignerTarget.bibleVersion,
            targetVerse,
            content,
            plain,
            "alignment_edit",
            _expectedVersion,
          );
        }
        // Optimistically fold the new alignment into the local chapter cache so
        // content-derived UI (the broken-alignment link, OL-anchored note
        // highlights) updates immediately instead of waiting for a refetch.
        // Mirrors the verse-text / section save paths; the outbox 200 handler
        // bumps the version, so we keep targetVerse's version here.
        if (targetVerse) {
          const newDto = { ...targetVerse, content, plain_text: plain } as VerseDto;
          bookHook?.applyLocalVerse(newDto);
          if (alignerTarget.chapter === chapter) applyLocalVerse(newDto);
        }
      },
      onConfirmUnalign: (lostWords, commit) =>
        setPendingAlignmentLoss({
          ref: `${book} ${alignerTarget.chapter}:${targetVerse?.verse ?? alignerTarget.verse} ${alignerTarget.bibleVersion}`,
          lostWords,
          commit,
        }),
      onCancel: () => {
        setPanelMode("resources");
      },
      onDirtyChange: setAlignmentDirty,
      panelRef: alignmentPanelRef,
      onOpenDual: () => openDualAligner(alignerTarget.chapter, alignerTarget.verse),
      onRestoreVersion: targetVerse
        ? (content, plainText) =>
            restoreVerse(
              alignerTarget.chapter,
              targetVerse.verse,
              alignerTarget.bibleVersion,
              content,
              plainText,
              targetVerse,
            )
        : undefined,
    };
  }, [alignerTarget, data, chapter, bookHook, book, openDualAligner, applyLocalVerse, enqueueVerseSafely]);

  // Props for the side-by-side popup: ULT + UST slices against one shared
  // source. Undefined (popup closed) unless a dualTarget is set and at least
  // one of the two versions exists for the verse.
  const dualAlignerProps = useMemo(() => {
    if (!dualTarget || !data) return undefined;
    const sameChapter = dualTarget.chapter === chapter;
    const bookData =
      !sameChapter && bookHook
        ? (() => {
            const cs = bookHook.chapters.get(dualTarget.chapter);
            return cs?.kind === "ready" ? cs.data : null;
          })()
        : null;
    const sourceData = sameChapter ? data : bookData;
    if (!sourceData) return undefined;
    const ult = buildAlignerSlice(sourceData, dualTarget.verse, "ULT");
    const ust = buildAlignerSlice(sourceData, dualTarget.verse, "UST");
    if (!ult.targetVerse && !ust.targetVerse) return undefined;
    const sourceLabel = ult.sourceLabel; // identical across versions
    // The shared strip shows the UNION span so a multi-verse UST and a
    // per-verse ULT both see the Hebrew they reference. Each PANEL keeps its
    // own slice's source (only the verses its target covers) — aligning to it
    // is what gets serialized into zaln milestones, and the union would let a
    // single-verse panel reference Hebrew outside its verse. posOffset bridges
    // panel positions into the union for the lifted hover.
    const rangeStart = Math.min(ult.rangeStart, ust.rangeStart);
    const rangeEnd = Math.max(ult.rangeEnd, ust.rangeEnd);
    const byStart = sourceData.verses[sourceLabel] ?? {};
    const sourceVerse =
      rangeEnd > rangeStart
        ? concatSourceRange(byStart, rangeStart, rangeEnd)
        : byStart[rangeStart] ?? null;
    const offsetFor = (ownStart: number) => {
      let off = 0;
      for (let v = rangeStart; v < ownStart; v++) off += countSourceWords(byStart[v]);
      return off;
    };
    const twlForVerse = sourceData.twl.filter((r) => r.verse >= rangeStart && r.verse <= rangeEnd);
    const labelVerse = ult.targetVerse ?? ust.targetVerse;
    const vref = `${book} ${dualTarget.chapter}:${
      labelVerse ? formatVerseLabel(labelVerse) : dualTarget.verse
    }`;
    // PATCH key is the resolved row's verse_start — dualTarget.verse may sit
    // inside a range row now that slices resolve through buildVerseIndex.
    const enqueue = (bibleVersion: string, row: VerseDto | null) =>
      (content: unknown, plain: string, _expectedVersion: number) => {
        if (!row) return;
        enqueueVerseSafely(
          dualTarget.chapter,
          row.verse,
          bibleVersion,
          row,
          content,
          plain,
          "alignment_edit",
          _expectedVersion,
        );
        // Optimistic local update so content-derived UI (the broken-alignment
        // link) refreshes immediately — same as the single-panel aligner.
        const newDto = { ...row, content, plain_text: plain } as VerseDto;
        bookHook?.applyLocalVerse(newDto);
        if (dualTarget.chapter === chapter) applyLocalVerse(newDto);
      };
    const confirmUnalign = (bibleVersion: string, row: VerseDto | null) =>
      (lostWords: string[], commit: () => void) =>
        setPendingAlignmentLoss({
          ref: `${book} ${dualTarget.chapter}:${row?.verse ?? dualTarget.verse} ${bibleVersion}`,
          lostWords,
          commit,
        });
    const left: PanelSlot = {
      bibleVersion: "ULT",
      verse: ult.targetVerse,
      sourceVerse: ult.sourceVerse,
      twlForVerse: ult.twlForVerse,
      posOffset: offsetFor(ult.rangeStart),
      onSave: enqueue("ULT", ult.targetVerse),
      onConfirmUnalign: confirmUnalign("ULT", ult.targetVerse),
      onDirtyChange: setDualLeftDirty,
      panelRef: dualLeftRef,
      onReadingDirtyChange: setDualLeftReadingDirty,
      readingRef: dualLeftReadingRef,
    };
    const right: PanelSlot = {
      bibleVersion: "UST",
      verse: ust.targetVerse,
      sourceVerse: ust.sourceVerse,
      twlForVerse: ust.twlForVerse,
      posOffset: offsetFor(ust.rangeStart),
      onSave: enqueue("UST", ust.targetVerse),
      onConfirmUnalign: confirmUnalign("UST", ust.targetVerse),
      onDirtyChange: setDualRightDirty,
      panelRef: dualRightRef,
      onReadingDirtyChange: setDualRightReadingDirty,
      readingRef: dualRightReadingRef,
    };
    return {
      book,
      chapter: dualTarget.chapter,
      verseNum: dualTarget.verse,
      vref,
      sourceLabel,
      sourceVerse,
      twlForVerse,
      left,
      right,
    };
  }, [dualTarget, data, chapter, bookHook, book, applyLocalVerse, enqueueVerseSafely]);

  // Prev/next verse for the dual aligner's titlebar arrows, within the current
  // chapter's verse list (excluding the intro tile). Null at the ends.
  const dualNav = useMemo(() => {
    if (!dualAlignerProps || dualAlignerProps.chapter !== chapter) {
      return { prev: null as number | null, next: null as number | null };
    }
    const nums = verseNumbers.filter((v) => v > 0);
    const idx = nums.indexOf(dualAlignerProps.verseNum);
    if (idx === -1) return { prev: null, next: null };
    return { prev: nums[idx - 1] ?? null, next: nums[idx + 1] ?? null };
  }, [dualAlignerProps, chapter, verseNumbers]);

  const alignmentBadge = alignerTarget
    ? `${alignerTarget.chapter}:${
        alignerTarget.verse === 0
          ? "i"
          : alignmentTabProps?.verse
            ? formatVerseLabel(alignmentTabProps.verse)
            : alignerTarget.verse
      }`
    : undefined;

  // Initial load (or retry from scratch) — no data to show yet. Render the
  // TopBar anyway (it fetches its own book list, and includes SyncStatusBar)
  // so a bad deep link / 404 chapter still leaves the user a way to navigate
  // out and an offline user sees their connection state. Navigation here is
  // deliberately ungated — the alignment panel and the dirty-confirm dialog
  // only mount in the data branch, so runWithDirtyGate would soft-lock.
  if (!data) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          // 100vh includes mobile browsers' retractable URL bar, so the
          // status bar ends up under browser chrome. 100dvh (dynamic
          // viewport height) excludes it; the plain 100vh above is the
          // fallback for browsers that don't support dvh yet.
          height: "100vh",
          "@supports (height: 100dvh)": { height: "100dvh" },
        }}
      >
        <TopBar
          book={book}
          chapter={chapter}
          verse={activeVerse}
          onNavigate={(b, c, v) => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            onNavigate?.(b, c, v);
          }}
          // Layout switcher is available even with no chapter data — it's a
          // workspace-level control, and an empty/new project should still show
          // it. No scripture/alignment to sync here, so the handler just sets +
          // persists the active id; the data branch's selectLayout takes over
          // once a chapter loads.
          layouts={builtinLayouts}
          userLayouts={userLayouts}
          activeLayoutId={activeLayout.id}
          onSelectLayout={(id) => {
            setActiveLayoutIdState(id);
            persistActiveLayoutId(id);
          }}
          pipelineToast={pipelineToast}
          onPipelineToastClear={() => setPipelineToast(null)}
          lintFlagIssues={bookLint.flagIssues}
          lintFlagCount={bookLint.flagCount}
          lintEscalateCount={bookLint.escalateCount}
          onGoToLintIssue={goToLintIssue}
          onOpenExportMenu={(anchorEl) => exportUsfmRef.current?.openMenu(anchorEl)}
          username={meUsername}
          onLogout={onLogout}
        />
        <ExportUsfmButton
          ref={exportUsfmRef}
          hideTrigger
          book={book}
          chapter={chapter}
          enabledVersions={displayedVersions}
          chapterVersesFor={() => []}
        />
        <Box sx={{ p: 4, display: "flex", alignItems: "center", gap: 2 }}>
          {status === "error" ? (
            <Alert severity="error">{t("shell.failedToLoad", { book, chapter, error })}</Alert>
          ) : (
            <>
              <CircularProgress size={20} />
              <Typography variant="body2">
                {status === "retrying" ? t("shell.reconnecting", { attempt: retryAttempts }) : t("shell.loadingChapter", { book, chapter })}
              </Typography>
            </>
          )}
        </Box>
      </Box>
    );
  }

  const enqueueRow = <T extends TnRow | TqRow | TwlRow>(
    kind: "tn" | "tq" | "twl",
    row: T,
    patch: Partial<T>,
    opts?: { restoredFromVersion?: number },
  ) => {
    // Optimistic local apply mirrors what the server will do: any non-revert
    // patch clears the restored_from_version marker so the chip immediately
    // drops the v{N} override instead of waiting for the round-trip.
    const localPatch = {
      ...patch,
      restored_from_version:
        opts?.restoredFromVersion !== undefined ? opts.restoredFromVersion : null,
    } as Partial<TnRow & TqRow & TwlRow>;
    // Capture the pre-edit baseline (the row's current value for each patched
    // field) BEFORE the optimistic apply, so a later 409 can distinguish a
    // spurious conflict (server changed a different field / already has our
    // value) from a genuine one and auto-heal the former (see
    // classifyRowPatchConflict). Read from `row`, which still holds the version
    // we branched from — applyLocalRowPatch produces a new cached object.
    const rowRecord = row as unknown as Record<string, unknown>;
    const baseline: Record<string, unknown> = {};
    for (const field of Object.keys(patch)) baseline[field] = rowRecord[field];
    applyLocalRowPatch(kind, row.id, localPatch);
    void outbox.enqueueRow(kind, row.id, row.version, patch as Record<string, unknown>, { ...opts, book: row.book, baseline });
  };

  // Draft-write path. Every keystroke in a verse-text cell calls this; it
  // stashes the plain text in IndexedDB so unsaved typing survives tab
  // close / chapter navigation. No PATCH fires here — only on saveVerseDraft.
  const stashVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
  ) => {
    void drafts.set(
      verseKey(book, chapterNum, verseNum, bibleVersion),
      { plainText: plain },
      base.version,
      { kind: "verse", book, chapter: chapterNum, verse: verseNum, bibleVersion },
    );
  };

  // User clicked Save on a verse cell. Runs smartEditVerse so unchanged
  // regions keep their `\zaln-s` milestones, applies the new content
  // locally so highlights re-render, then enqueues. Outbox-result listener
  // (installed in main.ts) clears the draft on 200.
  //
  // `plain` is the editable representation (paragraph / poetry markers
  // surfaced as inline "\p" / "\q1" tokens) — extractEditableText on the
  // base content produces the matching baseline for the diff. The DB
  // `plain_text` column stays marker-free, so we recompute it from the
  // resulting tree via extractPlainText.
  const saveVerseDraft = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    plain: string,
    base: VerseDto,
  ) => {
    const oldEditable = extractEditableText(base.content);
    // No-op guard: a focus/blur (or any save) with no actual text change must
    // not enqueue a PATCH — it would bump the verse version server-side for
    // nothing, adding noisy history and leaving a stale expected_version that a
    // later alignment save on the same row can 409 against.
    //
    // `oldEditable` is already normalizeEditable-collapsed, but `plain` is raw
    // DOM textContent (may carry trailing \n / ZWSP / nbsp the editor emits),
    // so normalize both sides — otherwise type-a-char-then-revert never matches
    // and a version-bumping no-op PATCH fires. On a real no-op we must also
    // CLEAR the stranded keystroke draft: drafts are written on every keystroke
    // and only cleared by the outbox-200 listener, so returning without clearing
    // leaves an orphaned draft (dirty border + SyncStatusBar entry + "unsaved
    // edits" toast whose Save button re-hits this guard and never resolves).
    if (oldEditable === normalizeEditable(plain)) {
      // Generation-fenced: only clear the draft whose payload is the exact
      // text this no-op save examined. If the user typed again between the
      // Save click and this line, the newer draft must survive.
      const key = verseKey(book, chapterNum, verseNum, bibleVersion);
      void drafts
        .get(key)
        .then((draft) => {
          const generation = generationForSavedPlain(draft, plain);
          if (generation) void drafts.clearGeneration(key, generation);
        })
        .catch(() => {
          /* conservative: leave an unreadable draft in place */
        });
      return;
    }
    // `plain` is raw DOM textContent, so the dropped-marker-chip guard applies
    // here and only here — see smartEditVerse's `capturedFromDom` (#606).
    const result = smartEditVerse(base.content, oldEditable, plain, {
      capturedFromDom: true,
    });
    // Heads-up when this save drops alignment. Editing a word's text or order
    // unaligns that word by design — the engine preserves only the words it
    // didn't have to touch — and the loss is otherwise easy to miss: the editor
    // shows plain text, so a translator who reworded a phrase and saved gets no
    // in-place signal that they now have words to re-align (the prompt that led
    // here: a verse reworded + repunctuated in one save came back with several
    // words unaligned, read as "changing the period unaligned them"). Compare
    // the unaligned-word count before vs after and notify only when it actually
    // INCREASED, so a pure punctuation / spacing edit — which keeps every \zaln —
    // stays silent.
    const beforeUnaligned = countUnalignedTargetWords(
      (base.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const afterUnaligned = countUnalignedTargetWords(
      (result.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const newlyUnaligned = afterUnaligned - beforeUnaligned;
    if (newlyUnaligned > 0) {
      pushPipelineToast(
        t("shell.editLeftUnaligned", {
          count: newlyUnaligned,
          ref: `${book} ${chapterNum}:${verseNum}`,
          bibleVersion,
        }),
        "info",
      );
    }
    // The editor handed back text with none of its paragraph/poetry marks and
    // no word changed, so the engine restored them rather than wipe the verse's
    // lineation (#606). That is the right call for a dropped-chip capture, but
    // it also overrides a translator who genuinely meant to remove every mark in
    // the same save — so say so, and name the way to do it.
    if (result.markerCaptureGuarded) {
      pushPipelineToast(
        t("shell.markersRestored", {
          ref: `${book} ${chapterNum}:${verseNum}`,
          bibleVersion,
        }),
        "info",
      );
    }
    const newPlainText = extractPlainText(result.content);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: result.content,
    } as VerseDto;
    const applyLocal = () => {
      bookHook?.applyLocalVerse(newDto);
      if (chapterNum === chapter) applyLocalVerse(newDto);
    };
    const key = verseKey(book, chapterNum, verseNum, bibleVersion);
    // Resolve the durable draft before queueing so the outbox records the exact
    // generation represented by `plain`. If the user typed again after clicking
    // Save, generationForSavedPlain refuses to associate that newer draft with
    // this older payload, so the eventual 200 cannot clear the new work.
    const enqueueCapturedSave = (draftGeneration?: string) => {
      if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, result.content, newPlainText, "text_edit", base.version, applyLocal, draftGeneration)) {
        return;
      }
      applyLocal();
    };
    void drafts
      .get(key)
      .then((draft) => enqueueCapturedSave(generationForSavedPlain(draft, plain)))
      // Draft lookup is cleanup metadata, not a prerequisite for durability.
      // If IndexedDB is temporarily unreadable, still queue the user's save;
      // the draft simply remains available for a conservative manual cleanup.
      .catch(() => enqueueCapturedSave());
  };

  // Restore a previously-saved verse version (from the history dialog). Unlike
  // saveVerseDraft, there is no smartEditVerse pass — we re-save the exact
  // stored content tree verbatim (alignment milestones included). It routes
  // through the same pipe with the alignment_edit intent: a deliberate
  // full-tree replacement legitimately changes alignment, and that is the only
  // intent the collateral-loss guard exempts (guardBlocksSave). The version
  // climbs normally, so the new entry's content matches the restored one — no
  // restored_from_version bookkeeping needed (unlike notes).
  const restoreVerse = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    content: unknown,
    plainText: string | null,
    base: VerseDto,
  ) => {
    const newPlainText = plainText ?? extractPlainText(content);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, content, newPlainText, "alignment_edit")) {
      return;
    }
    // Drop any stranded keystroke draft so the dirty border / "unsaved edits"
    // toast don't linger over content the restore just replaced.
    void drafts.clear(verseKey(book, chapterNum, verseNum, bibleVersion));
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  // Section header (\s1/\s2/\s3) edit / delete. `change.index` is the
  // i'th section header inside this verse's content per
  // splitSectionHeaders. tag === null deletes the band. The verseObjects
  // tree is mutated structurally (no smartEditVerse — there's no text
  // diff, just a structural node swap) and saved via the same outbox.
  const saveSectionEdit = (
    chapterNum: number,
    verseNum: number,
    bibleVersion: string,
    change: { index: number; tag: string | null; text: string },
    base: VerseDto,
  ) => {
    const verseObjects = (base.content as { verseObjects?: unknown[] } | null)?.verseObjects;
    if (!Array.isArray(verseObjects)) return;
    // Walk verseObjects in order; the index counter advances each time
    // we hit a section heading. On match: swap (tag/text) or splice out.
    const next: unknown[] = [];
    let sectionIdx = 0;
    for (const node of verseObjects) {
      const o = node as Record<string, unknown> | null;
      if (
        o &&
        o["type"] === "section" &&
        typeof o["tag"] === "string" &&
        SECTION_HEADER_TAGS.has(o["tag"] as string)
      ) {
        if (sectionIdx === change.index) {
          if (change.tag !== null) {
            // usfm-js stores \s* heading text in `content` (with a
            // trailing \n that the renderer/exporter expects).
            // splitSectionHeaders prefers `content` over `text`, so we
            // must write `content` for the change to round-trip.
            const { text: _drop, ...rest } = o;
            next.push({ ...rest, tag: change.tag, content: `${change.text}\n` });
          }
          // null tag → drop the node entirely.
          sectionIdx++;
          continue;
        }
        sectionIdx++;
      }
      next.push(node);
    }
    const newContent = { ...(base.content as Record<string, unknown> | null), verseObjects: next };
    const newPlainText = extractPlainText(newContent);
    const newDto = {
      ...base,
      chapter: chapterNum,
      verse: verseNum,
      bible_version: bibleVersion,
      plain_text: newPlainText,
      content: newContent,
    } as VerseDto;
    if (!enqueueVerseSafely(chapterNum, verseNum, bibleVersion, base, newContent, newPlainText, "section_edit")) {
      return;
    }
    bookHook?.applyLocalVerse(newDto);
    if (chapterNum === chapter) applyLocalVerse(newDto);
  };

  const scriptureNode = (
        <ScriptureColumn
          book={book}
          chapter={chapter}
          textCheck={textLaneCheck}
          versesByVersion={data.verses}
          verseNumbers={verseNumbers}
          activeVerse={activeVerse}
          activeNoteQuote={activeQuote}
          activeNoteOccurrence={activeOccurrence}
          reorderHighlight={reorderHighlight}
          mode={mode}
          enabledVersions={displayedVersions}
          availableVersions={availableVersions}
          bookChapterList={bookChapterList}
          bookChapters={bookHook && mode === "book" ? bookHook.chapters : undefined}
          onLoadBookChapter={bookHook ? bookHook.loadChapter : undefined}
          onSelectBookVerse={(ch, v) => {
            // Verse click in book mode navigates via URL so the chapter
            // payload + resources reload through the existing useChapter
            // flow. App.tsx lifts the useBook cache so this round-trip is
            // cheap.
            runWithDirtyGate(() => {
              if (ch !== chapter) {
                onNavigate?.(book, ch, v);
              } else {
                setActiveVerse(v);
                setActiveNoteId(null);
                setActiveWordId(null);
              }
            });
          }}
          onEditBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onSaveBookVerse={(ch, verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(ch, verseNum, bibleVersion, plain, base);
          }}
          onOpenBookAligner={(ch, v, bv) => openAligner(ch, v, bv)}
          onReplaceVerse={(ch, verseNum, bibleVersion, newContent, newPlainText, base) => {
            // Find/replace ships pre-built content from smartReplaceVerse —
            // alignment is preserved when word counts match, fully
            // re-tokenized otherwise. Dual-apply to useChapter so opening
            // ⌭ right after a replace shows the new content instead of the
            // pre-replace cache.
            const newDto = {
              ...base,
              chapter: ch,
              verse: verseNum,
              bible_version: bibleVersion,
              plain_text: newPlainText,
              content: newContent,
            } as VerseDto;
            if (!enqueueVerseSafely(ch, verseNum, bibleVersion, base, newContent, newPlainText, "find_replace")) {
              return;
            }
            bookHook?.applyLocalVerse(newDto);
            if (ch === chapter) applyLocalVerse(newDto);
          }}
          onReplaceNote={(row, newNote) => {
            // Find/replace on a translation note rewrites the BODY only (id is
            // the PK, support_reference is a structured rc:// link — both stay
            // put; the overlay enforces this). Reuse the standard note save
            // path so it gets the same outbox If-Match (on row.version),
            // restored_from_version clear, and 409 merge handling as a manual
            // edit. Also patch the book-mode cache so a cross-chapter note in
            // book view updates immediately (enqueueRow's local apply only
            // touches the active chapter's useChapter data).
            enqueueRow("tn", row, { note: newNote });
            bookHook?.applyLocalRowPatch("tn", row.chapter, row.id, {
              note: newNote,
              restored_from_version: null,
            });
          }}
          onSelectVerse={(v) => requestSelectVerse(v)}
          onModeChange={(m) => {
            setMode(m);
            // Classic owns be:scriptureMode; every other layout persists its
            // mode into that layout's override so a toggle never mutates
            // Classic's shared key (plan risk: scripture-mode double ownership).
            if (isClassic) saveToStorage(SCRIPTURE_MODE_KEY, m);
            else mergeOverride(activeLayout.id, { mode: m });
          }}
          onEnabledVersionsChange={(versions) => {
            setEnabledVersions(versions);
            // Only Classic persists be:enabledVersions. Non-classic layouts pin
            // versions from their spec (intersected with availableVersions each
            // render) and are not persisted back this phase.
            if (isClassic) saveToStorage(ENABLED_VERSIONS_KEY, versions);
          }}
          onEditVerse={(verseNum, bibleVersion, plain, base) => {
            stashVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onSaveVerse={(verseNum, bibleVersion, plain, base) => {
            saveVerseDraft(chapter, verseNum, bibleVersion, plain, base);
          }}
          onRestoreVerse={(verseNum, bibleVersion, content, plainText, base) => {
            restoreVerse(chapter, verseNum, bibleVersion, content, plainText, base);
          }}
          onEditSection={(verseNum, bibleVersion, change, base) => {
            saveSectionEdit(chapter, verseNum, bibleVersion, change, base);
          }}
          onEditBookSection={(ch, verseNum, bibleVersion, change, base) => {
            saveSectionEdit(ch, verseNum, bibleVersion, change, base);
          }}
          onOpenAligner={(v, bv) => openAligner(chapter, v, bv)}
          scrollNonce={scrollNonce}
          onRequestScrollToActive={requestScrollToActive}
          searchNotes={getSearchNotes}
          onScrollToNoteMatch={focusNoteMatch}
          onNoteQueryChange={setFindNoteQuery}
          onActiveNoteMatchChange={setActiveNoteMatch}
          lexiconMap={lexiconMap}
          twl={data.twl}
          locked={Boolean(chapterLock)}
        />
  );

  const resourceColumnProps: Omit<ResourceColumnProps, "visibleTabs" | "initialTab"> = {
    book,
    chapter,
    activeVerse,
    checkoff: resourceCheckoff,
    displayVerseRange,
    tn: data.tn,
    tq: data.tq,
    twl: data.twl,
    ultVerseObjectsFor,
    onWordHoverPreview: handleWordHoverPreview,
    activeNoteId,
    activeWordId,
    findNoteQuery,
    activeNoteMatch,
    scrollNonce,
    onNoteChange: (id, patch) => {
      applyLocalRowPatch("tn", id, patch);
    },
    onNoteSave: (id, patch, opts) => {
      const row = data.tn.find((r) => r.id === id);
      if (row) enqueueRow("tn", row, patch, opts);
    },
    onNoteFocus: (row) => {
      setActiveNoteId(row.id);
      setActiveWordId(null);
      if (row.verse !== activeVerse) setActiveVerse(row.verse);
    },
    onNoteStartAi: (row, live) => {
      // Build from the live (unsaved) note fields so SUGGEST works
      // before an explicit save — the cached data.tn row can lag the
      // box (quote propagates on a debounce; a freshly-built note may
      // not be flushed at all), which is what produced the bogus "AI
      // prerequisites missing." id/version/book/verse stay from the
      // cached row so the outbox If-Match and toast targeting hold.
      const aiRow: TnRow = {
        ...row,
        quote: live.quote,
        note: live.note,
        support_reference: live.support_reference,
      };
      const built = buildTnQuickRequest(aiRow, data);
      if (!built.ok) {
        // NoteCard gates on quote + support_reference. The remaining
        // reasons (missing ULT/UST, unalignable English, or an
        // original-language quote that doesn't resolve) need a
        // user-actionable message — and the two unalignable-quote reasons
        // need DIFFERENT copy, since "copy the English support phrase" is
        // meaningless for a Hebrew/Greek quote (#346).
        const message =
          built.error.reason === "missing_ult_verse"
            ? t("appShell.shell.aiMissingUlt")
            : built.error.reason === "missing_ust_verse"
              ? t("appShell.shell.aiMissingUst")
              : built.error.reason === "source_quote_not_found"
                ? t("appShell.shell.aiSourceQuoteNotFound", {
                    label: versionLabel(projectConfig, "ULT"),
                  })
                : built.error.reason === "hebrew_not_found"
                  ? t("appShell.shell.aiHebrewNotFound")
                  : t("appShell.shell.aiPrereqMissing");
        aiDrafts.pushError(aiRow, message);
        return;
      }
      aiDrafts.start(aiRow, built.request, {
        getIsVisible: (id) => visibleRowIdsRef.current.has(id),
        onSuccess: (r, res) => {
          // Carry the support_reference the request was built from
          // along with this save. It may still be unsaved on the
          // server (e.g. picked on a brand-new note right before
          // hitting Suggest) — without this, this PATCH's own version
          // bump can make NoteCard's resync effect stamp the pending
          // pick back to the server's stale/null value before the
          // user gets a chance to save it themselves.
          const patch = { quote: res.quote, note: res.note, support_reference: r.support_reference };
          // Re-running the suggestion on an already-drafted note can
          // return a quote+note identical to what's stored; skip the
          // save so we don't bump the row version with a no-op (mirror
          // of the commitQuoteBuild guard). res.quote may be
          // source-derived Hebrew in a different combining-mark order
          // than the stored value, so NFC-normalize the quote compare;
          // the note is plain TSV text stored verbatim, so compare raw.
          const changed =
            nfc(res.quote) !== nfc(r.quote ?? "") || res.note !== (r.note ?? "");
          if (!changed) return;
          applyLocalRowPatch("tn", r.id, patch);
          void outbox.enqueueRow("tn", r.id, r.version, patch, { book: r.book });
        },
      });
    },
    isNoteAiPending: aiDrafts.isPending,
    noteAiRecentlyCompletedAt: aiDrafts.recentlyCompletedAt,
    onNoteVisibilityChange: handleNoteVisibilityChange,
    onNoteTranslateQuote: (row, english) => {
      const vo = (
        verseIndexByVersion["ULT"]?.[row.verse]?.content as
          | { verseObjects?: unknown[] }
          | null
          | undefined
      )?.verseObjects;
      if (!Array.isArray(vo)) return null;
      return findSourceForTargetText(vo, english) || null;
    },
    onWordTranslateQuote: (row, english) => {
      const vo = (
        verseIndexByVersion["ULT"]?.[row.verse]?.content as
          | { verseObjects?: unknown[] }
          | null
          | undefined
      )?.verseObjects;
      if (!Array.isArray(vo)) return null;
      return findSourceForTargetText(vo, english) || null;
    },
    onWordGloss: (row) => {
      // English (ULT) words aligned to this row's saved orig_words.
      // OL-anchored via the UHB/UGNT verse, mirroring the highlighter.
      if (!row.orig_words) return "";
      const ult = (
        verseIndexByVersion["ULT"]?.[row.verse]?.content as
          | { verseObjects?: unknown[] }
          | null
          | undefined
      )?.verseObjects;
      if (!Array.isArray(ult)) return "";
      const src = (
        (verseIndexByVersion["UHB"]?.[row.verse] ?? verseIndexByVersion["UGNT"]?.[row.verse])
          ?.content as { verseObjects?: unknown[] } | null | undefined
      )?.verseObjects;
      return extractTargetSelectionText(
        ult,
        row.orig_words,
        row.occurrence ?? 1,
        Array.isArray(src) ? src : undefined,
      );
    },
    onWordFocus: (row) => {
      setActiveWordId(row.id);
      setActiveNoteId(null);
      if (row.verse !== activeVerse) setActiveVerse(row.verse);
    },
    onNoteCreate: async () => {
      const list = sortedForVerse(data.tn, activeVerse);
      const sort_order = pickSortOrder(list, null, "after");
      const created = (await api.createRow<TnRow>("tn", {
        book,
        chapter,
        verse: activeVerse,
        ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
        note: "",
        sort_order,
      }));
      applyLocalRowInsert("tn", created);
      setActiveNoteId(created.id);
      setActiveWordId(null);
    },
    onNoteInsertAfter: async (refId) => {
      const ref = data.tn.find((r) => r.id === refId);
      if (!ref) return;
      const list = sortedForVerse(data.tn, ref.verse);
      const sort_order = pickSortOrder(list, refId, "after");
      // No inherited support_reference — fresh notes get an empty
      // chip so the user can typeahead in immediately.
      const created = (await api.createRow<TnRow>("tn", {
        book,
        chapter,
        verse: ref.verse,
        ref_raw: ref.ref_raw,
        note: "",
        sort_order,
      }));
      applyLocalRowInsert("tn", created, { afterId: refId });
      setActiveNoteId(created.id);
      setActiveWordId(null);
    },
    onNoteReorder: (draggedId, refId, position) => {
      // Read the live (ref) row list, not the render-scoped `data`
      // closure: a rapid burst of arrow clicks fires several handlers
      // before React re-renders, and a stale closure would renumber from
      // an outdated order and enqueue ops carrying a stale version.
      const tn = dataRef.current?.tn ?? [];
      const dragged = tn.find((r) => r.id === draggedId);
      if (!dragged) return;
      const sorted = sortedForVerse(tn, dragged.verse);
      const changes = reorderSequential(sorted, draggedId, refId, position);
      for (const { row, sort_order } of changes) {
        enqueueRow("tn", row, { sort_order });
      }
    },
    verseOptions: verseNumbers,
    onNoteChangeVerse: (id, verse, verseEnd) => {
      // Retarget a note to another verse in this chapter, or extend it to
      // span a range (verseEnd > verse => ref_raw "chapter:start-end").
      // Read the live row (dataRef, not the render closure) so a rapid
      // move carries the current version. Recompute ref_raw + a fresh
      // sort_order (end of the leading verse) so the note lands in order
      // there; enqueueRow applies it optimistically and PATCHes. `verse`
      // is sent explicitly, which rows.ts treats as authoritative — so a
      // range ref_raw keeps this leading verse for grouping.
      const tn = dataRef.current?.tn ?? [];
      const row = tn.find((r) => r.id === id);
      if (!row) return;
      const isRange = verseEnd != null && verseEnd > verse;
      const ref_raw =
        verse === 0
          ? `${chapter}:intro`
          : isRange
            ? `${chapter}:${verse}-${verseEnd}`
            : `${chapter}:${verse}`;
      if (row.verse === verse && row.ref_raw === ref_raw) return;
      const sort_order = pickSortOrder(sortedForVerse(tn, verse), null, "after");
      enqueueRow("tn", row, { verse, ref_raw, sort_order });
      // Follow the note to its new verse: the resource column only renders
      // notes in displayVerseRange, so without this the moved card vanishes
      // from view. Navigating there confirms the move landed.
      setActiveVerse(verse);
      setActiveNoteId(id);
    },
    onReorderPreview: handleReorderPreview,
    onWordCreate: async () => {
      const list = sortedForVerse(data.twl, activeVerse);
      const sort_order = pickSortOrder(list, null, "after");
      const created = (await api.createRow<TwlRow>("twl", {
        book,
        chapter,
        verse: activeVerse,
        ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
        orig_words: "",
        tw_link: "",
        sort_order,
      }));
      applyLocalRowInsert("twl", created);
      setActiveWordId(created.id);
      setActiveNoteId(null);
    },
    onWordReorder: (draggedId, refId, position) => {
      // See onNoteReorder: live ref list, not the stale render closure.
      const twl = dataRef.current?.twl ?? [];
      const dragged = twl.find((r) => r.id === draggedId);
      if (!dragged) return;
      const sorted = sortedForVerse(twl, dragged.verse);
      const changes = reorderSequential(sorted, draggedId, refId, position);
      for (const { row, sort_order } of changes) {
        enqueueRow("twl", row, { sort_order });
      }
    },
    onQuestionCreate: async () => {
      const created = (await api.createRow<TqRow>("tq", {
        book,
        chapter,
        verse: activeVerse,
        ref_raw: activeVerse === 0 ? `${chapter}:intro` : `${chapter}:${activeVerse}`,
        question: "",
        response: "",
      }));
      applyLocalRowInsert("tq", created);
    },
    onNoteDelete: handleTrashNote,
    onNoteRestore: handleRestoreNote,
    onWordSave: (id, patch) => {
      const row = data.twl.find((r) => r.id === id);
      if (row) enqueueRow("twl", row, patch);
    },
    onWordDelete: (id) => {
      const row = data.twl.find((r) => r.id === id);
      if (!row) return;
      applyLocalRowDelete("twl", id);
      if (activeWordId === id) setActiveWordId(null);
      void outbox.enqueueDeleteRow("twl", id, row.version, row.book);
    },
    onQuestionSave: (id, patch) => {
      const row = data.tq.find((r) => r.id === id);
      if (row) enqueueRow("tq", row, patch);
    },
    onQuestionDelete: (id) => {
      const row = data.tq.find((r) => r.id === id);
      if (!row) return;
      applyLocalRowDelete("tq", id);
      void outbox.enqueueDeleteRow("tq", id, row.version, row.book);
    },
    locked: Boolean(chapterLock),
    onSetNotePreserve: handleSetNotePreserve,
    onSetNoteHint: handleSetNoteHint,
    onNoteApprove: handleApproveNote,
    onApproveAllNotes: handleApproveAllNotes,
    onNoteTranslate: handleTranslateNote,
    translatingNoteIds: translatingRowIds,
    onQuestionApprove: handleApproveQuestion,
    onApproveAllQuestions: handleApproveAllQuestions,
    onQuestionTranslate: handleTranslateQuestion,
    translatingQuestionIds,
    quoteBuildActiveNoteId: quoteBuildTarget?.kind === "tn" ? quoteBuildTarget.id : null,
    quoteBuildActiveWordId: quoteBuildTarget?.kind === "twl" ? quoteBuildTarget.id : null,
    quoteBuildSelectionCount: quoteBuildSelectedKeys.size,
    quoteBuildAppliedTo,
    onStartQuoteBuild: (noteId) => startQuoteBuild({ kind: "tn", id: noteId }),
    onStartWordQuoteBuild: (wordId) => startQuoteBuild({ kind: "twl", id: wordId }),
    onAddTwlSuggestion: handleAddTwlSuggestion,
    isTwlSuggestionExcluded,
    onTwlSuggestions: setVerseTwlSuggestions,
    twlRowAlternatives,
    twlBlockedArticleIds,
    twlFiltersReady: twlFilters.settled,
    panelMode,
    onSetPanelMode: handleSetPanelMode,
    alignmentProps: alignmentTabProps,
    alignmentBadge,
  };

  const renderResources = (visibleTabs?: ResourceTab[]) => (
    <ResourceColumn
      {...resourceColumnProps}
      visibleTabs={visibleTabs}
      initialTab={openOnWords && (!visibleTabs || visibleTabs.includes("words")) ? "words" : visibleTabs?.[0]}
      requestTab={wordsTabRequest}
    />
  );

  // ── Arrangeable layouts: tiled docking (drag a panel between regions) ──
  //
  // `arrangeable` is the ONE gate on every piece of drag chrome below, and it is
  // exactly `!isClassic`. builtin:classic renders through WorkspaceLayout's
  // hand-rolled flexbox branch and must stay byte-identical, so it gets no panel
  // headers, no drop zones, and no drag context at all.
  //
  // This is deliberately a SEPARATE notion from renderRegion's
  // `display !== "tabs" && panels.length > 1` gate below — that condition still
  // reads exactly as it did, so the stacked-multi-panel branch remains
  // unreachable from Classic's tabbed resources region.
  const arrangeable = !isClassic;

  // The RENDERED topology = the user's rearrangement when there is one, else the
  // spec's root. effectiveRoot is the single source of truth and refuses to
  // apply a tree override to Classic.
  const effRoot = effectiveRoot(activeLayout, layoutOverride);
  // WorkspaceLayout gets a spec whose `root` is ALREADY effective, so it needs no
  // knowledge of overrides. Same object when there is no override, so Classic's
  // identity check and memoization behaviour are unchanged.
  const renderedLayout: LayoutSpec =
    effRoot === activeLayout.root ? activeLayout : { ...activeLayout, root: effRoot };
  // Persisted per-node sizes for the active (non-classic) layout. Classic uses
  // the effectiveSplit divider path and ignores these.
  const sizes = layoutOverride?.sizes ?? {};
  const minimizedPanels = layoutOverride?.minimized ?? {};

  // The sizes the STORE holds RIGHT NOW — not the ones this render closed over.
  //
  // `onSizesChange` deliberately does NOT bump `layoutRev`: that would re-render
  // the whole Shell on every divider tick while the user is still dragging it. The
  // cost of that choice is that the memoized `layoutOverride` (and so `sizes`) goes
  // stale the instant a resize is persisted. Any writer that REPLACES the sizes
  // record wholesale — setLayoutTree does — must therefore re-read, or it silently
  // erases a resize the user made since the last render. Same for anything that
  // BAKES sizes into a saved spec.
  const currentSizes = (): Record<string, number> =>
    loadLayoutStore().overrides[activeLayout.id]?.sizes ?? {};

  const onSizesChange = (patch: Record<string, number>) => {
    // Hand mergeOverride the PATCH ALONE and let it merge over the live store.
    // Seeding the merge with this render's `sizes` was itself a stale-write: a
    // second resize would carry the pre-first-resize value back on top of the
    // fresher one, reverting the divider the user had just moved.
    mergeOverride(activeLayout.id, { sizes: patch });
  };

  // A panel's live minimized state: the override wins, falling back to the
  // spec's `PanelInstance.minimized` runtime default (which is what
  // handleSaveLayout bakes).
  const isPanelMinimized = (panel: PanelInstance): boolean =>
    minimizedPanels[panel.id] ?? !!panel.minimized;
  const setPanelMinimized = (panelId: string, value: boolean) => {
    mergeOverride(activeLayout.id, { minimized: { [panelId]: value } });
    setLayoutRev((n) => n + 1);
  };

  // ── Region hide / restore (runtime state, NOT part of the layout spec) ──
  //
  // Closing a region closes a whole section WITH its panels still inside it —
  // distinct from minimizing one panel to its header. It is a render-time filter
  // over `LayoutOverride.hidden`: the tree is never edited, so no panel can be
  // orphaned and `normalizeTree` can never delete a closed region (it only drops
  // regions that have NO panels, and a closed one still has all of its).
  //
  // Deliberately NOT reachable from Classic: every call site below sits behind
  // `arrangeable`, and setLayoutHidden refuses builtin:classic as a second guard.

  // A closed region needs a human name, and regions have none in the schema — so
  // name it by the panels it holds, using the same `panelTitle.*` namespace the
  // panel headers use.
  // (A zero-panel region needs no fallback: normalizeTree drops empty regions, so
  // one can never reach the restore list.)
  const regionLabel = (region: PanelRegion): string =>
    region.panels.map((p) => t(`panelTitle.${p.type}`)).join(", ");

  // Closed regions of the ACTIVE layout, in tree order. Empty for Classic.
  const closedRegions = arrangeable
    ? hiddenRegions(effRoot, layoutOverride?.hidden).map((r) => ({
        id: r.id,
        label: regionLabel(r),
      }))
    : [];

  // One id -> region lookup, built once, instead of re-walking the whole tree
  // per id (collectRegions(effRoot).find(...) inside a .map was O(regions^2)).
  const regionById = new Map(collectRegions(effRoot).map((r) => [r.id, r]));

  // Band-hidden regions, labeled the same way as `closedRegions` so
  // WorkspaceLayout's switcher can show a human name. This is the VIEWPORT
  // constraint (computed in the hook zone above from the same effective
  // tree) — it is a completely separate concept from `closedRegions` (the
  // USER's own intent) and must never be merged into layoutStore or the
  // `hidden` override: shrinking the window must never permanently narrow
  // what comes back when the user widens it again.
  const bandHiddenRegions = bandHiddenRegionIds
    .map((id) => regionById.get(id))
    .filter((r): r is PanelRegion => !!r)
    .map((r) => ({ id: r.id, label: regionLabel(r) }));

  // The OPEN regions (not user-closed), in tree order, for the band switcher's
  // tab strip. Deliberately `openRegionIds` (computed in the hook zone above)
  // rather than every region in the tree — see the CRITICAL comment there:
  // the switcher must never list a region the user has closed, since that
  // region is band-hidden by construction (resolveBandHidden was fed only
  // open ids) and a tab pointing at it would show nothing when tapped.
  const bandRegions = openRegionIds
    .map((id) => regionById.get(id))
    .filter((r): r is PanelRegion => !!r)
    .map((r) => ({ id: r.id, label: regionLabel(r) }));

  // Fresh out of the store for the same reason currentSizes is: setLayoutHidden
  // replaces the record wholesale, so seeding it from this render's closure could
  // erase a change made since.
  const currentHidden = (): Record<string, boolean> =>
    loadLayoutStore().overrides[activeLayout.id]?.hidden ?? {};

  const setRegionHidden = (regionId: string, value: boolean) => {
    if (!arrangeable) return;
    // RESOLVE ON BOTH SIDES OF THE WRITE, and persist the resolved value.
    //
    // Found in the browser, invisible to the unit tests: `hidden` is only
    // interpreted at render time, so an UNSATISFIABLE stored set — every region
    // closed, which a hand-edited localStorage or an older build can produce —
    // renders as "nothing closed" while still being the value every write builds
    // on. Closing a region then computed a set that was still unsatisfiable,
    // resolved to {} again, and changed nothing: a Close button that does
    // nothing, forever. Resolving the base first heals the stored value on the
    // next click instead of carrying it forward.
    //
    // resolveHidden is also the pruner here: it emits `true` only for regions
    // that exist in the tree, so it drops the `false` this produces on restore
    // AND any id the tree no longer has.
    const apply = () => {
      const base = resolveHidden(effRoot, currentHidden());
      setLayoutHidden(activeLayout.id, resolveHidden(effRoot, { ...base, [regionId]: value }));
      setLayoutRev((n) => n + 1);
    };
    // CLOSING UNMOUNTS the region's panels (renderNode returns null for it), so it
    // is the same hazard as switching layouts: an alignment panel with unsaved
    // drags holds them in component state only — they never reach the outbox — and
    // would vanish silently. Route the close through the dirty gate, exactly as
    // selectLayout and the panel-mode switch already do.
    //
    // REOPENING needs no gate: it mounts, it cannot discard anything.
    if (value) runWithDirtyGate(apply);
    else apply();
  };

  // Refuse to close the LAST region still on screen: an empty workspace has no
  // chrome left to click. (layoutTree.resolveHidden is the backstop for any other
  // path into that state; this is the up-front guard that keeps the control from
  // even appearing.)
  const canCloseRegion = (regionId: string): boolean =>
    arrangeable && canHideRegion(effRoot, layoutOverride?.hidden, regionId);

  const handleRestoreAllRegions = () => {
    if (!arrangeable) return;
    setLayoutHidden(activeLayout.id, {});
    setLayoutRev((n) => n + 1);
  };

  // Commit a drop: move the panel in the EFFECTIVE tree and persist the whole
  // new tree. `sizes` is pruned at the same time because a drop creates and
  // destroys regions — and nextRegionId recycles `region-<n>` ids, so a leftover
  // key could later mis-size a brand-new region.
  const commitDrop = (target: DropTarget) => {
    const panelId = draggedPanelId;
    setDraggedPanelId(null);
    if (!panelId || !arrangeable) return;
    const next = movePanel(effRoot, panelId, target);
    if (next === effRoot) return; // no-op drop (engine rejected it) — persist nothing
    setLayoutTree(activeLayout.id, next, pruneSizes(currentSizes(), next, activeLayout.id));
    // Re-resolve against the NEW tree, for the same reason `sizes` is pruned: a
    // drop destroys regions and `nextRegionId` RECYCLES `region-<n>` ids, so a
    // stale `hidden` key could otherwise make a brand-new region spawn invisible.
    // (resolveHidden rather than a plain prune — see setRegionHidden.)
    setLayoutHidden(activeLayout.id, resolveHidden(next, currentHidden()));
    setLayoutRev((n) => n + 1);
  };

  const layoutDrag: LayoutDragValue = {
    draggedPanelId,
    beginDrag: (id: string) => setDraggedPanelId(id),
    endDrag: () => setDraggedPanelId(null),
    commitDrop,
  };

  // "Reset arrangement" only makes sense for a non-Classic layout that actually
  // has a rearrangement to throw away.
  // …or one with regions closed: reopening them is part of "put it back".
  const hasTreeOverride = arrangeable && (!!layoutOverride?.tree || closedRegions.length > 0);
  const handleResetArrangement = () => {
    // Back to the spec's own topology; sizes keyed to the discarded tree go too.
    setLayoutTree(activeLayout.id, null, pruneSizes(currentSizes(), activeLayout.root, activeLayout.id));
    // Closed regions are part of the arrangement the user is discarding — leaving
    // a section closed after a reset would look like the reset had failed.
    setLayoutHidden(activeLayout.id, {});
    setLayoutRev((n) => n + 1);
  };

  const renderPanelContent = (panel: PanelInstance): ReactNode => {
    switch (panel.type) {
      case "scripture":
        return scriptureNode;
      case "notes":
      case "words":
      case "questions":
        return <StackedResourcePanel {...resourceColumnProps} panelType={panel.type} />;
      case "taArticle": {
        const row = activeNoteId ? data.tn.find((r) => r.id === activeNoteId) : null;
        return <AssociatedArticlePanel resource="ta" selected={!!row} articleRef={row?.support_reference ?? null} />;
      }
      case "twArticle": {
        const row = activeWordId ? data.twl.find((r) => r.id === activeWordId) : null;
        return <AssociatedArticlePanel resource="tw" selected={!!row} articleRef={row?.tw_link ?? null} />;
      }
      case "original":
        return (
          <OriginalLanguagePanel
            book={book}
            chapter={chapter}
            versesByVersion={data.verses}
            verseNumbers={verseNumbers}
            activeVerse={activeVerse}
            activeNoteQuote={activeQuote}
            activeNoteOccurrence={activeOccurrence}
            reorderHighlight={reorderHighlight}
            lexiconMap={lexiconMap}
            twl={data.twl}
            resource={panel.config?.resource}
            onSelectVerse={requestSelectVerse}
          />
        );
      case "search":
        return <SearchPanel />;
      default:
        // TODO follow-on PRs: articleList / alignment panels.
        return (
          <Box sx={{ m: 2, p: 2, border: "1px dashed", borderColor: "divider", borderRadius: 1, color: "text.secondary" }}>
            <Typography variant="body2">{t("appShell.shell.panelComingLater", { type: panel.type })}</Typography>
          </Box>
        );
    }
  };

  const renderRegionContent = (region: PanelRegion): ReactNode => {
    // Multi-panel STACKED region → stack each panel separately (the new
    // capability). Tabbed regions (display:"tabs", e.g. Classic's resources
    // column with its notes/words/questions tabs) are EXCLUDED here and fall
    // through to the unchanged tabbed ResourceColumn path below — that guard is
    // what keeps builtin:classic byte-identical.
    if (region.display !== "tabs" && region.panels.length > 1) {
      return (
        <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {region.panels.map((p, pi) => {
            const min = arrangeable && isPanelMinimized(p);
            // The region's close control rides on its FIRST panel's header, so it
            // needs no extra header row of its own and stays in flow (see
            // PanelChrome.onCloseRegion).
            const closeRegion =
              pi === 0 && canCloseRegion(region.id)
                ? () => setRegionHidden(region.id, true)
                : undefined;
            return (
              <Box
                key={p.id}
                sx={{
                  // A minimized panel shrinks to its header instead of holding a
                  // full flex share.
                  flex: min ? "0 0 auto" : 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  "&:last-of-type": { borderBottom: 0 },
                }}
              >
                {arrangeable ? (
                  <PanelChrome
                    panelId={p.id}
                    panelType={p.type}
                    minimized={min}
                    onToggleMinimized={() => setPanelMinimized(p.id, !min)}
                    onCloseRegion={closeRegion}
                  >
                    {renderPanelContent(p)}
                  </PanelChrome>
                ) : (
                  renderPanelContent(p)
                )}
              </Box>
            );
          })}
        </Box>
      );
    }
    // Single-panel (or empty) region → CURRENT behavior, unchanged (keeps Classic
    // + translate-notes/words byte-identical).
    const types = region.panels.map((pp) => pp.type);
    if (types.includes("scripture")) return scriptureNode;
    const resourceTabs = region.panels
      .map((pp) => pp.type)
      .filter((tt): tt is ResourceTab => (RESOURCE_PANEL_TYPES as readonly string[]).includes(tt));
    if (resourceTabs.length > 0) return renderResources(isClassic ? undefined : resourceTabs);
    // A lone non-resource panel (e.g. an article panel dragged into its own
    // region) renders through the same per-panel dispatch as a stacked one.
    const only = region.panels[0];
    if (only) return renderPanelContent(only);
    return null;
  };

  const renderRegion = (region: PanelRegion): ReactNode => {
    const content = renderRegionContent(region);
    // ── THE CLASSIC GUARD ───────────────────────────────────────────────
    // Classic returns its region content RAW — no wrapper element, no drop
    // handlers, no header chrome. Every line of new docking code sits on the
    // other side of this early return, so it is structurally unreachable from
    // builtin:classic even if some other guard were to regress.
    if (!arrangeable) return content;

    // A single-panel region still needs a grip, or docking would be one-way: a
    // panel dragged out into its own region could never be dragged back.
    // (The multi-panel branch above already added its own per-panel chrome.)
    const lone = region.panels.length === 1 ? region.panels[0] : null;
    const closeRegion = canCloseRegion(region.id)
      ? () => setRegionHidden(region.id, true)
      : undefined;
    // A region with NO per-panel chrome — a `display: "tabs"` region holding more
    // than one panel, which is exactly what "Save current as…" produces from
    // Classic — would otherwise have nowhere to put the close control. Give it a
    // minimal header carrying only that button (still in flow, never an overlay).
    const bareRegionHeader = !lone && region.panels.length > 1 && region.display === "tabs";
    const wrapped =
      lone ? (
        <PanelChrome
          panelId={lone.id}
          panelType={lone.type}
          minimized={isPanelMinimized(lone)}
          onToggleMinimized={() => setPanelMinimized(lone.id, !isPanelMinimized(lone))}
          onCloseRegion={closeRegion}
        >
          {content}
        </PanelChrome>
      ) : bareRegionHeader && closeRegion ? (
        <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <Box
            sx={{
              flexShrink: 0,
              display: "flex",
              justifyContent: "flex-end",
              minHeight: 18,
              px: 0.5,
              bgcolor: "grey.50",
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <Tooltip title={t("layout.closeRegion")}>
              <IconButton
                size="small"
                onClick={closeRegion}
                aria-label={t("layout.closeRegion")}
                sx={{ p: 0 }}
              >
                <CloseIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {content}
          </Box>
        </Box>
      ) : (
        content
      );

    return (
      <RegionDropZone key={region.id} regionId={region.id}>
        {wrapped}
      </RegionDropZone>
    );
  };

  // Switch the active layout. A switch can hide a dirty alignment panel, so it
  // routes through the dirty gate; then it syncs scripture mode/versions from
  // the target spec and persists the choice. Classic restores its legacy keys;
  // other layouts read their scripture panel (and any saved mode override).
  // Resolves against built-ins + user layouts read fresh from the store so a
  // just-saved layout is selectable before its state update has flushed.
  const selectLayout = (id: string) => {
    runWithDirtyGate(() => {
      const candidates = [...builtinLayouts, ...loadLayoutStore().userLayouts];
      const next = candidates.find((l) => l.id === id);
      const resolved = next ? validateLayoutAgainstRegistry(next, projectConfig) : null;
      const target =
        resolved ?? candidates.find((l) => l.id === CLASSIC_LAYOUT_ID) ?? candidates[0];
      if (target.id === CLASSIC_LAYOUT_ID) {
        setMode(loadFromStorage<ScriptureMode>(SCRIPTURE_MODE_KEY, "stacked"));
        setEnabledVersions(loadFromStorage<string[]>(ENABLED_VERSIONS_KEY, ["ULT", "UST"]));
      } else {
        const sp = findScripturePanel(target.root);
        const overrideMode = loadLayoutStore().overrides[target.id]?.mode;
        const nextMode = overrideMode ?? sp?.config?.mode;
        if (nextMode) setMode(nextMode);
        const versions = sp?.config?.versions;
        if (versions && versions !== "inherit") {
          setEnabledVersions(versions.filter((v) => availableVersions.includes(v)));
        }
      }
      setActiveLayoutIdState(target.id);
      persistActiveLayoutId(target.id);
    });
  };

  // Save the CURRENT arrangement as a new user layout. Approach: bake the live
  // look into the saved spec (not copy-overrides) — deep-clone the active tree,
  // bake the live size overrides into node `size` fields (applyEffectiveSizes),
  // and bake the live scripture `mode` + `enabledVersions` into the scripture
  // panel's config. The spec is self-contained: re-selecting it reproduces
  // today's proportions, mode, and version pins with no override needed. A
  // Classic-derived save renders through the generic (non-classic) path, which
  // is visually equivalent. validateLayoutSpec sanitizes + guards the clone.
  const handleSaveLayout = (name: string) => {
    // Clone the EFFECTIVE tree, not the spec's — otherwise "Save current as…"
    // would silently throw away the user's rearrangement, which is the one thing
    // they most likely just did.
    const clonedRoot = JSON.parse(JSON.stringify(effRoot)) as LayoutNode;
    // Fresh, not the render closure: "Save current as…" right after dragging a
    // divider must bake the size the user can SEE, not the one from before it.
    applyEffectiveSizes(clonedRoot, currentSizes(), activeLayout.id);
    const sp = findScripturePanel(clonedRoot);
    if (sp) sp.config = { ...(sp.config ?? {}), mode, versions: [...enabledVersions] };
    // Bake the live minimized state too — same "the saved spec reproduces what
    // you see" principle as sizes / mode / versions. PanelInstance.minimized is
    // exactly the runtime default for this.
    for (const region of collectRegions(clonedRoot)) {
      // Closed regions are deliberately NOT baked — a saved layout is a shareable
      // definition, and opening one with a section already closed (findable only
      // via the reopen strip) is worse than opening it whole; nothing is lost
      // either way, since the tree carries the panels regardless. So strip any
      // spec-level `hidden` the source layout happened to carry rather than
      // cloning it through: otherwise a region the user had REOPENED would come
      // back closed in the new layout, whose id the `false` override cannot follow.
      delete region.hidden;
      for (const panel of region.panels) {
        // The EFFECTIVE value: an absent override must not erase a spec-level
        // `minimized: true` that the source layout already carried.
        if (isPanelMinimized(panel)) panel.minimized = true;
        else delete panel.minimized;
      }
    }
    const candidate: LayoutSpec = {
      v: 2,
      id: "user:" + crypto.randomUUID(),
      name,
      builtin: false,
      rail: { visible: activeLayout.rail.visible },
      root: clonedRoot,
    };
    const validated = validateLayoutSpec(candidate);
    setSaveAsOpen(false);
    if (!validated) return; // malformed clone — abort rather than persist junk
    const store = upsertUserLayout(validated);
    setUserLayouts([...store.userLayouts]);
    // The saved look matches the current one, so mode/versions need no re-sync;
    // still route the switch through the dirty gate (it can remount panels).
    runWithDirtyGate(() => {
      setActiveLayoutIdState(validated.id);
      persistActiveLayoutId(validated.id);
    });
  };

  const handleRenameLayout = (id: string, newName: string) => {
    const existing = loadLayoutStore().userLayouts.find((l) => l.id === id);
    if (!existing) return;
    const store = upsertUserLayout({ ...existing, name: newName });
    setUserLayouts([...store.userLayouts]);
  };

  const handleDeleteLayout = (id: string) => {
    const wasActive = activeLayout.id === id;
    const store = deleteUserLayout(id); // also resets persisted active → Classic if it was active
    setUserLayouts([...store.userLayouts]);
    // Restore Classic's scripture mode/versions + Shell state when the deleted
    // layout was the active one.
    if (wasActive) selectLayout(CLASSIC_LAYOUT_ID);
  };

  const handleDuplicateLayout = (id: string) => {
    const existing = loadLayoutStore().userLayouts.find((l) => l.id === id);
    if (!existing) return;
    const copy: LayoutSpec = {
      ...existing,
      id: "user:" + crypto.randomUUID(),
      name: `${existing.name} ${t("layout.copySuffix")}`,
      root: JSON.parse(JSON.stringify(existing.root)) as LayoutNode,
    };
    const validated = validateLayoutSpec(copy);
    if (!validated) return;
    const store = upsertUserLayout(validated);
    setUserLayouts([...store.userLayouts]);
  };

  return (
    <Box
      sx={{
        // 100vh includes mobile browsers' retractable URL bar, so the status/
        // sync bar ends up under browser chrome. 100dvh (dynamic viewport
        // height) excludes it; the plain 100vh above is the fallback for
        // browsers that don't support dvh yet.
        height: "100vh",
        "@supports (height: 100dvh)": { height: "100dvh" },
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <TopBar
        book={book}
        chapter={chapter}
        verse={activeVerse}
        onNavigate={(b, c, v) => {
          runWithDirtyGate(() => {
            setActiveVerse(v ?? 1);
            setActiveNoteId(null);
            setActiveWordId(null);
            onNavigate?.(b, c, v);
          });
        }}
        onRequestReload={reloadForUpdate}
        pipelineMenu={
          <PipelineMenu
            book={book}
            chapter={chapter}
            onMessage={(msg) => pushPipelineToast(msg, "info")}
            onImported={() => void refetch()}
          />
        }
        pipelineToast={pipelineToast}
        onPipelineToastClear={() => setPipelineToast(null)}
        lintFlagIssues={bookLint.flagIssues}
        lintFlagCount={bookLint.flagCount}
        lintEscalateCount={bookLint.escalateCount}
        onGoToLintIssue={goToLintIssue}
        onOpenExportMenu={(anchorEl) => exportUsfmRef.current?.openMenu(anchorEl)}
        username={meUsername}
        onLogout={onLogout}
        railCollapsed={effectiveRailCollapsed}
        // Omitted below desktop width, which makes TopBar drop the control
        // entirely — the rail is force-collapsed there, so a toggle would do
        // nothing. Restored the moment the window is wide enough to honour it.
        onToggleRail={band === "desktop" ? toggleRail : undefined}
        layouts={builtinLayouts}
        userLayouts={userLayouts}
        activeLayoutId={activeLayout.id}
        onSelectLayout={selectLayout}
        onSaveLayoutAs={() => setSaveAsOpen(true)}
        onManageLayouts={() => setManageOpen(true)}
        // Passed only when there is something to reset, which is how the menu
        // item stays hidden for Classic and for an untouched layout.
        onResetArrangement={hasTreeOverride ? handleResetArrangement : undefined}
        closedRegions={closedRegions}
        onRestoreRegion={(id) => setRegionHidden(id, false)}
        onRestoreAllRegions={handleRestoreAllRegions}
      />
      <ExportUsfmButton
        ref={exportUsfmRef}
        hideTrigger
        book={book}
        chapter={chapter}
        enabledVersions={displayedVersions}
        chapterVersesFor={(version) => (data ? Object.values(data.verses[version] ?? {}) : [])}
      />
      {chapterLock && (
        <Alert
          severity="info"
          icon={false}
          sx={{
            borderRadius: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
            py: 0.5,
            "& .MuiAlert-message": { width: "100%" },
          }}
        >
          {t("shell.chapterLockBanner", {
            pipelineType: chapterLock.pipelineType,
            book,
            chapter,
            started: formatRelative(chapterLock.startedAt, t),
          })}
        </Alert>
      )}
      <LayoutDragProvider value={layoutDrag}>
      <WorkspaceLayout
        spec={renderedLayout}
        renderRegion={renderRegion}
        sizes={sizes}
        onSizesChange={onSizesChange}
        closedRegions={closedRegions}
        onRestoreRegion={(id) => setRegionHidden(id, false)}
        restoreLabel={(label) => t("layout.restoreRegion", { name: label })}
        railCollapsed={effectiveRailCollapsed}
        railWidth={railWidth}
        effectiveSplit={effectiveSplit}
        onSplitRatioChange={setSplitRatio}
        onSplitCommit={commitSplitRatio}
        onSplitReset={resetSplitRatio}
        band={band}
        bandRegions={bandRegions}
        bandHiddenRegions={bandHiddenRegions}
        focusedRegionId={focusedRegionId}
        onFocusRegion={focusRegionWithGate}
        switcherLabel={t("layout.regionSwitcher")}
        railNode={
          <>
            <Tooltip title={t("shell.chapterCheckoffBoard")} placement="right">
              <Button
                size="small"
                startIcon={<GridViewIcon sx={{ fontSize: 16 }} />}
                onClick={() => setBoardOpen(true)}
                sx={{
                  flexShrink: 0,
                  m: 0.5,
                  minWidth: 0,
                  fontSize: 12,
                  justifyContent: "flex-start",
                  bgcolor: "grey.50",
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  borderRadius: 0.5,
                  color: "text.secondary",
                }}
              >
                {t("shell.board")}
              </Button>
            </Tooltip>
            <TimelineRail
              book={book}
              chapter={chapter}
              tiles={tileSet}
              activeVerse={activeVerse}
              showChapter={mode === "book"}
              enabledLanes={enabledLanes}
              onSelect={requestSelectVerse}
              onToggleLane={toggleLane}
              onHideLane={toggleLaneVisible}
            />
          </>
        }
      />
      </LayoutDragProvider>
      <ChapterBoard
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        enabledLanes={enabledLanes}
        onToggleLaneVisible={toggleLaneVisible}
        book={book}
        chapter={chapter}
        tiles={tileSet}
        canCheck={meUserId != null}
        onToggle={toggleLane}
        onBulkToggle={bulkLaneToggle}
      />
      <Dialog open={!!pendingBulk} onClose={() => setPendingBulk(null)}>
        <DialogTitle>
          {pendingBulk?.checked
            ? t("shell.bulkCheckTitle", { label: pendingBulk ? t(`lanes.${pendingBulk.lane}`) : "" })
            : t("shell.bulkClearTitle", { label: pendingBulk ? t(`lanes.${pendingBulk.lane}`) : "" })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingBulk?.checked
              ? t("shell.bulkCheckBody", { label: pendingBulk ? t(`lanes.${pendingBulk.lane}`) : "", verseCount: pendingBulk?.verses.length ?? 0, ref: `${book} ${chapter}` })
              : t("shell.bulkClearBody", { label: pendingBulk ? t(`lanes.${pendingBulk.lane}`) : "", verseCount: pendingBulk?.verses.length ?? 0, ref: `${book} ${chapter}` })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingBulk(null)}>{t("shell.cancel")}</Button>
          <Button variant="contained" color={pendingBulk?.checked ? "primary" : "error"} onClick={confirmBulk}>
            {pendingBulk?.checked ? t("shell.checkAll") : t("shell.clearAll")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!pendingNav} onClose={dismissPendingNav}>
        <DialogTitle>{t("shell.unsavedAlignmentChanges")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("shell.unsavedAlignmentBody")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={dismissPendingNav}>{t("shell.cancel")}</Button>
          <Button color="error" onClick={() => resolvePendingNav("discard")}>
            {t("shell.discard")}
          </Button>
          <Button variant="contained" onClick={() => resolvePendingNav("save")}>
            {t("shell.save")}
          </Button>
        </DialogActions>
      </Dialog>
      {dualAlignerProps && (
        <SideBySideAligner
          open
          onClose={requestCloseDual}
          book={dualAlignerProps.book}
          chapter={dualAlignerProps.chapter}
          verseNum={dualAlignerProps.verseNum}
          vref={dualAlignerProps.vref}
          sourceLabel={dualAlignerProps.sourceLabel}
          sourceVerse={dualAlignerProps.sourceVerse}
          twlForVerse={dualAlignerProps.twlForVerse}
          lexiconMap={lexiconMap}
          left={dualAlignerProps.left}
          right={dualAlignerProps.right}
          onPrevVerse={dualNav.prev != null ? () => dualNavTo(dualNav.prev!) : undefined}
          onNextVerse={dualNav.next != null ? () => dualNavTo(dualNav.next!) : undefined}
          onSaveReading={(bv, plain, base) =>
            // base.verse, not verseNum — each side's row may start at a
            // different verse (ULT v7 singleton vs UST 6-9 range row).
            saveVerseDraft(dualAlignerProps.chapter, base.verse, bv, plain, base)
          }
        />
      )}
      <Dialog open={!!pendingAlignmentLoss} onClose={() => setPendingAlignmentLoss(null)}>
        <DialogTitle>
          {pendingAlignmentLoss && pendingAlignmentLoss.lostWords.length === 1
            ? t("shell.aWordWillBeUnaligned")
            : t("shell.wordsWillBeUnaligned")}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("shell.alignLossIntro", {
              phrase: pendingAlignmentLoss?.lostWords.length === 1 ? t("shell.thisWord") : t("shell.theseWords"),
              ref: pendingAlignmentLoss?.ref ?? "",
            })}
            <Box component="span" sx={{ fontWeight: 700 }}>
              {pendingAlignmentLoss?.lostWords.slice(0, 8).join(", ")}
              {pendingAlignmentLoss && pendingAlignmentLoss.lostWords.length > 8
                ? t("shell.plusMore", { n: pendingAlignmentLoss.lostWords.length - 8 })
                : ""}
            </Box>
            {t("shell.alignLossOutro", {
              state: pendingAlignmentLoss?.lostWords.length === 1 ? t("shell.wordIs") : t("shell.wordsAre"),
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAlignmentLoss(null)}>{t("shell.cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              // Clear BEFORE running commit: commit may chain into the next
              // panel's save and open a fresh confirm (the dual aligner), and a
              // trailing setPendingAlignmentLoss(null) would clobber it.
              const commit = pendingAlignmentLoss?.commit;
              setPendingAlignmentLoss(null);
              commit?.();
            }}
          >
            {t("shell.saveAnyway")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!pendingDualAction} onClose={() => setPendingDualAction(null)}>
        <DialogTitle>{t("shell.unsavedChanges")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("shell.unsavedDualBody")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDualAction(null)}>{t("shell.cancel")}</Button>
          <Button color="error" onClick={() => resolveDualAction("discard")}>
            {t("shell.discard")}
          </Button>
          <Button variant="contained" onClick={() => resolveDualAction("save")}>
            {t("shell.save")}
          </Button>
        </DialogActions>
      </Dialog>
      <AiCompletionToasts
        notifications={aiDrafts.notifications}
        onDismiss={aiDrafts.dismiss}
        onView={(rowId, verse) => {
          runWithDirtyGate(() => {
            setActiveVerse(verse);
            setActiveNoteId(rowId);
            setActiveWordId(null);
            requestScrollToActive();
          });
        }}
      />
      <UnsavedToasts
        book={book}
        onSaveVerseDraft={(b, ch, v, bv) => {
          if (b !== book) return;
          // Look up the latest plain from the draft (avoids racing with
          // a still-pending typing flurry) and the base from whichever
          // cache holds the chapter — current chapter via data.verses,
          // book mode via bookHook.chapters.
          void drafts.get(verseKey(b, ch, v, bv)).then((rec) => {
            const payload = rec?.payload as { plainText?: string } | undefined;
            const plain = payload?.plainText;
            if (typeof plain !== "string") return;
            const base =
              ch === chapter
                ? data?.verses[bv]?.[v]
                : bookHook?.chapters.get(ch)?.kind === "ready"
                  ? (bookHook.chapters.get(ch) as { kind: "ready"; data: { verses: Record<string, Record<number, VerseDto>> } }).data.verses[bv]?.[v]
                  : undefined;
            if (!base) return;
            saveVerseDraft(ch, v, bv, plain, base);
          });
        }}
        onJumpTo={(b, ch, v) => {
          if (b !== book) return;
          runWithDirtyGate(() => {
            if (ch !== chapter) onNavigate?.(b, ch, v);
            else {
              setActiveVerse(v);
              requestScrollToActive();
            }
          });
        }}
      />
      <LayoutMenu
        saveAsOpen={saveAsOpen}
        onCloseSaveAs={() => setSaveAsOpen(false)}
        onSave={handleSaveLayout}
        manageOpen={manageOpen}
        onCloseManage={() => setManageOpen(false)}
        userLayouts={userLayouts}
        activeLayoutId={activeLayout.id}
        onRename={handleRenameLayout}
        onDelete={handleDeleteLayout}
        onDuplicate={handleDuplicateLayout}
      />
      {quoteBuildContext && (
        <QuoteBuilderPopper
          open={!!quoteBuildAnchor}
          anchorEl={quoteBuildAnchor}
          book={book}
          chapter={chapter}
          verse={quoteBuildContext.verse}
          uhbVerseObjects={quoteBuildContext.uhb}
          ultVerseObjects={quoteBuildContext.ult}
          ustVerseObjects={quoteBuildContext.ust}
          lexiconMap={lexiconMap}
          selectedKeys={quoteBuildSelectedKeys}
          onToggleKey={toggleQuoteBuildWord}
          onSelectKeys={selectQuoteBuildWords}
          onCancel={cancelQuoteBuild}
          onCommit={commitQuoteBuild}
        />
      )}
    </Box>
  );
}

// ---------- sort_order helpers ----------

type Sortable = { id: string; verse: number; sort_order: number | null };

function formatRelative(unixSeconds: number, t: TFunction): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return t("appShell.time.secondsAgo", { n: diff });
  if (diff < 3600) return t("appShell.time.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("appShell.time.hoursAgo", { n: Math.floor(diff / 3600) });
  return t("appShell.time.daysAgo", { n: Math.floor(diff / 86400) });
}

function sortedForVerse<T extends Sortable>(rows: T[], verse: number): T[] {
  return rows
    .filter((r) => r.verse === verse)
    .sort(
      (a, b) =>
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
          (b.sort_order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id),
    );
}

// Pick a sort_order so the new/moved row lands at the requested slot. Falls
// back to step-of-100 gaps when neighbors lack a sort_order yet. `excludeId`
// is set when reordering an existing row — we don't want it in the list when
// computing midpoints, otherwise drop-after-self collapses to a no-op midpoint
// inside its own slot.
function pickSortOrder<T extends Sortable>(
  rows: T[],
  refId: string | null,
  position: "before" | "after",
  excludeId?: string,
): number {
  const list = excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  if (list.length === 0) return 100;
  if (!refId) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) {
    const last = list[list.length - 1];
    return (last.sort_order ?? list.length * 100) + 100;
  }
  const target = list[idx];
  const targetSort = target.sort_order ?? (idx + 1) * 100;
  if (position === "before") {
    const prev = list[idx - 1];
    const prevSort = prev?.sort_order ?? targetSort - 200;
    return (prevSort + targetSort) / 2;
  }
  const next = list[idx + 1];
  const nextSort = next?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

// Reorder by full sequential renumbering (step 100) rather than a single
// midpoint. Moving `draggedId` to the slot at (refId, position) and assigning
// every row a fresh 100,200,300,… value. Returns only the rows whose value
// changed, each paired with its new sort_order.
//
// Why renumber instead of pickSortOrder: imported rows all have sort_order =
// null, and the sort collapses every null to one key (ordered by id). A lone
// midpoint value can't be slotted *between* two nulls — it sorts before or
// after the entire null group — so a moved row jumps to an end instead of
// advancing one slot. Renumbering gives the whole verse real, ordered values
// in one pass; subsequent moves only touch the rows that actually shifted.
function reorderSequential<T extends Sortable>(
  sorted: T[],
  draggedId: string,
  refId: string | null,
  position: "before" | "after",
): Array<{ row: T; sort_order: number }> {
  const dragged = sorted.find((r) => r.id === draggedId);
  if (!dragged) return [];
  const without = sorted.filter((r) => r.id !== draggedId);
  let insertIdx: number;
  if (refId == null) {
    insertIdx = position === "before" ? 0 : without.length;
  } else {
    const refIdx = without.findIndex((r) => r.id === refId);
    insertIdx = refIdx < 0 ? without.length : position === "before" ? refIdx : refIdx + 1;
  }
  const next = [...without.slice(0, insertIdx), dragged, ...without.slice(insertIdx)];
  const changes: Array<{ row: T; sort_order: number }> = [];
  next.forEach((row, i) => {
    const sort_order = (i + 1) * 100;
    if (row.sort_order !== sort_order) changes.push({ row, sort_order });
  });
  return changes;
}
