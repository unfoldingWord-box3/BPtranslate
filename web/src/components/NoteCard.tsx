import { lazy, Suspense, memo, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Paper,
  Stack,
  Chip,
  IconButton,
  InputAdornment,
  Typography,
  Box,
  TextField,
  Tooltip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Menu,
  MenuItem,
  ListItemText,
  ListSubheader,
  Divider,
} from "@mui/material";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import LightbulbOutlinedIcon from "@mui/icons-material/LightbulbOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import RestoreFromTrashIcon from "@mui/icons-material/RestoreFromTrash";
import AddIcon from "@mui/icons-material/Add";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import TranslateIcon from "@mui/icons-material/Translate";
import UndoIcon from "@mui/icons-material/Undo";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import CheckIcon from "@mui/icons-material/Check";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import { alpha, type Theme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { TnRow } from "../sync/api";
import type { SourceNote } from "../hooks/useSourceNotes";
import { useNotePairAxisContext } from "./notePairAxis";
import { useCatalogs } from "../hooks/useCatalogs";
import { useNoteTemplates } from "../hooks/useNoteTemplates";
import { CatalogPicker } from "./CatalogPicker";
import { shortSupport } from "../lib/supportReference";
import { taShort, parseTaRef } from "../lib/taArticle";
import { TCM, buildSH } from "../lib/noteTemplates";
import { getLockUnapprovedDrafts } from "../lib/editorPrefs";
import { formatEpochSecondsDateTime } from "../lib/formatDate";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";
import { isAquiferDraftRow } from "./flows/translateShared";

const NoteHistoryDialog = lazy(() =>
  import("./NoteHistoryDialog").then((m) => ({ default: m.NoteHistoryDialog })),
);

export type DropPosition = "before" | "after";

// Transient ring on the arrow a note was just reordered with — mouse clicks
// don't show a :focus-visible ring, so this signals "the note moved, press
// Enter/Space to keep nudging it." Self-clears via ResourceColumn state.
const reorderFlashSx = {
  color: "primary.main",
  bgcolor: "primary.50",
  boxShadow: "0 0 0 2px var(--mui-palette-primary-main, #31ADE3)",
} as const;

interface Props {
  row: TnRow;
  active: boolean;
  // Find-in-notes highlight: when set, every match of the query in the note
  // body is marked (yellow); the `activeMatchOccurrence`-th match is emphasized
  // (orange) and scrolled into view. Null when find is closed / TN scope off.
  findQuery?: { find: string; regex: boolean; caseSensitive: boolean } | null;
  activeMatchOccurrence?: number | null;
  dragging: boolean;
  isDropTarget: boolean;
  // Optimistic local-only apply, fired on every keystroke / chip pick so
  // parent state (e.g. activeQuote-driven highlighting) stays in sync. Does
  // NOT hit the outbox.
  onChange: (patch: Partial<TnRow>) => void;
  // Enqueue a row PATCH. Called once per edit session — at session end
  // (active going false), on manual save, or on unmount. When the patch
  // comes from "switch to v{N}" in the history dialog, opts carries the
  // origin version so the server can mark the new edit_log entry + row
  // column for chip-label purposes.
  onSave: (patch: Partial<TnRow>, opts?: { restoredFromVersion?: number }) => void;
  // Resolves false when the trash request failed, so handleDelete can leave the
  // user's unsaved text alone (see the comment there).
  onDelete: () => void | Promise<boolean | void>;
  onRestore: () => void;
  // Absent => no "add note after" button (rows with no verse of their own).
  onInsertAfter?: () => void;
  onFocus?: () => void;
  onGripDragStart: () => void;
  onDragEnd: () => void;
  onCardDragOver: (position: DropPosition) => void;
  onCardDragLeave: () => void;
  onCardDrop: (position: DropPosition) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  // The just-reordered arrow to flash a focus ring on ("up"/"down"), or null.
  // Mirrors WordsTable: a mouse reorder keeps focus on the moved card's arrow
  // (Enter/Space repeats) but shows no ring, so this makes that discoverable.
  flashArrow?: "up" | "down" | null;
  // Verse numbers in this chapter, offered in the reference picker so a note
  // can be retargeted to a different verse ("change reference"). Absent/empty
  // => the ref shows as a static label with no picker.
  verseOptions?: number[];
  // Retarget the note. A single verse moves it; a second `verseEnd > verse`
  // makes the reference a bridge ("chapter:verse-verseEnd").
  onChangeVerse?: (verse: number, verseEnd?: number) => void;
  // Hovering the reorder controls (grip / up / down) previews this note's
  // current slot in the scripture stoplight without moving it: fires true on
  // enter, false on leave.
  onReorderHover?: (entering: boolean) => void;
  // Async AI-draft lifecycle. State lives in Shell so the call can
  // survive the card un-focusing / scrolling off-screen. NoteCard is
  // purely presentational w.r.t. AI: shows spinner while pending,
  // pulses briefly when a result lands.
  isAiPending?: boolean;
  aiRecentlyCompletedAt?: number | null;
  // Fires the request. Returns immediately; result lands later via the
  // row patch pipeline. Absent => sparkles is hidden. Carries the LIVE
  // (unsaved) note fields so Shell builds the request from what's on
  // screen rather than the cached row — see buildAiLive below.
  onStartAi?: (live: { quote: string; note: string; support_reference: string | null }) => void;
  // Reported on intersection changes so Shell can decide whether an
  // arriving AI result needs the persistent off-screen toast or just
  // the in-place pulse. Default root (viewport) is good enough for our
  // resource column scroll setup.
  onVisibilityChange?: (rowId: string, isVisible: boolean) => void;
  // Chapter has an active AI pipeline (state from pipelineStore). When true
  // and the row is neither preserved nor a hint, the card is read-only.
  // Preserved or hinted rows stay editable even during a run.
  locked?: boolean;
  // Toggle the row's "survive future AI pipeline sweeps" bit. Always
  // available — these are pre-run intent signals, not in-run claims.
  // Fires POST /api/rows/tn/:id/preserve upstream.
  onSetPreserve?: (value: boolean) => void;
  // Toggle the row's "queue as AI-pipeline hint" bit. hint=1 rows are sent
  // to the chapter-wide AI run as directives and are excluded from the
  // sweep until the AI expansion lands. Fires POST /api/rows/tn/:id/hint.
  onSetHint?: (value: boolean) => void;
  // Translate English in the quote field to source-language text via ULT
  // alignment. Returns the derived Hebrew/Greek string, or null if no
  // alignment match was found.
  onTranslateQuote?: (english: string) => string | null;
  // Quote-builder workflow: the "build from source" button opens a picker
  // popup mounted at Shell level. While the picker is open for this note,
  // quoteBuildMode is true and the button label reflects the selection
  // count. Shell owns the selection state + cancel/commit handlers — the
  // card just opens the picker.
  quoteBuildMode?: boolean;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: () => void;
  // Bumps to a fresh value each time Shell commits a quote-build for THIS
  // note. The picker only opens while the card is active, so the row→quote
  // sync effect is blocked by the open session guard; this signal is the
  // escape hatch (mirrors aiRecentlyCompletedAt) that lands the committed
  // quote in the box. Shell applies the quote to row optimistically before
  // bumping this, so the effect just reads the now-current row.quote.
  quoteBuildAppliedAt?: number | null;
  // ── Translation mode (gateway-language projects only) ──
  // True when the active project translates FROM a source language (project
  // config translationSource != null). Off for the English root project, whose
  // card is byte-for-byte unchanged (all the props below are then absent).
  translationMode?: boolean;
  // The published English SOURCE note this row's draft was made from (matched
  // by row id). Pinned read-only above the editable draft for ai_draft/edited
  // rows. Null when unavailable (source fetch failed / no matching id).
  sourceNote?: SourceNote | null;
  // Approve the current draft → POST validate(1) → row becomes 'validated' and
  // the card collapses. Absent => the Approve affordance is hidden.
  onApprove?: () => void;
  // Un-approve a validated row → validate(0) → back to 'edited'.
  onUnapprove?: () => void;
  // Translate THIS note via the translate pipeline (translate.rowIds:[id]).
  // Offered on untranslated (NULL-state) rows and as "re-run AI" on drafts.
  onTranslate?: () => void;
  // This row has an in-flight translate pipeline — show a working affordance.
  isTranslating?: boolean;
}

// Notes coming from TSV imports use literal "\n" (two characters) as the
// line-break marker. tcCreate renders those as real newlines; we do the same
// on read, and on save we write back whatever the user typed verbatim. The
// data in D1 transitions to true newlines as users edit.
function tsvToDisplay(s: string | null): string {
  return (s ?? "").replace(/\\n/g, "\n");
}

// Detect the primary script of a string for directing RTL/LTR rendering and
// showing the translate icon. RTL covers the Hebrew, Arabic (incl. supplement /
// extended-A / presentation forms), Syriac, Thaana and N'Ko blocks — so an
// Arabic quote or draft reads RTL even when the UI chrome is LTR. Greek is LTR
// and is grouped with Latin for detection purposes.
const RTL_CHAR =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[a-zA-ZͰ-Ͽἀ-῿]/;

type QuoteScript = "empty" | "rtl" | "ltr";

function detectQuoteScript(text: string): QuoteScript {
  if (!text.trim()) return "empty";
  if (RTL_CHAR.test(text)) return "rtl";
  if (LTR_CHAR.test(text)) return "ltr";
  return "empty";
}

interface SessionSnapshot {
  quote: string;
  note: string;
  support_reference: string | null;
}

// Compile a find query the same way FindReplaceOverlay does: escape literals
// unless in regex mode; case-insensitive unless requested. Invalid regex → null.
function buildNoteFindRegex(q: {
  find: string;
  regex: boolean;
  caseSensitive: boolean;
}): RegExp | null {
  if (!q.find) return null;
  try {
    const pattern = q.regex ? q.find : q.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(pattern, q.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

// Read-only render of a note body with the ACTIVE find match highlighted
// (orange, "here I am"). Shown in place of the textarea while the user is
// navigating find and hasn't clicked into this note to edit — a real inline
// <mark> in a normal block, so it's pixel-accurate and scrolls naturally (no
// overlay alignment games). Clicking anywhere swaps to the editable textarea.
function NoteBodyReadView({
  text,
  query,
  activeOccurrence,
  onActivate,
}: {
  text: string;
  query: { find: string; regex: boolean; caseSensitive: boolean };
  activeOccurrence: number | null;
  onActivate: () => void;
}) {
  const { t } = useTranslation();
  const markRef = useRef<HTMLElement | null>(null);

  // Char range of the active occurrence in the display text. Occurrence index
  // comes from the overlay (computed on the raw body); display/body differ only
  // by `\n` escape ↔ newline, so the Nth match lines up unless a match sits
  // inside an escape — a rare cosmetic edge for the emphasis only.
  const range = useMemo(() => {
    const re = buildNoteFindRegex(query);
    if (!re || activeOccurrence == null) return null;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
      if (i === activeOccurrence) return { start: m.index, end: m.index + m[0].length };
      i += 1;
      if (m[0].length === 0) re.lastIndex++;
    }
    return null;
  }, [text, query, activeOccurrence]);

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [range]);

  const nodes = range
    ? [
        <span key="a">{text.slice(0, range.start)}</span>,
        <Box
          component="mark"
          key="m"
          ref={(el: HTMLElement | null) => {
            markRef.current = el;
          }}
          sx={{
            borderRadius: "2px",
            padding: "0 1px",
            color: "inherit",
            backgroundColor: (t) => (t.palette.mode === "dark" ? "rgba(251, 146, 60, 0.5)" : "#fb923c"),
            outline: (t) => `2px solid ${t.palette.mode === "dark" ? "#fb923c" : "#c2410c"}`,
          }}
        >
          {text.slice(range.start, range.end)}
        </Box>,
        <span key="b">{text.slice(range.end)}</span>,
      ]
    : text;

  return (
    <Box
      onClick={onActivate}
      title={t("noteCard.clickToEdit")}
      sx={{
        cursor: "text",
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        minHeight: 56,
        px: "14px",
        py: "8.5px",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 1,
        fontSize: `calc(15px * var(--be-reading-scale, 1))`,
        lineHeight: 1.55,
        fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
        "&:hover": { borderColor: "text.primary" },
      }}
    >
      {text ? nodes : " "}
    </Box>
  );
}

// Shared between the stacked and side-by-side renderings of the English source
// block, so the two can't drift apart visually.
const SOURCE_LABEL_SX = {
  fontFamily: "monospace",
  color: "text.disabled",
  textTransform: "uppercase",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.09em",
} as const;

const SOURCE_BOX_SX = {
  borderInlineStart: "3px solid",
  borderColor: "divider",
  bgcolor: (theme: Theme) => alpha(theme.palette.text.primary, 0.03),
  borderRadius: 1,
  px: 1.5,
  py: 1,
} as const;

const SOURCE_TEXT_SX = {
  fontSize: `calc(14px * var(--be-reading-scale, 1))`,
  lineHeight: 1.55,
  color: "text.secondary",
  fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  textAlign: "start",
} as const;

// Height of the label row above each half when side by side. The draft's row
// carries the TEMPLATE / SUGGEST buttons and is naturally this tall; pinning
// both rows to it keeps the two content boxes starting on the same line even
// when those buttons are hidden (read-only cards).
const PAIR_LABEL_ROW_H = 26;

function NoteCardInner({
  row,
  active,
  findQuery = null,
  activeMatchOccurrence = null,
  dragging,
  isDropTarget,
  onChange,
  onSave,
  onDelete,
  onRestore,
  onInsertAfter,
  onFocus,
  onGripDragStart,
  onDragEnd,
  onCardDragOver,
  onCardDragLeave,
  onCardDrop,
  onMoveUp,
  onMoveDown,
  flashArrow,
  verseOptions,
  onChangeVerse,
  onReorderHover,
  isAiPending = false,
  aiRecentlyCompletedAt = null,
  onStartAi,
  onVisibilityChange,
  locked = false,
  onSetPreserve,
  onSetHint,
  onTranslateQuote,
  quoteBuildMode = false,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  quoteBuildAppliedAt = null,
  translationMode = false,
  sourceNote = null,
  onApprove,
  onUnapprove,
  onTranslate,
  isTranslating = false,
}: Props) {
  const { t } = useTranslation();
  // The notes pane publishes the EFFECTIVE axis (it collapses side-by-side to
  // stacked in a narrow pane). Outside a notes pane this is "vertical", i.e.
  // the layout this card has always had.
  const notePairAxis = useNotePairAxisContext();
  // Two explicit bits drive lock-time behavior now:
  //   - preserve=1: translator marked this row "survive AI runs"
  //   - hint=1:    this row is a stub queued for AI expansion in place
  // Either bit keeps the card editable during a locked chapter. The legacy
  // implicit "kept = updated_by IS NOT NULL" signal is folded into the
  // preserve bit on the server (see rows.ts /keep alias).
  const isPreserved = row.preserve === 1;
  const isHint = row.hint === 1;
  // Trashed: pending deletion until tonight's finalize. The card grays out,
  // drops to the bottom of the verse, and goes inert except for Restore.
  // Folding it into readOnly makes every body input non-interactive and hides
  // the add/delete buttons for free (they already gate on !readOnly).
  const trashed = row.trashed_at != null;
  // Editor-mode approval lock. In Editor (authoring) mode a note still sitting in
  // raw "ai_draft" state — AI or Aquifer output nobody has approved — is read-only:
  // approval happens in Translator mode, and an editor shouldn't touch unapproved
  // machine output. Human-edited ("edited") and approved ("validated") notes are
  // unaffected, as are English-root projects (translation_state is null there).
  // Gated by a client pref (default ON) so it can graduate to the Preferences pane;
  // when the flag is off, Editor mode behaves exactly as before. See editorPrefs.ts.
  const isUnapprovedAiDraft = !translationMode && row.translation_state === "ai_draft";
  const lockUnapproved = isUnapprovedAiDraft && getLockUnapprovedDrafts();
  const readOnly = trashed || lockUnapproved || (locked && !isPreserved && !isHint);
  const [quote, setQuote] = useState(tsvToDisplay(row.quote));
  const [note, setNote] = useState(tsvToDisplay(row.note));
  // Find-highlight: the active match note shows a read view (with the match
  // highlighted) until the user clicks in; then it swaps to the textarea.
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [editingBody, setEditingBody] = useState(false);
  // A new find target (different occurrence / note) always returns to the read
  // view so the highlight shows; clicking sets editingBody back to true.
  useEffect(() => {
    setEditingBody(false);
  }, [activeMatchOccurrence, row.id]);
  // When the user clicks the read view to edit, focus the now-shown textarea
  // and put the caret at the end.
  useEffect(() => {
    if (!editingBody) return;
    const ta = noteTextareaRef.current;
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [editingBody]);
  const [supportRef, setSupportRef] = useState<string | null>(row.support_reference);
  // ── Translation mode ── derived state. All inert (null/false) for the
  // English root project, which never passes translationMode, so the card
  // below renders exactly as before.
  const translationState = translationMode ? (row.translation_state ?? null) : null;
  // Distinct provenance: an ai_draft sourced from Aquifer (not the AI bot). Kept
  // in draft_meta_json so it survives the round-trip; drives a distinct badge.
  const isAquiferDraft = translationState === "ai_draft" && isAquiferDraftRow(row);
  const isDraftState = translationState === "ai_draft" || translationState === "edited";
  const isValidated = translationState === "validated";
  // A GL-project row the translate pipeline never touched AND with no target
  // text yet — offer the per-note Translate affordance. A NULL-state row that
  // already carries content (e.g. pre-state-machine imported ar_tn) is treated
  // as a normal editable card, not forced into the untranslated treatment.
  const isUntranslated =
    translationMode && translationState == null && !(row.note && row.note.trim());
  // The read-only English source block, and whether it sits beside the draft
  // rather than above it. Side by side only makes sense when there IS a source
  // to put there — a card without one keeps the draft full-width.
  const showSourceNote = Boolean(
    translationMode && (isDraftState || isUntranslated) && sourceNote,
  );
  const pairSideBySide = showSourceNote && notePairAxis === "horizontal";
  // Validated cards collapse (green, one-line preview). Local expand is
  // view-only — editing a re-expanded card auto-demotes it to 'edited'
  // server-side (rows.ts content PATCH). Re-collapses when it re-validates.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!isValidated) setExpanded(false);
  }, [isValidated]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aiConfirmOpen, setAiConfirmOpen] = useState(false);
  // Guards the destructive note-level discard (Undo): reverting drops every
  // unsaved keystroke since the last save, so the one-click control opens a
  // confirm dialog instead of reverting inline.
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  // Template dropdown anchor (only used when a support ref has >1 variant) and
  // the body staged for the "replace existing note?" confirm dialog.
  const [templateMenuAnchor, setTemplateMenuAnchor] = useState<HTMLElement | null>(null);
  const [templateConfirmBody, setTemplateConfirmBody] = useState<string | null>(null);
  // Reference (verse) picker anchor — opened from the ref_raw label. `refSpanMode`
  // swaps the menu from the single-verse list into the "extend through" picker
  // that turns the reference into a bridge; reset whenever the menu closes.
  const [refMenuAnchor, setRefMenuAnchor] = useState<HTMLElement | null>(null);
  const [refSpanMode, setRefSpanMode] = useState(false);

  // Baseline of the last server-confirmed content. stashEdit() optimistically
  // re-spreads row.{quote,note,support_reference} on every keystroke (so a
  // mid-session remount can recover live typing from props), which would
  // otherwise defeat the diff below — local state and "row" would tick in
  // lockstep and hasRowDiff would never go true. Pinning the baseline to
  // version means it only rebases on a real server confirmation (PATCH 200,
  // restore, AI completion, or WS row.upserted), all of which bump version.
  const savedRef = useRef({
    quote: row.quote,
    note: row.note,
    support_reference: row.support_reference,
    version: row.version,
  });
  const [savePendingVersion, setSavePendingVersion] = useState<number | null>(null);
  if (row.version !== savedRef.current.version) {
    savedRef.current = {
      quote: row.quote,
      note: row.note,
      support_reference: row.support_reference,
      version: row.version,
    };
  }
  // Clear the in-flight gate once the server-confirmed version moves past
  // the one we saved against. A conflict (409) keeps row.version stuck and
  // savePendingVersion stays set — that's intentional, the user has to
  // resolve via the SyncStatusBar before sending another save.
  useEffect(() => {
    if (savePendingVersion !== null && row.version > savePendingVersion) {
      setSavePendingVersion(null);
    }
  }, [row.version, savePendingVersion]);

  // Session model: when this card becomes active, snapshot the current
  // committed values so undo can revert to "what it was when I started
  // editing". Pending patches accumulate here and flush on manual save,
  // session end, or unmount. On manual save the snapshot rebases to the
  // saved state so the chip's "*" reflects "unsaved since last save".
  //
  // Backed by state (drives re-renders so the chip clears its dirty
  // asterisk) with a mirrored ref for the unmount cleanup, which runs
  // after the component is gone and can't read state from closure.
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(null);
  const setSessionSnapshot = (next: SessionSnapshot | null) => {
    sessionSnapshotRef.current = next;
  };
  const pendingRef = useRef<Partial<TnRow>>({});

  // The quote field drives the scripture highlight (Shell reads the active
  // note's quote out of chapter state). Propagate quote edits to the parent
  // on a short debounce instead of on every keystroke, so typing stays local
  // to this card — every keystroke used to rebuild the whole chapter payload
  // and re-render the entire app. quoteRef mirrors the latest local value so
  // the timer always flushes the final text, even if an undo / template /
  // translate set the quote through another path before it fires. The note
  // BODY drives nothing outside this card, so it never propagates (it persists
  // via the draft store and saves through flushPending).
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const quotePropagateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleQuotePropagate = () => {
    if (quotePropagateTimer.current !== null) clearTimeout(quotePropagateTimer.current);
    quotePropagateTimer.current = setTimeout(() => {
      quotePropagateTimer.current = null;
      onChange({ quote: quoteRef.current });
    }, 200);
  };
  useEffect(
    () => () => {
      if (quotePropagateTimer.current !== null) clearTimeout(quotePropagateTimer.current);
    },
    [],
  );

  const paperRef = useRef<HTMLDivElement | null>(null);
  const catalogs = useCatalogs();
  const noteTemplates = useNoteTemplates();

  const positionFromEvent = (e: React.DragEvent): DropPosition => {
    const rect = paperRef.current?.getBoundingClientRect();
    if (!rect) return "after";
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  // Re-sync from the server-confirmed row, but only when no session is in
  // progress. While a session is open, the local fields are the source of
  // truth (a server response landing mid-session would otherwise clobber
  // the user's unsaved edits). Also skip a field that stashEdit() has an
  // un-flushed pick for (pendingRef) even with no session open — a stash
  // survives a deactivate, and an unrelated version bump elsewhere (e.g.
  // an AI-suggest save landing after the user wandered off) must not stamp
  // that pending pick back to the server's stale value.
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    if ("quote" in pendingRef.current) return;
    setQuote(tsvToDisplay(row.quote));
  }, [row.id, row.version, row.quote]);
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    if ("note" in pendingRef.current) return;
    setNote(tsvToDisplay(row.note));
  }, [row.id, row.version, row.note]);
  useEffect(() => {
    if (sessionSnapshotRef.current !== null) return;
    if ("support_reference" in pendingRef.current) return;
    setSupportRef(row.support_reference);
  }, [row.id, row.version, row.support_reference]);

  // Restore unsaved typing on first mount. If a draft exists for this row,
  // overwrite local state from its patch — otherwise the user's typing
  // would be lost the first time they navigate away from this note.
  // Guarded by a ref so subsequent re-renders don't keep clobbering the
  // live state with a now-stale snapshot.
  // Flips true once the on-mount draft lookup resolves (draft or not). The
  // draft-write effect gates its *clear* branch on this so a freshly-remounted
  // card — whose state hasn't rehydrated yet — can't wipe the very draft we're
  // about to read.
  const [hydrated, setHydrated] = useState(false);
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(rowKey("tn", row.book, row.id)).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const payload = rec?.payload as
        | {
            patch?: Partial<TnRow>;
            baseline?: { quote: string | null; note: string | null; support_reference: string | null };
          }
        | undefined;
      const patch = payload?.patch;
      setHydrated(true);
      if (!patch) return;
      // Restore the server baseline this draft was diffed against. Optimistic
      // applyLocalRowPatch() edits land in the cached row at an unchanged
      // version, so a no-refetch remount (e.g. pin toggle reshaping the column)
      // would otherwise initialise savedRef from that polluted row and compute
      // hasRowDiff=false — the card looks saved, the Save button disables, and
      // the draft-write effect clears the draft, stranding the edit in volatile
      // state. Pinning savedRef to the persisted baseline keeps the dirty chip /
      // Save button honest.
      const baseline = payload?.baseline;
      if (baseline) {
        savedRef.current = {
          quote: baseline.quote,
          note: baseline.note,
          support_reference: baseline.support_reference,
          version: rec?.expectedVersion ?? savedRef.current.version,
        };
      }
      if (typeof patch.quote === "string") setQuote(tsvToDisplay(patch.quote));
      if (typeof patch.note === "string") setNote(tsvToDisplay(patch.note));
      if ("support_reference" in patch) {
        setSupportRef((patch.support_reference as string | null) ?? null);
      }
    }).catch(() => {
      // An IndexedDB read failure must still flip `hydrated` true — otherwise
      // the draft-write effect's clear branch never fires and a reverted draft
      // keeps nagging. We just skip restoring any persisted draft (the card
      // falls back to the server row, and live editing still works).
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      setHydrated(true);
    });
  }, [row.id, row.book]);

  // Session entry/exit. Snapshot is taken on active=false→true with the
  // values currently in local state (which may differ from the row if a
  // draft was hydrated). On deactivate we just clear the snapshot — no
  // PATCH fires until the user clicks Save. Edits survive in the drafts
  // store across mount/unmount, so leaving an active card doesn't lose
  // typing.
  useEffect(() => {
    if (active) {
      if (sessionSnapshotRef.current === null) {
        setSessionSnapshot({ quote, note, support_reference: supportRef });
      }
    } else if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Save the diff between local state and the saved row. We don't rely on
  // pendingRef anymore — a deactivate→reactivate cycle, or a draft
  // restored from IndexedDB on mount, can leave the local state differing
  // from row without any in-session stashEdit() history. Recomputing from
  // local-vs-row props makes the save button work in those cases too.
  // The picker / NoteCard JSX still call stashEdit() for the
  // applyLocalRowPatch side-effect (parents need the live preview), but
  // we no longer use pendingRef as the source of truth for what to PATCH.
  const flushPending = () => {
    const patch: Partial<TnRow> = {};
    const savedQuote = savedRef.current.quote ?? "";
    const savedNote = savedRef.current.note ?? "";
    // We send raw TSV (with literal \n escapes) so the server / DCS
    // round-trip stays stable. tsvToDisplay flips them to real newlines
    // for the UI; reverse here.
    const localQuote = quote.replace(/\n/g, "\\n");
    const localNote = note.replace(/\n/g, "\\n");
    if (localQuote !== savedQuote) patch.quote = localQuote;
    if (localNote !== savedNote) patch.note = localNote;
    if (supportRef !== savedRef.current.support_reference) patch.support_reference = supportRef;
    pendingRef.current = {};
    if (Object.keys(patch).length === 0) return;
    // Gate further Save clicks against the same baseline. Without this,
    // double-clicking Save before the server responds enqueues two PATCHes
    // with the same If-Match, the second of which lands as a phantom 409.
    setSavePendingVersion(savedRef.current.version);
    onSave(patch);
    // Rebase the snapshot so the chip stops showing "*" after a manual
    // save and a follow-up Undo reverts to the just-saved state.
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({ quote, note, support_reference: supportRef });
    }
  };

  const stashEdit = (patch: Partial<TnRow>) => {
    pendingRef.current = { ...pendingRef.current, ...patch };
    // Optimistic local apply so the parent's data.tn reflects the live
    // value. Required so a mid-session remount (e.g. pin toggle reshaping
    // the resource column) doesn't initialise the next instance from a
    // stale row prop — that would freeze the display at pre-edit content
    // even after the save lands as v(n+1).
    onChange(patch);
  };

  // Revert to the LAST SAVED row state — drops every unsaved keystroke
  // since the row landed on the server. We compare against savedRef
  // (not row props, which carry mid-typing optimistic values from
  // stashEdit) so Undo reaches the actual last-saved content, not the
  // dirty value the user just typed. Also clears the draft store so
  // the orange border / unsaved-toasts forget about this row.
  const handleUndo = () => {
    const savedQuote = savedRef.current.quote;
    const savedSupportRef = savedRef.current.support_reference;
    const rowQuote = tsvToDisplay(savedQuote);
    const rowNote = tsvToDisplay(savedRef.current.note);
    setQuote(rowQuote);
    setNote(rowNote);
    setSupportRef(savedSupportRef);
    pendingRef.current = {};
    // Re-baseline the session snapshot to the saved state so a follow-up
    // edit produces a fresh hasNetChanges signal rather than thinking
    // the user is undoing the previous undo.
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({
        quote: rowQuote,
        note: rowNote,
        support_reference: savedSupportRef,
      });
    }
    void drafts.clear(draftKey);
    onChange({
      quote: savedQuote,
      note: savedRef.current.note,
      support_reference: savedSupportRef,
    });
  };

  // Trash discards any unsaved edits — but only AFTER the server accepts the
  // trash. Discarding up front destroyed the user's typing whenever the request
  // failed (the parent reverts its optimistic flip and the card is editable
  // again, so there is nothing left to restore it from). The parent owns the
  // drafts.clear on its success path; the card only has to stop holding the
  // discarded text — the optimistic trashed_at flips `readOnly` immediately, so
  // the persist effect above can't re-create the record in the meantime (issue
  // #359, mirroring the flows fix in #349/#353). A later restore then brings
  // back the server note, not the discarded text.
  const handleDelete = async () => {
    const ok = await onDelete();
    if (ok === false) return;
    pendingRef.current = {};
    setSessionSnapshot(null);
    const savedQuote = savedRef.current.quote ?? "";
    const savedNote = savedRef.current.note;
    const savedSupportRef = savedRef.current.support_reference;
    setQuote(tsvToDisplay(savedQuote));
    setNote(tsvToDisplay(savedNote));
    setSupportRef(savedSupportRef);
    // Mirror handleUndo: the parent row cache carries mid-typing optimistic
    // values from stashEdit, so reset it too or a remount re-inflates the text
    // we just discarded.
    onChange({
      quote: savedQuote,
      note: savedNote,
      support_reference: savedSupportRef,
    });
  };

  // Apply a historical snapshot. The patch goes through the normal save
  // pipe so it lands as v(current+1) — every older entry stays in
  // edit_log, including the v(current) we're moving away from. Local
  // state is rewritten outright so any in-progress session is discarded
  // in favor of the chosen version.
  const handleUseVersion = (
    snap: {
      quote: string | null;
      note: string | null;
      support_reference: string | null;
    },
    fromVersion: number,
  ) => {
    const rawQuote = snap.quote ?? "";
    const rawNote = snap.note ?? "";
    const rawSr = snap.support_reference ?? null;

    const displayQuote = tsvToDisplay(rawQuote);
    const displayNote = tsvToDisplay(rawNote);
    setQuote(displayQuote);
    setNote(displayNote);
    setSupportRef(rawSr);
    pendingRef.current = {};
    // If a session is open, reset its baseline so Undo reverts to the
    // newly-applied version and the "unsaved edits" asterisk stays quiet.
    if (sessionSnapshotRef.current) {
      setSessionSnapshot({
        quote: displayQuote,
        note: displayNote,
        support_reference: rawSr,
      });
    }

    // Only patch the fields that actually differ from the saved server
    // state so we don't trigger a needless version bump if the user picked
    // the current version somehow. Use savedRef (not row) because row
    // carries optimistic mid-typing values from stashEdit().
    const patch: Partial<TnRow> = {};
    if (rawQuote !== (savedRef.current.quote ?? "")) patch.quote = rawQuote;
    if (rawNote !== (savedRef.current.note ?? "")) patch.note = rawNote;
    if (rawSr !== savedRef.current.support_reference) patch.support_reference = rawSr;
    if (Object.keys(patch).length === 0) return;
    onChange(patch);
    onSave(patch, { restoredFromVersion: fromVersion });
  };

  const aiPrereqsMet = !!supportRef && quote.trim().length > 0;

  const quoteScript = detectQuoteScript(quote);
  const showTranslateIcon = quoteScript === "ltr" && !readOnly && !!onTranslateQuote;

  const handleTranslateQuote = () => {
    if (!onTranslateQuote || quoteScript !== "ltr") return;
    const result = onTranslateQuote(quote);
    if (result) {
      setQuote(result);
      stashEdit({ quote: result });
    }
  };

  // When AI completes (Shell sets a fresh `aiRecentlyCompletedAt`), force
  // local fields to the new row.quote/row.note even if a session is
  // open — the user expects the AI patch to show up regardless of
  // whether they happened to be editing this note when it landed. Also
  // re-baseline the session snapshot so Undo reverts to the AI result
  // (not pre-AI), matching the user's mental model of "AI just wrote
  // this; undo would undo the writing".
  useEffect(() => {
    if (!aiRecentlyCompletedAt) return;
    const newQuote = tsvToDisplay(row.quote);
    const newNote = tsvToDisplay(row.note);
    setQuote(newQuote);
    setNote(newNote);
    pendingRef.current = {};
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({
        quote: newQuote,
        note: newNote,
        support_reference: supportRef,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRecentlyCompletedAt]);

  // Quote-builder commit. The picker only opens while this card is active,
  // so the row→quote sync effect above is blocked by the open session
  // guard and the built quote (already applied to row.quote by Shell) would
  // never reach the box. When Shell signals a fresh commit for this note,
  // force the box to the new quote and rebaseline the session snapshot so
  // Undo treats the committed quote as the baseline — same shape as the AI
  // escape hatch above. Only the quote changes; note/supportRef are left as-is.
  useEffect(() => {
    if (quoteBuildAppliedAt == null) return;
    const newQuote = tsvToDisplay(row.quote);
    setQuote(newQuote);
    pendingRef.current = {};
    if (sessionSnapshotRef.current !== null) {
      setSessionSnapshot({ quote: newQuote, note, support_reference: supportRef });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteBuildAppliedAt]);

  // Visibility reporting. Default root means "browser viewport" — close
  // enough for the resource column's scroll model and avoids threading
  // a scroll-container ref through props.
  useEffect(() => {
    if (!onVisibilityChange) return;
    const el = paperRef.current;
    if (!el) return;
    const rowId = row.id;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          onVisibilityChange(rowId, entry.isIntersecting);
        }
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      // Cards are visible right up until unmount; tell Shell they're
      // no longer in viewport so an in-flight AI doesn't think the card
      // is still rendered when it lands.
      onVisibilityChange(rowId, false);
    };
  }, [row.id, onVisibilityChange]);

  // Snapshot the live note fields for the AI request. SUGGEST must work
  // before an explicit save: quote edits reach Shell's data.tn only on a
  // 200ms debounce and a freshly-created note can still be blank there, so
  // building from the cached row produced spurious "AI prerequisites
  // missing." Mirror flushPending's TSV conversion so the request sees
  // exactly what a save would persist.
  const buildAiLive = () => ({
    quote: quote.replace(/\n/g, "\\n"),
    note: note.replace(/\n/g, "\\n"),
    support_reference: supportRef,
  });

  const handleAiClick = () => {
    if (!onStartAi || !aiPrereqsMet || isAiPending) return;
    if (note.trim().length > 0) {
      setAiConfirmOpen(true);
      return;
    }
    onStartAi(buildAiLive());
  };

  // Curated templates for the selected support reference (keyed on the short
  // form, e.g. "figs-metaphor"). Empty when no support ref is picked or the
  // ref has no templates in the sheet.
  const templatesForRef = supportRef ? noteTemplates[shortSupport(supportRef)] ?? [] : [];

  // Fill the note from a template, going through stashEdit so the parent's
  // row.note reflects it (matches the TCM/SH chips). requestTemplate gates on
  // existing text: a non-empty note opens a confirm dialog first.
  const applyTemplate = (body: string) => {
    setNote(body);
    stashEdit({ note: body });
  };
  const requestTemplate = (body: string) => {
    if (note.trim().length > 0) setTemplateConfirmBody(body);
    else applyTemplate(body);
  };
  const handleTemplateClick = (e: React.MouseEvent<HTMLElement>) => {
    if (templatesForRef.length === 1) requestTemplate(templatesForRef[0].body);
    else if (templatesForRef.length > 1) setTemplateMenuAnchor(e.currentTarget);
  };

  // Sync the draft store against the diff vs server row. This is what feeds
  // the offscreen-unsaved popup and survives chapter navigation. Separate
  // from hasNetChanges because we want drafts to track divergence from the
  // *saved* state, not from the session entry point.
  const rowDiff: Partial<TnRow> = {};
  const rowQuoteDisplay = tsvToDisplay(savedRef.current.quote);
  const rowNoteDisplay = tsvToDisplay(savedRef.current.note);
  if (quote !== rowQuoteDisplay) rowDiff.quote = quote;
  if (note !== rowNoteDisplay) rowDiff.note = note;
  if (supportRef !== savedRef.current.support_reference) rowDiff.support_reference = supportRef;
  const hasRowDiff = Object.keys(rowDiff).length > 0;
  // A validated card sits collapsed unless the user is actively editing it,
  // has expanded it for review, or has unsaved edits (which would auto-demote).
  const collapsedValidated = isValidated && !active && !expanded && !hasRowDiff;
  // State chip descriptor for the header. null → no chip (English root project,
  // or a non-null-but-uninteresting case). Colors mirror the mockup: violet for
  // AI draft, blue for edited, green for validated, neutral for untranslated.
  const stateChip: { label: string; color: string; icon?: ReactElement } | null = !translationMode
    ? // Editor mode: surface (and, via readOnly above, enforce) the unapproved
      // state of raw AI/Aquifer drafts so an editor sees they're locked pending
      // a translator's approval. Gated by the same flag as the lock, so turning
      // the feature off restores the old chip-less Editor view.
      lockUnapproved
      ? {
          label: t("noteCard.notApproved"),
          color: "warning.main",
          icon: <LockOutlinedIcon sx={{ fontSize: 13 }} />,
        }
      : null
    : translationState === "ai_draft"
      ? isAquiferDraft
        ? { label: t("translation.stateAquiferDraft"), color: "#70C9CC" }
        : { label: t("translation.stateAiDraft"), color: "warning.main" }
      : translationState === "edited"
        ? { label: t("translation.stateEdited"), color: "info.main" }
        : isValidated
          ? { label: t("translation.stateApproved"), color: "success.main" }
          : isUntranslated
            ? { label: t("translation.stateUntranslated"), color: "text.secondary" }
            : null;
  const draftKey = rowKey("tn", row.book, row.id);
  useEffect(() => {
    if (readOnly) return;
    if (hasRowDiff) {
      void drafts.set(
        draftKey,
        {
          patch: rowDiff,
          // Persist the server baseline (savedRef stays version-pinned, immune
          // to the optimistic same-version row mutations) so a remount restores
          // an honest baseline instead of inheriting a polluted row. See the
          // hydration effect above.
          baseline: {
            quote: savedRef.current.quote,
            note: savedRef.current.note,
            support_reference: savedRef.current.support_reference,
          },
        },
        row.version,
        {
          kind: "row",
          rowKind: "tn",
          id: row.id,
          book: row.book,
          chapter: row.chapter,
          verse: row.verse,
        },
      );
    } else if (hydrated) {
      // Only clear after the on-mount draft lookup has run — before that,
      // hasRowDiff is measured against an unhydrated baseline and would
      // spuriously wipe a draft we haven't had the chance to restore.
      void drafts.clear(draftKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftKey,
    hasRowDiff,
    hydrated,
    quote,
    note,
    supportRef,
    row.version,
    row.id,
    row.book,
    row.chapter,
    row.verse,
    readOnly,
  ]);

  return (
    <Paper
      ref={paperRef}
      elevation={0}
      variant="outlined"
      data-note-id={row.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      onDragOver={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onCardDragOver(positionFromEvent(e));
      }}
      onDragLeave={() => {
        if (!isDropTarget) return;
        onCardDragLeave();
      }}
      onDrop={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        onCardDrop(positionFromEvent(e));
      }}
      sx={{
        my: 1,
        border: active || (translationMode && (isDraftState || isValidated)) ? "1.5px solid" : "1px solid",
        // Trashed cards get a dashed, muted, grayed-out treatment to signal
        // "pending deletion — restorable until tonight".
        borderStyle: trashed ? "dashed" : undefined,
        // Translation-mode state tint yields to the trashed/active treatments.
        // ai_draft → warning (Kindle orange, "review me"); validated → success
        // (teal, "done"). English root project → "divider" (unchanged).
        borderColor: trashed
          ? "text.disabled"
          : active
            ? "primary.main"
            : translationState === "ai_draft"
              ? "warning.light"
              : isValidated
                ? "success.main"
                : "divider",
        bgcolor: trashed
          ? "grey.100"
          : active
            ? "primary.50"
            : collapsedValidated
              ? (theme) => alpha(theme.palette.success.main, 0.09)
              : "background.paper",
        overflow: "hidden",
        // Opacity applied without a CSS transition on purpose: trash/restore
        // re-render twice in quick succession (optimistic patch, then the
        // server-confirmed replacement), and a transition spanning those two
        // class swaps gets left in an idle state that pins the card at the
        // start opacity — a restored card would stay visibly dimmed until the
        // next reload. Instant opacity sidesteps that entirely.
        opacity: trashed ? 0.6 : dragging ? 0.4 : 1,
        ...draftDirtyBorderSx(),
        // Glow pulse on AI completion. The flag is set by useAiDrafts
        // for ~4 s, so the animation finishes naturally and the rule
        // becomes a no-op once the flag clears.
        "@keyframes ai-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgba(49,173,227,0)" },
          "30%": { boxShadow: "0 0 18px 4px rgba(49,173,227,0.55)" },
          "100%": { boxShadow: "0 0 0 0 rgba(49,173,227,0)" },
        },
        animation: aiRecentlyCompletedAt ? "ai-pulse 1.4s ease-in-out 0s 2" : "none",
      }}
    >
      {/* ── Header ── */}
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        sx={{
          px: 1,
          py: 0.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
          flexWrap: "wrap",
        }}
      >
        <Box
          onMouseEnter={!trashed && onReorderHover ? () => onReorderHover(true) : undefined}
          onMouseLeave={!trashed && onReorderHover ? () => onReorderHover(false) : undefined}
          sx={{ display: "inline-flex", alignItems: "center" }}
        >
        <Tooltip title={trashed ? t("noteCard.restoreToReorder") : t("words.dragToReorder")}>
          <Box
            draggable={!trashed}
            onDragStart={(e) => {
              if (trashed) return;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", row.id);
              if (paperRef.current) {
                e.dataTransfer.setDragImage(paperRef.current, 12, 12);
              }
              onGripDragStart();
            }}
            onDragEnd={onDragEnd}
            sx={{
              cursor: trashed ? "default" : "grab",
              color: "text.disabled",
              display: "inline-flex",
              alignItems: "center",
              "&:active": { cursor: trashed ? "default" : "grabbing" },
            }}
          >
            <DragIndicatorIcon fontSize="small" />
          </Box>
        </Tooltip>
        <Tooltip title={t("words.moveUp")}>
          <span>
            <IconButton
              size="small"
              data-reorder-arrow="up"
              aria-label={t("words.moveUp")}
              onClick={(e) => { e.stopPropagation(); onMoveUp?.(); }}
              disabled={!onMoveUp}
              sx={{ p: 0.25, color: "text.disabled", ...(flashArrow === "up" ? reorderFlashSx : null) }}
            >
              <ArrowUpwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("words.moveDown")}>
          <span>
            <IconButton
              size="small"
              data-reorder-arrow="down"
              aria-label={t("words.moveDown")}
              onClick={(e) => { e.stopPropagation(); onMoveDown?.(); }}
              disabled={!onMoveDown}
              sx={{ p: 0.25, color: "text.disabled", ...(flashArrow === "down" ? reorderFlashSx : null) }}
            >
              <ArrowDownwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </span>
        </Tooltip>
        </Box>
        <Box sx={readOnly ? { pointerEvents: "none", opacity: 0.6 } : undefined}>
          <CatalogPicker
            value={supportRef}
            options={catalogs.supportReferences}
            freeSolo={false}
            display={(v) => (v ? shortSupport(v) : t("noteCard.addSupportRef"))}
            placeholder={t("noteCard.supportRefPlaceholder")}
            color="primary"
            variant={active ? "filled" : "outlined"}
            onChange={(next) => {
              setSupportRef(next);
              stashEdit({ support_reference: next });
            }}
          />
        </Box>
        {parseTaRef(supportRef) && (
          <Tooltip title={t("noteCard.openArticle")}>
            <IconButton
              size="small"
              component="a"
              href={`#/articles/ta/${encodeURIComponent(taShort(supportRef))}`}
              aria-label={t("noteCard.openArticle")}
              onClick={(e) => e.stopPropagation()}
              sx={{ p: 0.25, color: "text.secondary" }}
            >
              <MenuBookOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        {onChangeVerse && verseOptions && verseOptions.length > 0 && !readOnly ? (
          <Tooltip title={t("noteCard.changeReference")}>
            <Chip
              label={row.ref_raw}
              size="small"
              variant="outlined"
              clickable
              deleteIcon={<ArrowDropDownIcon />}
              onDelete={(e) => {
                e.stopPropagation();
                setRefMenuAnchor(e.currentTarget.parentElement as HTMLElement);
              }}
              onClick={(e) => {
                e.stopPropagation();
                setRefMenuAnchor(e.currentTarget);
              }}
              sx={{ fontFamily: "monospace", fontSize: 11, height: 22, color: "text.secondary" }}
            />
          </Tooltip>
        ) : (
          <Typography variant="caption" sx={{ color: "text.disabled", fontFamily: "monospace" }}>
            {row.ref_raw}
          </Typography>
        )}
        {stateChip && (
          <Chip
            label={stateChip.label}
            icon={stateChip.icon}
            size="small"
            variant="outlined"
            sx={{
              height: 20,
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: stateChip.color,
              borderColor: stateChip.color,
              "& .MuiChip-icon": { color: stateChip.color, ml: 0.5 },
            }}
          />
        )}
        {collapsedValidated && (
          <Button
            size="small"
            variant="text"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
            sx={{ minWidth: 0, py: 0, px: 0.75, fontSize: 11, color: "text.secondary" }}
          >
            {t("translation.showSource")}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        {/* Right-side action controls grouped into one non-shrinking, non-wrapping
            row. The header itself still wraps (flexWrap on the Stack), but it can
            now only break between the metadata on the left and this whole group —
            never mid-group. That stops the lone + / Save / trash icons from
            flip-flopping across the wrap boundary one at a time when a note goes
            dirty (editing injects the Undo button here, eating the row's slack):
            the group either fits on line 1 or drops to line 2 as a stable unit. */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
        <Tooltip
          title={
            row.restored_from_version != null
              ? t("noteCard.versionTooltipRestored", {
                  restored: row.restored_from_version,
                  unsaved: hasRowDiff ? t("noteCard.unsavedEditsSuffix") : "",
                  version: row.version,
                  date: formatEpochSecondsDateTime(row.updated_at),
                })
              : t("noteCard.versionTooltip", {
                  version: row.version,
                  unsaved: hasRowDiff ? t("noteCard.unsavedEditsSuffix") : "",
                  saved: t("noteCard.timesSaved", { count: row.version - 1 }),
                  date: formatEpochSecondsDateTime(row.updated_at),
                })
          }
        >
          <Chip
            label={`v${row.restored_from_version ?? row.version}${hasRowDiff ? "*" : ""}`}
            size="small"
            variant="outlined"
            clickable
            onClick={(e) => {
              e.stopPropagation();
              setHistoryOpen(true);
            }}
            sx={{
              fontFamily: "monospace",
              fontSize: 11,
              height: 22,
              color: hasRowDiff ? "warning.main" : "text.secondary",
              borderColor: hasRowDiff ? "warning.main" : "divider",
              fontWeight: hasRowDiff ? 600 : 400,
            }}
          />
        </Tooltip>
        {row.latest_source === "ai_pipeline" && (
          <Tooltip title={t("questions.aiPipelineTooltip")}>
            <Chip
              icon={<AutoAwesomeIcon style={{ fontSize: 12 }} />}
              label="AI"
              size="small"
              variant="outlined"
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                color: "secondary.main",
                borderColor: "secondary.main",
                "& .MuiChip-icon": { color: "secondary.main", ml: 0.5, mr: -0.25 },
              }}
            />
          </Tooltip>
        )}
        {/* Save is rendered BEFORE Undo so its slot stays stable: a note
            going dirty appends the Undo control to Save's RIGHT rather than
            inserting it to Save's left and shoving Save out from under the
            cursor (the old order cost a click, and — worse — put an unlabeled
            one-click discard exactly where the user was aiming for Save). */}
        <Tooltip
          title={
            savePendingVersion !== null
              ? t("noteCard.saving")
              : hasRowDiff
                ? t("noteCard.savePending")
                : t("noteCard.noPendingEdits")
          }
        >
          <span>
            <IconButton
              size="small"
              aria-label={t("noteCard.savePending")}
              onClick={flushPending}
              disabled={!hasRowDiff || savePendingVersion !== null || readOnly}
              sx={{
                p: 0.25,
                color:
                  hasRowDiff && savePendingVersion === null && !readOnly
                    ? "primary.main"
                    : "action.disabled",
              }}
            >
              {hasRowDiff ? <SaveIcon fontSize="inherit" /> : <SaveOutlinedIcon fontSize="inherit" />}
            </IconButton>
          </span>
        </Tooltip>
        {/* Gated on hasRowDiff alone (not `active`): a dirty note must show
            its Undo button whether or not the card is focused. The discard is
            destructive (drops every unsaved keystroke) and reachable in one
            click, so it opens a confirm dialog rather than reverting inline. */}
        {hasRowDiff && (
          <Tooltip
            title={
              savePendingVersion !== null
                ? t("noteCard.cantDiscardInFlight")
                : t("noteCard.discardUnsaved")
            }
          >
            <span>
              <IconButton
                size="small"
                aria-label={t("noteCard.discardUnsaved")}
                onClick={() => setDiscardConfirmOpen(true)}
                disabled={savePendingVersion !== null}
                sx={{
                  p: 0.25,
                  color: savePendingVersion !== null ? "action.disabled" : "warning.main",
                }}
              >
                <UndoIcon fontSize="inherit" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        {!readOnly && (
          <>
            {onInsertAfter && (
              <Tooltip title={t("noteCard.addNoteAfter")}>
                <IconButton size="small" aria-label={t("noteCard.addNoteAfter")} onClick={onInsertAfter} color="success" sx={{ p: 0.25 }}>
                  <AddIcon fontSize="inherit" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title={t("noteCard.deleteNote")}>
              <IconButton size="small" aria-label={t("noteCard.deleteNote")} onClick={() => void handleDelete()} color="error" sx={{ p: 0.25 }}>
                <DeleteOutlineIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </>
        )}
        {trashed && (
          <>
            <Chip
              label={t("noteCard.deleted")}
              size="small"
              color="default"
              variant="outlined"
              sx={{ height: 22, fontSize: 11, color: "text.secondary", borderColor: "divider" }}
            />
            <Tooltip title={t("noteCard.restoreNote")}>
              <IconButton size="small" aria-label={t("noteCard.restoreNote")} onClick={onRestore} color="primary" sx={{ p: 0.25 }}>
                <RestoreFromTrashIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </>
        )}
        </Stack>
      </Stack>

      {collapsedValidated ? (
        /* Validated → collapsed one-line preview (green). Click to expand for
           review; editing the expanded card auto-demotes it to 'edited'. */
        <Box
          onClick={() => setExpanded(true)}
          title={t("translation.showSource")}
          sx={{
            px: 1.5,
            py: 1,
            cursor: "pointer",
            color: "text.secondary",
            fontSize: `calc(14px * var(--be-reading-scale, 1))`,
            fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {tsvToDisplay(row.note) || "—"}
        </Box>
      ) : (
        <>
      {/* ── Quote ── */}
      <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.12em",
            }}
          >
            {t("words.quote")}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {active && !readOnly && onStartQuoteBuild && (
            <Tooltip title={t("noteCard.buildFromSourceTooltip")}>
              <Button
                size="small"
                variant={quoteBuildMode ? "outlined" : "text"}
                color={quoteBuildMode ? "primary" : "inherit"}
                onClick={onStartQuoteBuild}
                sx={{
                  fontSize: 11,
                  minWidth: 0,
                  py: 0.25,
                  px: 0.75,
                  color: quoteBuildMode ? "primary.main" : "text.secondary",
                }}
              >
                {quoteBuildMode
                  ? t("noteCard.pickerOpenSelected", { count: quoteBuildSelectionCount })
                  : t("noteCard.buildFromSource")}
              </Button>
            </Tooltip>
          )}
        </Stack>
        <TextField
          value={quote}
          onChange={(e) => {
            setQuote(e.target.value);
            // Debounced parent propagation for the live highlight; no longer
            // a whole-app re-render per keystroke (see scheduleQuotePropagate).
            scheduleQuotePropagate();
          }}
          multiline
          fullWidth
          size="small"
          spellCheck={false}
          onFocus={onFocus}
          InputProps={{
            readOnly,
            ...(hasRowDiff && quote !== rowQuoteDisplay ? { "data-dirty": "true" } : {}),
            ...(showTranslateIcon && {
              endAdornment: (
                <InputAdornment position="end" sx={{ alignSelf: "flex-start" }}>
                  <Tooltip title={t("words.translateTooltip")}>
                    <IconButton
                      size="small"
                      onClick={handleTranslateQuote}
                      sx={{ p: 0.25, color: "primary.main" }}
                    >
                      <TranslateIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ),
            }),
          }}
          inputProps={{
            dir: quoteScript === "ltr" ? "ltr" : "rtl",
            style: {
              fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
              fontSize: quoteScript === "rtl" ? 21 : 19,
              textAlign: quoteScript === "ltr" ? "left" : "right",
              lineHeight: quoteScript === "rtl" ? 1.9 : 1.5,
            },
          }}
        />
      </Box>

      {/* ── English source (translation mode) + the editable draft ──
          The source is pinned read-only against the draft the translator is
          writing. `pairSideBySide` puts the two next to each other (the
          tcCreate reading); otherwise the source stays stacked above the draft,
          which is the layout this card has always had and remains the default.
          Only these two blocks move — quote, support reference, flag chips and
          the approve/re-run row are identical on both axes. ── */}
      <Box
        sx={
          pairSideBySide
            ? { display: "flex", alignItems: "stretch", gap: 1.5, px: 1.5, pt: 1 }
            : undefined
        }
      >
      {showSourceNote &&
        (pairSideBySide ? (
          // Side by side, the source half mirrors the draft half's anatomy so
          // the two read as a matched pair: a label row of the SAME height
          // (PAIR_LABEL_ROW_H — the draft's row is sized by its TEMPLATE /
          // SUGGEST buttons, which the source has no equivalent of), then the
          // content box. Keeping the label OUTSIDE the tinted box is what makes
          // the two boxes start on the same line; with the label inside, the
          // source box began a row higher than the draft field. The box then
          // flexes to fill, so both halves also END on the same line.
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Stack
              direction="row"
              alignItems="center"
              sx={{ mb: 0.5, minHeight: PAIR_LABEL_ROW_H }}
            >
              <Typography variant="caption" sx={SOURCE_LABEL_SX}>
                {t("translation.sourceLabel")}
              </Typography>
            </Stack>
            <Box dir="ltr" sx={{ ...SOURCE_BOX_SX, flex: 1 }}>
              <Box sx={SOURCE_TEXT_SX}>{sourceNote?.note}</Box>
            </Box>
          </Box>
        ) : (
          // Stacked — byte-for-byte the block this card has always rendered.
          <Box dir="ltr" sx={{ ...SOURCE_BOX_SX, mx: 1.5, mt: 1 }}>
            <Typography variant="caption" sx={{ ...SOURCE_LABEL_SX, display: "block", mb: 0.5 }}>
              {t("translation.sourceLabel")}
            </Typography>
            <Box sx={SOURCE_TEXT_SX}>{sourceNote?.note}</Box>
          </Box>
        ))}

      {/* ── Note (hero) ── */}
      <Box
        sx={
          pairSideBySide
            ? // No bottom padding here: the source box stretches to this
              // column's full height, so any padding below the draft field
              // would push the source box past it and misalign their bottoms.
              // Column layout so the field can flex to fill the leftover space.
              { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }
            : { px: 1.5, pt: 0.75, pb: 0.75 }
        }
      >
        <Stack
          direction="row"
          alignItems="center"
          sx={{ mb: 0.5, ...(pairSideBySide ? { minHeight: PAIR_LABEL_ROW_H } : {}) }}
        >
          <Typography
            variant="caption"
            sx={{
              fontFamily: "monospace",
              color: "text.secondary",
              textTransform: "uppercase",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.12em",
            }}
          >
            {translationMode ? t("translation.draftLabel") : t("noteCard.note")}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip
            title={
              !supportRef
                ? t("noteCard.pickSupportRefFirst")
                : templatesForRef.length === 0
                  ? t("noteCard.noTemplateFor", { ref: shortSupport(supportRef) })
                  : templatesForRef.length > 1
                    ? t("noteCard.chooseTemplate")
                    : t("noteCard.fillFromTemplate")
            }
          >
            <span>
              <Button
                size="small"
                variant="text"
                onClick={handleTemplateClick}
                disabled={readOnly || !supportRef || templatesForRef.length === 0}
                startIcon={<DescriptionOutlinedIcon sx={{ fontSize: "14px !important" }} />}
                endIcon={
                  templatesForRef.length > 1 ? (
                    <ArrowDropDownIcon sx={{ fontSize: "16px !important", ml: -0.75 }} />
                  ) : undefined
                }
                sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary", minWidth: 0, py: 0.25, px: 0.75 }}
              >
                {t("translation.template")}
              </Button>
            </span>
          </Tooltip>
          <Tooltip
            title={
              isAiPending
                ? t("noteCard.draftingInBackground")
                : !onStartAi
                  ? t("noteCard.aiUnavailable")
                  : !supportRef
                    ? t("noteCard.pickSupportRefFirst")
                    : !quote.trim()
                      ? t("noteCard.fillQuoteFirst")
                      : t("noteCard.generateWithAi")
            }
          >
            <span>
              <Button
                size="small"
                variant="text"
                onClick={handleAiClick}
                disabled={!onStartAi || !aiPrereqsMet || isAiPending || readOnly}
                startIcon={
                  isAiPending ? (
                    <CircularProgress size={12} color="inherit" />
                  ) : (
                    <AutoAwesomeIcon sx={{ fontSize: "14px !important" }} />
                  )
                }
                sx={{ fontSize: 12, fontWeight: 500, color: "text.secondary", minWidth: 0, py: 0.25, px: 0.75 }}
              >
                {t("noteCard.suggest")}
              </Button>
            </span>
          </Tooltip>
        </Stack>
        {findQuery && activeMatchOccurrence != null && !editingBody ? (
          <NoteBodyReadView
            text={note}
            query={findQuery}
            activeOccurrence={activeMatchOccurrence}
            onActivate={() => setEditingBody(true)}
          />
        ) : (
          <TextField
            value={note}
            inputRef={noteTextareaRef}
            onChange={(e) => {
              // Body text is consumed only by this card — keep it purely local
              // (persisted via the draft store, saved through flushPending). No
              // applyLocalRowPatch, so a keystroke doesn't re-render the app.
              setNote(e.target.value);
            }}
            multiline
            fullWidth
            minRows={2}
            size="small"
            spellCheck
            onFocus={onFocus}
            // Side by side, grow to fill the column so the draft box matches
            // the source box instead of ending short whenever the translation
            // is more compact than the English (Arabic usually is).
            //
            // flex-grow, NOT a fixed height: `height: 100%` on the textarea
            // also CAPPED it, so a draft longer than the source got trapped in
            // a small scrolling box instead of growing the card. Here the field
            // fills leftover space when short, and `min-height: auto` lets it
            // push the column taller when long — at which point the source box
            // stretches to match it instead. Stacked is untouched: the field
            // keeps its natural autosize there.
            sx={
              pairSideBySide
                ? {
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    "& .MuiInputBase-root": { flex: 1, alignItems: "flex-start" },
                  }
                : undefined
            }
            InputProps={{
              readOnly,
              ...(hasRowDiff && note !== rowNoteDisplay ? { "data-dirty": "true" } : {}),
            }}
            inputProps={{
              // Target-language draft direction: RTL when the draft text is
              // itself RTL (e.g. Arabic), so an RTL target reads correctly even
              // when the UI chrome is LTR. English root project passes no
              // translationMode, so this stays unset (browser default).
              ...(translationMode && detectQuoteScript(note) === "rtl"
                ? { dir: "rtl" as const }
                : {}),
              style: {
                fontSize: `calc(15px * var(--be-reading-scale, 1))`,
                lineHeight: 1.55,
                fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
                ...(translationMode && detectQuoteScript(note) === "rtl"
                  ? { textAlign: "right" as const }
                  : {}),
              },
            }}
          />
        )}
      </Box>
      </Box>

      {/* ── Translation-mode action row (Approve / Translate / Re-run) ── */}
      {translationMode && !readOnly && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ px: 1.5, pb: 1, pt: 0.25, flexWrap: "wrap", rowGap: 0.75 }}
        >
          {isDraftState && onApprove && (
            <Button
              size="small"
              variant="contained"
              color="success"
              startIcon={<CheckIcon sx={{ fontSize: "16px !important" }} />}
              onClick={onApprove}
              sx={{ py: 0.25 }}
            >
              {t("common.approve")}
            </Button>
          )}
          {isValidated && expanded && (
            <>
              <Button
                size="small"
                variant="text"
                onClick={() => setExpanded(false)}
                sx={{ py: 0.25, color: "text.secondary" }}
              >
                {t("translation.collapse")}
              </Button>
              {onUnapprove && (
                <Button
                  size="small"
                  variant="text"
                  color="warning"
                  onClick={onUnapprove}
                  sx={{ py: 0.25 }}
                >
                  {t("translation.unapprove")}
                </Button>
              )}
            </>
          )}
          {onTranslate && (isUntranslated || isDraftState) && (
            <Button
              size="small"
              variant={isUntranslated ? "contained" : "outlined"}
              color={isUntranslated ? "secondary" : "inherit"}
              disabled={isTranslating}
              startIcon={
                isTranslating ? (
                  <CircularProgress size={12} color="inherit" />
                ) : (
                  <AutoAwesomeIcon sx={{ fontSize: "16px !important" }} />
                )
              }
              onClick={onTranslate}
              sx={{ py: 0.25, color: isUntranslated ? undefined : "text.secondary" }}
            >
              {isTranslating
                ? t("translation.translating")
                : isUntranslated
                  ? t("common.translate")
                  : t("translation.reRun")}
            </Button>
          )}
          {isDraftState && (
            <Typography variant="caption" sx={{ color: "text.disabled" }}>
              {t("translation.whyDraft")}
            </Typography>
          )}
        </Stack>
      )}

      {/* ── Footer chips ── */}
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          px: 1.5,
          pt: 0.75,
          pb: 1.25,
          flexWrap: "wrap",
          rowGap: 0.5,
          columnGap: 0.75,
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: "grey.50",
        }}
      >
        {onSetPreserve && (
          <Tooltip title={t("noteCard.preserveTooltip")}>
            <Chip
              size="small"
              icon={<PushPinOutlinedIcon style={{ fontSize: 12 }} />}
              label={t("noteCard.preserve")}
              variant={isPreserved ? "filled" : "outlined"}
              color={isPreserved ? "success" : "default"}
              onClick={() => {
                const next = !isPreserved;
                onSetPreserve(next);
                if (next && isHint) onSetHint?.(false);
              }}
              sx={{ fontSize: 11, height: 22, cursor: "pointer" }}
            />
          </Tooltip>
        )}
        {onSetHint && !readOnly && (
          <Tooltip title={t("noteCard.hintTooltip")}>
            <Chip
              size="small"
              icon={<LightbulbOutlinedIcon style={{ fontSize: 12 }} />}
              label={t("noteCard.hint")}
              variant={isHint ? "filled" : "outlined"}
              color={isHint ? "warning" : "default"}
              onClick={() => {
                const next = !isHint;
                onSetHint(next);
                if (next && isPreserved) onSetPreserve?.(false);
              }}
              sx={{ fontSize: 11, height: 22, cursor: "pointer" }}
            />
          </Tooltip>
        )}

        {/* breathing room between toggle group and template group */}
        <Box sx={{ width: 12 }} aria-hidden="true" />

        <Tooltip title={t("noteCard.tcmTooltip")}>
          <span>
            <Chip
              size="small"
              label={t("noteCard.tcm")}
              variant="outlined"
              disabled={readOnly}
              onClick={() => {
                setNote(TCM);
                stashEdit({ note: TCM });
              }}
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                borderStyle: "dashed",
                color: "primary.main",
                borderColor: "primary.light",
                "&:hover": { bgcolor: "primary.50" },
              }}
            />
          </span>
        </Tooltip>
        <Tooltip title={t("noteCard.shTooltip")}>
          <span>
            <Chip
              size="small"
              label={t("noteCard.sh")}
              variant="outlined"
              disabled={readOnly}
              onClick={() => {
                const t = buildSH(row.book);
                setNote(t);
                stashEdit({ note: t });
              }}
              sx={{
                fontFamily: "monospace",
                fontSize: 11,
                height: 22,
                borderStyle: "dashed",
                color: "primary.main",
                borderColor: "primary.light",
                "&:hover": { bgcolor: "primary.50" },
              }}
            />
          </span>
        </Tooltip>

        <Box sx={{ flex: 1 }} />

        <Chip
          label={row.id}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace", fontSize: 11, height: 22 }}
        />
      </Stack>
        </>
      )}
      {historyOpen && (
        <Suspense fallback={null}>
          <NoteHistoryDialog
            open={historyOpen}
            noteId={row.id}
            book={row.book}
            currentVersion={row.version}
            effectiveVersion={row.restored_from_version ?? row.version}
            onClose={() => setHistoryOpen(false)}
            onUseVersion={handleUseVersion}
            readOnly={readOnly}
          />
        </Suspense>
      )}
      <Dialog open={aiConfirmOpen} onClose={() => setAiConfirmOpen(false)}>
        <DialogTitle>{t("noteCard.replaceNoteTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("noteCard.replaceNoteAiBody")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAiConfirmOpen(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => {
              setAiConfirmOpen(false);
              onStartAi?.(buildAiLive());
            }}
            color="primary"
            variant="contained"
          >
            {t("noteCard.replace")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={discardConfirmOpen} onClose={() => setDiscardConfirmOpen(false)}>
        <DialogTitle>{t("noteCard.discardConfirmTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>{t("noteCard.discardConfirmBody")}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardConfirmOpen(false)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => {
              setDiscardConfirmOpen(false);
              handleUndo();
            }}
            color="warning"
            variant="contained"
          >
            {t("noteCard.discardConfirmAction")}
          </Button>
        </DialogActions>
      </Dialog>
      <Menu
        anchorEl={refMenuAnchor}
        open={Boolean(refMenuAnchor)}
        onClose={() => {
          setRefMenuAnchor(null);
          setRefSpanMode(false);
        }}
        slotProps={{ paper: { sx: { maxHeight: 320 } } }}
      >
        {refSpanMode
          ? [
              <ListSubheader key="hdr" sx={{ lineHeight: 2, bgcolor: "transparent" }}>
                {t("noteCard.extendThrough", { verse: row.verse })}
              </ListSubheader>,
              ...(verseOptions ?? [])
                .filter((v) => v > row.verse)
                .map((v) => (
                  <MenuItem
                    key={v}
                    onClick={() => {
                      setRefMenuAnchor(null);
                      setRefSpanMode(false);
                      onChangeVerse?.(row.verse, v);
                    }}
                  >
                    {`v${row.verse}–${v}`}
                  </MenuItem>
                )),
              <Divider key="div" />,
              <MenuItem key="back" onClick={() => setRefSpanMode(false)}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {t("noteCard.back")}
                </Typography>
              </MenuItem>,
            ]
          : [
              ...(verseOptions ?? []).map((v) => (
                <MenuItem
                  key={v}
                  selected={v === row.verse}
                  onClick={() => {
                    setRefMenuAnchor(null);
                    // A bare verse always collapses a bridge to a singleton;
                    // pass no end so ref_raw becomes "chapter:verse".
                    if (v !== row.verse || (row.ref_raw ?? "").includes("-")) onChangeVerse?.(v);
                  }}
                >
                  {v === 0 ? t("topbar.intro") : `v${v}`}
                </MenuItem>
              )),
              // Span affordance stays out of the single-verse flow: one extra
              // tap, only offered when a later verse exists to bridge to.
              ...(row.verse !== 0 && (verseOptions ?? []).some((v) => v > row.verse)
                ? [
                    <Divider key="div" />,
                    <MenuItem key="span" onClick={() => setRefSpanMode(true)}>
                      <Typography variant="body2" sx={{ color: "primary.main" }}>
                        {t("noteCard.spanMultiple")}
                      </Typography>
                    </MenuItem>,
                  ]
                : []),
            ]}
      </Menu>
      <Menu
        anchorEl={templateMenuAnchor}
        open={Boolean(templateMenuAnchor)}
        onClose={() => setTemplateMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxWidth: 380 } } }}
      >
        {templatesForRef.map((tmpl, i) => (
          <MenuItem
            key={`${tmpl.type}-${i}`}
            onClick={() => {
              setTemplateMenuAnchor(null);
              requestTemplate(tmpl.body);
            }}
            sx={{ whiteSpace: "normal", alignItems: "flex-start" }}
          >
            <ListItemText
              primary={tmpl.type || t("noteCard.defaultTemplate")}
              secondary={tmpl.body.length > 90 ? `${tmpl.body.slice(0, 90)}…` : tmpl.body}
            />
          </MenuItem>
        ))}
      </Menu>
      <Dialog open={templateConfirmBody !== null} onClose={() => setTemplateConfirmBody(null)}>
        <DialogTitle>{t("noteCard.replaceNoteTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("noteCard.replaceNoteTemplateBody")}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTemplateConfirmBody(null)}>{t("common.cancel")}</Button>
          <Button
            onClick={() => {
              if (templateConfirmBody !== null) applyTemplate(templateConfirmBody);
              setTemplateConfirmBody(null);
            }}
            color="primary"
            variant="contained"
          >
            {t("noteCard.replace")}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

// Skip re-rendering a card when only sibling cards changed. We compare the
// data + UI-state props by value and treat the callback props as stable:
// they close over this row's id plus Shell handlers, and a row whose data is
// unchanged keeps a behaviourally-correct closure. The `row` reference is the
// load-bearing check — useChapter.applyLocalRowPatch preserves identity for
// untouched rows, so an edit or save on one note doesn't churn the others.
function areNotePropsEqual(a: Props, b: Props): boolean {
  const qa = a.findQuery ?? null;
  const qb = b.findQuery ?? null;
  const sameQuery =
    qa === qb ||
    (!!qa &&
      !!qb &&
      qa.find === qb.find &&
      qa.regex === qb.regex &&
      qa.caseSensitive === qb.caseSensitive);
  return (
    a.row === b.row &&
    a.active === b.active &&
    sameQuery &&
    (a.activeMatchOccurrence ?? null) === (b.activeMatchOccurrence ?? null) &&
    a.dragging === b.dragging &&
    a.isDropTarget === b.isDropTarget &&
    a.isAiPending === b.isAiPending &&
    a.aiRecentlyCompletedAt === b.aiRecentlyCompletedAt &&
    a.locked === b.locked &&
    a.quoteBuildMode === b.quoteBuildMode &&
    a.quoteBuildSelectionCount === b.quoteBuildSelectionCount &&
    (a.flashArrow ?? null) === (b.flashArrow ?? null) &&
    a.translationMode === b.translationMode &&
    (a.sourceNote ?? null) === (b.sourceNote ?? null) &&
    a.isTranslating === b.isTranslating
  );
}

export const NoteCard = memo(NoteCardInner, areNotePropsEqual);
