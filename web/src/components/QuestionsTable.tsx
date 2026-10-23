import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Paper, Stack, TextField, IconButton, Typography, Tooltip } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import type { TqRow } from "../sync/api";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";
import { tqTableBaseline } from "../lib/tqRowFields";
import { reconcileField } from "../lib/twlRowFields";
import { useTranslation } from "react-i18next";

interface Props {
  rows: TqRow[];
  // Apply local + enqueue. Caller is responsible for outbox.enqueueRow.
  onSave: (id: string, patch: Partial<TqRow>) => void;
  onDelete: (id: string) => void;
  // When true, rows render read-only and the delete button is hidden. Used
  // while an AI pipeline is mid-flight for the chapter — the auto-apply step
  // will overwrite TQs anyway.
  locked?: boolean;
}

function QuestionsTableInner({ rows, onSave, onDelete, locked = false }: Props) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.disabled" sx={{ py: 1, pl: 1 }}>
        {t("questions.noQuestionsForVerse")}
      </Typography>
    );
  }
  return (
    <Paper
      variant="outlined"
      sx={{ overflow: "hidden", containerType: "inline-size", ...draftDirtyBorderSx() }}
    >
      <Box
        sx={{
          ...responsiveGridSx,
          px: 1,
          py: 0.5,
          bgcolor: "grey.50",
          fontFamily: "monospace",
          fontSize: 10,
          textTransform: "uppercase",
          color: "text.disabled",
          borderBottom: "1px dashed",
          borderColor: "divider",
          // The column labels don't map onto the stacked layout, so drop the
          // header band once the rows reflow.
          [`@container (max-width: ${NARROW_BP_PX}px)`]: { display: "none" },
        }}
      >
        <span>{t("questions.ref")}</span>
        <span>{t("questions.question")}</span>
        <span>{t("questions.response")}</span>
        <span />
      </Box>
      {rows.map((r) => (
        <Row
          key={r.id}
          row={r}
          onSave={(p) => onSave(r.id, p)}
          onDelete={() => onDelete(r.id)}
          locked={locked}
        />
      ))}
    </Paper>
  );
}

// Memoized: a note/word edit leaves `rows` (tqForVerse, a ResourceColumn
// useMemo) referentially stable, so the questions table skips re-render.
export const QuestionsTable = memo(
  QuestionsTableInner,
  (a, b) => a.rows === b.rows && a.locked === b.locked,
);

// Container-query breakpoint: under this table width the ref lane + two text
// columns + two action buttons can't all stay legible, so the layout reflows
// to stack the question and response on their own full-width rows.
const NARROW_BP_PX = 460;

// Wide: ref lane (ranges like "1:1-3" fit), question + response share the rest,
// two action cells. Narrow (container ≤ NARROW_BP_PX): ref shares the top row
// with the action buttons; the text fields drop to full-width rows beneath.
const responsiveGridSx = {
  display: "grid",
  gap: 1,
  alignItems: "center",
  gridTemplateColumns: "80px 1fr 1fr 28px 28px",
  gridTemplateAreas: '"ref question response save delete"',
  [`@container (max-width: ${NARROW_BP_PX}px)`]: {
    gridTemplateColumns: "1fr 28px 28px",
    gridTemplateAreas: [
      '"ref save delete"',
      '"question question question"',
      '"response response response"',
    ].join(" "),
    rowGap: 0.5,
  },
} as const;

const Row = memo(function Row({
  row,
  onSave,
  onDelete,
  locked,
}: {
  row: TqRow;
  onSave: (patch: Partial<TqRow>) => void;
  onDelete: () => void;
  locked: boolean;
}) {
  const { t } = useTranslation();
  const [refRaw, setRefRaw] = useState(row.ref_raw ?? "");
  const [question, setQuestion] = useState(row.question ?? "");
  const [response, setResponse] = useState(row.response ?? "");

  // When the row's values change (an optimistic Save, the server's answer, a
  // remote edit), a field adopts the new value only if the user hasn't edited
  // it since the last baseline. Resetting on every version bump dropped text
  // typed between Save and the server's answer, and cleared its draft (#617).
  const baselineRef = useRef(tqTableBaseline(row));
  useEffect(() => {
    const prev = baselineRef.current;
    const next = tqTableBaseline({ ref_raw: row.ref_raw, question: row.question, response: row.response });
    baselineRef.current = next;
    setRefRaw((v) => reconcileField(prev.refRaw, next.refRaw, v));
    setQuestion((q) => reconcileField(prev.question, next.question, q));
    setResponse((r) => reconcileField(prev.response, next.response, r));
  }, [row.ref_raw, row.question, row.response]);

  const draftKey = useMemo(() => rowKey("tq", row.book, row.id), [row.book, row.id]);

  // Hydrate from any persisted draft on first mount so unsaved typing
  // survives navigation. Later server pushes are reconciled by the effect
  // above.
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(draftKey).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const patch = (rec?.payload as { patch?: Partial<TqRow> } | undefined)?.patch;
      if (!patch) return;
      if (typeof patch.ref_raw === "string") setRefRaw(patch.ref_raw);
      if (typeof patch.question === "string") setQuestion(patch.question);
      if (typeof patch.response === "string") setResponse(patch.response);
    });
  }, [draftKey]);
  const diff = useMemo<Partial<TqRow>>(() => {
    const out: Partial<TqRow> = {};
    if (refRaw !== (row.ref_raw ?? "")) out.ref_raw = refRaw;
    if (question !== (row.question ?? "")) out.question = question;
    if (response !== (row.response ?? "")) out.response = response;
    return out;
  }, [refRaw, question, response, row.ref_raw, row.question, row.response]);
  const isDirty = Object.keys(diff).length > 0;

  // Sync the draft store as the source of crash-recovery truth. Cleared
  // when the user edits back to server state (so the orange border vanishes).
  useEffect(() => {
    if (locked) return;
    if (isDirty) {
      void drafts.set(draftKey, { patch: diff }, row.version, {
        kind: "row",
        rowKind: "tq",
        id: row.id,
        book: row.book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(draftKey);
    }
  }, [draftKey, isDirty, diff, row.version, row.id, row.book, row.chapter, row.verse, locked]);

  const handleSave = () => {
    if (!isDirty) return;
    onSave(diff);
  };

  return (
    <Box
      sx={{
        ...responsiveGridSx,
        px: 1,
        py: 0.5,
        borderBottom: "1px dashed",
        borderColor: "divider",
        "&:last-of-type": { borderBottom: "none" },
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        sx={{ minWidth: 0, gridArea: "ref" }}
      >
        {row.latest_source === "ai_pipeline" && (
          <Tooltip title={t("questions.aiPipelineTooltip")}>
            <AutoAwesomeIcon
              sx={{ fontSize: 14, color: "secondary.main", flexShrink: 0 }}
            />
          </Tooltip>
        )}
        <TextField
          value={refRaw}
          onChange={(e) => setRefRaw(e.target.value)}
          size="small"
          spellCheck={false}
          variant="outlined"
          placeholder="1:1"
          InputProps={{
            readOnly: locked,
            // Apply dirty flag to the input root so the orange-border CSS
            // catches it on blur. Marking the TextField wrapper wouldn't —
            // :focus-within would still match while typing.
            ...(isDirty ? { "data-dirty": "true" } : {}),
          }}
          inputProps={{
            style: { fontSize: 12, padding: "3px 6px", fontFamily: "monospace" },
          }}
        />
      </Stack>
      <TextField
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        size="small"
        multiline
        spellCheck
        variant="outlined"
        sx={{ gridArea: "question" }}
        InputProps={{
          readOnly: locked,
          ...(isDirty ? { "data-dirty": "true" } : {}),
        }}
        inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
      />
      <TextField
        value={response}
        onChange={(e) => setResponse(e.target.value)}
        size="small"
        multiline
        spellCheck
        variant="outlined"
        sx={{ gridArea: "response" }}
        InputProps={{
          readOnly: locked,
          ...(isDirty ? { "data-dirty": "true" } : {}),
        }}
        inputProps={{ style: { fontSize: 13, padding: "3px 6px" } }}
      />
      {locked ? (
        <span style={{ gridArea: "save" }} />
      ) : (
        <Tooltip title={isDirty ? t("questions.saveEdits") : t("questions.noUnsavedEdits")}>
          <span style={{ gridArea: "save" }}>
            <IconButton
              size="small"
              disabled={!isDirty}
              onClick={handleSave}
              sx={{ p: 0.25, color: isDirty ? "primary.main" : "action.disabled" }}
            >
              {isDirty ? (
                <SaveIcon fontSize="inherit" />
              ) : (
                <SaveOutlinedIcon fontSize="inherit" />
              )}
            </IconButton>
          </span>
        </Tooltip>
      )}
      {locked ? (
        <span style={{ gridArea: "delete" }} />
      ) : (
        <IconButton
          size="small"
          onClick={onDelete}
          color="error"
          sx={{ p: 0.25, gridArea: "delete" }}
        >
          <DeleteOutlineIcon fontSize="inherit" />
        </IconButton>
      )}
    </Box>
  );
}, (a, b) =>
  // Skip sibling question rows when the table re-renders; row is stable unless
  // THIS question changed. Callbacks (onSave/onDelete) intentionally ignored.
  a.row === b.row && a.locked === b.locked);
