// Persona-grouped pill navigation across the flow screens, after .flow-nav in
// docs/flows/ui/t1-home.html. Three groups — Translator / Lead / Admin — with
// the Admin group shown only to admins.
//
// The mockups drop the nav entirely below 700px, which strands admin screens
// with no way out. Here it collapses to a single menu button instead: the nav
// is always reachable at every width.

import { useState } from "react";
import { FlowHeader } from "./FlowHeader";
import { useTranslation } from "react-i18next";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import MenuIcon from "@mui/icons-material/Menu";
import useMediaQuery from "@mui/material/useMediaQuery";

export type FlowRole = "viewer" | "editor" | "admin";

export interface FlowNavProps {
  /** Id of the screen currently shown, e.g. "review". Marks that pill current. */
  current: string;
  book?: string;
  chapter?: number;
  verse?: number;
  role: FlowRole;
}

// Screens that address a passage fall back to these when the caller has no
// current location (e.g. the Admin screens, which aren't passage-scoped).
const DEFAULT_BOOK = "OBA";
const DEFAULT_CHAPTER = 1;
const DEFAULT_VERSE = 1;

// Labels are i18n keys, translated at render time — ids and hrefs stay
// untouched so routing and current-item matching are unaffected.
interface NavItem {
  id: string;
  labelKey: string;
  href: string;
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

function buildGroups(book: string, chapter: number, verse: number, role: FlowRole): NavGroup[] {
  const groups: NavGroup[] = [
    {
      labelKey: "adminDesk.flowNav.groups.translator",
      items: [
        { id: "home", labelKey: "adminDesk.flowNav.items.home", href: "#/home" },
        { id: "review", labelKey: "adminDesk.flowNav.items.review", href: `#/review/${book}/${chapter}` },
        { id: "scripture", labelKey: "adminDesk.flowNav.items.scripture", href: `#/scripture/${book}/${chapter}/${verse}` },
        { id: "verse", labelKey: "adminDesk.flowNav.items.verse", href: `#/verse/${book}/${chapter}/${verse}` },
        { id: "align", labelKey: "adminDesk.flowNav.items.align", href: `#/align/${book}/${chapter}/${verse}` },
        { id: "articles", labelKey: "adminDesk.flowNav.items.articles", href: "#/articles" },
        { id: "words", labelKey: "adminDesk.flowNav.items.words", href: `#/words/${book}/${chapter}/${verse}` },
      ],
    },
    {
      labelKey: "adminDesk.flowNav.groups.lead",
      items: [
        { id: "ai", labelKey: "adminDesk.flowNav.items.ai", href: "#/ai" },
        { id: "style", labelKey: "adminDesk.nav.style", href: "#/style" },
        { id: "curate", labelKey: "adminDesk.nav.templates", href: "#/curate" },
      ],
    },
  ];
  if (role === "admin") {
    groups.push({
      labelKey: "adminDesk.groups.admin",
      items: [
        { id: "setup", labelKey: "adminDesk.nav.setup", href: "#/setup" },
        { id: "books", labelKey: "adminDesk.nav.books", href: "#/books" },
        { id: "team", labelKey: "adminDesk.flowNav.items.team", href: "#/team" },
        { id: "observe", labelKey: "adminDesk.nav.observe", href: "#/observe" },
      ],
    });
  }
  return groups;
}

export function FlowNav({ current, book, chapter, verse, role }: FlowNavProps) {
  const { t } = useTranslation();
  // The mockup's own failure point. Below it we collapse rather than hide.
  const collapsed = useMediaQuery("(max-width:699.95px)");
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const groups = buildGroups(
    book ?? DEFAULT_BOOK,
    chapter ?? DEFAULT_CHAPTER,
    verse ?? DEFAULT_VERSE,
    role,
  );

  const currentItem = groups.flatMap((g) => g.items).find((i) => i.id === current);

  if (collapsed) {
    return (
      <FlowHeader>
        <Box
          component="nav"
          aria-label={t("adminDesk.flowNav.screens")}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            paddingBlock: 1,
            paddingInline: 1.5,
          }}
        >
          <Button
            startIcon={<MenuIcon />}
            onClick={(e) => setAnchorEl(e.currentTarget)}
            sx={{ minHeight: 44, textAlign: "start" }}
            aria-haspopup="menu"
            aria-expanded={anchorEl ? true : undefined}
          >
            {currentItem ? t(currentItem.labelKey) : t("adminDesk.flowNav.screens")}
          </Button>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
            {groups.flatMap((group) => [
              <ListSubheader key={`h-${group.labelKey}`} disableSticky>
                {t(group.labelKey)}
              </ListSubheader>,
              ...group.items.map((item) => (
                <MenuItem
                  key={item.id}
                  component="a"
                  href={item.href}
                  selected={item.id === current}
                  aria-current={item.id === current ? "page" : undefined}
                  onClick={() => setAnchorEl(null)}
                  sx={{ minHeight: 44 }}
                >
                  {t(item.labelKey)}
                </MenuItem>
              )),
            ])}
          </Menu>
        </Box>
      </FlowHeader>
    );
  }

  return (
    <FlowHeader>
      <Box
        component="nav"
        aria-label={t("adminDesk.flowNav.screens")}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          overflowX: "auto",
          paddingBlock: 1,
          paddingInline: 2.25,
        }}
      >
        {groups.map((group) => (
          <Box key={group.labelKey} sx={{ display: "flex", alignItems: "center", gap: 0.75, flex: "none" }}>
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "text.secondary",
                fontSize: "0.65rem",
                whiteSpace: "nowrap",
              }}
            >
              {t(group.labelKey)}
            </Typography>
            {group.items.map((item) => {
              const isCurrent = item.id === current;
              return (
                <Box
                  key={item.id}
                  component="a"
                  href={item.href}
                  aria-current={isCurrent ? "page" : undefined}
                  sx={{
                    flex: "none",
                    textDecoration: "none",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    borderRadius: 999,
                    paddingBlock: 0.625,
                    paddingInline: 1.375,
                    border: "1px solid",
                    borderColor: isCurrent ? "primary.main" : "divider",
                    bgcolor: isCurrent ? "action.selected" : "action.hover",
                    color: isCurrent ? "text.primary" : "text.secondary",
                    "&:hover": { color: "text.primary" },
                  }}
                >
                  {t(item.labelKey)}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </FlowHeader>
  );
}
