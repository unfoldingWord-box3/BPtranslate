// Topbar "issues to clean up" indicator. When the current book has DCS-
// validation findings that need a human decision (the lint "flag" bucket),
// a quiet warning chip shows the count; clicking it opens a menu of each
// issue with a "go to" affordance that navigates straight to the ref (and,
// for TN findings, activates the offending note). Hidden entirely when the
// book is clean — it's a nudge, not a permanent fixture.

import { useState } from "react";
import {
  Box,
  Chip,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from "@mui/material";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { useTranslation } from "react-i18next";
import type { BookLintIssue } from "../sync/api";

// Kindle warning accent (#E59D33 from CLAUDE.md brand palette), matching the
// other "needs attention" chips (VersionIndicator's update nudge, the
// SyncStatusBar transient chips).
const flagAccentSx = {
  color: "#E59D33",
  borderColor: "#E59D33",
  "& .MuiChip-icon": { color: "#E59D33" },
} as const;

interface Props {
  book: string;
  flagIssues: BookLintIssue[];
  flagCount: number;
  escalateCount: number;
  /** Navigate to (and, for TN issues, activate) the offending row. */
  onGoToIssue: (issue: BookLintIssue) => void;
  /**
   * "chip" (default) — the original standalone top-bar pill. "row" — a
   * full-width link row for embedding inside another menu/popover (the
   * merged Status indicator's "Lint" line).
   */
  variant?: "chip" | "row";
}

export function BookLintIndicator({
  book,
  flagIssues,
  flagCount,
  escalateCount,
  onGoToIssue,
  variant = "chip",
}: Props) {
  const { t } = useTranslation();
  // The trigger element, held in state (callback ref) so the Menu can anchor
  // on it without reading a ref during render.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  // Nothing to clean up — stay out of the way.
  if (flagCount <= 0) return null;

  const tooltip = `${flagCount} issue${flagCount === 1 ? "" : "s"} to clean up in ${book}${
    escalateCount > 0 ? ` (+${escalateCount} integrity)` : ""
  } — click to review`;

  const trigger =
    variant === "row" ? (
      <Box
        ref={setAnchorEl}
        component="button"
        onClick={() => setOpen(true)}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          width: "100%",
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          px: 1.75,
          py: 1,
        }}
      >
        <ReportProblemOutlinedIcon sx={{ fontSize: 18, color: "warning.main" }} />
        <Typography variant="body2" sx={{ flex: 1 }}>
          {t("topbar.status.issuesToCleanUp", { book, count: flagCount })}
        </Typography>
        <ChevronRightIcon sx={{ fontSize: 18, color: "text.disabled" }} />
      </Box>
    ) : (
      <Box ref={setAnchorEl} component="span" sx={{ display: "inline-flex" }}>
        <Tooltip title={tooltip}>
          <Chip
            icon={<ReportProblemOutlinedIcon />}
            label={flagCount}
            size="small"
            variant="outlined"
            clickable
            onClick={() => setOpen(true)}
            sx={flagAccentSx}
          />
        </Tooltip>
      </Box>
    );

  return (
    <>
      {trigger}
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 420 } } }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2">{book} — issues to clean up</Typography>
          <Typography variant="caption" color="text.secondary">
            {flagCount} need{flagCount === 1 ? "s" : ""} a decision
            {escalateCount > 0 ? ` · ${escalateCount} integrity` : ""}
          </Typography>
        </Box>
        <Divider />
        {flagIssues.map((issue, i) => (
          <MenuItem
            key={`${issue.resource}-${issue.ref}-${issue.rowId ?? ""}-${i}`}
            onClick={() => {
              setOpen(false);
              onGoToIssue(issue);
            }}
            sx={{ alignItems: "flex-start", whiteSpace: "normal", py: 1 }}
          >
            <ListItemText
              primary={
                <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}
                  >
                    {issue.ref}
                  </Typography>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ textTransform: "uppercase" }}
                  >
                    {issue.resource}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {issue.check}
                  </Typography>
                </Box>
              }
              secondary={
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {issue.message}
                </Typography>
              }
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
