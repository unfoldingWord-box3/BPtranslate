// PackageHubScreen — the book-package navigation hub at #/package/{book}.
// This screen REPLACES the old flows pill bar: it is where a translator lands
// after picking a book, and the "Back to {book} package" chevron on every
// work screen points here. It renders no pill bar, no tabs, no pills — tappable
// surface rows in the visual language TranslateNotesScreen calibrated (same
// COLUMN_PX, topbar, card tokens, back chevron).
//
// ── 2026-08-10 responsive layouts + Alignment surface (Benjamin) ────────────
//
//   * Phone (<900px): unchanged — one centred COLUMN_PX column of stacked rows.
//   * md+ (>=900px, the same breakpoint TranslateWordsScreen/ArticlesScreen
//     use): the hub is navigation, not master-detail, so instead of a
//     list/detail desk the SAME surface cards flow into a responsive grid —
//     the design system's grid-3 idiom (docs/mockups/desktop-first/_design.css
//     .grid-3): repeat(auto-fit, minmax(320px, 1fr)) inside a 1440px centred
//     container. Section headers span the full grid width; each surface card
//     keeps its tallies and expands its chapter list inline inside its own
//     grid cell (alignItems start, so an open card never stretches its row
//     siblings; at md+ a long chapter list scrolls within the cell instead of
//     growing unbounded). No new chrome beyond that. Desktop >=1200px follows
//     the same rule — auto-fit adds columns as the 1440px desk allows.
//   * New Alignment surface, chapter-scoped like notes/questions, linking to
//     #/alignment/{book}/{ch} — TranslateAlignScreen's route contract (built
//     in a sibling 2026-08-10 slice; the hash is dead until that route lands
//     in App.tsx parseHash). It clones the Scripture surface's pattern
//     exactly: inline chapter expansion, a chapter with 0 verses disabled.
//     Chapter rows show the BookSummary verses count — alignment is
//     verse-scoped work and NO alignment-specific progress count exists on
//     any endpoint, so none is invented; the surface sub-line is descriptive
//     only.
//   * RTL: logical properties only (paddingInline / insetBlockStart /
//     marginBlockStart / textAlign start), and grid column order follows the
//     document direction, so the md+ layout flips for free.
//
// What it shows, and the evidence for every number:
//
//   * The ONLY book-level aggregate the API provides is BookSummary
//     (web/src/sync/api.ts:167-176): per-chapter counts of verses / tn / tq /
//     twl rows, fetched ONCE by useBook's summary fetch (GET /api/chapters/
//     {book}, api.ts:1589-1590; useBook.ts:66-79). Every count on this screen
//     is a sum or a row of that one response — no N+1, no per-chapter fetches.
//
//   * Lifecycle card (2026-08-24, docs/ux-simplification.md A4): the rollup
//     this header used to ask for now exists — GET /api/chapters/{book} grew
//     per-chapter `tnValidated` / `tqValidated` / `versesDone` (A2), still ONE
//     request via the same useBook summary fetch. So the card at the top shows
//     honest aggregate review progress (notes/questions approved, verses done)
//     plus, for admins, "Publish this book" (POST /api/exports/run {book},
//     #287 plumbing) and the latest per-resource publish outcomes with Door43
//     PR links (GET /api/exports?book=…, admin-only endpoint — non-admins see
//     the progress numbers only). The old rule still holds for everything
//     else: a verb or count with no backend is absent, not faked (Benjamin's
//     2026-08-07 precedent) — which is why the progress section hides itself
//     entirely when the API build predates the rollup fields (see
//     lib/packageLifecycle.ts reviewProgress).
//
//   * The Words & Articles row carries NO count. BookSummary.twl counts
//     word-LINK rows (occurrences in the text), but the Words screen lists
//     unique tw terms + ta articles (api.getArticles, api.ts:1865-1868) —
//     labelling an occurrence count as if it tallied that list would mislead,
//     and fetching two article lists just for a tally isn't worth it.
//
// Chapter selection: Scripture, Notes, Questions and Alignment are
// chapter-scoped (#/scripture/{book}/{ch}, #/notes/{book}/{ch},
// #/questions/{book}/{ch} — App.tsx parseHash:123-155 — plus
// #/alignment/{book}/{ch} per the route contract above), so tapping one of
// those rows expands an inline chapter list (one open at a time); tapping a
// chapter navigates. Words & Articles is book-scoped (#/words/{book}) and
// navigates directly — the two groups are labelled so the asymmetry reads as
// intentional. A chapter with zero notes/questions/verses renders disabled
// with an honest "No notes" sub rather than linking to an empty queue.
//
// Back chevron → #/books (the redesign's top level; #/home is the old flows
// home and retires with the rest of flexible mode). Data comes
// from the same one-column plumbing: useBook for the summary, useProjectConfig
// for the "{source} to {target}" sub-line (TranslateNotesScreen:547-549).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlowHeader } from "./FlowHeader";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Link,
  Snackbar,
  Stack,
  Typography,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import type { FlowScreenContext } from "./types";
import { api, ApiError, type BookSummary, type ExportSnapshot } from "../../sync/api";
import { useBook } from "../../hooks/useBook";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { bookName } from "../../lib/bookNames";
import { realChapters } from "../../lib/bookSummary";
import {
  classifySnapshot,
  isTerminalRunStatus,
  latestPerResource,
  progressPercent,
  reviewProgress,
  type ProgressPair,
} from "../../lib/packageLifecycle";
import { FlowStatusChip } from "./FlowStatusChip";

export interface PackageHubScreenProps extends FlowScreenContext {
  book: string;
  /**
   * Live in-session position (preferred over the stale `me.last*` boot
   * snapshot), mirrored from BooksScreen. The verse-view row opens the last
   * worked verse when it falls in this book; `null`/undefined or a different
   * book falls back to 1:1 (#453).
   */
  lastPosition?: { book: string; chapter: number; verse: number } | null;
}

// Same one-column reading measure as TranslateNotesScreen (its line 98).
const COLUMN_PX = 480;

// The four chapter-scoped surfaces expand in place; words navigates directly.
type ExpandableSurface = "scripture" | "notes" | "questions" | "alignment";

// What a chapter row counts. An IDENTITY, not a display string: it selects the
// i18n key ("No verses" / "{{count}} verses") at render time, so the label can
// pluralize and translate without the caller passing English prose.
type HubUnit = "verses" | "notes" | "questions";

interface HubChapterSummary {
  chapter: number;
  verses: number;
  tn: number;
  tq: number;
}

interface SurfaceRowProps {
  title: string;
  subText: string;
  onClick: () => void;
  cardSx: object;
  expanded?: boolean;
  expandable?: boolean;
  disabled?: boolean;
}

// One tappable surface row: title + sub + chevron, the artifact's .listitem
// translated to MUI. `expanded` rotates the chevron; `disabled` rows state
// their reason in the sub instead of pretending to lead anywhere.
//
// Hoisted to module scope (2026-08-16, nested-component audit, issue #172):
// declaring this inside PackageHubScreen's body gave it a new function
// identity on every parent render, so React remounted the whole subtree
// (and, for ChapterList below, reset its scroll position) on every hub
// re-render rather than just when its own props changed. All parent-closure
// state it used to read directly (`cardSx`) is now an explicit prop, same
// pattern as QaPair in TranslateQuestionsScreen.tsx.
function SurfaceRow({ title, subText, onClick, cardSx, expanded, expandable, disabled }: SurfaceRowProps) {
  return (
    <ButtonBase
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expandable ? expanded : undefined}
      sx={{
        ...cardSx,
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        width: "100%",
        textAlign: "start",
        justifyContent: "flex-start",
        paddingBlock: 1.5,
        paddingInline: 1.75,
        opacity: disabled ? 0.55 : 1,
        "&:hover": disabled ? undefined : { borderColor: "#31ADE3" },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600, fontSize: "0.97rem", m: 0 }}>{title}</Typography>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
          {subText}
        </Typography>
      </Box>
      <ChevronRightIcon
        fontSize="small"
        sx={{
          color: "text.secondary",
          flex: "none",
          transition: "transform 0.15s ease",
          transform: expanded ? "rotate(90deg)" : "none",
        }}
      />
    </ButtonBase>
  );
}

interface ChapterListProps {
  countOf: (c: HubChapterSummary) => number;
  unit: HubUnit;
  href: (chapter: number) => string;
  wide: boolean;
  chapters: HubChapterSummary[];
}

// Inline chapter list under an expanded surface row. Every entry is a row
// from the one BookSummary response; `count === 0` disables the entry.
//
// Hoisted to module scope alongside SurfaceRow (issue #172) — `wide` and
// `chapters` (formerly the closed-over `realChapters`) are now explicit
// props.
function ChapterList({ countOf, unit, href, wide, chapters }: ChapterListProps) {
  const { t } = useTranslation();
  return (
    <Stack
      spacing={0.75}
      sx={{
        paddingInlineStart: 2,
        paddingBlockStart: 0.75,
        // At md+ the list lives inside one grid cell — a long book scrolls
        // within the cell instead of growing it unbounded.
        ...(wide ? { maxHeight: 420, overflowY: "auto" } : {}),
      }}
    >
      {chapters.map((c) => {
        const n = countOf(c);
        const empty = n === 0;
        return (
          <ButtonBase
            key={c.chapter}
            disabled={empty}
            onClick={() => {
              location.hash = href(c.chapter);
            }}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              width: "100%",
              textAlign: "start",
              justifyContent: "flex-start",
              bgcolor: "action.hover",
              borderRadius: "9px",
              paddingBlock: 1,
              paddingInline: 1.5,
              opacity: empty ? 0.55 : 1,
            }}
          >
            <Typography sx={{ fontWeight: 600, fontSize: "0.9rem", flex: "none" }}>
              {t("adminPages.progress.chapterN", { chapter: c.chapter })}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
              {empty
                ? t(`flowVerse.hub.chapterEmpty.${unit}`)
                : t(`flowVerse.hub.chapterUnit.${unit}`, { count: n })}
            </Typography>
            {!empty && (
              <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary", flex: "none" }} />
            )}
          </ButtonBase>
        );
      })}
    </Stack>
  );
}

// One compact progress line on the lifecycle card: label, "x of y", and a
// thin determinate bar. Module scope like SurfaceRow/ChapterList (issue #172).
function ProgressLine({ label, pair }: { label: string; pair: ProgressPair }) {
  const { t } = useTranslation();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }}>
          {label}
        </Typography>
        <Typography
          variant="caption"
          sx={{ fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
        >
          {t("flowVerse.lifecycle.ofTotal", { done: pair.done, total: pair.total })}
        </Typography>
      </Box>
      <LinearProgress
        variant="determinate"
        value={progressPercent(pair)}
        sx={{ height: 4, borderRadius: 2, marginBlockStart: 0.5 }}
      />
    </Box>
  );
}

// Latest publish outcome for one resource: resource code, status chip
// (AdminWorkflowScreen's committed / needs-attention vocabulary plus the A1
// held_for_review state), a detail caption, and the Door43 PR link when the
// server could derive one (ExportSnapshot.prUrl) — otherwise plain PR #n text.
function OutcomeRow({ snapshot }: { snapshot: ExportSnapshot }) {
  const { t } = useTranslation();
  const outcome = classifySnapshot(snapshot);

  let chip: ReactNode;
  let detail: string | null = null;
  switch (outcome.kind) {
    case "committed":
      chip = <FlowStatusChip kind="ok" label={t("adminPages.workflow.chipCommitted")} />;
      detail = t("flowVerse.lifecycle.rowsCommitted", { count: outcome.rows });
      if (outcome.prProblem) detail += ` · ${outcome.prProblem}`;
      break;
    case "held":
      chip = <FlowStatusChip kind="draft" label={t("flowVerse.lifecycle.chipHeld")} />;
      detail = t("flowVerse.lifecycle.heldRows", { count: outcome.count });
      break;
    case "unchanged":
      chip = <FlowStatusChip kind="skip" label={t("flowVerse.lifecycle.chipUpToDate")} />;
      break;
    case "skipped":
      chip = <FlowStatusChip kind="skip" />;
      detail = outcome.reason;
      break;
    case "error":
      chip = <FlowStatusChip kind="warn" label={t("adminPages.workflow.chipNeedsAttention")} />;
      detail = outcome.detail;
      break;
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", minWidth: 0 }}>
      <Typography
        component="span"
        sx={{ fontWeight: 700, fontSize: "0.75rem", textTransform: "uppercase", inlineSize: 34, flex: "none" }}
      >
        {snapshot.resource}
      </Typography>
      {chip}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ flex: 1, minWidth: 120, overflowWrap: "anywhere" }}
      >
        {detail ?? ""}
      </Typography>
      {snapshot.prUrl ? (
        <Link
          href={snapshot.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          variant="caption"
          sx={{ fontWeight: 600, whiteSpace: "nowrap", flex: "none" }}
        >
          {t("adminPages.workflow.prNumber", { number: snapshot.pr_number })}
        </Link>
      ) : snapshot.pr_number != null ? (
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap", flex: "none" }}>
          {t("adminPages.workflow.prNumber", { number: snapshot.pr_number })}
          {snapshot.branch ? ` · ${snapshot.branch}` : ""}
        </Typography>
      ) : null}
    </Box>
  );
}

interface LifecycleCardProps {
  book: string;
  name: string;
  chapters: BookSummary["chapters"];
  admin: boolean;
  wide: boolean;
  cardSx: object;
}

// The lifecycle header card (docs/ux-simplification.md §1.3 / A4): aggregate
// review progress for everyone; publish button + latest per-resource publish
// outcomes for admins. GET /api/exports is requireAdmin, so non-admins never
// fetch it. Polling after a publish: exportsInstance every 5s until the
// Workflow reports a terminal status (complete/errored/terminated) or 60
// attempts (~5 min) pass, then the book-filtered snapshot list reloads.
function LifecycleCard({ book, name, chapters, admin, wide, cardSx }: LifecycleCardProps) {
  const { t } = useTranslation();

  const progress = useMemo(() => reviewProgress(chapters), [chapters]);

  const [snapshots, setSnapshots] = useState<ExportSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pollAttempts = useRef(0);

  const loadSnapshots = useCallback(async () => {
    try {
      // 25 rows ≈ 5 runs × 5 resources — enough that the latest row per
      // resource is present even after a couple of partial runs.
      const res = await api.exportsList({ book, limit: 25 });
      setSnapshots(res.snapshots);
      setSnapshotsError(false);
    } catch {
      setSnapshots(null);
      setSnapshotsError(true);
    }
  }, [book]);

  useEffect(() => {
    if (!admin) return;
    setSnapshots(null);
    setSnapshotsError(false);
    void loadSnapshots();
  }, [admin, loadSnapshots]);

  // Poll the Workflow instance after a publish. Interval-based like
  // AdminWorkflowScreen's lane-job poll; stops on terminal status or timeout.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    pollAttempts.current = 0;
    const timer = setInterval(() => {
      pollAttempts.current += 1;
      void (async () => {
        let status: string | null = null;
        try {
          const res = await api.exportsInstance(runId);
          const s = res.status as { status?: string } | null;
          status = typeof s?.status === "string" ? s.status : null;
        } catch {
          /* transient — keep polling until timeout */
        }
        if (!alive) return;
        if (status) setRunStatus(status);
        if (isTerminalRunStatus(status)) {
          clearInterval(timer);
          setRunId(null);
          setMsg(
            status === "complete"
              ? t("flowVerse.lifecycle.doneMsg")
              : t("flowVerse.lifecycle.failedMsg"),
          );
          void loadSnapshots();
        } else if (pollAttempts.current >= 60) {
          clearInterval(timer);
          setRunId(null);
          setMsg(t("flowVerse.lifecycle.timeoutMsg"));
          void loadSnapshots();
        }
      })();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId, loadSnapshots, t]);

  const handlePublishConfirmed = async () => {
    setRunBusy(true);
    try {
      const res = await api.exportsRun({ book });
      setRunId(res.id);
      setRunStatus(res.status);
      setMsg(t("flowVerse.lifecycle.queuedMsg"));
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null;
      setMsg(
        body?.error === "workflow_create_failed"
          ? t("flowVerse.lifecycle.alreadyRunning")
          : e instanceof ApiError
            ? t("flowVerse.lifecycle.startFailedHttp", { status: e.status })
            : t("flowVerse.lifecycle.startFailed"),
      );
    } finally {
      setRunBusy(false);
      setConfirmOpen(false);
    }
  };

  const latest = useMemo(() => (snapshots ? latestPerResource(snapshots) : []), [snapshots]);
  const publishing = runId != null;

  return (
    <Box
      sx={{
        ...cardSx,
        paddingBlock: 1.75,
        paddingInline: 1.75,
        minWidth: 0,
        ...(wide ? { gridColumn: "1 / -1" } : {}),
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
        <Typography component="h2" sx={{ fontWeight: 700, fontSize: "0.97rem", m: 0, flex: 1, minWidth: 0 }}>
          {t("flowVerse.lifecycle.title")}
        </Typography>
        {admin && (
          <Button
            variant="contained"
            size="small"
            disabled={publishing || runBusy}
            onClick={() => setConfirmOpen(true)}
            sx={{ flex: "none" }}
          >
            {t("flowVerse.lifecycle.publishButton")}
          </Button>
        )}
      </Box>

      {publishing && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, marginBlockStart: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {t("flowVerse.lifecycle.runningLine", { status: runStatus ?? "queued" })}
          </Typography>
        </Box>
      )}

      {progress && (
        <Box
          sx={{
            marginBlockStart: 1.5,
            display: "grid",
            gap: wide ? 2 : 1.25,
            // Three columns on the wide desk, stacked on phones.
            gridTemplateColumns: wide ? "repeat(3, minmax(0, 1fr))" : "1fr",
          }}
        >
          <ProgressLine label={t("flowVerse.lifecycle.notesApproved")} pair={progress.notes} />
          <ProgressLine label={t("flowVerse.lifecycle.questionsApproved")} pair={progress.questions} />
          <ProgressLine label={t("flowVerse.lifecycle.versesDone")} pair={progress.verses} />
        </Box>
      )}

      {admin && (
        <Box sx={{ marginBlockStart: 1.5 }}>
          <Typography
            variant="caption"
            component="p"
            sx={{ fontWeight: 700, color: "text.secondary", m: 0, marginBlockEnd: 0.75 }}
          >
            {t("flowVerse.lifecycle.latestResults")}
          </Typography>
          {snapshotsError ? (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {t("flowVerse.lifecycle.historyLoadFailed")}
            </Typography>
          ) : snapshots === null ? (
            <CircularProgress size={16} />
          ) : latest.length === 0 ? (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
              {t("flowVerse.lifecycle.notPublished")}
            </Typography>
          ) : (
            <Stack spacing={0.75}>
              {latest.map((s) => (
                <OutcomeRow key={s.resource} snapshot={s} />
              ))}
            </Stack>
          )}
        </Box>
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>{t("flowVerse.lifecycle.confirmTitle", { book: name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {t("flowVerse.lifecycle.confirmBody", { book: name })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>{t("adminPages.workflow.notNow")}</Button>
          <Button variant="contained" disabled={runBusy} onClick={() => void handlePublishConfirmed()}>
            {t("flowVerse.lifecycle.confirmRun")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={msg != null} autoHideDuration={6000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}

export default function PackageHubScreen({ book, role, lastPosition }: PackageHubScreenProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { skip } = theme.palette.flows;
  // md+ (>=900px): the surface cards flow into the grid-3 desk (file header).
  const wide = useMediaQuery(theme.breakpoints.up("md"));

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || t("flowWords.target");

  const { summary, summaryStatus } = useBook(book, true);

  const [open, setOpen] = useState<ExpandableSurface | null>(null);

  // BookSummary includes a chapter-0 entry for book front matter (intro tn
  // rows, 0 verses — verified against GET /api/chapters/ZEC: ids 0–14 for a
  // 14-chapter book). The hub shows real chapters only: intro rows are not
  // reachable through the chapter-scoped translate screens, so counting them
  // here would advertise work this screen can't open.
  const chapters = useMemo(() => realChapters(summary), [summary]);

  const totals = useMemo(() => {
    let verses = 0;
    let tn = 0;
    let tq = 0;
    for (const c of chapters) {
      verses += c.verses;
      tn += c.tn;
      tq += c.tq;
    }
    return { chapters: chapters.length, verses, tn, tq };
  }, [chapters]);

  const name = bookName(book);
  const sub = translationMode
    ? t("flowVerse.hub.subTranslation", {
        source: (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase(),
        target: targetLabel,
      })
    : t("flowVerse.hub.subPlain", { target: targetLabel });

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow:
      theme.palette.mode === "dark"
        ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
        : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
  };

  const sectionHeadSx = {
    display: "flex",
    alignItems: "baseline",
    gap: 1,
    marginBlockStart: 1.25,
    marginInline: 0.25,
    // At md+ the container is a grid — headers span every column.
    ...(wide ? { gridColumn: "1 / -1" } : {}),
  };

  // One grid cell at md+ (a surface row plus its inline chapter list); at
  // phone widths the wrapper is inert — same stacking, same 1.25 gap.
  const cellSx = {
    display: "flex",
    flexDirection: "column" as const,
    gap: 1.25,
    minWidth: 0,
  };

  const sectionTitleSx = {
    fontSize: "0.75rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    m: 0,
  };

  const toggle = (id: ExpandableSurface) => setOpen((cur) => (cur === id ? null : id));

  return (
    <Box sx={{ height: "100%", minHeight: 0, overflowY: "auto", textAlign: "start" }}>
      {/* topbar */}
      <FlowHeader>
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <IconButton
              aria-label={t("adminPages.progress.backToBooks")}
              onClick={() => {
                location.hash = "#/books";
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                {name}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {sub}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            {summaryStatus === "ready" && (
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                  color: "text.secondary",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                }}
              >
                {t("flowVerse.hub.chapterCount", { count: totals.chapters })}
              </Typography>
            )}
          </Stack>
          {/* Progress lives on the lifecycle card below (A4), fed by the A2
              rollup — not duplicated in this topbar. */}
        </Box>
      </FlowHeader>

      <Box
        sx={{
          maxWidth: wide ? 1440 : COLUMN_PX,
          mx: "auto",
          paddingInline: 2,
          paddingBlockStart: wide ? 1.5 : 1,
          paddingBlockEnd: 4,
          ...(wide
            ? {
                // grid-3 idiom (_design.css): panel cards, as many columns as
                // the 1440px desk fits. alignItems start keeps an expanded
                // card from stretching its row siblings.
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: 2,
                alignItems: "start",
              }
            : { display: "flex", flexDirection: "column", gap: 1.25 }),
        }}
      >
        {summaryStatus === "error" ? (
          <Alert severity="error" sx={{ mt: 1, ...(wide ? { gridColumn: "1 / -1" } : {}) }}>
            {t("flowWords.loadError", { book: name })}
          </Alert>
        ) : summaryStatus !== "ready" ? (
          <Stack
            alignItems="center"
            justifyContent="center"
            sx={{ paddingBlock: 8, ...(wide ? { gridColumn: "1 / -1" } : {}) }}
          >
            <CircularProgress />
          </Stack>
        ) : (
          <>
            <LifecycleCard
              book={book}
              name={name}
              chapters={chapters}
              admin={role === "admin"}
              wide={wide}
              cardSx={cardSx}
            />

            <Box sx={sectionHeadSx}>
              <Typography component="h2" sx={sectionTitleSx}>
                {t("flowVerse.hub.sectionChapters")}
              </Typography>
            </Box>

            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("panelTitle.scripture")}
                subText={`${t("flowVerse.hub.chapterCount", { count: totals.chapters })} · ${t(
                  "flowVerse.hub.verseCount",
                  { count: totals.verses },
                )}`}
                expandable
                expanded={open === "scripture"}
                onClick={() => toggle("scripture")}
              />
              {open === "scripture" && (
                <ChapterList
                  wide={wide}
                  chapters={chapters}
                  countOf={(c) => c.verses}
                  unit="verses"
                  href={(ch) => `#/scripture/${book}/${ch}`}
                />
              )}
            </Box>

            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("shell.notes")}
                subText={
                  totals.tn === 0
                    ? t("flowVerse.hub.noNotesIn", { book: name })
                    : t("flowVerse.hub.noteCount", { count: totals.tn })
                }
                expandable
                expanded={open === "notes"}
                disabled={totals.tn === 0}
                onClick={() => toggle("notes")}
              />
              {open === "notes" && (
                <ChapterList
                  wide={wide}
                  chapters={chapters}
                  countOf={(c) => c.tn}
                  unit="notes"
                  href={(ch) => `#/notes/${book}/${ch}`}
                />
              )}
            </Box>

            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("shell.questions")}
                subText={
                  totals.tq === 0
                    ? t("flowVerse.hub.noQuestionsIn", { book: name })
                    : t("flowVerse.hub.questionCount", { count: totals.tq })
                }
                expandable
                expanded={open === "questions"}
                disabled={totals.tq === 0}
                onClick={() => toggle("questions")}
              />
              {open === "questions" && (
                <ChapterList
                  wide={wide}
                  chapters={chapters}
                  countOf={(c) => c.tq}
                  unit="questions"
                  href={(ch) => `#/questions/${book}/${ch}`}
                />
              )}
            </Box>

            {/* Verse counts, not alignment progress — no alignment-specific
                count exists on any endpoint (file header), so the sub stays
                descriptive and chapter rows reuse BookSummary.verses. */}
            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("panelTitle.alignment")}
                subText={t("flowVerse.hub.alignmentSub")}
                expandable
                expanded={open === "alignment"}
                onClick={() => toggle("alignment")}
              />
              {open === "alignment" && (
                <ChapterList
                  wide={wide}
                  chapters={chapters}
                  countOf={(c) => c.verses}
                  unit="verses"
                  href={(ch) => `#/alignment/${book}/${ch}`}
                />
              )}
            </Box>

            <Box sx={sectionHeadSx}>
              <Typography component="h2" sx={sectionTitleSx}>
                {t("flowVerse.hub.sectionWholeBook")}
              </Typography>
            </Box>

            {/* Verse view (#447): the alignment-joined original/literal/
                simplified fidelity surface (VerseScreen, #/verse) was built but
                left unreachable once the old pill bar retired (#173) — relink it here.
                It opens at the last worked verse in this book when known
                (#453), else 1:1; the screen's own topbar pages between verses
                from there. */}
            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("flowVerse.hub.verseView")}
                subText={t("flowVerse.hub.verseViewSub")}
                onClick={() => {
                  const at =
                    lastPosition && lastPosition.book === book
                      ? { chapter: Math.max(1, lastPosition.chapter), verse: Math.max(1, lastPosition.verse) }
                      : { chapter: 1, verse: 1 };
                  location.hash = `#/verse/${book}/${at.chapter}/${at.verse}`;
                }}
              />
            </Box>

            <Box sx={cellSx}>
              <SurfaceRow
                cardSx={cardSx}
                title={t("flowWords.title")}
                subText={t("flowVerse.hub.wordsSub")}
                onClick={() => {
                  location.hash = `#/words/${book}`;
                }}
              />
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
