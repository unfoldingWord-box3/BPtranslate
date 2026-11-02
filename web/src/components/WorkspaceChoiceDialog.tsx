// One-time workspace picker for a first login that matches SEVERAL Door43
// orgs (the OAuth callback redirects with ?_choose_ws=1 — case (d) of the
// login-time workspace resolution in api/src/workspaces.ts). The server has
// already landed the session in the FIRST match, so closing the dialog
// without choosing is safe; picking another org runs the exact switch flow
// WorkspaceSwitcher uses (api.switchWorkspace → persist mirror → reload).
//
// The prompt must survive App.tsx's boot-time workspace reconciliation,
// which reloads the tab once to realign localStorage with the fresh be_ws
// cookie — hence the sessionStorage flag helpers below rather than plain
// component state keyed off the (already-stripped) query param.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import BusinessIcon from "@mui/icons-material/Business";
import { api, type WorkspaceInfo } from "../sync/api";
import { setWorkspaceSlug } from "../sync/workspace";

const CHOOSE_WS_KEY = "bible-editor.choose-ws";

export function markChooseWsPending(): void {
  try {
    sessionStorage.setItem(CHOOSE_WS_KEY, "1");
  } catch {
    /* private mode — the prompt just won't survive the reconciliation reload */
  }
}

export function isChooseWsPending(): boolean {
  try {
    return sessionStorage.getItem(CHOOSE_WS_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearChooseWsPending(): void {
  try {
    sessionStorage.removeItem(CHOOSE_WS_KEY);
  } catch {
    /* private mode */
  }
}

export function WorkspaceChoiceDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Two distinct failures, two distinct recoveries: a failed LIST load leaves
  // nothing to render (alert replaces the list); a failed SWITCH must keep the
  // already-loaded list on screen with an inline error so the user can retry
  // or pick a different org.
  const [loadFailed, setLoadFailed] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listWorkspaces()
      .then((res) => {
        if (cancelled) return;
        setWorkspaces(res.workspaces.filter((w) => w.allowed));
        setCurrent(res.current);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    clearChooseWsPending();
    onClose();
  };

  const choose = async (w: WorkspaceInfo) => {
    if (switching) return;
    if (w.slug === current) {
      // Already where the server landed us — persist the mirror and move on.
      setWorkspaceSlug(w.slug);
      dismiss();
      return;
    }
    setSwitching(w.slug);
    setSwitchFailed(false);
    try {
      await api.switchWorkspace(w.slug);
      setWorkspaceSlug(w.slug);
      clearChooseWsPending();
      // Deliberate full reload, same as WorkspaceSwitcher: no hook state from
      // the previous org may survive the D1 rebind.
      location.reload();
    } catch {
      // Keep the list rendered and the buttons enabled — the user can retry
      // this org or pick another; only the inline error appears.
      setSwitching(null);
      setSwitchFailed(true);
    }
  };

  return (
    <Dialog open onClose={dismiss} maxWidth="xs" fullWidth>
      <DialogTitle>{t("workspace.chooseTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1 }}>
          {t("workspace.chooseIntro")}
        </DialogContentText>
        {loading ? (
          <Stack alignItems="center" sx={{ py: 2 }}>
            <CircularProgress size={24} />
          </Stack>
        ) : loadFailed ? (
          <Alert severity="warning">{t("workspace.chooseFailed")}</Alert>
        ) : (
          <>
            {switchFailed && (
              <Alert severity="warning" sx={{ mb: 1 }}>
                {t("workspace.switchFailed")}
              </Alert>
            )}
            <List dense>
              {workspaces.map((w) => (
                <ListItemButton
                  key={w.slug}
                  disabled={switching !== null}
                  selected={w.slug === current}
                  onClick={() => void choose(w)}
                >
                  <ListItemIcon>
                    {w.slug === current ? (
                      <CheckIcon fontSize="small" />
                    ) : (
                      <BusinessIcon fontSize="small" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={w.label}
                    secondary={w.slug === current ? t("workspace.chooseCurrentNote") : w.org}
                  />
                </ListItemButton>
              ))}
            </List>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={dismiss} disabled={switching !== null}>
          {t("workspace.chooseStay")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
