// Per-verse TWL "Suggestions" — links the matcher proposes for the active verse
// that aren't already present. Additive by design (Rich's ask): the editor picks
// which to add; nothing is auto-deleted. Each suggestion shows the matched ULT
// English span and the proposed TW article; when a word maps to several articles
// a small dropdown disambiguates. "Add" hands the matched span back to the Shell,
// which resolves it to an OL quote + occurrence (twlResolve) and creates the row.

import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Box,
  Stack,
  Typography,
  IconButton,
  Tooltip,
  Chip,
  Select,
  MenuItem,
  CircularProgress,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import BlockIcon from "@mui/icons-material/Block";
import ReplayIcon from "@mui/icons-material/Replay";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { api, type TwlSuggestion } from "../sync/api";
import { useCatalogs } from "../hooks/useCatalogs";
import { TwArticleDialog } from "./TwArticleDialog";

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
function twShort(idOrLink: string): string {
  const m = idOrLink.match(/\/bible\/([^/]+\/[^/]+)$/);
  return m ? m[1] : idOrLink;
}

// Short id (kt/call-speakloudly) → full link, for catalog group lookups.
function twLinkOf(id: string): string {
  return id.startsWith("rc://") ? id : `rc://*/tw/dict/bible/${id}`;
}

interface Props {
  book: string;
  chapter: number;
  verse: number;
  // Changes whenever the verse's existing TWL links change, so the list
  // refetches and drops anything just added (the server excludes existing links).
  refreshKey: string;
  onAdd: (suggestion: TwlSuggestion, chosenArticleId: string) => void;
  // Drop suggestions already linked on the verse (resolved-OL identity, computed
  // by Shell against the live rows). Applied after fetch so adds/deletes reflect
  // without a server round-trip.
  isExcluded?: (suggestion: TwlSuggestion) => boolean;
  // Report the raw (pre-exclusion) suggestion list up so the parent can merge the
  // matcher's candidates onto committed rows. Emits [] on unmount / verse change.
  onSuggestions?: (suggestions: TwlSuggestion[]) => void;
  // Article ids blocked by the unlinked deny-list for this suggestion's resolved
  // quote. Blocked ids are pruned from the picker; a suggestion whose every
  // article is blocked is dropped entirely.
  blockedArticleIds?: (suggestion: TwlSuggestion, candidateIds?: string[]) => Set<string>;
  // Whether the deny-lists have settled (loaded or failed). The list holds off
  // rendering until then so a blocked suggestion can't show — or be added —
  // before isExcluded / blockedArticleIds have real data. Defaults to true so a
  // caller that doesn't wire filters is unaffected.
  filtersReady?: boolean;
  locked?: boolean;
  // When the Words lane is checked for this verse, new suggestions are paused
  // (the editor has signed off on the words here). The list collapses to a
  // one-line "paused" strip; "reopen" peeks it without un-checking the lane.
  paused?: boolean;
}

function TwlSuggestionsInner({ book, chapter, verse, refreshKey, onAdd, isExcluded, onSuggestions, blockedArticleIds, filtersReady = true, locked = false, paused = false }: Props) {
  const { t } = useTranslation();
  const [peeked, setPeeked] = useState(false);
  // Re-collapse when the verse changes or the lane is re-checked.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kept after commit on purpose: the fetch effect below depends on `peeked`, and moving this reset into render would change its request/abort sequence when navigating while paused and peeked.
    setPeeked(false);
  }, [book, chapter, verse, paused]);
  const [suggestions, setSuggestions] = useState<TwlSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Per-suggestion chosen article for disambiguation (keyed by span+occurrence).
  const [chosen, setChosen] = useState<Record<string, string>>({});
  // Proofreader-rejected suggestions (keyed by span+occurrence): crossed off in
  // place so reviewers can mark a verse as worked through. Local/session-only and
  // reversible — nothing is persisted or sent to the server.
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
  const [reloadNonce, setReloadNonce] = useState(0);
  // TW article shown in the in-app popup (null = closed).
  const [articleId, setArticleId] = useState<string | null>(null);
  const catalogs = useCatalogs();

  // The full sibling family for an article (kt/call-* ), as short ids — the same
  // global groups the committed-row badge uses. The matcher's per-match
  // disambiguation can collapse to one article when a specific phrase matched
  // ("Call out" → only kt/call-speakloudly); we still offer the family so the
  // editor can switch, consistent with the badge. Returns [] when not grouped.
  const familyOf = (id: string): string[] => {
    const idx = catalogs.disambiguationIndex?.[twLinkOf(id)];
    if (idx == null) return [];
    const group = catalogs.disambiguationGroups?.[idx];
    return group ? group.map((o) => twShort(o.link)) : [];
  };

  // Tracks the location the current `suggestions` belong to. A same-verse
  // refetch (add/delete a link → refreshKey ticks) keeps the old list visible
  // while the new one loads — isExcluded already drops the just-added row, so
  // the list shrinks smoothly instead of collapsing and re-expanding. Only an
  // actual navigation blanks first, so we never flash the previous verse's
  // suggestions against the new verse.
  const locRef = useRef(`${book}|${chapter}|${verse}`);

  useEffect(() => {
    // Skip the scan entirely while paused (and not peeking) — the whole point
    // is to stop proposing once the editor has signed off on words here.
    if (verse === 0 || (paused && !peeked)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- empty the list while paused or with no verse; without it the previous verse's suggestions stay on screen when there is nothing to scan.
      setSuggestions([]);
      return;
    }
    const loc = `${book}|${chapter}|${verse}`;
    if (locRef.current !== loc) {
      locRef.current = loc;
      setSuggestions([]);
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(false);
    api
      .getTwlSuggestions(book, chapter, verse, ctrl.signal)
      .then((r) => {
        setSuggestions(r.suggestions);
        setChosen({});
      })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        // AbortError on unmount/verse-change is normal; only surface real failures.
        if (e?.name !== "AbortError") setError(true);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [book, chapter, verse, refreshKey, reloadNonce, paused, peeked]);

  // Clear rejections only when the verse itself changes — NOT on refreshKey
  // (which ticks whenever a link is added/deleted on this verse). Otherwise a
  // normal "reject A, add B" flow would refetch and un-reject A. Adjusted
  // during render when the verse location changes.
  const rejectLoc = `${book}|${chapter}|${verse}`;
  const [prevRejectLoc, setPrevRejectLoc] = useState(rejectLoc);
  if (rejectLoc !== prevRejectLoc) {
    setPrevRejectLoc(rejectLoc);
    setRejected({});
  }

  // Report the raw list up (for committed-row alternative merging) whenever it
  // changes, and clear it on unmount so a stale list can't linger after the
  // panel hides (e.g. switching to the pinned multi-verse view).
  useEffect(() => {
    onSuggestions?.(suggestions);
  }, [suggestions, onSuggestions]);
  useEffect(() => () => onSuggestions?.([]), [onSuggestions]);

  const keyOf = (s: TwlSuggestion) => `${s.matchedText}|${s.glOccurrence}`;
  // Filter on each render — isExcluded / blockedArticleIds close over the live
  // verse rows + deny-lists, so adding/deleting a link or loading filters
  // updates the list immediately. Two passes: drop already-linked suggestions
  // (isExcluded) and deleted-here ones, then prune unlinked-blocked articles
  // from each survivor's picker, dropping any whose every article is blocked.
  const visible = suggestions
    .filter((s) => !(isExcluded?.(s) ?? false))
    .map((s) => {
      // Union the per-match disambiguation with the article's global family so a
      // confidently-resolved single match still exposes its siblings.
      const family = familyOf(s.articleId);
      const merged = family.length
        ? [...s.disambiguation, ...family.filter((id) => !s.disambiguation.includes(id))]
        : s.disambiguation;
      // Block over the merged candidate set, so a family sibling on the unlinked
      // deny-list is pruned just like a server-disambiguation one.
      const blocked = blockedArticleIds?.(s, merged);
      const allowed = blocked && blocked.size > 0 ? merged.filter((id) => !blocked.has(id)) : merged;
      return { s, allowed };
    })
    .filter(({ allowed }) => allowed.length > 0);

  // Blank the body when EITHER:
  //  - the deny-list filters haven't settled — we can't tell which suggestions
  //    are blocked yet, so rendering would flash addable links the deny-list is
  //    about to remove (and let them be clicked before it arrives); or
  //  - it's a first load with nothing to show yet.
  // A same-verse refetch (loading, filters already settled, list non-empty —
  // e.g. adding a link ticks refreshKey) keeps the current list rendered, so it
  // shrinks by one row in place instead of collapsing and re-expanding the box.
  // Crucially this only holds the list visible when the blank reason is
  // `loading`, never when it's `!filtersReady`.
  const showBlank = !filtersReady || (loading && suggestions.length === 0);

  if (paused && !peeked) {
    return (
      <Box sx={{ mt: 1.5 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ px: 1, py: 0.75, border: "1px dashed", borderColor: "divider", borderRadius: 1 }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 16, color: "primary.main" }} />
          <Typography variant="caption" sx={{ flex: 1, color: "text.secondary" }}>
            {t("dialogs.twlSuggestions.paused")}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "primary.main", cursor: "pointer", whiteSpace: "nowrap" }}
            onClick={() => setPeeked(true)}
          >
            {t("dialogs.twlSuggestions.reopen")}
          </Typography>
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 1.5 }}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 0.5, pl: 0.5 }}>
        <AutoAwesomeIcon fontSize="inherit" sx={{ fontSize: 14, color: "primary.main" }} />
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "text.secondary" }}
        >
          {t("dialogs.twlSuggestions.heading")}
        </Typography>
        <Chip
          label={showBlank ? "…" : visible.length}
          size="small"
          variant="outlined"
          sx={{ height: 16, fontFamily: "monospace", fontSize: 10 }}
        />
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t("dialogs.twlSuggestions.rescan")}>
          <span>
            <IconButton size="small" onClick={() => setReloadNonce((n) => n + 1)} disabled={loading} sx={{ p: 0.25 }}>
              {loading ? <CircularProgress size={14} /> : <RefreshIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      {error ? (
        <Typography variant="caption" color="error" sx={{ pl: 1 }}>
          {t("dialogs.twlSuggestions.loadFailed")}
        </Typography>
      ) : showBlank ? null : visible.length === 0 ? (
        <Typography variant="caption" color="text.disabled" sx={{ pl: 1, fontStyle: "italic" }}>
          {t("dialogs.twlSuggestions.empty")}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {visible.map(({ s, allowed }) => {
            const k = keyOf(s);
            // Keep `selected` within the allowed set: honor the user's pick if
            // still allowed, else the primary if allowed, else the first survivor.
            const selected =
              chosen[k] && allowed.includes(chosen[k])
                ? chosen[k]
                : allowed.includes(s.articleId)
                  ? s.articleId
                  : allowed[0];
            const ambiguous = allowed.length > 1;
            const isRejected = !!rejected[k];
            return (
              <Box
                key={k}
                sx={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto 28px 28px 28px",
                  alignItems: "center",
                  gap: 0.5,
                  px: 1,
                  py: 0.5,
                  border: "1px dashed",
                  borderColor: "divider",
                  borderRadius: 1,
                  bgcolor: isRejected ? "action.disabledBackground" : "primary.50",
                  opacity: isRejected ? 0.55 : 1,
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    sx={{
                      fontFamily: '"Source Serif Pro","Cambria","Times New Roman",serif',
                      fontSize: 14,
                      lineHeight: 1.2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textDecoration: isRejected ? "line-through" : "none",
                    }}
                  >
                    {s.matchedText}
                    {s.glOccurrence > 1 && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                        ·{s.glOccurrence}
                      </Typography>
                    )}
                  </Typography>
                </Box>
                {ambiguous ? (
                  <Select
                    value={selected}
                    onChange={(e) => setChosen((m) => ({ ...m, [k]: e.target.value }))}
                    size="small"
                    variant="standard"
                    sx={{ fontSize: 11, maxWidth: 150, "& .MuiSelect-select": { py: 0.25 } }}
                  >
                    {allowed.map((id) => (
                      <MenuItem key={id} value={id} sx={{ fontSize: 11 }}>
                        {twShort(id)}
                      </MenuItem>
                    ))}
                  </Select>
                ) : (
                  <Chip label={twShort(selected)} size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
                )}
                <Tooltip title={locked ? "" : t("dialogs.twlSuggestions.add")}>
                  <span>
                    <IconButton
                      size="small"
                      color="success"
                      disabled={locked || isRejected}
                      onClick={() => onAdd(s, selected)}
                      sx={{ p: 0.25 }}
                    >
                      <AddIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip
                  title={
                    isRejected
                      ? t("dialogs.twlSuggestions.undoReject")
                      : t("dialogs.twlSuggestions.reject")
                  }
                >
                  <IconButton
                    size="small"
                    color={isRejected ? "default" : "error"}
                    onClick={() => setRejected((m) => ({ ...m, [k]: !m[k] }))}
                    sx={{ p: 0.25 }}
                  >
                    {isRejected ? <ReplayIcon fontSize="small" /> : <BlockIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
                <Tooltip title={t("words.readArticle")}>
                  <IconButton
                    size="small"
                    onClick={() => setArticleId(selected)}
                    sx={{ p: 0.25, color: "text.secondary" }}
                  >
                    <OpenInNewIcon sx={{ fontSize: 15 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            );
          })}
        </Stack>
      )}
      <TwArticleDialog articleId={articleId} onClose={() => setArticleId(null)} />
    </Box>
  );
}

export const TwlSuggestions = memo(TwlSuggestionsInner);
