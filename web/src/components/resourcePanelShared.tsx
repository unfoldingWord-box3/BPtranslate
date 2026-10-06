import { useTranslation } from "react-i18next";
import { Box, Stack, Typography, Chip, Button, IconButton, Tooltip } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import PushPinIcon from "@mui/icons-material/PushPin";
import PushPinOutlinedIcon from "@mui/icons-material/PushPinOutlined";
import CheckIcon from "@mui/icons-material/Check";
import { LANE_FILL, type LaneShade } from "../lib/laneChecks";

// In-context checkoff for the resource panels (Notes/Words/Questions), scoped to
// the active verse. Shell computes these from the lane-check state.
export type ResourceLane = "tn" | "tw" | "tq";
export interface ResourceCheckoff {
  canCheck: boolean;
  shade: (lane: ResourceLane) => LaneShade;
  applicable: (lane: ResourceLane) => boolean;
  attribution: (lane: ResourceLane) => string;
  onToggle: (lane: ResourceLane) => void;
  // Bulk "all this chapter" — Shell decides direction (check-all unless every
  // applicable verse is already mine, then clear-all).
  onBulkToggle: (lane: ResourceLane) => void;
}

export type PinKey = "notes" | "words" | "questions";

export function sortBySortOrder<
  T extends { sort_order: number | null; id: string; trashed_at?: number | null },
>(rows: T[]): T[] {
  // Trashed notes always sort to the bottom of the verse, preserving their
  // relative order. Purely presentational — sort_order is untouched, so a
  // Restore drops the note straight back to its original position. Rows
  // without a trashed_at field (twl) are treated as not trashed.
  return [...rows].sort(
    (a, b) =>
      (a.trashed_at != null ? 1 : 0) - (b.trashed_at != null ? 1 : 0) ||
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
        (b.sort_order ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}

export function groupByVerse<T extends { verse: number }>(rows: T[]): Array<[number, T[]]> {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const bucket = map.get(r.verse) ?? [];
    bucket.push(r);
    map.set(r.verse, bucket);
  }
  return [...map.entries()].sort(([a], [b]) => a - b);
}

export function DropIndicator() {
  return (
    <Box
      sx={{
        height: 3,
        my: 0.5,
        bgcolor: "primary.main",
        borderRadius: 1,
        boxShadow: "0 0 4px rgba(49,173,227,0.5)",
      }}
    />
  );
}

export function VerseGroupHead({
  verse,
  active,
  section,
  label,
}: {
  verse: number;
  active: boolean;
  section: PinKey;
  // Overrides the default "intro" / "v{n}" text (the book introduction group).
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-verse-group={verse}
      data-vg-section={section}
      sx={{
        // Clear the sticky SectionHead when scrollIntoView lands here with
        // block: "start", so the verse number stays visible rather than
        // tucking behind the pinned header.
        scrollMarginTop: "40px",
        mt: 1,
        mb: 0.25,
        py: 0.25,
        px: 0.5,
        borderBottom: "1px dashed",
        borderColor: active ? "primary.main" : "divider",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          fontFamily: "monospace",
          fontWeight: 700,
          color: active ? "primary.main" : "text.secondary",
          letterSpacing: 0.5,
        }}
      >
        {label ?? (verse === 0 ? t("shell.intro") : `v${verse}`)}
      </Typography>
    </Stack>
  );
}

export function SectionHead({
  title,
  count,
  countNote,
  pinned,
  onTogglePin,
  onAdd,
  sticky,
  hideAdd,
  lane,
  checkoff,
}: {
  title: string;
  count: number;
  /**
   * Optional caption beside the count chip, explaining what the chip leaves
   * out — currently "N trashed". `count` is the live-row denominator every
   * other surface uses (#238); trashed rows are still rendered below, so
   * without this the chip and the visible cards would disagree by N.
   */
  countNote?: string;
  pinned: boolean;
  onTogglePin: () => void;
  onAdd: () => void;
  sticky?: boolean;
  hideAdd?: boolean;
  lane?: ResourceLane;
  checkoff?: ResourceCheckoff;
}) {
  const { t } = useTranslation();
  const laneApplicable = checkoff && lane ? checkoff.applicable(lane) : false;
  const shade = checkoff && lane && laneApplicable ? checkoff.shade(lane) : "open";
  const fill = shade !== "open" ? LANE_FILL[shade as Exclude<LaneShade, "open">] : null;
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{
        pb: 0.25,
        mb: 0.25,
        borderBottom: "1px solid",
        borderColor: "divider",
        ...(sticky
          ? {
              position: "sticky",
              top: 0,
              bgcolor: "background.paper",
              zIndex: 2,
              pt: 0.25,
            }
          : {}),
      }}
    >
      <Typography variant="subtitle2">{title}</Typography>
      <Chip
        label={count}
        size="small"
        variant="outlined"
        sx={{ height: 18, fontFamily: "monospace", fontSize: 10 }}
      />
      {countNote && (
        <Typography variant="caption" sx={{ color: "text.disabled", whiteSpace: "nowrap" }}>
          · {countNote}
        </Typography>
      )}
      <Tooltip
        title={pinned ? t("shell.unpinSection", { title: title.toLowerCase() }) : t("shell.pinSection", { title: title.toLowerCase() })}
      >
        <IconButton size="small" onClick={onTogglePin} sx={{ p: 0.25, color: pinned ? "primary.main" : "text.disabled" }}>
          {pinned ? <PushPinIcon fontSize="inherit" sx={{ fontSize: 16 }} /> : <PushPinOutlinedIcon fontSize="inherit" sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      {checkoff && lane && laneApplicable && checkoff.canCheck && !pinned && (
        <Tooltip
          title={t("shell.checkoffVerse", { title, attribution: checkoff.attribution(lane), action: shade === "me" || shade === "both" ? t("shell.uncheck") : t("shell.check") })}
        >
          <Box
            role="checkbox"
            aria-checked={shade !== "open"}
            onClick={() => checkoff.onToggle(lane)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              cursor: "pointer",
              px: 0.75,
              height: 20,
              borderRadius: 1,
              fontSize: 11,
              userSelect: "none",
              bgcolor: fill ? fill.bg : "transparent",
              color: fill ? fill.fg : "text.secondary",
              border: fill ? "none" : "1px solid",
              borderColor: fill ? "transparent" : "divider",
            }}
          >
            <CheckIcon sx={{ fontSize: 13 }} /> {t("shell.done")}
          </Box>
        </Tooltip>
      )}
      {checkoff && lane && laneApplicable && checkoff.canCheck && (
        <Tooltip title={t("shell.checkAllChapter", { title: title.toLowerCase() })}>
          <Typography
            variant="caption"
            onClick={() => checkoff.onBulkToggle(lane)}
            sx={{ color: "primary.main", cursor: "pointer", whiteSpace: "nowrap", ml: 0.25 }}
          >
            {t("shell.all")}
          </Typography>
        </Tooltip>
      )}
      <Box sx={{ flex: 1 }} />
      {hideAdd ? null : (
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          color="success"
          variant="outlined"
          sx={{ minWidth: 0, fontSize: 11 }}
          onClick={onAdd}
        >
          {t("shell.new")}
        </Button>
      )}
    </Stack>
  );
}
