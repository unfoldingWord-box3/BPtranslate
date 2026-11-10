// Rapid check's status filter: a menu in the "Status · type" column header
// that hides notes by the status their chip shows, and the line above the
// column header that says what is hidden. The list logic is in
// lib/rapidStatusFilter.ts; the screen owns the state.

import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import IconButton from "@mui/material/IconButton";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import FilterListIcon from "@mui/icons-material/FilterList";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { FlowStatusChip } from "./FlowStatusChip";
import { flowChipKind } from "../../lib/flowStatusChip";
import { RAPID_STATUS_BUCKETS, type RapidStatusBucket } from "../../lib/rapidStatusFilter";

// Every status is offered even with no notes yet, so "hide approved" can be
// set before anything is approved. Aquifer import is the exception: most
// projects never have one.
const offered = (b: RapidStatusBucket, counts: ReadonlyMap<RapidStatusBucket, number>) =>
  b !== "aquifer" || (counts.get(b) ?? 0) > 0;

export interface RapidStatusFilterMenuProps {
  hidden: ReadonlySet<RapidStatusBucket>;
  counts: ReadonlyMap<RapidStatusBucket, number>;
  labels: Record<RapidStatusBucket, string>;
  onChange: (next: ReadonlySet<RapidStatusBucket>) => void;
}

export function RapidStatusFilterMenu({ hidden, counts, labels, onChange }: RapidStatusFilterMenuProps) {
  const { t } = useTranslation();
  // Popover origins are physical; open toward the inline end in both directions.
  const side = useTheme().direction === "rtl" ? "right" : "left";
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const active = hidden.size > 0;
  const options = RAPID_STATUS_BUCKETS.filter((b) => offered(b, counts));
  const name = t("flowTranslate.rapid.statusFilter.button");

  const toggle = (b: RapidStatusBucket) => {
    const next = new Set(hidden);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    onChange(next);
  };
  const only = (b: RapidStatusBucket) => onChange(new Set(RAPID_STATUS_BUCKETS.filter((x) => x !== b)));

  return (
    <>
      <IconButton
        size="small"
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={anchor != null}
        aria-pressed={active}
        data-rapid-status-filter=""
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{
          padding: "5px",
          margin: "-3px",
          color: active ? "primary.main" : "text.secondary",
          bgcolor: active ? "action.selected" : undefined,
        }}
      >
        <FilterListIcon sx={{ fontSize: 15 }} />
      </IconButton>
      <Popover
        open={anchor != null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        // Keys typed in the menu must not act on the notes behind it (React
        // bubbles portal events to the list's handler): A, Space, J, K…
        onKeyDown={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: "bottom", horizontal: side }}
        transformOrigin={{ vertical: "top", horizontal: side }}
        slotProps={{ paper: { role: "dialog", "aria-label": name, sx: { p: 1, minWidth: 240, maxWidth: 320 } } }}
      >
        <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingInlineStart: 0.5, mb: 0.5 }}>
          <Typography component="span" sx={{ fontSize: "0.75rem", fontWeight: 700, color: "text.secondary" }}>
            {name}
          </Typography>
          <Button size="small" disabled={!active} onClick={() => onChange(new Set())} sx={{ minWidth: 0, fontSize: "0.75rem" }}>
            {t("flowTranslate.rapid.statusFilter.showAll")}
          </Button>
        </Box>
        <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
          {options.map((b) => (
            <Box component="li" key={b} sx={{ display: "flex", alignItems: "center", gap: 0.5 }} data-rapid-status-option={b}>
              <Box
                component="label"
                sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: 1, minWidth: 0, cursor: "pointer" }}
              >
                <Checkbox size="small" checked={!hidden.has(b)} onChange={() => toggle(b)} sx={{ padding: "5px" }} />
                <FlowStatusChip kind={flowChipKind(b)} label={labels[b]} />
                <Typography component="span" sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
                  {counts.get(b) ?? 0}
                </Typography>
              </Box>
              <Button
                size="small"
                onClick={() => only(b)}
                aria-label={t("flowTranslate.rapid.statusFilter.onlyAria", { status: labels[b] })}
                sx={{ minWidth: 0, paddingInline: 1, fontSize: "0.75rem" }}
              >
                {t("flowTranslate.rapid.statusFilter.only")}
              </Button>
            </Box>
          ))}
        </Box>
        <Typography sx={{ mt: 0.75, paddingInline: 0.5, fontSize: "0.75rem", color: "text.secondary" }}>
          {t("flowTranslate.rapid.statusFilter.hint")}
        </Typography>
      </Popover>
    </>
  );
}

export interface RapidStatusFilterLineProps {
  hidden: ReadonlySet<RapidStatusBucket>;
  counts: ReadonlyMap<RapidStatusBucket, number>;
  labels: Record<RapidStatusBucket, string>;
  shown: number;
  total: number;
  onShowAll: () => void;
}

/** What the status filter hides, and a way to show everything again. */
export function RapidStatusFilterLine({ hidden, counts, labels, shown, total, onShowAll }: RapidStatusFilterLineProps) {
  const { t, i18n } = useTranslation();
  // Name whichever side is shorter: "Hidden: Approved" or "Only: Pending".
  const offeredBuckets = RAPID_STATUS_BUCKETS.filter((b) => offered(b, counts));
  const off = offeredBuckets.filter((b) => hidden.has(b));
  const on = offeredBuckets.filter((b) => !hidden.has(b));
  const showOnly = on.length < off.length;
  const list = new Intl.ListFormat(i18n.language, { style: "short", type: "unit" }).format(
    (showOnly ? on : off).map((b) => labels[b]),
  );
  return (
    <Box data-rapid-status-line="" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", fontSize: "0.8125rem" }}>
      <FilterListIcon sx={{ fontSize: 16, color: "primary.main" }} />
      <Typography component="span" sx={{ fontSize: "inherit", fontWeight: 600 }}>
        {showOnly
          ? t("flowTranslate.rapid.statusFilter.onlyShown", { list })
          : t("flowTranslate.rapid.statusFilter.hidden", { list })}
      </Typography>
      <Typography component="span" sx={{ fontSize: "inherit", color: "text.secondary" }}>
        {t("flowTranslate.rapid.statusFilter.shown", { shown, total })}
      </Typography>
      <Button size="small" onClick={onShowAll} sx={{ minWidth: 0, fontSize: "0.75rem" }}>
        {t("flowTranslate.rapid.statusFilter.showAll")}
      </Button>
    </Box>
  );
}
