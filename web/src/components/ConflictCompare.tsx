// Mine / Theirs compare for a row save the server refused with a version
// conflict. Shared by the review queue's dialog (flows/ReviewConflictDialog.tsx)
// and the classic editors' inline panel (RowConflictPanel below, #892).
//
// The other editor is never named. Even the full row carries only `updated_by`
// (a numeric user id), no username — see
// docs/flows/05-functional-preview-findings.md §4.7, where the mockup filled
// that gap with a fabricated colleague. That was the worst honesty defect the
// preview drive found.
//
// NOT ONLY NOTE TEXT. A row 409 can come from any patch the queue enqueues —
// note/response text, but also {quote, occurrence}, {verse, ref_raw}, and
// {sort_order}. The compare therefore renders whatever fields the op actually
// patched (`fields`), and only uses the big two-column text compare when the
// note/response text is the single conflicted field (`textual`). Framing a
// quote swap as "your note text vs theirs" would show an empty "Mine" against
// the server's full note — a fabricated comparison.

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { canKeepTheirs, withEditorValues, type RowConflictView } from "../sync/rowConflictView";

/** One field the conflicting op patched, with both sides' values. */
export interface ConflictFieldView {
  /** Raw patch key, e.g. "quote", "sort_order". */
  field: string;
  /** Human label, already localized by the owner, e.g. "Quote". */
  label: string;
  /**
   * The same label in the sentence-inline form ("quote"). Supplied rather than
   * lower-cased here: casing a translated string is not a portable operation.
   */
  labelLower: string;
  /** What this browser tried to save, rendered as text. */
  mine: string;
  /** The server's current value. Null while it is loading or if it could not be read. */
  theirs: string | null;
}

export function unescapeNewlines(text: string | null | undefined): string {
  return (text ?? "").replace(/\\n/g, "\n");
}

// i18n keys for the row fields a save can patch — the map stores KEY NAMES,
// not display text, so it stays language-independent at module scope.
// Anything unmapped falls back to the raw column name rather than being
// silently prettified into something that might not match what the API
// actually changed. `lower` is the sentence-inline form, supplied as its own
// key rather than produced by lower-casing a translated string.
const FIELD_LABEL_KEYS: Record<string, { label: string; lower: string }> = {
  note: { label: "flowReview.field.note", lower: "flowReview.fieldLower.note" },
  question: { label: "flowReview.field.question", lower: "flowReview.fieldLower.question" },
  response: { label: "flowReview.field.response", lower: "flowReview.fieldLower.response" },
  quote: { label: "flowReview.field.quote", lower: "flowReview.fieldLower.quote" },
  occurrence: { label: "flowReview.field.occurrence", lower: "flowReview.fieldLower.occurrence" },
  verse: { label: "flowReview.field.verse", lower: "flowReview.fieldLower.verse" },
  ref_raw: { label: "flowReview.field.refRaw", lower: "flowReview.fieldLower.refRaw" },
  sort_order: { label: "flowReview.field.sortOrder", lower: "flowReview.fieldLower.sortOrder" },
  support_reference: {
    label: "flowReview.field.supportReference",
    lower: "flowReview.fieldLower.supportReference",
  },
};

export function fieldLabel(t: TFunction, field: string): string {
  const entry = FIELD_LABEL_KEYS[field];
  return entry ? t(entry.label) : field;
}

export function fieldLabelLower(t: TFunction, field: string): string {
  const entry = FIELD_LABEL_KEYS[field];
  return entry ? t(entry.lower) : field;
}

// Render any patch/row value as display text. Absent stays "" so the compare
// can show an explicit "(empty)" rather than a blank box.
export function displayFieldValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? unescapeNewlines(value) : String(value);
}

// ", 2 min ago" from unix seconds; "" when absent or implausible, so the
// heading degrades to a bare "Theirs (v6)" rather than showing a lie.
function agoSuffix(t: TFunction, updatedAt: number | null): string {
  if (updatedAt == null || !Number.isFinite(updatedAt)) return "";
  const secs = Math.floor(Date.now() / 1000) - updatedAt;
  if (secs < 0) return "";
  if (secs < 60) return t("flowReview.conflict.agoJustNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("flowReview.conflict.agoMinutes", { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t("flowReview.conflict.agoHours", { count: hrs });
  const days = Math.floor(hrs / 24);
  return t("flowReview.conflict.agoDays", { count: days });
}

// "quote", "quote and occurrence", "verse, reference and order" — used only to
// name what actually conflicted, never to characterise the change itself.
export function joinLabels(t: TFunction, labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  return t("flowReview.common.listAnd", {
    list: labels.slice(0, -1).join(t("flowReview.common.listSeparator")),
    last: labels[labels.length - 1],
  });
}

/** "v6, 2 min ago", or null when there is no version to name. */
export function theirsMetaLabel(t: TFunction, version: number | null, updatedAt: number | null): string | null {
  return version == null ? null : `v${version}${agoSuffix(t, updatedAt)}`;
}

function ColumnShell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: 1,
        p: 1.25,
        fontSize: "0.85rem",
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
        textAlign: "start",
      }}
    >
      <Typography
        variant="caption"
        component="h3"
        color="text.secondary"
        sx={{
          display: "block",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          mb: 0.75,
        }}
      >
        {heading}
      </Typography>
      {children}
    </Box>
  );
}

export interface ConflictColumnsProps {
  fields: ConflictFieldView[];
  /** True only when the sole patched field is the row's note/response text. */
  textual: boolean;
  /** "v6, 2 min ago" (theirsMetaLabel), or null. */
  theirsMeta: string | null;
  loadingTheirs: boolean;
  /** Honest reason the other version can't be shown. */
  theirsError: string | null;
  /** Two columns from this breakpoint up; one column below it. */
  wideFrom?: "tablet" | "never";
}

/** The Mine / Theirs columns: one pair for a text conflict, one pair per field otherwise. */
export function ConflictColumns({
  fields,
  textual,
  theirsMeta,
  loadingTheirs,
  theirsError,
  wideFrom = "tablet",
}: ConflictColumnsProps) {
  const { t } = useTranslation();
  const theirsHeading =
    theirsMeta == null
      ? t("flowReview.conflict.theirs")
      : t("flowReview.conflict.theirsWithMeta", { meta: theirsMeta });

  // Rendered inside a ColumnShell: real text, an explicit "(empty)", or the
  // honest reason there is nothing to show. Never a blank box.
  function theirsBody(value: string | null): ReactNode {
    if (loadingTheirs) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="caption" color="text.secondary">
            {t("flowReview.conflict.loadingTheirs")}
          </Typography>
        </Box>
      );
    }
    if (theirsError != null) {
      return (
        <Typography variant="caption" color="text.secondary">
          {theirsError}
        </Typography>
      );
    }
    if (value == null) {
      return (
        <Typography variant="caption" color="text.secondary">
          {t("flowReview.conflict.theirsUnavailable")}
        </Typography>
      );
    }
    return value === "" ? <Box component="em">{t("flowReview.conflict.empty")}</Box> : value;
  }

  const twoColumn = {
    display: "grid",
    gap: 1.25,
    gridTemplateColumns: wideFrom === "never" ? "1fr" : { xs: "1fr", tablet: "1fr 1fr" },
  } as const;

  if (textual) {
    return (
      <Box sx={twoColumn}>
        <ColumnShell heading={t("flowReview.conflict.mine")}>
          {fields[0]?.mine || <Box component="em">{t("flowReview.conflict.empty")}</Box>}
        </ColumnShell>
        <ColumnShell heading={theirsHeading}>{theirsBody(fields[0]?.theirs ?? null)}</ColumnShell>
      </Box>
    );
  }
  if (fields.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        {t("flowReview.conflict.unidentified")}
      </Typography>
    );
  }
  return (
    <Box sx={{ display: "grid", gap: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: "start" }}>
        {t("flowReview.conflict.theirVersionLine", {
          meta: theirsMeta ?? t("flowReview.conflict.unknownVersion"),
        })}
      </Typography>
      {fields.map((f) => (
        <Box key={f.field}>
          <Typography
            variant="caption"
            component="h3"
            sx={{ display: "block", fontWeight: 700, mb: 0.5, textAlign: "start" }}
          >
            {f.label}
          </Typography>
          <Box sx={twoColumn}>
            <ColumnShell heading={t("flowReview.conflict.mine")}>
              {f.mine || <Box component="em">{t("flowReview.conflict.empty")}</Box>}
            </ColumnShell>
            <ColumnShell heading={t("flowReview.conflict.theirs")}>{theirsBody(f.theirs)}</ColumnShell>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

export interface ConflictActionsProps {
  /** False while their version is loading or unreadable; the tooltip says why. */
  canKeepTheirs: boolean;
  keepTheirsReason: string;
  keepTheirsLabel: string;
  /** Null when there is no server version to re-send against. */
  theirsVersion: number | null;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  size?: "small" | "medium";
}

/** "Keep theirs" then "Keep mine". */
export function ConflictActions({
  canKeepTheirs,
  keepTheirsReason,
  keepTheirsLabel,
  theirsVersion,
  onKeepMine,
  onKeepTheirs,
  size = "medium",
}: ConflictActionsProps) {
  const { t } = useTranslation();
  const minHeight = size === "small" ? undefined : 44;
  return (
    <>
      <Tooltip title={keepTheirsReason}>
        <span>
          <Button
            variant="outlined"
            size={size}
            onClick={onKeepTheirs}
            disabled={!canKeepTheirs}
            sx={{ minHeight }}
          >
            {keepTheirsLabel}
          </Button>
        </span>
      </Tooltip>
      <Tooltip title={theirsVersion == null ? t("flowReview.conflict.noServerVersion") : ""}>
        <span>
          <Button
            variant="contained"
            color="success"
            size={size}
            onClick={onKeepMine}
            disabled={theirsVersion == null}
            sx={{ minHeight }}
          >
            {t("flowReview.conflict.keepMine")}
          </Button>
        </span>
      </Tooltip>
    </>
  );
}

/**
 * The classic editors' inline compare (#892): shown on the note or question
 * itself while one of its saves waits on a conflict. The other person's row
 * comes from the 409 (`view.theirs`), so there is nothing to load. Keep mine
 * re-sends at their version; Keep theirs drops this browser's queued saves of
 * the row and puts their text in the editor (the owner does both).
 *
 * "Mine" is the editor as it stands (`editor`, with `dirty` naming the fields
 * that differ from the card's baseline), so typing made after the refused
 * save shows too: it is what Keep theirs throws away (review K1).
 */
export function RowConflictPanel({
  kind,
  view: queued,
  editor,
  dirty,
  onKeepMine,
  onKeepTheirs,
}: {
  kind: "tn" | "tq";
  view: RowConflictView;
  editor: Record<string, unknown>;
  dirty: readonly string[];
  onKeepMine: () => void;
  onKeepTheirs: () => void;
}) {
  const { t } = useTranslation();
  const view = withEditorValues(queued, editor, dirty);
  const textField = kind === "tq" ? "response" : "note";
  const fields: ConflictFieldView[] = view.fields.map((field) => ({
    field,
    label: fieldLabel(t, field),
    labelLower: fieldLabelLower(t, field),
    mine: displayFieldValue(view.mine[field]),
    theirs: view.theirs ? displayFieldValue(view.theirs[field]) : null,
  }));
  const textual = fields.length === 1 && fields[0].field === textField;
  const keepTheirsOk = canKeepTheirs(view);
  const keepTheirsReason = keepTheirsOk
    ? ""
    : view.theirs == null
      ? t("flowReview.conflict.theirsUnreadable")
      : t("flowReview.conflict.stillSending");
  return (
    <Box
      role="region"
      aria-label={kind === "tn" ? t("flowReview.conflict.titleNote") : t("flowReview.conflict.titleQuestion")}
      data-row-conflict="true"
      onMouseDown={(e) => e.stopPropagation()}
      sx={{
        mx: 1.5,
        my: 1,
        p: 1.25,
        border: "1px solid",
        borderColor: "warning.main",
        borderRadius: 1,
        bgcolor: "background.paper",
      }}
    >
      <Typography variant="subtitle2" component="h2" sx={{ textAlign: "start", mb: 0.5 }}>
        {kind === "tn" ? t("flowReview.conflict.titleNote") : t("flowReview.conflict.titleQuestion")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1, textAlign: "start" }}>
        {/* Not bodyFields (review P2): it promises that unsaved typing stays,
            and here Keep theirs replaces the editor's text. */}
        {textual ? t("flowReview.conflict.bodyTextual") : t("flowReview.conflict.bodyFieldsCard")}
      </Typography>
      <ConflictColumns
        fields={fields}
        textual={textual}
        theirsMeta={theirsMetaLabel(t, view.theirsVersion, view.theirsUpdatedAt)}
        loadingTheirs={false}
        theirsError={null}
      />
      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
        <ConflictActions
          canKeepTheirs={keepTheirsOk}
          keepTheirsReason={keepTheirsReason}
          keepTheirsLabel={t("flowReview.conflict.keepTheirs")}
          theirsVersion={view.theirsVersion}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
          size="small"
        />
      </Stack>
    </Box>
  );
}
