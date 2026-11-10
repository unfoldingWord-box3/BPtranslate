// One assistant proposal: its edits (with a word diff), approvals and
// Not needed rows, each with a checkbox, and an Apply button. Knows nothing
// about the screen it came from: labels and "before" text come from describeId.

import { useMemo } from "react";
import { Alert, Box, Button, Checkbox, Stack, Typography } from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { actionCount, noteDiff, proposalKey, selectedActions, type ProposalActions, type ProposalKind } from "./proposal";

export interface ProposalState {
  actions: ProposalActions;
  /** Whatever buildContext returned alongside the notes; handed back to onApply. */
  snapshot: unknown;
  /** Keys (proposalKey) of rows the user unticked. */
  unticked: string[];
  applied: { text: string; severity: "success" | "info" | "warning" } | null;
}

export interface NoteInfo {
  label: string;
  before: string;
}

// The word diff is O(m·n), so it is computed only when the texts change, not
// on every render of the panel (each keystroke in the chat box is one, #860).
function DiffText({ before, proposed }: { before: string; proposed: string }) {
  const theme = useTheme();
  const del = alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.3 : 0.15);
  const add = alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.3 : 0.2);
  const ops = useMemo(() => noteDiff(before, proposed), [before, proposed]);
  return (
    <Typography component="div" variant="body2" dir="auto" sx={{ whiteSpace: "pre-wrap", textAlign: "start", overflowWrap: "anywhere" }}>
      {ops.map((op, i) =>
        op.type === "eq" ? (
          <span key={i}>{op.text}</span>
        ) : op.type === "del" ? (
          <Box key={i} component="del" sx={{ bgcolor: del, textDecoration: "line-through" }}>
            {op.text}
          </Box>
        ) : (
          <Box key={i} component="ins" sx={{ bgcolor: add, textDecoration: "none" }}>
            {op.text}
          </Box>
        ),
      )}
    </Typography>
  );
}

function snippet(s: string): string {
  const flat = s.replace(/\\n|\n/g, " ").trim();
  return flat.length > 90 ? flat.slice(0, 90) + "…" : flat;
}

export default function ProposalCard({
  proposal,
  describeId,
  applying,
  disabled,
  onToggle,
  onApply,
}: {
  proposal: ProposalState;
  describeId: (id: string) => NoteInfo | null;
  applying: boolean;
  /** Another card is applying, or this one has no way to apply right now. */
  disabled: boolean;
  onToggle: (key: string) => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const unticked = new Set(proposal.unticked);
  const count = actionCount(selectedActions(proposal.actions, unticked));
  const done = proposal.applied != null;
  const { edits, approve, notNeeded } = proposal.actions;

  const tick = (kind: ProposalKind, id: string, label: string) => (
    <Checkbox
      size="small"
      checked={!unticked.has(proposalKey(kind, id))}
      onChange={() => onToggle(proposalKey(kind, id))}
      disabled={done || applying}
      slotProps={{ input: { "aria-label": t("assistant.proposal.include", { ref: label }) } }}
      sx={{ p: 0.5, marginInlineEnd: 0.5 }}
    />
  );

  const listRow = (kind: ProposalKind, id: string) => {
    const info = describeId(id);
    const label = info?.label ?? t("assistant.proposal.unknownNote");
    return (
      <Stack key={kind + id} direction="row" alignItems="flex-start" sx={{ py: 0.25 }}>
        {tick(kind, id, label)}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {label}
          </Typography>
          {info && info.before.trim() && (
            <Typography variant="caption" color="text.secondary" dir="auto" component="div" sx={{ textAlign: "start" }}>
              {snippet(info.before)}
            </Typography>
          )}
        </Box>
      </Stack>
    );
  };

  return (
    <Box
      component="section"
      data-assistant-proposal=""
      aria-label={t("assistant.proposal.title")}
      sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1.5, p: 1, my: 1, bgcolor: "background.paper" }}
    >
      <Typography variant="subtitle2" component="h4" sx={{ mb: 0.5 }}>
        {t("assistant.proposal.title")}
      </Typography>

      {edits.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {t("assistant.proposal.edits", { count: edits.length })}
          </Typography>
          {edits.map((e) => {
            const info = describeId(e.id);
            const label = info?.label ?? t("assistant.proposal.unknownNote");
            return (
              <Stack key={e.id} direction="row" alignItems="flex-start" sx={{ py: 0.5 }}>
                {tick("e", e.id, label)}
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {label}
                  </Typography>
                  <DiffText before={info?.before ?? ""} proposed={e.note} />
                </Box>
              </Stack>
            );
          })}
        </Box>
      )}

      {approve.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {t("assistant.proposal.approvals", { count: approve.length })}
          </Typography>
          {approve.map((id) => listRow("a", id))}
        </Box>
      )}

      {notNeeded.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            {t("assistant.proposal.notNeeded", { count: notNeeded.length })}
          </Typography>
          {notNeeded.map((id) => listRow("n", id))}
        </Box>
      )}

      {done ? (
        <Alert severity={proposal.applied!.severity} role="status" sx={{ py: 0 }}>
          {proposal.applied!.text}
        </Alert>
      ) : (
        <Button size="small" variant="contained" onClick={onApply} disabled={count === 0 || applying || disabled}>
          {applying ? t("assistant.proposal.applying") : t("assistant.proposal.apply", { count })}
        </Button>
      )}
    </Box>
  );
}
