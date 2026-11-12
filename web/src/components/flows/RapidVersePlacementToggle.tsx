// Rapid check's "Verse: Top | Inline" switch, on the pinned block's control
// line next to the lane chips. Two plain aria-pressed buttons (not a radio
// group): the list's key handler turns bubbled arrow keys into J/K, so arrow
// keys inside a radio group would move the note cursor instead. Tab reaches
// each button; Enter and Space press it, and V (handled by the list) flips it.

import Box from "@mui/material/Box";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { useTranslation } from "react-i18next";
import type { RapidVersePlacement } from "../../lib/editorPrefs";

export function RapidVersePlacementToggle({
  value,
  onChange,
}: {
  value: RapidVersePlacement;
  onChange: (next: RapidVersePlacement) => void;
}) {
  const { t } = useTranslation();
  const btnSx = { paddingBlock: 0, paddingInline: 1, fontSize: "0.75rem", fontWeight: 700, textTransform: "none" } as const;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flex: "none" }}>
      <Box component="span" aria-hidden sx={{ fontSize: "0.75rem", fontWeight: 700, color: "text.secondary" }}>
        {t("flowTranslate.rapid.verse.label")}
      </Box>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={value}
        onChange={(_, next: RapidVersePlacement | null) => {
          // Pressing the selected button again gives null: keep the choice.
          if (next) onChange(next);
        }}
        aria-label={t("flowTranslate.rapid.verse.groupAria")}
        data-rapid-verse-placement={value}
        sx={{ height: 24 }}
      >
        <ToggleButton
          value="top"
          title={t("flowTranslate.rapid.verse.topTitle")}
          data-rapid-verse-placement-option="top"
          sx={btnSx}
        >
          {t("flowTranslate.rapid.verse.top")}
        </ToggleButton>
        <ToggleButton
          value="inline"
          title={t("flowTranslate.rapid.verse.inlineTitle")}
          data-rapid-verse-placement-option="inline"
          sx={btnSx}
        >
          {t("flowTranslate.rapid.verse.inline")}
        </ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}
