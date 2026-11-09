// i18n: user-visible strings use t() with keys under `adminPages.scorecard`
// (en/ar values in web/src/i18n/locales/*.json).
//
// AdminDraftScorecardScreen — #/admin/scorecard, issue #816. A read-only,
// per-chapter measure of how good the AI's translation-note drafts are, for one
// book: of the notes a person has approved, how many were approved exactly as
// the AI drafted them, how close the drafts were overall, how often the editor
// still had to add a closing period after a final "]", and which context pack
// (the guidance the AI was given) each chapter's drafts were made with. It is
// how the translate learning loop tells whether a guidance change helps.
//
// All numbers come from GET /api/books/:book/draft-scorecard; the exact rules
// live in api/src/draftScorecard.ts. This page only lays them out.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  Alert,
  Box,
  Chip,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  type BookListEntry,
  type DraftScorecardChapter,
  type DraftScorecardResponse,
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

// "org/repo@0123456789…" → "0123456" (the short commit), the full ref in a tooltip.
function shortSha(ref: string): string {
  const at = ref.lastIndexOf("@");
  return at >= 0 ? ref.slice(at + 1, at + 8) : ref;
}

export default function AdminDraftScorecardScreen({ role, me }: FlowScreenContext) {
  const { t } = useTranslation();
  const isAdmin = role === "admin";

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [book, setBook] = useState("");
  const [data, setData] = useState<DraftScorecardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // The scorecard for the selected book.
  useEffect(() => {
    if (!book) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on book change, blank the previous book's numbers before fetching so they are never shown under the new book's name.
    setData(null);
    setError(null);
    api
      .getDraftScorecard(book, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted) setData(res);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.status === 403) setError(i18n.t("adminPages.scorecard.errForbidden"));
        else setError(err instanceof Error ? err.message : i18n.t("adminPages.common.loadFailed"));
      });
    return () => ctrl.abort();
  }, [book]);

  if (!isAdmin) {
    return (
      <AdminDesk current="scorecard">
        <Alert severity="info">
          {t("adminPages.scorecard.adminOnlyBody")} {t("adminPages.common.yourRoleIs")} <strong>{role}</strong>.
        </Alert>
      </AdminDesk>
    );
  }

  const dash = "—";
  const pct = (n: number) => n.toFixed(1);

  const chapterLabel = (c: DraftScorecardChapter) =>
    c.chapter == null
      ? t("adminPages.scorecard.bookTotal")
      : c.chapter === 0
        ? t("adminPages.scorecard.intro")
        : String(c.chapter);

  const contextCell = (c: DraftScorecardChapter) => {
    if (c.contextPacks.length === 0 && c.untracedDrafts === 0) return dash;
    return (
      <Stack direction="row" flexWrap="wrap" gap={0.5}>
        {c.contextPacks.map((p) =>
          p.ref ? (
            <Tooltip key={p.ref} title={p.ref}>
              <Chip
                size="small"
                variant="outlined"
                label={
                  <span>
                    <bdi style={{ fontFamily: "monospace" }}>{shortSha(p.ref)}</bdi>
                    {" · "}
                    {p.count}
                  </span>
                }
              />
            </Tooltip>
          ) : (
            <Chip
              key="none"
              size="small"
              variant="outlined"
              label={t("adminPages.scorecard.notPinned", { n: p.count })}
            />
          ),
        )}
        {c.untracedDrafts > 0 && (
          <Chip
            size="small"
            variant="outlined"
            sx={{ color: "text.secondary" }}
            label={t("adminPages.scorecard.runNotOnRecord", { n: c.untracedDrafts })}
          />
        )}
      </Stack>
    );
  };

  const row = (c: DraftScorecardChapter) => {
    const total = c.chapter == null;
    // Numbers never wrap: a wrapped "50.0% (1 of 2)" reorders badly in RTL.
    const cellSx = { whiteSpace: "nowrap", ...(total ? { fontWeight: 700 } : {}) } as const;
    return (
      <TableRow key={c.chapter ?? "total"} sx={total ? { bgcolor: "action.hover" } : undefined}>
        <TableCell sx={cellSx}>{chapterLabel(c)}</TableCell>
        <TableCell sx={cellSx}>{c.validated}</TableCell>
        <TableCell sx={cellSx}>{c.noDraft}</TableCell>
        <TableCell sx={cellSx}>{c.englishCheck === "all" ? c.englishSource : `${c.englishSource}*`}</TableCell>
        <TableCell sx={cellSx}>{c.compared}</TableCell>
        <TableCell sx={cellSx}>
          {c.unchangedPct == null
            ? dash
            : t("adminPages.scorecard.pctCount", { pct: pct(c.unchangedPct), n: c.unchanged })}
        </TableCell>
        <TableCell sx={cellSx}>{c.medianSimilarity == null ? dash : c.medianSimilarity.toFixed(2)}</TableCell>
        <TableCell sx={cellSx}>
          {c.closingPeriod.eligible === 0
            ? dash
            : t("adminPages.scorecard.pctOf", {
                pct: pct((c.closingPeriod.made / c.closingPeriod.eligible) * 100),
                made: c.closingPeriod.made,
                eligible: c.closingPeriod.eligible,
              })}
        </TableCell>
        <TableCell>{contextCell(c)}</TableCell>
      </TableRow>
    );
  };

  return (
    <AdminDesk current="scorecard">
      <AdminPageHeader
        eyebrow={t("adminDesk.groups.admin")}
        title={t("adminPages.scorecard.title")}
        subtitle={t("adminPages.scorecard.subtitle")}
      />
      <Stack spacing={2}>
        {booksError && <Alert severity="error">{booksError}</Alert>}
        {books && books.length === 0 && <Alert severity="info">{t("adminPages.scorecard.noBooks")}</Alert>}

        <Box sx={panelSx()}>
          <TextField
            select
            size="small"
            label={t("adminPages.scorecard.bookLabel")}
            value={book}
            disabled={!books?.length}
            onChange={(e) => setBook(e.target.value)}
            sx={{ minWidth: 180, mb: 2 }}
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
              {t("adminPages.scorecard.loading")}
            </Typography>
          )}
          {data && data.englishUncheckedChapters.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {data.total.englishCheck === "none"
                ? t("adminPages.scorecard.englishUncheckedAll")
                : t("adminPages.scorecard.englishUncheckedSome", {
                    chapters: data.englishUncheckedChapters
                      .map((ch) => (ch === 0 ? t("adminPages.scorecard.intro") : String(ch)))
                      .join(", "),
                  })}
              {/* The server's detail is English; dir="auto" keeps its full stop on the right end in the Arabic UI. */}
              <Typography variant="body2" color="text.secondary" dir="auto" sx={{ mt: 0.5 }}>
                {data.englishSourceProblem}
              </Typography>
            </Alert>
          )}
          {data && data.chapters.length === 0 && (
            <Alert severity="info">{t("adminPages.scorecard.noValidated")}</Alert>
          )}
          {data && data.chapters.length > 0 && (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("adminPages.scorecard.colChapter")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colValidated")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colNoDraft")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colEnglish")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colCompared")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colUnchanged")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colSimilarity")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colClosingPeriod")}</TableCell>
                    <TableCell>{t("adminPages.scorecard.colContextPack")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.chapters.map(row)}
                  {row(data.total)}
                </TableBody>
              </Table>
            </Box>
          )}
        </Box>

        <Box sx={panelSx()}>
          <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, mb: 1 }}>
            {t("adminPages.scorecard.howTitle")}
          </Typography>
          <Box component="ul" sx={{ m: 0, paddingInlineStart: 2.5, "& li": { mb: 0.5 } }}>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howScope")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howNoDraft")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howEnglish")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howUnchanged")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howSimilarity")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howClosingPeriod")}</Typography>
            <Typography component="li" variant="body2">{t("adminPages.scorecard.howContextPack")}</Typography>
          </Box>
        </Box>
      </Stack>
    </AdminDesk>
  );
}
