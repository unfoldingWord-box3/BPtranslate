// "Start an AI run" header action for flow screens (#481). Wraps the shared
// PipelineMenu (the one the classic editor and the AI studio use — not a
// re-implementation) so editors can start a chapter run where they already are.
//
// Placement is decision A on #481, via aiRunPlacement: an icon button in the
// header row on tablet and desktop; at the phone band a "more" button whose
// menu holds the AI item, so the crowded phone header (#517) gains one button
// either way. Viewers get nothing — not even an empty "more" menu.
//
// The pipeline menu anchors to the "more" button, never to the overflow item:
// that item unmounts as soon as the overflow menu closes.
import { useRef, useState } from "react";
import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Tooltip } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { useTranslation } from "react-i18next";
import { PipelineMenu } from "../PipelineMenu";
import { aiRunPlacement } from "../../lib/aiRunPlacement";
import type { Role } from "../../sync/api";

type Props = {
  book: string;
  chapter: number;
  role: Role;
  /** True below the tablet band (theme breakpoint `tablet`, layoutBands.ts). */
  phone: boolean;
  onMessage?: (msg: string) => void;
  onImported?: () => void;
};

export function FlowAiRunAction({ book, chapter, role, phone, onMessage, onImported }: Props) {
  const { t } = useTranslation();
  const placement = aiRunPlacement(role, phone ? "phone" : "tablet");
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  if (placement === "hidden") return null;

  return (
    <PipelineMenu
      book={book}
      chapter={chapter}
      onMessage={onMessage}
      onImported={onImported}
      renderTrigger={(open) =>
        placement === "topbar" ? (
          <Tooltip title={t("pipeline.startAiRun")}>
            <IconButton
              size="small"
              aria-label={t("pipeline.startAiRun")}
              onClick={(e) => open(e.currentTarget)}
              sx={{ flex: "none" }}
            >
              <AutoAwesomeIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : (
          <>
            <IconButton
              ref={moreRef}
              size="small"
              aria-label={t("pipeline.moreActions")}
              aria-haspopup="menu"
              onClick={() => setMoreOpen(true)}
              sx={{ flex: "none" }}
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu anchorEl={moreRef.current} open={moreOpen} onClose={() => setMoreOpen(false)}>
              <MenuItem
                onClick={() => {
                  setMoreOpen(false);
                  if (moreRef.current) open(moreRef.current);
                }}
              >
                <ListItemIcon>
                  <AutoAwesomeIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t("pipeline.startAiRun")} />
              </MenuItem>
            </Menu>
          </>
        )
      }
    />
  );
}
