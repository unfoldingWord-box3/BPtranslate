// In-app Help panel: searchable table of contents plus article view over the
// bundled guide (help/<lang>/*.md → helpIndex.generated.json). This file is
// lazy-loaded from App.tsx so the guide JSON stays out of the main chunk.

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  IconButton,
  InputAdornment,
  Link,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { UiLangContext } from "../i18n/UiLangContext";
import helpIndexJson from "./helpIndex.generated.json";
import { articleForRoute, articlesFor, type HelpIndex } from "./guideMap";
import { searchHelp } from "./search";

const helpIndex = helpIndexJson as unknown as HelpIndex;

interface Props {
  open: boolean;
  /** Bumped by App on every open so a re-open resets the view. */
  openSeq: number;
  routeKey: string | null;
  initialArticle?: string;
  onClose: () => void;
}

const bodySx = {
  fontSize: 14,
  lineHeight: 1.6,
  overflowWrap: "anywhere",
  "& h1, & h2, & h3, & h4": { lineHeight: 1.3, marginBlock: "1.1em 0.4em" },
  "& h2": { fontSize: 17 },
  "& h3": { fontSize: 15 },
  "& p": { marginBlock: "0.6em" },
  "& ul, & ol": { paddingInlineStart: "1.4em", marginBlock: "0.6em" },
  "& li": { marginBlock: "0.2em" },
  "& table": { borderCollapse: "collapse", display: "block", overflowX: "auto", maxWidth: "100%" },
  "& th, & td": { border: "1px solid", borderColor: "divider", padding: "4px 8px", textAlign: "start" },
  "& code": { fontFamily: "monospace", fontSize: "0.9em" },
  "& img": { border: "1px solid", borderColor: "divider", borderRadius: 4 },
} as const;

export default function HelpDrawer({ open, openSeq, routeKey, initialArticle, onClose }: Props) {
  const { t } = useTranslation();
  const { lang } = useContext(UiLangContext);
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const articles = useMemo(() => articlesFor(helpIndex, lang), [lang]);
  // No guide in this UI language: the articles are the English fallback, so
  // keep them LTR even when the surrounding UI is RTL.
  const englishFallback = !helpIndex.langs[lang];
  const [query, setQuery] = useState("");
  const [articleId, setArticleId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Each open starts from the requested article, else the current screen's
  // article, else the table of contents.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on each open (openSeq bumps per click, even for the same article); the drawer stays mounted between opens, so there is no remount to reset it.
    setQuery("");
    const requested = initialArticle ? articles.find((a) => a.id === initialArticle) : undefined;
    const forRoute = routeKey ? articleForRoute(helpIndex, lang, routeKey) : null;
    setArticleId((requested ?? forRoute)?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openSeq]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [articleId, query]);

  const article = articleId ? articles.find((a) => a.id === articleId) ?? null : null;
  // A 0-1 character query is treated as empty: keep showing the article / TOC.
  const trimmed = query.trim().length < 2 ? "" : query.trim();
  const hits = useMemo(() => (trimmed ? searchHelp(articles, trimmed) : []), [articles, trimmed]);
  const general = articles.filter((a) => !(a.roles.length === 1 && a.roles[0] === "admin"));
  const adminOnly = articles.filter((a) => a.roles.length === 1 && a.roles[0] === "admin");

  const select = (id: string) => {
    setQuery("");
    setArticleId(id);
  };

  const components: Components = {
    a({ href, children }) {
      if (href?.startsWith("#help:")) {
        const id = href.slice("#help:".length);
        return (
          <Link component="button" type="button" onClick={() => select(id)} sx={{ font: "inherit", verticalAlign: "baseline" }}>
            {children}
          </Link>
        );
      }
      if (href && /^https?:\/\//i.test(href)) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }
      return <>{children}</>;
    },
    img({ src, alt }) {
      return <img src={src} alt={alt ?? ""} loading="lazy" style={{ maxWidth: "100%", height: "auto" }} />;
    },
  };

  const BackIcon = theme.direction === "rtl" && !englishFallback ? ArrowForwardIcon : ArrowBackIcon;

  const tocItem = (a: { id: string; title: string }) => (
    <ListItemButton key={a.id} onClick={() => select(a.id)}>
      <ListItemText primary={a.title} />
    </ListItemButton>
  );

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: isPhone ? "100%" : 420, maxWidth: "100%" }, "aria-label": t("help.title") } as object }}
    >
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <Box sx={{ p: 1.5, borderBlockEnd: "1px solid", borderColor: "divider" }}>
          <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
            <Typography variant="h6" component="h2" sx={{ flex: 1, fontSize: 18 }}>
              {t("help.title")}
            </Typography>
            <IconButton size="small" onClick={onClose} aria-label={t("help.close")}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Box>
          <TextField
            size="small"
            fullWidth
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            label={t("help.searchLabel")}
            placeholder={t("help.searchPlaceholder")}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
        </Box>

        <Box ref={scrollRef} dir={englishFallback ? "ltr" : undefined} sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 2, py: 1 }}>
          {trimmed ? (
            hits.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                {t("help.noResults", { query: trimmed })}
              </Typography>
            ) : (
              <List dense disablePadding aria-label={t("help.results")}>
                {hits.map((h) => (
                  <ListItemButton key={h.article.id} onClick={() => select(h.article.id)} sx={{ px: 0 }}>
                    <ListItemText
                      primary={h.article.title}
                      secondary={h.snippet || undefined}
                      slotProps={{ primary: { sx: { fontWeight: 600 } } }}
                    />
                  </ListItemButton>
                ))}
              </List>
            )
          ) : article ? (
            <Box>
              <Button size="small" startIcon={<BackIcon fontSize="small" />} onClick={() => setArticleId(null)} sx={{ mb: 1 }}>
                {t("help.allTopics")}
              </Button>
              <Typography variant="h5" component="h3" sx={{ fontSize: 20, fontWeight: 600 }}>
                {article.title}
              </Typography>
              <Box sx={bodySx}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                  {article.body}
                </ReactMarkdown>
              </Box>
            </Box>
          ) : (
            <List dense disablePadding aria-label={t("help.allTopics")}>
              {general.map(tocItem)}
              {adminOnly.length > 0 && (
                <>
                  <ListSubheader disableGutters sx={{ bgcolor: "transparent", lineHeight: "2.4em" }}>
                    {t("help.forAdmins")}
                  </ListSubheader>
                  {adminOnly.map(tocItem)}
                </>
              )}
            </List>
          )}
        </Box>
      </Box>
    </Drawer>
  );
}
