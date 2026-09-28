// AdminDesk — shared chrome for the redesigned admin screens, implementing
// the locked "admin = desk-rail" decision (2026-08-07) with Benjamin's
// 2026-08-10 direction: desktop-first (the first user is a laptop user), but
// still usable narrow.
//
//   * >=900px (theme md): a 232px sticky rail beside the content column,
//     inside the 1440px desk — the .desk-shell/.rail primitives from
//     docs/mockups/desktop-first/_design.css translated to the MUI/sx idiom
//     the flows screens already use.
//   * <900px: the rail collapses into a tap-to-open menu at the top (the same
//     pattern the old FlowNav used, which Benjamin found more intuitive on
//     mobile than a horizontal scroll strip — 2026-08-17).
//
// Sections navigate by hash (#/admin/* and the More-tools hashes) so
// back/forward work; the active section is tinted with the Inspire highlight
// like every other selected row in the redesign. Screens render inside as
// children — this file owns ONLY the chrome, never data.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Button,
  ButtonBase,
  ListSubheader,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import { FlowHeader } from "./FlowHeader";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import MenuIcon from "@mui/icons-material/Menu";
import GroupsIcon from "@mui/icons-material/Groups";
import TuneIcon from "@mui/icons-material/Tune";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import InsightsIcon from "@mui/icons-material/Insights";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import PaletteIcon from "@mui/icons-material/Palette";
import ArticleIcon from "@mui/icons-material/Article";
import VisibilityIcon from "@mui/icons-material/Visibility";

const INSPIRE = "#31ADE3";

export type AdminSection =
  | "team"
  | "setup"
  | "workflow"
  | "progress"
  | "ai"
  | "style"
  | "templates"
  | "observe";

// Labels are i18n keys, translated at render time — the nav identities (key,
// hash) stay untouched for the adminSurfaceMap guard.
type NavItem = { key: AdminSection; labelKey: string; icon: ReactNode; hash: string };

const SECTIONS: NavItem[] = [
  { key: "progress", labelKey: "adminDesk.nav.progress", icon: <InsightsIcon fontSize="small" />, hash: "#/admin/progress" },
  { key: "workflow", labelKey: "adminDesk.nav.workflow", icon: <AccountTreeIcon fontSize="small" />, hash: "#/admin/workflow" },
  { key: "team", labelKey: "adminDesk.nav.team", icon: <GroupsIcon fontSize="small" />, hash: "#/admin/team" },
  { key: "setup", labelKey: "adminDesk.nav.setup", icon: <TuneIcon fontSize="small" />, hash: "#/admin/setup" },
];

// More-tools sections — same first-class treatment as SECTIONS above, but each
// keeps its own pre-existing hash (#/ai etc.) rather than the #/admin/{key}
// pattern, so bookmarks and links into these pages keep working (#186).
const TOOLS: NavItem[] = [
  { key: "ai", labelKey: "adminDesk.nav.ai", icon: <AutoAwesomeIcon fontSize="small" />, hash: "#/ai" },
  { key: "style", labelKey: "adminDesk.nav.style", icon: <PaletteIcon fontSize="small" />, hash: "#/style" },
  { key: "templates", labelKey: "adminDesk.nav.templates", icon: <ArticleIcon fontSize="small" />, hash: "#/curate" },
  { key: "observe", labelKey: "adminDesk.nav.observe", icon: <VisibilityIcon fontSize="small" />, hash: "#/observe" },
];

export function AdminDesk({ current, children }: { current: AdminSection; children: ReactNode }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const go = (hash: string) => {
    location.hash = hash;
    setAnchorEl(null);
  };

  const groupHeader = (label: string, marginBlockStart = 0) => (
    <Typography
      variant="caption"
      sx={{
        fontWeight: 700,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        color: "text.secondary",
        paddingInline: 1.5,
        paddingBlock: 0.75,
        marginBlockStart,
      }}
    >
      {label}
    </Typography>
  );

  const railItem = (item: NavItem) => {
    const active = item.key === current;
    return (
      <ButtonBase
        key={item.key}
        aria-current={active ? "page" : undefined}
        onClick={() => go(item.hash)}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 1.25,
          textAlign: "start",
          fontSize: "0.875rem",
          fontWeight: 600,
          color: active ? "text.primary" : "text.secondary",
          bgcolor: active ? alpha(INSPIRE, dark ? 0.16 : 0.1) : "transparent",
          borderRadius: "9px",
          paddingBlock: 1,
          paddingInline: 1.5,
          whiteSpace: "nowrap",
          "&:hover": { bgcolor: active ? alpha(INSPIRE, dark ? 0.16 : 0.1) : "action.hover" },
        }}
      >
        {item.icon}
        {t(item.labelKey)}
      </ButtonBase>
    );
  };

  // Exit — the desk is a place you leave, so the way out is the first thing in
  // the rail (Benjamin, 2026-08-10: "how do I get out?").
  const booksExit = (
    <ButtonBase
      onClick={() => go("#/books")}
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 1.25,
        textAlign: "start",
        fontSize: "0.875rem",
        fontWeight: 600,
        color: "text.secondary",
        borderRadius: "9px",
        paddingBlock: 1,
        paddingInline: 1.5,
        whiteSpace: "nowrap",
        "&:hover": { bgcolor: "action.hover", color: "text.primary" },
      }}
    >
      <ChevronLeftIcon
        fontSize="small"
        sx={theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined}
      />
      {t("adminDesk.nav.books")}
    </ButtonBase>
  );

  // Desktop: a sticky vertical rail beside the content column.
  const rail = (
    <Box
      component="nav"
      aria-label={t("adminDesk.a11y.adminSections")}
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "14px",
        padding: 1.25,
        display: "flex",
        flexDirection: "column",
        gap: 0.25,
        position: "sticky",
        insetBlockStart: 16,
        alignSelf: "start",
      }}
    >
      {booksExit}
      {groupHeader(t("adminDesk.groups.admin"))}
      {SECTIONS.map(railItem)}
      {groupHeader(t("adminDesk.groups.moreTools"), 0.5)}
      {TOOLS.map(railItem)}
    </Box>
  );

  // Narrow: a compact bar with the Books exit and a tap-to-open menu showing
  // the current section — collapses rather than scrolls (Benjamin 2026-08-17).
  const currentLabelKey =
    [...SECTIONS, ...TOOLS].find((i) => i.key === current)?.labelKey ?? "adminDesk.groups.admin";
  const menuItem = (item: NavItem) => {
    const active = item.key === current;
    return (
      <MenuItem
        key={item.key}
        selected={active}
        aria-current={active ? "page" : undefined}
        onClick={() => go(item.hash)}
        sx={{ minHeight: 44, gap: 1.25 }}
      >
        {item.icon}
        {t(item.labelKey)}
      </MenuItem>
    );
  };
  // Rendered into the global flow bar (FlowHeader), beside the account
  // controls, rather than as a card of its own under it (#299).
  const collapsedNav = (
    <FlowHeader>
      <Box
        component="nav"
        aria-label={t("adminDesk.a11y.adminSections")}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          paddingBlock: 0.5,
          paddingInline: 1,
        }}
      >
        {booksExit}
        <Button
          startIcon={<MenuIcon />}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          aria-haspopup="menu"
          aria-expanded={anchorEl ? true : undefined}
          sx={{
            minHeight: 44,
            flex: 1,
            justifyContent: "flex-start",
            textAlign: "start",
            color: "text.primary",
            fontWeight: 600,
          }}
        >
          {t(currentLabelKey)}
        </Button>
        <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
          <ListSubheader disableSticky>{t("adminDesk.groups.admin")}</ListSubheader>
          {SECTIONS.map(menuItem)}
          <ListSubheader disableSticky>{t("adminDesk.groups.moreTools")}</ListSubheader>
          {TOOLS.map(menuItem)}
        </Menu>
      </Box>
    </FlowHeader>
  );

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      <Box
        sx={{
          maxWidth: 1440,
          mx: "auto",
          paddingInline: 2,
          paddingBlock: 2,
          ...(wide
            ? { display: "grid", gridTemplateColumns: "232px minmax(0, 1fr)", gap: 2.5, alignItems: "start" }
            : { display: "flex", flexDirection: "column", gap: 1.5 }),
        }}
      >
        {wide ? rail : collapsedNav}
        <Box sx={{ minWidth: 0 }}>{children}</Box>
      </Box>
    </Box>
  );
}
