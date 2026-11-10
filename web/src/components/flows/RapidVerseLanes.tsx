// Rapid check, type-filter mode: the compact scripture lanes drawn above each
// verse group (mockup board C, design PR #825; issue #831). The pinned verse
// block at the top still shows the open note's full card; these lanes let the
// translator read every listed verse without opening one of its notes.
//
// Drawing only. TranslateNotesScreen hands in the lane indexes it already
// builds for the pinned block, the verse, and the quotes of the notes listed
// in that verse; every listed note's quote is marked (flowLaneSegmentsForQuotes).
// Memoized: the screen re-renders on every keystroke in the editor, and the
// highlight walk should run only when a verse's lanes or quotes change.

import { Fragment, memo, useMemo, type ReactNode } from "react";
import Box from "@mui/material/Box";
import { useTranslation } from "react-i18next";
import type { VerseDto } from "../../sync/api";
import { coveredLaneSlices } from "../../lib/verseRange";
import { flowLaneSegmentsForQuotes, type FlowQuote, type FlowSegment } from "../../lib/flowHighlight";
import { SCRIPTURE_FONT_STACK } from "../../theme";
import { arabicFontSize, startsArabicScript } from "../../lib/arabicScriptSize";

export interface RapidLaneSpec {
  key: string;
  label: string;
  index: Record<number, VerseDto>;
}

export interface RapidVerseLanesProps {
  verse: number;
  /** "ZEC 13:2", for the group's accessible name. */
  refLabel: string;
  /** In display order. Hidden lanes are simply left out by the caller. */
  lanes: RapidLaneSpec[];
  sourceIndex: Record<number, VerseDto>;
  /** The quotes of the notes listed in this verse (stable identity per change). */
  quotes: readonly FlowQuote[];
  mark: (segments: FlowSegment[]) => ReactNode;
}

export const RapidVerseLanes = memo(function RapidVerseLanes({
  verse,
  refLabel,
  lanes,
  sourceIndex,
  quotes,
  mark,
}: RapidVerseLanesProps) {
  const { t } = useTranslation();
  const drawn = useMemo(
    () =>
      lanes.map((lane) => {
        const { slices, plainText } = coveredLaneSlices(lane.index, sourceIndex, [verse]);
        return {
          key: lane.key,
          label: lane.label,
          text: plainText,
          arabic: startsArabicScript(plainText),
          segments: plainText ? flowLaneSegmentsForQuotes(slices, quotes) : [],
        };
      }),
    [lanes, sourceIndex, verse, quotes],
  );
  if (drawn.length === 0) return null;
  // The pinned verse block's lane styling (RapidVerseBlock), so the two
  // look alike: a small label at the inline start, the text beside it.
  return (
    <Box
      role="group"
      aria-label={t("flowTranslate.rapid.lanes.groupAria", { ref: refLabel })}
      data-rapid-lanes={verse}
      sx={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        columnGap: 1.25,
        rowGap: 0.25,
        alignItems: "baseline",
        minWidth: 0,
        fontWeight: 400,
        color: "text.primary",
      }}
    >
      {drawn.map((lane) => (
        <Fragment key={lane.key}>
          <Box
            component="span"
            data-rapid-group-lane={lane.key}
            sx={{ fontSize: "0.656rem", fontWeight: 700, letterSpacing: "0.08em", color: "text.secondary" }}
          >
            {lane.label}
          </Box>
          {lane.text ? (
            // dir="auto" follows the content, as in the pinned block: an
            // Arabic literal lays out RTL with its punctuation on the
            // correct side, the English ULT stays LTR. Arabic is drawn a
            // size larger to match the English.
            <Box
              component="p"
              dir="auto"
              data-rapid-group-lane-text={lane.key}
              sx={{
                m: 0,
                textAlign: "start",
                fontFamily: SCRIPTURE_FONT_STACK,
                fontSize: arabicFontSize("0.9375rem", lane.arabic),
                lineHeight: 1.5,
                minWidth: 0,
              }}
            >
              {mark(lane.segments)}
            </Box>
          ) : (
            <Box component="em" sx={{ color: "text.secondary", fontSize: "0.8125rem" }}>
              {t("flowTranslate.rapid.cols.laneEmpty", { label: lane.label })}
            </Box>
          )}
        </Fragment>
      ))}
    </Box>
  );
});
