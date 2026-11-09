// Rapid check: the dense, keyboard-driven layout of the flows notes screen
// (#/notes) for laptop-and-up screens. Design record: PR #825
// (docs/design/rapid-check-mockups/HANDOFF.md on branch design/rapid-check-mockups).
//
// This component only DRAWS. It owns no note data and no save path: the rows,
// the one open editor and every verb come from TranslateNotesScreen, which
// keeps its single cursor, its single-row editor (draft hydration, drafts
// store, conflict and lock handling) and its Save / Save & approve handlers.
// The "current" row here is the screen's cursor; only it can hold the editor.

import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { SCRIPTURE_FONT_STACK } from "../../theme";

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

export interface NotesRapidCheckProps {
  rows: RapidCheckRow[];
  /** Type-filter mode: rows span the chapter, so label each verse group. */
  groupByVerse: boolean;
  /** Type-filter mode: the compact lanes drawn in a verse group's head. */
  renderGroupLanes?: (verse: number, refLabel: string) => ReactNode;
  book: string;
  sourceLabel: string;
  sourceDir: "rtl" | "ltr";
  targetLabel: string;
  /** Translation-mode workspaces have an English source column to show. */
  englishAvailable: boolean;
  showEnglish: boolean;
  onToggleEnglish: () => void;
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
  onApproveCurrent: () => void;
  onStartEdit: () => void;
  onStopEdit: () => void;
}

const INSPIRE = "#31ADE3";

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
    book,
    sourceLabel,
    sourceDir,
    targetLabel,
    englishAvailable,
    showEnglish,
    onToggleEnglish,
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
    onApproveCurrent,
    onStartEdit,
    onStopEdit,
  } = props;
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const { ok, skip } = theme.palette.flows;
  const englishCol = englishAvailable && showEnglish;
  const cols = englishCol
    ? "36px minmax(120px, 160px) minmax(110px, 0.7fr) minmax(0, 1.2fr) minmax(0, 1.5fr)"
    : "36px minmax(120px, 160px) minmax(110px, 0.8fr) minmax(0, 2fr)";

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
  useEffect(() => {
    if (!currentId) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-rapid-row="${CSS.escape(currentId)}"]`);
    // The first row of a verse group brings the group's head (its lanes)
    // into view too, so J/K never leave the verse text under the pinned header.
    const head = el?.previousElementSibling;
    if (head instanceof HTMLElement && head.dataset.rapidGroup != null) head.scrollIntoView({ block: "nearest" });
    el?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  // Keyboard focus must stay inside the list for the shortcuts to work. The
  // element that held it can disappear: J past a verse's last note replaces
  // every row, an approved circle turns disabled, Save or Esc closes the
  // editor. When that drops focus to <body>, take it back to the list.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) {
      scrollRef.current?.focus({ preventScroll: true });
    }
  }, [currentId, editing, rows, quoteOpen]);

  const currentApprovable = rows.find((r) => r.isCurrent)?.approvable ?? false;

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
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Letters match the physical key (e.code), so they also work while an
    // Arabic or other keyboard layout is active.
    const code = e.code;
    if (code === "KeyJ" || e.key === "ArrowDown") {
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
    } else if (code === "KeyQ" && !e.shiftKey && onOpenQuote) {
      e.preventDefault();
      if (!e.repeat && !busy && !editLocked) onOpenQuote();
    }
  };

  const headSx = {
    fontSize: "0.625rem",
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
  };

  const kbdSx = {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: "0.6875rem",
    border: "1px solid",
    borderColor: "divider",
    borderBottomWidth: 2,
    borderRadius: "4px",
    paddingInline: "4px",
  };

  return (
    <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", width: "100%", maxWidth: 1440, mx: "auto" }}>
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
          sx={{ position: "sticky", top: 0, zIndex: 3, bgcolor: "background.default", paddingBlockStart: 1.5 }}
        >
          {header}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.5 }}
          >
            {filterControl}
            {englishAvailable && (
              <Chip
                size="small"
                clickable
                variant={showEnglish ? "filled" : "outlined"}
                color={showEnglish ? "primary" : "default"}
                label={t("flowTranslate.englishNote")}
                aria-pressed={showEnglish}
                onClick={onToggleEnglish}
                sx={{ fontWeight: 700 }}
              />
            )}
            <Typography
              component="p"
              variant="caption"
              color="text.secondary"
              sx={{ m: 0, marginInlineStart: "auto !important", display: "flex", gap: 0.75, alignItems: "center", flexWrap: "wrap" }}
            >
              <Box component="kbd" sx={kbdSx}>J</Box>
              <Box component="kbd" sx={kbdSx}>K</Box>
              {t("flowTranslate.rapid.keyMove")}
              {" · "}
              <Box component="kbd" sx={kbdSx}>Enter</Box>
              {t("flowTranslate.rapid.keyEdit")}
              {" · "}
              <Box component="kbd" sx={kbdSx}>A</Box>
              {t("flowTranslate.rapid.keyApprove")}
              {" · "}
              <Box component="kbd" sx={kbdSx}>Ctrl</Box>
              <Box component="kbd" sx={kbdSx}>Enter</Box>
              {t("flowTranslate.rapid.keySaveApprove")}
              {" · "}
              <Box component="kbd" sx={kbdSx}>Esc</Box>
              {t("flowTranslate.rapid.keyClose")}
            </Typography>
          </Stack>
          <Box
            sx={{
              mt: 1,
              display: "grid",
              gridTemplateColumns: cols,
              gap: 1.5,
              paddingBlock: 0.75,
              paddingInlineEnd: 1,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              borderBottomWidth: 0,
              borderRadius: "10px 10px 0 0",
            }}
          >
            <span />
            <Box component="span" sx={headSx}>{t("flowTranslate.rapid.colNote")}</Box>
            <Box component="span" sx={headSx}>{sourceLabel}</Box>
            {englishCol && <Box component="span" sx={headSx}>{t("flowTranslate.englishNote")}</Box>}
            <Box component="span" sx={headSx}>{t("flowTranslate.rapid.colTarget", { target: targetLabel })}</Box>
          </Box>
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
              groupByVerse && renderGroupLanes && r.verse > 0 && (i === 0 || rows[i - 1].verse !== r.verse)
                ? renderGroupLanes(r.verse, `${book} ${r.refLabel}`)
                : null;
            const groupHead =
              groupByVerse && (i === 0 || rows[i - 1].verse !== r.verse) ? (
                <Box
                  key={`v-${r.id}`}
                  role="listitem"
                  data-rapid-group={r.verse}
                  sx={{
                    paddingInline: 1.5,
                    paddingBlock: 0.5,
                    bgcolor: skip.soft,
                    color: skip.ink,
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                    scrollMarginTop: `${stickyH + 4}px`,
                    ...(groupLanes
                      ? {
                          // The rows' first two columns (and their 3px
                          // current-row bar), so the lanes start where the
                          // rows' quote column does.
                          display: "grid",
                          gridTemplateColumns: "36px minmax(120px, 160px) minmax(0, 1fr)",
                          columnGap: 1.5,
                          alignItems: "baseline",
                          paddingInlineStart: 0,
                          paddingInlineEnd: 1,
                          borderInlineStart: "3px solid transparent",
                        }
                      : {}),
                  }}
                >
                  <Box component="span" sx={groupLanes ? { gridColumn: "1 / 3", paddingInlineStart: 1.5 } : undefined}>
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
                  sx={{
                    display: "grid",
                    gridTemplateColumns: cols,
                    gap: 1.5,
                    alignItems: "start",
                    paddingBlock: 0.75,
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
                    <FlowStatusChip kind={r.chip.kind} label={r.chip.label} />
                    <Typography component="span" title={r.typeSlug ?? undefined} sx={{ fontSize: "0.75rem", fontWeight: 600, lineHeight: 1.25 }}>
                      {r.typeLabel ?? "—"}
                    </Typography>
                    <Typography component="span" sx={{ fontSize: "0.6875rem", color: "text.secondary" }}>
                      {r.refLabel}
                    </Typography>
                  </Box>

                  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.25, minWidth: 0 }}>
                    <Typography
                      component="p"
                      dir={sourceDir}
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
                        data-rapid-quote={r.id}
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
                        <Box component="span" dir="auto" sx={{ display: "block", fontSize: "0.9375rem", lineHeight: 1.6, whiteSpace: "pre-wrap", textAlign: "start" }}>
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
      {footer}
    </Box>
  );
}
