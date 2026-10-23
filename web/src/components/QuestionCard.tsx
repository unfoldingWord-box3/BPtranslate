import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import CheckIcon from "@mui/icons-material/Check";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";
import SaveOutlinedIcon from "@mui/icons-material/SaveOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useTranslation } from "react-i18next";
import type { TqRow } from "../sync/api";
import type { SourceQuestion } from "../hooks/useSourceQuestions";
import { drafts, rowKey, draftDirtyBorderSx } from "../sync/drafts";
import { tqCardBaseline, tsvToDisplay } from "../lib/tqRowFields";
import { reconcileField } from "../lib/twlRowFields";

// Translation-review card for translationQuestions — the tQ analogue of
// NoteCard's translation mode. Only rendered in a gateway-language project
// (ResourceColumn gates translationMode ? QuestionCard : QuestionsTable), so the
// English authoring workflow (QuestionsTable) is completely untouched. Renders a
// row by translation_state: ai_draft/edited expand with the English source
// pinned above editable question+response drafts; validated collapses to a
// green one-line preview; an untranslated (NULL + empty) row offers Translate.

// Only Hebrew (U+0590–U+05FF) is RTL here; Greek/Latin are LTR. Mirrors NoteCard.
const RTL_CHAR = /[֐-׿؀-ۿ]/; // Hebrew + Arabic ranges (target drafts are Arabic)

function isRtl(text: string): boolean {
  return RTL_CHAR.test(text);
}

interface Props {
  row: TqRow;
  // The published English SOURCE question this row's draft was made from
  // (matched by row id). Pinned read-only above the editable draft. Null when
  // unavailable (source fetch failed / no matching id).
  sourceQuestion?: SourceQuestion | null;
  // Apply local + enqueue (caller owns outbox.enqueueRow), mirrors QuestionsTable.
  onSave: (patch: Partial<TqRow>) => void;
  onDelete: () => void;
  // Approve the current draft → validate(1) → 'validated', card collapses.
  onApprove?: () => void;
  // Un-approve a validated row → validate(0) → 'edited'.
  onUnapprove?: () => void;
  // Translate THIS question via the translate pipeline (translate.rowIds:[id]).
  onTranslate?: () => void;
  // This row has an in-flight translate pipeline.
  isTranslating?: boolean;
  // Chapter locked (AI pipeline mid-flight) — render read-only, hide delete.
  locked?: boolean;
}

function QuestionCardInner({
  row,
  sourceQuestion,
  onSave,
  onDelete,
  onApprove,
  onUnapprove,
  onTranslate,
  isTranslating = false,
  locked = false,
}: Props) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState(tsvToDisplay(row.question));
  const [response, setResponse] = useState(tsvToDisplay(row.response));

  // When the row's values change (an optimistic Save, the server's answer, a
  // remote edit), a field adopts the new value only if the user hasn't edited
  // it since the last baseline. Resetting on every version bump dropped text
  // typed between Save and the server's answer, and cleared its draft (#617).
  const baselineRef = useRef(tqCardBaseline(row));
  useEffect(() => {
    const prev = baselineRef.current;
    const next = tqCardBaseline({ question: row.question, response: row.response });
    baselineRef.current = next;
    setQuestion((q) => reconcileField(prev.question, next.question, q));
    setResponse((r) => reconcileField(prev.response, next.response, r));
  }, [row.question, row.response]);

  const draftKey = useMemo(() => rowKey("tq", row.book, row.id), [row.book, row.id]);

  // Hydrate any persisted crash-recovery draft on first mount.
  const hydratedFromDraftRef = useRef(false);
  useEffect(() => {
    if (hydratedFromDraftRef.current) return;
    void drafts.get(draftKey).then((rec) => {
      if (hydratedFromDraftRef.current) return;
      hydratedFromDraftRef.current = true;
      const patch = (rec?.payload as { patch?: Partial<TqRow> } | undefined)?.patch;
      if (!patch) return;
      if (typeof patch.question === "string") setQuestion(patch.question);
      if (typeof patch.response === "string") setResponse(patch.response);
    });
  }, [draftKey]);

  const diff = useMemo<Partial<TqRow>>(() => {
    const out: Partial<TqRow> = {};
    if (question !== tsvToDisplay(row.question)) out.question = question;
    if (response !== tsvToDisplay(row.response)) out.response = response;
    return out;
  }, [question, response, row.question, row.response]);
  const isDirty = Object.keys(diff).length > 0;

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

  // ── Derived translation state (mirrors NoteCard) ──
  const translationState = row.translation_state ?? null;
  const isDraftState = translationState === "ai_draft" || translationState === "edited";
  const isValidated = translationState === "validated";
  const isUntranslated =
    translationState == null && !(row.question && row.question.trim());

  // Leaving the validated state collapses the card again, adjusted during render.
  const [expanded, setExpanded] = useState(false);
  const [prevIsValidated, setPrevIsValidated] = useState(isValidated);
  if (prevIsValidated !== isValidated) {
    setPrevIsValidated(isValidated);
    if (!isValidated) setExpanded(false);
  }
  const collapsedValidated = isValidated && !expanded && !isDirty;

  const stateChip: { label: string; color: string } | null =
    translationState === "ai_draft"
      ? { label: t("translation.stateAiDraft"), color: "warning.main" }
      : translationState === "edited"
        ? { label: t("translation.stateEdited"), color: "info.main" }
        : isValidated
          ? { label: t("translation.stateApproved"), color: "success.main" }
          : isUntranslated
            ? { label: t("translation.stateUntranslated"), color: "text.secondary" }
            : null;

  const handleSave = () => {
    if (!isDirty) return;
    onSave(diff);
  };

  const draftRtl = isRtl(question) || isRtl(response);

  return (
    <Box
      sx={{
        my: 1,
        border: isDraftState || isValidated ? "1.5px solid" : "1px solid",
        borderColor:
          translationState === "ai_draft"
            ? "warning.light"
            : isValidated
              ? "success.main"
              : "divider",
        bgcolor: collapsedValidated
          ? (theme) => alpha(theme.palette.success.main, 0.09)
          : "background.paper",
        borderRadius: 1,
        overflow: "hidden",
        ...draftDirtyBorderSx(),
      }}
    >
      {/* ── Header: ref + state chip + AI chip ── */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.75}
        sx={{ px: 1.5, pt: 1, pb: 0.5, flexWrap: "wrap", rowGap: 0.5 }}
      >
        <Typography
          variant="caption"
          sx={{ fontFamily: "monospace", color: "text.disabled", fontWeight: 600 }}
        >
          {row.ref_raw}
        </Typography>
        {stateChip && (
          <Chip
            label={stateChip.label}
            size="small"
            sx={{
              height: 18,
              fontSize: 10,
              fontWeight: 600,
              color: stateChip.color,
              borderColor: stateChip.color,
            }}
            variant="outlined"
          />
        )}
        {row.latest_source === "ai_pipeline" && (
          <Tooltip title={t("questions.aiPipelineTooltip")}>
            <AutoAwesomeIcon sx={{ fontSize: 14, color: "secondary.main" }} />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title={isDirty ? t("questions.saveEdits") : t("questions.noUnsavedEdits")}>
          <span>
            <IconButton
              size="small"
              disabled={!isDirty || locked}
              onClick={handleSave}
              sx={{ p: 0.25, color: isDirty ? "primary.main" : "action.disabled" }}
            >
              {isDirty ? <SaveIcon fontSize="inherit" /> : <SaveOutlinedIcon fontSize="inherit" />}
            </IconButton>
          </span>
        </Tooltip>
        {!locked && (
          <IconButton size="small" onClick={onDelete} color="error" sx={{ p: 0.25 }}>
            <DeleteOutlineIcon fontSize="inherit" />
          </IconButton>
        )}
      </Stack>

      {collapsedValidated ? (
        /* Validated → collapsed one-line preview (green). Click to expand. */
        <Box
          onClick={() => setExpanded(true)}
          title={t("translation.showSource")}
          sx={{
            px: 1.5,
            pb: 1,
            cursor: "pointer",
            color: "text.secondary",
            fontSize: `calc(14px * var(--be-reading-scale, 1))`,
            fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {tsvToDisplay(row.question) || "—"}
        </Box>
      ) : (
        <>
          {/* ── English source, pinned read-only (always LTR) ── */}
          {(isDraftState || isUntranslated) && sourceQuestion && (
            <Box
              dir="ltr"
              sx={{
                mx: 1.5,
                mt: 0.5,
                borderInlineStart: "3px solid",
                borderColor: "divider",
                bgcolor: (theme) => alpha(theme.palette.text.primary, 0.03),
                borderRadius: 1,
                px: 1.5,
                py: 1,
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  mb: 0.5,
                  fontFamily: "monospace",
                  color: "text.disabled",
                  textTransform: "uppercase",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.09em",
                }}
              >
                {t("translation.sourceLabel")}
              </Typography>
              <Box
                sx={{
                  fontSize: `calc(14px * var(--be-reading-scale, 1))`,
                  lineHeight: 1.55,
                  color: "text.primary",
                  fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
                  whiteSpace: "pre-wrap",
                  overflowWrap: "break-word",
                  textAlign: "start",
                  fontWeight: 600,
                }}
              >
                {sourceQuestion.question || "—"}
              </Box>
              {sourceQuestion.response && (
                <Box
                  sx={{
                    mt: 0.5,
                    fontSize: `calc(13px * var(--be-reading-scale, 1))`,
                    lineHeight: 1.5,
                    color: "text.secondary",
                    fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
                    whiteSpace: "pre-wrap",
                    overflowWrap: "break-word",
                    textAlign: "start",
                  }}
                >
                  {sourceQuestion.response}
                </Box>
              )}
            </Box>
          )}

          {/* ── Editable target draft: question + response ── */}
          {!isUntranslated && (
            <Stack spacing={0.75} sx={{ px: 1.5, py: 1 }}>
              <TextField
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                size="small"
                multiline
                spellCheck
                variant="outlined"
                label={t("questions.question")}
                InputProps={{
                  readOnly: locked,
                  ...(isDirty ? { "data-dirty": "true" } : {}),
                }}
                inputProps={{
                  ...(draftRtl ? { dir: "rtl" as const } : {}),
                  style: {
                    fontSize: `calc(14px * var(--be-reading-scale, 1))`,
                    lineHeight: 1.55,
                    ...(draftRtl ? { textAlign: "right" as const } : {}),
                  },
                }}
              />
              <TextField
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                size="small"
                multiline
                spellCheck
                variant="outlined"
                label={t("questions.response")}
                InputProps={{
                  readOnly: locked,
                  ...(isDirty ? { "data-dirty": "true" } : {}),
                }}
                inputProps={{
                  ...(draftRtl ? { dir: "rtl" as const } : {}),
                  style: {
                    fontSize: `calc(14px * var(--be-reading-scale, 1))`,
                    lineHeight: 1.55,
                    ...(draftRtl ? { textAlign: "right" as const } : {}),
                  },
                }}
              />
            </Stack>
          )}

          {/* ── Action row (Approve / Translate / Re-run / collapse) ── */}
          {!locked && (
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ px: 1.5, pb: 1, pt: 0.25, flexWrap: "wrap", rowGap: 0.75 }}
            >
              {isDraftState && onApprove && (
                <Button
                  size="small"
                  variant="contained"
                  color="success"
                  startIcon={<CheckIcon sx={{ fontSize: "16px !important" }} />}
                  onClick={onApprove}
                  sx={{ py: 0.25 }}
                >
                  {t("common.approve")}
                </Button>
              )}
              {isValidated && expanded && (
                <>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => setExpanded(false)}
                    sx={{ py: 0.25, color: "text.secondary" }}
                  >
                    {t("translation.collapse")}
                  </Button>
                  {onUnapprove && (
                    <Button
                      size="small"
                      variant="text"
                      color="warning"
                      onClick={onUnapprove}
                      sx={{ py: 0.25 }}
                    >
                      {t("translation.unapprove")}
                    </Button>
                  )}
                </>
              )}
              {onTranslate && (isUntranslated || isDraftState) && (
                <Button
                  size="small"
                  variant={isUntranslated ? "contained" : "outlined"}
                  color={isUntranslated ? "secondary" : "inherit"}
                  disabled={isTranslating}
                  startIcon={
                    isTranslating ? (
                      <CircularProgress size={12} color="inherit" />
                    ) : (
                      <AutoAwesomeIcon sx={{ fontSize: "16px !important" }} />
                    )
                  }
                  onClick={onTranslate}
                  sx={{ py: 0.25, color: isUntranslated ? undefined : "text.secondary" }}
                >
                  {isTranslating
                    ? t("translation.translating")
                    : isUntranslated
                      ? t("common.translate")
                      : t("translation.reRun")}
                </Button>
              )}
              {isDraftState && (
                <Typography variant="caption" sx={{ color: "text.disabled" }}>
                  {t("translation.whyDraft")}
                </Typography>
              )}
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}

export const QuestionCard = memo(
  QuestionCardInner,
  (a, b) =>
    a.row === b.row &&
    a.sourceQuestion === b.sourceQuestion &&
    a.isTranslating === b.isTranslating &&
    a.locked === b.locked,
);
