// "Start an AI run" action for flow screens (#481). Wraps the shared
// PipelineMenu (the one the classic editor and the AI studio use — not a
// re-implementation) so editors can start a chapter run where they already are.
//
// Placement comes from aiRunPlacement: an icon button in the header row on
// tablet and desktop; at the phone band an item in the account menu
// (Benjamin's decision on #481, 2026-11-02), so the crowded phone header
// (#517) gains no button and page titles keep their room. Viewers get nothing.
//
// The account menu is mounted once by App.tsx, outside the screen, so the
// screen registers its action through FlowAccountAiRunContext. The
// PipelineMenu itself (its menu, confirm and conflict dialogs) stays mounted
// here in the screen: closing the account menu must not unmount it, and the
// screen owns the chapter and the refetch after a Door43 import.
import { createContext, useContext, useEffect, useState } from "react";
import { IconButton, Snackbar, Tooltip } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useTranslation } from "react-i18next";
import { PipelineMenu } from "../PipelineMenu";
import { aiRunPlacement } from "../../lib/aiRunPlacement";
import type { Role } from "../../sync/api";

/** Opens the screen's pipeline menu anchored to the given element. */
export type OpenAiRun = (anchor: HTMLElement) => void;

/**
 * Set by App.tsx around the flow screens. A screen at the phone band registers
 * its OpenAiRun here (null on unmount); AccountMenu shows "Start an AI run"
 * while one is registered.
 */
export const FlowAccountAiRunContext = createContext<(open: OpenAiRun | null) => void>(() => {});

function RegisterInAccountMenu({ open }: { open: OpenAiRun }) {
  const register = useContext(FlowAccountAiRunContext);
  useEffect(() => {
    register(open);
    return () => register(null);
  }, [register, open]);
  return null;
}

type Props = {
  book: string;
  chapter: number;
  role: Role;
  /** True below the tablet band (theme breakpoint `tablet`, layoutBands.ts). */
  phone: boolean;
  onImported?: () => void;
};

export function FlowAiRunAction({ book, chapter, role, phone, onImported }: Props) {
  const { t } = useTranslation();
  const placement = aiRunPlacement(role, phone ? "phone" : "tablet");
  // Own toast, not the host's: the hosts' save toasts close after 1.4s, too
  // short to read "This organization has no AI key set up…" and the like.
  const [msg, setMsg] = useState<string | null>(null);
  if (placement === "hidden") return null;

  return (
    <>
    <Snackbar
      open={msg !== null}
      message={msg ?? ""}
      autoHideDuration={6000}
      onClose={() => setMsg(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      // Clear the work screens' bottom action bar.
      sx={{ bottom: 96 }}
    />
    <PipelineMenu
      book={book}
      // Intros and book notes sit at chapter 0; a run covers chapter 1 and up.
      chapter={Math.max(1, chapter)}
      onMessage={setMsg}
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
          <RegisterInAccountMenu open={open} />
        )
      }
    />
    </>
  );
}
