// TranslateNotesScreen — the translation-notes queue, rebuilt faithfully to the
// approved "Translation Notes — Titus 1" mockup (the design-direction reset).
//
// Translation-primary by construction: the translator is turning an English
// translationNote into their language, so the TARGET DRAFT is the centrepiece
// and everything else on the screen is read-only context for it. There are
// exactly three verbs — Approve / Not needed / Redo — and no authoring chrome:
// no preserve, no hint, no TCM/SH chips, no reorder / insert / retarget, no
// debug row ids, no quote builder, no history dialog. Those belong to the
// authoring surfaces (ReviewQueue, NoteCard), not to a translator's screen.
//
// ── 2026-08-10 responsive layouts (Benjamin) ────────────────────────────────
//
// Below md (900px) nothing changed: one centred column (the mockup's phone
// shell) with the viewport-fixed action bar — that simplicity IS the phone
// design. At md+ the screen becomes master-detail after TranslateWordsScreen's
// precedent (the desk-class primitives in docs/mockups/desktop-first/
// _design.css): a scrollable list pane (340-380px) showing the note queue as
// rows (verse ref · quote-or-note preview · status chip) on the inline-start
// side, and a panel-chromed detail pane holding the same card stack, both
// inside a 1440px centred desk. Selecting a row moves the SAME queue cursor
// the phone's Prev/Next drives — one cursor, two representations — and the
// action bar goes sticky at the pane's bottom instead of viewport-fixed
// (pinned there by margin-block-start:auto when the content is short).
// Logical properties only; the grid column order itself flips under RTL.
//
// ── 2026-08-10 markup round (Benjamin) ──────────────────────────────────────
//
// * List rows preview the TARGET note — the live draft for the open card,
//   else the row's saved target text, else the English source note's first
//   line — NEVER the original-language quote (Hebrew in a one-line preview
//   reads as noise on OT books). Markdown chrome (#, **) is stripped so
//   intro rows stop reading as "# Zechariah 1 General Notes".
// * Prev/Next also live in the topbar as compact icon chevrons (both
//   widths), sharing the card stack's cursor and disabled logic, flipped
//   under RTL per the scripture screen's scaleX pattern.
// * A horizontal touch-swipe on the card stack (phone column and the wide
//   detail pane scroller) pages the same cursor via useSwipeNav — disabled
//   on the done view, direction-mapped to the TARGET language's direction.
//
// ── 2026-08-10 article-type round (Benjamin) ────────────────────────────────
//
// Each note's tA article type ("metaphor", "merism", …) is derived from the
// row's support_reference (last path segment; category prefix stripped for
// the label, full slug kept as the tooltip) and shown as a quiet read-only
// pill on the list rows and in the draft card's header. A compact type
// filter (MUI Select: "All types" plus the types present in THIS chapter's
// queue, with counts) narrows both the list pane and the Prev/Next / swipe /
// advance traversal by mapping cursor movement through a derived index list
// over the frozen queue — the queue itself is never mutated, and with no
// filter active every traversal path is byte-equivalent to before. Filter
// state is component-local and resets on chapter change.
//
// Data + save machinery is the proven plumbing, unchanged:
//   * rows + verses            → useChapter
//   * English source note      → useSourceNotes (published en_tn TSV, keyed by
//                                row id) — the row's OWN `note` is the TARGET
//   * every keystroke          → drafts store (IndexedDB), restored on mount,
//                                cleared by the outbox once the server confirms
//   * saves                    → outbox.enqueueRow with If-Match + baseline
//   * Approve                  → api.validateNote
//   * Not needed               → api.trashNote (the existing tn soft-trash,
//                                relabelled; the row stays recoverable)
//   * Redo                     → api.tnQuick for OT verse notes; intro/general
//                                notes (verse === 0) and every NT verse note
//                                use the single-row translate pipeline instead
//                                (classic NoteCard "Re-run" already does this —
//                                issue #300; NT routing: see lib/tnRedo.ts)
//
// Chapter locks (verified in api/src/rows.ts, findings §2.7): tn PATCH is
// lock-EXEMPT, and /validate + /trash have no lock check at all. So every write
// this screen makes is accepted while a run is in flight — the lock banner is
// informational here and gates nothing. Disabling anything would block writes
// the server accepts.
//
// 409 handling is deliberately minimal: a banner that says another editor
// changed the row, with a reload affordance. The full merge dialog stays on
// the authoring screen.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CheckIcon from "@mui/icons-material/Check";
import SaveIcon from "@mui/icons-material/Save";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { isAquiferDraftRow, unescapeNewlines, waitForOp } from "./translateShared";
import { useSwipeNav } from "./useSwipeNav";
import type { FlowScreenContext } from "./types";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useSourceNotes } from "../../hooks/useSourceNotes";
import { useSourceScripture } from "../../hooks/useSourceScripture";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { useShowSourceUlt } from "../../lib/editorPrefs";
import { resolveSourceRef } from "../../lib/sourceRef";
import {
  buildVerseIndex,
  clampCoveredForRender,
  coveredLaneSlices,
  noteCoveredVerses,
  noteRefLabel,
} from "../../lib/verseRange";
import { buildTnQuickRequest } from "../../lib/tnQuickRequest";
import {
  introRedoTimeoutMs,
  redoErrorIsAiUnconfigured,
  tnRedoBlockedReason,
  tnRedoUsesPipeline,
} from "../../lib/tnRedo";
import { resolveFlowChipStatus, flowChipKind, type FlowChipStatus } from "../../lib/flowStatusChip";
import { flowLaneSegmentsAcross, type FlowSegment } from "../../lib/flowHighlight";
import { isHebrewBook } from "../../lib/sourceSearch";
import { realChapters } from "../../lib/bookSummary";
import { drafts, rowKey } from "../../sync/drafts";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { pipelineStore, getSessionKey } from "../../sync/pipelineStore";
import {
  api,
  ApiError,
  type ChapterLockedBody,
  type TnRow,
  type TqRow,
} from "../../sync/api";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateNotesScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  // Optional deep-link verse (e.g. from the Books "Continue" card, a manual
  // URL edit, or browser Back/Forward). Seeds the queue cursor to the first
  // queue entry at or after this verse on mount/chapter change, and re-seeks
  // it again on any later change to this prop within the same chapter (see
  // the dedicated seek effect below) — without rebuilding the queue itself.
  verse?: number;
  // Optional deep-link note id (#/notes/{book}/{ch}/{vs}?row={id}) — the
  // SyncStatusBar "N unsaved" jump menu sends it so the cursor lands on the
  // exact note holding the draft, not just the verse's first card. When the id
  // isn't in the queue (trashed, or a stale link) the verse seek still applies.
  rowId?: string;
}

// A card is terminal in exactly two ways — the two verbs that finish it.
// "Edited" is a chip, not a terminal state: editing a draft does not approve it,
// and pretending otherwise would report progress the server does not have.
type CardStatus = "approved" | "skipped";

// Content width. The mockup is a 430px phone shell; 480 keeps the same one-column
// reading measure while giving desktop a little more room for long notes.
const COLUMN_PX = 480;

// tA article type, derived from the row's support reference:
// "rc://*/ta/man/translate/figs-metaphor" → slug "figs-metaphor". The display
// label strips the category prefix and reads hyphens as spaces —
// "figs-metaphor" → "metaphor", "writing-newevent" → "newevent",
// "grammar-connect-logic-result" → "connect logic result". The full slug
// stays available as the tooltip (2026-08-10 article-type round).
function typeSlugOf(supportReference: string | null | undefined): string | null {
  if (!supportReference) return null;
  const seg = supportReference.split("/").filter(Boolean).pop();
  return seg || null;
}

function typeLabelOf(slug: string): string {
  return slug.replace(/^(?:figs|translate|writing|grammar)-/, "").replace(/-/g, " ");
}

interface LaneProps {
  label: string;
  // Gates the "no text" empty state only — the rendered body comes from
  // `segments` (which already carries this text, marked up per token).
  text: string | null;
  segments: FlowSegment[];
  labelFontFamily: string | undefined;
  mark: (segments: FlowSegment[]) => ReactNode;
}

// Read-only scripture reference lane (ULT/UST) above a note card, with the
// note's quote highlighted via `mark`.
//
// Hoisted to module scope (2026-08-16, nested-component audit, issue #172):
// declaring this inside TranslateNotesScreen's body gave it a new function
// identity on every parent render, so React remounted the whole subtree on
// every hub/screen re-render rather than just when its own props changed.
// `theme.typography.fontFamily` and the `mark` highlighter are now explicit
// props instead of closed-over values, following the QaPair hoist pattern in
// TranslateQuestionsScreen.tsx.
function Lane({ label, text, segments, labelFontFamily, mark }: LaneProps) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: "9px",
        paddingBlock: 1.25,
        paddingInline: 1.5,
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.03rem",
        lineHeight: 1.55,
        "& + &": { mt: 1 },
      }}
    >
      <Box
        component="span"
        sx={{
          display: "block",
          fontFamily: labelFontFamily,
          fontSize: "0.656rem",
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "text.secondary",
          mb: 0.375,
        }}
      >
        {label}
      </Box>
      {text ? (
        // dir="auto" follows the *content*: Arabic lane text lays out RTL with
        // trailing punctuation on the correct side, English stays LTR. The
        // label above keeps the container's direction.
        <Box component="span" dir="auto" sx={{ display: "block", textAlign: "start" }}>
          {mark(segments)}
        </Box>
      ) : (
        <Box component="em" sx={{ color: "text.secondary", fontSize: "0.875rem" }}>
          {t("flowTranslate.laneNoText", { label })}
        </Box>
      )}
    </Box>
  );
}

export default function TranslateNotesScreen({ book, chapter, verse, rowId }: TranslateNotesScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // --hl from docs/flows/ui/_tokens.css: the quote highlight in scripture, and
  // the ground the "Edited" chip and the tap-to-edit hover share.
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  // .ref in the mockup: Ocean in light, Cultivate in dark.
  const REF_COLOR = dark ? "#70C9CC" : "#014263";
  const { ok, skip } = theme.palette.flows;
  // md+ (>=900px, the words screen's breakpoint): master-detail side by side
  // instead of the phone's single centred column (2026-08-10, header).
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  // Directional chevrons follow the UI direction (TranslateScriptureScreen's
  // pattern) — MUI does not flip icons under RTL by itself.
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || t("flowTranslate.targetFallback");
  const litLabel = projectConfig?.litLabel || "ULT";
  const simLabel = projectConfig?.simLabel || "UST";

  // The English source note lives in the PUBLISHED source repo, not in D1: in a
  // translation-mode workspace the row's own `note` IS the target being drafted
  // (useSourceNotes.ts:4-7 says this for the tQ twin, and ResourceColumn.tsx:326-338
  // wires the tN case exactly this way). Null projection = no tN source
  // configured → the English card degrades to a plain statement rather than
  // showing the target text twice.
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tn"),
    [projectConfig],
  );
  const sourceNotes = useSourceNotes(translationMode ? book : null, sourceProjection);

  // The published source-language literal bible (translationSource `lit`, e.g.
  // unfoldingWord/en_ult) as an optional third read-only lane (issue #430). A
  // BSOJ translator's lit/sim lanes are AVD/NAV; the English the notes were
  // written against is nowhere on this screen otherwise. Offered only when the
  // project's own lit lane isn't already that repo (an English-root workspace
  // would show ULT twice), and only fetched while the toggle is on.
  const sourceLitRef = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "lit"),
    [projectConfig],
  );
  const sourceUltAvailable =
    translationMode &&
    sourceLitRef != null &&
    !(sourceLitRef.org === projectConfig?.org && sourceLitRef.repo === projectConfig?.repos?.lit);
  // "en_ult" → "ULT": the resource code after the language prefix, the same
  // convention orgInference derives lane labels from.
  const sourceUltLabel = useMemo(() => {
    const code = sourceLitRef?.repo.split("_").slice(1).join("_").toUpperCase();
    return code || "ULT";
  }, [sourceLitRef]);
  const [showSourceUlt, setShowSourceUlt] = useShowSourceUlt();
  const sourceUltOn = sourceUltAvailable && showSourceUlt;
  const sourceUlt = useSourceScripture(sourceUltOn ? book : null, chapter, sourceLitRef, "SOURCE_LIT");

  const { status, data, refetch, applyLocalRowPatch, applyLocalRowReplacement } = useChapter(
    book,
    chapter,
  );
  // Chapter count for "Continue to chapter N+1" — summary only; the per-chapter
  // payloads stay lazy.
  const { summary } = useBook(book, true);
  const chapterCount = summary ? realChapters(summary).length : null;

  // ── queue ────────────────────────────────────────────────────────────────
  // Frozen once per chapter so the denominator ("3 of 8") and the progress bar
  // stay stable: approving a card, or moving one to the trash, must not
  // renumber the queue under the translator's hands.
  const chapterKey = `${book}:${chapter}`;
  const [queue, setQueue] = useState<{ key: string; ids: string[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<"cards" | "done">("cards");
  const [reviewing, setReviewing] = useState(false);
  // Article-type filter (slug, e.g. "figs-metaphor"); null = show everything.
  // Session-local, reset on chapter change (2026-08-10 article-type round).
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.book !== book || data.chapter !== chapter) return;
    if (queue?.key === chapterKey) return;
    const ordered = [...data.tn]
      .filter((r) => r.trashed_at == null)
      .sort((a, b) => a.verse - b.verse || (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const seed: Record<string, CardStatus> = {};
    for (const r of ordered) if (r.translation_state === "validated") seed[r.id] = "approved";
    const firstOpen = ordered.findIndex((r) => !seed[r.id]);
    setQueue({ key: chapterKey, ids: ordered.map((r) => r.id) });
    setStatuses(seed);
    setEditedIds(new Set());
    const rowIdx = rowId != null ? ordered.findIndex((r) => r.id === rowId) : -1;
    if (rowIdx >= 0) {
      // An exact note id wins over the verse seek — several notes can share a
      // verse, and the id names the one the deep link (e.g. the "N unsaved"
      // jump menu) actually meant.
      setCursor(rowIdx);
    } else if (verse != null) {
      // A verse past the last note's verse has no >= match (-1); clamp to the
      // last card instead of falling back to index 0, which would jump to the
      // top of the chapter instead of near where the user asked to look.
      const seekIdx = ordered.findIndex((r) => r.verse >= verse);
      setCursor(seekIdx < 0 ? (ordered.length > 0 ? ordered.length - 1 : 0) : seekIdx);
    } else {
      setCursor(firstOpen < 0 ? 0 : firstOpen);
    }
    // A deep-linked verse or note always lands on the card view, even if every
    // note in the chapter is already approved — "done" would otherwise discard
    // the requested target.
    setView(verse != null || rowIdx >= 0 ? "cards" : ordered.length > 0 && firstOpen < 0 ? "done" : "cards");
    setReviewing(false);
    setTypeFilter(null);
    // `verse` and `rowId` deliberately not deps beyond this — this effect only builds the
    // queue and seeds its cursor once per mount/chapter change (the
    // `queue?.key === chapterKey` guard above). Re-seeking on a later,
    // same-chapter change to `verse` is handled by the dedicated effect below,
    // which does not rebuild the queue or reset statuses/editedIds/typeFilter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, book, chapter, queue, chapterKey]);

  const rowById = useMemo(() => {
    const m = new Map<string, TnRow>();
    for (const r of data?.tn ?? []) m.set(r.id, r);
    return m;
  }, [data]);

  // Note rows in THIS book holding persisted unsaved typing (IndexedDB drafts
  // from this browser). Drives the list pane's "Unsaved" chip so a translator
  // following the top bar's "N unsaved" jump can see exactly which note it
  // meant — the open card's own live diff is covered separately by hasDiff.
  const [draftRowIds, setDraftRowIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // `active` fences the subscription's initial async snapshot: subscribe()
    // fires the callback from a listAll() promise that unsubscribe does NOT
    // cancel, so on a book change the outgoing effect's late snapshot could
    // otherwise land after the new book's and mark colliding row ids (ids are
    // only unique per book) Unsaved.
    let active = true;
    const unsub = drafts.subscribe((list) => {
      if (!active) return;
      const ids = new Set<string>();
      for (const d of list) {
        if (d.quarantined) continue;
        if (d.meta.kind === "row" && d.meta.rowKind === "tn" && d.meta.book === book) {
          ids.add(d.meta.id);
        }
      }
      setDraftRowIds(ids);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [book]);

  const queueIds = queue?.key === chapterKey ? queue.ids : null;
  const total = queueIds?.length ?? 0;
  const currentId = queueIds && cursor < queueIds.length ? queueIds[cursor] : null;
  const row = currentId ? (rowById.get(currentId) ?? null) : null;
  const statusedCount = queueIds ? queueIds.filter((id) => statuses[id]).length : 0;

  // Re-seek the cursor when `verse` changes while the queue is already built
  // for the current chapter — e.g. editing the URL from #/notes/RUT/1 to
  // #/notes/RUT/1/9, or Back/Forward between two verses of the same chapter
  // (issue #201). Cross-chapter deep links are handled above, by the queue
  // rebuild itself. Guarded on an actual change of `verse` (via the ref, not
  // just its presence in the dep array) so this never fires on plain cursor
  // navigation (Prev/Next), a status change, or unrelated re-renders — only a
  // real prop change moves the cursor here. Uses the same setCursor/setView
  // pair the list pane's row click uses, so drafts stash/hydrate exactly as
  // they do for a manual row click — no queue rebuild, no reset of statuses/
  // editedIds.
  const prevVerseRef = useRef(verse);
  const prevRowIdRef = useRef(rowId);
  useEffect(() => {
    if (prevVerseRef.current === verse && prevRowIdRef.current === rowId) return;
    prevVerseRef.current = verse;
    prevRowIdRef.current = rowId;
    if (!queueIds || queueIds.length === 0) return;
    // Honoring a same-chapter verse change always overrides an active type
    // filter (issue #226, gap 2). The requested verse's note may be a different
    // type — hidden by the filter — and the filter effect below would otherwise
    // immediately yank the cursor to the first visible row, so the URL never
    // lands on the requested verse. Clearing the filter first (batched with the
    // setCursor) lets that effect early-return instead of fighting this one, and
    // mirrors what the queue-build path does on a cross-chapter deep link.
    setTypeFilter(null);
    // Same precedence as the queue-build seek: an exact note id (from the
    // "N unsaved" jump menu) beats the verse's first-card heuristic.
    if (rowId != null) {
      const rowIdx = queueIds.indexOf(rowId);
      if (rowIdx >= 0) {
        setCursor(rowIdx);
        setView("cards");
        return;
      }
    }
    if (verse == null) {
      // The verse segment was dropped (e.g. #/notes/RUT/1/9 → #/notes/RUT/1 via
      // Back/Forward or a manual URL edit). Restore the same no-verse init the
      // mount/queue-build path uses: first still-open card, or the done view
      // when every card in the chapter is already statused (issue #226, gap 1).
      const firstOpen = queueIds.findIndex((id) => !statuses[id]);
      setCursor(firstOpen < 0 ? 0 : firstOpen);
      setView(firstOpen < 0 ? "done" : "cards");
      return;
    }
    const seekIdx = queueIds.findIndex((id) => (rowById.get(id)?.verse ?? -Infinity) >= verse);
    setCursor(seekIdx < 0 ? queueIds.length - 1 : seekIdx);
    setView("cards");
  }, [verse, rowId, queueIds, rowById, statuses]);

  // ── article-type filter (2026-08-10) ─────────────────────────────────────
  // Distinct types present in THIS chapter's queue, with counts — the filter
  // menu is built from what is actually here, never a global taxonomy.
  const typeOptions = useMemo(() => {
    if (!queueIds) return [];
    const counts = new Map<string, { label: string; count: number }>();
    for (const id of queueIds) {
      const slug = typeSlugOf(rowById.get(id)?.support_reference);
      if (!slug) continue;
      const entry = counts.get(slug);
      if (entry) entry.count += 1;
      else counts.set(slug, { label: typeLabelOf(slug), count: 1 });
    }
    return [...counts.entries()]
      .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [queueIds, rowById]);

  // The filtered traversal: an ascending index list over the FROZEN queue —
  // the queue itself is never mutated. Every cursor movement while a filter
  // is active maps through this list; with no filter the original code paths
  // run untouched (byte-equivalent behavior).
  const visibleIdx = useMemo(() => {
    if (!queueIds || !typeFilter) return [];
    const out: number[] = [];
    queueIds.forEach((id, i) => {
      if (typeSlugOf(rowById.get(id)?.support_reference) === typeFilter) out.push(i);
    });
    return out;
  }, [queueIds, typeFilter, rowById]);

  // Applying a filter the current card doesn't match snaps the cursor to the
  // first matching card (an empty match set renders the empty state instead).
  // A filter whose type vanished from the queue (refetch) clears itself.
  useEffect(() => {
    if (!typeFilter || !queueIds) return;
    if (!typeOptions.some((o) => o.slug === typeFilter)) {
      setTypeFilter(null);
      return;
    }
    if (visibleIdx.length === 0) return;
    if (!visibleIdx.includes(cursor)) setCursor(visibleIdx[0]);
  }, [typeFilter, typeOptions, visibleIdx, cursor, queueIds]);

  // ── editor state ─────────────────────────────────────────────────────────
  const [draftValue, setDraftValue] = useState("");
  const baselineRef = useRef("");
  // "Hydration for this key has started" — set synchronously, guards against
  // re-entering the hydrate branch and against a stale async lookup landing
  // after a newer row change.
  const hydratedKeyRef = useRef<string | null>(null);
  // "Hydration for this key has FULLY settled" (sync setup *and* the async
  // drafts.get() lookup resolved) — deliberately React state, not a ref. See
  // issue #167 and the comment on the hydrate/stash effects below.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editing, setEditing] = useState(false);
  // Phone focus mode (2026-08-15, mobile polish): with the on-screen keyboard
  // up there is almost no room, so an active edit on a narrow viewport hides
  // the surrounding chrome (topbar, action bar, Prev/Next, type filter) and
  // leaves only the scripture/source context cards, the editor, and its Done
  // button. Wide/desktop behavior is untouched — this is always false there.
  const focusMode = !wide && editing;
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorInputRef = useRef<HTMLTextAreaElement>(null);

  const [busy, setBusy] = useState(false);
  const [redoing, setRedoing] = useState(false);
  // Intro Redo is async (pipeline). Track the exact job + row we started so
  // onComplete / timeout only settle *this* Redo — not chapter-wide translate
  // jobs or a Redo on another note/screen (issue #300 review).
  const pendingIntroRedoRef = useRef<{ jobId: string; rowId: string } | null>(null);
  // Same pending row id as state, because the inline editor has to LOCK while a
  // background redraft is in flight: the draft key is per row, and settling a
  // done job clears that draft — so anything typed in the meantime would be
  // silently discarded (codex P1 on #300). A ref can't gate a render.
  const [introRedoRowId, setIntroRedoRowId] = useState<string | null>(null);
  const redoingRef = useRef(false);
  redoingRef.current = redoing;
  const introRedoTimerRef = useRef<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);
  // Sticky once the server tells us the AI proxy isn't configured — there is no
  // capability flag to read up front, so the first 503 is how we learn.
  const [aiUnavailable, setAiUnavailable] = useState<string | null>(null);

  const say = useCallback((text: string, severity: "info" | "warning" = "warning") => {
    setNotice({ text, severity });
  }, []);

  // Hydrate the editor on card change: a persisted draft (unsaved typing from
  // this browser) wins over the row's own content.
  //
  // Third issue-#167 fix, this one for React StrictMode (web/src/main.tsx —
  // enabled): on a component's first mount, StrictMode runs this effect,
  // immediately runs its cleanup (cancelled = true), then re-runs the effect
  // body — simulating a fast unmount/remount, dev-only. The re-run used to
  // bail out at `if (hydratedKeyRef.current === nonceKey) return;` alone
  // (already true, set synchronously by the first run) and do nothing else;
  // meanwhile the first run's own drafts.get() eventually resolves but bails
  // at its `cancelled` check, so setSettledKey never fires for that row —
  // the initially-mounted card could never persist a draft, since the stash
  // effect's settledKey guard stayed permanently unmet for it.
  //
  // Fix: only skip entirely once BOTH hydratedKeyRef and settledKey already
  // match this nonceKey. When hydratedKeyRef matches but settledKey doesn't
  // (StrictMode's second invocation, or any other race that left a lookup
  // stranded), skip re-running the *synchronous* setup — draftValue/baseline
  // are already right, no need to reset them — but still start a *fresh*,
  // independently-cancellable lookup. Only one of the two invocations' async
  // callbacks can ever be live (the other's cleanup already flipped its own
  // `cancelled`), so exactly one settles the key; a data-application race
  // between overlapping lookups still can't happen, since that's guarded
  // by each callback's own `cancelled` closure exactly as before.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tn", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (hydratedKeyRef.current === nonceKey && settledKey === nonceKey) return;
    if (hydratedKeyRef.current !== nonceKey) {
      hydratedKeyRef.current = nonceKey;
      const fallback = unescapeNewlines(row.note);
      baselineRef.current = fallback;
      setDraftValue(fallback);
      setEditing(false);
    }
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== nonceKey) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      const patchVal = payload?.patch?.note;
      if (typeof patchVal === "string") setDraftValue(unescapeNewlines(patchVal));
      const baselineVal = payload?.baseline?.note;
      if (typeof baselineVal === "string") baselineRef.current = unescapeNewlines(baselineVal);
      // Mark this key fully settled — sync setup AND the async lookup have
      // both landed — whether or not a persisted draft was found. This is
      // STATE, not a ref: setting it is guaranteed to produce a render/effect
      // pass, so the stash effect below is never left waiting on a pass that
      // depends on some *other* setState call happening to fire too. See
      // issue #167 (three separate bugs fixed by this split and the guard
      // above, all documented here and on the stash effect).
      setSettledKey(nonceKey);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id, book, reloadNonce, settledKey]);

  const hasDiff = draftValue !== baselineRef.current;

  // While THIS row has a background redraft in flight the inline editor is
  // read-only: settling a done job clears the row's draft and refetches, so
  // anything typed in that window would be thrown away. Only the pending row
  // locks — a redraft on one note must not block editing another.
  const editLocked = introRedoRowId != null && row?.id === introRedoRowId;

  // Stash every keystroke. Nothing leaves the browser here — the draft store
  // is what makes "no save on blur, no save on unmount" safe.
  //
  // Guarded on settledKey, not merely on "hydration started" (issue #167,
  // two related bugs found in review):
  //
  // 1. A guard based on a REF that lags one commit behind row?.id (the
  //    original attempt) assumed the hydration effect's setDraftValue always
  //    produces a follow-up render for the lagging ref to catch up on. React
  //    skips that render when the new row's raw content happens to be
  //    Object.is-equal to the outgoing row's leftover text, silently
  //    breaking the guard for that row.
  // 2. A guard based on hydratedKeyRef ALONE (set synchronously the instant
  //    hydration *starts*, the second attempt) is worse: it treats the
  //    hydrate effect's own synchronous setDraftValue(fallback) commit as
  //    "already hydrated," so this effect can run — and call drafts.clear()
  //    — before the async drafts.get() lookup has resolved. Concretely: row
  //    change to B (which has a persisted draft) → hydrate branch sets
  //    baseline=fallback, calls setDraftValue(fallback) (a REAL render,
  //    since B's fallback differs from the outgoing row's text) → THIS
  //    effect re-runs in the very next commit, sees draftValue === baseline
  //    (both "fallback," since the async lookup hasn't overwritten it yet)
  //    → clears the persisted draft in IndexedDB before it was ever read.
  //
  // settledKey is set only from inside the async lookup's .then(), so it
  // can't go true until the read has actually completed — independent of
  // whichever setState calls happen to fire along the way, in either
  // effect.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tn", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (settledKey !== nonceKey) return;
    if (draftValue !== baselineRef.current) {
      void drafts.set(
        key,
        { patch: { note: draftValue }, baseline: { note: baselineRef.current } },
        row.version,
        { kind: "row", rowKind: "tn", id: row.id, book, chapter: row.chapter, verse: row.verse },
      );
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftValue, row?.id, row?.version, book, reloadNonce, settledKey]);

  useUnsavedGuard(hasDiff);

  // Entering edit mode focuses the textarea without letting the browser's own
  // autoFocus scroll fire mid-keyboard-open (which, combined with the
  // same-frame height change on phones, loses the user's place); we drive the
  // scroll ourselves, a frame later, once layout has settled. On wide/desktop
  // layouts we only reveal the editor if it's actually off-screen (matching
  // the old autoFocus behavior); on phone we center it, then re-center once
  // more when the on-screen keyboard finishes opening (visualViewport
  // 'resize'), since that resize can happen after our first scroll.
  useEffect(() => {
    if (!editing) return;
    editorInputRef.current?.focus({ preventScroll: true });
    const raf = requestAnimationFrame(() => {
      editorContainerRef.current?.scrollIntoView({ block: wide ? "nearest" : "center" });
    });
    let vv: VisualViewport | undefined;
    let onResize: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!wide) {
      vv = window.visualViewport ?? undefined;
      if (vv) {
        onResize = () => {
          editorContainerRef.current?.scrollIntoView({ block: "center" });
          vv?.removeEventListener("resize", onResize!);
        };
        vv.addEventListener("resize", onResize);
        timeout = setTimeout(() => {
          vv?.removeEventListener("resize", onResize!);
        }, 1500);
      }
    }
    return () => {
      cancelAnimationFrame(raf);
      if (vv && onResize) vv.removeEventListener("resize", onResize);
      if (timeout) clearTimeout(timeout);
    };
  }, [editing, wide]);

  // ── outbox reconciliation ────────────────────────────────────────────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row" || op.target.rowKind !== "tn" || op.target.book !== book) {
          return;
        }
        if (result.kind === "ok") {
          setChapterLock(null);
          return;
        }
        if (result.kind === "locked") {
          setChapterLock(result.lockBody);
          return;
        }
        // Only a settled conflict is a question for the user: the outbox
        // auto-heals the healable ones and still notifies listeners.
        if (result.kind === "conflict" && op.status === "conflict") {
          setConflictNotice(t("flowTranslate.conflictNotice"));
        }
      }),
    [book, t],
  );

  // ── scripture context ────────────────────────────────────────────────────
  const sourceByVerse = data?.verses?.UHB ?? data?.verses?.UGNT;
  const sourceIndex = useMemo(() => buildVerseIndex(sourceByVerse), [sourceByVerse]);
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);

  const hebrew = isHebrewBook(book);
  const sourceLabel = hebrew ? t("flowTranslate.hebrew") : t("flowTranslate.greek");
  const sourceDir: "ltr" | "rtl" = hebrew ? "rtl" : "ltr";

  // A multi-verse note (ref_raw bridged, e.g. "13:26-27") must show the source
  // and ULT/UST text of every verse it covers, not just its leading verse — the
  // single-verse `Index[row.verse]` lookup silently dropped the rest (issue
  // #341). `noteCoveredVerses` returns `[row.verse]` for the common singleton
  // (and for intro rows), so those lanes are unchanged.
  const coveredVerses = useMemo(() => (row ? noteCoveredVerses(row) : []), [row]);
  // A free-text `ref_raw` typo like "1:1-200" would paint the whole chapter into
  // BOTH lanes of one card (issue #385). Clamp what a single card renders to a
  // sane number of verses — real bridged notes span a handful — without touching
  // NOTE_SPAN_CAP or the lock/checkoff paths that key off the full covered list.
  const renderCovered = useMemo(() => clampCoveredForRender(coveredVerses), [coveredVerses]);
  const ultLane = useMemo(
    () => coveredLaneSlices(ultIndex, sourceIndex, renderCovered.verses),
    [ultIndex, sourceIndex, renderCovered.verses],
  );
  const ustLane = useMemo(
    () => coveredLaneSlices(ustIndex, sourceIndex, renderCovered.verses),
    [ustIndex, sourceIndex, renderCovered.verses],
  );
  const ultText = ultLane.plainText;
  const ustText = ustLane.plainText;
  // The source ULT lane rides the same slice/highlight pipeline: en_ult is
  // aligned to the same UHB/UGNT the note's quote is in, so the quote lights
  // up in the English text exactly as it does in the project lanes.
  const sourceUltIndex = useMemo(() => buildVerseIndex(sourceUlt.verses), [sourceUlt.verses]);
  const sourceUltLane = useMemo(
    () => coveredLaneSlices(sourceUltIndex, sourceIndex, renderCovered.verses),
    [sourceUltIndex, sourceIndex, renderCovered.verses],
  );
  const sourceUltText = sourceUltLane.plainText;

  // The mockup highlights the note's phrase inside both scripture lanes. The
  // phrase is derived from the row's original-language quote through the same
  // alignment lookup the classic editor highlights with — never guessed.
  //
  // Marking is PER TOKEN (issue #323), like the classic surfaces: the lane text
  // is rendered from the verse tree and every `\w` token whose
  // `text|occurrence` key is highlighted gets its own <mark>. The old
  // contiguous-substring search over plain_text highlighted nothing when the
  // matched words scattered, and hit the wrong instance for occurrence > 1.
  //
  // Across a bridged note's span each verse is highlighted on its own —
  // occurrence numbers are per verse, so one combined tree double-marks tokens
  // that share a surface form across the boundary (#344 review).
  const rowQuote = row?.quote ?? null;
  const rowOccurrence = row?.occurrence ?? 1;
  const ultSegments = useMemo(
    () => flowLaneSegmentsAcross(ultLane.slices, rowQuote, rowOccurrence),
    [ultLane, rowQuote, rowOccurrence],
  );
  const ustSegments = useMemo(
    () => flowLaneSegmentsAcross(ustLane.slices, rowQuote, rowOccurrence),
    [ustLane, rowQuote, rowOccurrence],
  );
  const sourceUltSegments = useMemo(
    () => flowLaneSegmentsAcross(sourceUltLane.slices, rowQuote, rowOccurrence),
    [sourceUltLane, rowQuote, rowOccurrence],
  );

  const mark = useCallback(
    (segments: FlowSegment[]): ReactNode => {
      if (segments.length === 0) return null;
      // Plain strings need no key; only the element nodes are keyed.
      return segments.map((seg, i) => {
        // A verse-boundary marker in a multi-verse lane (#387): render it as
        // non-scripture chrome — a muted superscript verse number in the UI
        // font — with `unicode-bidi: isolate` so its Latin digits don't disturb
        // the surrounding RTL scripture, and `role="img"` + a translated
        // aria-label so a screen reader announces "Verse N" once instead of
        // reading the raw `¦N` as part of the verse.
        if (seg.kind === "verseMarker") {
          return (
            <Box
              key={i}
              component="sup"
              role="img"
              aria-label={t("flowScripture.verseBoundary", { verse: seg.verse })}
              sx={{
                fontFamily: (theme) => theme.typography.fontFamily,
                fontSize: "0.72em",
                fontWeight: 700,
                color: "text.secondary",
                mx: "0.3em",
                unicodeBidi: "isolate",
                userSelect: "none",
              }}
            >
              {seg.verse}
            </Box>
          );
        }
        return seg.marked ? (
          <Box
            key={i}
            component="mark"
            sx={{ background: HL, color: "inherit", borderRadius: "3px", paddingInline: "2px" }}
          >
            {seg.text}
          </Box>
        ) : (
          seg.text
        );
      });
    },
    [HL, t],
  );

  const englishNote = row ? (sourceNotes.get(row.id)?.note ?? null) : null;

  // ── navigation between cards ─────────────────────────────────────────────
  const nextUnstatused = useCallback(
    (from: number, table: Record<string, CardStatus>): number => {
      if (!queueIds) return -1;
      if (typeFilter) {
        // Same cycle — start just after `from`, wrap, check `from` itself
        // last — restricted to the filtered index list.
        const n = visibleIdx.length;
        if (n === 0) return -1;
        const after = visibleIdx.findIndex((i) => i > from);
        const start = after < 0 ? 0 : after;
        for (let k = 0; k < n; k++) {
          const idx = visibleIdx[(start + k) % n];
          if (!table[queueIds[idx]]) return idx;
        }
        return -1;
      }
      for (let i = 1; i <= queueIds.length; i++) {
        const idx = (from + i) % queueIds.length;
        if (!table[queueIds[idx]]) return idx;
      }
      return -1;
    },
    [queueIds, typeFilter, visibleIdx],
  );

  const advanceAfter = useCallback(
    (id: string, next: CardStatus) => {
      if (!queueIds) return;
      const table = { ...statuses, [id]: next };
      if (reviewing) {
        if (typeFilter) {
          const nxt = visibleIdx.find((i) => i > cursor);
          if (nxt === undefined) setView("done");
          else setCursor(nxt);
          return;
        }
        if (cursor >= queueIds.length - 1) setView("done");
        else setCursor(cursor + 1);
        return;
      }
      const nxt = nextUnstatused(cursor, table);
      if (nxt === -1) {
        // Filtered set exhausted while the wider chapter still has open
        // cards: hold position rather than show the (untrue) chapter-complete
        // view. Without a filter this condition is never taken.
        if (typeFilter && queueIds.some((qid) => !table[qid])) return;
        setView("done");
      } else setCursor(nxt);
    },
    [queueIds, statuses, reviewing, cursor, nextUnstatused, typeFilter, visibleIdx],
  );

  // Free navigation — one cursor, four drivers: the card stack's Prev/Next,
  // the topbar chevrons, list-row clicks (md+), and touch swipes. With a type
  // filter active, movement maps through visibleIdx; without one, the
  // original clamp arithmetic runs untouched.
  const goPrev = useCallback(() => {
    if (!typeFilter) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    setCursor((c) => {
      let target = c;
      for (const i of visibleIdx) {
        if (i >= c) break;
        target = i;
      }
      return target;
    });
  }, [typeFilter, visibleIdx]);
  const goNext = useCallback(() => {
    if (!typeFilter) {
      setCursor((c) => Math.min(total - 1, c + 1));
      return;
    }
    setCursor((c) => visibleIdx.find((i) => i > c) ?? c);
  }, [typeFilter, visibleIdx, total]);

  // Disabled logic for every Prev/Next affordance — reduces to the original
  // expressions (cursor === 0 / cursor >= total - 1) when no filter is active.
  const canPrev = typeFilter ? visibleIdx.some((i) => i < cursor) : cursor > 0;
  const canNext = typeFilter ? visibleIdx.some((i) => i > cursor) : cursor < total - 1;

  // Swipe pages in the TARGET language's reading order (the content being
  // paged), not the UI chrome's — the words screen derives direction the same
  // way. Disabled on the done view: there is no card there to page.
  const targetRtl = projectConfig?.direction === "rtl";
  const swipe = useSwipeNav({
    onPrev: goPrev,
    onNext: goNext,
    enabled: view === "cards" && total > 0 && !focusMode,
    rtl: targetRtl,
  });

  // ── writes ───────────────────────────────────────────────────────────────
  // Save-then-validate, in that order and awaited: /validate does not carry a
  // version, so a PATCH that landed after it would demote the row straight back
  // to 'edited' server-side. The outbox stays the only thing that talks to
  // /api/rows — we just wait for its result before approving.
  async function saveDraft(target: TnRow): Promise<boolean> {
    const patch = { note: draftValue };
    const baseline = { note: baselineRef.current };
    applyLocalRowPatch("tn", target.id, patch as Partial<TnRow & TqRow>);
    const op = await outbox.enqueueRow("tn", target.id, target.version, patch, { book, baseline });
    const result = await waitForOp(op.id);
    if (result === null) {
      say(t("flowTranslate.queuedNotConfirmed"));
      return false;
    }
    if (result.kind !== "ok") {
      if (result.kind === "conflict") {
        setConflictNotice(t("flowTranslate.conflictNotice"));
      } else if (result.kind === "locked") {
        setChapterLock(result.lockBody);
        say(t("flowTranslate.lockedEditDropped"));
      } else {
        say(t("flowTranslate.saveFailed", { reason: result.reason }));
      }
      return false;
    }
    baselineRef.current = draftValue;
    setEditedIds((prev) => new Set(prev).add(target.id));
    // Mirror the server's demotion locally so the row object stays consistent
    // with what a refetch will report: a content edit demotes an AI draft or a
    // previously-validated target row to 'edited' (see the CASE in
    // api/src/rows.ts — English-root rows with a NULL state are left untouched,
    // so we must not invent an 'edited' state for them). The Pending chip itself
    // is driven by editedIds too, so it shows this session regardless; this keeps
    // translation_state honest for genuine target rows across a refetch.
    if (target.translation_state === "ai_draft" || target.translation_state === "validated") {
      applyLocalRowPatch("tn", target.id, { translation_state: "edited" } as Partial<
        TnRow & TqRow
      >);
    }
    // Saving without approving demotes the row, so drop any prior Approved status.
    setStatuses((prev) => {
      if (prev[target.id] === undefined) return prev;
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    return true;
  }

  async function handleApprove() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (hasDiff && !(await saveDraft(row))) return;
      const updated = await api.validateNote(row.id, book, true);
      applyLocalRowReplacement("tn", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "approved" }));
      setEditing(false);
      setToast(t("flowTranslate.toastApproved"));
      advanceAfter(row.id, "approved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say(t("flowTranslate.approveNeedsDraft"));
      } else {
        say(
          t("flowTranslate.approveFailed", {
            status: err instanceof ApiError ? err.status : t("flowTranslate.genericError"),
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // "Save" persists the edit to the server without approving it. Editing a note
  // is not the same as finishing it: a translator can save progress and approve
  // later, and the row then carries the Pending chip. This replaced "Done",
  // which only closed the editor and never touched the server — a close that
  // looked like a save but wasn't.
  async function handleSave() {
    if (!row || busy) return;
    if (!hasDiff) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (await saveDraft(row)) {
        setEditing(false);
        setToast(t("flowTranslate.toastSaved"));
      }
    } finally {
      setBusy(false);
    }
  }

  // "Not needed" is the existing tn soft-trash, relabelled: the card leaves the
  // queue but the row stays recoverable for the team's later review (and the
  // nightly job is what finally tombstones it).
  async function handleNotNeeded() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.trashNote(row.id, book);
      applyLocalRowReplacement("tn", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "skipped" }));
      setEditing(false);
      // A trashed row must not leave an orphan draft behind (#349), and must
      // not keep showing the user's discarded text if advanceAfter holds
      // position (type filter exhausted). Snap both the editor value and the
      // baseline to server truth — the same derivation the hydration effect
      // uses — so hasDiff drops, the current-row chip reads "Not needed"
      // instead of "Edited", and there's no stale-closure window if the user
      // types while the request is in flight. Also explicitly clear the
      // IndexedDB draft so it stops counting toward the "N unsaved" reminder
      // — the persist effect can't clear it once the cursor advances and
      // re-keys to the next row (the drafts.clear immediately below).
      const next = unescapeNewlines(updated.note);
      setDraftValue(next);
      baselineRef.current = next;
      void drafts.clear(rowKey("tn", book, row.id));
      setToast(t("flowTranslate.toastNotNeeded"));
      advanceAfter(row.id, "skipped");
    } catch (err) {
      say(
        t("flowTranslate.notNeededFailed", {
          status: err instanceof ApiError ? err.status : t("flowTranslate.genericError"),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  const redoBlockedReason = tnRedoBlockedReason(row, book, {
    aiUnavailable,
    noNoteSelected: t("flowTranslate.noNoteSelected"),
    needsSupportRef: t("flowTranslate.redoNeedsSupportRef"),
    needsQuote: t("flowTranslate.redoNeedsQuote"),
  });

  const clearIntroRedoTimer = useCallback(() => {
    if (introRedoTimerRef.current != null) {
      window.clearTimeout(introRedoTimerRef.current);
      introRedoTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearIntroRedoTimer(), [clearIntroRedoTimer]);

  // Settle the in-flight intro Redo only for the job/row we started. Shared by
  // onComplete, a post-start already-terminal check, and the stuck-spinner timeout.
  const settleIntroRedo = useCallback(
    (
      job: { job_id: string; state: string; error_message?: string | null },
      opts?: { timedOut?: boolean },
    ) => {
      const pending = pendingIntroRedoRef.current;
      if (!pending || job.job_id !== pending.jobId) return;
      if (!redoingRef.current && !opts?.timedOut) return;
      clearIntroRedoTimer();
      pendingIntroRedoRef.current = null;
      setIntroRedoRowId(null);
      redoingRef.current = false;
      setRedoing(false);
      if (opts?.timedOut) {
        say(t("flowTranslate.redoTimedOut"), "warning");
        return;
      }
      if (job.state === "done") {
        void drafts.clear(rowKey("tn", book, pending.rowId));
        void refetch().then(() => setReloadNonce((n) => n + 1));
        setToast(t("flowTranslate.toastNewDraft"));
      } else {
        say(
          t("flowTranslate.redoFailed", {
            status: job.error_message ?? job.state,
          }),
        );
      }
    },
    [book, clearIntroRedoTimer, refetch, say, t],
  );

  // Intro Redo lands through the pipeline store (async), not a response body.
  useEffect(
    () =>
      pipelineStore.onComplete((job) => {
        if (job.pipeline_type !== "translate") return;
        settleIntroRedo(job);
      }),
    [settleIntroRedo],
  );

  // Cancel (and dismiss) drop the job from the store WITHOUT a completion event
  // — onComplete only fires on done/failed transitions. Without this the
  //  spinner would sit until the 15-minute timeout (codex P2 on #300).
  useEffect(
    () =>
      pipelineStore.subscribe((list) => {
        const pending = pendingIntroRedoRef.current;
        if (!pending) return;
        const job = list.find((j) => j.job_id === pending.jobId);
        if (job && job.state !== "cancelled") return;
        settleIntroRedo({ job_id: pending.jobId, state: "cancelled" });
      }),
    [settleIntroRedo],
  );

  async function handleRedo() {
    if (!row || !data || redoing || redoBlockedReason) return;
    // settleIntroRedo may run sync on the post-start already-terminal race before React re-renders; a stale false would drop the settle.
    redoingRef.current = true;
    setRedoing(true);
    setNotice(null);
    // Pipeline Redo stays spinning until settleIntroRedo; tn-quick (and any
    // failure / early return) clears it in finally.
    let keepSpinningForPipeline = false;
    try {
      if (tnRedoUsesPipeline(row, book)) {
        // Chapter intros (N:intro → verse 0, chapter ≥ 1) and NT verse notes
        // (tn-quick is Hebrew-only — lib/tnRedo.ts). Book front:intro
        // (chapter 0) is out of scope for this flows screen — startChapter
        // must be positive on the pipeline start route.
        const started = await pipelineStore.start({
          pipelineType: "translate",
          book,
          startChapter: chapter,
          endChapter: chapter,
          sessionKey: getSessionKey(),
          translate: { rowIds: [row.id] },
        });
        pendingIntroRedoRef.current = { jobId: started.jobId, rowId: row.id };
        setIntroRedoRowId(row.id);
        // Close the editor: the incoming draft replaces this row's text, and the
        // lock below keeps it closed until the job settles.
        setEditing(false);
        keepSpinningForPipeline = true;
        clearIntroRedoTimer();
        // Scale the stuck-spinner budget to what start() actually returned. An
        // `already_running` answer means we latched onto a broader in-flight
        // job (chapter-wide, ~1h) instead of a fresh single-row run; the old
        // fixed 15-minute timer misreported that healthy job as a `timeout`
        // failure (#376). A cancel/dismiss still settles early via the store
        // subscriptions; this timer is only the last-resort backstop.
        introRedoTimerRef.current = window.setTimeout(() => {
          settleIntroRedo(
            { job_id: started.jobId, state: "failed", error_message: "timeout" },
            { timedOut: true },
          );
        }, introRedoTimeoutMs(started.status));
        // Race: completion may have fired before the ref was set. If the
        // store already shows a terminal row, settle now instead of spinning.
        const existing = pipelineStore.get(started.jobId);
        if (
          existing &&
          (existing.state === "done" ||
            existing.state === "cancelled" ||
            existing.state === "failed")
        ) {
          settleIntroRedo(existing);
        } else {
          say(t("flowTranslate.redoStarted"), "info");
        }
        return;
      }
      const built = buildTnQuickRequest(row, data);
      if (!built.ok) {
        say(
          built.error.reason === "missing_ult_verse"
            ? t("flowTranslate.noLaneTextForAi", { label: litLabel })
            : built.error.reason === "missing_ust_verse"
              ? t("flowTranslate.noLaneTextForAi", { label: simLabel })
              : // The two unalignable-quote reasons need DIFFERENT copy: the
                // English-path advice ("copy the support phrase") is meaningless
                // for a Hebrew/Greek quote, and the original-language advice is
                // meaningless for an English phrase. This screen used to collapse
                // both onto one diagnostic-only string, leaving the demo surface
                // the only place with no remediation (#360); Shell/ReviewQueue
                // already split them (#346). Both interpolate {{label}} rather
                // than hardcoding "ULT" (#7 — BSOJ/Arabic).
                built.error.reason === "source_quote_not_found"
                ? t("flowTranslate.sourceQuoteNotAligned", { label: litLabel })
                : built.error.reason === "hebrew_not_found"
                  ? t("flowTranslate.quoteNotAligned", { label: litLabel })
                  : t("flowTranslate.redoMissingData"),
        );
        return;
      }
      const res = await api.tnQuick(built.request);
      setDraftValue(res.note);
      setEditing(false);
      setToast(t("flowTranslate.toastNewDraft"));
      if (res.warnings.length > 0) say(res.warnings.join(" "), "info");
    } catch (err) {
      clearIntroRedoTimer();
      pendingIntroRedoRef.current = null;
      setIntroRedoRowId(null);
      const code =
        err instanceof ApiError && err.body && typeof err.body === "object" && "error" in err.body
          ? String((err.body as { error?: unknown }).error)
          : "";
      if (redoErrorIsAiUnconfigured(code)) {
        // Calm and specific: this workspace simply has no AI drafting yet. This
        // is the ONE case that greys Redo permanently — it's genuinely not set
        // up and won't be mid-session. Nothing else on the screen is affected.
        setAiUnavailable(t("flowTranslate.aiUnavailable"));
      } else {
        // Everything else — including a bare 503/502 from an overloaded bot or a
        // relayed Anthropic overload — is TRANSIENT. Surface a retryable notice
        // and leave Redo enabled. Latching aiUnavailable on a bare 503 here used
        // to disable Redo for the whole session on a single upstream hiccup,
        // with only a faint caption to explain it (the "greyed out and nothing
        // happened" report). Carry the bot's error code with the status so a
        // 503 reads as "503 uhb_missing_for_verse", not a bare number — the
        // bare number is what kept the NT-verse case undiagnosed.
        say(
          t("flowTranslate.redoFailed", {
            status:
              err instanceof ApiError
                ? code
                  ? `${err.status} ${code}`
                  : err.status
                : t("flowTranslate.genericError"),
          }),
        );
      }
    } finally {
      if (!keepSpinningForPipeline) {
        redoingRef.current = false;
        setRedoing(false);
      }
    }
  }

  function reloadRow() {
    setConflictNotice(null);
    void refetch().then(() => setReloadNonce((n) => n + 1));
  }

  // ── render gates (every hook above this line, unconditionally) ───────────
  if (status === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="error">{t("flowTranslate.loadFailed", { book, chapter })}</Alert>
      </Box>
    );
  }
  if (!data || !queueIds) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
        <CircularProgress />
      </Stack>
    );
  }

  const done = view === "done";
  const approvedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && !editedIds.has(id),
  ).length;
  const editedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && editedIds.has(id),
  ).length;
  const skippedCount = queueIds.filter((id) => statuses[id] === "skipped").length;

  const aiDrafted = row?.translation_state === "ai_draft" || row?.latest_source === "ai_pipeline";
  // Aquifer-imported rows land as ai_draft with draft_meta_json.source==="aquifer".
  // They are neither AI-bot drafts nor human drafts — surface their provenance so
  // the header and chips don't mislabel them "DRAFT · AI" (issue #295).
  const isAquiferDraft = row?.translation_state === "ai_draft" && isAquiferDraftRow(row);

  // Label copy for a resolved chip status, tn's wording. Precedence itself lives
  // in resolveFlowChipStatus (#348) — this only maps status → tn label. tn does
  // not distinguish an AI draft, so aiDraft/draft share the "draft" label; tn is
  // the only screen with a "skipped" (Not needed) verdict.
  const noteChipLabel = (status: FlowChipStatus): string => {
    switch (status) {
      case "editing":
        return t("flowTranslate.status.edited");
      case "unsaved":
        return t("flowTranslate.status.unsaved");
      case "approved":
        return t("flowTranslate.status.approved");
      case "skipped":
        return t("flowTranslate.notNeeded");
      case "pending":
        return t("flowTranslate.status.pending");
      case "aquifer":
        return t("flowTranslate.status.aquiferImport");
      case "aiDraft":
      case "draft":
        return t("flowTranslate.status.draft");
    }
  };
  // The one chip resolver for tn rows — card (isCurrent) and list-row alike.
  // Unsaved text wins over any saved verdict (#342): the open card by its live
  // diff, every other row by whether a draft is persisted for it.
  const noteChip = (
    id: string,
    r: TnRow,
    isCurrent: boolean,
  ): { kind: FlowStatusKind; label: string } => {
    const st = statuses[id];
    const status = resolveFlowChipStatus({
      isCurrent,
      hasLiveDiff: hasDiff,
      draftPresent: draftRowIds.has(id),
      approved: st === "approved",
      skipped: st === "skipped",
      pending: editedIds.has(id) || r.translation_state === "edited",
      aquifer: r.translation_state === "ai_draft" && isAquiferDraftRow(r),
      aiDrafted: false,
    });
    return { kind: flowChipKind(status), label: noteChipLabel(status) };
  };
  const chip: { kind: FlowStatusKind; label: string } = row
    ? noteChip(row.id, row, true)
    : { kind: "draft", label: t("flowTranslate.status.draft") };
  const nextChapter = chapter + 1;
  const hasNextChapter = chapterCount === null ? true : nextChapter <= chapterCount;

  const sub = translationMode
    ? t("flowTranslate.subtitleTranslation", {
        book,
        chapter,
        source: (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase(),
        target: targetLabel,
      })
    : t("flowTranslate.subtitle", { book, chapter, target: targetLabel });

  // "N of M" — while a type filter is active, position and count are within
  // the filtered set and the type label is appended ("3 of 12 · metaphor");
  // with no filter this is character-for-character the original string.
  const filteredPos = typeFilter ? visibleIdx.indexOf(cursor) : -1;
  const headerCount = typeFilter
    ? t("flowTranslate.pagerOfType", {
        index: done
          ? visibleIdx.length
          : visibleIdx.length === 0
            ? 0
            : Math.max(1, filteredPos + 1),
        total: visibleIdx.length,
        type: typeLabelOf(typeFilter),
      })
    : done
      ? t("flowTranslate.pagerOf", { index: total, total })
      : t("flowTranslate.pagerOf", { index: Math.min(cursor + 1, total), total });

  // The current card's article type (detail header pill).
  const rowTypeSlug = row ? typeSlugOf(row.support_reference) : null;

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
      : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
    paddingBlock: 1.75,
    paddingInline: 2,
    textAlign: "start" as const,
  };

  const labelSx = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    fontSize: "0.6875rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    mb: 1,
  };

  // Quiet read-only pill naming the note's tA article type ("metaphor",
  // "merism", …). Full slug rides the title attribute. Muted chip language
  // (skip.soft/skip.ink) — deliberately NOT a FlowStatusChip: this is
  // classification, not status. textTransform/letterSpacing are reset so the
  // pill reads normally inside the uppercase labelSx header row.
  const typePill = (slug: string) => (
    <Box
      component="span"
      title={slug}
      sx={{
        flex: "none",
        maxWidth: 120,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        bgcolor: skip.soft,
        color: skip.ink,
        borderRadius: 999,
        fontSize: "0.6875rem",
        fontWeight: 600,
        lineHeight: 1.6,
        paddingInline: 1,
        paddingBlock: 0.25,
        textTransform: "none",
        letterSpacing: 0,
      }}
    >
      {typeLabelOf(slug)}
    </Box>
  );

  // Compact article-type filter — list-pane header on wide, above the cards
  // on phone. Options are the types present in this chapter's queue, with
  // counts. data-no-swipe: a drag on the select must never page the queue.
  const typeFilterControl =
    typeOptions.length > 0 ? (
      <Box data-no-swipe>
        <Select
          size="small"
          fullWidth
          displayEmpty
          value={typeFilter ?? ""}
          onChange={(e) => {
            const v = e.target.value as string;
            setTypeFilter(v === "" ? null : v);
          }}
          aria-label={t("flowTranslate.filterAria")}
          sx={{ borderRadius: "10px", fontSize: "0.875rem", bgcolor: "background.paper" }}
        >
          <MenuItem value="">{t("flowTranslate.allTypes")}</MenuItem>
          {typeOptions.map((o) => (
            <MenuItem key={o.slug} value={o.slug} title={o.slug}>
              {o.label} ({o.count})
            </MenuItem>
          ))}
        </Select>
      </Box>
    ) : null;

  // Everything inside the reading column — identical at every width; only the
  // container differs (phone: the centred column; md+: the detail pane).
  const detailBody = (
    <>
        {chapterLock && (
          // Informational only: tn PATCH is lock-exempt and /validate + /trash
          // have no lock check, so nothing on this screen is blocked.
          <LockBanner
            pipelineType={chapterLock.pipelineType}
            startedAt={chapterLock.startedAt}
          />
        )}

        {conflictNotice && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={reloadRow}>
                {t("flowTranslate.reloadNote")}
              </Button>
            }
          >
            {conflictNotice}
          </Alert>
        )}

        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

        {total === 0 ? (
          <Alert severity="info">{t("flowTranslate.noNotesInChapter", { book, chapter })}</Alert>
        ) : done ? (
          <Box sx={{ ...cardSx, textAlign: "center", paddingBlock: 4.5 }}>
            <Box
              component="svg"
              width="96"
              height="96"
              viewBox="0 0 96 96"
              aria-hidden="true"
              sx={{ mx: "auto", display: "block" }}
            >
              <circle cx="48" cy="48" r="46" fill={ok.soft} />
              <circle cx="48" cy="48" r="36" fill={ok.main} />
              <path
                d="M33 49 L44 60 L64 37"
                fill="none"
                stroke="#fff"
                strokeWidth="6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Box>
            <Typography component="h2" sx={{ fontSize: "1.375rem", fontWeight: 700, mt: 1.5 }}>
              {t("flowTranslate.chapterComplete", { book, chapter })}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t("flowTranslate.doneSummary", {
                approved: approvedCount,
                edited: editedCount,
                skipped: skippedCount,
              })}
            </Typography>
            <Stack spacing={1}>
              <Button
                variant="contained"
                disabled={!hasNextChapter}
                onClick={() => {
                  location.hash = `#/notes/${book}/${nextChapter}`;
                }}
                sx={{
                  minHeight: 52,
                  borderRadius: "12px",
                  fontWeight: 700,
                  bgcolor: INSPIRE,
                  color: "#06293B",
                  "&:hover": { bgcolor: INSPIRE_DEEP },
                }}
              >
                {hasNextChapter
                  ? t("flowTranslate.continueToChapter", { chapter: nextChapter })
                  : t("flowTranslate.bookComplete", { book, chapter: nextChapter })}
              </Button>
              <Button
                onClick={() => {
                  setReviewing(true);
                  setCursor(0);
                  setView("cards");
                }}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                {t("flowTranslate.reviewAgain")}
              </Button>
            </Stack>
          </Box>
        ) : typeFilter && visibleIdx.length === 0 ? (
          <Alert severity="info">
            {t("flowTranslate.noTypeNotesKeepGoing", {
              type: typeLabelOf(typeFilter),
              book,
              chapter,
              allTypes: t("flowTranslate.allTypes"),
            })}
          </Alert>
        ) : !row ? (
          <Box sx={cardSx}>
            <Typography variant="body2" color="text.secondary">
              {t("flowTranslate.rowGone")}
            </Typography>
            <Button
              sx={{ mt: 1 }}
              onClick={() => setCursor((c) => Math.min(c + 1, total - 1))}
              disabled={cursor >= total - 1}
            >
              {t("flowTranslate.nextNote")}
            </Button>
          </Box>
        ) : (
          <>
            {/* original-language quote strip */}
            {row.quote && (
              <Stack direction="row" alignItems="baseline" spacing={1.25} sx={{ paddingInline: 0.25 }}>
                <Typography
                  component="p"
                  sx={{
                    flex: "none",
                    fontSize: "0.656rem",
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "text.secondary",
                    m: 0,
                  }}
                >
                  {sourceLabel}
                </Typography>
                <Typography
                  component="p"
                  dir={sourceDir}
                  sx={{
                    fontFamily: SCRIPTURE_FONT_STACK,
                    fontSize: "1.0625rem",
                    m: 0,
                    minWidth: 0,
                    textAlign: "start",
                  }}
                >
                  {row.quote}
                </Typography>
              </Stack>
            )}

            {/* scripture */}
            <Box sx={cardSx}>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                <Typography
                  sx={{ fontSize: "0.875rem", fontWeight: 700, color: REF_COLOR, flex: 1, minWidth: 0 }}
                >
                  {row.verse === 0
                    ? t("flowTranslate.introRefLong", { book, chapter: row.chapter })
                    : // `ref_raw` ("13:26" or bridged "13:26-27") is the authoritative
                      // reference and the only place a note's range lives (tn_rows has
                      // no verse_end); render it like the classic NoteCard, but only
                      // when it names the span the lanes actually show — see
                      // noteRefLabel. (issue #341)
                      `${book} ${noteRefLabel(row)}`}
                </Typography>
                {sourceUltAvailable && (
                  // Toggle for the source ULT lane (#430). A pressed chip rather
                  // than a Switch: it sits in the card header next to the
                  // reference, and its label IS the lane label it reveals.
                  <Chip
                    size="small"
                    clickable
                    variant={showSourceUlt ? "filled" : "outlined"}
                    color={showSourceUlt ? "primary" : "default"}
                    label={sourceUltLabel}
                    aria-pressed={showSourceUlt}
                    aria-label={t("flowTranslate.toggleSourceUlt", { label: sourceUltLabel })}
                    onClick={() => setShowSourceUlt(!showSourceUlt)}
                    sx={{ flex: "none", fontWeight: 700, letterSpacing: "0.04em" }}
                  />
                )}
              </Stack>
              {sourceUltOn &&
                (sourceUlt.status === "ready" && sourceUltText ? (
                  <Lane
                    label={sourceUltLabel}
                    text={sourceUltText}
                    segments={sourceUltSegments}
                    labelFontFamily={theme.typography.fontFamily}
                    mark={mark}
                  />
                ) : (
                  // Not the Lane's own empty state: that copy talks about an
                  // undrafted TARGET lane "in this workspace", which is the wrong
                  // story for a published source that simply lacks the verse.
                  <Typography
                    variant="caption"
                    sx={{ display: "block", mb: 1, color: "text.secondary", fontStyle: "italic" }}
                  >
                    {sourceUlt.status === "error"
                      ? t("flowTranslate.sourceLaneUnavailable", { label: sourceUltLabel })
                      : sourceUlt.status === "ready"
                        ? t("flowTranslate.sourceLaneNoVerse", { label: sourceUltLabel })
                        : t("flowTranslate.sourceLaneLoading", { label: sourceUltLabel })}
                  </Typography>
                ))}
              <Lane
                label={litLabel}
                text={ultText}
                segments={ultSegments}
                labelFontFamily={theme.typography.fontFamily}
                mark={mark}
              />
              <Lane
                label={simLabel}
                text={ustText}
                segments={ustSegments}
                labelFontFamily={theme.typography.fontFamily}
                mark={mark}
              />
              {renderCovered.clamped && (
                <Typography
                  variant="caption"
                  sx={{ display: "block", mt: 0.5, color: "text.secondary", fontStyle: "italic" }}
                >
                  {t("flowTranslate.laneClampHint", {
                    shown: renderCovered.verses.length,
                    total: renderCovered.total,
                  })}
                </Typography>
              )}
            </Box>

            {(() => {
              // Intro notes (row.verse === 0) render the source + target cards
              // side-by-side on wide screens, mirroring the tA/tW article
              // editor's responsive split (ArticleWorkspace.tsx); per-verse
              // notes keep the original vertical stack (a fragment — no extra
              // DOM node, so their layout is untouched). The grid's column
              // order follows the document direction, so this is RTL-safe.
              const englishSourceCard = (
            /* English source note */
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                {t("flowTranslate.englishNote")}
              </Typography>
              {englishNote ? (
                <Typography
                  sx={{ fontSize: "0.97rem", lineHeight: 1.55, whiteSpace: "pre-wrap" }}
                >
                  {unescapeNewlines(englishNote)}
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {translationMode
                    ? sourceProjection
                      ? t("flowTranslate.noSourceForNote")
                      : t("flowTranslate.noSourceRepo")
                    : t("flowTranslate.authoringWorkspace")}
                </Typography>
              )}
            </Box>
              );
              const targetDraftCard = (
            /* target draft — the centrepiece */
            <Box ref={editorContainerRef} sx={cardSx}>
              {/* component="div", not "p": this header nests a flex <Box> (the
                  type pill + FlowStatusChip, an MUI Chip = <div>), and a <div>
                  is invalid inside a <p> (validateDOMNesting warning; #336).
                  The sibling <span>-only headers stay as-is. */}
              <Typography component="div" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                {isAquiferDraft
                  ? t("flowTranslate.targetDraftAquifer", { target: targetLabel })
                  : aiDrafted
                    ? t("flowTranslate.targetDraftAi", { target: targetLabel })
                    : t("flowTranslate.targetDraft", { target: targetLabel })}
                <Box sx={{ ml: "auto", display: "flex", alignItems: "center", gap: 0.75 }}>
                  {/* read-only article type — classification, not a verb */}
                  {rowTypeSlug && typePill(rowTypeSlug)}
                  <FlowStatusChip kind={chip.kind} label={chip.label} />
                </Box>
              </Typography>

              {editing ? (
                <>
                  <TextField
                    inputRef={editorInputRef}
                    multiline
                    fullWidth
                    minRows={4}
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    // Direction follows the *content*, not the project language:
                    // dir="auto" lets first-strong-character detection pick RTL for
                    // genuine Arabic and LTR for English placeholder text, so LTR
                    // content in an RTL-target project no longer bidi-mangles (#256).
                    // Never an sx `direction` (stylis inverts it under an RTL UI; PR #53).
                    disabled={editLocked}
                    inputProps={{ dir: "auto" }}
                    sx={{
                      "& .MuiOutlinedInput-root": {
                        bgcolor: "action.hover",
                        borderRadius: "9px",
                        fontSize: "0.97rem",
                        lineHeight: 1.55,
                      },
                      "& .MuiOutlinedInput-notchedOutline": {
                        borderWidth: "1.5px",
                        borderColor: INSPIRE,
                      },
                    }}
                  />
                  <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
                    <Button
                      disabled={busy || redoing}
                      onClick={() => void handleSave()}
                      startIcon={<SaveIcon />}
                      sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                    >
                      {t("flowTranslate.save")}
                    </Button>
                  </Stack>
                </>
              ) : (
                <>
                  <Box
                    role="button"
                    tabIndex={0}
                    // dir follows the *content* (dir="auto") so a genuinely Arabic
                    // draft renders RTL while English placeholder text renders LTR
                    // instead of bidi-mangling (see the editor TextField above; #256).
                    dir="auto"
                    onClick={() => {
                      if (!editLocked) setEditing(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (!editLocked) setEditing(true);
                      }
                    }}
                    sx={{
                      cursor: editLocked ? "default" : "text",
                      borderRadius: "6px",
                      paddingBlock: 0.25,
                      paddingInline: 0.5,
                      marginBlock: -0.25,
                      marginInline: -0.5,
                      fontSize: "0.97rem",
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                      textAlign: "start",
                      "&:hover": { background: HL },
                    }}
                  >
                    {draftValue.trim().length > 0 ? (
                      draftValue
                    ) : (
                      <Box component="em" sx={{ color: "text.secondary" }}>
                        {t("flowTranslate.emptyDraftTap", { target: targetLabel })}
                      </Box>
                    )}
                  </Box>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                    {t("flowTranslate.tapToEdit")}
                  </Typography>
                </>
              )}

              {aiUnavailable && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                  {aiUnavailable}
                </Typography>
              )}
            </Box>
              );
              return row.verse === 0 ? (
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
                    gap: 1.5,
                    alignItems: "start",
                  }}
                >
                  {englishSourceCard}
                  {targetDraftCard}
                </Box>
              ) : (
                <>
                  {englishSourceCard}
                  {targetDraftCard}
                </>
              );
            })()}

            {/* previous / next — hidden in phone focus mode (keyboard-up
                editing) so the editor gets the room */}
            {!focusMode && (
              <Stack direction="row" justifyContent="space-between" spacing={1.25}>
                <Button
                  startIcon={<ChevronLeftIcon />}
                  disabled={!canPrev}
                  onClick={goPrev}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  {t("flowTranslate.previous")}
                </Button>
                <Button
                  endIcon={<ChevronRightIcon />}
                  disabled={!canNext}
                  onClick={goNext}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  {t("flowTranslate.next")}
                </Button>
              </Stack>
            )}
          </>
        )}
    </>
  );

  // List preview: first non-empty line, with markdown chrome stripped (leading
  // #s, ** pairs) so intro notes don't read "# Zechariah 1 General Notes".
  const previewLine = (raw: string): string =>
    (raw.split("\n").find((l) => l.trim()) ?? "")
      .replace(/^#{1,6}\s*/, "")
      .replace(/\*\*/g, "")
      .trim();

  // One list-pane row (md+ only): verse ref · one-line preview · status chip.
  // Selecting a row moves the SAME cursor the phone's Prev/Next drives.
  const listRow = (id: string, idx: number) => {
    const r = rowById.get(id);
    if (!r) {
      return (
        <Box key={id} sx={{ ...cardSx, opacity: 0.72, paddingBlock: 1.25 }}>
          <Typography variant="body2" color="text.secondary">
            {t("flowTranslate.rowGoneShort")}
          </Typography>
        </Box>
      );
    }
    const typeSlug = typeSlugOf(r.support_reference);
    // Same resolver as the card (#348): unsaved text (the open card's live diff,
    // or a persisted draft on any other row) is checked ahead of the
    // approved/skipped verdicts, so it's never hidden behind "Approved".
    const rowChip = noteChip(id, r, id === currentId);
    const isSelected = !done && idx === cursor;
    // Preview the TARGET text — what the translator wrote (their live draft
    // for the open card, else the row's saved note), falling back to the
    // English source note. NEVER the quote: Hebrew/Greek in a one-line
    // preview reads as noise (2026-08-10 markup round).
    const targetText = id === currentId ? draftValue : unescapeNewlines(r.note);
    const sourceNote = sourceNotes.get(id)?.note;
    const preview =
      previewLine(targetText) || (sourceNote ? previewLine(unescapeNewlines(sourceNote)) : "");
    return (
      <Box
        key={id}
        component="button"
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => {
          setCursor(idx);
          setView("cards");
        }}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          width: "100%",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          paddingBlock: 1.25,
          ...(isSelected
            ? { borderColor: INSPIRE, bgcolor: alpha(INSPIRE, dark ? 0.12 : 0.06) }
            : {}),
          "&:hover": { borderColor: INSPIRE },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>
            {r.verse === 0
              ? t("flowTranslate.introRef", { chapter: r.chapter })
              : // Same range-aware label as the card's chip, so a bridged row
                // reads "13:26-27" in the list too (#344 review).
                noteRefLabel(r)}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            dir="auto"
            sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {preview || t("flowTranslate.nothingDrafted")}
          </Typography>
        </Box>
        {typeSlug && typePill(typeSlug)}
        <FlowStatusChip kind={rowChip.kind} label={rowChip.label} />
        <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary", flex: "none" }} />
      </Box>
    );
  };

  // Action bar — the three verbs. Phone: fixed to the viewport bottom; md+:
  // anchored inside the detail pane (sticky at its bottom, pinned there by
  // margin-block-start:auto when the content is short — the words screen's
  // pane pattern).
  const actionBar =
    !done && total > 0 && row ? (
        <Box
          component="footer"
          // Guard the verbs from the swipe surface: a horizontal drag that
          // starts on Approve / Not needed / Redo must never page the queue.
          data-no-swipe
          sx={
            wide
              ? {
                  position: "sticky",
                  insetBlockEnd: 0,
                  zIndex: 10,
                  marginBlockStart: "auto",
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
              : {
                  position: "fixed",
                  insetBlockEnd: 0,
                  insetInline: 0,
                  zIndex: theme.zIndex.appBar,
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
          }
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              maxWidth: wide ? "none" : COLUMN_PX,
              mx: "auto",
              paddingInline: wide ? 2.5 : 2,
              paddingBlockStart: 1.5,
              paddingBlockEnd: wide ? 1.5 : "calc(12px + env(safe-area-inset-bottom))",
            }}
          >
            <Button
              variant="outlined"
              disabled={redoBlockedReason !== null || redoing || busy}
              title={redoBlockedReason ?? t("flowTranslate.redoTooltip")}
              onClick={() => void handleRedo()}
              startIcon={
                <AutoAwesomeIcon
                  sx={
                    redoing
                      ? { animation: "be-spin 0.8s linear infinite", "@keyframes be-spin": { to: { transform: "rotate(360deg)" } } }
                      : undefined
                  }
                />
              }
              sx={{
                flex: 1,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                color: ACCENT,
                borderColor: INSPIRE,
                borderWidth: "1.5px",
              }}
            >
              {t("flowTranslate.redo")}
            </Button>
            <Button
              disabled={busy || redoing}
              onClick={() => void handleNotNeeded()}
              sx={{
                flex: 1,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                bgcolor: skip.soft,
                color: skip.ink,
                "&:hover": { bgcolor: skip.soft },
              }}
            >
              {t("flowTranslate.notNeeded")}
            </Button>
            <Button
              disabled={busy || redoing}
              onClick={() => void handleApprove()}
              startIcon={<CheckIcon />}
              sx={{
                flex: 1.4,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                bgcolor: ok.main,
                color: "#fff",
                "&:hover": { bgcolor: ok.main, filter: "brightness(0.95)" },
              }}
            >
              {t("flowTranslate.saveApprove")}
            </Button>
          </Stack>
        </Box>
    ) : null;

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
      {/* topbar (at md+ the root doesn't scroll, so sticky is simply inert).
          Hidden in phone focus mode — an active edit on a narrow viewport
          gets the keyboard-constrained screen to itself. */}
      {!focusMode && (
      <Box
        sx={{
          position: "sticky",
          insetBlockStart: 0,
          zIndex: 20,
          flex: "none",
          bgcolor: "background.paper",
          borderBlockEnd: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <IconButton
              aria-label={t("flowTranslate.backToPackage", { book })}
              onClick={() => {
                location.hash = `#/package/${book}`;
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                {t("flowTranslate.title")}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {sub}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {headerCount}
            </Typography>
            {/* compact prev/next — same cursor and disabled logic as the card
                stack's Prev/Next; chevrons flip under RTL (the scripture
                screen's scaleX pattern). 2026-08-10 markup round. */}
            <IconButton
              size="small"
              aria-label={t("flowTranslate.previousNote")}
              disabled={done || !canPrev}
              onClick={goPrev}
              sx={{ flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
            <IconButton
              size="small"
              aria-label={t("flowTranslate.nextNote")}
              disabled={done || !canNext}
              onClick={goNext}
              sx={{ flex: "none" }}
            >
              <ChevronRightIcon fontSize="small" sx={chevronFlip} />
            </IconButton>
          </Stack>
          <Box
            sx={{
              height: 4,
              borderRadius: "2px",
              bgcolor: skip.soft,
              mt: 1.25,
              overflow: "hidden",
            }}
          >
            <Box
              sx={{
                height: "100%",
                borderRadius: "2px",
                bgcolor: INSPIRE,
                transition: "width 0.35s ease",
                width: total === 0 ? "0%" : `${(statusedCount / total) * 100}%`,
              }}
            />
          </Box>
        </Box>
      </Box>
      )}

      {wide ? (
        /* desk (the words screen's md+ pattern): 1440px centred grid — the
           note queue as a scrollable list pane on the inline-start side, the
           card stack in a panel-chromed detail pane. Grid column order follows
           the document direction, so this is RTL-safe as-is. */
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
          {/* list pane */}
          <Box
            sx={{
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1.25,
              paddingInline: 0.25,
              paddingBlockEnd: 2,
            }}
          >
            {typeFilterControl}
            {total === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mx: 0.25 }}>
                {t("flowTranslate.noNotesInChapter", { book, chapter })}
              </Typography>
            ) : typeFilter && visibleIdx.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mx: 0.25 }}>
                {t("flowTranslate.noTypeNotes", {
                  type: typeLabelOf(typeFilter),
                  book,
                  chapter,
                })}
              </Typography>
            ) : typeFilter ? (
              visibleIdx.map((i) => listRow(queueIds[i], i))
            ) : (
              queueIds.map(listRow)
            )}
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
            }}
          >
            <Box
              {...swipe}
              sx={{
                height: "100%",
                minHeight: 0,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box
                sx={{
                  width: "100%",
                  flex: "none",
                  paddingInline: 2.5,
                  paddingBlockStart: 2,
                  paddingBlockEnd: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.5,
                }}
              >
                {detailBody}
              </Box>
              {actionBar}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box
          {...swipe}
          sx={{
            maxWidth: COLUMN_PX,
            mx: "auto",
            paddingInline: 2,
            paddingBlockStart: 2,
            // room for the fixed action bar — collapsed in phone focus mode,
            // where the action bar itself is hidden
            paddingBlockEnd: done ? 4 : focusMode ? 2 : 15,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
          }}
        >
          {!done && total > 0 && !focusMode && typeFilterControl}
          {detailBody}
        </Box>
      )}
      {!wide && !focusMode && actionBar}

      <Snackbar
        open={toast !== null}
        message={toast ?? ""}
        autoHideDuration={1400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: 96 }}
      />
    </Box>
  );
}
