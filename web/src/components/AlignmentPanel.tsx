import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Typography,
  Stack,
  Chip,
  IconButton,
  Paper,
  Tooltip,
  Button,
  Snackbar,
  useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import HistoryIcon from "@mui/icons-material/History";
import { useTranslation } from "react-i18next";
import { assignChipHues, chipAccentColor, chipSupColor } from "../lib/highlightStyles";
import {
  alignmentPlainText,
  cardKey,
  clearAll,
  clearGroup,
  extractSource,
  mergeGroupsToGroups,
  moveSourceToGroups,
  moveTargets,
  parseAlignment,
  serializeAlignment,
  sourceKey,
  stripCompoundOverlaps,
  mergeAdjacentSameSource,
  mergeSamePositionGroups,
  type AlignmentGroup,
  type AlignmentState,
  type SourceWord,
} from "../lib/alignment";
import type { TwlRow, VerseDto } from "../sync/api";
import { alignmentDrafts, alignmentDraftKey } from "../sync/alignmentDrafts";
import { isLaneFrozen } from "../sync/laneFreeze";
import { lostAlignedWords } from "../lib/alignmentDelta";
import { useLexicon, type LexiconEntry } from "../hooks/useLexicon";
import { useAlignmentSuggestions } from "../hooks/useAlignmentSuggestions";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionIsRtl, versionLabel } from "../lib/versionLabels";
import { isHebrewBook } from "../lib/sourceSearch";
import {
  computeGhosts,
  dismissedGhostKey,
  ghostPipColor,
  suggestKey,
  type Ghost,
  type StreamWord,
} from "../lib/alignmentSuggest";
import { nfc } from "../lib/hebrew";
import { collectSourceWordNodes } from "../lib/quoteBuilder";
import { SourceTooltipBody } from "./SourceTooltipBody";
import { UhbStrip, buildTwHintMap, twHintFromMap } from "./UhbStrip";
import {
  type HoverHighlight,
  type HighlightCtx,
  hoverShadow,
} from "../lib/highlightTypes";

const WORD_IDS_MIME = "text/word-ids";
const SOURCE_ID_MIME = "text/source-id";
const GROUP_ID_MIME = "text/group-id";

// Storage keys for sticky toolbar prefs.
const LS_HIDE_UHB = "be:alignmentHideUhb";
const LS_COLORIZE = "be:alignmentColorize";
const LS_HOVERLINK = "be:alignmentHoverLink";
const LS_INVENTORY_HEIGHT = "be:alignmentInventoryHeight";

const DEFAULT_INVENTORY_HEIGHT = 112;
const MIN_INVENTORY_HEIGHT = 56;
const MAX_INVENTORY_HEIGHT = 480;

function readFlag(key: string, fallback = false): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}
function clampInventoryHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_INVENTORY_HEIGHT;
  return Math.max(MIN_INVENTORY_HEIGHT, Math.min(MAX_INVENTORY_HEIGHT, Math.round(n)));
}

export interface AlignmentPanelHandle {
  isDirty: () => boolean;
  // Returns true if committed synchronously, false if deferred behind the unalign
  // confirm. `afterCommit` runs only once the save actually lands (never on cancel).
  save: (afterCommit?: () => void) => boolean;
  reset: () => void;
  discard: () => void;
  // Immediate flush of dirty in-memory alignment into the crash-draft store
  // (skips the debounce). Used by lane-freeze so closing the panel doesn't
  // drop unsaved drags that hadn't hit IndexedDB yet.
  flushCrashDraft: () => void;
  // Snapshot of dirty alignment for quarantine into the shared drafts store.
  // Null when clean / missing verse.
  getDirtySnapshot: () => {
    content: unknown;
    plainText: string;
    expectedVersion: number;
  } | null;
}

interface Props {
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
  // Confirm-before-save for an alignment edit that would leave a previously
  // aligned word bare. alignment_edit is exempt from the collateral-loss save
  // guard (re-aligning legitimately changes sources), so without this an
  // accidental unlink saves silently and only surfaces when the nightly export
  // refuses it. When provided and a save would unalign words, the panel calls
  // this with the affected words + a `commit` that performs the save; the parent
  // surfaces a confirm and runs `commit` only if the user proceeds. Absent ⇒ the
  // save commits straight through (preserves prior behavior for any caller that
  // doesn't wire the confirm).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  // Side-by-side mode (all optional; absent = standalone single-panel behavior).
  // When `hover`/`onHoverChange` are provided the hover state is controlled by a
  // shared parent so two panels cross-highlight the same Hebrew. Likewise
  // `hoverLink`/`onToggleHoverLink` let the parent keep both toolbars in sync.
  // `renderUhbStrip={false}` suppresses the per-panel source strip (the parent
  // renders one shared strip). `onOpenDual` adds a "Side-by-side" action.
  hover?: HoverHighlight;
  onHoverChange?: (h: HoverHighlight) => void;
  hoverLink?: boolean;
  onToggleHoverLink?: () => void;
  renderUhbStrip?: boolean;
  onOpenDual?: () => void;
  // Restore a previously-saved version of this verse (content tree, alignment
  // included). When present, the action bar shows a version-history button that
  // opens the same dialog as rows mode. Absent ⇒ no history button (e.g. the
  // side-by-side panels, whose lifecycle/saves are parent-owned).
  onRestoreVersion?: (content: unknown, plainText: string | null) => void;
  // Hide the panel's own Cancel button. In side-by-side mode the panel's
  // lifecycle is owned by the parent (one shared close + dirty gate); the
  // per-panel Cancel would call handleReset() before that gate runs, wiping
  // this side's edits so a later "Save" can't recover them.
  hideCancel?: boolean;
  // When false, Hebrew source words don't show their lexical tooltip on hover.
  showSourceInfo?: boolean;
  // Offset of this panel's first source token within the side-by-side
  // aligner's union source span. Hover positions travel union-relative so the
  // shared strip and the opposite panel agree on which Hebrew token is meant
  // even when the two versions cover different verse ranges. 0 standalone.
  posOffset?: number;
}

const VerseHistoryDialog = lazy(() =>
  import("./VerseHistoryDialog").then((m) => ({ default: m.VerseHistoryDialog })),
);

export const AlignmentPanel = forwardRef<AlignmentPanelHandle, Props>(
  function AlignmentPanel(
    {
      book,
      chapter,
      verse,
      verseNum,
      bibleVersion,
      sourceVerse,
      sourceLabel,
      twlForVerse,
      onSave,
      onCancel,
      onDirtyChange,
      onConfirmUnalign,
      hover: hoverProp,
      onHoverChange,
      hoverLink: hoverLinkProp,
      onToggleHoverLink,
      renderUhbStrip = true,
      onOpenDual,
      onRestoreVersion,
      hideCancel = false,
      showSourceInfo = true,
      posOffset = 0,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [historyOpen, setHistoryOpen] = useState(false);
    // Extracted so the crash-draft hydration effect re-parses against the same
    // source tree computedInitial uses (parse needs the UHB/UGNT to re-anchor
    // milestones).
    const sourceVerseObjects = useMemo<unknown[] | null>(() => {
      return sourceVerse?.content &&
        Array.isArray((sourceVerse.content as { verseObjects?: unknown[] }).verseObjects)
        ? (sourceVerse.content as { verseObjects: unknown[] }).verseObjects
        : null;
    }, [sourceVerse]);
    const computedInitial = useMemo<AlignmentState | null>(() => {
      if (!verse?.content) return null;
      const verseObjects = (verse.content as { verseObjects?: unknown[] }).verseObjects;
      if (!Array.isArray(verseObjects)) return null;
      return parseAlignment(verseObjects, sourceVerseObjects);
    }, [verse, sourceVerseObjects]);

    const [initial, setInitial] = useState<AlignmentState | null>(computedInitial);
    const [state, setState] = useState<AlignmentState | null>(computedInitial);
    // Latest committed `state`, mirrored for the async crash-draft hydration:
    // the IDB read resolves after the panel has rendered, and the user may have
    // already dragged in that window — the hydration guards on this ref so a
    // restore never clobbers a fresh edit (see the reset/hydration effect).
    const stateRef = useRef(state);
    useEffect(() => {
      stateRef.current = state;
    });
    const [selectedUnaligned, setSelectedUnaligned] = useState<Set<string>>(new Set());
    const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
    const [showOnlyUnaligned, setShowOnlyUnaligned] = useState(false);
    const [hideUhbStrip, setHideUhbStrip] = useState<boolean>(() => readFlag(LS_HIDE_UHB));
    const [colorize, setColorize] = useState<boolean>(() => readFlag(LS_COLORIZE));
    // hover + hoverLink are controlled when the side-by-side parent passes them
    // in; otherwise they're local (standalone single-panel behavior unchanged).
    const [localHoverLink, setLocalHoverLink] = useState<boolean>(() => readFlag(LS_HOVERLINK));
    const hoverLink = hoverLinkProp !== undefined ? hoverLinkProp : localHoverLink;
    const [localHover, setLocalHover] = useState<HoverHighlight>(null);
    const hover = hoverProp !== undefined ? hoverProp : localHover;
    const setHover: (h: HoverHighlight) => void = onHoverChange ?? setLocalHover;
    // Session-scoped ghost rejections (keyed by dismissedGhostKey). Suppresses a
    // suggestion the user dismissed via the chip's × so it can't immediately
    // regenerate on the next render — the "predicted alignment" circle fix.
    const [dismissedGhosts, setDismissedGhosts] = useState<Set<string>>(new Set());
    // Whole-card merge: the group id currently being dragged by its grip
    // (drives merge-target highlighting), plus a one-tap-undo snapshot of the
    // state from just before the last merge.
    const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
    const [mergeUndo, setMergeUndo] = useState<AlignmentState | null>(null);
    // Set true when this mount restored a crash-saved draft (see the hydration
    // effect) so the user gets a non-blocking "restored unsaved alignment"
    // notice. Cleared on the next verse reset.
    const [restored, setRestored] = useState(false);

    const toggleHideUhbStrip = () => {
      setHideUhbStrip((cur) => {
        const next = !cur;
        writeFlag(LS_HIDE_UHB, next);
        return next;
      });
    };
    const toggleColorize = () => {
      setColorize((cur) => {
        const next = !cur;
        writeFlag(LS_COLORIZE, next);
        return next;
      });
    };
    const toggleHoverLink = () => {
      if (onToggleHoverLink) {
        onToggleHoverLink();
        return;
      }
      setLocalHoverLink((cur) => {
        const next = !cur;
        writeFlag(LS_HOVERLINK, next);
        if (!next) setHover(null);
        return next;
      });
    };

    // Sync to upstream verse changes (find/replace, version swap, etc.).
    // In-memory drag state is dropped from React state here; but if a
    // crash-saved draft exists for this verse it is re-hydrated below, so an
    // unsaved edit survives a reload/crash (and a normal navigation-away that
    // wasn't saved or discarded) rather than being silently lost.
    //
    // On the SAME dependency, attempt to restore a crash-saved alignment draft
    // (Fix C — a browser crash can't be caught by the beforeunload guard, so
    // in-progress drags are persisted per-change to alignmentDrafts). The reset
    // above runs synchronously to computedInitial; the draft load is async, so
    // its setState resolves AFTER and wins — that is deliberate. Three guards:
    // (1) the draft's version must still match the current base (otherwise the
    // base changed under it — another tab's save, a reimport — and applying it
    // would clobber newer content; a mismatched draft is discarded); (2) the
    // user must not have started editing in the async-read window (stateRef
    // still === computedInitial) so a restore never overwrites a fresh drag;
    // (3) the `cancelled` flag drops a resolution whose verse changed again.
    // `initial` stays computedInitial so the restored state reads as dirty
    // (state !== initial) and can be saved or reset.
    useEffect(() => {
      setInitial(computedInitial);
      setState(computedInitial);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
      setMergeUndo(null);
      setDraggingGroupId(null);
      setRestored(false);

      if (!computedInitial || !verse) return;
      const key = alignmentDraftKey(book, chapter, verseNum, bibleVersion);
      const baseVersion = verse.version;
      const baseGen = verse.source_generation;
      let cancelled = false;
      void alignmentDrafts.get(key).then((rec) => {
        if (cancelled || !rec) return;
        // Quarantined crash drafts are recovery-only (shared drafts store);
        // never restore them onto a replaced generation via the aligner path.
        if (rec.quarantined || isLaneFrozen(bibleVersion)) {
          void alignmentDrafts.clear(key);
          return;
        }
        if (rec.expectedVersion !== baseVersion) {
          void alignmentDrafts.clear(key);
          return;
        }
        if (
          rec.sourceGeneration == null ||
          (baseGen != null && rec.sourceGeneration !== baseGen)
        ) {
          void alignmentDrafts.clear(key);
          return;
        }
        // The user dragged during the async read — keep their edit; the persist
        // effect will overwrite the draft with it. Don't restore over it.
        if (stateRef.current !== computedInitial) return;
        const vo = (rec.content as { verseObjects?: unknown[] }).verseObjects;
        if (!Array.isArray(vo)) return;
        setState(parseAlignment(vo, sourceVerseObjects));
        setRestored(true);
      });
      return () => {
        cancelled = true;
      };
    }, [computedInitial, verse, book, chapter, verseNum, bibleVersion, sourceVerseObjects]);

    // Dismissals are per (verse, version) and only for this session — reset when
    // the user navigates to a different verse / edits a different bible, but NOT
    // on same-verse re-sync after a save (computedInitial churns then; the
    // coordinate doesn't), so rejected ghosts stay rejected across a save.
    useEffect(() => {
      setDismissedGhosts(new Set());
    }, [verseNum, bibleVersion]);

    const dirty = state !== initial && state !== null;
    useEffect(() => {
      onDirtyChange?.(dirty);
    }, [dirty, onDirtyChange]);

    // Fix C — persist in-progress drags to IndexedDB so a browser crash (which
    // beforeunload can't intercept) doesn't lose them. Debounced so a burst of
    // drags coalesces into one write. Only writes while dirty; a non-dirty
    // state means the panel is at baseline or was just reset, and the draft is
    // cleared explicitly on save/reset (never here) so navigating INTO a verse
    // that has a persisted draft doesn't wipe it before hydration reads it.
    useEffect(() => {
      if (!dirty || !state || !verse) return;
      const key = alignmentDraftKey(book, chapter, verseNum, bibleVersion);
      const baseVersion = verse.version;
      const t = setTimeout(() => {
        const content = { verseObjects: serializeAlignment(state) };
        void alignmentDrafts.set(key, content, baseVersion, {
          sourceGeneration: verse.source_generation,
        });
      }, 400);
      return () => clearTimeout(t);
    }, [state, dirty, verse, book, chapter, verseNum, bibleVersion]);

    const handleTargetsDrop = (dest: string, wordIds: string[]) => {
      if (!state || wordIds.length === 0) return;
      setState(moveTargets(state, wordIds, dest));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleSourceDrop = (destGroupId: string, sourceId: string) => {
      if (!state) return;
      // The drop target is a DISPLAY card, which may have collapsed several
      // state groups sharing a source position (occ 1/2 + 2/2 over-count → one
      // physical token, see displayGroups/mergeSamePositionGroups). Add the
      // word to EVERY group the card fused — by sourceKey OR position, the same
      // identity handleClearGroup uses — so the card stays one card instead of
      // splitting the hidden siblings back out (ZEC 10:2 UST duplicate-teraphim).
      const target = state.groups.find((g) => g.id === destGroupId);
      if (!target) return;
      const key = sourceKey(target);
      const posKey = groupPositionKey(target, sourceIndexMap);
      const destGroupIds = [
        destGroupId,
        ...state.groups
          .filter(
            (g) =>
              g.id !== destGroupId &&
              (sourceKey(g) === key ||
                (posKey !== null && groupPositionKey(g, sourceIndexMap) === posKey)),
          )
          .map((g) => g.id),
      ];
      setState(
        moveSourceToGroups(state, sourceId, destGroupIds, (s) =>
          resolveSourcePos(s, sourceIndexMap),
        ),
      );
    };
    const handleExtractSource = (sourceId: string) => {
      if (!state) return;
      setState(extractSource(state, sourceId));
    };
    // Resolve a DISPLAY card id back to EVERY state group it collapsed — by
    // sourceKey OR source position, the same identity handleClearGroup /
    // handleSourceDrop use. A card fuses groups by source identity
    // (mergeAdjacentSameSource) AND by position (mergeSamePositionGroups → the
    // occ 1/2 + 2/2 over-count), so the carried id alone under-counts it. The
    // carried id stays first so it leads the returned list.
    const groupsForCard = (cardId: string): string[] => {
      if (!state) return [cardId];
      const target = state.groups.find((g) => g.id === cardId);
      if (!target) return [cardId];
      const key = sourceKey(target);
      const posKey = groupPositionKey(target, sourceIndexMap);
      return [
        cardId,
        ...state.groups
          .filter(
            (g) =>
              g.id !== cardId &&
              (sourceKey(g) === key ||
                (posKey !== null && groupPositionKey(g, sourceIndexMap) === posKey)),
          )
          .map((g) => g.id),
      ];
    };
    // Merge a whole card (the dragged group) into the card it was dropped on.
    // survivor = the earlier-positioned of the two, so the combined Hebrew
    // chain reads in verse order regardless of drag direction. Each side may be
    // a position-fused card standing for several state groups (see
    // mergeGroupsToGroups), so resolve both to all their underlying groups.
    const handleMergeGroups = (dropTargetId: string, draggedId: string) => {
      if (!state || dropTargetId === draggedId) return;
      const order = displayGroups.map((g) => g.id);
      const ti = order.indexOf(dropTargetId);
      const di = order.indexOf(draggedId);
      const [survivor, eaten] =
        ti !== -1 && di !== -1 && di < ti
          ? [draggedId, dropTargetId]
          : [dropTargetId, draggedId];
      const next = mergeGroupsToGroups(
        state,
        groupsForCard(survivor),
        groupsForCard(eaten),
        (s) => resolveSourcePos(s, sourceIndexMap),
      );
      if (next === state) return;
      setMergeUndo(state);
      setState(next);
      setDraggingGroupId(null);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleUndoMerge = () => {
      if (!mergeUndo) return;
      setState(mergeUndo);
      setMergeUndo(null);
    };
    const handleClearGroup = (groupId: string) => {
      if (!state) return;
      const target = state.groups.find((g) => g.id === groupId);
      if (!target) return;
      // Clear EVERY underlying group the displayed card collapsed together, not
      // just the one whose id the card carries. A card fuses groups by source
      // identity (mergeAdjacentSameSource → sourceKey) AND by source position
      // (mergeSamePositionGroups → positionKey); an AI over-count (occ 1/2 +
      // 2/2 → one physical token) hides a second group under a DIFFERENT
      // sourceKey, so clearing by sourceKey alone left its targets aligned.
      const key = sourceKey(target);
      const posKey = groupPositionKey(target, sourceIndexMap);
      let next = state;
      for (const g of state.groups) {
        if (sourceKey(g) === key || (posKey !== null && groupPositionKey(g, sourceIndexMap) === posKey)) {
          next = clearGroup(next, g.id);
        }
      }
      setState(next);
    };
    const handleClearSelection = () => {
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    const handleChipClick = (id: string, shift: boolean) => {
      if (!state) return;
      if (shift && selectionAnchor) {
        const all = state.unaligned.map((w) => w.id);
        const a = all.indexOf(selectionAnchor);
        const b = all.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const range = all.slice(lo, hi + 1);
          setSelectedUnaligned((prev) => {
            const next = new Set(prev);
            for (const w of range) next.add(w);
            return next;
          });
          return;
        }
      }
      setSelectedUnaligned((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchor(id);
    };
    const idsForUnalignedDrag = (id: string) =>
      selectedUnaligned.has(id) && selectedUnaligned.size > 1
        ? Array.from(selectedUnaligned)
        : [id];

    const themeMode = useTheme().palette.mode;

    // Per-(text|occurrence) hue assignment for the "match instances by
    // color" toggle. Same lemma → distinct hues spaced around the OKLCH
    // wheel; chips with a single occurrence get no entry. Stream order
    // anchors left-to-right hue progression within each duplicate group.
    const matchHues = useMemo(() => {
      if (!state) return new Map<string, number>();
      const items: Array<{ key: string; lemma: string }> = [];
      for (const item of state.stream) {
        if (item.kind !== "word") continue;
        const w = item.word;
        const n = parseInt(w.occurrences, 10);
        if (!Number.isFinite(n) || n <= 1) continue;
        items.push({ key: `${w.text}|${w.occurrence}`, lemma: w.text });
      }
      return assignChipHues(items);
    }, [state]);

    // Cross-language hover linking needs to know which alignment group each
    // chip / Hebrew word belongs to.
    const targetIdToGroupId = useMemo(() => {
      const map = new Map<string, string>();
      if (!state) return map;
      for (const item of state.stream) {
        if (item.kind !== "word") continue;
        if (item.alignedTo) map.set(item.word.id, item.alignedTo);
      }
      return map;
    }, [state]);
    // Map Hebrew tokens to alignment groups by source-token POSITION.
    // `strong|occurrence` is NOT unique: occurrence numbers the exact surface
    // text (cantillation included), so same-Strong words with different
    // pointing all carry occurrence 1 (three אֶל forms in ZEC 1:3 are each
    // H0413|1 — 236 such collisions across ZEC) and the strong-keyed map lit
    // the wrong word. Each group source word resolves to a position via the
    // same text→strong fallback chain displayGroups sorts by; the strip's
    // tokens carry their walk position natively. Positions in `hover` are
    // union-relative (see highlightTypes.ts); these maps are own-relative and
    // translate via posOffset at the comparison sites.
    const sourceIndexMap = useMemo(() => buildSourceIndexMap(sourceVerse), [sourceVerse]);

    const displayGroups = useMemo(() => {
      if (!state) return [];
      const sortKey = (g: (typeof state.groups)[number]) => {
        if (g.source.length === 0) return Number.MAX_SAFE_INTEGER;
        const pos = resolveSourcePos(g.source[0], sourceIndexMap);
        return pos >= 0 ? pos : Number.MAX_SAFE_INTEGER;
      };
      const sorted = [...state.groups].sort((a, b) => sortKey(a) - sortKey(b));
      const stripped = stripCompoundOverlaps(sorted);
      const merged = mergeAdjacentSameSource(stripped);
      // Collapse same-position duplicates (one physical Hebrew token the AI
      // stamped with occurrences>actual — see mergeSamePositionGroups).
      return mergeSamePositionGroups(merged, (g) => groupPositionKey(g, sourceIndexMap));
    }, [state, sourceIndexMap]);

    const posMaps = useMemo(() => {
      const posToGroupId = new Map<number, string>();
      const sourcePosById = new Map<string, number>();
      const groupPositions = new Map<string, number[]>();
      if (!state) return { posToGroupId, sourcePosById, groupPositions };
      // sourcePosById + groupPositions cover EVERY state.groups source word so
      // any rendered token (and any word whose `alignedTo` points at a group
      // mergeAdjacentSameSource later folds away) still resolves its position.
      for (const g of state.groups) {
        const positions: number[] = [];
        for (const s of g.source) {
          const pos = resolveSourcePos(s, sourceIndexMap);
          sourcePosById.set(s.id, pos);
          if (pos < 0) continue;
          positions.push(pos);
        }
        groupPositions.set(g.id, positions);
      }
      // posToGroupId — position → which CARD owns it — must come from the
      // groups the cards actually render (displayGroups), not state.groups:
      // stripCompoundOverlaps drops a compound's source word when a standalone
      // card already owns that content, so mapping off state.groups let the
      // stripped token's position win by parse order and light the wrong card
      // on a strip-token hover.
      for (const g of displayGroups) {
        for (const s of g.source) {
          const pos = sourcePosById.get(s.id) ?? -1;
          if (pos < 0) continue;
          if (!posToGroupId.has(pos)) posToGroupId.set(pos, g.id);
        }
      }
      return { posToGroupId, sourcePosById, groupPositions };
    }, [state, displayGroups, sourceIndexMap]);

    // Highlight resolution. `hover` may name an English or Hebrew word; we
    // mark same-language matches as "exact" and aligned cross-language
    // partners as "linked". The handlers no-op when hoverLink is off so the
    // chips can fire them unconditionally.
    const onEnglishHover = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string) => {
        if (!hoverLink) return;
        const groupId = groupIdOverride ?? targetIdToGroupId.get(wordId) ?? null;
        // Union positions of the group's Hebrew — lets the shared strip and
        // the opposite panel light their counterparts without sharing group
        // ids (ids are regenerated per panel parse).
        const positions = (groupId ? posMaps.groupPositions.get(groupId) ?? [] : []).map(
          (p) => p + posOffset,
        );
        // Scope the english key by bibleVersion: `hover` is shared across both
        // side-by-side panels, so an un-scoped `${text}|${occurrence}` key
        // would give the OTHER panel's same-text/occurrence chip a false
        // "exact" ring (hover ULT "and"(3) → UST "and"(3) lights too).
        setHover({
          kind: "english",
          key: `${bibleVersion}:${text}|${occurrence}`,
          groupId,
          positions,
        });
      },
      [hoverLink, bibleVersion, targetIdToGroupId, posMaps, posOffset, setHover],
    );
    const onHebrewHover = useCallback(
      (pos: number, groupIdOverride?: string) => {
        if (!hoverLink) return;
        if (pos < 0 && !groupIdOverride) return;
        setHover({
          kind: "hebrew",
          pos,
          groupId: groupIdOverride ?? posMaps.posToGroupId.get(pos - posOffset) ?? null,
        });
      },
      [hoverLink, posMaps, posOffset, setHover],
    );
    const onHoverLeave = useCallback(() => {
      setHover(null);
    }, [setHover]);

    const englishHighlight = useCallback(
      (wordId: string, text: string, occurrence: string, groupIdOverride?: string): "exact" | "linked" | null => {
        if (!hoverLink || !hover) return null;
        // Match the bibleVersion-scoped key set in onEnglishHover so the
        // opposite panel's same-text chip doesn't ring "exact".
        const myKey = `${bibleVersion}:${text}|${occurrence}`;
        if (hover.kind === "english" && hover.key === myKey) return "exact";
        const myGroupId = groupIdOverride ?? targetIdToGroupId.get(wordId) ?? null;
        if (!myGroupId) return null;
        if (hover.kind === "hebrew") {
          // Resolve the hovered Hebrew position to THIS panel's own group.
          // The carried hover.groupId belongs to whichever panel the cursor
          // is in, so cross-panel linking resolves locally — each side lights
          // its own English (ULT "And I answered" ↔ UST "I asked"). The
          // groupId equality covers this panel's own card words whose source
          // pos failed to resolve (mirrors hebrewHighlight's fallback; group
          // ids are per-panel UUIDs, so no cross-panel false match).
          if (posMaps.posToGroupId.get(hover.pos - posOffset) === myGroupId) return "linked";
          if (hover.groupId === myGroupId) return "linked";
          return null;
        }
        // English hovered (possibly in the other panel): its group's union
        // Hebrew positions resolve here to the group that shares the Hebrew.
        return hover.positions.some((p) => posMaps.posToGroupId.get(p - posOffset) === myGroupId)
          ? "linked"
          : null;
      },
      [hoverLink, hover, bibleVersion, targetIdToGroupId, posMaps, posOffset],
    );
    const hebrewHighlight = useCallback(
      (pos: number, groupIdOverride?: string): "exact" | "linked" | null => {
        if (!hoverLink || !hover) return null;
        if (pos >= 0 && hover.kind === "hebrew" && hover.pos === pos) return "exact";
        const myGroupId =
          groupIdOverride ?? (pos >= 0 ? posMaps.posToGroupId.get(pos - posOffset) ?? null : null);
        if (!myGroupId) return null;
        if (hover.kind === "hebrew") {
          // Whole-group: the rest of the hovered word's group lights, resolved
          // to THIS panel's grouping — a compound card shows its siblings even
          // when the other side keeps them separate.
          return posMaps.posToGroupId.get(hover.pos - posOffset) === myGroupId ? "linked" : null;
        }
        // English hover: its group's union positions name the Hebrew directly
        // (works on the shared strip and across panels); the groupId equality
        // covers this panel's own card words that failed position resolution.
        return hover.positions.includes(pos) || hover.groupId === myGroupId ? "linked" : null;
      },
      [hoverLink, hover, posMaps, posOffset],
    );

    // Reading direction of each side, set as `dir` on the word containers so
    // the chips lay out in reading order regardless of the UI language (#532).
    // Target words follow the project's language (an Arabic ULT is RTL even
    // under an English UI); source words follow the book's original language
    // (Hebrew OT RTL, Greek NT LTR).
    const projectConfig = useProjectConfig();
    const targetDir: "rtl" | "ltr" = versionIsRtl(projectConfig, bibleVersion) ? "rtl" : "ltr";
    const sourceDir: "rtl" | "ltr" = isHebrewBook(book) ? "rtl" : "ltr";

    const hctx: HighlightCtx = useMemo(
      () => ({
        colorize,
        hoverLink,
        showSourceInfo,
        matchHues,
        themeMode,
        onEnglishEnter: onEnglishHover,
        onHebrewEnter: onHebrewHover,
        onLeave: onHoverLeave,
        englishHighlight,
        hebrewHighlight,
      }),
      [
        colorize,
        hoverLink,
        showSourceInfo,
        matchHues,
        themeMode,
        onEnglishHover,
        onHebrewHover,
        onHoverLeave,
        englishHighlight,
        hebrewHighlight,
      ],
    );

    const allStrongs = useMemo(() => {
      const strongs = new Set<string>();
      const keys = new Set<string>(); // "<strong>~<morphClass>" suggestion keys
      const add = (strong: string, morph: string | undefined) => {
        if (!strong) return;
        strongs.add(strong);
        keys.add(suggestKey(strong, morph));
      };
      if (state) {
        for (const g of state.groups) for (const s of g.source) add(s.strong, s.morph);
      }
      const sourceObjects = (sourceVerse?.content as { verseObjects?: unknown[] } | null)
        ?.verseObjects;
      if (Array.isArray(sourceObjects)) {
        // Shared source-word walk (usfm.ts descent rule) — the hand-rolled
        // any-milestone walk this replaced missed every `\qs`-wrapped word, so a
        // wrapped Strong's never reached the lexicon prefetch or /align/suggest
        // (#370).
        for (const { node } of collectSourceWordNodes(sourceObjects)) {
          add(String(node["strong"] ?? ""), node["morph"] as string | undefined);
        }
      }
      return { strongs: [...strongs], keys: [...keys] };
    }, [state, sourceVerse]);
    const lexiconMap = useLexicon(allStrongs.strongs);

    // Non-AI alignment suggestions over the canonical corpus (see hook). The
    // source-strong set is stable across alignment edits within a verse, so
    // this fetches once per verse; ghostByGroup is recomputed locally as words
    // get aligned. Ghosts only appear on still-empty groups.
    const suggestions = useAlignmentSuggestions(bibleVersion, allStrongs.keys);
    // Document-order word tokens with their aligned state — phrase ghosts need
    // adjacency, so this is the basis for the contiguous-run match.
    const streamWords = useMemo<StreamWord[]>(
      () =>
        state
          ? state.stream.flatMap((it) =>
              it.kind === "word"
                ? [{ id: it.word.id, text: it.word.text, aligned: it.alignedTo !== null }]
                : [],
            )
          : [],
      [state],
    );
    const ghostByGroup = useMemo(
      () => computeGhosts(displayGroups, streamWords, suggestions, dismissedGhosts),
      [displayGroups, streamWords, suggestions, dismissedGhosts],
    );
    const handleAcceptGhost = (groupId: string, wordIds: string[]) => {
      handleTargetsDrop(`g:${groupId}`, wordIds);
    };
    const handleDismissGhost = (ghost: Ghost) => {
      const g = displayGroups.find((x) => x.id === ghost.groupId);
      if (!g) return;
      const key = dismissedGhostKey(g, ghost.text);
      setDismissedGhosts((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    };
    const handleAcceptAllGhosts = () => {
      if (!state || ghostByGroup.size === 0) return;
      let next = state;
      for (const gh of ghostByGroup.values()) {
        next = moveTargets(next, gh.wordIds, `g:${gh.groupId}`);
      }
      setState(next);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };

    const handleReset = useCallback(() => {
      setState(initial);
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
      setRestored(false);
      // Explicit discard of unsaved work — drop the crash-draft too so it can't
      // rehydrate on reopen.
      void alignmentDrafts.clear(alignmentDraftKey(book, chapter, verseNum, bibleVersion));
    }, [initial, book, chapter, verseNum, bibleVersion]);
    const handleClearAll = () => {
      if (!state) return;
      setState(clearAll(state));
      setSelectedUnaligned(new Set());
      setSelectionAnchor(null);
    };
    // Returns true if the save COMMITTED synchronously, false if it was deferred
    // behind the unalign confirm. `afterCommit` runs once the save actually lands
    // — immediately on a clean save, or after "Save anyway"; it never runs if the
    // user cancels. Callers that navigate/close after saving (the dirty gates in
    // Shell) pass the nav as `afterCommit` so it waits for the real commit instead
    // of firing while the confirm is still open.
    const handleSave = useCallback((afterCommit?: () => void): boolean => {
      if (!state || !verse) {
        afterCommit?.();
        return true;
      }
      const newVerseObjects = serializeAlignment(state);
      const newContent = { verseObjects: newVerseObjects };
      const plain = alignmentPlainText(state);
      // The commit closure captures `state`, so when it runs after a confirm the
      // optimistic baseline reset still uses the state that was saved.
      const commit = () => {
        onSave(newContent, plain, verse.version);
        // Optimistic: the freshly-saved state is now the baseline. When the
        // chapter cache eventually round-trips the new content, computedInitial
        // recomputes and the useEffect resets state to it (idempotent).
        setInitial(state);
        setRestored(false);
        // The alignment is now queued in the outbox; drop the crash-draft
        // immediately. onOutboxResult also clears it when the PATCH lands
        // (belt-and-suspenders in alignmentDrafts.ts).
        void alignmentDrafts.clear(alignmentDraftKey(book, chapter, verseNum, bibleVersion));
        afterCommit?.();
      };
      // Warn before unaligning a previously-aligned word. On "Cancel" the parent
      // runs nothing, so `commit` (and thus setInitial + afterCommit) never fires
      // and the panel stays dirty — the user can re-align and save again.
      const lostWords = lostAlignedWords(verse.content, newContent);
      if (lostWords.length > 0 && onConfirmUnalign) {
        onConfirmUnalign(lostWords, commit);
        return false;
      }
      commit();
      return true;
    }, [state, verse, onSave, onConfirmUnalign, book, chapter, verseNum, bibleVersion]);

    useImperativeHandle(
      ref,
      () => ({
        isDirty: () => dirty,
        save: handleSave,
        reset: handleReset,
        discard: handleReset,
        flushCrashDraft: () => {
          if (!dirty || !state || !verse) return;
          const key = alignmentDraftKey(book, chapter, verseNum, bibleVersion);
          const content = { verseObjects: serializeAlignment(state) };
          void alignmentDrafts.set(key, content, verse.version, {
            sourceGeneration: verse.source_generation,
          });
        },
        getDirtySnapshot: () => {
          if (!dirty || !state || !verse) return null;
          return {
            content: { verseObjects: serializeAlignment(state) },
            plainText: alignmentPlainText(state),
            expectedVersion: verse.version,
          };
        },
      }),
      [dirty, handleSave, handleReset, state, verse, book, chapter, verseNum, bibleVersion],
    );


    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          // Fill the remaining height of the flex-column parent (the resource
          // column below its tabs header, or a side-by-side panel wrapper)
          // rather than `height: 100%`, which overflowed by the header's height
          // in the single-panel mount and clipped the footer. minHeight: 0 lets
          // the inner cards area shrink and scroll on short viewports.
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          bgcolor: "background.paper",
        }}
      >
        {!state && (
          <Box sx={{ p: 3 }}>
            <Typography variant="body2" color="text.secondary">
              {t("aligner.noAlignmentData")}
            </Typography>
          </Box>
        )}
        {state && (
          <>
            {renderUhbStrip && (
              <UhbStrip
                sourceVerse={sourceVerse}
                sourceLabel={sourceLabel}
                lexiconMap={lexiconMap}
                twlForVerse={twlForVerse}
                verseNum={verseNum}
                hidden={hideUhbStrip}
                onToggleHidden={toggleHideUhbStrip}
                hctx={hctx}
              />
            )}
            <InventoryStrip
              state={state}
              bibleVersion={bibleVersion}
              selectedIds={selectedUnaligned}
              showOnlyUnaligned={showOnlyUnaligned}
              onToggleShowOnlyUnaligned={() => setShowOnlyUnaligned((v) => !v)}
              onChipClick={handleChipClick}
              idsForDrag={idsForUnalignedDrag}
              onClearSelection={handleClearSelection}
              onDrop={(ids) => handleTargetsDrop("u", ids)}
              colorize={colorize}
              hoverLink={hoverLink}
              onToggleColorize={toggleColorize}
              onToggleHoverLink={toggleHoverLink}
              hctx={hctx}
              targetDir={targetDir}
            />
            <SectionHeader count={displayGroups.length} />
            <Box
              sx={{
                flex: 1,
                // Allow this scroller to shrink below its content height so it
                // actually scrolls (and the footer stays visible) when the
                // strips above it leave little room on a short viewport.
                minHeight: 0,
                overflowY: "auto",
                px: 1.5,
                pb: 1.5,
              }}
            >
              <AlignmentCards
                groups={displayGroups}
                ghostByGroup={ghostByGroup}
                onAcceptGhost={handleAcceptGhost}
                onDismissGhost={handleDismissGhost}
                twlForVerse={twlForVerse}
                lexiconMap={lexiconMap}
                verseNum={verseNum}
                onTargetsDrop={handleTargetsDrop}
                selectedWordIds={Array.from(selectedUnaligned)}
                onClearSelection={handleClearSelection}
                onSourceDrop={handleSourceDrop}
                onExtractSource={handleExtractSource}
                onClearGroup={handleClearGroup}
                onMerge={handleMergeGroups}
                draggingGroupId={draggingGroupId}
                onGroupDragStart={setDraggingGroupId}
                onGroupDragEnd={() => setDraggingGroupId(null)}
                hctx={hctx}
                sourcePos={posMaps.sourcePosById}
                posOffset={posOffset}
                sourceDir={sourceDir}
                targetDir={targetDir}
              />
            </Box>
            <ActionBar
              dirty={dirty}
              ghostCount={ghostByGroup.size}
              onAcceptAll={handleAcceptAllGhosts}
              onClear={handleClearAll}
              onReset={handleReset}
              onCancel={() => {
                handleReset();
                onCancel();
              }}
              hideCancel={hideCancel}
              onSave={handleSave}
              bibleVersion={bibleVersion}
              onOpenDual={onOpenDual}
              version={verse?.version}
              onOpenHistory={onRestoreVersion ? () => setHistoryOpen(true) : undefined}
            />
            <Snackbar
              open={mergeUndo !== null}
              autoHideDuration={6000}
              onClose={() => setMergeUndo(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
              message={t("aligner.mergedGroups")}
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={handleUndoMerge}
                  sx={{ fontWeight: 700 }}
                >
                  {t("aligner.undo")}
                </Button>
              }
            />
            <Snackbar
              open={restored}
              autoHideDuration={6000}
              onClose={() => setRestored(false)}
              anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
              message={t("aligner.restoredUnsaved")}
            />
          </>
        )}
        {historyOpen && verse && (
          <Suspense fallback={null}>
            <VerseHistoryDialog
              open={historyOpen}
              book={book}
              chapter={chapter}
              verseNum={verseNum}
              bibleVersion={bibleVersion}
              currentVersion={verse.version}
              onClose={() => setHistoryOpen(false)}
              onUseVersion={(content, plainText) => onRestoreVersion?.(content, plainText)}
            />
          </Suspense>
        )}
      </Box>
    );
  },
);

// ─── Inventory chip strip (aligned strikethrough + unaligned interactive) ──
function InventoryStrip({
  state,
  bibleVersion,
  selectedIds,
  showOnlyUnaligned,
  onToggleShowOnlyUnaligned,
  onChipClick,
  idsForDrag,
  onClearSelection,
  onDrop,
  colorize,
  hoverLink,
  onToggleColorize,
  onToggleHoverLink,
  hctx,
  targetDir,
}: {
  state: AlignmentState;
  bibleVersion: string;
  selectedIds: Set<string>;
  showOnlyUnaligned: boolean;
  onToggleShowOnlyUnaligned: () => void;
  onChipClick: (id: string, shift: boolean) => void;
  idsForDrag: (id: string) => string[];
  onClearSelection: () => void;
  onDrop: (wordIds: string[]) => void;
  colorize: boolean;
  hoverLink: boolean;
  onToggleColorize: () => void;
  onToggleHoverLink: () => void;
  hctx: HighlightCtx;
  targetDir: "rtl" | "ltr";
}) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const versionDisplay = versionLabel(projectConfig, bibleVersion);
  const [over, setOver] = useState(false);
  const [chipAreaHeight, setChipAreaHeight] = useState<number>(() =>
    clampInventoryHeight(readNumber(LS_INVENTORY_HEIGHT, DEFAULT_INVENTORY_HEIGHT)),
  );
  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = chipAreaHeight;
      let last = startHeight;
      const onMove = (ev: MouseEvent) => {
        const next = clampInventoryHeight(startHeight + (ev.clientY - startY));
        last = next;
        setChipAreaHeight(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        writeNumber(LS_INVENTORY_HEIGHT, last);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [chipAreaHeight],
  );
  const unalignedIds = new Set(state.unaligned.map((w) => w.id));
  const streamWords = state.stream.flatMap((item, idx) =>
    item.kind === "word" ? [{ idx, word: item.word, aligned: item.alignedTo !== null }] : [],
  );
  const visible = showOnlyUnaligned ? streamWords.filter((w) => !w.aligned) : streamWords;
  const unalignedCount = state.unaligned.length;
  return (
    <Box
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const ids = readWordIds(e.dataTransfer);
        const movable = ids.filter((id) => !unalignedIds.has(id));
        if (movable.length > 0) onDrop(movable);
      }}
      sx={{
        px: 2,
        pt: 1,
        pb: 1.25,
        bgcolor: over ? "primary.50" : "grey.100",
        flexShrink: 0,
        position: "relative",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            fontSize: 10,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "text.secondary",
            fontWeight: 600,
          }}
        >
          {t("aligner.versionWords", { version: versionDisplay })}
        </Typography>
        <Chip
          label={t("aligner.unalignedCount", { count: unalignedCount })}
          size="small"
          sx={{
            height: 18,
            fontFamily: "monospace",
            fontSize: 10,
            bgcolor: unalignedCount > 0 ? "warning.light" : "primary.50",
            color: unalignedCount > 0 ? "warning.contrastText" : "primary.dark",
          }}
        />
        {selectedIds.size > 0 && (
          <>
            <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
              {t("aligner.selectedCount", { count: selectedIds.size })}
            </Typography>
            <Tooltip title={t("aligner.clearSelection")}>
              <IconButton size="small" onClick={onClearSelection} sx={{ p: 0.25 }}>
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Box sx={{ flex: 1 }} />
        <ToolbarToggle
          label={t("aligner.colors")}
          checked={colorize}
          onChange={onToggleColorize}
          tooltip={t("aligner.colorsTooltip")}
        />
        <ToolbarToggle
          label={t("aligner.hoverLink")}
          checked={hoverLink}
          onChange={onToggleHoverLink}
          tooltip={t("aligner.hoverLinkTooltip")}
        />
        <Button
          size="small"
          variant="text"
          onClick={onToggleShowOnlyUnaligned}
          sx={{
            fontSize: 11,
            textTransform: "none",
            color: showOnlyUnaligned ? "primary.main" : "text.secondary",
            minWidth: 0,
            px: 0.75,
            py: 0.25,
          }}
        >
          {showOnlyUnaligned ? t("aligner.showAll") : t("aligner.showOnlyUnaligned")}
        </Button>
      </Stack>
      <Box
        dir={targetDir}
        sx={{
          display: "flex",
          flexWrap: "wrap",
          gap: 0.5,
          rowGap: 1.25,
          maxHeight: chipAreaHeight,
          overflowY: "auto",
          // Extra top padding so chip superscripts (`mt: -2px` in targetLabel)
          // aren't clipped by the strip's overflow region. Also small
          // horizontal padding so the hover-link box-shadow ring on edge
          // chips doesn't get cropped by overflow-x (auto-promoted by
          // overflow-y: auto).
          pt: 1.5,
          pb: 0.5,
          px: 0.5,
        }}
      >
        {visible.length === 0 && (
          <Typography variant="caption" sx={{ color: "text.disabled", fontStyle: "italic" }}>
            {showOnlyUnaligned ? t("aligner.allWordsAligned") : t("aligner.noWordsInVerse")}
          </Typography>
        )}
        {visible.map(({ idx, word, aligned }) =>
          aligned ? (
            <AlignedChip
              key={`${word.text}|${word.occurrence}|${idx}`}
              wordId={word.id}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              hctx={hctx}
            />
          ) : (
            <SelectableChip
              key={`${word.text}|${word.occurrence}|${idx}`}
              wordId={word.id}
              text={word.text}
              occurrence={word.occurrence}
              occurrences={word.occurrences}
              selected={selectedIds.has(word.id)}
              onClick={(shift) => onChipClick(word.id, shift)}
              idsForDrag={() => idsForDrag(word.id)}
              hctx={hctx}
            />
          ),
        )}
      </Box>
      <Box
        onMouseDown={startResize}
        title={t("aligner.dragToResize")}
        sx={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: -4,
          height: 8,
          cursor: "ns-resize",
          zIndex: 1,
          "&::after": {
            content: '""',
            position: "absolute",
            left: 0,
            right: 0,
            top: "50%",
            height: "1px",
            bgcolor: "divider",
            transform: "translateY(-50%)",
            transition: "background-color 0.15s, height 0.15s",
          },
          "&:hover::after, &:active::after": {
            bgcolor: "primary.main",
            height: "2px",
          },
        }}
      />
    </Box>
  );
}

// ─── Section header above cards ────────────────────────────────────────
function SectionHeader({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <Stack
      direction="row"
      alignItems="baseline"
      spacing={1}
      sx={{ px: 2, pt: 1.25, pb: 0.75, flexShrink: 0 }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "text.secondary",
          fontWeight: 600,
        }}
      >
        {t("aligner.groups", { count })}
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", fontSize: 10.5 }}
      >
        {t("aligner.dragHint")}
      </Typography>
    </Stack>
  );
}

// ─── Action bar ────────────────────────────────────────────────────────
function ActionBar({
  dirty,
  ghostCount,
  onAcceptAll,
  onClear,
  onReset,
  onCancel,
  hideCancel,
  onSave,
  bibleVersion,
  onOpenDual,
  version,
  onOpenHistory,
}: {
  dirty: boolean;
  ghostCount: number;
  onAcceptAll: () => void;
  onClear: () => void;
  onReset: () => void;
  onCancel: () => void;
  hideCancel?: boolean;
  onSave: () => void;
  bibleVersion: string;
  onOpenDual?: () => void;
  version?: number;
  onOpenHistory?: () => void;
}) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const versionDisplay = versionLabel(projectConfig, bibleVersion);
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.5}
      useFlexGap
      flexWrap="wrap"
      sx={{
        px: 1.5,
        py: 1,
        rowGap: 0.5,
        borderTop: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
        flexShrink: 0,
      }}
    >
      <Typography
        variant="caption"
        sx={{ fontFamily: "monospace", color: "text.disabled", fontSize: 10 }}
      >
        {t("aligner.editing", { version: versionDisplay })}
      </Typography>
      {/* Spacer keeps the actions right-aligned when the bar fits on one line;
          when it doesn't (narrow laptop screens), the actions wrap to a second
          row instead of the rightmost Save button overflowing off-screen. */}
      <Box sx={{ flex: 1, minWidth: 0 }} />
      {onOpenHistory && version != null && (
        <Tooltip title={t("aligner.versionHistory")}>
          <Button
            size="small"
            startIcon={<HistoryIcon sx={{ fontSize: 16 }} />}
            onClick={onOpenHistory}
            sx={{
              textTransform: "none",
              fontSize: 11,
              mr: 0.5,
              color: "text.secondary",
              fontFamily: "monospace",
            }}
          >
            {t("aligner.versionChip", { version })}
          </Button>
        </Tooltip>
      )}
      {onOpenDual && (
        <Tooltip title={t("aligner.openDualTooltip", { left: versionLabel(projectConfig, "ULT"), right: versionLabel(projectConfig, "UST") })}>
          <Button
            size="small"
            onClick={onOpenDual}
            sx={{
              textTransform: "none",
              fontSize: 11,
              mr: 0.5,
              color: "text.secondary",
            }}
          >
            {t("aligner.sideBySide")}
          </Button>
        </Tooltip>
      )}
      {ghostCount > 0 && (
        <Button
          size="small"
          variant="outlined"
          onClick={onAcceptAll}
          sx={{
            textTransform: "none",
            fontSize: 11,
            mr: 0.5,
            borderStyle: "dashed",
            color: "primary.main",
            borderColor: "primary.main",
          }}
        >
          {t("aligner.acceptSuggestions", { count: ghostCount })}
        </Button>
      )}
      <Button
        size="small"
        onClick={onClear}
        sx={{
          color: "error.main",
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {t("aligner.clear")}
      </Button>
      <Button
        size="small"
        onClick={onReset}
        disabled={!dirty}
        sx={{
          color: "text.secondary",
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {t("aligner.reset")}
      </Button>
      {!hideCancel && (
        <Button
          size="small"
          onClick={onCancel}
          sx={{
            color: "text.primary",
            textTransform: "uppercase",
            fontSize: 11,
            letterSpacing: "0.06em",
            fontWeight: 600,
          }}
        >
          {t("common.cancel")}
        </Button>
      )}
      <Button
        size="small"
        variant="contained"
        onClick={() => onSave()}
        disabled={!dirty}
        sx={{
          textTransform: "uppercase",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 700,
          px: 2,
        }}
      >
        {t("aligner.saveVersion", { version: versionDisplay })}
      </Button>
    </Stack>
  );
}

// ─── Cards grid (restyled) ─────────────────────────────────────────────
function AlignmentCards({
  groups,
  ghostByGroup,
  onAcceptGhost,
  onDismissGhost,
  twlForVerse,
  lexiconMap,
  verseNum,
  onTargetsDrop,
  selectedWordIds,
  onClearSelection,
  onSourceDrop,
  onExtractSource,
  onClearGroup,
  onMerge,
  draggingGroupId,
  onGroupDragStart,
  onGroupDragEnd,
  hctx,
  sourcePos,
  posOffset,
  sourceDir,
  targetDir,
}: {
  groups: AlignmentGroup[];
  ghostByGroup: Map<string, Ghost>;
  onAcceptGhost: (groupId: string, wordIds: string[]) => void;
  onDismissGhost: (ghost: Ghost) => void;
  twlForVerse: TwlRow[];
  lexiconMap: Map<string, LexiconEntry | null>;
  verseNum: number;
  onTargetsDrop: (dest: string, wordIds: string[]) => void;
  /** Currently tap-selected unaligned word-bank chips (for the click-to-align path). */
  selectedWordIds: string[];
  onClearSelection: () => void;
  onSourceDrop: (destGroupId: string, sourceId: string) => void;
  onExtractSource: (sourceId: string) => void;
  onClearGroup: (groupId: string) => void;
  onMerge: (dropTargetId: string, draggedId: string) => void;
  draggingGroupId: string | null;
  onGroupDragStart: (groupId: string) => void;
  onGroupDragEnd: () => void;
  hctx: HighlightCtx;
  // Source word id → own-relative token position (-1 unresolved), and the
  // union offset — for card keys and the position-keyed hover identity.
  sourcePos: Map<string, number>;
  posOffset: number;
  sourceDir: "rtl" | "ltr";
  targetDir: "rtl" | "ltr";
}) {
  const { t } = useTranslation();
  // Precompute the per-verse TWL hint lookup once (see buildTwHintMap) so each
  // hover re-render isn't O(sourceWords × twlRows) of re-split + re-nfc work.
  const twHints = useMemo(
    () => buildTwHintMap(twlForVerse, verseNum),
    [twlForVerse, verseNum],
  );
  return (
    <Box
      dir={sourceDir}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 1,
        alignContent: "flex-start",
        // Card visual order follows the source's reading flow — the cards
        // are sorted by source position by displayGroups, so Hebrew (RTL)
        // lays the first card to the right and Greek (LTR) to the left.
        pt: 0.5,
      }}
    >
      {groups.map((g) => {
        const ghost = ghostByGroup.get(g.id);
        // Stable per-card React key derived from the source chain (see cardKey
        // in ../lib/alignment — a `p{pos}`-only key collided when one source
        // token was split-aligned to two target runs, piling up cards).
        const key = cardKey(g, sourcePos);
        return (
        <DropTargetCard
          key={key}
          groupId={g.id}
          onTargetsDrop={(wordIds) => onTargetsDrop(`g:${g.id}`, wordIds)}
          selectedWordIds={selectedWordIds}
          onClearSelection={onClearSelection}
          onSourceDrop={(sourceId) => onSourceDrop(g.id, sourceId)}
          onMerge={(draggedId) => onMerge(g.id, draggedId)}
          draggingGroupId={draggingGroupId}
          onGroupDragStart={onGroupDragStart}
          onGroupDragEnd={onGroupDragEnd}
        >
          <Box
            dir={sourceDir}
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 0.25,
              alignItems: "baseline",
              // Reserves room for the absolute-positioned × in the top-right
              // corner so a tall Hebrew word doesn't tuck under it.
              pl: 2.5,
              mb: 0.5,
            }}
          >
            {g.source.map((s) => {
              const own = sourcePos.get(s.id) ?? -1;
              return (
                <SourceWordTypography
                  key={s.id}
                  source={s}
                  pos={own >= 0 ? own + posOffset : -1}
                  groupId={g.id}
                  lex={lexiconMap.get(s.strong) ?? null}
                  twHint={twHintFromMap(twHints, s.content ?? "")}
                  canExtract={g.source.length > 1}
                  onExtract={() => onExtractSource(s.id)}
                  hctx={hctx}
                />
              );
            })}
          </Box>
          {(g.targets.length > 0 || g.source.length > 1) && (
            <Tooltip title={t("aligner.clearGroupTooltip")}>
              <IconButton
                size="small"
                onClick={() => onClearGroup(g.id)}
                sx={{
                  p: 0.25,
                  color: "text.disabled",
                  "&:hover": { color: "error.main" },
                  position: "absolute",
                  top: 4,
                  // Top-left so it never sits on top of a Hebrew word's
                  // superscript-occurrence indicator (which lives on the
                  // upper-right of each RTL character).
                  left: 4,
                }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
          {/* useFlexGap: Stack's default spacing is a one-sided margin, which
              lands on the wrong side when this row's dir differs from the
              UI's (the RTL emotion cache mirrors it by UI language). */}
          <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" dir={targetDir}>
            {g.targets.length === 0 ? (
              ghost ? (
                <GhostChip
                  ghost={ghost}
                  onAccept={() => onAcceptGhost(ghost.groupId, ghost.wordIds)}
                  onDismiss={() => onDismissGhost(ghost)}
                />
              ) : (
                <Box
                  sx={{
                    width: "100%",
                    border: "1px dashed",
                    borderColor: "divider",
                    borderRadius: 1,
                    py: 0.5,
                    px: 1,
                    fontSize: 11.5,
                    color: "text.disabled",
                    fontStyle: "italic",
                    textAlign: "center",
                  }}
                >
                  {t("aligner.dropEnglishHere")}
                </Box>
              )
            ) : (
              g.targets.map((t, ti) => (
                <SimpleDraggableChip
                  key={`${t.text}|${t.occurrence}|${ti}`}
                  wordId={t.id}
                  text={t.text}
                  occurrence={t.occurrence}
                  occurrences={t.occurrences}
                  groupId={g.id}
                  onUnalign={() => onTargetsDrop("u", [t.id])}
                  hctx={hctx}
                />
              ))
            )}
          </Stack>
        </DropTargetCard>
        );
      })}
    </Box>
  );
}

function DropTargetCard({
  groupId,
  onTargetsDrop,
  selectedWordIds,
  onClearSelection,
  onSourceDrop,
  onMerge,
  draggingGroupId,
  onGroupDragStart,
  onGroupDragEnd,
  children,
}: {
  groupId: string;
  onTargetsDrop: (wordIds: string[]) => void;
  selectedWordIds: string[];
  onClearSelection: () => void;
  onSourceDrop: (sourceId: string) => void;
  onMerge: (draggedGroupId: string) => void;
  draggingGroupId: string | null;
  onGroupDragStart: (groupId: string) => void;
  onGroupDragEnd: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const isBeingDragged = draggingGroupId === groupId;
  const isMergeTarget = over && draggingGroupId !== null && !isBeingDragged;
  const showOver = over && !isMergeTarget && !isBeingDragged;
  // Tap-to-align: when word-bank chips are tap-selected, a plain click on the
  // card body aligns them here — the keyboard/trackpad/touch path that mirrors
  // dragging, routed through the SAME onTargetsDrop as the drop handler. Guarded
  // to a no-op when nothing is selected (so click behaviour is unchanged) and
  // when the click lands on an inner control (× clear-group, unalign buttons,
  // the ghost-suggestion chip), which keep their own handlers.
  //
  // The guard can't just be closest("button") — almost nothing inside the card
  // is a real <button>, so every one of these would otherwise ALSO run this
  // handler and silently align the pending selection to the card:
  //   role="button"      GhostChip. MUI renders a clickable Chip through
  //                      ButtonBase with component="div" (Chip.js:408,421), and
  //                      ButtonBase sets role="button" instead of emitting a
  //                      <button> (ButtonBase.js:230).
  //   draggable          the target chips (a plain Chip -> a div, whose
  //                      onDoubleClick unaligns — and a double-click delivers a
  //                      click first), the Hebrew source spans (onDoubleClick
  //                      extracts), and the bottom merge grip.
  // The card's own Paper is not draggable, so matching [draggable] here narrows
  // the click target to the card background without disabling the feature.
  const hasSelection = selectedWordIds.length > 0;
  return (
    <Paper
      elevation={0}
      onClick={(e) => {
        if (!hasSelection) return;
        if ((e.target as HTMLElement).closest('button,[role="button"],[draggable="true"]')) return;
        onTargetsDrop(selectedWordIds);
        onClearSelection();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        // Whole-card merge takes priority: a dragged grip carries GROUP_ID_MIME.
        // Ignore a drop of a card onto itself.
        const draggedGroupId = e.dataTransfer.getData(GROUP_ID_MIME);
        if (draggedGroupId) {
          if (draggedGroupId !== groupId) onMerge(draggedGroupId);
          return;
        }
        const wordIds = readWordIds(e.dataTransfer);
        if (wordIds.length > 0) {
          onTargetsDrop(wordIds);
          return;
        }
        const sourceId = e.dataTransfer.getData(SOURCE_ID_MIME);
        if (sourceId) onSourceDrop(sourceId);
      }}
      data-group-id={groupId}
      dir="ltr"
      sx={{
        position: "relative",
        // A tap-selection turns every card into a click target — signal it.
        cursor: hasSelection ? "pointer" : "default",
        bgcolor: isMergeTarget || showOver ? "primary.50" : "background.paper",
        borderColor:
          isMergeTarget || showOver
            ? "primary.main"
            : hasSelection
              ? "primary.light"
              : "divider",
        borderWidth: 1,
        borderStyle: isMergeTarget ? "dashed" : "solid",
        borderRadius: 1.5,
        px: 1.25,
        // Extra headroom so superscript indicators (Hebrew sup occurrences,
        // chip sup-occurrence indicators) aren't clipped by the card border.
        pt: 1.5,
        // Extra bottom room for the grip handle below the chips.
        pb: 2.25,
        minWidth: 160,
        maxWidth: 260,
        flex: "0 1 auto",
        display: "flex",
        flexDirection: "column",
        opacity: isBeingDragged ? 0.4 : 1,
        transition: "opacity 0.12s, border-color 0.12s, background-color 0.12s",
      }}
    >
      {children}
      {/* Bottom grip — drag a whole card onto another to merge their groups.
          Sits at the bottom edge, clear of the top-right Hebrew occurrence
          superscripts and the top-left clear (×) button. */}
      <Tooltip title={t("aligner.mergeCardTooltip")}>
        <Box
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(GROUP_ID_MIME, groupId);
            e.dataTransfer.effectAllowed = "move";
            onGroupDragStart(groupId);
          }}
          onDragEnd={onGroupDragEnd}
          sx={{
            position: "absolute",
            left: "50%",
            bottom: 4,
            transform: "translateX(-50%)",
            width: 44,
            height: 11,
            cursor: "grab",
            borderRadius: "6px",
            color: "text.disabled",
            backgroundImage:
              "radial-gradient(circle, currentColor 1.3px, transparent 1.7px)",
            backgroundSize: "8px 6px",
            backgroundRepeat: "repeat-x",
            backgroundPosition: "center",
            opacity: 0.7,
            transition: "color 0.12s, opacity 0.12s",
            "&:hover": { color: "primary.main", opacity: 1 },
            "&:active": { cursor: "grabbing" },
          }}
        />
      </Tooltip>
      {isMergeTarget && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "primary.50",
            color: "primary.dark",
            fontWeight: 600,
            fontSize: 13,
            borderRadius: 1.5,
            pointerEvents: "none",
            zIndex: 4,
          }}
        >
          {t("aligner.mergeIntoGroup")}
        </Box>
      )}
    </Paper>
  );
}

// ─── Hebrew source word as typography (no inverted block) ──────────────
function SourceWordTypography({
  source,
  pos,
  groupId,
  lex,
  twHint,
  canExtract,
  onExtract,
  hctx,
}: {
  source: SourceWord;
  // Union-relative source position (-1 when unresolved — hover identity then
  // falls back to the group id alone).
  pos: number;
  groupId: string;
  lex: LexiconEntry | null;
  twHint: string | null;
  canExtract: boolean;
  onExtract: () => void;
  hctx: HighlightCtx;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(false);
  const tone = hctx.hebrewHighlight(pos, groupId);
  const showInfo = hctx.showSourceInfo;
  return (
    <Tooltip
      enterDelay={0}
      enterNextDelay={0}
      title={
        showInfo ? (
          <Box>
            <SourceTooltipBody source={source} lex={lex} twHint={twHint} />
            {canExtract && (
              <Box sx={{ mt: 0.5, fontSize: 11, opacity: 0.85 }}>
                {t("aligner.doubleClickSplit")}
              </Box>
            )}
          </Box>
        ) : (
          ""
        )
      }
      disableHoverListener={!showInfo}
      disableFocusListener={!showInfo}
      disableTouchListener={!showInfo}
      slotProps={{ popper: { sx: { pointerEvents: "none" } } }}
    >
      <Box
        component="span"
        draggable
        onMouseEnter={() => {
          setHover(true);
          hctx.onHebrewEnter(pos, groupId);
        }}
        onMouseLeave={() => {
          setHover(false);
          hctx.onLeave();
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(SOURCE_ID_MIME, source.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDoubleClick={() => {
          if (canExtract) onExtract();
        }}
        sx={{
          position: "relative",
          display: "inline-flex",
          alignItems: "baseline",
          py: 0.25,
          px: 0.75,
          pr: sourceShowsOccurrence(source) ? 2 : 0.75,
          bgcolor: hover ? "grey.100" : "transparent",
          borderRadius: 0.5,
          fontFamily: '"Frank Ruhl Libre", "Times New Roman", "SBL Hebrew", "Cardo", serif',
          fontSize: 23,
          lineHeight: 1.2,
          color: "text.primary",
          cursor: canExtract ? "grab" : "grab",
          whiteSpace: "nowrap",
          transition: "background-color 0.12s, box-shadow 0.12s",
          userSelect: "none",
          boxShadow: hoverShadow(tone, hctx.themeMode),
          "&:active": { cursor: "grabbing" },
        }}
      >
        {source.content}
        {sourceShowsOccurrence(source) && (
          <Box
            component="sup"
            dir="ltr"
            sx={{
              position: "absolute",
              top: 0,
              right: 2,
              fontFamily: "monospace",
              fontSize: 9,
              fontWeight: 700,
              lineHeight: 1,
              color: "primary.main",
              pointerEvents: "none",
            }}
          >
            {source.occurrence}
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

// ─── English chips ─────────────────────────────────────────────────────
function AlignedChip({
  wordId,
  text,
  occurrence,
  occurrences,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  hctx: HighlightCtx;
}) {
  const tone = hctx.englishHighlight(wordId, text, occurrence);
  const hueDeg = hctx.colorize ? hctx.matchHues.get(`${text}|${occurrence}`) : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = hueDeg != null ? chipSupColor(hueDeg, hctx.themeMode) : "text.disabled";
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, supColor)}
      size="small"
      variant="outlined"
      onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence)}
      onMouseLeave={hctx.onLeave}
      sx={{
        fontFamily: '"Roboto","Helvetica",sans-serif',
        color: "text.disabled",
        bgcolor: "grey.50",
        borderColor: "divider",
        userSelect: "none",
        height: 26,
        borderRadius: 0.75,
        boxShadow: hoverShadow(tone, hctx.themeMode),
        transition: "box-shadow 0.12s",
        ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
        "& .MuiChip-label": { overflow: "visible", px: 1 },
      }}
    />
  );
}

function SelectableChip({
  wordId,
  text,
  occurrence,
  occurrences,
  selected,
  onClick,
  idsForDrag,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  selected: boolean;
  onClick: (shift: boolean) => void;
  idsForDrag: () => string[];
  hctx: HighlightCtx;
}) {
  const tone = hctx.englishHighlight(wordId, text, occurrence);
  const hueDeg =
    !selected && hctx.colorize
      ? hctx.matchHues.get(`${text}|${occurrence}`)
      : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = selected
    ? "primary.contrastText"
    : hueDeg != null
      ? chipSupColor(hueDeg, hctx.themeMode)
      : "primary.dark";
  return (
    <Chip
      label={targetLabel(text, occurrence, occurrences, supColor)}
      size="small"
      variant={selected ? "filled" : "outlined"}
      color={selected ? "primary" : "default"}
      draggable
      onClick={(e) => onClick(e.shiftKey)}
      onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence)}
      onMouseLeave={hctx.onLeave}
      onDragStart={(e) => {
        const ids = idsForDrag();
        e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify(ids));
        if (ids.length === 1) e.dataTransfer.setData("text/word-id", ids[0]);
        e.dataTransfer.effectAllowed = "move";
      }}
      sx={{
        cursor: "grab",
        fontFamily: '"Roboto","Helvetica",sans-serif',
        userSelect: "none",
        height: 26,
        borderRadius: 0.75,
        bgcolor: selected ? "primary.main" : "background.paper",
        boxShadow: hoverShadow(tone, hctx.themeMode),
        transition: "box-shadow 0.12s",
        ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
        "& .MuiChip-label": { overflow: "visible", px: 1 },
        "&:active": { cursor: "grabbing" },
      }}
    />
  );
}

function SimpleDraggableChip({
  wordId,
  text,
  occurrence,
  occurrences,
  groupId,
  onUnalign,
  hctx,
}: {
  wordId: string;
  text: string;
  occurrence: string;
  occurrences: string;
  groupId: string;
  onUnalign?: () => void;
  hctx: HighlightCtx;
}) {
  const { t } = useTranslation();
  const tone = hctx.englishHighlight(wordId, text, occurrence, groupId);
  const hueDeg = hctx.colorize ? hctx.matchHues.get(`${text}|${occurrence}`) : undefined;
  const accent = hueDeg != null ? chipAccentColor(hueDeg, hctx.themeMode) : undefined;
  const supColor = hueDeg != null ? chipSupColor(hueDeg, hctx.themeMode) : "primary.dark";
  return (
    <Tooltip title={t("aligner.unalignTooltip")}>
      <Chip
        label={targetLabel(text, occurrence, occurrences, supColor)}
        size="small"
        variant="outlined"
        draggable
        onMouseEnter={() => hctx.onEnglishEnter(wordId, text, occurrence, groupId)}
        onMouseLeave={hctx.onLeave}
        onDragStart={(e) => {
          e.dataTransfer.setData(WORD_IDS_MIME, JSON.stringify([wordId]));
          e.dataTransfer.setData("text/word-id", wordId);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDoubleClick={onUnalign}
        sx={{
          cursor: "grab",
          fontFamily: '"Roboto","Helvetica",sans-serif',
          userSelect: "none",
          height: 26,
          borderRadius: 0.75,
          bgcolor: "background.paper",
          boxShadow: hoverShadow(tone, hctx.themeMode),
          transition: "box-shadow 0.12s",
          ...(accent ? { borderBottom: `3px solid ${accent}`, pb: "2px" } : {}),
          "& .MuiChip-label": { overflow: "visible", px: 1 },
          "&:active": { cursor: "grabbing" },
        }}
      />
    </Tooltip>
  );
}

// ─── Tiny checkbox-style toggle for the inventory header ──────────────
function ToolbarToggle({
  label,
  checked,
  onChange,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  tooltip?: string;
}) {
  return (
    <Tooltip title={tooltip ?? ""} disableHoverListener={!tooltip}>
      <Box
        component="button"
        onClick={onChange}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          background: "transparent",
          border: 0,
          p: 0.25,
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 11,
          color: checked ? "primary.main" : "text.secondary",
          "&:hover": { color: checked ? "primary.dark" : "text.primary" },
        }}
      >
        <Box
          component="span"
          sx={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 13,
            height: 13,
            borderRadius: "3px",
            border: "1.5px solid",
            borderColor: checked ? "primary.main" : "grey.300",
            bgcolor: checked ? "primary.main" : "transparent",
            color: "primary.contrastText",
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          {checked ? "✓" : ""}
        </Box>
        {label}
      </Box>
    </Tooltip>
  );
}

// ─── Ghost (suggested alignment) chips ─────────────────────────────────
// Scoring + matching (computeGhosts, the weighted-average blend, surfaceMatch,
// ghostPipColor, the Ghost/StreamWord types) live in ../lib/alignmentSuggest so
// the offline eval harness scores exactly what ships. Below is only the chip's
// presentation: a faded, dashed, click-to-accept chip inside an empty group.
// The × (MUI onDelete) dismisses it for the session via dismissedGhosts, so a
// rejected suggestion can't immediately regenerate — the "predicted alignment"
// circle fix. Clicking × never fires onClick (MUI stops it), so reject ≠ accept.
function GhostChip({
  ghost,
  onAccept,
  onDismiss,
}: {
  ghost: Ghost;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const pct = Math.round(ghost.confidence * 100);
  const srcLabel = ghost.source === "memory" ? "wordMAP" : t("aligner.srcLexicon");
  return (
    <Tooltip title={t("aligner.ghostTooltip", { src: srcLabel, pct })}>
      <Chip
        size="small"
        variant="outlined"
        clickable
        onClick={onAccept}
        onDelete={onDismiss}
        deleteIcon={<CloseIcon />}
        label={
          <Box component="span" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}>
            <Box
              component="span"
              sx={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                bgcolor: ghostPipColor(ghost.confidence),
                flexShrink: 0,
              }}
            />
            <Box component="span" sx={{ fontStyle: "italic" }}>
              {ghost.text}
            </Box>
          </Box>
        }
        sx={{
          height: 26,
          borderRadius: 0.75,
          borderStyle: "dashed",
          borderColor: "primary.main",
          color: "text.secondary",
          bgcolor: "transparent",
          opacity: 0.72,
          cursor: "pointer",
          transition: "opacity 0.12s, background-color 0.12s",
          "&:hover": { opacity: 1, bgcolor: "primary.50" },
          "& .MuiChip-label": { px: 1 },
          "& .MuiChip-deleteIcon": {
            fontSize: 15,
            ml: "-2px",
            color: "text.disabled",
            "&:hover": { color: "error.main" },
          },
        }}
      />
    </Tooltip>
  );
}

// ─── Helpers (carried over verbatim from AlignmentDialog) ──────────────
function sourceShowsOccurrence(s: SourceWord): boolean {
  const n = parseInt(s.occurrences, 10);
  return Number.isFinite(n) && n > 1;
}

function targetLabel(
  text: string,
  occurrence: string,
  occurrences: string,
  tone: string,
): React.ReactNode {
  const n = parseInt(occurrences, 10);
  if (!Number.isFinite(n) || n <= 1) return text;
  // The superscript sits at the top of the inline-flex container with
  // vertical-align: super, so it stays fully inside the chip's bounding
  // box and never collides with the chip's top border at any zoom.
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "baseline" }}>
      <span>{text}</span>
      <Box
        component="span"
        sx={{
          ml: "3px",
          fontFamily: "monospace",
          fontSize: 9,
          fontWeight: 700,
          lineHeight: 1,
          color: tone,
          verticalAlign: "super",
          alignSelf: "flex-start",
          mt: "1px",
        }}
      >
        {occurrence}
      </Box>
    </Box>
  );
}

function readWordIds(dt: DataTransfer): string[] {
  const raw = dt.getData(WORD_IDS_MIME);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }
  const single = dt.getData("text/word-id");
  return single ? [single] : [];
}

// Resolve a group source word to its token position in the panel's source
// verse: NFC content + occurrence first (exact), then content first-instance,
// then strong + occurrence, then strong first-instance. The fallback chain
// absorbs malformed occurrence data and cantillation drift between milestone
// x-content and the UHB \w text. -1 when nothing matches.
function resolveSourcePos(s: SourceWord, indexMap: Map<string, number>): number {
  const c = nfc(s.content ?? "");
  return (
    indexMap.get(`t:${c}|${s.occurrence}`) ??
    indexMap.get(`t:${c}|1`) ??
    indexMap.get(`s:${s.strong}|${s.occurrence}`) ??
    indexMap.get(`s:${s.strong}|1`) ??
    -1
  );
}

// Position-sequence identity for a group: a stable key from its resolved source
// positions, or null when any source word is unresolved (then callers must not
// treat it as a duplicate — we can't prove it). Shared by displayGroups (which
// collapses same-position duplicate cards via mergeSamePositionGroups) and the
// card-clear handler, which must unalign EVERY underlying group the card
// collapsed — not just the one whose id the card carries — so the two agree on
// what a single card owns.
function groupPositionKey(g: AlignmentGroup, indexMap: Map<string, number>): string | null {
  if (g.source.length === 0) return null;
  const positions = g.source.map((s) => resolveSourcePos(s, indexMap));
  return positions.some((p) => p < 0) ? null : positions.join(".");
}

// Projected off quoteBuilder's shared `collectSourceWordNodes` so the positions
// this map hands out are the SAME enumeration UhbStrip's SourceVerseTokens
// renders with (both now route their descent through usfm.ts's one rule). The
// hand-rolled walk it replaced descended any milestone and no `\qs` character
// wrapper, so a wrapped source word shifted the map one position out of step
// with the strip and hover/highlight lit the neighbouring word (#370).
function buildSourceIndexMap(sourceVerse: VerseDto | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!sourceVerse?.content) return map;
  const verseObjects = (sourceVerse.content as { verseObjects?: unknown[] }).verseObjects;
  if (!Array.isArray(verseObjects)) return map;
  const textCount = new Map<string, number>();
  const strongCount = new Map<string, number>();
  for (const { node, position } of collectSourceWordNodes(verseObjects)) {
    const text = nfc(String(node["text"] ?? ""));
    const strong = String(node["strong"] ?? "");
    const tOcc = (textCount.get(text) ?? 0) + 1;
    const sOcc = (strongCount.get(strong) ?? 0) + 1;
    textCount.set(text, tOcc);
    strongCount.set(strong, sOcc);
    const textKey = `t:${text}|${tOcc}`;
    const strongKey = `s:${strong}|${sOcc}`;
    if (!map.has(textKey)) map.set(textKey, position);
    if (!map.has(strongKey)) map.set(strongKey, position);
  }
  return map;
}
