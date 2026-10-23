import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  CircularProgress,
  Divider,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError, isAdmin, type BookSourceOverride } from "../sync/api";
import { RepoRef } from "./SourceOverrideField";
import { UW_UPSTREAM_ORG, upstreamSourceForResource } from "../lib/orgDraft";

// Per-book resource source overrides (issue #103). Lives inside the Import
// workspace's "Advanced" accordion. Lists the book's current tN/tQ overrides
// and — for admins — offers an add/remove form. Reads are open to everyone;
// the PUT is admin-only server-side, so non-admins see a read-only list.
//
// A pasted Door43 URL is verified with api.verifySource BEFORE the PUT (mirrors
// SourceOverrideField); we send the verified { org, repo }, never the raw URL.

type Resource = "tn" | "tq";

// A whole-book override is stored as (0, 999); render it as "whole book".
const WHOLE_BOOK_START = 0;
const WHOLE_BOOK_END = 999;

function isWholeBook(o: BookSourceOverride): boolean {
  return o.chapter_start === WHOLE_BOOK_START && o.chapter_end === WHOLE_BOOK_END;
}

export function BookSourceOverridesPanel({ book }: { book: string }) {
  const { t } = useTranslation();
  const admin = isAdmin();

  const [overrides, setOverrides] = useState<BookSourceOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.getBookSources(book);
      setOverrides(res.overrides);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [book]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and on book change; refetch sets loading at start so the spinner shows instead of the previous book's overrides. Adding and clearing an override call the same refetch.
    void refetch();
  }, [refetch]);

  // Add-form state.
  const [resource, setResource] = useState<Resource>("tn");
  const [sourceType, setSourceType] = useState<"dcs" | "aquifer">("dcs");
  // For a Door43 source, choose the unfoldingWord upstream (repo derived from
  // the resource) or paste an arbitrary Door43 URL (issue #289). "upstream" is
  // the common case, so it's the default.
  const [dcsPreset, setDcsPreset] = useState<"upstream" | "url">("upstream");
  const [fromCh, setFromCh] = useState("");
  const [toCh, setToCh] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Aquifer is tN-only and always needs a chapter range (whole-book Aquifer uses
  // the "Pull Aquifer drafts" tool instead). Force resource back to tN when the
  // source type flips to Aquifer.
  const isAquifer = sourceType === "aquifer";

  // The repo the upstream preset resolves to, derived live from the resource so
  // it tracks the tN/tQ selector.
  const upstreamSource = upstreamSourceForResource(resource);

  const resetForm = () => {
    setResource("tn");
    setSourceType("dcs");
    setDcsPreset("upstream");
    setFromCh("");
    setToCh("");
    setUrl("");
    setFormError(null);
  };

  const handleAdd = useCallback(async () => {
    setFormError(null);
    const hasFrom = fromCh.trim() !== "";
    const hasTo = toCh.trim() !== "";
    // Both bounds or neither — a lone bound is ambiguous (mirrors the server's
    // range_needs_both_bounds check, caught here for a friendlier message).
    if (hasFrom !== hasTo) {
      setFormError(t("import.sources.rangeNeedsBoth"));
      return;
    }
    // Aquifer requires a range (whole-book Aquifer → Pull Aquifer drafts).
    if (isAquifer && !(hasFrom && hasTo)) {
      setFormError(t("import.sources.aquiferNeedsRange"));
      return;
    }
    setSaving(true);
    try {
      if (isAquifer) {
        // No repo to verify — the aqLang is derived server-side from the project.
        await api.setBookSource(book, {
          resource: "tn",
          kind: "aquifer",
          chapterStart: Number(fromCh),
          chapterEnd: Number(toCh),
        });
      } else {
        // The unfoldingWord upstream preset resolves to a known-good { org, repo }
        // with no round-trip (the URL path would just verify the same repo); the
        // "Other Door43 repo" path verifies the pasted URL → { org, repo }. Either
        // way we send org+repo, so the stored row is identical.
        const { org, repo } =
          dcsPreset === "upstream"
            ? upstreamSourceForResource(resource)
            : await api.verifySource(url.trim());
        await api.setBookSource(book, {
          resource,
          org,
          repo,
          ...(hasFrom && hasTo
            ? { chapterStart: Number(fromCh), chapterEnd: Number(toCh) }
            : {}),
        });
      }
      await refetch();
      resetForm();
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string } | undefined)?.error;
        // 409 overlap is the common, actionable mistake — call it out plainly.
        if (code === "overlapping_range") setFormError(t("import.sources.overlap"));
        else if (code === "range_needs_both_bounds" || code === "aquifer_needs_range")
          setFormError(t("import.sources.aquiferNeedsRange"));
        else if (code === "aquifer_language_unavailable")
          setFormError(t("import.sources.aquiferLangUnavailable"));
        else if (e.status === 403) setFormError(t("import.sources.adminOnly"));
        else setFormError(t("import.sources.saveFailed"));
      } else {
        setFormError(t("import.sources.saveFailed"));
      }
    } finally {
      setSaving(false);
    }
  }, [book, resource, isAquifer, dcsPreset, fromCh, toCh, url, refetch, t]);

  const handleRemove = useCallback(
    async (o: BookSourceOverride) => {
      setFormError(null);
      try {
        await api.clearBookSource(book, {
          resource: o.resource,
          chapterStart: o.chapter_start,
        });
        await refetch();
      } catch {
        setFormError(t("import.sources.removeFailed"));
      }
    },
    [book, refetch, t],
  );

  if (loading) {
    return (
      <Stack alignItems="center" sx={{ py: 2 }}>
        <CircularProgress size={18} />
      </Stack>
    );
  }
  if (loadError) {
    return (
      <Alert severity="error" variant="outlined" sx={{ py: 0 }}>
        {t("import.sources.loadFailed")}
      </Alert>
    );
  }

  return (
    <Stack spacing={1.5}>
      <Typography variant="caption" color="text.secondary">
        {t("import.sources.intro")}
      </Typography>

      {/* Current overrides, grouped by resource. */}
      {overrides.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t("import.sources.none")}
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {overrides.map((o) => (
            <Stack
              key={`${o.resource}:${o.chapter_start}`}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{ flexWrap: "wrap", rowGap: 0.5 }}
            >
              <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 32 }}>
                {o.resource === "tn"
                  ? t("import.sources.resourceTn")
                  : t("import.sources.resourceTq")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {isWholeBook(o)
                  ? t("import.sources.wholeBook")
                  : t("import.sources.chapterRange", {
                      start: o.chapter_start,
                      end: o.chapter_end,
                    })}
              </Typography>
              {o.kind === "aquifer" ? (
                <Typography variant="body2">
                  {t("import.sources.sourceAquifer", { lang: o.repo })}
                </Typography>
              ) : (
                <RepoRef org={o.org} repo={o.repo} />
              )}
              {admin && (
                <Button size="small" color="inherit" onClick={() => void handleRemove(o)}>
                  {t("import.sources.remove")}
                </Button>
              )}
            </Stack>
          ))}
        </Stack>
      )}

      {/* Add form (admins only) — non-admins see the read-only list above. */}
      {admin ? (
        <>
          <Divider />
          <Typography variant="subtitle2">{t("import.sources.addHeading")}</Typography>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }} alignItems="center">
            <Select
              size="small"
              value={sourceType}
              onChange={(e) => {
                const next = e.target.value as "dcs" | "aquifer";
                setSourceType(next);
                if (next === "aquifer") setResource("tn"); // Aquifer is tN-only
              }}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="dcs">{t("import.sources.sourceTypeDcs")}</MenuItem>
              <MenuItem value="aquifer">{t("import.sources.sourceTypeAquifer")}</MenuItem>
            </Select>
            <Select
              size="small"
              value={resource}
              onChange={(e) => setResource(e.target.value as Resource)}
              disabled={isAquifer}
              sx={{ minWidth: 140 }}
            >
              <MenuItem value="tn">{t("import.sources.resourceTn")}</MenuItem>
              <MenuItem value="tq">{t("import.sources.resourceTq")}</MenuItem>
            </Select>
            <TextField
              size="small"
              type="number"
              label={t("import.sources.fromChapter")}
              value={fromCh}
              onChange={(e) => setFromCh(e.target.value)}
              sx={{ width: 96 }}
            />
            <TextField
              size="small"
              type="number"
              label={t("import.sources.toChapter")}
              value={toCh}
              onChange={(e) => setToCh(e.target.value)}
              sx={{ width: 96 }}
            />
          </Stack>
          {isAquifer ? (
            <Typography variant="caption" color="text.secondary">
              {t("import.sources.aquiferWholeBookHint")}
            </Typography>
          ) : (
            <Stack spacing={1}>
              {/* Source preset: the unfoldingWord upstream (repo derived from the
                  resource) or a pasted Door43 URL for any other repo (issue #289). */}
              <Select
                size="small"
                value={dcsPreset}
                onChange={(e) => {
                  setDcsPreset(e.target.value as "upstream" | "url");
                  setFormError(null);
                }}
                disabled={saving}
                sx={{ minWidth: 280, maxWidth: 480 }}
              >
                <MenuItem value="upstream">
                  {t("import.sources.sourceUpstream", {
                    org: UW_UPSTREAM_ORG,
                    repo: upstreamSource.repo,
                  })}
                </MenuItem>
                <MenuItem value="url">{t("import.sources.sourceOther")}</MenuItem>
              </Select>
              {dcsPreset === "upstream" ? (
                <RepoRef org={upstreamSource.org} repo={upstreamSource.repo} />
              ) : (
                <TextField
                  size="small"
                  fullWidth
                  sx={{ maxWidth: 480 }}
                  label={t("import.sources.urlLabel")}
                  placeholder="https://git.door43.org/BibleAquifer/ar_tn"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={saving}
                />
              )}
            </Stack>
          )}
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="contained"
              size="small"
              disabled={
                saving ||
                (isAquifer
                  ? fromCh.trim() === "" || toCh.trim() === ""
                  : dcsPreset === "url" && url.trim() === "")
              }
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}
              onClick={() => void handleAdd()}
            >
              {saving ? t("import.sources.verifying") : t("import.sources.add")}
            </Button>
          </Stack>
        </>
      ) : (
        <Typography variant="caption" color="text.secondary">
          {t("import.sources.adminOnly")}
        </Typography>
      )}

      {formError && (
        <Alert severity="error" variant="outlined" sx={{ py: 0 }} onClose={() => setFormError(null)}>
          {formError}
        </Alert>
      )}
    </Stack>
  );
}
