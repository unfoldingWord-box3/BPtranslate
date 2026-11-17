// 409 version_mismatch merge prompt, after the #conflictBackdrop dialog in
// docs/flows/ui/t2-review.html.
//
// WHAT THE 409 CARRIES. Every version_mismatch site in api/src/rows.ts answers
// `{ error: "version_mismatch", current: fresh }` with the server's whole row
// (`SELECT *`), which the outbox keeps on the op as `conflictCurrent`. This
// dialog still takes the "Theirs" CONTENT from a separate re-read of the row
// (ReviewQueue), which also picks up a third write that landed after the 409,
// and shows a loading state until that read lands. If the re-read fails the
// dialog says so and disables "Keep theirs" rather than showing an empty box
// that reads as "the other editor blanked it".
//
// The columns, field labels and buttons are shared with the classic editors'
// inline compare (../ConflictCompare.tsx, #892), which explains why the other
// editor is never named and why only the patched fields are compared.

import { useTranslation } from "react-i18next";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import {
  ConflictActions,
  ConflictColumns,
  joinLabels,
  theirsMetaLabel,
  type ConflictFieldView,
} from "../ConflictCompare";

export type { ConflictFieldView };

export interface ReviewConflictDialogProps {
  open: boolean;
  kind: "tn" | "tq";
  /** Exactly the fields the conflicting op patched — never a fixed guess. */
  fields: ConflictFieldView[];
  /** True only when the sole patched field is the row's note/response text. */
  textual: boolean;
  /** True once the re-read row landed, so the "theirs" values are real. */
  theirsLoaded: boolean;
  /** Version being merged against — the 409's, or the re-read's if newer. */
  theirsVersion: number | null;
  /** From the re-read row's `updated_at`. Null omits the age clause. */
  theirsUpdatedAt: number | null;
  loadingTheirs: boolean;
  /** Honest reason the other version can't be shown; disables "Keep theirs". */
  theirsError: string | null;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  onClose: () => void;
}

export function ReviewConflictDialog({
  open,
  kind,
  fields,
  textual,
  theirsLoaded,
  theirsVersion,
  theirsUpdatedAt,
  loadingTheirs,
  theirsError,
  onKeepMine,
  onKeepTheirs,
  onClose,
}: ReviewConflictDialogProps) {
  const { t } = useTranslation();
  const canKeepTheirs = !loadingTheirs && theirsError == null && theirsLoaded;
  const keepTheirsReason = loadingTheirs
    ? t("flowReview.conflict.stillLoadingTheirs")
    : !canKeepTheirs
      ? t("flowReview.conflict.theirsUnreadable")
      : "";

  const title = textual
    ? kind === "tn"
      ? t("flowReview.conflict.titleNote")
      : t("flowReview.conflict.titleQuestion")
    : fields.length > 0
      ? t("flowReview.conflict.titleFields", {
          fields: joinLabels(
            t,
            fields.map((f) => f.labelLower),
          ),
        })
      : t("flowReview.conflict.titleRow");

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, textAlign: "start" }}>
          {textual
            ? t("flowReview.conflict.bodyTextual")
            : t("flowReview.conflict.bodyFields")}
        </Typography>
        <ConflictColumns
          fields={fields}
          textual={textual}
          theirsMeta={theirsMetaLabel(t, theirsVersion, theirsUpdatedAt)}
          loadingTheirs={loadingTheirs}
          theirsError={theirsError}
        />
      </DialogContent>
      <DialogActions>
        <ConflictActions
          canKeepTheirs={canKeepTheirs}
          keepTheirsReason={keepTheirsReason}
          keepTheirsLabel={
            textual ? t("flowReview.conflict.keepTheirs") : t("flowReview.conflict.discardMine")
          }
          theirsVersion={theirsVersion}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
        />
      </DialogActions>
    </Dialog>
  );
}
