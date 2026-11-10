// Rapid check's pinned verse block: a compact version of the card view's
// scripture card (issue #830), plus verse navigation and lane toggles.
//
// One control line that never scrolls away: previous verse, a verse picker
// that also shows the reference, next verse, then the screen's extra controls
// (type filter, alignment chip) and one chip per scripture lane. A lane chip
// is filled while its lane shows and outlined while it is hidden, so a hidden
// lane can always be brought back from the same place.
//
// Below that, each shown lane is one compact line: a small label at the
// inline start, the verse text beside it (no grey box). Like the card view,
// the note's quote is highlighted with `mark`. In the "verses inline"
// placement (be:rapidVersePlacement) the lines are left out (`showLanes`) and
// each verse group in the list draws its own (RapidVerseLanes); the control
// line and the lane chips stay here.
//
// This component only draws. The lanes' text, the highlight, the verse list
// and every toggle come from TranslateNotesScreen. The card view keeps its
// own scripture card (`scriptureCard` and `Lane` there) unchanged.

import { Fragment, type ReactNode } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { FlowSegment } from "../../lib/flowHighlight";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface RapidLane {
  /** Stable id: the resource the pref is keyed by. */
  id: string;
  label: string;
  shown: boolean;
  onToggle: () => void;
  /** Accessible name of the lane's chip; it contains the label. */
  toggleLabel: string;
  text: string | null;
  segments: FlowSegment[];
  /** Replaces the text line while shown (the source lane's loading or error
   *  line, or its alignment strip). */
  body?: ReactNode;
  /** A note above the text line. */
  caption?: ReactNode;
  /** The chip can't be used yet (the lane's pref key isn't known). */
  disabled?: boolean;
  /** The body draws its own label (the alignment strip): leave the label cell empty. */
  bodyHasLabel?: boolean;
}

/** One verse of the chapter that has notes, as the picker lists it. */
export interface RapidVerseStop {
  key: string;
  label: string;
  count: number;
}

export interface RapidVerseBlockProps {
  /** The open note's reference, e.g. "OBA 1:3" or "OBA 1 intro". */
  reference: string;
  stops: RapidVerseStop[];
  currentKey: string | null;
  onGoTo: (key: string) => void;
  lanes: RapidLane[];
  mark: (segments: FlowSegment[]) => ReactNode;
  /** Extra controls on the control line (type filter, alignment chip). */
  controls?: ReactNode;
  /** A line under the lanes (the bridged-verse clamp hint). */
  footnote?: ReactNode;
  /** False in the "verses inline" placement: the lanes' text lines and the
   *  footnote are left out; the control line and the lane chips stay. */
  showLanes?: boolean;
}

const REF_LIGHT = "#014263"; // Ocean
const REF_DARK = "#70C9CC"; // Cultivate

export function RapidVerseBlock({
  reference,
  stops,
  currentKey,
  onGoTo,
  lanes,
  mark,
  controls,
  footnote,
  showLanes = true,
}: RapidVerseBlockProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const refColor = theme.palette.mode === "dark" ? REF_DARK : REF_LIGHT;
  // MUI does not flip icons under RTL by itself.
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;
  const at = currentKey == null ? -1 : stops.findIndex((s) => s.key === currentKey);
  const prev = at > 0 ? stops[at - 1] : null;
  const next = at >= 0 && at < stops.length - 1 ? stops[at + 1] : null;
  const shown = showLanes ? lanes.filter((l) => l.shown) : [];

  return (
    <Box
      data-rapid-verse-block=""
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "10px",
        paddingBlock: 0.5,
        paddingInline: 1,
        textAlign: "start",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexWrap: "wrap", rowGap: 0.5 }}>
        <IconButton
          size="small"
          aria-label={t("flowTranslate.rapid.nav.prevVerse")}
          title={t("flowTranslate.rapid.nav.prevVerseTitle")}
          disabled={!prev}
          onClick={() => prev && onGoTo(prev.key)}
          data-rapid-verse-prev=""
        >
          <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
        </IconButton>
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={at >= 0 ? currentKey! : ""}
          onChange={(e) => {
            if (e.target.value) onGoTo(String(e.target.value));
          }}
          renderValue={() => reference}
          displayEmpty
          // On the combobox itself (Select's own aria-label lands on a wrapper).
          inputProps={{ "aria-label": t("flowTranslate.rapid.nav.picker"), "data-rapid-verse-picker": "" }}
          // After a pick (or Esc) the keyboard goes back to the list, so the
          // shortcuts work at once; MUI would otherwise refocus the combobox.
          onClose={() => {
            requestAnimationFrame(() => {
              // Only when nothing else has taken focus meanwhile.
              const a = document.activeElement;
              if (a && a !== document.body && a.getAttribute("role") !== "combobox") return;
              document.querySelector<HTMLElement>("[data-rapid-check]")?.focus({ preventScroll: true });
            });
          }}
          sx={{
            fontSize: "0.875rem",
            fontWeight: 700,
            color: refColor,
            "& .MuiSelect-select": { paddingBlock: 0.25 },
          }}
          MenuProps={{ disableRestoreFocus: true, slotProps: { paper: { sx: { maxHeight: 360 } } } }}
        >
          {stops.map((s) => (
            <MenuItem key={s.key} value={s.key} dense>
              {t("flowTranslate.rapid.nav.option", { ref: s.label, count: s.count })}
            </MenuItem>
          ))}
        </Select>
        <IconButton
          size="small"
          aria-label={t("flowTranslate.rapid.nav.nextVerse")}
          title={t("flowTranslate.rapid.nav.nextVerseTitle")}
          disabled={!next}
          onClick={() => next && onGoTo(next.key)}
          data-rapid-verse-next=""
        >
          <ChevronRightIcon fontSize="small" sx={chevronFlip} />
        </IconButton>
        <Box sx={{ flex: 1 }} />
        {controls}
        {lanes.map((l) => (
          <Chip
            key={l.id}
            size="small"
            clickable
            variant={l.shown ? "filled" : "outlined"}
            color={l.shown ? "primary" : "default"}
            label={l.label}
            aria-pressed={l.shown}
            aria-label={l.toggleLabel}
            title={l.toggleLabel}
            onClick={l.onToggle}
            disabled={l.disabled}
            data-rapid-lane-toggle={l.id}
            sx={{ flex: "none", fontWeight: 700, letterSpacing: "0.04em" }}
          />
        ))}
      </Stack>
      {shown.length > 0 && (
        <Box
          sx={{
            mt: 0.25,
            maxHeight: "24vh",
            overflowY: "auto",
            display: "grid",
            gridTemplateColumns: "auto minmax(0, 1fr)",
            columnGap: 1.25,
            rowGap: 0.25,
            alignItems: "baseline",
            paddingInlineStart: 0.5,
          }}
        >
          {shown.map((l) => (
            <Fragment key={l.id}>
              <Box
                component="span"
                data-rapid-lane={l.id}
                sx={{ fontSize: "0.656rem", fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary" }}
              >
                {l.bodyHasLabel ? null : l.label}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                {l.caption}
                {l.body ??
                  (l.text ? (
                    // dir="auto" follows the content, as in the card view's Lane.
                    <Box
                      component="span"
                      dir="auto"
                      sx={{
                        display: "block",
                        textAlign: "start",
                        fontFamily: SCRIPTURE_FONT_STACK,
                        fontSize: "0.9375rem",
                        lineHeight: 1.5,
                      }}
                    >
                      {mark(l.segments)}
                    </Box>
                  ) : (
                    <Box component="em" sx={{ color: "text.secondary", fontSize: "0.8125rem" }}>
                      {t("flowTranslate.rapid.cols.laneEmpty", { label: l.label })}
                    </Box>
                  ))}
              </Box>
            </Fragment>
          ))}
        </Box>
      )}
      {showLanes && footnote}
    </Box>
  );
}
