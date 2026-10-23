// Centered popup that renders a Translation Words article inline instead of
// sending the editor to a new Door43 tab. Fetches raw markdown on open and
// renders it with react-markdown; internal links resolve to Door43 (new tab).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  Box,
  Typography,
  IconButton,
  Link,
  CircularProgress,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import { MarkdownView } from "./MarkdownView";
import { fetchTwArticle, twArticleDcsUrl, twShort, type TwArticleSource } from "../lib/twArticle";
import { resolveSourceRef } from "../lib/sourceRef";
import { useProjectConfig } from "../hooks/useProjectConfig";

interface Props {
  articleId: string | null;
  onClose: () => void;
}

// First "# Heading" line is the article's display name ("vision, envision").
function titleFromMarkdown(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1] : fallback;
}


export function TwArticleDialog({ articleId, onClose }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  // A GL project reads tW articles from its translationSource (source repo, which
  // may live in a DIFFERENT org than translationSource.org); non-translation
  // projects read their own org's tW repo. Default (null cfg) falls back to
  // unfoldingWord/en_tw inside twArticle. translationSource.repos (and cfg.repos)
  // can be PARTIAL — the applicable tW repo may be blank (role left blank in
  // Setup). resolveSourceRef gives { org, repo } | null for the translation
  // branch; guard so we never fetch `${org}/undefined/...` and show a clear
  // "no tW source configured" message instead.
  const source: TwArticleSource | undefined = cfg
    ? cfg.translationSource
      ? (resolveSourceRef(cfg.translationSource, "tw") ?? undefined)
      : (cfg.repos.tw ? { org: cfg.org, repo: cfg.repos.tw } : undefined)
    : undefined;
  const noSource = !!cfg && !source;
  const sourceKey = source ? `${source.org}/${source.repo}` : "";

  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!articleId || noSource) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- blank the previous article before fetching the new one; without it the dialog shows the old tW article under the new heading until the fetch lands.
    setMarkdown(null);
    setError(false);
    fetchTwArticle(articleId, source)
      .then((md) => {
        if (!cancelled) setMarkdown(md);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, sourceKey]);

  const open = articleId !== null;
  // No source configured → no DCS link (it would otherwise resolve to the
  // unfoldingWord/en_tw default and mislead).
  const dcsUrl = noSource ? "" : twArticleDcsUrl(articleId, source);
  const title = markdown ? titleFromMarkdown(markdown, twShort(articleId)) : twShort(articleId);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth scroll="paper">
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          px: 3,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="h6" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
          {dcsUrl && (
            <Link href={dcsUrl} target="_blank" rel="noopener noreferrer" variant="body2" underline="hover">
              {t("dialogs.twArticle.viewOnDcs")}
            </Link>
          )}
          <IconButton size="small" onClick={onClose} aria-label={t("dialogs.common.close")}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
      <DialogContent dividers>
        {noSource ? (
          <Typography color="text.secondary" variant="body2">
            {t("dialogs.twArticle.noSource")}
          </Typography>
        ) : error ? (
          <Typography color="error" variant="body2">
            {t("dialogs.twArticle.loadFailed")}{" "}
            {dcsUrl && (
              <Link href={dcsUrl} target="_blank" rel="noopener noreferrer">
                {t("dialogs.twArticle.openOnDoor43")}
              </Link>
            )}
          </Typography>
        ) : markdown === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <MarkdownView markdown={markdown} baseUrl={dcsUrl ?? undefined} />
        )}
      </DialogContent>
    </Dialog>
  );
}
