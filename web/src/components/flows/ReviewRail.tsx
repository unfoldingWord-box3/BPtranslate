// Queue-at-a-glance rail, after .queue-panel / .approve-all-row /
// .add-row-actions / .queue-list in docs/flows/ui/t2-review.html. Shown at
// tablet and desktop; the phone band replaces it with card-to-card nav.
//
// The rail owns no network calls — "Approve all" and "+ Note / + Question"
// report intent upward so the one component that owns the chapter data also
// owns the writes and their honest failure reporting.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import Alert from "@mui/material/Alert";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import type { TnRow, TqRow } from "../../sync/api";

export type ReviewRowState = "draft" | "edited" | "validated";

// The three review buckets a status filter can pick. "trashed" applies to
// notes only (tq has no trashed_at); "approved" is translation_state ===
// "validated"; everything else is "pending".
export type ReviewRowStatus = "pending" | "approved" | "trashed";
export type ReviewStatusFilter = "all" | ReviewRowStatus;

// tA article type, derived from the row's support reference — mirrors
// typeSlugOf/typeLabelOf in TranslateNotesScreen (the new-UI notes flow) so
// the classic queue names types the same way:
// "rc://*/ta/man/translate/figs-metaphor" → slug "figs-metaphor" → label
// "metaphor".
function typeSlugOf(supportReference: string | null | undefined): string | null {
  if (!supportReference) return null;
  const seg = supportReference.split("/").filter(Boolean).pop();
  return seg || null;
}

function typeLabelOf(slug: string): string {
  return slug.replace(/^(?:figs|translate|writing|grammar)-/, "").replace(/-/g, " ");
}

// One-line preview of a note's text. TnRow.note carries literal "\n" escape
// sequences (see the source TSV format); collapse them plus any real
// whitespace so the snippet reads on a single line. CSS handles the ellipsis;
// the slice just keeps the DOM node small.
function noteSnippet(note: string | null | undefined): string {
  return (note ?? "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

export interface ReviewRailItem {
  id: string;
  ref: string;
  secondary: string;
  /** Note/question text preview shown beneath the quote on note rows. */
  snippet: string;
  /** tA article-type slug (notes only), e.g. "figs-metaphor"; null for tq. */
  typeSlug: string | null;
  /** Human label for `typeSlug`, e.g. "metaphor". */
  typeLabel: string | null;
  status: ReviewRowStatus;
  state: ReviewRowState;
  trashed: boolean;
}

export interface ReviewRailProps {
  activeKind: "tn" | "tq";
  items: ReviewRailItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Unapproved counts for BOTH queues — the mockup labels both buttons. */
  unapprovedNotes: number;
  unapprovedQuestions: number;
  onApproveAll: (kind: "tn" | "tq") => void;
  /** Non-null while a sequential approve-all run is in flight. */
  approveProgress: { done: number; total: number } | null;
  /** Honest stop-on-first-failure message from the last run, if any. */
  approveError: string | null;
  onDismissApproveError: () => void;
  onAddRow: (kind: "tn" | "tq") => void;
  addDisabled: boolean;
  addDisabledReason?: string;
  addPending: boolean;
}

export function railItemsFromRows(
  kind: "tn" | "tq",
  rows: Array<TnRow | TqRow>,
  refFor: (row: TnRow | TqRow) => string,
): ReviewRailItem[] {
  return rows.map((row) => {
    const st = row.translation_state;
    const trashed = kind === "tn" ? (row as TnRow).trashed_at != null : false;
    const typeSlug = kind === "tn" ? typeSlugOf((row as TnRow).support_reference) : null;
    const status: ReviewRowStatus = trashed
      ? "trashed"
      : st === "validated"
        ? "approved"
        : "pending";
    return {
      id: row.id,
      ref: refFor(row),
      secondary:
        kind === "tn" ? ((row as TnRow).quote ?? "") : ((row as TqRow).question ?? ""),
      snippet: kind === "tn" ? noteSnippet((row as TnRow).note) : "",
      typeSlug,
      typeLabel: typeSlug ? typeLabelOf(typeSlug) : null,
      status,
      state: st === "validated" || st === "edited" ? st : "draft",
      trashed,
    };
  });
}

export function ReviewRail({
  activeKind,
  items,
  selectedId,
  onSelect,
  unapprovedNotes,
  unapprovedQuestions,
  onApproveAll,
  approveProgress,
  approveError,
  onDismissApproveError,
  onAddRow,
  addDisabled,
  addDisabledReason,
  addPending,
}: ReviewRailProps) {
  const { t } = useTranslation();
  const unapproved = activeKind === "tn" ? unapprovedNotes : unapprovedQuestions;
  const approveLabel =
    activeKind === "tn"
      ? t("flowReview.rail.approveAllNotes", { n: unapprovedNotes })
      : t("flowReview.rail.approveAllQuestions", { n: unapprovedQuestions });
  const addLabel = activeKind === "tn" ? t("flowReview.rail.addNote") : t("flowReview.rail.addQuestion");

  const theme = useTheme();
  const { skip } = theme.palette.flows;

  // ── queue filters (issue #270) ────────────────────────────────────────────
  // Status filter applies to both queues; the type filter is notes-only (tq
  // rows carry no support_reference). Both live in the rail so the host's
  // `rows`/selection semantics are untouched — the filter only narrows what
  // this list shows.
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Distinct article types present in THIS chapter's notes, with counts — built
  // from what is actually here, never a global taxonomy.
  const typeOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const it of items) {
      if (!it.typeSlug) continue;
      const entry = counts.get(it.typeSlug);
      if (entry) entry.count += 1;
      else counts.set(it.typeSlug, { label: it.typeLabel ?? it.typeSlug, count: 1 });
    }
    return [...counts.entries()]
      .map(([slug, v]) => ({ slug, label: v.label, count: v.count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  // A type filter whose slug vanished (kind switch, refetch) heals to "all"
  // rather than silently hiding every row.
  const effectiveTypeFilter =
    activeKind === "tn" && typeOptions.some((o) => o.slug === typeFilter) ? typeFilter : "all";

  // "Trashed" is a notes-only status, and its menu item isn't rendered for
  // questions. Heal it the same way: without this, picking Trashed in the notes
  // queue and switching to questions leaves the select showing nothing and
  // filters away every question, so the rail just looks empty.
  const effectiveStatusFilter =
    statusFilter === "trashed" && activeKind !== "tn" ? "all" : statusFilter;

  const visibleItems = useMemo(
    () =>
      items.filter((it) => {
        if (effectiveStatusFilter !== "all" && it.status !== effectiveStatusFilter) return false;
        if (effectiveTypeFilter !== "all" && it.typeSlug !== effectiveTypeFilter) return false;
        return true;
      }),
    [items, effectiveStatusFilter, effectiveTypeFilter],
  );

  const filtersActive = effectiveStatusFilter !== "all" || effectiveTypeFilter !== "all";

  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        overflow: "hidden",
        position: "sticky",
        top: 8,
        maxHeight: "78vh",
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.paper",
      }}
    >
      <Box sx={{ p: 1.5, borderBlockEnd: "1px solid", borderColor: "divider" }}>
        <Typography
          variant="caption"
          component="h2"
          color="text.secondary"
          sx={{
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            display: "block",
            mb: 1,
          }}
        >
          {t("common.approveAll")}
        </Typography>
        <Button
          fullWidth
          size="small"
          color="success"
          variant="outlined"
          onClick={() => onApproveAll(activeKind)}
          disabled={unapproved === 0 || approveProgress !== null}
          sx={{ justifyContent: "flex-start", textAlign: "start", minHeight: 44 }}
        >
          {approveLabel}
        </Button>
        {approveProgress && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {t("flowReview.rail.approvingProgress", {
                done: approveProgress.done,
                total: approveProgress.total,
              })}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={
                approveProgress.total === 0
                  ? 0
                  : (approveProgress.done / approveProgress.total) * 100
              }
              sx={{ mt: 0.5 }}
            />
          </Box>
        )}
        {approveError && (
          <Alert severity="warning" sx={{ mt: 1 }} onClose={onDismissApproveError}>
            {approveError}
          </Alert>
        )}

        <Box sx={{ display: "flex", gap: 0.75, mt: 1 }}>
          <Button
            fullWidth
            size="small"
            variant="outlined"
            onClick={() => onAddRow(activeKind)}
            disabled={addDisabled || addPending}
            title={addDisabled ? addDisabledReason : undefined}
            sx={{ borderStyle: "dashed", minHeight: 44 }}
          >
            {addPending ? t("flowReview.rail.adding") : addLabel}
          </Button>
        </Box>
      </Box>

      <Box
        sx={{
          p: 1.5,
          borderBlockEnd: "1px solid",
          borderColor: "divider",
          display: "flex",
          flexDirection: "column",
          gap: 1,
        }}
      >
        <Typography
          variant="caption"
          component="h2"
          color="text.secondary"
          sx={{
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            display: "block",
          }}
        >
          {t("flowReview.rail.filterHeading")}
        </Typography>
        <Select
          size="small"
          fullWidth
          value={effectiveStatusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ReviewStatusFilter)}
          aria-label={
            activeKind === "tn"
              ? t("flowReview.rail.statusFilterAriaNotes")
              : t("flowReview.rail.statusFilterAriaQuestions")
          }
          sx={{ fontSize: "0.8125rem", bgcolor: "background.paper" }}
        >
          <MenuItem value="all">{t("flowReview.rail.statusAll")}</MenuItem>
          <MenuItem value="pending">{t("flowReview.rail.statusPending")}</MenuItem>
          <MenuItem value="approved">{t("flowTranslate.status.approved")}</MenuItem>
          {activeKind === "tn" && (
            <MenuItem value="trashed">{t("flowTranslate.status.trashed")}</MenuItem>
          )}
        </Select>
        {activeKind === "tn" && typeOptions.length > 0 && (
          <Select
            size="small"
            fullWidth
            value={effectiveTypeFilter}
            onChange={(e) => setTypeFilter(e.target.value as string)}
            aria-label={t("flowReview.rail.typeFilterAria")}
            sx={{ fontSize: "0.8125rem", bgcolor: "background.paper" }}
          >
            <MenuItem value="all">{t("flowReview.rail.typeAll")}</MenuItem>
            {typeOptions.map((o) => (
              <MenuItem key={o.slug} value={o.slug} title={o.slug}>
                {o.label} ({o.count})
              </MenuItem>
            ))}
          </Select>
        )}
      </Box>

      <Box sx={{ overflowY: "auto" }}>
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "start" }}>
            {activeKind === "tn"
              ? t("flowReview.queue.noNotes")
              : t("flowReview.queue.noQuestions")}
          </Typography>
        ) : visibleItems.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: "start" }}>
            {filtersActive
              ? activeKind === "tn"
                ? t("flowReview.rail.noNotesFiltered")
                : t("flowReview.rail.noQuestionsFiltered")
              : activeKind === "tn"
                ? t("flowReview.queue.noNotes")
                : t("flowReview.queue.noQuestions")}
          </Typography>
        ) : (
          visibleItems.map((item) => (
            <Box
              key={item.id}
              component="button"
              type="button"
              aria-current={item.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(item.id)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                width: "100%",
                textAlign: "start",
                border: "none",
                borderBlockEnd: "1px solid",
                borderColor: "divider",
                bgcolor: item.id === selectedId ? "action.selected" : "transparent",
                cursor: "pointer",
                p: 1,
                minHeight: 44,
                font: "inherit",
                color: "inherit",
                opacity: item.trashed ? 0.55 : 1,
              }}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{ width: 16, flex: "none", fontSize: "0.65rem", fontWeight: 700, color: "text.secondary" }}
              >
                {activeKind === "tn"
                  ? t("flowReview.rail.badgeNote")
                  : t("flowReview.rail.badgeQuestion")}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    fontWeight={600}
                    noWrap
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      textDecoration: item.trashed ? "line-through" : "none",
                    }}
                  >
                    {item.ref}
                  </Typography>
                  {item.trashed && (
                    <Box
                      component="span"
                      sx={{
                        flex: "none",
                        fontSize: "0.6rem",
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                        border: "1px solid",
                        borderColor: "divider",
                        borderRadius: 0.5,
                        px: 0.5,
                        lineHeight: 1.6,
                      }}
                    >
                      {t("flowTranslate.status.trashed")}
                    </Box>
                  )}
                  {item.typeLabel && (
                    // Quiet read-only pill naming the note's tA article type —
                    // classification, not status, so it uses the muted skip
                    // palette rather than a FlowStatusChip. Full slug on hover.
                    <Box
                      component="span"
                      title={item.typeSlug ?? undefined}
                      sx={{
                        flex: "none",
                        maxWidth: 96,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        bgcolor: skip.soft,
                        color: skip.ink,
                        borderRadius: 999,
                        fontSize: "0.625rem",
                        fontWeight: 600,
                        lineHeight: 1.6,
                        paddingInline: 0.75,
                      }}
                    >
                      {item.typeLabel}
                    </Box>
                  )}
                </Box>
                {/* Quote/question and note snippet are project-language text:
                    direction follows the content (dir="auto", #256), so an
                    Arabic line reads RTL under an LTR UI (#533). */}
                {item.secondary && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    component="div"
                    dir="auto"
                  >
                    {item.secondary}
                  </Typography>
                )}
                {activeKind === "tn" && item.snippet && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    component="div"
                    dir="auto"
                    sx={{ opacity: 0.85 }}
                  >
                    {item.snippet}
                  </Typography>
                )}
              </Box>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  bgcolor:
                    item.state === "validated"
                      ? "success.main"
                      : item.state === "edited"
                        ? "primary.main"
                        : "action.disabled",
                }}
              />
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
