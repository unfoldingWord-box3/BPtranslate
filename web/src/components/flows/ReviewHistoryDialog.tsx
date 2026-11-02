// Kind-aware row history for the review queue, after the #histBackdrop dialog
// in docs/flows/ui/t2-review.html.
//
// Why not reuse NoteHistoryDialog.tsx: that component hard-codes
// `api.getRowHistory("tn", …)` (NoteHistoryDialog.tsx:89) and its restore path
// speaks the note card's snapshot shape. The review queue runs both tn and tq
// through the same card, so it needs the kind threaded through. Everything
// else — the endpoint, the RowHistoryEntry shape, the "hide revert phantoms"
// rule — is the same contract.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { api, ApiError, type RowHistoryEntry } from "../../sync/api";
import i18n from "../../i18n";
import { formatEpochSecondsDateTime } from "../../lib/formatDate";

export interface ReviewHistoryDialogProps {
  open: boolean;
  kind: "tn" | "tq";
  rowId: string;
  book: string;
  /** The row's live version — the If-Match expectation for a restore. */
  currentVersion: number;
  /** tn only: the row is in the visible trash and can be restored. */
  trashed: boolean;
  onClose: () => void;
  /** Restore the row out of the trash (tn only). */
  onRestoreFromTrash?: () => void;
  /**
   * Re-apply an older version's text. Only the edited field travels
   * (`note` for tn, `response` for tq) — the dialog says so rather than
   * implying a whole-row revert.
   */
  onUseVersion: (text: string, fromVersion: number) => void;
}

const fmtTime = (epochSec: number) => formatEpochSecondsDateTime(epochSec);

function userLabel(t: TFunction, e: RowHistoryEntry): string {
  if (!e.user) return t("flowReview.history.systemUser");
  return e.user.full_name || e.user.username || t("flowReview.history.userNum", { id: e.user.id });
}

export function ReviewHistoryDialog({
  open,
  kind,
  rowId,
  book,
  currentVersion,
  trashed,
  onClose,
  onRestoreFromTrash,
  onUseVersion,
}: ReviewHistoryDialogProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RowHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the history fetch starts when the dialog opens, and this clears the previous open's result and error so the dialog shows its loading state instead of another row's history while the request is in flight.
    setEntries(null);
    setError(null);
    api
      .getRowHistory(kind, rowId, book)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.versions);
      })
      .catch((e) => {
        if (cancelled) return;
        // i18n.t, not the hook's `t`: adding `t` to this effect's deps would
        // re-run the history FETCH on every UI-language change.
        setError(
          i18n.t("flowReview.history.loadFailed", {
            status: e instanceof ApiError ? e.status : i18n.t("flowReview.common.errorWord"),
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, rowId, book]);

  const field = kind === "tn" ? "note" : "response";
  // Revert phantoms carry a snapshot identical to the version they restored —
  // the server marks them so the list doesn't show the same text twice.
  const shown = (entries ?? []).filter((e) => e.restored_from_version == null);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {kind === "tn" ? t("flowReview.history.titleNote") : t("flowReview.history.titleQuestion")}
      </DialogTitle>
      <DialogContent dividers>
        {trashed && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              onRestoreFromTrash ? (
                <Button size="small" onClick={onRestoreFromTrash}>
                  {t("flowReview.history.restore")}
                </Button>
              ) : undefined
            }
          >
            {t("flowReview.history.inTrash")}
          </Alert>
        )}
        {error && <Alert severity="warning">{error}</Alert>}
        {!error && entries === null && (
          <Box sx={{ display: "flex", justifyContent: "center", p: 2 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {entries !== null && shown.length === 0 && !error && (
          <Typography variant="body2" color="text.secondary">
            {t("flowReview.history.noVersions")}
          </Typography>
        )}
        {shown
          .slice()
          .reverse()
          .map((e) => {
            const snapshotText = e.snapshot[field];
            const restorable =
              e.version !== currentVersion && typeof snapshotText === "string";
            return (
              <Box
                key={e.version}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 1,
                  borderBlockEnd: "1px solid",
                  borderColor: "divider",
                  textAlign: "start",
                }}
              >
                <Typography variant="body2" fontWeight={700} sx={{ width: 40, flex: "none" }}>
                  v{e.version}
                </Typography>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2">{e.action}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {userLabel(t, e)} · {fmtTime(e.created_at)}
                  </Typography>
                </Box>
                {restorable && (
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ flex: "none", minHeight: 44 }}
                    onClick={() => onUseVersion(snapshotText as string, e.version)}
                  >
                    {t("flowReview.history.switchTo", { version: e.version })}
                  </Button>
                )}
              </Box>
            );
          })}
        {shown.length > 0 && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
            {t("flowReview.history.switchExplains", {
              // The sentence names the column that travels; these two keys are
              // the display words for it, kept apart from the conflict dialog's
              // field labels because that surface calls `response` "Answer".
              field:
                field === "note"
                  ? t("flowReview.history.fieldNote")
                  : t("flowReview.history.fieldResponse"),
            })}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
