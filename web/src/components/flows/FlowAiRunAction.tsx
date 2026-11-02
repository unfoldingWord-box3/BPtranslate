// "Start an AI run" action for flow screens (#481). Wraps the shared
// PipelineMenu (the one the classic editor and the AI studio use — not a
// re-implementation) so editors can start a chapter run where they already are.
//
// Placement comes from aiRunPlacement: an icon button in the header row on
// tablet and desktop; at the phone band an item in the account menu
// (Benjamin's decision on #481, 2026-11-02), so the crowded phone header
// (#517) gains no button and page titles keep their room. Viewers get nothing.
// In a source project (the English root) there is no AI action, so the same
// trigger is labelled and iconed as "Import from Door43" (#731,
// lib/pipelineTrigger.ts); AccountMenu does the same for the phone item.
//
// A hook, not a component, because it has two parts that mount in different
// places:
//   - `action`: the PipelineMenu (its menu, confirm and conflict dialogs) and
//     the toast. The screen mounts it OUTSIDE its focus-mode header
//     conditional, so entering focus mode while editing never drops an open
//     dialog, a toast, or the account-menu registration.
//   - `headerButton`: the top-bar icon (tablet and desktop only), which goes
//     in the header row.
// The account menu is mounted once by App.tsx, outside the screen, so at the
// phone band the screen registers its action through FlowAccountAiRunContext.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { IconButton, Snackbar, Tooltip } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import { useTranslation } from "react-i18next";
import { PipelineMenu } from "../PipelineMenu";
import { aiRunPlacement } from "../../lib/aiRunPlacement";
import { pipelineTrigger } from "../../lib/pipelineTrigger";
import { projectType, useProjectConfig } from "../../hooks/useProjectConfig";
import type { Role } from "../../sync/api";

/** Opens the screen's pipeline menu anchored to the given element. */
export type OpenAiRun = (anchor: HTMLElement) => void;

/**
 * Set by App.tsx around the flow screens. A screen at the phone band registers
 * its OpenAiRun here (null on unmount); AccountMenu shows "Start an AI run"
 * ("Import from Door43" in a source project, #731) while one is registered.
 */
export const FlowAccountAiRunContext = createContext<(open: OpenAiRun | null) => void>(() => {});

// Hands PipelineMenu's open function to `expose` while mounted.
function Expose({ open, expose }: { open: OpenAiRun; expose: (open: OpenAiRun | null) => void }) {
  useEffect(() => {
    expose(open);
    return () => expose(null);
  }, [expose, open]);
  return null;
}

type Options = {
  book: string;
  chapter: number;
  role: Role;
  /** True below the tablet band (theme breakpoint `tablet`, layoutBands.ts). */
  phone: boolean;
  onImported?: () => void;
};

export function useFlowAiRun({ book, chapter, role, phone, onImported }: Options): {
  action: ReactNode;
  headerButton: ReactNode;
} {
  const { t } = useTranslation();
  const placement = aiRunPlacement(role, phone ? "phone" : "tablet");
  const registerInAccountMenu = useContext(FlowAccountAiRunContext);
  const trigger = pipelineTrigger(projectType(useProjectConfig()));
  const [open, setOpenState] = useState<OpenAiRun | null>(null);
  const setOpen = useCallback((fn: OpenAiRun | null) => setOpenState(() => fn), []);
  // Own toast, not the host's: the hosts' save toasts close after 1.4s, too
  // short to read "This organization has no AI key set up…" and the like.
  const [msg, setMsg] = useState<string | null>(null);
  if (placement === "hidden") return { action: null, headerButton: null };

  const onPhone = placement === "accountMenu";
  const action = (
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
        // On a phone the menu opens from the avatar at the bar's end: drop it
        // below the avatar instead of over it.
        menuBelowEnd={onPhone}
        renderTrigger={(o) => <Expose open={o} expose={onPhone ? registerInAccountMenu : setOpen} />}
      />
    </>
  );
  const headerButton =
    !onPhone && open ? (
      <Tooltip title={t(trigger.actionKey)}>
        <IconButton
          size="small"
          aria-label={t(trigger.actionKey)}
          onClick={(e) => open(e.currentTarget)}
          sx={{ flex: "none" }}
        >
          {trigger.kind === "import" ? <CloudDownloadIcon fontSize="small" /> : <AutoAwesomeIcon fontSize="small" />}
        </IconButton>
      </Tooltip>
    ) : null;
  return { action, headerButton };
}
