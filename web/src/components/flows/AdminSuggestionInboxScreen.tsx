// i18n: user-visible strings use t() with keys under `adminPages.suggestions`
// (en/ar values in web/src/i18n/locales/*.json).
//
// AdminSuggestionInboxScreen — #/admin/suggestions, issue #819. For one book,
// the corrections editors keep making to the AI's translation-note drafts
// (the same change, at least 10 times across at least 3 chapters), each as a
// card with a suggested home for it:
//   - house-style rule: after a confirmation (the rule changes every future
//     draft, all books, notes and questions), Approve creates the rule, switched on, on the server
//     (POST /api/suggestion-inbox/:book/approve, which rebuilds it from its
//     own data);
//   - term / template / Common issues: those editors have no prefill, so
//     Approve copies a ready line to the clipboard, shows it, and links to the
//     editor;
//   - Reject: never suggested again.
// The cards are computed when the page loads (no nightly job); the rules are
// in api/src/suggestionInbox.ts. This page only lays them out.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  type BookListEntry,
  type Suggestion,
  type SuggestionHome,
  type SuggestionInboxResponse,
} from "../../sync/api";
import { bookName, BOOKS } from "../../lib/bookNames";

const CANON_INDEX = new Map(BOOKS.map((b, i) => [b.code, i]));
const canonSort = (a: BookListEntry, b: BookListEntry) =>
  (CANON_INDEX.get(a.book.toUpperCase()) ?? 999) - (CANON_INDEX.get(b.book.toUpperCase()) ?? 999) ||
  a.book.localeCompare(b.book);

function panelSx() {
  return {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    padding: 2,
  } as const;
}

const HOME_LABEL: Record<SuggestionHome, string> = {
  house_style: "adminPages.suggestions.homeHouseStyle",
  template: "adminPages.suggestions.homeTemplate",
  term: "adminPages.suggestions.homeTerm",
  common_issues: "adminPages.suggestions.homeCommonIssues",
};

// Where Approve sends a non-rule card, and the label of that link.
// The kind of house-style rule a card would create (api/src/houseStyle.ts kinds).
const KIND_LABEL: Record<string, string> = {
  literal: "adminPages.suggestions.kindLiteral",
  whole_word: "adminPages.suggestions.kindWholeWord",
  final_bracket_period: "adminPages.suggestions.kindFinalBracketPeriod",
};

const HOME_EDITOR: Record<Exclude<SuggestionHome, "house_style">, { hash: string; labelKey: string }> = {
  template: { hash: "#/admin/curate", labelKey: "adminPages.suggestions.openTemplates" },
  term: { hash: "#/admin/style", labelKey: "adminPages.suggestions.openTerms" },
  common_issues: { hash: "#/admin/style", labelKey: "adminPages.suggestions.openCommonIssues" },
};

// The text Approve copies for a non-rule home. Symbols only, no UI language:
// it is pasted into the workspace's own guidance. A Common issues line holds
// both texts, which is what hides the card once it is saved there.
// Arrows are not mirrored in right-to-left text, so an Arabic or Hebrew line
// gets "←" to keep pointing from the old words to the new ones. Right-to-left
// is decided by Unicode script: Hebrew (U+0590–05FF), Arabic (U+0600–06FF and
// its supplements and presentation forms), Syriac, Thaana, N'Ko.
const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;

function copyText(s: Suggestion): string {
  const arrow = RTL_SCRIPT.test(s.before + s.after) ? "←" : "→";
  const after = s.after === "" ? "∅" : `«${s.after}»`;
  return s.home === "common_issues" ? `- «${s.before}» ${arrow} ${after}` : `${s.before} ${arrow} ${s.after}`;
}

// The changed text. Not monospace: monospace fonts lack Arabic shaping, and
// the live test showed "(مُكيَّف)" with its parentheses drawn apart.
const changeTextSx = { fontSize: "1.05rem", fontWeight: 600 } as const;

export default function AdminSuggestionInboxScreen({ role, me }: FlowScreenContext) {
  const { t } = useTranslation();
  const theme = useTheme();
  const isAdmin = role === "admin";

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [book, setBook] = useState("");
  const [data, setData] = useState<SuggestionInboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadGen, setReloadGen] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Per-card outcome: a done message, an error, or the copied line for a non-rule home.
  const [cardMsg, setCardMsg] = useState<Record<string, { severity: "success" | "error" | "info"; text: string }>>({});
  const [notice, setNotice] = useState<string | null>(null);
  // The rule card waiting for the admin to confirm (a rule changes every future draft).
  const [confirming, setConfirming] = useState<Suggestion | null>(null);

  // Workspace books — one request (GET /api/books).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .getBooks()
      .then((res) => {
        if (cancelled) return;
        const sorted = [...res.books].sort(canonSort);
        setBooks(sorted);
        const last = me?.lastBook?.toUpperCase();
        setBook((prev) =>
          prev && sorted.some((b) => b.book === prev)
            ? prev
            : (sorted.find((b) => b.book === last)?.book ?? sorted[0]?.book ?? ""),
        );
      })
      .catch((err) => {
        // i18n.t (singleton), not the hook's t, so a language switch can't refire this.
        if (!cancelled) setBooksError(err instanceof Error ? err.message : i18n.t("adminPages.common.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, me?.lastBook]);

  // The inbox for the selected book, recomputed on each load.
  useEffect(() => {
    if (!book) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on book change, blank the previous book's cards before fetching so they are never shown under the new book's name.
    setData(null);
    setError(null);
    api
      .getSuggestionInbox(book, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted) setData(res);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 403) setError(i18n.t("adminPages.suggestions.errForbidden"));
        else setError(err instanceof Error ? err.message : i18n.t("adminPages.common.loadFailed"));
      });
    return () => ctrl.abort();
  }, [book, reloadGen]);

  const setMsg = (key: string, severity: "success" | "error" | "info", text: string) =>
    setCardMsg((m) => ({ ...m, [key]: { severity, text } }));

  const approve = useCallback(
    async (s: Suggestion) => {
      if (s.home !== "house_style") {
        // No prefill in those editors: copy the line and show it with a link.
        const text = copyText(s);
        let copied = true;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          copied = false;
        }
        setMsg(s.key, "info", i18n.t(copied ? "adminPages.suggestions.copied" : "adminPages.suggestions.copyFailed"));
        return;
      }
      setBusyKey(s.key);
      try {
        await api.approveSuggestion(book, s.key);
        setNotice(i18n.t("adminPages.suggestions.ruleAdded", { before: s.before }));
        setReloadGen((g) => g + 1);
      } catch (err) {
        const code = err instanceof ApiError ? (err.body as { error?: string } | null)?.error : null;
        setMsg(
          s.key,
          "error",
          code === "suggestion_not_found"
            ? i18n.t("adminPages.suggestions.errGone")
            : code === "rule_mismatch"
              ? i18n.t("adminPages.suggestions.errMismatch")
              : code === "rule_imprecise"
                ? i18n.t("adminPages.suggestions.errImprecise")
                : err instanceof Error
              ? err.message
              : i18n.t("adminPages.common.loadFailed"),
        );
      } finally {
        setBusyKey(null);
      }
    },
    [book],
  );

  const reject = useCallback(async (s: Suggestion) => {
    setBusyKey(s.key);
    try {
      await api.rejectSuggestion(book, s.key);
      // Drop the card and count it in the "Not shown" footer, as a reload would.
      setData((d) =>
        d
          ? {
              ...d,
              suggestions: d.suggestions.filter((x) => x.key !== s.key),
              excluded: { ...d.excluded, rejected: d.excluded.rejected + 1 },
            }
          : d,
      );
      setNotice(i18n.t("adminPages.suggestions.rejected"));
    } catch (err) {
      const gone = err instanceof ApiError && err.status === 404;
      setMsg(
        s.key,
        "error",
        gone ? i18n.t("adminPages.suggestions.errGone") : err instanceof Error ? err.message : i18n.t("adminPages.common.loadFailed"),
      );
    } finally {
      setBusyKey(null);
    }
  }, [book]);

  if (!isAdmin) {
    return (
      <AdminDesk current="suggestions">
        <Alert severity="info">
          {t("adminPages.suggestions.adminOnlyBody")} {t("adminPages.common.yourRoleIs")} <strong>{role}</strong>.
        </Alert>
      </AdminDesk>
    );
  }

  const chapterList = (chs: number[]) =>
    chs
      .map((ch) => (ch === 0 ? t("adminPages.suggestions.intro") : String(ch)))
      .join(t("adminPages.suggestions.listSep"));

  const changeLine = (s: Suggestion) => (
    <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
      <Box component="bdi" sx={{ ...changeTextSx, bgcolor: "action.hover", px: 0.75, borderRadius: 1 }}>
        {s.before}
      </Box>
      {/* The row follows the page direction, so in Arabic the old words are on the right. */}
      <Typography component="span" aria-hidden>
        {theme.direction === "rtl" ? "←" : "→"}
      </Typography>
      {s.after === "" ? (
        <Chip size="small" variant="outlined" label={t("adminPages.suggestions.deleted")} />
      ) : (
        <Box component="bdi" sx={{ ...changeTextSx, bgcolor: "action.hover", px: 0.75, borderRadius: 1 }}>
          {s.after}
        </Box>
      )}
      {s.change === "insert-end" && (
        <Chip size="small" variant="outlined" label={t("adminPages.suggestions.atEnd")} />
      )}
    </Stack>
  );

  const card = (s: Suggestion) => {
    const msg = cardMsg[s.key];
    const editor = s.home !== "house_style" ? HOME_EDITOR[s.home] : null;
    return (
      <Box key={s.key} sx={panelSx()} data-testid="suggestion-card">
        <Stack spacing={1.25}>
          {changeLine(s)}
          <Typography variant="body2">
            <span style={{ whiteSpace: "nowrap" }}>
              {t("adminPages.suggestions.hitsOf", { hits: s.hits, opportunities: s.opportunities })}
            </span>
            {" · "}
            {t("adminPages.suggestions.chapters", { chapters: chapterList(s.chapters) })}
          </Typography>
          <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Typography variant="body2" color="text.secondary">
              {t("adminPages.suggestions.suggestedHome")}
            </Typography>
            <Chip size="small" color="primary" variant="outlined" label={t(HOME_LABEL[s.home])} />
            {s.rule && (
              <Typography variant="body2" color="text.secondary">
                {t("adminPages.suggestions.ruleKind", {
                  kind: t(KIND_LABEL[s.rule.kind] ?? "adminPages.suggestions.kindLiteral"),
                })}
              </Typography>
            )}
          </Stack>
          {s.precision && (
            <Typography variant="body2" data-testid="rule-precision">
              {t("adminPages.suggestions.precision", {
                fires: s.precision.fires,
                correct: s.precision.correct,
                pct: s.precision.fires ? Math.round((s.precision.correct / s.precision.fires) * 100) : 0,
              })}
              {s.home !== "house_style" &&
                ` ${t("adminPages.suggestions.precisionBelow", { min: Math.round(s.precision.minPrecision * 100) })}`}
            </Typography>
          )}
          <Box component="ul" sx={{ m: 0, paddingInlineStart: 2.5, "& li": { mb: 0.75 } }}>
            {s.examples.map((e) => (
              <Typography component="li" variant="body2" key={e.rowId}>
                <Typography component="span" variant="body2" color="text.secondary">
                  {t("adminPages.suggestions.exampleChapter", { chapter: chapterList([e.chapter]) })}
                </Typography>
                <Box sx={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 1 }}>
                  <Typography component="span" variant="body2" color="text.secondary">
                    {t("adminPages.suggestions.draft")}
                  </Typography>
                  {/* justifySelf start: each excerpt sits next to its label, laid out by its own direction. */}
                  <Typography component="span" variant="body2" dir="auto" sx={{ justifySelf: "start" }}>
                    {e.draft}
                  </Typography>
                  <Typography component="span" variant="body2" color="text.secondary">
                    {t("adminPages.suggestions.final")}
                  </Typography>
                  <Typography component="span" variant="body2" dir="auto" sx={{ justifySelf: "start" }}>
                    {e.final}
                  </Typography>
                </Box>
              </Typography>
            ))}
          </Box>
          {msg && (
            <Alert severity={msg.severity}>
              {msg.text}
              {msg.severity === "info" && editor && (
                <Stack spacing={1} sx={{ mt: 1 }}>
                  <Box component="bdi" sx={{ ...changeTextSx, display: "block", userSelect: "all" }}>
                    {copyText(s)}
                  </Box>
                  <Box>
                    <Button size="small" variant="outlined" href={editor.hash}>
                      {t(editor.labelKey)}
                    </Button>
                  </Box>
                </Stack>
              )}
            </Alert>
          )}
          <Stack direction="row" flexWrap="wrap" gap={1}>
            <Button
              size="small"
              variant="contained"
              disabled={busyKey === s.key}
              onClick={() => (s.home === "house_style" ? setConfirming(s) : void approve(s))}
            >
              {s.home === "house_style"
                ? t("adminPages.suggestions.approveRule")
                : t("adminPages.suggestions.approveCopy")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              disabled={busyKey === s.key || data?.notMigrated}
              onClick={() => void reject(s)}
            >
              {t("adminPages.suggestions.reject")}
            </Button>
          </Stack>
        </Stack>
      </Box>
    );
  };

  const ex = data?.excluded;
  const excludedTotal = ex ? ex.rejected + ex.rule + ex.term + ex.template + ex.commonIssues + ex.lesson : 0;

  return (
    <AdminDesk current="suggestions">
      <AdminPageHeader
        eyebrow={t("adminDesk.groups.admin")}
        title={t("adminPages.suggestions.title")}
        subtitle={t("adminPages.suggestions.subtitle")}
      />
      <Stack spacing={2}>
        {booksError && <Alert severity="error">{booksError}</Alert>}
        {books && books.length === 0 && <Alert severity="info">{t("adminPages.suggestions.noBooks")}</Alert>}

        <Box sx={panelSx()}>
          <TextField
            select
            size="small"
            label={t("adminPages.suggestions.bookLabel")}
            value={book}
            disabled={!books?.length}
            onChange={(e) => {
              setNotice(null);
              setCardMsg({});
              setBook(e.target.value);
            }}
            sx={{ minWidth: 180, mb: 1.5 }}
          >
            {(books ?? []).map((b) => (
              <MenuItem key={b.book} value={b.book}>
                {bookName(b.book)}
              </MenuItem>
            ))}
          </TextField>

          {error && <Alert severity="error">{error}</Alert>}
          {!data && !error && book && (
            <Typography variant="body2" color="text.secondary">
              {t("adminPages.suggestions.loading")}
            </Typography>
          )}
          {data && (
            <Typography variant="body2" color="text.secondary">
              {t("adminPages.suggestions.scanned", {
                compared: data.scanned.compared,
                validated: data.scanned.validated,
              })}
              {data.scanned.skippedLong > 0 && ` ${t("adminPages.suggestions.skippedLong", { n: data.scanned.skippedLong })}`}
            </Typography>
          )}
        </Box>

        {/* A rule changes every AI draft that arrives from now on, so it is confirmed first. */}
        <Dialog open={confirming != null} onClose={() => setConfirming(null)} maxWidth="sm" fullWidth>
          <DialogTitle>{t("adminPages.suggestions.confirmTitle")}</DialogTitle>
          <DialogContent>
            {confirming && (
              <Stack spacing={1.5}>
                {changeLine(confirming)}
                <Typography variant="body2">
                  {t("adminPages.suggestions.confirmBody", {
                    kind: t(KIND_LABEL[confirming.rule?.kind ?? "literal"] ?? "adminPages.suggestions.kindLiteral"),
                  })}
                </Typography>
              </Stack>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirming(null)}>{t("adminPages.suggestions.confirmCancel")}</Button>
            <Button
              variant="contained"
              onClick={() => {
                const s = confirming;
                setConfirming(null);
                if (s) void approve(s);
              }}
            >
              {t("adminPages.suggestions.confirmOk")}
            </Button>
          </DialogActions>
        </Dialog>

        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)}>
            <bdi>{notice}</bdi>
          </Alert>
        )}
        {data?.notMigrated && <Alert severity="warning">{t("adminPages.suggestions.notMigrated")}</Alert>}
        {data && data.suggestions.length === 0 && (
          <Alert severity="info">
            {t("adminPages.suggestions.none", { hits: data.minHits, chapters: data.minChapters })}
          </Alert>
        )}
        {data && data.suggestions.map(card)}
        {ex && excludedTotal > 0 && (
          <Typography variant="body2" color="text.secondary">
            {t("adminPages.suggestions.excluded", {
              rule: ex.rule,
              term: ex.term,
              template: ex.template,
              commonIssues: ex.commonIssues,
              rejected: ex.rejected,
            })}
          </Typography>
        )}

        <Box sx={panelSx()}>
          <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, mb: 1 }}>
            {t("adminPages.suggestions.howTitle")}
          </Typography>
          <Box component="ul" sx={{ m: 0, paddingInlineStart: 2.5, "& li": { mb: 0.5 } }}>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howWhen")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howChange")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howThreshold")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howHits")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howExcluded")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howHome")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howApprove")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.suggestions.howReject")}</Typography>
          </Box>
        </Box>
      </Stack>
    </AdminDesk>
  );
}
