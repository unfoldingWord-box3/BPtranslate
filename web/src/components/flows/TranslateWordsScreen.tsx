// i18n: user-visible strings go through t() under the `flowWords` namespace
// (plus `common.*` for exact shared verbs).
//
// TranslateWordsScreen — the per-book "Words & Articles" translation queue,
// built to the approved "Words & Articles · Titus" artifact and following the
// patterns TranslateNotesScreen / TranslateQuestionsScreen established (drafts
// store, honest disabled states, one centred column at every width, save
// before any state-changing verb).
//
// Route: #/words/{book} (list + detail are internal state, like the artifact's
// two views — no sub-route). The back chevron aims at #/package/{book}, the
// per-book hub screen. Translation-primary by construction: NO authoring
// chrome (no populate / add-by-id / search rail — those live on ArticlesScreen
// and ArticleWorkspace), no FlowNav, hash nav + back-chevrons only.
//
// ── 2026-08-10 list restructure + responsive layouts (Benjamin) ─────────────
//
//   * "Separate the words from the articles": the list now has two top-level
//     parts — Words and Academy articles — instead of the old flat
//     "Key terms" / "Academy articles" pair (which mislabelled all tW terms
//     as key terms).
//   * "The words into key terms, names, and other as collapsible": within
//     Words, three collapsible groups keyed on the tw category already in the
//     id (kt → Key terms, names → Names, other → Other). Key terms opens by
//     default; Names and Other start collapsed. The Academy articles section
//     header uses the same collapsible pattern for consistency (open by
//     default). Open/closed state is component state — session-local, not
//     persisted. Each header shows its count and approved tally.
//   * "Tablet and desktop layouts": below md (900px, the same breakpoint
//     ArticlesScreen uses) nothing changed — single centred column, list ⇄
//     detail as swapped views. At md+ the screen becomes master-detail after
//     the desk-class primitives in docs/mockups/desktop-first/_design.css
//     (.desk / .rail / .panel): a scrollable list pane (340-380px) on the
//     inline-start side, a panel-chromed detail pane filling the rest, both
//     inside a 1440px centred desk. Selecting a row loads the detail pane in
//     place (ArticleDetail variant="pane": no back chevron, action bar sticky
//     at the pane's bottom instead of fixed to the viewport). Logical
//     properties only throughout — the grid order itself flips under RTL.
//   * "Sort by frequency in the book, descending" (Benjamin, same day): within
//     each group, rows order by the book count — tW occurrence count, tA
//     linked-notes count — most-referenced first, so the most effective work
//     is prioritized visually. Ties break alphabetically by id (stable).
//     Populated vs unpopulated deliberately does NOT affect order: frequency
//     is the only primary key, and an unpopulated high-frequency term ranking
//     first is correct — it's the most effective thing to populate.
//
// ── Data (all real; nothing sampled from the artifact) ─────────────────────
//
//   * Which articles belong to this book, and how often:
//       - tW terms  = distinct tw_link across the book's twl rows
//         (deleted_at IS NULL), counted per article → "N occurrences".
//       - tA articles = distinct support_reference across the book's tn rows
//         (deleted_at/trashed_at IS NULL), counted per article → "linked from
//         N notes".
//     There is NO book-scoped article index endpoint — BookSummary
//     (web/src/sync/api.ts:167-176) carries per-chapter row COUNTS only — so
//     this screen loads the book's chapters through useBook.loadChapter (the
//     same whole-book pattern BookView uses) and derives the sets client-side.
//     Chapter payloads carry verses this screen never reads; that weight is
//     the price of honest per-book counts today. Counts fill in progressively
//     as chapters land, and a failed chapter is reported as possibly-missing
//     counts rather than silently under-counting.
//   * Ref → article-id parsing mirrors the server's own rules
//     (api/src/articlePopulate.ts:66-116, whitelists at :40-42): rc:// or bare
//     forms, tA one-segment refs defaulting to the "translate" manual.
//   * Article sources + translations = article_units via api.getArticles /
//     api.getArticle (web/src/sync/api.ts:1863-1875). tA articles are
//     title / sub-title / body parts; tW articles are body-only
//     (api/src/articlePopulate.ts:129-141).
//
// ── Verbs (each verified against the real API) ─────────────────────────────
//
//   * Approve  → save-then-validate, in that order and awaited: PATCH
//     /api/articles/:resource/unit (If-Match CAS, api/src/articles.ts:78-149)
//     for every dirty part, then POST /unit/validate value=1
//     (api/src/articles.ts:156-205) for every part with a non-NULL
//     translation_state. The validate guard (articles.ts:185) means a
//     never-drafted article has nothing to approve — the button disables with
//     that reason instead of 404ing. Articles have NO chapter lock (the lock
//     lives in api/src/rows.ts; articles.ts checks none), so no LockBanner.
//   * Save     → the same PATCH without the validate step. The artifact has no
//     Save (its "Done" commits to page memory only), but a real translator
//     needs a server write that does not also approve — ArticleWorkspace and
//     ArticlesScreen both ship exactly this button, so it stays.
//   * Redo     → the article-scoped ASYNC translate pipeline job:
//     pipelineStore.start({ pipelineType: "translate", translate:
//     { resourceType, articleId } }) (POST /api/pipelines/start,
//     web/src/sync/api.ts:1289-1298 + 2097; same wiring as
//     ArticlesScreen.tsx:687-700). Unlike tq — whose redo was hidden at
//     60cea3d because only a chapter-scoped job existed — articles have a
//     per-article job, so the verb is real and stays, but honestly async: a
//     spinner plus "runs in the background", with pipelineStore.onComplete
//     reloading the article when the job lands. (onComplete fires for ANY
//     translate job this user is polling, not just this article's — the same
//     accepted looseness as ArticlesScreen.tsx:562-573.) A 503 from the
//     pipeline proxy (BT_API_TOKEN unset) sets a sticky "AI drafting isn't set
//     up" note, mirroring TranslateNotesScreen.
//   * Needs work → HIDDEN (not rendered disabled-forever; Benjamin's
//     2026-08-07 precedent, see TranslateQuestionsScreen's header at 60cea3d).
//     The article state machine is NULL | ai_draft | edited | validated
//     (web/src/sync/api.ts:1050; api/src/articles.ts:151-205) — there is no
//     "needs work" state to write. The nearest existing verb, unvalidate
//     (validate value=0), only demotes validated → edited and is not a flag.
//     If the team wants this verb, it needs a schema/state addition first;
//     wire it then.
//
// ── Deviations from the artifact, and why ──────────────────────────────────
//
//   * The artifact's edit mode is ONE whole-draft textarea (its data model is
//     an array of paired blocks with no server behind it). The real storable
//     unit is a PART's target_md (tw: body; ta: title / sub-title / body), so
//     tap-to-edit here opens a textarea per PART — for tW that is exactly the
//     artifact's whole-article edit; for tA it is three honest units. Blocks
//     inside a body are display-only pairing (split on markdown headings),
//     never separately savable — pretending otherwise would invent an entity
//     the server cannot store.
//   * List rows show the article id's slug, not a target-language display
//     title: GET /api/articles/:resource excludes source_md/target_md for
//     weight (api/src/articles.ts:39-55), and fetching every full unit just to
//     render a list line is not worth N requests. Real titles (first heading
//     of the markdown / the tA title part) appear in the detail view, where
//     the full units are loaded anyway.
//   * "Both" keeps two columns side-by-side at every width (the artifact
//     overrides its own .pair collapse for exactly this screen) — type drops a
//     step so two narrow columns stay readable. When source and target section
//     counts differ, the by-block pairing would misalign, so it degrades to
//     two whole columns with a visible note.
//
// Every keystroke goes to the IndexedDB drafts store (articleKey,
// web/src/sync/drafts.ts:140-143), restored on mount, cleared when the server
// confirms — no save-on-unmount, no confirm dialogs. Article drafts are NOT
// cleared by the outbox listener in drafts.ts (it only handles verse/row
// keys); this screen clears them itself once a PATCH round-trips, the same
// contract ArticlesScreen.tsx:575-586 implements.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowHeader } from "./FlowHeader";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CheckIcon from "@mui/icons-material/Check";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SaveIcon from "@mui/icons-material/Save";

import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import type { FlowScreenContext } from "./types";

import { useArticles } from "../../hooks/useArticles";
import { useBook } from "../../hooks/useBook";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { api, ApiError, type ArticleUnit, type ArticleUnitMeta } from "../../sync/api";
import { drafts as draftStore, articleKey, type DraftRecord } from "../../sync/drafts";
import { pipelineStore, getSessionKey } from "../../sync/pipelineStore";
import { MarkdownView } from "../MarkdownView";
import { realChapterNumbers } from "../../lib/bookSummary";
import { resolveFlowChipStatus, flowChipKind, type FlowChipStatus } from "../../lib/flowStatusChip";

export interface TranslateWordsScreenProps extends FlowScreenContext {
  book: string;
}

type Resource = "tw" | "ta";
type ArticleState = "ai_draft" | "edited" | "validated" | null;
type Lang = "target" | "source" | "both";

// Collapsible list groups: the three tw categories plus the Academy articles
// section (whose header follows the same pattern).
type GroupKey = "kt" | "names" | "other" | "ta";

// Content width — the artifact's 430px phone shell, given the same extra room
// the notes/questions screens take.
const COLUMN_PX = 480;

// Session-wide default for the language segment: a freshly opened article
// inherits whatever mode was last used (the artifact's lastLang behaviour).
let sessionLang: Lang = "target";

// ── ref → article id (client twins of api/src/articlePopulate.ts:66-116) ───

const TA_MANUALS = new Set(["translate", "checking", "process", "intro"]);
const TW_CATEGORIES = new Set(["kt", "names", "other"]);
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

function stripMd(seg: string): string {
  return seg.replace(/\.md$/, "");
}

function twArticleIdOf(link: string | null | undefined): string | null {
  if (!link) return null;
  const raw = link.trim();
  if (!raw) return null;
  let segs: string[];
  if (raw.startsWith("rc://")) {
    segs = raw.slice("rc://".length).split("/").filter(Boolean);
    const ti = segs.indexOf("tw");
    if (ti === -1) return null;
    segs = segs.slice(ti + 1);
  } else {
    segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }
  segs = segs.map(stripMd).filter((s) => s && s !== "dict" && s !== "bible");
  if (segs.length !== 2) return null;
  const [cat, slug] = segs;
  if (!TW_CATEGORIES.has(cat) || !SLUG_RE.test(slug)) return null;
  return `${cat}/${slug}`;
}

function taArticleIdOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const raw = ref.trim();
  if (!raw) return null;
  let segs: string[];
  if (raw.startsWith("rc://")) {
    segs = raw.slice("rc://".length).split("/").filter(Boolean);
    const ti = segs.indexOf("ta");
    if (ti === -1) return null;
    segs = segs.slice(ti + 1);
    if (segs[0] === "man") segs = segs.slice(1);
  } else {
    segs = raw.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  }
  segs = segs.map(stripMd).filter(Boolean);
  let manual: string;
  let slug: string;
  if (segs.length === 1) {
    manual = "translate";
    slug = segs[0];
  } else if (segs.length === 2) {
    [manual, slug] = segs;
  } else {
    return null;
  }
  if (!TA_MANUALS.has(manual) || !SLUG_RE.test(slug)) return null;
  return `${manual}/${slug}`;
}

// ── article helpers (local copies of ArticlesScreen.tsx:64-84) ─────────────

// Any ai_draft wins, else any edited, else all-translated-parts-validated.
function aggregateState(states: ArticleState[]): ArticleState {
  if (states.some((s) => s === "ai_draft")) return "ai_draft";
  if (states.some((s) => s === "edited")) return "edited";
  const translated = states.filter((s) => s != null);
  if (translated.length > 0 && translated.every((s) => s === "validated")) return "validated";
  return null;
}

// Label copy for a resolved chip status, tw's wording. Precedence lives in
// resolveFlowChipStatus (#348); tw has no current/non-current split, no
// skipped/aquifer verdicts, and no "unsaved" vs "pending" label distinction —
// a dirty or saved-edited article both read "Edited". tw feeds `dirty` as the
// live-diff signal (isCurrent=true) so any dirty article resolves to "editing".
function wordsChipLabel(status: FlowChipStatus, t: TFunction): string {
  switch (status) {
    case "editing":
    case "unsaved":
    case "pending":
      return t("flowWords.chipEdited");
    case "approved":
      return t("flowWords.chipApproved");
    case "aiDraft":
      return t("flowWords.chipAiDraft");
    case "skipped":
    case "aquifer":
    case "draft":
      return t("flowWords.chipNotStarted");
  }
}

function chipFor(
  state: ArticleState,
  dirty: boolean,
  t: TFunction,
): { kind: FlowStatusKind; label: string } {
  const status = resolveFlowChipStatus({
    isCurrent: true,
    hasLiveDiff: dirty,
    draftPresent: false,
    approved: state === "validated",
    skipped: false,
    pending: state === "edited",
    aquifer: false,
    aiDrafted: state === "ai_draft",
  });
  return { kind: flowChipKind(status), label: wordsChipLabel(status, t) };
}

// tA parts order title → sub-title → body; tw is body-only.
const PART_ORDER: Record<string, number> = { title: 0, "sub-title": 1, body: 2 };
function orderParts(list: ArticleUnit[]): ArticleUnit[] {
  return [...list].sort((a, b) => (PART_ORDER[a.part] ?? 9) - (PART_ORDER[b.part] ?? 9));
}

// ── markdown block split (display-only pairing for the "Both" view) ────────
// Lossless: blocks are consecutive line ranges, a new block starts at each
// heading line; joining texts with "\n" reproduces the input exactly.
interface MdBlock {
  heading: string | null;
  text: string;
}
function splitMdBlocks(md: string): MdBlock[] {
  const lines = md.split("\n");
  const blocks: MdBlock[] = [];
  let cur: string[] = [];
  let heading: string | null = null;
  let started = false;
  for (const line of lines) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      if (started) blocks.push({ heading, text: cur.join("\n") });
      heading = h[1].trim();
      cur = [line];
      started = true;
    } else {
      cur.push(line);
      started = true;
    }
  }
  if (started) blocks.push({ heading, text: cur.join("\n") });
  return blocks;
}

function firstHeading(md: string | null | undefined): string | null {
  if (!md) return null;
  const m = /^#{1,6}\s+(.*)$/m.exec(md);
  return m ? m[1].trim() : null;
}

function groupUnits(units: ArticleUnitMeta[]): Map<string, ArticleUnitMeta[]> {
  const map = new Map<string, ArticleUnitMeta[]>();
  for (const u of units) {
    const arr = map.get(u.article_id);
    if (arr) arr.push(u);
    else map.set(u.article_id, [u]);
  }
  return map;
}

// One list entry: an article referenced by this book's rows.
interface BookItem {
  resource: Resource;
  id: string; // "kt/apostle" / "translate/figs-metaphor"
  slug: string;
  category: string;
  count: number;
  populated: boolean;
  paths: string[];
  state: ArticleState;
}

export default function TranslateWordsScreen({ role, book }: TranslateWordsScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const INSPIRE = "#31ADE3";
  const { skip } = theme.palette.flows;
  // md+ (>=900px, ArticlesScreen's breakpoint): master-detail side by side
  // instead of the phone's list ⇄ detail view swap.
  const wide = useMediaQuery(theme.breakpoints.up("md"));

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || t("flowWords.target");
  const sourceLangLabel = (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase();
  const direction: "ltr" | "rtl" = projectConfig?.direction === "rtl" ? "rtl" : "ltr";

  // Viewers can't write (server-side blockViewerWrites); disable with the
  // reason instead of letting a 403 land at click time.
  const canEdit = role === "admin" || role === "editor";

  // Article unit metadata (workspace-global; the book intersection below is
  // what scopes the list). Hook accepts null so the calls stay unconditional.
  const twHook = useArticles(translationMode ? "tw" : null);
  const taHook = useArticles(translationMode ? "ta" : null);

  // The book's chapters — the only source of per-book twl/tn rows today.
  const { summary, summaryStatus, chapters, loadChapter } = useBook(book, translationMode);

  // `chapters` mirrored into a ref so the worker loop below always sees the
  // latest load state without needing it as an effect dependency (that would
  // restart the whole queue on every chapter completion).
  const chaptersRef = useRef(chapters);
  chaptersRef.current = chapters;

  // Four workers drain the chapter queue instead of firing loadChapter for
  // every chapter at once — mirrors AdminProgressScreen.tsx's queue+worker
  // pattern (its BookSummary fan-out). loadChapter itself is fire-and-forget
  // (no promise), so each worker polls chaptersRef for its chapter to leave
  // "loading"/"unloaded" before pulling the next one off the queue.
  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    const queue = realChapterNumbers(summary);
    const waitForSettled = (ch: number) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (cancelled) {
            resolve();
            return;
          }
          const st = chaptersRef.current.get(ch);
          if (st && st.kind !== "loading" && st.kind !== "unloaded") {
            resolve();
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });
    const worker = async () => {
      for (;;) {
        const ch = queue.shift();
        if (ch === undefined || cancelled) return;
        loadChapter(ch);
        await waitForSettled(ch);
      }
    };
    for (let i = 0; i < Math.min(4, queue.length); i++) void worker();
    return () => {
      cancelled = true;
    };
  }, [summary, loadChapter]);

  // Must match the queue above (real chapters only) or scanning never ends.
  const chapterTotal = realChapterNumbers(summary).length;
  let chaptersReady = 0;
  let chaptersFailed = 0;
  for (const st of chapters.values()) {
    if (st.kind === "ready") chaptersReady++;
    else if (st.kind === "error") chaptersFailed++;
  }
  const scanning = chapterTotal > 0 && chaptersReady + chaptersFailed < chapterTotal;

  // Per-book reference counts, filled progressively as chapters land.
  const bookRefs = useMemo(() => {
    const tw = new Map<string, number>();
    const ta = new Map<string, number>();
    const bump = (m: Map<string, number>, id: string) => {
      m.set(id, (m.get(id) ?? 0) + 1);
    };
    for (const st of chapters.values()) {
      if (st.kind !== "ready") continue;
      for (const r of st.data.twl) {
        if (r.deleted_at != null) continue;
        const id = twArticleIdOf(r.tw_link);
        if (id) bump(tw, id);
      }
      for (const r of st.data.tn) {
        if (r.deleted_at != null || r.trashed_at != null) continue;
        const id = taArticleIdOf(r.support_reference);
        if (id) bump(ta, id);
      }
    }
    return { tw, ta };
  }, [chapters]);

  const twGroups = useMemo(() => groupUnits(twHook.units), [twHook.units]);
  const taGroups = useMemo(() => groupUnits(taHook.units), [taHook.units]);

  const buildItems = useCallback(
    (
      resource: Resource,
      refs: Map<string, number>,
      groups: Map<string, ArticleUnitMeta[]>,
    ): BookItem[] => {
      const items: BookItem[] = [];
      for (const [id, count] of refs) {
        const parts = groups.get(id);
        const [category, slug] = id.split("/");
        items.push({
          resource,
          id,
          slug: slug ?? id,
          category: category ?? "",
          count,
          populated: Boolean(parts && parts.length > 0),
          paths: (parts ?? []).map((p) => p.path),
          state: parts ? aggregateState(parts.map((p) => p.translation_state ?? null)) : null,
        });
      }
      // Frequency in the book, descending (Benjamin 2026-08-10, see header) —
      // populated-ness never reorders; ties fall back to id, alphabetically.
      items.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
      return items;
    },
    [],
  );
  const termItems = useMemo(
    () => buildItems("tw", bookRefs.tw, twGroups),
    [buildItems, bookRefs, twGroups],
  );
  const taItems = useMemo(
    () => buildItems("ta", bookRefs.ta, taGroups),
    [buildItems, bookRefs, taGroups],
  );

  // Tallies count only populated items — an article with no populated source
  // has nothing here to approve, so counting it would misreport progress.
  const populated = [...termItems, ...taItems].filter((i) => i.populated);
  const approvedCount = populated.filter((i) => i.state === "validated").length;
  const unpopulatedCount = termItems.length + taItems.length - populated.length;

  // ── selection (list ⇄ detail, internal state like the artifact) ──────────
  const [selected, setSelected] = useState<{ resource: Resource; id: string } | null>(null);
  // Collapsible group state — session-local by design (2026-08-10, header).
  const [openGroups, setOpenGroups] = useState<Record<GroupKey, boolean>>({
    kt: true,
    names: false,
    other: false,
    ta: true,
  });
  const selectedItem = selected
    ? [...termItems, ...taItems].find((i) => i.resource === selected.resource && i.id === selected.id) ?? null
    : null;

  // After an approve, advance to the next populated entry in list order (tW
  // terms then tA articles), mirroring the notes flow's auto-advance. On the
  // last entry there's nothing after it, so fall back to clearing selection
  // (returns to the list / empty pane) — the pre-existing end-of-queue state.
  const goToNextEntry = useCallback(() => {
    if (!selected) return;
    const ordered = [...termItems, ...taItems].filter((i) => i.populated);
    const idx = ordered.findIndex((i) => i.resource === selected.resource && i.id === selected.id);
    const next = idx >= 0 ? ordered[idx + 1] : undefined;
    setSelected(next ? { resource: next.resource, id: next.id } : null);
  }, [selected, termItems, taItems]);

  const [toast, setToast] = useState<string | null>(null);
  const say = useCallback((msg: string) => setToast(msg), []);

  // Unsaved-typing dots on list rows (same wiring as ArticlesScreen:139-149).
  const [draftList, setDraftList] = useState<DraftRecord[]>([]);
  useEffect(() => draftStore.subscribe(setDraftList), []);
  const dirtyArticleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of draftList) {
      if (d.quarantined) continue;
      if (d.meta.kind !== "article") continue;
      ids.add(`${d.meta.resource}/${d.meta.articleId}`);
    }
    return ids;
  }, [draftList]);

  const refetchMetas = useCallback(() => {
    twHook.refetch();
    taHook.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twHook.refetch, taHook.refetch]);

  // ── render gates (every hook above this line, unconditionally) ───────────
  const sub = t("flowWords.subLine", { book, source: sourceLangLabel, target: targetLabel });

  // One phrasing per resource, shared by the list rows and both detail
  // variants: "N occurrences in BOOK" (tw) / "linked from N notes in BOOK" (ta).
  const countLabelOf = (item: { resource: Resource; count: number }) =>
    item.resource === "tw"
      ? t("flowWords.occurrencesIn", { count: item.count, book })
      : t("flowWords.linkedFrom", { count: item.count, book });

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
      : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
    paddingBlock: 1.75,
    paddingInline: 2,
    textAlign: "start" as const,
  };

  if (projectConfig === null) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!translationMode) {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="info">{t("flowWords.notTranslationMode")}</Alert>
      </Box>
    );
  }

  if (summaryStatus === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="error">{t("flowWords.loadError", { book })}</Alert>
      </Box>
    );
  }

  // ── detail (phone: a swapped full view; at md+ it renders in the pane) ────
  if (!wide && selected && selectedItem && selectedItem.populated) {
    return (
      <>
        <ArticleDetail
          key={`${selected.resource}/${selected.id}`}
          variant="page"
          resource={selected.resource}
          articleId={selected.id}
          paths={selectedItem.paths}
          countLabel={countLabelOf(selectedItem)}
          canEdit={canEdit}
          sourceLangLabel={sourceLangLabel}
          targetLabel={targetLabel}
          direction={direction}
          onBack={() => setSelected(null)}
          onApproved={goToNextEntry}
          onServerChange={refetchMetas}
          onToast={say}
        />
        <Snackbar
          open={toast !== null}
          message={toast ?? ""}
          autoHideDuration={1400}
          onClose={() => setToast(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
          sx={{ bottom: 96 }}
        />
      </>
    );
  }

  // ── list ──────────────────────────────────────────────────────────────────
  const sectionHead = (label: string, items: BookItem[]) => {
    const pop = items.filter((i) => i.populated);
    const okCount = pop.filter((i) => i.state === "validated").length;
    return (
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mt: 1.25, mx: 0.25 }}>
        <Typography
          component="h2"
          sx={{
            fontSize: "0.75rem",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "text.secondary",
            m: 0,
          }}
        >
          {label}
        </Typography>
        <Typography
          variant="caption"
          sx={{ ml: "auto !important", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
        >
          {pop.length > 0
            ? t("flowWords.approvedOf", { n: okCount, total: pop.length })
            : t("flowWords.noneHere")}
        </Typography>
      </Stack>
    );
  };

  // Collapsible group header — the word categories and the Academy articles
  // section share this pattern (2026-08-10 restructure, see file header).
  // The collapsed chevron points toward inline-end, so it flips under RTL.
  const collapsedChevron = theme.direction === "rtl" ? "rotate(90deg)" : "rotate(-90deg)";
  const collapsibleHead = (key: GroupKey, label: string, items: BookItem[]) => {
    const open = openGroups[key];
    const pop = items.filter((i) => i.populated);
    const okCount = pop.filter((i) => i.state === "validated").length;
    return (
      <Box
        component="button"
        type="button"
        aria-expanded={open}
        onClick={() => setOpenGroups((g) => ({ ...g, [key]: !g[key] }))}
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          border: "none",
          background: "transparent",
          font: "inherit",
          color: "inherit",
          cursor: "pointer",
          width: "100%",
          textAlign: "start",
          borderRadius: "8px",
          paddingBlock: 0.75,
          paddingInline: 0.25,
          mt: key === "ta" ? 1.5 : 0,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <ExpandMoreIcon
          fontSize="small"
          sx={{
            color: "text.secondary",
            flex: "none",
            transform: open ? "none" : collapsedChevron,
            transition: "transform 0.15s ease",
          }}
        />
        <Typography
          component={key === "ta" ? "h2" : "h3"}
          sx={{
            fontSize: "0.75rem",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "text.secondary",
            m: 0,
          }}
        >
          {label}
        </Typography>
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
        >
          · {items.length}
        </Typography>
        <Typography
          variant="caption"
          sx={{ ml: "auto", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
        >
          {pop.length > 0
            ? t("flowWords.approvedOf", { n: okCount, total: pop.length })
            : t("flowWords.noneHere")}
        </Typography>
      </Box>
    );
  };

  const groupRows = (key: GroupKey, items: BookItem[], emptyText: string) => {
    if (!openGroups[key]) return null;
    if (items.length === 0 && !scanning) {
      return (
        <Typography variant="body2" color="text.secondary" sx={{ mx: 0.25 }}>
          {emptyText}
        </Typography>
      );
    }
    return items.map(listRow);
  };

  const listRow = (item: BookItem) => {
    const chip = chipFor(item.state, dirtyArticleIds.has(`${item.resource}/${item.id}`), t);
    const countText = countLabelOf(item);
    if (!item.populated) {
      return (
        <Box key={`${item.resource}/${item.id}`} sx={{ ...cardSx, opacity: 0.72, paddingBlock: 1.25 }}>
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>{item.slug}</Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {item.category} · {countText} · {t("flowWords.notPopulated")}
          </Typography>
        </Box>
      );
    }
    const isSelected =
      wide && selected?.resource === item.resource && selected?.id === item.id;
    return (
      <Box
        key={`${item.resource}/${item.id}`}
        component="button"
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => setSelected({ resource: item.resource, id: item.id })}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          width: "100%",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          paddingBlock: 1.25,
          ...(isSelected
            ? { borderColor: INSPIRE, bgcolor: alpha(INSPIRE, dark ? 0.12 : 0.06) }
            : {}),
          "&:hover": { borderColor: INSPIRE },
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>{item.slug}</Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {item.category} · {countText}
          </Typography>
        </Box>
        {dirtyArticleIds.has(`${item.resource}/${item.id}`) && (
          <Box
            aria-label={t("flowWords.unsavedDraft")}
            sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: "#E59D33", flex: "none" }}
          />
        )}
        <FlowStatusChip kind={chip.kind} label={chip.label} />
        <ChevronRightIcon fontSize="small" sx={{ color: "text.secondary", flex: "none" }} />
      </Box>
    );
  };

  const nothingYet =
    !scanning && termItems.length === 0 && taItems.length === 0 && summaryStatus === "ready";

  // Words split by tw category (kt / names / other — the whitelist above);
  // Academy articles are the other top-level part.
  const ktItems = termItems.filter((i) => i.category === "kt");
  const namesItems = termItems.filter((i) => i.category === "names");
  const otherItems = termItems.filter((i) => i.category === "other");

  // The list content is identical at every width — only its container differs
  // (phone: the centred column; md+: the scrollable list pane).
  const listBody = (
    <>
      {(twHook.error || taHook.error) && (
        <Alert severity="warning">
          {t("flowWords.listLoadFailed", {
            details: `${twHook.error ? ` (tW: ${twHook.error.message})` : ""}${
              taHook.error ? ` (tA: ${taHook.error.message})` : ""
            }`,
          })}
        </Alert>
      )}

      {scanning && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0, mt: 0.5 }}>
          {t("flowWords.scanning", { book, ready: chaptersReady, total: chapterTotal })}
        </Typography>
      )}
      {chaptersFailed > 0 && (
        <Alert severity="warning">
          {t("flowWords.chaptersFailed", { count: chaptersFailed, book })}
        </Alert>
      )}

      {nothingYet ? (
        <Alert severity="info">{t("flowWords.nothingFound", { book })}</Alert>
      ) : (
        <>
          {sectionHead(t("flowWords.sectionWords"), termItems)}
          {collapsibleHead("kt", t("flowWords.groupKeyTerms"), ktItems)}
          {groupRows("kt", ktItems, t("flowWords.emptyKeyTerms", { book }))}
          {collapsibleHead("names", t("flowWords.groupNames"), namesItems)}
          {groupRows("names", namesItems, t("flowWords.emptyNames", { book }))}
          {collapsibleHead("other", t("flowWords.groupOther"), otherItems)}
          {groupRows("other", otherItems, t("flowWords.emptyOther", { book }))}

          {collapsibleHead("ta", t("flowWords.sectionAcademy"), taItems)}
          {groupRows("ta", taItems, t("flowWords.emptyAcademy", { book }))}

          {unpopulatedCount > 0 && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mx: 0.25 }}>
              {t("flowWords.unpopulatedNote", { count: unpopulatedCount, book })}
            </Typography>
          )}
        </>
      )}
    </>
  );

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        textAlign: "start",
        ...(wide
          ? { display: "flex", flexDirection: "column", overflow: "hidden" }
          : { overflowY: "auto" }),
      }}
    >
      {/* topbar — rendered into the global flow bar via FlowHeader (#299) */}
      <FlowHeader>
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1.25}>
            <IconButton
              aria-label={t("flowWords.backToPackage", { book })}
              onClick={() => {
                location.hash = `#/package/${book}`;
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={{ minWidth: 0 }}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                {t("flowWords.title")}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {sub}
              </Typography>
            </Box>
            <Box sx={{ flex: 1 }} />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                color: "text.secondary",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
              }}
            >
              {t("flowWords.approvedOf", { n: approvedCount, total: populated.length })}
            </Typography>
          </Stack>
          <Box sx={{ height: 4, borderRadius: "2px", bgcolor: skip.soft, mt: 1.25, overflow: "hidden" }}>
            <Box
              sx={{
                height: "100%",
                borderRadius: "2px",
                bgcolor: INSPIRE,
                transition: "width 0.35s ease",
                width: populated.length === 0 ? "0%" : `${(approvedCount / populated.length) * 100}%`,
              }}
            />
          </Box>
        </Box>
      </FlowHeader>

      {wide ? (
        /* desk (docs/mockups/desktop-first/_design.css .desk/.rail/.panel):
           1440px centred grid — rail-like list pane on the inline-start side,
           panel-chromed detail pane filling the rest. Grid column order
           follows the document direction, so this is RTL-safe as-is. */
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            width: "100%",
            maxWidth: 1440,
            mx: "auto",
            display: "grid",
            gridTemplateColumns: "minmax(340px, 380px) minmax(0, 1fr)",
            gap: 2.5,
            paddingInline: 2,
            paddingBlockStart: 1.5,
            paddingBlockEnd: 2,
          }}
        >
          {/* list pane */}
          <Box
            sx={{
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 1.25,
              paddingInline: 0.25,
              paddingBlockEnd: 2,
            }}
          >
            {listBody}
          </Box>
          {/* detail pane */}
          <Box
            sx={{
              minHeight: 0,
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              borderRadius: "14px",
              overflow: "hidden",
            }}
          >
            {selected && selectedItem && selectedItem.populated ? (
              <ArticleDetail
                key={`${selected.resource}/${selected.id}`}
                variant="pane"
                resource={selected.resource}
                articleId={selected.id}
                paths={selectedItem.paths}
                countLabel={countLabelOf(selectedItem)}
                canEdit={canEdit}
                sourceLangLabel={sourceLangLabel}
                targetLabel={targetLabel}
                direction={direction}
                onBack={() => setSelected(null)}
                onApproved={goToNextEntry}
                onServerChange={refetchMetas}
                onToast={say}
              />
            ) : (
              <Stack alignItems="center" justifyContent="center" sx={{ height: "100%", p: 4 }}>
                <Typography variant="body2" color="text.secondary" textAlign="center">
                  {t("flowWords.selectPrompt")}
                </Typography>
              </Stack>
            )}
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            maxWidth: COLUMN_PX,
            mx: "auto",
            paddingInline: 2,
            paddingBlockStart: 1,
            paddingBlockEnd: 4,
            display: "flex",
            flexDirection: "column",
            gap: 1.25,
          }}
        >
          {listBody}
        </Box>
      )}

      <Snackbar
        open={toast !== null}
        message={toast ?? ""}
        autoHideDuration={1400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: 24 }}
      />
    </Box>
  );
}

// ── detail view ─────────────────────────────────────────────────────────────

interface ArticleDetailProps {
  resource: Resource;
  articleId: string;
  paths: string[];
  countLabel: string;
  canEdit: boolean;
  sourceLangLabel: string;
  targetLabel: string;
  direction: "ltr" | "rtl";
  /** "page": the phone's swapped full view (back chevron, viewport-fixed
   * action bar). "pane": the md+ master-detail panel (no back chevron —
   * selection lives in the list pane — and the action bar sticks to the
   * pane's bottom instead of the viewport). */
  variant: "page" | "pane";
  onBack: () => void;
  /** Called after a successful Approve. The parent advances selection to the
   * next entry (matching the notes flow), instead of clearing it back to the
   * empty "select a word or article" state. */
  onApproved: () => void;
  onServerChange: () => void;
  onToast: (msg: string) => void;
}

function ArticleDetail({
  resource,
  articleId,
  paths,
  countLabel,
  canEdit,
  sourceLangLabel,
  targetLabel,
  direction,
  variant,
  onBack,
  onApproved,
  onServerChange,
  onToast,
}: ArticleDetailProps) {
  const { t } = useTranslation();
  const pane = variant === "pane";
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  const { ok, skip } = theme.palette.flows;

  const cardSx = {
    bgcolor: "background.paper",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: "14px",
    boxShadow: dark
      ? "0 1px 2px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.35)"
      : "0 1px 2px rgba(1,66,99,0.05), 0 6px 20px rgba(1,66,99,0.08)",
    paddingBlock: 1.75,
    paddingInline: 2,
    textAlign: "start" as const,
  };

  const pathsKey = useMemo(() => [...paths].sort().join("|"), [paths]);

  const [parts, setParts] = useState<ArticleUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftsByPath, setDraftsByPath] = useState<Record<string, string>>({});
  const [editingPath, setEditingPath] = useState<string | null>(null);
  // Ref-based focus (not autoFocus) so entering editing doesn't yank the page
  // to wherever the browser's default scroll-into-view lands — we focus
  // without scrolling, then scroll the editor container into view ourselves.
  // In the pane (md+) layout we only reveal it if off-screen, matching the
  // old autoFocus behavior; on phone we center it, then re-center once more
  // when the on-screen keyboard finishes opening (visualViewport 'resize'),
  // since that resize can happen after our first scroll.
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (editingPath === null) return;
    const el = editorContainerRef.current;
    if (!el) return;
    const input = el.querySelector("textarea, input") as HTMLElement | null;
    input?.focus({ preventScroll: true });
    const raf = requestAnimationFrame(() => {
      el.scrollIntoView({ block: pane ? "nearest" : "center" });
    });
    let vv: VisualViewport | undefined;
    let onResize: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (!pane) {
      vv = window.visualViewport ?? undefined;
      if (vv) {
        onResize = () => {
          el.scrollIntoView({ block: "center" });
          vv?.removeEventListener("resize", onResize!);
        };
        vv.addEventListener("resize", onResize);
        timeout = setTimeout(() => {
          vv?.removeEventListener("resize", onResize!);
        }, 1500);
      }
    }
    return () => {
      cancelAnimationFrame(raf);
      if (vv && onResize) vv.removeEventListener("resize", onResize);
      if (timeout) clearTimeout(timeout);
    };
  }, [editingPath, pane]);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [redoing, setRedoing] = useState(false);
  const [staleDraft, setStaleDraft] = useState(false);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(null);
  // Sticky once the server says the AI proxy isn't configured — the first 503
  // is how we learn (no capability flag exists up front).
  const [aiUnavailable, setAiUnavailable] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>(sessionLang);

  const setLangRemembered = (l: Lang) => {
    sessionLang = l;
    setLang(l);
  };

  // Load full units, then let a persisted draft (unsaved typing from this
  // browser) win over the server's target — mirrors ArticlesScreen:513-560.
  useEffect(() => {
    let cancelled = false;
    setParts(null);
    setLoadError(null);
    setStaleDraft(false);
    setEditingPath(null);
    Promise.all(paths.map((p) => api.getArticle(resource, p)))
      .then(async (list) => {
        if (cancelled) return;
        const ordered = orderParts(list);
        const seeded = Object.fromEntries(ordered.map((u) => [u.path, u.target_md ?? ""]));
        let stale = false;
        const stored = await Promise.all(
          ordered.map((u) =>
            draftStore
              .get(articleKey(resource, u.path))
              .then((rec) => ({ unit: u, rec }))
              .catch(() => ({ unit: u, rec: undefined })),
          ),
        );
        if (cancelled) return;
        for (const { unit, rec } of stored) {
          const text = (rec?.payload as { target_md?: string } | undefined)?.target_md;
          if (typeof text !== "string") continue;
          if (text === (unit.target_md ?? "")) {
            void draftStore.clear(articleKey(resource, unit.path));
            continue;
          }
          if (rec && rec.expectedVersion !== unit.version) stale = true;
          seeded[unit.path] = text;
        }
        setParts(ordered);
        setDraftsByPath(seeded);
        if (stale) setStaleDraft(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, articleId, pathsKey, reloadKey]);

  // Stash every keystroke; nothing leaves the browser here. Cleared when the
  // text matches the server copy again (drafts.ts's outbox listener does not
  // cover article keys — this screen owns the clear).
  const persistDraft = useCallback(
    (part: ArticleUnit, text: string) => {
      const key = articleKey(resource, part.path);
      if (text === (part.target_md ?? "")) {
        void draftStore.clear(key);
        return;
      }
      void draftStore.set(key, { target_md: text }, part.version, {
        kind: "article",
        resource,
        articleId: part.article_id,
        path: part.path,
        part: part.part,
      });
    },
    [resource],
  );

  const isDirtyPart = useCallback(
    (part: ArticleUnit) => (draftsByPath[part.path] ?? "") !== (part.target_md ?? ""),
    [draftsByPath],
  );
  const anyDirty = useMemo(() => (parts ?? []).some(isDirtyPart), [parts, isDirtyPart]);
  useUnsavedGuard(anyDirty);

  const applyServerUnit = useCallback(
    (u: ArticleUnit) => {
      setParts((prev) => (prev ? prev.map((p) => (p.path === u.path ? u : p)) : prev));
      setDraftsByPath((prev) => ({ ...prev, [u.path]: u.target_md ?? "" }));
      void draftStore.clear(articleKey(resource, u.path));
    },
    [resource],
  );

  // The async Redo lands through the pipeline store, not a response body.
  // Fires for any translate job this user is polling — accepted looseness,
  // same as ArticlesScreen:562-573.
  useEffect(
    () =>
      pipelineStore.onComplete((job) => {
        if (job.pipeline_type !== "translate") return;
        setRedoing(false);
        if (job.state === "done") {
          setReloadKey((k) => k + 1);
          onServerChange();
          onToast(t("flowWords.toastNewDraft"));
        } else {
          setNotice({
            text: t("flowWords.redoFailed", { error: job.error_message ?? job.state }),
            severity: "warning",
          });
        }
      }),
    [onServerChange, onToast, t],
  );

  // ── writes ────────────────────────────────────────────────────────────────
  // PATCH every dirty part; on 409 adopt the server's fresh version (keeping
  // the user's text on screen) so the next Save goes through — the same rebase
  // ArticlesScreen:637-651 does. Returns the fresh parts, or null on failure.
  async function saveDirtyParts(): Promise<ArticleUnit[] | null> {
    if (!parts) return null;
    const dirty = parts.filter(isDirtyPart);
    if (dirty.length === 0) return parts;
    const results = await Promise.allSettled(
      dirty.map((part) => api.patchArticle(resource, part.path, part.version, draftsByPath[part.path] ?? "")),
    );
    let failed = false;
    const freshByPath = new Map<string, ArticleUnit>();
    results.forEach((r, i) => {
      const part = dirty[i];
      if (r.status === "fulfilled") {
        applyServerUnit(r.value);
        freshByPath.set(r.value.path, r.value);
        return;
      }
      failed = true;
      if (r.reason instanceof ApiError && r.reason.status === 409) {
        const fresh = (r.reason.body as { current?: ArticleUnit } | undefined)?.current;
        if (fresh) {
          setParts((prev) => (prev ? prev.map((p) => (p.path === fresh.path ? fresh : p)) : prev));
          persistDraft(fresh, draftsByPath[part.path] ?? "");
        }
        setNotice({
          text: t("flowWords.saveConflict"),
          severity: "warning",
        });
      } else {
        setNotice({
          text: t("flowWords.saveFailed", {
            error: r.reason instanceof ApiError ? r.reason.status : "error",
          }),
          severity: "warning",
        });
      }
    });
    onServerChange();
    return failed ? null : parts.map((p) => freshByPath.get(p.path) ?? p);
  }

  async function handleSave() {
    if (busy || redoing || !anyDirty) return;
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await saveDirtyParts();
      if (fresh) onToast(t("flowWords.toastSaved"));
    } finally {
      setBusy(false);
    }
  }

  // Save-then-validate, awaited in that order: /unit/validate carries no
  // version, so a PATCH landing after it would demote the part straight back
  // to 'edited' server-side (api/src/articles.ts:101-109).
  async function handleApprove() {
    if (busy || redoing || !parts) return;
    setBusy(true);
    setNotice(null);
    try {
      const fresh = await saveDirtyParts();
      if (!fresh) return;
      const targets = fresh.filter((p) => (p.translation_state ?? null) !== null);
      if (targets.length === 0) {
        setNotice({
          text: t("flowWords.nothingToApprove"),
          severity: "info",
        });
        return;
      }
      const results = await Promise.allSettled(
        targets.map((part) => api.validateArticle(resource, part.path, true)),
      );
      let anyFail = false;
      for (const r of results) {
        if (r.status === "fulfilled") applyServerUnit(r.value);
        else {
          anyFail = true;
          setNotice({
            text: t("flowWords.approveFailed", {
              error: r.reason instanceof ApiError ? r.reason.status : "error",
            }),
            severity: "warning",
          });
        }
      }
      onServerChange();
      if (!anyFail) {
        onToast(t("flowWords.toastApproved"));
        onApproved();
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRedo() {
    if (busy || redoing || editingPath !== null) return;
    setRedoing(true);
    setNotice(null);
    try {
      await pipelineStore.start({
        pipelineType: "translate",
        sessionKey: getSessionKey(),
        translate: { resourceType: resource, articleId },
      });
      setNotice({
        text: t("flowWords.redoStarted"),
        severity: "info",
      });
    } catch (e) {
      setRedoing(false);
      const body = (e as { body?: { error?: string } } | null)?.body;
      const code = body?.error ?? "";
      // 503 pipeline_api_disabled = BT_API_TOKEN unset (api/src/pipelines.ts:995).
      if ((e instanceof ApiError && e.status === 503) || code === "pipeline_api_disabled") {
        setAiUnavailable(t("flowWords.aiUnavailable"));
      } else {
        setNotice({
          text: t("flowWords.redoStartFailed", {
            error: code || (e instanceof ApiError ? e.status : "error"),
          }),
          severity: "warning",
        });
      }
    }
  }

  // ── derived display ───────────────────────────────────────────────────────
  const bodyPart = (parts ?? []).find((p) => p.part === "body") ?? null;
  const titlePart = (parts ?? []).find((p) => p.part === "title") ?? null;
  const sourceTitle =
    resource === "ta"
      ? (titlePart?.source_md ?? "").trim() || articleId
      : firstHeading(bodyPart?.source_md) ?? articleId.split("/")[1] ?? articleId;
  const targetTitle =
    resource === "ta"
      ? ((titlePart ? draftsByPath[titlePart.path] : "") ?? "").trim()
      : firstHeading(bodyPart ? draftsByPath[bodyPart.path] : null) ?? "";

  const aggregate = aggregateState((parts ?? []).map((p) => p.translation_state ?? null));
  const chip = chipFor(aggregate, anyDirty, t);
  const nothingToApprove =
    parts !== null && !anyDirty && parts.every((p) => (p.translation_state ?? null) === null);

  const approveBlockedReason = !canEdit
    ? t("flowWords.viewOnlyProject")
    : editingPath !== null
      ? t("flowWords.finishEditing")
      : nothingToApprove
        ? t("flowWords.nothingToApprove")
        : null;
  const redoBlockedReason = aiUnavailable
    ? aiUnavailable
    : !canEdit
      ? t("flowWords.viewOnlyProject")
      : editingPath !== null
        ? t("flowWords.finishEditing")
        : null;

  const partHeading = (part: ArticleUnit): string =>
    part.part === "title"
      ? t("flowWords.partTitle")
      : part.part === "sub-title"
        ? t("flowWords.partSubtitle")
        : t("flowWords.partArticle");

  const langTagSx = {
    display: "block",
    fontSize: "0.656rem",
    fontWeight: 700,
    letterSpacing: "0.09em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    m: 0,
    mb: 0.5,
  };
  const colHeadSx = { ...langTagSx, mb: 0.375 };
  // Source is the first grid column, target the second (see bothView's JSX)
  // — shrink source to 1fr / target to 1.6fr so target dominates, and drop
  // the source column's font a step further than the target's.
  const pairSx = {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.6fr)",
    gap: 1.25,
    fontSize: "0.84rem",
  };
  const srcColSx = { fontSize: "0.78rem" };

  function segButton(value: Lang, label: string) {
    const active = lang === value;
    return (
      <Button
        key={value}
        onClick={() => {
          if (lang !== value) {
            setEditingPath(null);
            setLangRemembered(value);
          }
        }}
        aria-pressed={active}
        sx={{
          flex: 1,
          minHeight: 38,
          borderRadius: "8px",
          fontWeight: 600,
          fontSize: "0.84rem",
          textTransform: "none",
          color: active ? "text.primary" : "text.secondary",
          bgcolor: active ? "background.paper" : "transparent",
          boxShadow: active ? "0 1px 3px rgba(1,66,99,0.15)" : "none",
          "&:hover": { bgcolor: active ? "background.paper" : "transparent" },
        }}
      >
        {label}
      </Button>
    );
  }

  // Tap-to-edit region for one part's target. Anchor links inside rendered
  // markdown keep working (a click on <a> must not open the editor).
  function targetView(part: ArticleUnit, small: boolean) {
    const text = draftsByPath[part.path] ?? "";
    const open = () => {
      if (!canEdit) return;
      setEditingPath(part.path);
    };
    return (
      <Box
        role={canEdit ? "button" : undefined}
        tabIndex={canEdit ? 0 : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) return;
          open();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        sx={{
          cursor: canEdit ? "text" : "default",
          borderRadius: "6px",
          paddingBlock: 0.25,
          paddingInline: 0.5,
          marginBlock: -0.25,
          marginInline: -0.5,
          fontSize: small ? "0.84rem" : undefined,
          ...(canEdit ? { "&:hover": { background: HL } } : {}),
        }}
      >
        {text.trim().length > 0 ? (
          <MarkdownView markdown={text} dir={direction} />
        ) : (
          <Box component="em" sx={{ color: "text.secondary" }}>
            {canEdit
              ? t("flowWords.nothingDraftedTap", { target: targetLabel })
              : t("flowWords.nothingDrafted")}
          </Box>
        )}
      </Box>
    );
  }

  function partEditor(part: ArticleUnit) {
    const text = draftsByPath[part.path] ?? "";
    return (
      <Box ref={editorContainerRef}>
        <TextField
          multiline
          fullWidth
          minRows={part.part === "body" ? 10 : 1}
          value={text}
          onChange={(e) => {
            setDraftsByPath((prev) => ({ ...prev, [part.path]: e.target.value }));
            persistDraft(part, e.target.value);
          }}
          inputProps={{ dir: direction }}
          sx={{
            "& .MuiOutlinedInput-root": {
              bgcolor: "action.hover",
              borderRadius: "9px",
              fontSize: "0.97rem",
              lineHeight: 1.55,
            },
            "& .MuiOutlinedInput-notchedOutline": {
              borderWidth: "1.5px",
              borderColor: INSPIRE,
            },
          }}
        />
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
          <Button
            onClick={() => {
              setEditingPath(null);
              if (isDirtyPart(part)) onToast(t("flowWords.toastDraftUpdated"));
            }}
            sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
          >
            {t("flowWords.done")}
          </Button>
        </Stack>
      </Box>
    );
  }

  // "Both": paired source/target blocks, columns side-by-side at every width
  // (the artifact overrides its own .pair collapse for this screen). Falls
  // back to two whole columns when the section counts don't line up.
  function bothView(part: ArticleUnit) {
    const src = part.source_md ?? "";
    const tgt = draftsByPath[part.path] ?? "";
    const srcBlocks = splitMdBlocks(src);
    const tgtBlocks = splitMdBlocks(tgt);
    const paired = tgt.trim().length > 0 && srcBlocks.length === tgtBlocks.length && srcBlocks.length > 0;
    if (!paired) {
      return (
        <>
          <Box sx={pairSx}>
            <Box sx={srcColSx}>
              <Typography component="p" sx={colHeadSx}>
                {sourceLangLabel}
              </Typography>
              <MarkdownView markdown={src} dir="ltr" />
            </Box>
            <Box>
              <Typography component="p" sx={colHeadSx}>
                {targetLabel}
              </Typography>
              {targetView(part, true)}
            </Box>
          </Box>
          {tgt.trim().length > 0 && (
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {t("flowWords.sectionCountMismatch")}
            </Typography>
          )}
        </>
      );
    }
    return (
      <>
        {srcBlocks.map((b, i) => (
          <Box
            key={`${part.path}#${i}`}
            sx={{
              ...(i > 0
                ? { mt: 1.5, pt: 1.5, borderBlockStart: "1px solid", borderColor: "divider" }
                : {}),
            }}
          >
            <Box sx={pairSx}>
              <Box sx={srcColSx}>
                <Typography component="p" sx={colHeadSx}>
                  {sourceLangLabel}
                </Typography>
                <MarkdownView markdown={b.text} dir="ltr" />
              </Box>
              <Box
                role={canEdit ? "button" : undefined}
                tabIndex={canEdit ? 0 : undefined}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a")) return;
                  if (canEdit) setEditingPath(part.path);
                }}
                onKeyDown={(e) => {
                  if (canEdit && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setEditingPath(part.path);
                  }
                }}
                sx={{
                  cursor: canEdit ? "text" : "default",
                  borderRadius: "6px",
                  ...(canEdit ? { "&:hover": { background: HL } } : {}),
                }}
              >
                <Typography component="p" sx={colHeadSx}>
                  {targetLabel}
                </Typography>
                <MarkdownView markdown={tgtBlocks[i].text} dir={direction} />
              </Box>
            </Box>
          </Box>
        ))}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
          {resource === "ta"
            ? t("flowWords.pairedNotePart", { target: targetLabel })
            : t("flowWords.pairedNoteArticle", { target: targetLabel })}
        </Typography>
      </>
    );
  }

  // Phone focus mode: editing on a phone (variant="page") hides the topbar,
  // the viewport-fixed action bar, the language segmented control, and the
  // "tap to edit" hint, so the small viewport is spent on the editor instead
  // of chrome around it. Wide/pane stays byte-identical — this only ever
  // applies when !pane.
  const focusMode = editingPath !== null && !pane;

  // ── render ────────────────────────────────────────────────────────────────
  // Pane mode: a flex column so the action bar's margin-block-start:auto pins
  // it to the pane's bottom even when the content is short; sticky keeps it
  // visible when the content scrolls.
  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        overflowY: "auto",
        textAlign: "start",
        ...(pane ? { display: "flex", flexDirection: "column" } : {}),
      }}
    >
      {/* topbar (pane: the panel-top chrome — title, no back chevron) */}
      {!focusMode && (
        <FlowHeader inline={pane} zIndex={10}>
          <Box
            sx={{
              maxWidth: pane ? "none" : COLUMN_PX,
              mx: "auto",
              paddingInline: pane ? 2.5 : 2,
              paddingBlock: 1.5,
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1.25}>
              {!pane && (
                <IconButton
                  aria-label={t("flowWords.backToList")}
                  onClick={onBack}
                  sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
                >
                  <ChevronLeftIcon fontSize="small" />
                </IconButton>
              )}
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  component={pane ? "h2" : "h1"}
                  sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}
                  noWrap
                >
                  {sourceTitle}
                </Typography>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
                  <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }} noWrap>
                    {targetTitle || countLabel}
                  </Typography>
                  <FlowStatusChip kind={chip.kind} label={chip.label} />
                </Stack>
              </Box>
            </Stack>
          </Box>
        </FlowHeader>
      )}

      <Box
        sx={{
          width: "100%",
          maxWidth: pane ? "none" : COLUMN_PX,
          mx: "auto",
          flex: "none",
          paddingInline: pane ? 2.5 : 2,
          paddingBlockStart: 2,
          // page: room for the viewport-fixed action bar; pane: the bar is
          // in-flow below, so only a small gap is needed. Focus mode hides
          // that fixed bar, so it only needs the small gap too.
          paddingBlockEnd: pane || focusMode ? 2 : 15,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}
        {staleDraft && (
          <Alert severity="warning" onClose={() => setStaleDraft(false)}>
            {t("flowWords.staleDraft")}
          </Alert>
        )}
        {!canEdit && <Alert severity="info">{t("flowWords.viewOnlyArticle")}</Alert>}

        {loadError ? (
          <Alert severity="error">{t("flowWords.articleLoadError", { error: loadError })}</Alert>
        ) : parts === null ? (
          <Stack alignItems="center" sx={{ p: 4 }}>
            <CircularProgress />
          </Stack>
        ) : (
          <>
            {/* language segment (artifact .seg) */}
            {!focusMode && (
              <Stack
                direction="row"
                spacing={0.5}
                role="group"
                aria-label={t("flowWords.langAria")}
                sx={{ bgcolor: skip.soft, borderRadius: "10px", p: 0.5 }}
              >
                {segButton("target", t("flowWords.segTarget", { label: targetLabel }))}
                {segButton("source", t("flowWords.segSource", { label: sourceLangLabel }))}
                {segButton("both", t("flowWords.segBoth"))}
              </Stack>
            )}

            <Box sx={cardSx}>
              {/* draft row: chip + honest AI/save affordances */}
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                {lang === "source" ? (
                  <FlowStatusChip kind="skip" label={t("flowWords.chipSourceReadOnly")} />
                ) : (
                  <FlowStatusChip kind={chip.kind} label={chip.label} />
                )}
                <Box sx={{ flex: 1 }} />
                {lang !== "source" && anyDirty && (
                  <Button
                    size="small"
                    startIcon={<SaveIcon sx={{ fontSize: "16px !important" }} />}
                    disabled={busy || redoing || !canEdit}
                    onClick={() => void handleSave()}
                    sx={{ minHeight: 36, color: ACCENT, fontWeight: 700 }}
                  >
                    {t("common.save")}
                  </Button>
                )}
              </Stack>

              {parts.map((p, i) => (
                <Box key={p.path} sx={i > 0 ? { mt: 2 } : undefined}>
                  {parts.length > 1 && (
                    <Typography
                      component="p"
                      sx={{
                        fontSize: "0.6875rem",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                        m: 0,
                        mb: 0.75,
                      }}
                    >
                      {partHeading(p)}
                    </Typography>
                  )}
                  {editingPath === p.path ? (
                    focusMode && lang === "both" ? (
                      <Box sx={pairSx}>
                        <Box sx={srcColSx}>
                          <Typography component="p" sx={colHeadSx}>
                            {sourceLangLabel}
                          </Typography>
                          <MarkdownView markdown={p.source_md ?? ""} dir="ltr" />
                        </Box>
                        <Box>{partEditor(p)}</Box>
                      </Box>
                    ) : (
                      partEditor(p)
                    )
                  ) : lang === "source" ? (
                    <MarkdownView markdown={p.source_md ?? ""} dir="ltr" />
                  ) : lang === "target" ? (
                    targetView(p, false)
                  ) : (
                    bothView(p)
                  )}
                </Box>
              ))}

              {lang !== "source" && editingPath === null && canEdit && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }}>
                  {t("flowWords.tapToEdit", { target: targetLabel })}
                </Typography>
              )}
              {aiUnavailable && (
                <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
                  {aiUnavailable}
                </Typography>
              )}
            </Box>
          </>
        )}
      </Box>

      {/* action bar — Redo · Approve. "Needs work" is hidden: the article
          state machine has no such state to write (see header). Page: fixed
          to the viewport bottom; pane: anchored inside the pane (sticky at
          its bottom, pinned there by margin-block-start:auto when short). */}
      {parts !== null && !loadError && !focusMode && (
        <Box
          component="footer"
          sx={
            pane
              ? {
                  position: "sticky",
                  insetBlockEnd: 0,
                  zIndex: 10,
                  marginBlockStart: "auto",
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
              : {
                  position: "fixed",
                  insetBlockEnd: 0,
                  insetInline: 0,
                  zIndex: theme.zIndex.appBar,
                  bgcolor: "background.paper",
                  borderBlockStart: "1px solid",
                  borderColor: "divider",
                }
          }
        >
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              maxWidth: pane ? "none" : COLUMN_PX,
              mx: "auto",
              paddingInline: pane ? 2.5 : 2,
              paddingBlockStart: 1.5,
              paddingBlockEnd: pane ? 1.5 : "calc(12px + env(safe-area-inset-bottom))",
            }}
          >
            <Button
              variant="outlined"
              disabled={redoBlockedReason !== null || redoing || busy}
              title={redoBlockedReason ?? t("flowWords.redoTitle")}
              onClick={() => void handleRedo()}
              startIcon={
                <AutoAwesomeIcon
                  sx={
                    redoing
                      ? {
                          animation: "be-spin 0.8s linear infinite",
                          "@keyframes be-spin": { to: { transform: "rotate(360deg)" } },
                        }
                      : undefined
                  }
                />
              }
              sx={{
                flex: 1,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                color: ACCENT,
                borderColor: INSPIRE,
                borderWidth: "1.5px",
              }}
            >
              {redoing ? t("flowWords.redrafting") : t("flowWords.redo")}
            </Button>
            <Button
              disabled={approveBlockedReason !== null || busy || redoing}
              title={approveBlockedReason ?? t("flowWords.approveTitle")}
              onClick={() => void handleApprove()}
              startIcon={<CheckIcon />}
              sx={{
                flex: 1.4,
                minHeight: 50,
                borderRadius: "12px",
                fontWeight: 700,
                bgcolor: ok.main,
                color: "#fff",
                "&:hover": { bgcolor: ok.main, filter: "brightness(0.95)" },
                "&.Mui-disabled": { bgcolor: skip.soft, color: skip.ink },
              }}
            >
              {t("common.approve")}
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
