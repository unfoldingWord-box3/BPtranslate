// Rapid check: the dense, keyboard-driven layout of the flows notes screen
// (#/notes) for laptop-and-up screens. Design record: PR #825
// (docs/design/rapid-check-mockups/HANDOFF.md on branch design/rapid-check-mockups).
//
// This component only DRAWS. It owns no note data and no save path: the rows,
// the one open editor and every verb come from TranslateNotesScreen, which
// keeps its single cursor, its single-row editor (draft hydration, drafts
// store, conflict and lock handling) and its Save / Save & approve handlers.
// The "current" row here is the screen's cursor; only it can hold the editor.

import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { RapidColumnHeader } from "./RapidColumnHeader";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import { arabicFontSize, startsArabicScript } from "../../lib/arabicScriptSize";
import { RapidBulkBar, RapidBulkResultLine, type RapidBulkProps } from "./RapidBulkBar";
import Button from "@mui/material/Button";
import AssistantPanel, { type AssistantApplyResult } from "../../assistant/AssistantPanel";
import { assistantVisible, useAssistantStatus } from "../../assistant/useAssistantStatus";
import type { NoteInfo } from "../../assistant/ProposalCard";
import type { AssistantActions } from "../../sync/api";
import { buildRapidNotes, type RapidAssistantRow } from "./rapidAssistant";

export interface RapidCheckRow {
  id: string;
  /** Index into the screen's frozen queue — what the cursor holds. */
  idx: number;
  verse: number;
  /** Reference label ("1:3", "13:26-27", or the intro label). */
  refLabel: string;
  typeSlug: string | null;
  typeLabel: string | null;
  chip: { kind: FlowStatusKind; label: string };
  quote: string;
  englishNote: string | null;
  /** The saved note, or the live draft for the current row. */
  targetText: string;
  isCurrent: boolean;
  approved: boolean;
  /** The status circle can approve this row right now. */
  approvable: boolean;
  /** Not the open row, and it holds unsaved typing: open it to save first. */
  blocked: boolean;
}

/** What the in-app assistant (#858) needs from the screen. */
export interface RapidAssistantProps {
  chapter: number;
  /** The chapter's notes that are not set aside, in screen order, read at send time. */
  rows: () => RapidAssistantRow[];
  describeId: (id: string) => NoteInfo | null;
  /** `versions` is the snapshot buildRapidNotes captured when the proposal was requested. */
  onApply: (selection: AssistantActions, versions: ReadonlyMap<string, number>) => Promise<AssistantApplyResult>;
}

export interface NotesRapidCheckProps {
  rows: RapidCheckRow[];
  /** Type-filter mode: rows span the chapter, so label each verse group. */
  groupByVerse: boolean;
  /** The compact lanes drawn in a verse group's head: given only in the
   *  "verses inline" placement, with or without a type filter. A verse
   *  group with lanes gets a head even when groupByVerse is off. */
  renderGroupLanes?: (verse: number, refLabel: string) => ReactNode;
  /** Flips the verse placement (top / inline), the V key. */
  onTogglePlacement: () => void;
  book: string;
  sourceLabel: string;
  sourceDir: "rtl" | "ltr";
  targetLabel: string;
  /** Translation-mode workspaces have an English source column to show. */
  englishAvailable: boolean;
  showEnglish: boolean;
  onToggleEnglish: () => void;
  /** The original-language quote column is shown (hidden from its header). */
  showQuote: boolean;
  onToggleQuote: () => void;
  /** Toggles the source ULT lane in the verse block; null when not offered. */
  onToggleSourceUlt: (() => void) | null;
  /** Alerts and the verse block, pinned above the list. */
  header: ReactNode;
  /** The screen's article-type filter; null when the chapter has no types. */
  filterControl: ReactNode;
  /** The screen's editor for the current row (TextField + Save). */
  editor: ReactNode;
  editing: boolean;
  editorContainerRef: Ref<HTMLDivElement>;
  /** The screen's action bar (Redo / Not needed / Save & approve). */
  footer: ReactNode;
  busy: boolean;
  editLocked: boolean;
  onSelect: (idx: number) => void;
  onEdit: (idx: number) => void;
  onApprove: (id: string) => void;
  /** Takes the approval off an approved row (its circle, clicked again). */
  onUnapprove: (id: string) => void;
  /** Opens the quote picker for the open row; null when it can't be offered. */
  onOpenQuote: (() => void) | null;
  /** The picker's anchor: the pencil in the open row's quote cell. */
  quoteAnchorRef: Ref<HTMLButtonElement>;
  /** The quote picker is open (focus returns to the list when it closes). */
  quoteOpen: boolean;
  onNext: () => void;
  onPrev: () => void;
  /** Previous / next verse with notes ([ and ]); null at either end. */
  onPrevVerse: (() => void) | null;
  onNextVerse: (() => void) | null;
  onApproveCurrent: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
  /** Checkbox multi-select and its bulk verbs (#829). */
  bulk: RapidBulkProps;
  /** The assistant chat; null hides it. */
  assistant: RapidAssistantProps | null;
}

const INSPIRE = "#31ADE3";
// The leading checkbox column (#829), ahead of the approve circle's.
const CHECK_COL = "28px";

// Keys typed into a text field, or inside the type filter's Select and its
// menu, are never shortcuts: "a" in the editor must type an "a", not approve.
// React bubbles portal events (the Select menu) through this container too.
function isInFormControl(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable) return true;
  return el.closest('[role="combobox"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"]') != null;
}

export function NotesRapidCheck(props: NotesRapidCheckProps) {
  const {
    rows,
    groupByVerse,
    renderGroupLanes,
    onTogglePlacement,
    book,
    sourceLabel,
    sourceDir,
    targetLabel,
    englishAvailable,
    showEnglish,
    onToggleEnglish,
    showQuote,
    onToggleQuote,
    onToggleSourceUlt,
    header,
    filterControl,
    editor,
    editing,
    editorContainerRef,
    footer,
    busy,
    editLocked,
    onSelect,
    onEdit,
    onApprove,
    onUnapprove,
    onOpenQuote,
    quoteAnchorRef,
    quoteOpen,
    onNext,
    onPrev,
    onPrevVerse,
    onNextVerse,
    onApproveCurrent,
    onStartEdit,
    onStopEdit,
    bulk,
    assistant,
  } = props;
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const { ok, skip } = theme.palette.flows;
  const englishCol = englishAvailable && showEnglish;
  // Narrower status and quote columns than the first version, so the two
  // note columns wrap less and rows stay shorter (#830).
  const cols = [
    "36px minmax(104px, 132px)",
    showQuote ? (englishCol ? "minmax(96px, 0.55fr)" : "minmax(110px, 0.7fr)") : null,
    englishCol ? "minmax(0, 1.2fr)" : null,
    "minmax(0, 1.5fr)",
  ]
    .filter(Boolean)
    .join(" ");

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stickyH, setStickyH] = useState(0);
  useEffect(() => {
    const el = stickyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStickyH(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the current row in view below the pinned header as the cursor moves.
  const currentId = rows.find((r) => r.isCurrent)?.id ?? null;
  // Switching the verse placement resizes the pinned header and adds or
  // removes the group heads: bring the current row back into view then too.
  const inlineLanes = renderGroupLanes != null;
  useEffect(() => {
    if (!currentId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-rapid-row="${CSS.escape(currentId)}"]`);
    // The first row of a verse group brings the group's head (its lanes)
    // into view too, so J/K never leave the verse text under the pinned header.
    const head = el?.previousElementSibling;
    if (head instanceof HTMLElement && head.dataset.rapidGroup != null) head.scrollIntoView({ block: "nearest" });
    el?.scrollIntoView({ block: "nearest" });
  }, [currentId, inlineLanes, stickyH]);

  // Keyboard focus must stay inside the list for the shortcuts to work. The
  // element that held it can disappear: J past a verse's last note replaces
  // every row, an approved circle turns disabled, Save or Esc closes the
  // editor. When that drops focus to <body>, take it back to the list.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled) {
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, [currentId, editing, rows, showQuote, showEnglish, quoteOpen]);

  const currentApprovable = rows.find((r) => r.isCurrent)?.approvable ?? false;

  // Checked notes (#829): visual state only, and only for the rows on screen.
  // The selection is tagged with the row set it was made on, so moving to
  // another verse or filter clears it instead of acting on hidden notes.
  const idsKey = rows.map((r) => r.id).join(",");
  const [sel, setSel] = useState<{ key: string; ids: ReadonlySet<string>; anchor: string | null }>({
    key: "",
    ids: new Set(),
    anchor: null,
  });
  const selected = sel.key === idsKey ? sel.ids : new Set<string>();
  const anchor = sel.key === idsKey ? sel.anchor : null;
  const selectedIds = rows.filter((r) => selected.has(r.id)).map((r) => r.id);
  const setSelected = (ids: Iterable<string>, nextAnchor: string | null = anchor) =>
    setSel({ key: idsKey, ids: new Set(ids), anchor: nextAnchor });
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next, id);
  };
  // Shift+click: check every row from the range start to this one.
  const extendTo = (id: string) => {
    const from = rows.findIndex((r) => r.id === (anchor ?? currentId));
    const to = rows.findIndex((r) => r.id === id);
    if (to < 0) return;
    const next = new Set(selected);
    const [lo, hi] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    for (let i = lo; i <= hi; i++) next.add(rows[i].id);
    setSelected(next, anchor ?? currentId);
  };
  const allChecked = rows.length > 0 && selectedIds.length === rows.length;
  // While a bulk action runs the checkboxes are frozen, so its outcome (the
  // skipped rows) cannot overwrite a selection made in the meantime.
  const selLocked = busy || bulk.running;
  const runBulk = (action: (ids: string[]) => Promise<string[]>) => {
    const key = idsKey;
    void action(selectedIds).then((left) => {
      // Rows the action skipped stay checked, so they are easy to find.
      setSel((prev) => (prev.key === key ? { key, ids: new Set(left), anchor: null } : prev));
    });
    scrollRef.current?.focus({ preventScroll: true });
  };

  // The assistant chat (#858): its button shows only to people who can apply
  // what it proposes, and only when an admin has switched it on.
  const [assistantOpen, setAssistantOpen] = useState(false);
  const assistantStatus = useAssistantStatus(i18n.language, assistantOpen);
  const assistantOn = assistant != null && assistantVisible(assistantStatus.status);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "TEXTAREA" && editing) {
      if (e.key === "Escape") {
        e.preventDefault();
        onStopEdit();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.repeat) {
        // Focus stays in the editor: if the save fails, the editor stays open
        // and the next letters typed are still text, not shortcuts. When the
        // approve closes the editor, the effect above moves focus to the list.
        e.preventDefault();
        if (!busy && !editLocked) onApproveCurrent();
      }
      return;
    }
    if (isInFormControl(target)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyZ" && bulk.onUndo) {
      e.preventDefault();
      if (!e.repeat && !busy) bulk.onUndo();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Letters match the physical key (e.code), so they also work while an
    // Arabic or other keyboard layout is active.
    const code = e.code;
    const down = code === "KeyJ" || e.key === "ArrowDown";
    if (e.shiftKey && (down || code === "KeyK" || e.key === "ArrowUp")) {
      // Shift+J/K extends the checked range by one row, within the rows shown.
      e.preventDefault();
      // The selection is fixed while a bulk action runs: its outcome replaces it.
      if (selLocked) return;
      const p = rows.findIndex((r) => r.isCurrent);
      const n = p + (down ? 1 : -1);
      if (p < 0 || n < 0 || n >= rows.length) return;
      setSelected([...selected, rows[p].id, rows[n].id], anchor ?? rows[p].id);
      onSelect(rows[n].idx);
      return;
    }
    // Space or X checks a row: the row whose checkbox or type/ref button has
    // focus, else the current row. Space on a checkbox is left to the button's
    // own click (handling it here too would toggle twice), and keeps its own
    // meaning on every other button.
    const boxId = target.dataset.rapidCheckbox ?? target.dataset.rapidSelect;
    if (
      code === "KeyX" ||
      (e.key === " " && target.dataset.rapidCheckbox == null && (boxId != null || target === e.currentTarget))
    ) {
      e.preventDefault();
      if (e.repeat || selLocked) return;
      const id = boxId ?? currentId;
      if (id) toggleRow(id);
      return;
    }
    if (down) {
      e.preventDefault();
      onNext();
    } else if (code === "KeyK" || e.key === "ArrowUp") {
      e.preventDefault();
      onPrev();
    } else if (e.key === "Enter" && (target === e.currentTarget || target.dataset.rapidSelect != null)) {
      // On the list itself or on any row's select button (where focus sits
      // after clicking a row; J/K may have moved the cursor since), Enter
      // edits the CURRENT note. Enter on any other button keeps its own action.
      e.preventDefault();
      if (!e.repeat && !editLocked) onStartEdit();
    } else if (code === "KeyA" && !e.shiftKey) {
      e.preventDefault();
      // No auto-repeat: holding A must not approve note after note unread.
      if (!e.repeat && !busy && !editLocked && currentApprovable) onApproveCurrent();
    } else if (code === "KeyE" && !e.shiftKey && englishAvailable) {
      e.preventDefault();
      onToggleEnglish();
    } else if (code === "KeyU" && !e.shiftKey && onToggleSourceUlt) {
      e.preventDefault();
      onToggleSourceUlt();
    } else if (code === "KeyV" && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) onTogglePlacement();
    } else if (code === "KeyQ" && !e.shiftKey && onOpenQuote) {
      e.preventDefault();
      // Only while the open row is drawn: its pencil (or, with the quote
      // column hidden, its type button) is the picker's anchor.
      if (!e.repeat && !busy && !editLocked && currentId) onOpenQuote();
    } else if (e.key === "[" || (code === "BracketLeft" && e.key !== "]")) {
      e.preventDefault();
      onPrevVerse?.();
    } else if (e.key === "]" || (code === "BracketRight" && e.key !== "[")) {
      e.preventDefault();
      onNextVerse?.();
    }
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", width: "100%" }}>
    <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", maxWidth: 1440, mx: "auto" }}>
      <Box
        ref={scrollRef}
        role="region"
        aria-label={t("flowTranslate.rapid.listAria")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-rapid-check=""
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          paddingInline: 2,
          paddingBlockEnd: 2,
          outline: "none",
          "&:focus-visible": { boxShadow: `inset 0 0 0 2px ${INSPIRE}` },
        }}
      >
        {/* One sticky wrapper (not several stacked ones), with no
            overflow:hidden between it and the scroll container — either
            breaks position: sticky. */}
        <Box
          ref={stickyRef}
          sx={{ position: "sticky", top: 0, zIndex: 3, bgcolor: "background.default", paddingBlockStart: 1 }}
        >
          {header}
          {filterControl && (
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.75, flexWrap: "wrap", rowGap: 0.5 }}>
              {filterControl}
            </Stack>
          )}
          <RapidColumnHeader
            cols={`${CHECK_COL} ${cols}`}
            leadingCell={
              <CheckBox
                checked={allChecked ? true : selectedIds.length > 0 ? "mixed" : false}
                label={t("flowTranslate.rapid.bulk.selectAll")}
                disabled={selLocked}
                onClick={() => setSelected(allChecked ? [] : rows.map((r) => r.id), null)}
              />
            }
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
            showQuote={showQuote}
            onToggleQuote={onToggleQuote}
            englishAvailable={englishAvailable}
            showEnglish={showEnglish}
            onToggleEnglish={onToggleEnglish}
            sourceUltKey={onToggleSourceUlt != null}
            quoteKey={onOpenQuote != null}
            placementKey
          />
        </Box>

        <Box
          role="list"
          sx={{
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: "0 0 10px 10px",
          }}
        >
          {rows.map((r, i) => {
            const groupLanes =
              renderGroupLanes && r.verse > 0 && (i === 0 || rows[i - 1].verse !== r.verse)
                ? renderGroupLanes(r.verse, `${book} ${r.refLabel}`)
                : null;
            const groupHead =
              (groupByVerse || groupLanes) && (i === 0 || rows[i - 1].verse !== r.verse) ? (
                <Box
                  key={`v-${r.id}`}
                  role="listitem"
                  data-rapid-group={r.verse}
                  sx={{
                    bgcolor: skip.soft,
                    color: skip.ink,
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    scrollMarginTop: `${stickyH + 4}px`,
                    ...(groupLanes
                      ? {
                          paddingBlock: 0.5,
                          borderBottom: "1px solid",
                          borderColor: "divider",
                          // The rows' first three columns (checkbox, circle,
                          // status/type) and their 3px current-row bar, so the
                          // lanes start where the rows' quote column does.
                          display: "grid",
                          gridTemplateColumns: `${CHECK_COL} 36px minmax(104px, 132px) minmax(0, 1fr)`,
                          columnGap: 1.5,
                          alignItems: "baseline",
                          paddingInlineStart: 0,
                          paddingInlineEnd: 1,
                          borderInlineStart: "3px solid transparent",
                        }
                      : // No lanes: just a dividing line. Each row already
                        // shows its verse beside the status, so the label is
                        // kept only for screen readers.
                        { position: "relative", height: "4px", overflow: "hidden" }),
                  }}
                >
                  <Box
                    component="span"
                    sx={
                      groupLanes
                        ? { gridColumn: "1 / 4", paddingInlineStart: 1.5 }
                        : { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }
                    }
                  >
                    {book} {r.refLabel}
                  </Box>
                  {groupLanes}
                </Box>
              ) : null;
            const circleLabel = r.approved
              ? t("flowTranslate.rapid.unapprove.circle")
              : r.blocked
                ? t("flowTranslate.rapid.openToSave")
                : r.approvable
                ? t("flowTranslate.rapid.approveNote", { ref: r.refLabel })
                : t("flowTranslate.rapid.nothingToApprove");
            return (
              <Fragment key={r.id}>
                {groupHead}
                <Box
                  role="listitem"
                  data-rapid-row={r.id}
                  aria-current={r.isCurrent ? "true" : undefined}
                  // A click anywhere on the row makes it current (the type/ref
                  // button stays the keyboard way in). Controls keep their own
                  // click, and a click that ends a text selection selects text.
                  onClick={(e) => {
                    if (r.isCurrent) return;
                    const el = e.target as HTMLElement;
                    if (el.closest('button, a, input, textarea, label, [role="button"], [role="checkbox"]')) return;
                    const sel = window.getSelection();
                    if (sel && !sel.isCollapsed && sel.anchorNode && e.currentTarget.contains(sel.anchorNode)) return;
                    onSelect(r.idx);
                  }}
                  sx={{
                    cursor: r.isCurrent ? "default" : "pointer",
                    "&:hover": r.isCurrent ? undefined : { bgcolor: "action.hover" },
                    display: "grid",
                    gridTemplateColumns: `${CHECK_COL} ${cols}`,
                    gap: 1.5,
                    alignItems: "start",
                    paddingBlock: 0.5,
                    paddingInlineEnd: 1,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    borderInlineStart: "3px solid",
                    borderInlineStartColor: r.isCurrent ? INSPIRE : "transparent",
                    bgcolor: r.isCurrent ? alpha(INSPIRE, dark ? 0.12 : 0.07) : "transparent",
                    scrollMarginTop: `${stickyH + 4}px`,
                    scrollMarginBottom: "8px",
                  }}
                >
                  <CheckBox
                    checked={selected.has(r.id)}
                    label={t("flowTranslate.rapid.bulk.selectNote", { ref: r.refLabel })}
                    rowId={r.id}
                    disabled={selLocked}
                    onClick={(shift) => (shift ? extendTo(r.id) : toggleRow(r.id))}
                  />
                  {/* approve circle: empty ring until approved, then filled with a check */}
                  <Box
                    component="button"
                    type="button"
                    data-rapid-approve={r.id}
                    aria-label={circleLabel}
                    title={circleLabel}
                    disabled={(!r.approved && !r.approvable) || busy || editLocked}
                    onClick={(e) => {
                      // A double-click's second click (detail 2) must not
                      // take back the approval the first click just made.
                      if (e.detail > 1) return;
                      if (r.approved) onUnapprove(r.id);
                      else onApprove(r.id);
                      // The button is disabled while the request runs; keep
                      // the keyboard in the list.
                      scrollRef.current?.focus({ preventScroll: true });
                    }}
                    sx={{
                      width: 32,
                      height: 32,
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: r.approved || r.approvable ? "pointer" : "default",
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        width: 20,
                        height: 20,
                        boxSizing: "border-box",
                        borderRadius: "50%",
                        border: "2px solid",
                        borderStyle: r.approved || r.approvable ? "solid" : "dashed",
                        borderColor: r.approved || r.approvable ? ok.main : "text.disabled",
                        bgcolor: r.approved ? ok.main : "transparent",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {r.approved && (
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </Box>
                  </Box>

                  {/* status · type · ref — the button makes this row current */}
                  <Box
                    component="button"
                    type="button"
                    onClick={() => onSelect(r.idx)}
                    data-rapid-select={r.id}
                    // With the quote column hidden, Q's picker anchors here.
                    ref={r.isCurrent && !showQuote ? quoteAnchorRef : undefined}
                    sx={{
                      border: 0,
                      background: "transparent",
                      padding: 0,
                      paddingBlockStart: 0.5,
                      font: "inherit",
                      color: "inherit",
                      textAlign: "start",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 0.25,
                      minWidth: 0,
                    }}
                  >
                    {/* chip and reference share a line, to keep short rows short (#830) */}
                    <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                      <FlowStatusChip kind={r.chip.kind} label={r.chip.label} />
                      <Typography component="span" sx={{ fontSize: "0.6875rem", color: "text.secondary" }}>
                        {r.refLabel}
                      </Typography>
                    </Box>
                    <Typography component="span" title={r.typeSlug ?? undefined} sx={{ fontSize: "0.75rem", fontWeight: 600, lineHeight: 1.25 }}>
                      {r.typeLabel ?? "—"}
                    </Typography>
                  </Box>

                  {showQuote && (
                    <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.25, minWidth: 0 }}>
                      <Typography
                        component="p"
                        dir={sourceDir}
                        data-rapid-quote=""
                        sx={{ m: 0, paddingBlockStart: 0.5, fontFamily: SCRIPTURE_FONT_STACK, fontSize: "1rem", lineHeight: 1.55, textAlign: "start", minWidth: 0, flex: 1 }}
                      >
                        {r.quote || "—"}
                      </Typography>
                      {r.isCurrent && onOpenQuote && (
                        // The card view's pencil, on the open row only: the
                        // quote picker is anchored here (Q opens it too).
                        <IconButton
                          ref={quoteAnchorRef}
                          size="small"
                          data-rapid-quote-pick={r.id}
                          disabled={busy || editLocked}
                          onClick={onOpenQuote}
                          aria-label={t("flowTranslate.changeQuote")}
                          aria-haspopup="dialog"
                          title={t("flowTranslate.rapid.quote.title")}
                          sx={{ flex: "none", color: "text.secondary" }}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      )}
                    </Box>
                  )}

                  {englishCol && (
                    <Typography
                      component="p"
                      dir="auto"
                      sx={{ m: 0, paddingBlockStart: 0.5, fontSize: "0.8125rem", lineHeight: 1.5, whiteSpace: "pre-wrap", textAlign: "start", minWidth: 0 }}
                    >
                      {r.englishNote ?? (
                        <Box component="em" sx={{ color: "text.secondary" }}>{t("flowTranslate.rapid.noEnglish")}</Box>
                      )}
                    </Typography>
                  )}

                  <Box sx={{ minWidth: 0 }}>
                    {r.isCurrent && editing ? (
                      <Box ref={editorContainerRef}>
                        {editor}
                      </Box>
                    ) : (
                      <Box
                        component="button"
                        type="button"
                        disabled={r.isCurrent && editLocked}
                        onClick={() => onEdit(r.idx)}
                        sx={{
                          display: "block",
                          width: "100%",
                          border: "1px solid transparent",
                          borderRadius: "6px",
                          background: "transparent",
                          font: "inherit",
                          color: "inherit",
                          textAlign: "start",
                          cursor: "text",
                          paddingBlock: 0.5,
                          paddingInline: 1,
                          "&:hover": { borderColor: "divider", bgcolor: "action.hover" },
                        }}
                      >
                        {/* Arabic is drawn a size larger to match the English (arabicScriptSize). */}
                        <Box component="span" dir="auto" sx={{ display: "block", fontSize: arabicFontSize("0.9375rem", startsArabicScript(r.targetText)), lineHeight: 1.5, whiteSpace: "pre-wrap", textAlign: "start" }}>
                          {r.targetText.trim().length > 0 ? (
                            r.targetText
                          ) : (
                            <Box component="em" sx={{ color: "text.secondary" }}>
                              {t("flowTranslate.nothingDrafted")}
                            </Box>
                          )}
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Fragment>
            );
          })}
        </Box>
      </Box>
      {assistantOn && (
        <Box sx={{ display: "flex", justifyContent: "flex-end", paddingInline: 2.5, paddingBlock: 0.5, bgcolor: "background.paper", borderBlockStart: "1px solid", borderColor: "divider" }}>
          <Button
            size="small"
            variant={assistantOpen ? "contained" : "outlined"}
            onClick={() => setAssistantOpen((o) => !o)}
            aria-pressed={assistantOpen}
            data-rapid-assistant-button=""
            sx={{ minHeight: 32, borderRadius: "12px", fontWeight: 700 }}
          >
            {t("assistant.open")}
          </Button>
        </Box>
      )}
      {bulk.result && (
        <RapidBulkResultLine
          result={bulk.result}
          onUndo={bulk.onUndo}
          onDismiss={bulk.onDismiss}
          disabled={busy || bulk.running}
        />
      )}
      {selectedIds.length > 0 ? (
        <RapidBulkBar
          count={selectedIds.length}
          disabled={busy || bulk.running}
          redoBlocked={bulk.redoBlocked}
          onApprove={() => runBulk(bulk.onApprove)}
          onRedo={() => runBulk(bulk.onRedo)}
          onNotNeeded={() => runBulk(bulk.onNotNeeded)}
          onClear={() => {
            setSelected([], null);
            scrollRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : (
        footer
      )}
    </Box>
    {assistant && (
      <AssistantPanel
        open={assistantOpen}
        onClose={() => setAssistantOpen(false)}
        lang={i18n.language}
        screen="rapid_check"
        status={assistantStatus.status}
        refreshStatus={assistantStatus.refresh}
        resetKey={`${book}:${assistant.chapter}`}
        buildContext={() => {
          const { notes, versions, omitted } = buildRapidNotes(assistant.rows(), new Set(selectedIds));
          return { book, chapter: assistant.chapter, notes, snapshot: versions, omitted };
        }}
        describeId={assistant.describeId}
        onApply={(sel, snapshot) => assistant.onApply(sel, snapshot as ReadonlyMap<string, number>)}
      />
    )}
    </Box>
  );
}

// A row's (or the header's select-all) checkbox: a button with the checkbox
// role, not an <input>, so the list's J/K/A shortcuts keep working while it
// has focus (the key handler ignores keys typed into form inputs).
function CheckBox({
  checked,
  label,
  rowId,
  disabled,
  onClick,
}: {
  checked: boolean | "mixed";
  label: string;
  rowId?: string;
  disabled: boolean;
  onClick: (shift: boolean) => void;
}) {
  const on = checked !== false;
  return (
    <Box
      component="button"
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={label}
      data-rapid-checkbox={rowId}
      disabled={disabled}
      onMouseDown={(e: MouseEvent) => {
        // Shift+click picks a range; don't let it select text too.
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e: MouseEvent) => onClick(e.shiftKey)}
      sx={{
        width: 28,
        height: 32,
        border: 0,
        background: "transparent",
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <Box
        component="span"
        sx={{
          width: 16,
          height: 16,
          boxSizing: "border-box",
          borderRadius: "4px",
          border: "2px solid",
          borderColor: on ? INSPIRE : "text.secondary",
          bgcolor: on ? INSPIRE : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked === true && (
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {checked === "mixed" && (
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 6h6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        )}
      </Box>
    </Box>
  );
}
