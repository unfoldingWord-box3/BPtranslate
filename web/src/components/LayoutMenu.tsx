// Phase 5: user-saved-layout dialogs. Shell owns the state needed to capture
// "current" into a spec, so the mutation callbacks live there; this component is
// just the two dialogs (Save current as… / Manage layouts…) plus a delete
// confirm. TopBar's LayoutSwitcher opens them via Shell-provided callbacks.
// i18n Phase 5+ : layout names stay in the language the user typed them.

import { useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  TextField,
  Button,
  Stack,
  IconButton,
  Tooltip,
  Typography,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { useTranslation } from "react-i18next";
import type { LayoutSpec } from "../lib/layoutSpec";

interface LayoutMenuProps {
  // Save current as…
  saveAsOpen: boolean;
  onCloseSaveAs: () => void;
  onSave: (name: string) => void;
  // Manage layouts…
  manageOpen: boolean;
  onCloseManage: () => void;
  userLayouts: LayoutSpec[];
  activeLayoutId: string;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}

// One editable row in the Manage dialog. Holds a local name draft so typing
// doesn't persist per keystroke — the rename commits on Enter / blur, and only
// when the name actually changed to a non-empty value.
function LayoutRow({
  layout,
  active,
  onRename,
  onDelete,
  onDuplicate,
}: {
  layout: LayoutSpec;
  active: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(layout.name);
  // Follow a rename that lands from outside (e.g. the commit below), adjusting
  // state during render rather than in an effect.
  const [prevLayoutName, setPrevLayoutName] = useState(layout.name);
  if (layout.name !== prevLayoutName) {
    setPrevLayoutName(layout.name);
    setName(layout.name);
  }

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== layout.name) onRename(layout.id, trimmed);
    else setName(layout.name);
  };

  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <TextField
        size="small"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLElement).blur();
          } else if (e.key === "Escape") {
            setName(layout.name);
            (e.target as HTMLElement).blur();
          }
        }}
        onBlur={commit}
        sx={{ flex: 1 }}
      />
      {active && (
        <Typography variant="caption" color="primary" sx={{ whiteSpace: "nowrap" }}>
          {t("layout.active")}
        </Typography>
      )}
      <Tooltip title={t("layout.duplicate")}>
        <IconButton size="small" onClick={() => onDuplicate(layout.id)}>
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t("common.delete")}>
        <IconButton size="small" onClick={() => onDelete(layout.id)}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

export function LayoutMenu({
  saveAsOpen,
  onCloseSaveAs,
  onSave,
  manageOpen,
  onCloseManage,
  userLayouts,
  activeLayoutId,
  onRename,
  onDelete,
  onDuplicate,
}: LayoutMenuProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<LayoutSpec | null>(null);

  // Fresh, empty name field each time the Save dialog opens (adjusted during
  // render on the closed → open transition).
  const [prevSaveAsOpen, setPrevSaveAsOpen] = useState(saveAsOpen);
  if (saveAsOpen !== prevSaveAsOpen) {
    setPrevSaveAsOpen(saveAsOpen);
    if (saveAsOpen) setName("");
  }

  const submitSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return (
    <>
      <Dialog open={saveAsOpen} onClose={onCloseSaveAs} fullWidth maxWidth="xs">
        <DialogTitle>{t("layout.saveDialogTitle")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label={t("layout.nameLabel")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitSave();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onCloseSaveAs}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={submitSave} disabled={!name.trim()}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={manageOpen} onClose={onCloseManage} fullWidth maxWidth="sm">
        <DialogTitle>{t("layout.manageDialogTitle")}</DialogTitle>
        <DialogContent>
          {userLayouts.length === 0 ? (
            <DialogContentText>{t("layout.noUserLayouts")}</DialogContentText>
          ) : (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {userLayouts.map((l) => (
                <LayoutRow
                  key={l.id}
                  layout={l}
                  active={l.id === activeLayoutId}
                  onRename={onRename}
                  onDelete={(id) =>
                    setPendingDelete(userLayouts.find((u) => u.id === id) ?? null)
                  }
                  onDuplicate={onDuplicate}
                />
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onCloseManage}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!pendingDelete} onClose={() => setPendingDelete(null)}>
        <DialogTitle>{t("layout.deleteConfirmTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("layout.deleteConfirmBody", { name: pendingDelete?.name ?? "" })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDelete(null)}>{t("common.cancel")}</Button>
          <Button
            color="error"
            onClick={() => {
              if (pendingDelete) onDelete(pendingDelete.id);
              setPendingDelete(null);
            }}
          >
            {t("common.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
