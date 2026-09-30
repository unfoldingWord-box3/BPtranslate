// Content-only, read-only panel body for a Flexible-layout region showing the
// tA (translationAcademy) or tW (translationWords) article associated with the
// currently active note/word. Mirrors TwArticleDialog's source-resolution and
// fetch logic (see that file) but has NO Dialog chrome — the panel's own
// header bar (PanelChrome) supplies the title.

import { useEffect, useState } from "react";
import { Box, Typography, Link, CircularProgress } from "@mui/material";
import { useTranslation } from "react-i18next";
import { MarkdownView } from "./MarkdownView";
import { fetchTwArticle, twArticleDcsUrl, type TwArticleSource } from "../lib/twArticle";
import { fetchTaArticle, taArticleDcsUrl, type TaArticleSource } from "../lib/taArticle";
import { resolveSourceRef } from "../lib/sourceRef";
import { directionForLang } from "../lib/isoLanguages";
import { useProjectConfig } from "../hooks/useProjectConfig";

interface Props {
  resource: "ta" | "tw";
  /** tN support_reference (ta) or TWL tw_link (tw); null when the active row carries none. */
  articleRef: string | null;
  /**
   * Whether a note/word is active at all. Distinct from `articleRef != null`:
   * plenty of tN rows carry no support_reference, and "you haven't picked a
   * note yet" must not be shown when the user has in fact picked one that
   * simply has no article to show.
   */
  selected: boolean;
}

export function AssociatedArticlePanel({ resource, articleRef, selected }: Props) {
  const { t } = useTranslation();
  const cfg = useProjectConfig();
  // A GL project reads the article from its translationSource (source repo,
  // which may live in a DIFFERENT org than translationSource.org); a
  // non-translation project reads its own org's repo. Default (null cfg) falls
  // back to unfoldingWord/en_ta or en_tw inside the fetch helper.
  // translationSource.repos (and cfg.repos) can be PARTIAL — guard so we never
  // fetch `${org}/undefined/...` and show a clear "no source" message instead.
  const source: TaArticleSource | TwArticleSource | undefined = cfg
    ? cfg.translationSource
      ? (resolveSourceRef(cfg.translationSource, resource) ?? undefined)
      : cfg.repos[resource]
        ? { org: cfg.org, repo: cfg.repos[resource]! }
        : undefined
    : undefined;
  const noSource = !!cfg && !source;
  // Direction follows the language the article is READ in (issue #523): the
  // translationSource's language when set, else the project's own direction.
  const articleDir = cfg?.translationSource
    ? directionForLang(cfg.translationSource.languageCode)
    : (cfg?.direction ?? "ltr");
  const sourceKey = source ? `${source.org}/${source.repo}` : "";

  const [title, setTitle] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!articleRef || noSource) return;
    let cancelled = false;
    setMarkdown(null);
    setTitle(null);
    setError(false);
    const promise =
      resource === "ta"
        ? fetchTaArticle(articleRef, source).then((a) => ({ title: a.title, body: a.body }))
        : fetchTwArticle(articleRef, source).then((body) => ({ title: null as string | null, body }));
    promise
      .then(({ title, body }) => {
        if (cancelled) return;
        setTitle(title);
        setMarkdown(body);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleRef, resource, sourceKey]);

  const dcsUrl = noSource
    ? ""
    : resource === "ta"
      ? taArticleDcsUrl(articleRef, source)
      : twArticleDcsUrl(articleRef, source);

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", scrollbarGutter: "stable", px: 2, py: 1 }}>
      {articleRef == null ? (
        <Typography color="text.secondary" variant="body2">
          {!selected
            ? resource === "ta"
              ? t("panelBody.selectNote")
              : t("panelBody.selectWord")
            : resource === "ta"
              ? t("panelBody.noNoteArticle")
              : t("panelBody.noWordArticle")}
        </Typography>
      ) : noSource ? (
        <Typography color="text.secondary" variant="body2">
          {resource === "ta" ? t("panelBody.noSourceTa") : t("panelBody.noSourceTw")}
        </Typography>
      ) : error ? (
        <Typography color="error" variant="body2">
          {t("panelBody.loadFailed")}{" "}
          {dcsUrl && (
            <Link href={dcsUrl} target="_blank" rel="noopener noreferrer">
              {t("panelBody.openOnDoor43")}
            </Link>
          )}
        </Typography>
      ) : markdown === null ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress size={24} />
        </Box>
      ) : (
        <Box dir={articleDir}>
          {resource === "ta" && title != null && (
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {title}
            </Typography>
          )}
          <MarkdownView markdown={markdown} baseUrl={dcsUrl || undefined} dir={articleDir} />
        </Box>
      )}
    </Box>
  );
}
