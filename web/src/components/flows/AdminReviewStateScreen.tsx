// i18n: user-visible strings use t() with keys under `adminPages.reviewState`
// (en/ar values in web/src/i18n/locales/*.json).
//
// AdminReviewStateScreen — #/admin/review, issue #296 (PR 2/2; the API half is
// api/src/reviewState.ts). Sets the BASELINE review state of every live
// translation note or question in one chapter, a chapter range, or a whole
// book: Approved (rows → 'validated') or Needs review (rows → 'edited', back in
// the review queue). The use case is an imported body of work whose real status
// is already known.
//
// A bulk sweep is deliberate by construction:
//   1. "Review change" sends the request with ?dryRun=1, which writes nothing
//      and returns the real number of rows the sweep would write.
//   2. A confirm dialog restates book, chapters, resource, new state and that
//      number, plus what the sweep does to in-progress rows, before anything is
//      written.
//   3. Only "Apply" sends the real request; the server's `changed` count is
//      shown afterwards and the per-chapter table reloads.
// The sweep's own safety rules (never touches content, deleted or trashed rows;
// stamps admin_bulk_state so AI few-shot examples exclude it) live server-side
// in reviewState.ts; this page only explains them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";

import { AdminDesk } from "./AdminDesk";
import { AdminPageHeader } from "./AdminPageHeader";
import type { FlowScreenContext } from "./types";
import {
  api,
  ApiError,
  type BookListEntry,
  type BookSummary,
  type ReviewSweepApplyResponse,
  type ReviewSweepDryRunResponse,
} from "../../sync/api";
import { bookName, BOOKS } from "../../lib/bookNames";
import { realChapters } from "../../lib/bookSummary";
import {
  buildReviewSweepBody,
  type ReviewSweepBody,
  type ReviewSweepResource,
  type ReviewSweepTarget,
} from "../../lib/reviewStateSweep";

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

export default function AdminReviewStateScreen({ role, me }: FlowScreenContext) {
  const { t } = useTranslation();
  const isAdmin = role === "admin";

  const [books, setBooks] = useState<BookListEntry[] | null>(null);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [book, setBook] = useState("");
  const [summary, setSummary] = useState<BookSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [resource, setResource] = useState<ReviewSweepResource>("tn");
  const [target, setTarget] = useState<ReviewSweepTarget>("approved");
  const [wholeBook, setWholeBook] = useState(false);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);

  const [checking, setChecking] = useState(false);
  // The confirmed sweep: the book is stored WITH the body so Apply writes exactly
  // what the dialog showed, never whatever the book picker says now.
  const [pending, setPending] = useState<{
    book: string;
    body: ReviewSweepBody;
    preview: ReviewSweepDryRunResponse;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ReviewSweepApplyResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The book currently selected, readable from async callbacks so a late
  // response for a previously selected book can be dropped.
  const bookRef = useRef(book);
  bookRef.current = book;
  // While a dry run is in flight, the dialog is open, or a sweep is running,
  // every scope control is locked so the scope cannot drift from what is shown.
  const locked = checking || pending != null || applying;

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
        // Default only on first init: a re-run (e.g. me.lastBook changing) must
        // not override a book the admin already picked.
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

  const loadSummary = useCallback((code: string, signal?: AbortSignal) => {
    setSummaryError(null);
    return api
      .getBookSummary(code, signal)
      .then((data) => {
        if (!signal?.aborted && bookRef.current === code) setSummary(data);
      })
      .catch((err) => {
        if (signal?.aborted || bookRef.current !== code) return;
        setSummaryError(err instanceof Error ? err.message : i18n.t("adminPages.common.loadFailed"));
      });
  }, []);

  // Per-chapter state mix for the selected book; resets the chapter pickers.
  useEffect(() => {
    if (!book) return;
    const ctrl = new AbortController();
    setSummary(null);
    setFrom(null);
    setTo(null);
    setResult(null);
    setActionError(null);
    setPending(null);
    void loadSummary(book, ctrl.signal);
    return () => ctrl.abort();
  }, [book, loadSummary]);

  const chapters = useMemo(() => realChapters(summary).sort((a, b) => a.chapter - b.chapter), [summary]);

  // Default the pickers to the book's first chapter once its summary lands.
  useEffect(() => {
    if (chapters.length && from == null && to == null) {
      setFrom(chapters[0].chapter);
      setTo(chapters[0].chapter);
    }
  }, [chapters, from, to]);

  const built = buildReviewSweepBody({ resource, target, wholeBook, from, to });

  const resourceLabel = (r: ReviewSweepResource) =>
    r === "tn" ? t("adminPages.reviewState.resourceTn") : t("adminPages.reviewState.resourceTq");
  const targetLabel = (s: ReviewSweepTarget) =>
    s === "approved" ? t("adminPages.reviewState.targetApproved") : t("adminPages.reviewState.targetNeedsReview");
  const scopeLabel = (body: ReviewSweepBody) =>
    "allChapters" in body
      ? t("adminPages.reviewState.scopeWholeBook")
      : "chapter" in body
        ? t("adminPages.reviewState.scopeChapter", { chapter: body.chapter })
        : t("adminPages.reviewState.scopeRange", { start: body.chapterStart, end: body.chapterEnd });

  const errorText = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 403) return t("adminPages.reviewState.errForbidden");
      const code = (e.body as { error?: string } | undefined)?.error;
      return `${e.status} — ${code ?? t("adminPages.common.loadFailed")}`;
    }
    return e instanceof Error ? e.message : t("adminPages.common.loadFailed");
  };

  const onReview = async () => {
    if (!built.ok || !book) return;
    const requested = book;
    const body = built.body;
    setChecking(true);
    setActionError(null);
    setResult(null);
    try {
      const preview = await api.reviewStateDryRun(requested, body);
      // Drop a preview for a book that is no longer selected.
      if (bookRef.current !== requested || preview.book !== requested) return;
      setPending({ book: requested, body, preview });
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const onApply = async () => {
    if (!pending) return;
    const { book: target, body } = pending;
    setApplying(true);
    setActionError(null);
    try {
      const res = await api.reviewStateApply(target, body);
      setResult(res);
    } catch (e) {
      // A timeout or dropped connection can land AFTER the server committed, so
      // say it may have partly applied and reload the counts either way.
      setActionError(t("adminPages.reviewState.errMaybeApplied", { detail: errorText(e) }));
    } finally {
      setPending(null);
      await loadSummary(target);
      setApplying(false);
    }
  };

  if (!isAdmin) {
    return (
      <AdminDesk current="review">
        <Alert severity="info">
          {t("adminPages.reviewState.adminOnlyBody")} {t("adminPages.common.yourRoleIs")} <strong>{role}</strong>.
        </Alert>
      </AdminDesk>
    );
  }

  const chapterPicker = (label: string, value: number | null, onChange: (n: number) => void) => (
    <TextField
      select
      size="small"
      label={label}
      value={value ?? ""}
      disabled={wholeBook || !chapters.length || locked}
      onChange={(e) => onChange(Number(e.target.value))}
      sx={{ minWidth: 120 }}
    >
      {chapters.map((c) => (
        <MenuItem key={c.chapter} value={c.chapter}>
          {c.chapter}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <AdminDesk current="review">
      <AdminPageHeader
        eyebrow={t("adminDesk.groups.admin")}
        title={t("adminPages.reviewState.title")}
        subtitle={t("adminPages.reviewState.subtitle")}
      />
      <Stack spacing={2}>
        {booksError && <Alert severity="error">{booksError}</Alert>}
        {books && books.length === 0 && <Alert severity="info">{t("adminPages.reviewState.noBooks")}</Alert>}

        <Box sx={panelSx()}>
          <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, mb: 1.5 }}>
            {t("adminPages.reviewState.setTitle")}
          </Typography>
          <Stack direction="row" flexWrap="wrap" gap={1.5} alignItems="center">
            <TextField
              select
              size="small"
              label={t("adminPages.reviewState.bookLabel")}
              value={book}
              disabled={!books?.length || locked}
              onChange={(e) => setBook(e.target.value)}
              sx={{ minWidth: 180 }}
            >
              {(books ?? []).map((b) => (
                <MenuItem key={b.book} value={b.book}>
                  {bookName(b.book)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label={t("adminPages.reviewState.resourceLabel")}
              value={resource}
              disabled={locked}
              onChange={(e) => setResource(e.target.value as ReviewSweepResource)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="tn">{resourceLabel("tn")}</MenuItem>
              <MenuItem value="tq">{resourceLabel("tq")}</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label={t("adminPages.reviewState.targetLabel")}
              value={target}
              disabled={locked}
              onChange={(e) => setTarget(e.target.value as ReviewSweepTarget)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="approved">{targetLabel("approved")}</MenuItem>
              <MenuItem value="needs_review">{targetLabel("needs_review")}</MenuItem>
            </TextField>
          </Stack>
          <Stack direction="row" flexWrap="wrap" gap={1.5} alignItems="center" sx={{ mt: 1.5 }}>
            {chapterPicker(t("adminPages.reviewState.fromLabel"), from, (n) => {
              setFrom(n);
              if (to == null || to < n) setTo(n);
            })}
            {chapterPicker(t("adminPages.reviewState.toLabel"), to, setTo)}
            <FormControlLabel
              control={<Checkbox checked={wholeBook} disabled={locked} onChange={(e) => setWholeBook(e.target.checked)} />}
              label={t("adminPages.reviewState.wholeBookLabel")}
            />
          </Stack>
          {!built.ok && built.error === "range_reversed" && (
            <Typography variant="body2" color="error" sx={{ mt: 1 }}>
              {t("adminPages.reviewState.errRangeReversed")}
            </Typography>
          )}
          <Button
            variant="contained"
            sx={{ mt: 2 }}
            disabled={!built.ok || !book || !chapters.length || locked}
            onClick={() => void onReview()}
          >
            {checking ? t("adminPages.reviewState.checking") : t("adminPages.reviewState.reviewButton")}
          </Button>
          {actionError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {actionError}
            </Alert>
          )}
          {result && (
            <Alert severity="success" sx={{ mt: 2 }}>
              {t("adminPages.reviewState.resultBody", {
                count: result.changed,
                chapters: result.changedChapters.length,
                state: targetLabel(result.state),
              })}
            </Alert>
          )}
        </Box>

        <Box sx={panelSx()}>
          <Typography component="h2" sx={{ fontSize: "1rem", fontWeight: 700, mb: 1 }}>
            {t("adminPages.reviewState.chaptersTitle", { book: book ? bookName(book) : "" })}
          </Typography>
          {summaryError && <Alert severity="error">{summaryError}</Alert>}
          {!summary && !summaryError && book && (
            <Typography variant="body2" color="text.secondary">
              {t("adminPages.reviewState.loading")}
            </Typography>
          )}
          {summary && (
            <Box sx={{ overflowX: "auto" }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("adminPages.reviewState.colChapter")}</TableCell>
                    <TableCell>{t("adminPages.reviewState.colNotes")}</TableCell>
                    <TableCell>{t("adminPages.reviewState.colQuestions")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {chapters.map((c) => (
                    <TableRow key={c.chapter}>
                      <TableCell>{c.chapter}</TableCell>
                      <TableCell>
                        {t("adminPages.reviewState.approvedOf", { done: c.tnValidated ?? "—", total: c.tn })}
                      </TableCell>
                      <TableCell>
                        {t("adminPages.reviewState.approvedOf", { done: c.tqValidated ?? "—", total: c.tq })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
        </Box>
      </Stack>

      <Dialog open={pending != null} onClose={() => !applying && setPending(null)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("adminPages.reviewState.confirmTitle")}</DialogTitle>
        {pending && (
          <DialogContent>
            <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 2, rowGap: 0.5, m: 0 }}>
              <Typography component="dt" color="text.secondary">{t("adminPages.reviewState.bookLabel")}</Typography>
              <Typography component="dd" sx={{ m: 0 }}>{bookName(pending.preview.book)}</Typography>
              <Typography component="dt" color="text.secondary">{t("adminPages.reviewState.chaptersLabel")}</Typography>
              <Typography component="dd" sx={{ m: 0 }}>{scopeLabel(pending.body)}</Typography>
              <Typography component="dt" color="text.secondary">{t("adminPages.reviewState.resourceLabel")}</Typography>
              <Typography component="dd" sx={{ m: 0 }}>{resourceLabel(pending.preview.resource)}</Typography>
              <Typography component="dt" color="text.secondary">{t("adminPages.reviewState.targetLabel")}</Typography>
              <Typography component="dd" sx={{ m: 0, fontWeight: 700 }}>{targetLabel(pending.preview.state)}</Typography>
              <Typography component="dt" color="text.secondary">{t("adminPages.reviewState.rowsLabel")}</Typography>
              <Typography component="dd" sx={{ m: 0, fontWeight: 700 }}>{pending.preview.wouldChange}</Typography>
            </Box>
            {pending.preview.wouldChange === 0 ? (
              <Alert severity="info" sx={{ mt: 2 }}>
                {t("adminPages.reviewState.nothingToChange")}
              </Alert>
            ) : (
              <Alert severity="warning" sx={{ mt: 2 }}>
                {pending.preview.state === "approved"
                  ? t("adminPages.reviewState.warnApprove")
                  : t("adminPages.reviewState.warnNeedsReview")}{" "}
                {t("adminPages.reviewState.warnCommon")}
              </Alert>
            )}
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setPending(null)} disabled={applying}>
            {t("adminPages.reviewState.cancel")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => void onApply()}
            disabled={applying || !pending || pending.preview.wouldChange === 0}
          >
            {applying ? t("adminPages.reviewState.applying") : t("adminPages.reviewState.apply")}
          </Button>
        </DialogActions>
      </Dialog>
    </AdminDesk>
  );
}
