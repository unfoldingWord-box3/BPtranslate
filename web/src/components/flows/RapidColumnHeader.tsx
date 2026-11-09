// Rapid check's column header row, with the column toggles and the keyboard
// shortcut list.
//
// The original-language quote column and the English note column each carry
// a small hide button in their own header. A hidden column becomes a small
// "+ name" chip at the inline end of this same row, so it can always be
// brought back from where it was turned off. That costs no width in the rows
// (a collapsed stub column would, in every row, and would need sideways text,
// which reads badly in Arabic). The target note column has no hide button: it
// is where the editing happens.
//
// Focus follows the toggle: hiding a column removes the button that was
// pressed, so focus moves to that column's restore chip, and back to the hide
// button when it is restored. Without that, focus would fall to <body> and the
// list's keyboard shortcuts would stop working.

import { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import AddIcon from "@mui/icons-material/Add";
import KeyboardOutlinedIcon from "@mui/icons-material/KeyboardOutlined";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { RapidColumn } from "../../lib/editorPrefs";

export interface RapidColumnHeaderProps {
  /** The grid template the rows use, so the header cells line up. */
  cols: string;
  sourceLabel: string;
  targetLabel: string;
  showQuote: boolean;
  onToggleQuote: () => void;
  /** Translation-mode workspaces have an English note column. */
  englishAvailable: boolean;
  showEnglish: boolean;
  onToggleEnglish: () => void;
  /** The U key is offered (the screen has a source ULT lane). */
  sourceUltKey: boolean;
}

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

export function RapidColumnHeader({
  cols,
  sourceLabel,
  targetLabel,
  showQuote,
  onToggleQuote,
  englishAvailable,
  showEnglish,
  onToggleEnglish,
  sourceUltKey,
}: RapidColumnHeaderProps) {
  const { t } = useTranslation();
  // Popover origins are physical; open toward the inline end in both directions.
  const side = useTheme().direction === "rtl" ? "right" : "left";
  const rowRef = useRef<HTMLDivElement>(null);
  const [keysAnchor, setKeysAnchor] = useState<HTMLElement | null>(null);
  const englishCol = englishAvailable && showEnglish;
  const englishName = t("flowTranslate.englishNote");

  // After a toggle by click, put focus on the control that replaced the one
  // pressed (see the header comment).
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const sel = pendingFocus.current;
    if (!sel) return;
    pendingFocus.current = null;
    rowRef.current?.querySelector<HTMLElement>(sel)?.focus();
  }, [showQuote, showEnglish]);

  const toggle = (col: RapidColumn, hiding: boolean) => {
    pendingFocus.current = hiding ? `[data-rapid-col-show="${col}"]` : `[data-rapid-col-hide="${col}"]`;
    if (col === "quote") onToggleQuote();
    else onToggleEnglish();
  };

  const hideButton = (col: RapidColumn, name: string) => (
    <IconButton
      size="small"
      aria-label={t("flowTranslate.rapid.cols.hide", { name })}
      title={t("flowTranslate.rapid.cols.hide", { name })}
      data-rapid-col-hide={col}
      onClick={() => toggle(col, true)}
      sx={{ padding: "5px", margin: "-3px", color: "text.secondary", opacity: 0.75, "&:hover, &:focus-visible": { opacity: 1 } }}
    >
      <VisibilityOffOutlinedIcon sx={{ fontSize: 14 }} />
    </IconButton>
  );

  const restoreChip = (col: RapidColumn, name: string) => (
    <Chip
      size="small"
      variant="outlined"
      clickable
      icon={<AddIcon />}
      label={name}
      aria-label={t("flowTranslate.rapid.cols.show", { name })}
      title={t("flowTranslate.rapid.cols.show", { name })}
      data-rapid-col-show={col}
      onClick={() => toggle(col, false)}
      sx={{ flex: "none", height: 22, fontSize: "0.6875rem", fontWeight: 700, "& .MuiChip-icon": { fontSize: 14 } }}
    />
  );

  const keys: [string[], string][] = [
    [["J", "K"], t("flowTranslate.rapid.keyMove")],
    [["[", "]"], t("flowTranslate.rapid.nav.keyVerse")],
    [["Enter"], t("flowTranslate.rapid.keyEdit")],
    [["A"], t("flowTranslate.rapid.keyApprove")],
    [["Ctrl", "Enter"], t("flowTranslate.rapid.keySaveApprove")],
    [["Esc"], t("flowTranslate.rapid.keyClose")],
    ...(englishAvailable ? [[["E"], t("flowTranslate.rapid.cols.keyEnglish")] as [string[], string]] : []),
    ...(sourceUltKey ? [[["U"], t("flowTranslate.rapid.cols.keySourceUlt")] as [string[], string]] : []),
  ];

  return (
    <Box
      ref={rowRef}
      sx={{
        mt: 0.75,
        display: "grid",
        gridTemplateColumns: cols,
        gap: 1.5,
        alignItems: "center",
        paddingBlock: 0.25,
        paddingInlineEnd: 1,
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderBottomWidth: 0,
        borderRadius: "10px 10px 0 0",
      }}
    >
      <Box sx={{ display: "flex", justifyContent: "center" }}>
        <IconButton
          size="small"
          aria-label={t("flowTranslate.rapid.cols.keys")}
          title={t("flowTranslate.rapid.cols.keys")}
          aria-haspopup="dialog"
          aria-expanded={keysAnchor != null}
          onClick={(e) => setKeysAnchor(e.currentTarget)}
          data-rapid-keys=""
          sx={{ padding: "3px", color: "text.secondary" }}
        >
          <KeyboardOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
        <Popover
          open={keysAnchor != null}
          anchorEl={keysAnchor}
          onClose={() => setKeysAnchor(null)}
          // Keys typed while the list is open must not act on the notes
          // behind it (React bubbles portal events to the list's handler).
          onKeyDown={(e) => e.stopPropagation()}
          anchorOrigin={{ vertical: "bottom", horizontal: side }}
          transformOrigin={{ vertical: "top", horizontal: side }}
          slotProps={{
            paper: { role: "dialog", "aria-label": t("flowTranslate.rapid.cols.keys"), sx: { p: 1.5, maxWidth: 360 } },
          }}
        >
          <Box
            component="dl"
            sx={{ m: 0, display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 1.5, rowGap: 0.75, fontSize: "0.8125rem" }}
          >
            {keys.map(([ks, what]) => (
              <Box key={ks.join("+")} sx={{ display: "contents" }}>
                <Box component="dt" sx={{ display: "flex", gap: 0.5 }}>
                  {ks.map((k) => (
                    // dir="ltr": "[" and "]" would be drawn mirrored in Arabic.
                    <Box key={k} component="kbd" dir="ltr" sx={kbdSx}>{k}</Box>
                  ))}
                </Box>
                <Box component="dd" sx={{ m: 0 }}>{what}</Box>
              </Box>
            ))}
          </Box>
        </Popover>
      </Box>
      <Box component="span" sx={headSx}>{t("flowTranslate.rapid.colNote")}</Box>
      {showQuote && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
          <Box component="span" sx={headSx}>{sourceLabel}</Box>
          {hideButton("quote", sourceLabel)}
        </Box>
      )}
      {englishCol && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
          <Box component="span" sx={headSx}>{englishName}</Box>
          {hideButton("english", englishName)}
        </Box>
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
        <Box component="span" sx={{ ...headSx, flex: 1, minWidth: 0 }}>
          {t("flowTranslate.rapid.colTarget", { target: targetLabel })}
        </Box>
        {!showQuote && restoreChip("quote", sourceLabel)}
        {englishAvailable && !showEnglish && restoreChip("english", englishName)}
      </Box>
    </Box>
  );
}
