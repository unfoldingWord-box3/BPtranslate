// Rapid check's bulk action bar (issue #829). Drawn only while notes are
// checked, in place of the single-note action bar; the outcome of the last
// bulk action (with Undo when the action can honestly be undone) shows above
// it. The verbs themselves live in useRapidBulk.

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CheckIcon from "@mui/icons-material/Check";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { RapidBulkResult } from "./useRapidBulk";

export interface RapidBulkProps {
  onApprove: (ids: string[]) => Promise<string[]>;
  onRedo: (ids: string[]) => Promise<string[]>;
  onNotNeeded: (ids: string[]) => Promise<string[]>;
  running: boolean;
  /** Why Redo with AI cannot run in this workspace, or null. */
  redoBlocked: string | null;
  result: RapidBulkResult | null;
  /** Undo the last bulk Not needed; null when there is nothing to undo. */
  onUndo: (() => void) | null;
  onDismiss: () => void;
}

export function RapidBulkResultLine({ result, onUndo, onDismiss, disabled }: {
  result: RapidBulkResult;
  onUndo: (() => void) | null;
  onDismiss: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      severity={result.severity}
      role="status"
      data-rapid-bulk-result=""
      onClose={onDismiss}
      action={
        onUndo ? (
          <Button color="inherit" size="small" disabled={disabled} onClick={onUndo} sx={{ fontWeight: 700 }}>
            {t("flowTranslate.rapid.bulk.undo")}
          </Button>
        ) : undefined
      }
      sx={{ borderRadius: 0, paddingBlock: 0, alignItems: "center" }}
    >
      {result.text}
    </Alert>
  );
}

export function RapidBulkBar({
  count,
  disabled,
  redoBlocked,
  onApprove,
  onRedo,
  onNotNeeded,
  onClear,
  trailing,
}: {
  count: number;
  disabled: boolean;
  redoBlocked: string | null;
  onApprove: () => void;
  onRedo: () => void;
  onNotNeeded: () => void;
  onClear: () => void;
  /** Drawn at the end of the row (Rapid check's Assistant button). */
  trailing?: ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { ok, skip } = theme.palette.flows;
  return (
    <Box
      component="footer"
      data-rapid-bulk-bar=""
      sx={{ bgcolor: "background.paper", borderBlockStart: "1px solid", borderColor: "divider" }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ paddingInline: 2.5, paddingBlock: 1, flexWrap: "wrap", rowGap: 0.75 }}
      >
        <Typography component="span" sx={{ fontWeight: 700, marginInlineEnd: 1 }} aria-live="polite">
          {t("flowTranslate.rapid.bulk.selected", { count })}
        </Typography>
        <Button
          disabled={disabled}
          onClick={onApprove}
          startIcon={<CheckIcon />}
          sx={{ minHeight: 36, borderRadius: "12px", fontWeight: 700, bgcolor: ok.main, color: "#fff", "&:hover": { bgcolor: ok.main, filter: "brightness(0.95)" } }}
        >
          {t("flowTranslate.rapid.bulk.approve")}
        </Button>
        <Button
          variant="outlined"
          disabled={disabled || redoBlocked != null}
          title={redoBlocked ?? t("flowTranslate.rapid.bulk.redoTitle")}
          onClick={onRedo}
          startIcon={<AutoAwesomeIcon />}
          sx={{ minHeight: 36, borderRadius: "12px", fontWeight: 700 }}
        >
          {t("flowTranslate.rapid.bulk.redo")}
        </Button>
        <Button
          disabled={disabled}
          onClick={onNotNeeded}
          sx={{ minHeight: 36, borderRadius: "12px", fontWeight: 700, bgcolor: skip.soft, color: skip.ink, "&:hover": { bgcolor: skip.soft } }}
        >
          {t("flowTranslate.notNeeded")}
        </Button>
        <Button disabled={disabled} onClick={onClear} sx={{ minHeight: 36, fontWeight: 700 }}>
          {t("flowTranslate.rapid.bulk.clear")}
        </Button>
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ marginInlineStart: "auto !important", textAlign: "end" }}
        >
          {t("flowTranslate.rapid.bulk.hint")}
        </Typography>
        {trailing}
      </Stack>
    </Box>
  );
}
