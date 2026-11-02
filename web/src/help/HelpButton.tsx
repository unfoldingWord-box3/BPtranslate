import { useContext } from "react";
import { IconButton, Tooltip } from "@mui/material";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { useTranslation } from "react-i18next";
import { HelpContext } from "./HelpContext";

export function HelpButton() {
  const { t } = useTranslation();
  const { openHelp } = useContext(HelpContext);
  return (
    <Tooltip title={t("help.open")}>
      <IconButton
        size="small"
        aria-label={t("help.open")}
        onClick={() => openHelp()}
        sx={{ color: "text.secondary", flexShrink: 0 }}
      >
        <HelpOutlineIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
