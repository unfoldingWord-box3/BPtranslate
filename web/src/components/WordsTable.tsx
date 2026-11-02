import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Chip, InputAdornment, ListItemText, Menu, MenuItem, Paper, Snackbar, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import CenterFocusStrongIcon from "@mui/icons-material/CenterFocusStrong";
import TranslateIcon from "@mui/icons-material/Translate";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import UndoIcon from "@mui/icons-material/Undo";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { TwlRow } from "../sync/api";
import { reconcileField, twlBaseline, twlDiff, type TwlFields } from "../lib/twlRowFields";
import { useRefusedSaveHold } from "../hooks/useRefusedSaveHold";
import { useCatalogs } from "../hooks/useCatalogs";
import { CatalogPicker } from "./CatalogPicker";
import { TwArticleDialog } from "./TwArticleDialog";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";
import { useTranslation } from "react-i18next";

export type WordDropPosition = "before" | "after";

// Mirrors the NoteCard quote-script detector: Hebrew (U+0590–U+05FF) is
// RTL, Greek + Latin are LTR. We only show the translate icon when the
// user has typed English (LTR) into a field that normally holds the
// source-language Hebrew/Greek.
const RTL_CHAR = /[֐-׿]/;
const LTR_CHAR = /[a-zA-ZͰ-Ͽἀ-῿]/;

type QuoteScript = "empty" | "rtl" | "ltr";

function detectQuoteScript(text: string): QuoteScript {
  if (!text.trim()) return "empty";
  if (RTL_CHAR.test(text)) return "rtl";
  if (LTR_CHAR.test(text)) return "ltr";
  return "empty";
}

// Container-query breakpoint: under this table width the quote + TW-article
// columns plus three action buttons get too cramped, so the layout reflows to
// keep the quote inline with the actions and drop the TW article to its own
// full-width row.
const NARROW_BP_PX = 460;

// Transient ring on the arrow a word was just reordered with. Mouse clicks
// don't show a :focus-visible ring, so this is what signals "the word moved
// here, press Enter/Space to keep nudging it." Self-clears via WordsTable state.
const reorderFlashSx = {
  color: "primary.main",
  bgcolor: "primary.50",
  boxShadow: "0 0 0 2px var(--mui-palette-primary-main, #31ADE3)",
  borderRadius: "4px",
} as const;

// Wide: grip, quote, TW article, and three action cells in one row. Narrow
// (container ≤ NARROW_BP_PX): the grip spans both rows on the left, the quote
// (the source words — the content that matters most) gets its own full-width
// row, and the short TW-article chip shares the second row with the action
// buttons. Keeping the quote off the button row stops the save/trash icons
// from crushing the Hebrew when the column is narrow.
const responsiveGridSx = {
  display: "grid",
  columnGap: 1,
  rowGap: 0,
  // Controls share one single-height row; the English gloss is its own row
  // beneath (starting under the quote column) so it never stretches the row
  // and pushes the grip / action icons off-center.
  alignItems: "center",
  // minmax(0, …) on the flexible tracks: a bare `fr` track has a min-content
  // floor, so the TW-article chip's long unbreakable monospace label (e.g.
  // `other/generation-lifetime`) would refuse to shrink and overflow into the
  // save/undo/delete cells. minmax(0, …) lets the track collapse so the chip
  // ellipsis-truncates instead.
  gridTemplateColumns: "28px minmax(0, 1fr) minmax(0, 1.2fr) 28px 28px 28px",
  gridTemplateAreas: [
    '"grip quote twarticle save undo delete"',
    '". gloss gloss gloss gloss gloss"',
  ].join(" "),
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "28px minmax(0, 1fr) 28px 28px 28px",
    gridTemplateAreas: [
      '"grip quote quote quote quote"',
      '"grip twarticle save undo delete"',
      '". gloss gloss gloss gloss"',
    ].join(" "),
    rowGap: 0.5,
  },
} as const;

interface Props {
  rows: TwlRow[];
  activeId: string | null;
  // Manual save: applies + enqueues. No autosave during typing.
  onSave: (id: string, patch: Partial<TwlRow>) => void;
  onDelete: (id: string) => void;
  onFocus: (row: TwlRow) => void;
  onReorder: (draggedId: string, refId: string, position: WordDropPosition) => void;
  // Hover a row's "locate" spot to preview where its word is in the scripture
  // (row id on enter, null on leave). No click / focus change.
  onHoverPreview?: (id: string | null) => void;
  // Chapter has an active AI pipeline. Disables all interaction in this
  // table — TWLs aren't AI-touched, but locking the whole chapter is
  // simpler and avoids partial-edit confusion.
  locked?: boolean;
  // Translate English in the quote field to source-language text via ULT
  // alignment. Returns the derived Hebrew/Greek string, or null if no
  // alignment match was found. Mirrors the NoteCard wiring.
  onTranslateQuote?: (row: TwlRow, english: string) => string | null;
  // Read-only English (ULT) gloss for a row's saved orig_words, derived from
  // alignment. "" when the quote doesn't resolve in the verse. Shell owns the
  // verse objects, so it computes the gloss (mirrors onTranslateQuote wiring).
  onWordGloss?: (row: TwlRow) => string;
  // Quote-builder ("build from source") wiring. Shell owns the picker popup +
  // selection state; the row just opens it. activeQuoteBuildId is the row whose
  // session is open (if any); the count drives that row's button label.
  activeQuoteBuildId?: string | null;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: (id: string) => void;
  // Extra TW article ids the per-verse matcher proposes for a row's source word,
  // keyed by row id — merged into that row's disambiguation badge so a wrong
  // link can reach a morphologically-correct alternative (e.g. other/lover for
  // "lovers"). A stable useMemo ref from Shell, so the memo below can compare it.
  suggestionAlternatives?: Map<string, string[]>;
}

// Reversible kill-switch for the manual TWL reorder gesture. TWL links are now
// ordered CANONICALLY (by the Hebrew/Greek word's position in the aligned ULT —
// see ../lib/twlCanonicalOrder), computed automatically on every surface, so a
// manual drag/arrow reorder of an aligned link would just snap back. We disable
// the gesture rather than delete it: flip this to `true` to fully restore the
// drag grip + up/down arrows (Shell's onWordReorder / reorderSequential are left
// intact and still wired). tn/tq note reordering is unaffected.
const ENABLE_TWL_MANUAL_REORDER = false;

function WordsTableInner({ rows, activeId, onSave, onDelete, onFocus, onReorder, onHoverPreview, locked = false, onTranslateQuote, onWordGloss, activeQuoteBuildId = null, quoteBuildSelectionCount = 0, onStartQuoteBuild, suggestionAlternatives }: Props) {
  const { t } = useTranslation();
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<
    { targetId: string; position: WordDropPosition } | null
  >(null);
  // One TW article popup for the whole table (null = closed); lifted out of the
  // memoized rows so opening it doesn't depend on per-row state.
  const [articleId, setArticleId] = useState<string | null>(null);

  // Arrow-reorder focus + visible hint. React preserves the moved row's keyed
  // DOM node through the reorder, so focus already rides along (Enter/Space
  // repeats the move) — but a mouse click never shows a focus ring, so nobody
  // discovers it. After a reorder we re-assert focus on the moved word's arrow
  // and flash a ring on it so the user sees where the word went and that they
  // can keep nudging it from the keyboard.
  const tableRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<{ id: string; dir: "up" | "down" } | null>(null);
  const [recentMove, setRecentMove] = useState<{ id: string; dir: "up" | "down" } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every commit on purpose: it consumes the focus request the arrow handlers leave in pendingFocusRef and clears it on first read, so the setState fires once per move, never in a loop.
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    const root = tableRef.current;
    if (!root) return;
    const find = (d: "up" | "down") =>
      root.querySelector<HTMLButtonElement>(
        `[data-word-id="${pending.id}"] [data-reorder-arrow="${d}"]`,
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
    setRecentMove({ id: pending.id, dir: pending.dir });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setRecentMove(null), 1600);
  });
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        {t("words.noWordsForVerse")}
      </Typography>
    );
  }
  return (
    <Paper
      ref={tableRef}
      variant="outlined"
      sx={{
        overflow: "hidden",
        containerType: "inline-size",
        ...draftDirtyBorderSx(),
        ...(locked ? { pointerEvents: "none", opacity: 0.6 } : null),
      }}
    >
      <Box
        sx={{
          ...responsiveGridSx,
          px: 1,
          py: 0.5,
          bgcolor: "grey.50",
          fontFamily: "monospace",
          fontSize: 10,
          textTransform: "uppercase",
          color: "text.disabled",
          borderBottom: "1px dashed",
          borderColor: "divider",
          // The column labels don't map onto the stacked layout, so drop the
          // header band once the rows reflow.
          [`@container (max-width: ${NARROW_BP_PX}px)`]: { display: "none" },
        }}
      >
        <span />
        <span>{t("words.quote")}</span>
        <span>{t("words.twArticle")}</span>
        <span />
        <span />
        <span />
      </Box>
      {rows.map((r) => {
        const showBefore =
          ENABLE_TWL_MANUAL_REORDER &&
          dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "before";
        const showAfter =
          ENABLE_TWL_MANUAL_REORDER &&
          dragId && dragId !== r.id && dragOver?.targetId === r.id && dragOver.position === "after";
        // Arrows reorder within the same verse only — onReorder maps to Shell's
        // sortedForVerse, which renumbers per-verse.
        const samePeers = rows.filter((p) => p.verse === r.verse);
        const idx = samePeers.indexOf(r);
        const prevWord = idx > 0 ? samePeers[idx - 1] : null;
        const nextWord = idx < samePeers.length - 1 ? samePeers[idx + 1] : null;
        return (
          <Box key={r.id}>
            {showBefore && <RowDropIndicator />}
            <WordRow
              row={r}
              active={r.id === activeId}
              dragging={dragId === r.id}
              isDropTarget={dragId !== null && dragId !== r.id}
              onSave={(p) => onSave(r.id, p)}
              onDelete={() => onDelete(r.id)}
              onFocus={() => onFocus(r)}
              onGripDragStart={ENABLE_TWL_MANUAL_REORDER ? () => setDragId(r.id) : undefined}
              onMoveUp={
                ENABLE_TWL_MANUAL_REORDER && prevWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "up" };
                      onReorder(r.id, prevWord.id, "before");
                    }
                  : undefined
              }
              onMoveDown={
                ENABLE_TWL_MANUAL_REORDER && nextWord
                  ? () => {
                      pendingFocusRef.current = { id: r.id, dir: "down" };
                      onReorder(r.id, nextWord.id, "after");
                    }
                  : undefined
              }
              flashArrow={recentMove?.id === r.id ? recentMove.dir : null}
              onHoverPreview={onHoverPreview}
              onDragEnd={() => {
                setDragId(null);
                setDragOver(null);
              }}
              onRowDragOver={(position) => {
                setDragOver((cur) =>
                  cur && cur.targetId === r.id && cur.position === position
                    ? cur
                    : { targetId: r.id, position },
                );
              }}
              onRowDrop={(position) => {
                if (dragId && dragId !== r.id) onReorder(dragId, r.id, position);
                setDragId(null);
                setDragOver(null);
              }}
              onTranslateQuote={
                onTranslateQuote ? (english) => onTranslateQuote(r, english) : undefined
              }
              gloss={onWordGloss ? onWordGloss(r) : ""}
              quoteBuildMode={r.id === activeQuoteBuildId}
              quoteBuildSelectionCount={r.id === activeQuoteBuildId ? quoteBuildSelectionCount : 0}
              onStartQuoteBuild={onStartQuoteBuild ? () => onStartQuoteBuild(r.id) : undefined}
              onOpenArticle={setArticleId}
              suggestionAltIds={(suggestionAlternatives?.get(r.id) ?? []).join(",")}
            />
            {showAfter && <RowDropIndicator />}
          </Box>
        );
      })}
      <TwArticleDialog articleId={articleId} onClose={() => setArticleId(null)} />
    </Paper>
  );
}

// Memoized: a change elsewhere in the resource column (e.g. editing a note)
// leaves `rows`/`activeId` referentially stable — twlForVerse is a useMemo in
// ResourceColumn — so the whole words table skips re-render. Callback props are
// recreated each parent render but are intentionally ignored.
export const WordsTable = memo(
  WordsTableInner,
  (a, b) =>
    a.rows === b.rows &&
    a.activeId === b.activeId &&
    a.locked === b.locked &&
    a.activeQuoteBuildId === b.activeQuoteBuildId &&
    a.quoteBuildSelectionCount === b.quoteBuildSelectionCount &&
    a.suggestionAlternatives === b.suggestionAlternatives,
);

function RowDropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.25,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(49,173,227,0.5)",
      }}
    />
  );
}

const WordRow = memo(function WordRow({
  row,
  active,
  dragging,
  isDropTarget,
  onSave,
  onDelete,
  onFocus,
  onGripDragStart,
  onMoveUp,
  onMoveDown,
  onDragEnd,
  onRowDragOver,
  onRowDrop,
  onTranslateQuote,
  gloss,
  quoteBuildMode = false,
  quoteBuildSelectionCount = 0,
  onStartQuoteBuild,
  onOpenArticle,
  flashArrow,
  onHoverPreview,
  suggestionAltIds = "",
}: {
  row: TwlRow;
  active: boolean;
  dragging: boolean;
  isDropTarget: boolean;
  onSave: (patch: Partial<TwlRow>) => void;
  onDelete: () => void;
  onFocus: () => void;
  // Undefined when the manual reorder gesture is disabled (canonical ordering).
  onGripDragStart?: () => void;
  // Reorder one slot within the verse. Undefined when already first/last, or when
  // the manual reorder gesture is disabled.
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  // The just-reordered arrow to flash a focus ring on ("up"/"down"), or null.
  flashArrow?: "up" | "down" | null;
  // Hover the locate spot to preview the word's scripture highlight (id / null).
  onHoverPreview?: (id: string | null) => void;
  onDragEnd: () => void;
  onRowDragOver: (position: WordDropPosition) => void;
  onRowDrop: (position: WordDropPosition) => void;
  onTranslateQuote?: (english: string) => string | null;
  // Read-only English (ULT) gloss of the saved orig_words; "" when unresolved.
  gloss?: string;
  // "Build from source" picker wiring (Shell owns the popup + selection state).
  quoteBuildMode?: boolean;
  quoteBuildSelectionCount?: number;
  onStartQuoteBuild?: () => void;
  // Open the TW article popup for this row's link (handled at the table level).
  onOpenArticle: (articleId: string) => void;
  // Comma-joined short article ids the matcher proposes for this row's source
  // word, merged into the disambiguation badge. "" when none.
  suggestionAltIds?: string;
}) {
  const { t } = useTranslation();
  const [quote, setQuote] = useState(row.orig_words ?? "");
  const [twLink, setTwLink] = useState<string | null>(row.tw_link);
  // Occurrence is hidden in the schema but real (round-trips to the TSV
  // Occurrence column). Display null/0 as 1 — the export coerces an OL quote's
  // null occurrence to 1, so 1 and null are equivalent on disk and must not
  // count as a dirty edit.
  const [occurrence, setOccurrence] = useState(row.occurrence ?? 1);
  const [translateError, setTranslateError] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const catalogs = useCatalogs();

  // Alternative articles for the current link, from two sources unioned by link:
  //  1. Heading-synonym siblings of the current link (e.g. kt/call-* ) — the
  //     variant-blind global groups built from article titles.
  //  2. The per-verse matcher's candidates for this row's source word — surfaces
  //     morphologically-correct articles the heading grouping can't reach (e.g.
  //     other/lover for "lovers" on a row wrongly linked to kt/love).
  // Drives the "this word has alternatives" badge + scoped picker.
  const disambig = useMemo(() => {
    const byLink = new Map<string, { link: string; title: string }>();
    if (twLink) {
      const idx = catalogs.disambiguationIndex?.[twLink];
      if (idx != null) {
        const group = catalogs.disambiguationGroups?.[idx];
        if (group) for (const o of group) byLink.set(o.link, o);
      }
    }
    for (const id of suggestionAltIds ? suggestionAltIds.split(",") : []) {
      if (!id) continue;
      const link = `rc://*/tw/dict/bible/${id}`;
      if (!byLink.has(link)) byLink.set(link, { link, title: "" });
    }
    // Ensure the current link is an option (shown selected) even when it only
    // came in via suggestions and has no heading group.
    if (byLink.size > 0 && twLink && !byLink.has(twLink)) {
      byLink.set(twLink, { link: twLink, title: "" });
    }
    const list = [...byLink.values()];
    return list.length > 1 ? list : null;
  }, [twLink, catalogs.disambiguationIndex, catalogs.disambiguationGroups, suggestionAltIds]);
  const [disambigAnchor, setDisambigAnchor] = useState<HTMLElement | null>(null);

  // When the row's field values change (an optimistic Save, the server's
  // answer, a remote edit), a field adopts the new value only if the user
  // hasn't edited it since the last baseline. This used to reset every field on
  // each version bump, so the server's answer to a Save dropped text typed
  // after the Save and cleared its draft (#616).
  const baselineRef = useRef<TwlFields>(twlBaseline(row));
  // Text of a refused save stays when the row is rebuilt to the server's copy
  // (#637 item 1); discarding that save puts the row's value back. The held
  // patch uses the row's field names (twlDiff).
  const { noteSave, rowChanged, decide } = useRefusedSaveHold("twl", row.id, row.book, (released) => {
    const base = baselineRef.current;
    if ("orig_words" in released) setQuote((q) => (q === released.orig_words ? base.quote : q));
    if ("tw_link" in released) setTwLink((l) => (l === released.tw_link ? base.twLink : l));
    if ("occurrence" in released) setOccurrence((o) => (o === released.occurrence ? base.occurrence : o));
  });
  useEffect(() => {
    const prev = baselineRef.current;
    const next = twlBaseline({ orig_words: row.orig_words, tw_link: row.tw_link, occurrence: row.occurrence });
    baselineRef.current = next;
    const released = rowChanged(row.version);
    const pick = <T,>(field: string, p: T, n: T, local: T): T => {
      const d = decide(field, local, released);
      return d === "keep" ? local : d === "adopt" ? n : reconcileField(p, n, local);
    };
    setQuote((q) => pick("orig_words", prev.quote, next.quote, q));
    setTwLink((l) => pick("tw_link", prev.twLink, next.twLink, l));
    setOccurrence((o) => pick("occurrence", prev.occurrence, next.occurrence, o));
  }, [row.orig_words, row.tw_link, row.occurrence, row.version, rowChanged, decide]);

  const draftKey = useMemo(() => rowKey("twl", row.book, row.id), [row.book, row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation.
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(draftKey).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const patch = (rec?.payload as { patch?: Partial<TwlRow> } | undefined)?.patch;
      if (!patch) return;
      if (typeof patch.orig_words === "string") setQuote(patch.orig_words);
      if ("tw_link" in patch) setTwLink((patch.tw_link as string | null) ?? null);
      if (typeof patch.occurrence === "number") setOccurrence(patch.occurrence);
    });
  }, [draftKey]);
  // null/0 stored occurrence is equivalent to 1 for an OL quote (see export
  // coercion), so only a real numeric change counts as dirty.
  const diff = useMemo<Partial<TwlRow>>(
    () =>
      twlDiff(
        { orig_words: row.orig_words, tw_link: row.tw_link, occurrence: row.occurrence },
        { quote, twLink, occurrence },
      ),
    [quote, twLink, occurrence, row.orig_words, row.tw_link, row.occurrence],
  );
  const isDirty = Object.keys(diff).length > 0;

  useEffect(() => {
    if (isDirty) {
      void drafts.set(draftKey, { patch: diff }, row.version, {
        kind: "row",
        rowKind: "twl",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      // Keeps a refused save's text (#647): these fields equal the cached
      // row, which still carries it. The shown values tell a refused field
      // still pending from one since saved over.
      void drafts.clearUnlessRefused(draftKey, { orig_words: quote, tw_link: twLink, occurrence });
    }
  }, [draftKey, isDirty, diff, row.version, row.id, row.book, row.chapter, row.verse, quote, twLink, occurrence]);

  const positionFromEvent = (e: React.DragEvent): WordDropPosition => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return "after";
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  const quoteScript = detectQuoteScript(quote);
  const showTranslateIcon = quoteScript === "ltr" && !!onTranslateQuote;

  const handleTranslateQuote = () => {
    if (!onTranslateQuote || quoteScript !== "ltr") return;
    const result = onTranslateQuote(quote);
    if (result) {
      setQuote(result);
    } else {
      setTranslateError(true);
    }
  };

  // Undo discards unsaved edits: it resets to the current row, the same
  // baseline `diff` uses. The row already carries an optimistic save before
  // the server acknowledges it, so Undo never restores a pre-save value (#613).
  const handleUndo = () => {
    const base = twlBaseline(row);
    setQuote(base.quote);
    setTwLink(base.twLink);
    setOccurrence(base.occurrence);
  };

  const handleSave = () => {
    if (!isDirty) return;
    noteSave(diff, row.version);
    onSave(diff);
  };

  return (
    <Box
      ref={rowRef}
      data-word-id={row.id}
      onMouseDown={onFocus}
      onFocus={onFocus}
      onDragOver={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onRowDragOver(positionFromEvent(e));
      }}
      onDrop={(e) => {
        if (!isDropTarget) return;
        e.preventDefault();
        onRowDrop(positionFromEvent(e));
      }}
      sx={{
        ...responsiveGridSx,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        bgcolor: active ? "primary.50" : "transparent",
        boxShadow: active ? "inset 2px 0 0 0 var(--mui-palette-primary-main, #31ADE3)" : "none",
        opacity: dragging ? 0.4 : 1,
        transition: "opacity 120ms ease",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <Box
        sx={{
          gridArea: "grip",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Locate spot: hovering it lights up where this link's word sits in the
            scripture (no click / focus change). onMouseLeave clears the preview;
            onBlur covers keyboard focus leaving via Tab. */}
        {onHoverPreview && (
          <Tooltip title={t("words.showInText")}>
            <IconButton
              size="small"
              aria-label="show in text"
              onMouseEnter={() => onHoverPreview(row.id)}
              onMouseLeave={() => onHoverPreview(null)}
              onFocus={() => onHoverPreview(row.id)}
              onBlur={() => onHoverPreview(null)}
              sx={{ p: 0, color: "text.disabled", "&:hover": { color: "primary.main" } }}
            >
              <CenterFocusStrongIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        )}
        {/* Manual reorder controls — hidden while TWL order is canonical (the
            grip cell stays for layout). Restored by flipping
            ENABLE_TWL_MANUAL_REORDER in this file. */}
        {ENABLE_TWL_MANUAL_REORDER && (
          <>
            <Tooltip title={t("words.moveUp")}>
              <span>
                <IconButton
                  size="small"
                  data-reorder-arrow="up"
                  onClick={onMoveUp}
                  disabled={!onMoveUp}
                  sx={{ p: 0, color: "text.disabled", ...(flashArrow === "up" ? reorderFlashSx : null) }}
                >
                  <ArrowUpwardIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("words.dragToReorder")}>
              <Box
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", row.id);
                  if (rowRef.current) {
                    e.dataTransfer.setDragImage(rowRef.current, 12, 12);
                  }
                  onGripDragStart?.();
                }}
                onDragEnd={onDragEnd}
                sx={{
                  cursor: "grab",
                  color: "text.disabled",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  "&:active": { cursor: "grabbing" },
                }}
              >
                <DragIndicatorIcon fontSize="small" />
              </Box>
            </Tooltip>
            <Tooltip title={t("words.moveDown")}>
              <span>
                <IconButton
                  size="small"
                  data-reorder-arrow="down"
                  onClick={onMoveDown}
                  disabled={!onMoveDown}
                  sx={{ p: 0, color: "text.disabled", ...(flashArrow === "down" ? reorderFlashSx : null) }}
                >
                  <ArrowDownwardIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </span>
            </Tooltip>
          </>
        )}
      </Box>
      <Box sx={{ gridArea: "quote", minWidth: 0, display: "flex", gap: 0.5, alignItems: "center" }}>
        <TextField
          value={quote}
          onChange={(e) => setQuote(e.target.value)}
          size="small"
          variant="outlined"
          spellCheck={false}
          // Shared fixed height keeps the quote box and the occurrence box the
          // same height; InputBase centers the input within it.
          sx={{ flex: 1, minWidth: 0, "& .MuiOutlinedInput-root": { height: 34 } }}
          InputProps={{
            ...(isDirty ? { "data-dirty": "true" } : {}),
            endAdornment: showTranslateIcon ? (
              <InputAdornment position="end">
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
            ) : undefined,
          }}
          inputProps={{
            dir: quoteScript === "ltr" ? "ltr" : "rtl",
            style: {
              fontFamily: '"Times New Roman","SBL Hebrew","Cardo",serif',
              fontSize: 19,
              padding: "0 6px",
              textAlign: quoteScript === "ltr" ? "left" : "right",
            },
          }}
        />
        <Tooltip title={t("words.occurrenceTooltip")}>
          <TextField
            value={occurrence}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setOccurrence(Number.isFinite(n) && n > 0 ? n : 1);
            }}
            size="small"
            variant="outlined"
            type="number"
            sx={{ width: 52, flexShrink: 0, "& .MuiOutlinedInput-root": { height: 34 } }}
            inputProps={{
              min: 1,
              "aria-label": t("words.occurrenceAriaLabel"),
              style: { fontSize: 13, padding: "0 4px", textAlign: "center" },
            }}
          />
        </Tooltip>
        {onStartQuoteBuild && (
          <Tooltip
            title={
              quoteBuildMode
                ? t("words.pickerOpen", { count: quoteBuildSelectionCount })
                : t("words.buildQuoteTooltip")
            }
          >
            <IconButton
              size="small"
              onClick={onStartQuoteBuild}
              sx={{
                p: 0.25,
                flexShrink: 0,
                color: quoteBuildMode ? "primary.main" : "text.secondary",
              }}
            >
              <AutoFixHighIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      {gloss ? (
        <Tooltip title={t("words.glossTooltip")}>
          <Typography
            variant="caption"
            sx={{
              gridArea: "gloss",
              color: "text.secondary",
              fontStyle: "italic",
              // Arabic glosses carry stacked diacritics; a tight line-height
              // lets their marks overflow upward into the row above. Loosen it
              // so the gloss keeps clear of the quote row above.
              lineHeight: 1.7,
              pb: "2px",
              whiteSpace: "normal",
              wordBreak: "break-word",
            }}
          >
            {gloss}
          </Typography>
        </Tooltip>
      ) : null}
      <Box sx={{ gridArea: "twarticle", minWidth: 0, display: "flex", alignItems: "center", gap: 0.5 }}>
        <CatalogPicker
          value={twLink}
          options={catalogs.twLinks}
          display={(v) => (v ? twShort(v) : t("words.addTwArticle"))}
          placeholder="names/, kt/, other/, …"
          onChange={(next) => setTwLink(next)}
        />
        {disambig && (
          <>
            <Tooltip
              title={t("words.disambigTooltip", { count: disambig.length })}
            >
              <Chip
                size="small"
                icon={<AltRouteIcon sx={{ fontSize: 13 }} />}
                label={disambig.length}
                color="warning"
                variant="outlined"
                onClick={(e) => setDisambigAnchor(e.currentTarget)}
                sx={{ height: 20, cursor: "pointer", flexShrink: 0, "& .MuiChip-label": { px: 0.5, fontSize: 11 } }}
              />
            </Tooltip>
            <Menu
              anchorEl={disambigAnchor}
              open={!!disambigAnchor}
              onClose={() => setDisambigAnchor(null)}
              MenuListProps={{ dense: true }}
            >
              {disambig.map((opt) => (
                <MenuItem
                  key={opt.link}
                  selected={opt.link === twLink}
                  onClick={() => {
                    setTwLink(opt.link);
                    setDisambigAnchor(null);
                  }}
                  sx={{ maxWidth: 360 }}
                >
                  <ListItemText
                    primary={twShort(opt.link)}
                    secondary={opt.title || undefined}
                    primaryTypographyProps={{ fontFamily: "monospace", fontSize: 12 }}
                    secondaryTypographyProps={{ fontSize: 11, sx: { whiteSpace: "normal" } }}
                  />
                </MenuItem>
              ))}
            </Menu>
          </>
        )}
        {twLink && (
          <Tooltip title={t("words.readArticle")}>
            <IconButton
              size="small"
              onClick={() => onOpenArticle(twLink)}
              sx={{ p: 0.25, color: "text.secondary", flexShrink: 0 }}
            >
              <OpenInNewIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <Tooltip title={isDirty ? t("words.saveEdits") : t("words.noUnsavedEdits")}>
        <span style={{ gridArea: "save" }}>
          <IconButton
            size="small"
            disabled={!isDirty}
            onClick={handleSave}
            sx={{ p: 0.25, color: isDirty ? "primary.main" : "action.disabled" }}
          >
            {isDirty ? (
              <SaveIcon fontSize="inherit" />
            ) : (
              <SaveOutlinedIcon fontSize="inherit" />
            )}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={isDirty ? t("words.undoEdits") : ""}>
        <span style={{ gridArea: "undo" }}>
          <IconButton
            size="small"
            onClick={handleUndo}
            disabled={!isDirty}
            sx={{ p: 0.25, color: "text.secondary", opacity: isDirty ? 1 : 0, transition: "opacity 150ms" }}
          >
            <UndoIcon fontSize="inherit" />
          </IconButton>
        </span>
      </Tooltip>
      <IconButton
        size="small"
        onClick={onDelete}
        color="error"
        sx={{ p: 0.25, gridArea: "delete" }}
      >
        <DeleteOutlineIcon fontSize="inherit" />
      </IconButton>
      <Snackbar
        open={translateError}
        autoHideDuration={4000}
        onClose={() => setTranslateError(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert severity="warning" onClose={() => setTranslateError(false)} sx={{ width: "100%" }}>
          {t("words.noAlignmentMatch", { quote })}
        </Alert>
      </Snackbar>
    </Box>
  );
}, (a, b) =>
  // Skip sibling word rows when the table re-renders (selection / add / delete).
  // row is referentially stable unless THIS word changed; callbacks ignored.
  // gloss is compared so a re-derived English gloss (e.g. after a realign) lands.
  a.row === b.row &&
  a.active === b.active &&
  a.dragging === b.dragging &&
  a.isDropTarget === b.isDropTarget &&
  !!a.onMoveUp === !!b.onMoveUp &&
  !!a.onMoveDown === !!b.onMoveDown &&
  a.gloss === b.gloss &&
  a.quoteBuildMode === b.quoteBuildMode &&
  a.quoteBuildSelectionCount === b.quoteBuildSelectionCount &&
  a.suggestionAltIds === b.suggestionAltIds);

function twShort(link: string | null): string {
  if (!link) return "—";
  // rc://*/tw/dict/bible/names/moab → names/moab
  const m = link.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : link;
}
