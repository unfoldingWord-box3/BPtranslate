// Read-only ULT alignment strip (issue #431): the source ULT lane on the flows
// notes screen, drawn so a translator can see which English words render which
// original-language words. Original words on one row (RTL for Hebrew, LTR for
// Greek), the ULT prose below; pointing at a word on either side lights its
// alignment group on both. The note's quote keeps the #430 <mark> tint.
//
// Desktop: hover. Phone: tap-to-select (tap again, or tap another word, to
// move it) — the #269 tap path, since a touch screen has no hover. A click
// also pins on desktop, so the reader can pin a group and read on.
//
// Nothing here edits or writes. Words wrap (#202); the strip never scrolls
// sideways.
//
// Lexicon (#432): pointing at an ORIGINAL word also opens a small popover
// under it with the word's lemma, morphology and UHAL/UGL entry — the verse
// screen's WordCard, fed by useLexicon. Every Strong's in the note's verses is
// requested once when the strip mounts, so the popover is instant and the
// note costs one batched /api/lexicon call. Unrendered original words stay
// muted but open the popover too: "what is this word nobody translated?" is
// exactly when a reader needs the dictionary.

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Popper from "@mui/material/Popper";
import { alpha, useTheme } from "@mui/material/styles";

import {
  litUp,
  sameFocus,
  stripStrongs,
  type AlignmentStripSlice,
  type StripFocus,
} from "./alignmentStripModel";
import { ORIGINAL_FONT_STACK, WordCard } from "./VerseDetailPane";
import { useLexicon } from "../../hooks/useLexicon";
import { SCRIPTURE_FONT_STACK } from "../../theme";

// Kindle — the "linked partner" tone the classic aligner's hover glow uses
// (highlightTypes.hoverShadow), so the quote tint (Inspire blue) and the
// alignment highlight stay distinguishable when they overlap.
const KINDLE = "#E59D33";

export interface UltAlignmentStripProps {
  label: string;
  slices: AlignmentStripSlice[];
  originalLabel: string;
  originalDir: "ltr" | "rtl";
  labelFontFamily: string | undefined;
  /** The note-quote tint — the same colour as the plain lanes' <mark>. */
  quoteBg: string;
}

const isMouse = (e: PointerEvent) => e.pointerType === "mouse";

export function UltAlignmentStrip({
  label,
  slices,
  originalLabel,
  originalDir,
  labelFontFamily,
  quoteBg,
}: UltAlignmentStripProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const litBg = alpha(KINDLE, theme.palette.mode === "dark" ? 0.4 : 0.28);
  const [hover, setHover] = useState<StripFocus>(null);
  // The caller keys this component by note id, so a different note remounts
  // it with no focus; a re-derived `slices` for the same note keeps it.
  const [pinned, setPinned] = useState<StripFocus>(null);
  const focus = hover ?? pinned;
  const toggle = (next: StripFocus) => setPinned((cur) => (sameFocus(cur, next) ? null : next));

  // Prefetch the whole note's Strong's in one batch (#432).
  const strongs = useMemo(() => stripStrongs(slices), [slices]);
  const lexicon = useLexicon(strongs);
  // The popover anchors on the focused original word's button.
  const origEls = useRef(new Map<string, HTMLElement>());
  const origKey = (slice: number, position: number) => `${slice}:${position}`;
  const lexFocus = focus?.side === "original" ? focus : null;
  const lexWord = lexFocus ? slices[lexFocus.slice]?.words[lexFocus.position] ?? null : null;
  const lexAnchor = lexFocus ? origEls.current.get(origKey(lexFocus.slice, lexFocus.position)) ?? null : null;
  // Hover-only (desktop, not pinned): let the pointer pass through the
  // popover, so it never sits between the mouse and the next line of words.
  const lexHoverOnly = hover?.side === "original" && !sameFocus(hover, pinned);
  const lexPaper = useRef<HTMLDivElement>(null);

  // A pinned popover covers the words under it, so it also closes on Escape
  // and on a press outside both the popover and its word (#432). Pressing the
  // word itself keeps the existing toggle; pressing another word moves the pin
  // there (its own click re-pins after this clears).
  const pinnedOrig = pinned?.side === "original" ? pinned : null;
  const pinnedKey = pinnedOrig ? origKey(pinnedOrig.slice, pinnedOrig.position) : null;
  useEffect(() => {
    if (!pinnedKey) return;
    const onPointerDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (lexPaper.current?.contains(target) || origEls.current.get(pinnedKey)?.contains(target))) return;
      setPinned(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setPinned(null);
      setHover(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pinnedKey]);

  const wordSx = (lit: boolean, quoted: boolean, muted: boolean) => ({
    appearance: "none",
    border: 0,
    font: "inherit",
    color: muted ? "text.secondary" : "text.primary",
    background: lit ? litBg : quoted ? quoteBg : "transparent",
    boxShadow: lit ? `inset 0 -2px 0 ${KINDLE}` : "none",
    borderRadius: "3px",
    padding: 0,
    paddingInline: "1px",
    cursor: muted ? "default" : "pointer",
    "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 1 },
  });

  return (
    <Box
      data-align-strip=""
      sx={{
        bgcolor: "action.hover",
        borderRadius: "9px",
        paddingBlock: 1.25,
        paddingInline: 1.5,
        mb: 1,
        overflowWrap: "anywhere",
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
        {t("flowTranslate.alignmentStripLabel", { label, original: originalLabel })}
      </Box>
      <Box
        component="span"
        sx={{ display: "block", fontFamily: labelFontFamily, fontSize: "0.75rem", color: "text.secondary", mb: 0.75 }}
      >
        {t("flowTranslate.alignmentStripHint")}
      </Box>
      {slices.map((slice, si) => {
        const lit = litUp(slice, si, focus);
        return (
          <Box
            key={slice.verse}
            sx={si > 0 ? { mt: 1.25, pt: 1.25, borderBlockStart: "1px solid", borderColor: "divider" } : undefined}
          >
            {slices.length > 1 && (
              <Box
                component="span"
                role="img"
                aria-label={t("flowScripture.verseBoundary", { verse: slice.verse })}
                sx={{ display: "block", fontFamily: labelFontFamily, fontSize: "0.72rem", fontWeight: 700, color: "text.secondary" }}
              >
                {slice.verse}
              </Box>
            )}
            <Box
              dir={originalDir}
              lang={originalDir === "rtl" ? "hbo" : "grc"}
              role="group"
              aria-label={originalLabel}
              sx={{ fontFamily: ORIGINAL_FONT_STACK, fontSize: "1.3rem", lineHeight: 1.9, textAlign: "start" }}
            >
              {slice.words.map((w) => {
                const muted = !slice.alignedPositions.has(w.position);
                const on = lit.positions.has(w.position);
                const here: StripFocus = { slice: si, side: "original", position: w.position };
                const key = origKey(si, w.position);
                return (
                  <Box
                    key={w.position}
                    ref={(el: HTMLElement | null) => {
                      if (el) origEls.current.set(key, el);
                      else origEls.current.delete(key);
                    }}
                    component="button"
                    type="button"
                    data-align-orig={w.position}
                    data-lit={on ? "true" : undefined}
                    data-quoted={slice.quotedPositions.has(w.position) ? "true" : undefined}
                    data-unrendered={muted ? "true" : undefined}
                    aria-pressed={sameFocus(pinned, here)}
                    aria-describedby={sameFocus(lexFocus, here) ? "ult-align-lex" : undefined}
                    // Not disabled when muted (#432): an unrendered word lights
                    // nothing, but still opens its lexicon popover.
                    onPointerEnter={(e: PointerEvent) => isMouse(e) && setHover(here)}
                    onPointerLeave={(e: PointerEvent) => isMouse(e) && setHover(null)}
                    onClick={() => toggle(here)}
                    sx={{
                      ...wordSx(on, slice.quotedPositions.has(w.position), muted),
                      cursor: "pointer",
                      marginInlineEnd: "0.3em",
                    }}
                  >
                    {w.text}
                  </Box>
                );
              })}
            </Box>
            {/* dir="auto" like the plain lane: the English ULT resolves LTR
                even inside the Arabic UI. */}
            <Box
              dir="auto"
              role="group"
              aria-label={label}
              sx={{ fontFamily: SCRIPTURE_FONT_STACK, fontSize: "1.03rem", lineHeight: 1.7, textAlign: "start", mt: 0.5 }}
            >
              {slice.lane.prose.map((tok, i) => {
                if (tok.kind === "text") return <span key={`t${i}`}>{tok.text}</span>;
                const groupId = tok.groupId;
                const on = groupId !== null && lit.groups.has(groupId);
                const quoted = slice.quotedWordIds.has(tok.id);
                const here: StripFocus = groupId ? { slice: si, side: "target", groupId } : null;
                return (
                  <Box
                    key={tok.id}
                    component="button"
                    type="button"
                    data-align-en={tok.text}
                    data-lit={on ? "true" : undefined}
                    data-quoted={quoted ? "true" : undefined}
                    data-supplied={groupId ? undefined : "true"}
                    aria-pressed={here ? sameFocus(pinned, here) : undefined}
                    // A supplied word has nothing behind it to light; it stays
                    // readable but inert.
                    disabled={!here}
                    onPointerEnter={(e: PointerEvent) => here && isMouse(e) && setHover(here)}
                    onPointerLeave={(e: PointerEvent) => here && isMouse(e) && setHover(null)}
                    onClick={() => here && toggle(here)}
                    sx={wordSx(on, quoted, !here)}
                  >
                    {tok.text}
                  </Box>
                );
              })}
            </Box>
          </Box>
        );
      })}
      <Popper
        id="ult-align-lex"
        open={Boolean(lexWord && lexAnchor)}
        anchorEl={lexAnchor}
        placement="bottom"
        sx={{ zIndex: theme.zIndex.tooltip, pointerEvents: lexHoverOnly ? "none" : "auto" }}
      >
        {lexWord && (
          <Paper ref={lexPaper} data-lex-popover="" elevation={6} sx={{ maxWidth: 300, borderRadius: 1.5 }}>
            <WordCard
              word={lexWord}
              entry={lexicon.get(lexWord.strong) ?? null}
              originalDir={originalDir}
              flush
            />
          </Paper>
        )}
      </Popper>
    </Box>
  );
}
