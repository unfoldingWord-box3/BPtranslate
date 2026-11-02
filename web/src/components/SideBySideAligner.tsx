import {
  forwardRef,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Typography, IconButton, Dialog, Tooltip, Button, useTheme } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowLeftIcon from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import { useTranslation } from "react-i18next";
import { AlignmentPanel, type AlignmentPanelHandle } from "./AlignmentPanel";
import { UhbStrip } from "./UhbStrip";
import { type HoverHighlight, type HighlightCtx } from "../lib/highlightTypes";
import type { TwlRow, VerseDto } from "../sync/api";
import type { LexiconEntry } from "../hooks/useLexicon";
import { extractEditableText, normalizeEditable } from "../lib/usfm";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { versionLabel } from "../lib/versionLabels";

// Separate key from the single-panel aligner's `be:alignmentHoverLink`
// (which defaults OFF). The side-by-side popup's whole point is the
// cross-highlight bridge ("hover Hebrew to bridge" in its titlebar), so it
// defaults ON — and a distinct key keeps that intentional default from
// colliding with (or being silently flipped by) the single-panel toggle,
// whose `readFlag` reads the same string with the opposite default.
const LS_HOVERLINK = "be:dualAlignmentHoverLink";
function readHoverLink(): boolean {
  try {
    const raw = localStorage.getItem(LS_HOVERLINK);
    return raw == null ? true : raw === "1";
  } catch {
    return true;
  }
}
function writeHoverLink(v: boolean) {
  try {
    localStorage.setItem(LS_HOVERLINK, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// One side of the popup: its target verse + the wiring to save it. Mirrors the
// per-version slice of Shell's alignmentTabProps, but two of them. Each slot
// carries its OWN source slice (the verses its target actually covers) — NOT
// the union span — so a single-verse panel never grows placeholder cards for
// Hebrew it can't legitimately align to (saving those would emit zaln
// milestones referencing words outside the verse). The union span exists only
// in the shared strip; `posOffset` translates this panel's positions into it.
export interface PanelSlot {
  bibleVersion: string;
  verse: VerseDto | null;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  posOffset: number;
  onSave: (newContent: unknown, plainText: string, expectedVersion: number) => void;
  onDirtyChange: (dirty: boolean) => void;
  // Confirm-before-save when this side's edit would unalign a previously aligned
  // word (forwarded to AlignmentPanel; see its onConfirmUnalign prop).
  onConfirmUnalign?: (lostWords: string[], commit: () => void) => void;
  // Reading-line dirty mirror, so the close/verse-nav gate can prompt before
  // silently dropping an unsaved reading-text edit (parallels onDirtyChange
  // for the alignment panel). The imperative handles for both live outside
  // the slot, as the aligner's left/right *Ref props: a ref inside this
  // object made the React Compiler flag every field read of the slot (#594).
  onReadingDirtyChange: (dirty: boolean) => void;
}

// Imperative surface the gate uses to flush or revert a reading line.
export interface ReadingLineHandle {
  save: () => void;
  discard: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  book: string;
  chapter: number;
  verseNum: number;
  vref: string;
  sourceLabel: string;
  sourceVerse: VerseDto | null;
  twlForVerse: TwlRow[];
  lexiconMap: Map<string, LexiconEntry | null>;
  left: PanelSlot;
  right: PanelSlot;
  // Imperative handles for each side's alignment panel and reading line,
  // used by the caller's close/verse-nav gate to save or discard.
  leftPanelRef: Ref<AlignmentPanelHandle>;
  rightPanelRef: Ref<AlignmentPanelHandle>;
  leftReadingRef: Ref<ReadingLineHandle>;
  rightReadingRef: Ref<ReadingLineHandle>;
  // Commit a reading-text edit (smart-edit + enqueue). Fired only by the
  // explicit Save button — the reading line no longer autosaves on blur.
  // Keyed by bibleVersion so the same callback serves both sides.
  onSaveReading: (bibleVersion: string, plain: string, base: VerseDto) => void;
  // Verse nav (titlebar arrows). Undefined at the chapter's ends.
  onPrevVerse?: () => void;
  onNextVerse?: () => void;
}

// Full-width popup hosting two AlignmentPanels (e.g. ULT + UST) that align to
// the SAME source (UHB/UGNT). It owns the lifted hover + hover-link state so the
// two panels cross-highlight the same Hebrew, and renders one shared source
// strip and a small editable reading strip above them.
export function SideBySideAligner({
  open,
  onClose,
  book,
  chapter,
  verseNum,
  vref,
  sourceLabel,
  sourceVerse,
  twlForVerse,
  lexiconMap,
  left,
  right,
  leftPanelRef,
  rightPanelRef,
  leftReadingRef,
  rightReadingRef,
  onSaveReading,
  onPrevVerse,
  onNextVerse,
}: Props) {
  const { t } = useTranslation();
  const projectConfig = useProjectConfig();
  const [hover, setHover] = useState<HoverHighlight>(null);
  const [hoverLink, setHoverLink] = useState<boolean>(readHoverLink);
  // Hebrew lexicon tooltip on hover — default on; turn off to see only what's
  // aligned (the highlight bridge) without the popup covering the panels.
  const [lexInfo, setLexInfo] = useState(false);
  // Per-side panel dirty state, mirrored locally so we can lock that side's
  // reading line while alignment drags are pending. A ReadingLine blur saves
  // text → upstream swaps the verse prop → AlignmentPanel's reset effect
  // recomputes its baseline and silently drops the unsaved drags AND clears
  // `dirty` (so the close gate sees nothing to save). Disabling the reading
  // line while the panel is dirty makes a pending alignment save un-pre-emptable
  // by a same-side text edit. (Still forwards the upstream onDirtyChange.)
  const [leftDirty, setLeftDirty] = useState(false);
  const [rightDirty, setRightDirty] = useState(false);
  // Hover positions are verse-specific — a stale ring would attach to whatever
  // token happens to hold the same position after a verse nav.
  const verseKey = `${chapter}:${verseNum}`;
  const [prevVerseKey, setPrevVerseKey] = useState(verseKey);
  if (verseKey !== prevVerseKey) {
    setPrevVerseKey(verseKey);
    setHover(null);
  }
  const toggleHoverLink = () =>
    setHoverLink((cur) => {
      const next = !cur;
      writeHoverLink(next);
      if (!next) setHover(null);
      return next;
    });

  const renderPanel = (
    slot: PanelSlot,
    panelRef: Ref<AlignmentPanelHandle>,
    setLocalDirty: (dirty: boolean) => void,
  ) => (
    <AlignmentPanel
      // Remount on verse change so the panel's internal state is seeded fresh
      // (useState(computedInitial)) instead of carrying the previous verse's
      // alignment across a dualNavTo until the passive reset effect runs — the
      // same stale-state race the single-panel aligner had. bibleVersion is
      // fixed per side (ULT left / UST right), so verseNum alone keys it.
      key={`${slot.bibleVersion}:${verseNum}`}
      ref={panelRef}
      book={book}
      chapter={chapter}
      verseNum={verseNum}
      bibleVersion={slot.bibleVersion}
      verse={slot.verse}
      sourceVerse={slot.sourceVerse}
      sourceLabel={sourceLabel}
      twlForVerse={slot.twlForVerse}
      onSave={slot.onSave}
      onConfirmUnalign={slot.onConfirmUnalign}
      onCancel={onClose}
      hideCancel
      onDirtyChange={(dirty) => {
        setLocalDirty(dirty);
        slot.onDirtyChange(dirty);
      }}
      hover={hover}
      onHoverChange={setHover}
      hoverLink={hoverLink}
      onToggleHoverLink={toggleHoverLink}
      renderUhbStrip={false}
      showSourceInfo={lexInfo}
      posOffset={slot.posOffset}
    />
  );

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
        {/* titlebar */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            px: 2,
            py: 1,
            bgcolor: "primary.dark",
            color: "primary.contrastText",
            flexShrink: 0,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
            <Tooltip title={t("aligner.previousVerse")}>
              <span>
                <IconButton
                  onClick={onPrevVerse}
                  disabled={!onPrevVerse}
                  size="small"
                  sx={{ color: "inherit", "&.Mui-disabled": { color: "rgba(255,255,255,0.3)" } }}
                >
                  <KeyboardArrowLeftIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Box
              sx={{
                fontFamily: "monospace",
                fontWeight: 700,
                fontSize: 12,
                bgcolor: "rgba(255,255,255,0.16)",
                px: 1,
                py: 0.5,
                borderRadius: 1,
                minWidth: 64,
                textAlign: "center",
              }}
            >
              {vref}
            </Box>
            <Tooltip title={t("aligner.nextVerse")}>
              <span>
                <IconButton
                  onClick={onNextVerse}
                  disabled={!onNextVerse}
                  size="small"
                  sx={{ color: "inherit", "&.Mui-disabled": { color: "rgba(255,255,255,0.3)" } }}
                >
                  <KeyboardArrowRightIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          <Typography sx={{ fontWeight: 600, fontSize: 15 }}>{t("aligner.alignSideBySide")}</Typography>
          <Typography sx={{ fontSize: 12, opacity: 0.82 }}>
            {t("aligner.dualSubtitle", {
              left: versionLabel(projectConfig, left.bibleVersion),
              right: versionLabel(projectConfig, right.bibleVersion),
              source: versionLabel(projectConfig, sourceLabel),
            })}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t("aligner.hebrewInfoTooltip")}>
            <Box
              component="label"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.5,
                fontSize: 12,
                cursor: "pointer",
                userSelect: "none",
                color: "inherit",
                mr: 0.5,
              }}
            >
              <input
                type="checkbox"
                checked={lexInfo}
                onChange={(e) => setLexInfo(e.target.checked)}
                style={{ accentColor: "#fff", cursor: "pointer", margin: 0 }}
              />
              {t("aligner.hebrewInfo")}
            </Box>
          </Tooltip>
          <Tooltip title={t("aligner.close")}>
            <IconButton onClick={onClose} size="small" sx={{ color: "inherit" }}>
              <CloseIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/* small editable reading strip */}
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "1px",
            bgcolor: "divider",
            borderBottom: "1px solid",
            borderColor: "divider",
            flexShrink: 0,
          }}
        >
          <ReadingLine
            ref={leftReadingRef}
            slot={left}
            onSave={onSaveReading}
            onDirtyChange={left.onReadingDirtyChange}
            locked={leftDirty}
          />
          <ReadingLine
            ref={rightReadingRef}
            slot={right}
            onSave={onSaveReading}
            onDirtyChange={right.onReadingDirtyChange}
            locked={rightDirty}
          />
        </Box>

        {/* one shared source strip — both sides align to the same Hebrew/Greek */}
        <SharedUhbStrip
          sourceVerse={sourceVerse}
          sourceLabel={sourceLabel}
          lexiconMap={lexiconMap}
          twlForVerse={twlForVerse}
          verseNum={verseNum}
          hover={hover}
          onHover={setHover}
          hoverLink={hoverLink}
          showSourceInfo={lexInfo}
        />

        {/* the two aligners */}
        <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              borderRight: "1px solid",
              borderColor: "divider",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {renderPanel(left, leftPanelRef, setLeftDirty)}
          </Box>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {renderPanel(right, rightPanelRef, setRightDirty)}
          </Box>
        </Box>
      </Box>
    </Dialog>
  );
}

// ─── shared UHB strip — builds a minimal HighlightCtx off the lifted hover ──
function SharedUhbStrip({
  sourceVerse,
  sourceLabel,
  lexiconMap,
  twlForVerse,
  verseNum,
  hover,
  onHover,
  hoverLink,
  showSourceInfo,
}: {
  sourceVerse: VerseDto | null;
  sourceLabel: string;
  lexiconMap: Map<string, LexiconEntry | null>;
  twlForVerse: TwlRow[];
  verseNum: number;
  hover: HoverHighlight;
  onHover: (h: HoverHighlight) => void;
  hoverLink: boolean;
  showSourceInfo: boolean;
}) {
  const themeMode = useTheme().palette.mode;
  const [hidden, setHidden] = useState(false);
  // The strip renders the UNION span, so its walk positions ARE the
  // union-relative hover identity. It has no grouping of its own — hovering a
  // token seeds the lifted hover, which each panel resolves to its own groups.
  // It lights: exact (its own token hovered anywhere) and linked (a panel's
  // English hovered → that group's Hebrew positions ring here too).
  const hctx: HighlightCtx = useMemo(
    () => ({
      colorize: false,
      hoverLink,
      showSourceInfo,
      matchHues: new Map<string, number>(),
      themeMode,
      onEnglishEnter: () => {},
      onHebrewEnter: (pos: number) => {
        if (!hoverLink) return;
        onHover({ kind: "hebrew", pos, groupId: null });
      },
      onLeave: () => onHover(null),
      englishHighlight: () => null,
      hebrewHighlight: (pos: number) => {
        if (!hoverLink || !hover) return null;
        if (hover.kind === "hebrew" && hover.pos === pos) return "exact";
        if (hover.kind === "english" && hover.positions.includes(pos)) return "linked";
        return null;
      },
    }),
    [hoverLink, showSourceInfo, themeMode, hover, onHover],
  );
  return (
    <UhbStrip
      sourceVerse={sourceVerse}
      sourceLabel={sourceLabel}
      lexiconMap={lexiconMap}
      twlForVerse={twlForVerse}
      verseNum={verseNum}
      hidden={hidden}
      onToggleHidden={() => setHidden((h) => !h)}
      hctx={hctx}
    />
  );
}

// ─── small editable reading line (explicit Save / Undo, no autosave) ────────
// Follows the DocColumn VerseSpan contract: write via textContent (Firefox-safe),
// seed the DOM once, and only resync from a prop change when the user isn't
// mid-edit. Edits live in the DOM until the translator clicks Save (smart-edit
// + enqueue) or Undo (revert to the last-saved text) — nothing autosaves.
const ReadingLine = forwardRef<ReadingLineHandle, {
  slot: PanelSlot;
  onSave: (bibleVersion: string, plain: string, base: VerseDto) => void;
  onDirtyChange: (dirty: boolean) => void;
  // Locked while this side's AlignmentPanel has unsaved drags: a text edit
  // here would swap the verse prop and silently wipe those drags (see the
  // dirty-state note in SideBySideAligner). The translator saves/cancels the
  // alignment first, then the line unlocks.
  locked?: boolean;
}>(function ReadingLine({ slot, onSave, onDirtyChange, locked = false }, ref) {
  const { t } = useTranslation();
  const { bibleVersion, verse } = slot;
  const projectConfig = useProjectConfig();
  const versionDisplay = versionLabel(projectConfig, bibleVersion);
  const editable = useMemo(() => (verse ? extractEditableText(verse.content) : ""), [verse]);
  const elRef = useRef<HTMLDivElement | null>(null);
  const lastTextRef = useRef("");
  const lastSetRef = useRef<string | null>(null);
  // Enables Save/Undo only when the DOM text actually differs from the saved
  // baseline — normalized so editor-emitted trailing whitespace doesn't arm the
  // buttons (and matches saveVerseDraft's no-op guard exactly). Mirrored up to
  // the parent so the close/nav gate can prompt before losing the edit.
  const [dirty, setDirty] = useState(false);
  const markDirty = (next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  };

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    // Never resync under the user's caret: onInput updates lastTextRef, so the
    // tracker can't distinguish "user typed" from "still showing what we set" —
    // a refetch echo (e.g. the other panel's save landing) would overwrite
    // mid-edit text and drop the caret to the start. Focus is the mid-edit
    // signal (DocColumn's VerseSpan uses its draft for the same purpose).
    if (document.activeElement === el) return;
    const dom = el.textContent ?? "";
    if (lastSetRef.current === null || dom === lastTextRef.current) {
      // Skip the DOM write when the content already matches — after an edit that
      // round-trips identically, replacing the text node would needlessly
      // repaint (flash) the line and drop the caret.
      if (dom !== editable) el.textContent = editable;
      lastSetRef.current = editable;
    }
    lastTextRef.current = editable;
    // Baseline moved (a Save landed, or a verse nav swapped the verse): the
    // line now matches saved text, so it's no longer dirty.
    markDirty(normalizeEditable(el.textContent ?? "") !== normalizeEditable(editable));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable]);

  const handleSave = () => {
    const el = elRef.current;
    if (!el || !verse) return;
    onSave(bibleVersion, el.textContent ?? "", verse);
    markDirty(false);
  };

  const handleUndo = () => {
    const el = elRef.current;
    if (!el) return;
    el.textContent = editable;
    lastTextRef.current = editable;
    lastSetRef.current = editable;
    markDirty(false);
  };

  // The gate (close / verse-nav) drives these: save flushes the edit, discard
  // reverts to the last-saved text — same as the Save / Undo buttons.
  useImperativeHandle(ref, () => ({ save: handleSave, discard: handleUndo }));

  return (
    <Box sx={{ bgcolor: "background.paper", px: 2, pt: 0.75, pb: 1, minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5, minHeight: 26 }}>
        <Typography
          variant="caption"
          sx={{
            fontFamily: "monospace",
            fontSize: 9,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "text.secondary",
            fontWeight: 600,
          }}
        >
          {t("aligner.readingText", { version: versionDisplay })}{" "}
          <Box
            component="span"
            sx={{
              color: locked ? "text.disabled" : "primary.main",
              textTransform: "none",
              letterSpacing: 0,
            }}
          >
            {locked ? t("aligner.saveAlignmentFirst") : t("aligner.editable")}
          </Box>
        </Typography>
        <Box sx={{ flex: 1 }} />
        {verse && !locked && (
          <>
            <Button
              size="small"
              onClick={handleUndo}
              disabled={!dirty}
              sx={{
                color: "text.secondary",
                textTransform: "uppercase",
                fontSize: 11,
                letterSpacing: "0.06em",
                fontWeight: 600,
                minWidth: 0,
                py: 0.25,
              }}
            >
              {t("common.undo")}
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={handleSave}
              disabled={!dirty}
              sx={{
                textTransform: "uppercase",
                fontSize: 11,
                letterSpacing: "0.06em",
                fontWeight: 700,
                px: 1.5,
                py: 0.25,
              }}
            >
              {t("aligner.saveVersion", { version: versionDisplay })}
            </Button>
          </>
        )}
      </Box>
      {verse ? (
        <Box
          ref={elRef}
          contentEditable={!locked}
          suppressContentEditableWarning
          spellCheck
          title={
            locked
              ? t("aligner.readingLockedTooltip")
              : undefined
          }
          onInput={(e) => {
            const value = (e.currentTarget as HTMLDivElement).textContent ?? "";
            lastTextRef.current = value;
            lastSetRef.current = value;
            markDirty(normalizeEditable(value) !== normalizeEditable(editable));
          }}
          sx={{
            maxHeight: 64,
            overflowY: "auto",
            fontFamily: '"Times New Roman", "Cardo", serif',
            fontSize: `calc(15px * var(--be-reading-scale, 1))`,
            lineHeight: 1.5,
            color: locked ? "text.disabled" : "text.primary",
            outline: "none",
            borderRadius: 1,
            px: 0.75,
            py: 0.25,
            border: "1px solid",
            borderColor: "divider",
            cursor: locked ? "not-allowed" : "text",
            opacity: locked ? 0.6 : 1,
            transition: "border-color 0.12s, opacity 0.12s",
            ...(locked
              ? {}
              : {
                  "&:hover": { borderColor: "primary.main" },
                  "&:focus": { borderColor: "primary.main", bgcolor: "action.hover" },
                }),
          }}
        />
      ) : (
        <Typography variant="body2" sx={{ color: "text.disabled", fontStyle: "italic", py: 0.5 }}>
          {t("aligner.noVersionText", { version: versionDisplay })}
        </Typography>
      )}
    </Box>
  );
});
