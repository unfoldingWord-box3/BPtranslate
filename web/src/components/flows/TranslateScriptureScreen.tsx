// i18n: user-visible strings go through t() under the `flowScripture`
// namespace (plus `common.*` for exact shared verbs).
//
// TranslateScriptureScreen — the verse-at-a-time scripture queue, built to the
// approved "Scripture — Titus 1" mockup (the Titus-artifact minimal redesign)
// and following the patterns TranslateNotesScreen / TranslateQuestionsScreen
// established: drafts store, frozen queue, edited-as-chip, one centred column
// at every width, honest verbs only.
//
// THE SAVE PATH IS THE ONE THAT MATTERS. A vanilla textarea can only produce a
// flat string, and writing `{verseObjects:[{type:"text",…}]}` back destroys the
// verse's whole \zaln alignment tree — this has caused prod data loss before.
// Every save here runs the IDENTICAL path Shell.saveVerseDraft and
// ScriptureScreen.handleSaveLane use (ScriptureScreen.tsx:263-372):
//
//   extractEditableText(base.content)          → the diff baseline
//   smartEditVerse(base.content, old, new)     → a real tree, milestones kept
//   analyzeAlignmentDelta + guardBlocksSave    → refuse/confirm collateral loss
//   outbox.enqueueVerse(..., {sourceGeneration}) → If-Match + X-Source-Generation
//
// No verseObjects are ever constructed here by hand and no plain-text body is
// ever sent. Drafts (IndexedDB, payload shape { plainText } — the same shape
// ScriptureLane.tsx:170 and DocColumn write under verseKey) hold unsaved
// typing; only Save/Approve enqueues.
//
// Verbs, verified against the API before wiring (per the 2026-08-07 precedent
// recorded in TranslateQuestionsScreen's header — a permanently disabled verb
// earns no screen space):
//
//   * Save draft    → per-lane smartEditVerse + outbox.enqueueVerse (above).
//                     The outbox is the durable commit (ScriptureScreen.tsx:366
//                     makes the same call), so Save doesn't block on the
//                     network; failures surface via the outbox listener.
//   * Approve verse → the real per-verse done flag (verse_statuses):
//                     outbox.enqueueVerseStatus → PATCH
//                     /api/chapters/{book}/{ch}/{v}/status (api.setVerseDone,
//                     web/src/sync/api.ts:1759). It is an UPSERT with no
//                     version — but dirty lanes are saved AND awaited
//                     (waitForOp) first, so "Approved" is never claimed over
//                     text the server refused.
//   * Redraft both / Redraft this lane → HIDDEN. Scripture drafting is the
//                     async `generate` pipeline (api/src/pipelines.ts:71-88,
//                     PipelineOptions.contentTypes ["ult","ust"]) — a
//                     chapter-scoped job that takes ~an hour and LOCKS the
//                     chapter while it runs. The `translate` pipeline covers
//                     tn|tq|tw|ta only (pipelines.ts:116), and the only
//                     synchronous quick endpoints are tn-quick/template-quick
//                     (api/src/index.ts:73-79,272) — there is no per-verse
//                     scripture redraft the screen could drive. If one ships,
//                     bring the artifact's buttons back wired to it; the
//                     chapter-scoped fallback is the pipelines menu
//                     (POST /api/pipelines/start, pipelineType "generate").
//
// Honesty notes, decided here and visible on screen:
//
//   * The mockup's per-lane "Source · ULT" line (published gateway-language
//     text) does not exist in this app's data: in a translation workspace the
//     ULT/UST rows ARE the target drafts, and no hook fetches published source
//     scripture (ScriptureLane.tsx:235-237 hit the same wall). The lane-
//     agnostic original-language line (UHB/UGNT) is shown once instead.
//   * The mockup's "AI draft" chip is unverifiable: VerseDto carries no
//     provenance (web/src/sync/api.ts:102-117 — only updated_by). The chip
//     says "Imported" for an untouched row and "Edited" once a human touched
//     it (updated_by set, or unsaved typing here) — ScriptureLane.tsx:201-209
//     makes the same call. "Approved" mirrors the verse's real done flag.
//   * "Draft saved" as a *verse status* is session-local bookkeeping (the
//     server has no such state — verse_statuses is a done boolean). Only
//     Approve writes to the server's status table; the done-view tallies say
//     which count is which.
//   * Saving an already-approved verse does NOT unset its done flag — Save
//     never touches verse_statuses.
//
// Chapter lock: verse PATCH is NOT lock-exempt (the carve-out in
// api/src/rows.ts covers tn only), so the banner here is real — a save during
// an AI run is refused and dropped rather than overwritten. verse_status
// writes can also come back locked; both surface the banner.
//
// ── 2026-08-10 tablet/desktop layouts + align affordances (Benjamin) ────────
//
//   * "All 3 widths": below md (900px) nothing changed — the verse-at-a-time
//     column with the viewport-fixed action bar. At md+ the screen becomes
//     master-detail after TranslateWordsScreen's desk pattern
//     (docs/mockups/desktop-first/_design.css .desk/.rail/.panel): a
//     scrollable verse-list pane (340–380px) on the inline-start side and a
//     panel-chromed detail pane holding the same reference + lane cards and
//     done view, with the Save draft / Approve verse bar sticky at the pane's
//     bottom. Selecting a list row moves the SAME cursor Prev/Next drives —
//     one selection model, two controls. Rows show the verse number, a
//     one-line snippet (target text when a lane has it, else the
//     original-language line), and the verse's terminal status chip
//     (Approved / Draft saved; an untouched verse is chipless). Desktop
//     (>=1200px) follows the same desk rule — the grid caps at 1440px.
//   * Alignment affordances, md+ ONLY (on the phone the Align screen stays
//     reachable from the hub): a quiet per-lane "Align" button →
//     #/alignment/{book}/{chapter}/{verse} (single mode — the align screen
//     owns lane choice) and one "Align both" → …/{verse}/dual. Plain hash
//     navigations at the CURRENT verse; no new state machinery.
//   * RTL: logical properties only. The desk grid's column order follows the
//     document direction by itself, and chevrons follow theme.direction
//     (scaleX flip).
//
// ── 2026-08-10 paging affordances (Benjamin, later the same day) ─────────────
//
//   * Prev/Next at the TOP too: compact icon-only chevrons in the topbar next
//     to "Verse N of M" (both widths). Same cursor, same disabled logic as the
//     bottom pair (goPrev/goNext are the single shared guards), plus disabled
//     on the done view — where the bottom pair doesn't render at all.
//   * Swipe navigation (useSwipeNav) spread on the verse content container —
//     a decisively-horizontal touch swipe pages the queue, reading-order aware
//     (rtl = the target-language direction). The hook itself ignores touches
//     that START in a textarea/input, which covers the two lane editors; the
//     source-text block additionally carries [data-no-swipe] so selecting
//     original-language text can't page. Disabled on the done view — its verbs
//     are Continue/Review, not paging.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowHeader, PHONE_TITLE_SX } from "./FlowHeader";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
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

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import {
  resolveFlowChipStatus,
  flowChipKind,
  type FlowChipStatus,
} from "../../lib/flowStatusChip";
import { waitForOp } from "./translateShared";
import { useSwipeNav } from "./useSwipeNav";
import type { FlowScreenContext } from "./types";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { countUnalignedTargetWords } from "../../lib/alignment";
import { analyzeAlignmentDelta, guardBlocksSave } from "../../lib/alignmentDelta";
import { smartEditVerse } from "../../lib/replace";
import { isHebrewBook } from "../../lib/sourceSearch";
import { realChapters } from "../../lib/bookSummary";
import { extractEditableText, extractPlainText, normalizeEditable } from "../../lib/usfm";
import { buildVerseIndex } from "../../lib/verseRange";
import { versionIsRtl, versionLabel } from "../../lib/versionLabels";
import { drafts, verseKey } from "../../sync/drafts";
import { onOutboxResult, outbox } from "../../sync/outbox";
import type { ChapterLockedBody, VerseDto } from "../../sync/api";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateScriptureScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  // Optional deep-link verse (e.g. the SyncStatusBar "N unsaved" jump, a
  // manual URL edit, or browser Back/Forward). Seeds the queue cursor to the
  // first queue entry at or after this verse on mount/chapter change, and
  // re-seeks it again on any later change to this prop within the same
  // chapter — mirrors TranslateNotesScreen's `verse` prop (#389).
  verse?: number;
}

// A verse is statused in exactly two ways. "approved" is the server's done
// flag (seeded from verse_statuses, written by Approve); "saved" is
// session-local bookkeeping for the mockup's "Save draft" progression.
type VerseTerminal = "approved" | "saved";

// The two editable target lanes. Role codes stay ULT/UST everywhere in the
// data; only the rendered label is per-project (ScriptureScreen.tsx:106-112).
const TARGET_LANES = ["ULT", "UST"] as const;
type TargetLane = (typeof TARGET_LANES)[number];
const LANE_STATE_KEY: Record<TargetLane, "lit" | "sim"> = { ULT: "lit", UST: "sim" };

// Outbox `fatal` reasons that mean "this lane is mid-replacement", not "your
// edit was wrong". Mirrors the terminal set in sync/outbox.ts's dispatch().
const LANE_REPLACEMENT_REASONS = new Set([
  "lane_replacement_required",
  "lane_replacement_in_progress",
  "source_generation_mismatch",
]);

// Content width — the mockup's 430px phone shell, given a little more room
// (the same measure the notes/questions screens settled on).
const COLUMN_PX = 480;

// Label copy for a resolved chip status, scripture's wording. Precedence lives
// in resolveFlowChipStatus (#348/#358); this only maps status → scripture label.
// A verse row has no per-lane AI-draft/aquifer/skip verdicts and no non-current
// "unsaved" tier (laneChip always resolves the OPEN verse), so a live diff or a
// human-touched save both read "Edited" and an untouched lane reads "Imported".
// The "No data" empty-lane case is handled by laneChip's own !base guard, not
// here.
function scriptureChipLabel(status: FlowChipStatus, t: TFunction): string {
  switch (status) {
    case "editing":
    case "unsaved":
    case "pending":
      return t("flowScripture.chipEdited");
    case "approved":
      return t("flowScripture.chipApproved");
    case "skipped":
    case "aquifer":
    case "aiDraft":
    case "draft":
      return t("flowScripture.chipImported");
  }
}

export default function TranslateScriptureScreen({
  role,
  book,
  chapter,
  verse,
}: TranslateScriptureScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  // .ref in the mockup: Ocean in light, Cultivate in dark.
  const REF_COLOR = dark ? "#70C9CC" : "#014263";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  const { ok, skip } = theme.palette.flows;
  // md+ (>=900px, the words screen's breakpoint): master-detail side by side
  // instead of the phone's single verse-at-a-time column (see file header).
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  // Phone (<560): the title row shares one bar with the account controls
  // (#299), so it shows the passage reference instead of the long title and
  // drops secondary icons (#517).
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet"));
  // Chevron glyphs don't flip with CSS direction on their own — mirror them
  // under RTL so "back"/"previous" keep pointing the right way.
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || t("flowScripture.target");
  const canEditRole = role === "admin" || role === "editor";

  const { status, data, applyLocalVerse, applyLocalVerseStatus } = useChapter(book, chapter);
  const { summary } = useBook(book, true);
  const chapterCount = summary ? realChapters(summary).length : null;

  // ── verse indexing ───────────────────────────────────────────────────────
  // Every per-verse read goes through buildVerseIndex so a `\v 6-9` range row
  // (keyed by verse_start) stays visible at verses 7-9 (verseRange.ts: "all
  // renderers go through this module").
  const verseIndexes = useMemo<Record<string, Record<number, VerseDto>>>(() => {
    const out: Record<string, Record<number, VerseDto>> = {};
    for (const bv of Object.keys(data?.verses ?? {})) {
      out[bv] = buildVerseIndex(data?.verses?.[bv]);
    }
    return out;
  }, [data]);

  const sourceIsHebrew = isHebrewBook(book);
  const sourceLane = sourceIsHebrew ? "UHB" : "UGNT";
  const sourceLabel = versionLabel(projectConfig, sourceLane);
  const sourceRtl = versionIsRtl(projectConfig, sourceLane);

  // The source lane anchors "which verses exist" — it is present even when a
  // target lane is omitted mid-replacement (ScriptureScreen.tsx:211-217).
  const verseNums = useMemo(() => {
    const ref = data?.verses?.[sourceLane] ?? data?.verses?.ULT ?? {};
    return Object.keys(ref)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
  }, [data, sourceLane]);

  // ── queue ────────────────────────────────────────────────────────────────
  // Frozen once per chapter so the denominator ("Verse 3 of 8") and the
  // progress bar stay stable while the translator works. Approved seeds come
  // from the server's verse_statuses done flags.
  const chapterKey = `${book}:${chapter}`;
  const [queue, setQueue] = useState<{ key: string; verses: number[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<number, VerseTerminal>>({});
  // Prior status per verse, captured just before handleApprove's optimistic
  // "approved" overwrite — lets a late verse_status fatal (outbox
  // reconciliation below) restore what was there before instead of blanking
  // the verse.
  const prevStatusRef = useRef<Record<number, VerseTerminal | undefined>>({});
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<"verses" | "done">("verses");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!data || data.book !== book || data.chapter !== chapter) return;
    if (queue?.key === chapterKey) return;
    const seed: Record<number, VerseTerminal> = {};
    for (const s of data.verseStatuses) {
      if (s.done === 1 && verseNums.includes(s.verse)) seed[s.verse] = "approved";
    }
    const firstOpen = verseNums.findIndex((v) => !seed[v]);
    setQueue({ key: chapterKey, verses: verseNums });
    setStatuses(seed);
    if (verse != null) {
      // A verse past the last queue entry has no >= match (-1); clamp to the
      // last verse instead of falling back to index 0, which would jump to
      // the top of the chapter instead of near where the deep link pointed.
      const seekIdx = verseNums.findIndex((v) => v >= verse);
      setCursor(seekIdx < 0 ? (verseNums.length > 0 ? verseNums.length - 1 : 0) : seekIdx);
    } else {
      setCursor(firstOpen < 0 ? 0 : firstOpen);
    }
    // A deep-linked verse always lands on the verse view, even if every verse
    // in the chapter is already approved — "done" would otherwise discard the
    // requested target.
    setView(verse != null ? "verses" : verseNums.length > 0 && firstOpen < 0 ? "done" : "verses");
    setReviewing(false);
    // `verse` deliberately not a dep beyond this — this effect only builds the
    // queue and seeds its cursor once per mount/chapter change (the
    // `queue?.key === chapterKey` guard above). Re-seeking on a later,
    // same-chapter change to `verse` is handled by the dedicated effect below,
    // which does not rebuild the queue or reset statuses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, book, chapter, queue, chapterKey, verseNums]);

  const queueVerses = queue?.key === chapterKey ? queue.verses : null;
  const total = queueVerses?.length ?? 0;
  const verseNum = queueVerses && cursor < queueVerses.length ? queueVerses[cursor] : null;
  const statusedCount = queueVerses ? queueVerses.filter((v) => statuses[v]).length : 0;

  // Re-seek the cursor when `verse` changes while the queue is already built
  // for the current chapter — e.g. editing the URL from #/scripture/JON/2 to
  // #/scripture/JON/2/7, or Back/Forward between two verses of the same
  // chapter. Cross-chapter deep links are handled above, by the queue rebuild
  // itself. Guarded on an actual change of `verse` (via the ref, not just its
  // presence in the dep array) so this never fires on plain cursor navigation
  // (Prev/Next), a status change, or unrelated re-renders — only a real prop
  // change moves the cursor here. Mirrors TranslateNotesScreen's verse re-seek
  // effect (#389).
  const prevVerseRef = useRef(verse);
  useEffect(() => {
    if (prevVerseRef.current === verse) return;
    prevVerseRef.current = verse;
    if (!queueVerses || queueVerses.length === 0) return;
    if (verse == null) {
      // The verse segment was dropped (e.g. #/scripture/JON/2/7 → #/scripture/
      // JON/2 via Back/Forward or a manual URL edit). Restore the same
      // no-verse init the mount/queue-build path uses: first still-open
      // verse, or the done view when every verse in the chapter is already
      // statused.
      const firstOpen = queueVerses.findIndex((v) => !statuses[v]);
      setCursor(firstOpen < 0 ? 0 : firstOpen);
      setView(firstOpen < 0 ? "done" : "verses");
      return;
    }
    const seekIdx = queueVerses.findIndex((v) => v >= verse);
    setCursor(seekIdx < 0 ? queueVerses.length - 1 : seekIdx);
    setView("verses");
  }, [verse, queueVerses, statuses]);

  // ── per-lane rows + baselines ────────────────────────────────────────────
  const bases = useMemo<Record<TargetLane, VerseDto | null>>(
    () => ({
      ULT: verseNum != null ? (verseIndexes.ULT?.[verseNum] ?? null) : null,
      UST: verseNum != null ? (verseIndexes.UST?.[verseNum] ?? null) : null,
    }),
    [verseIndexes, verseNum],
  );
  const baselines = useMemo<Record<TargetLane, string>>(
    () => ({
      ULT: bases.ULT ? extractEditableText(bases.ULT.content) : "",
      UST: bases.UST ? extractEditableText(bases.UST.content) : "",
    }),
    [bases],
  );
  const sourceDto = verseNum != null ? (verseIndexes[sourceLane]?.[verseNum] ?? null) : null;

  // ── editor state ─────────────────────────────────────────────────────────
  // One value per lane, hydration and dirty-tracking following ScriptureLane's
  // proven state machine (seed once per draft key; adopt new server content
  // only while clean; dirtyRef is the synchronous mirror so a re-render before
  // the async draft write lands can't resync over in-progress typing).
  const [values, setValues] = useState<Record<TargetLane, string>>({ ULT: "", UST: "" });
  const dirtyRef = useRef<Record<TargetLane, boolean>>({ ULT: false, UST: false });
  const hydratedKeyRef = useRef<Record<TargetLane, string | null>>({ ULT: null, UST: null });

  // Phone focus mode (issue #164), same idea as TranslateNotesScreen.tsx's
  // `focusMode` — the on-screen keyboard leaves almost no room on a phone, so
  // an active lane edit hides the surrounding chrome (topbar, Prev/Next)
  // until the user blurs out. Unlike Notes/Questions there is no pre-existing
  // edit-mode boolean here (the lane TextFields are always-on), so this is
  // driven directly by onFocus/onBlur on the lane TextField in
  // renderLaneCard() below. The action bar (Save draft / Approve verse) is
  // deliberately NOT hidden by focus mode, unlike Notes/Questions: blur fires
  // before a tap's click/pointerup completes, so hiding the only Save button
  // on blur risks eating the tap that was meant to press it. Keeping it
  // visible sidesteps that race entirely. Wide/desktop behavior is untouched
  // — this is always false there.
  const [laneFocused, setLaneFocused] = useState(false);
  const focusMode = !wide && laneFocused;
  // Deferred-blur handle: blurring one lane field to focus the sibling lane
  // field (ULT <-> UST) would otherwise transiently drop laneFocused between
  // the two events, flashing the topbar/pager back in for one frame mid-tap
  // (Codex review, PR #171 finding 2). onFocus cancels a pending clear before
  // it fires; the deferred macrotask lets the sibling's focus event (which
  // fires synchronously right after blur, same interaction) win the race.
  const laneBlurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLaneBlurTimeout = useCallback(() => {
    if (laneBlurTimeoutRef.current != null) {
      clearTimeout(laneBlurTimeoutRef.current);
      laneBlurTimeoutRef.current = null;
    }
  }, []);
  const handleLaneFocus = useCallback(() => {
    clearLaneBlurTimeout();
    setLaneFocused(true);
  }, [clearLaneBlurTimeout]);
  const handleLaneBlur = useCallback(() => {
    clearLaneBlurTimeout();
    laneBlurTimeoutRef.current = setTimeout(() => {
      laneBlurTimeoutRef.current = null;
      setLaneFocused(false);
    }, 0);
  }, [clearLaneBlurTimeout]);
  useEffect(() => clearLaneBlurTimeout, [clearLaneBlurTimeout]);
  // Belt-and-suspenders reset (Codex review, PR #171 finding 1): swiping away
  // from the last open verse calls setView("done") without changing cursor,
  // so verseNum — and therefore the lane TextField — doesn't change, meaning
  // it never unmounts and never blurs on its own. Force focus mode closed the
  // moment the done view opens, regardless of whether blur fired.
  useEffect(() => {
    if (view === "done") {
      clearLaneBlurTimeout();
      setLaneFocused(false);
    }
  }, [view, clearLaneBlurTimeout]);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(
    null,
  );
  const [lock, setLock] = useState<ChapterLockedBody | null>(null);
  const [laneReplacement, setLaneReplacement] = useState<Record<string, string>>({});
  // A save that would collaterally unalign untouched words. Mirrors
  // ScriptureScreen's pendingLoss confirm (ScriptureScreen.tsx:169-174): the
  // typing is NOT discarded — "Save anyway" re-enqueues under the one
  // guard-exempt intent. The commit saves the lane only; Approve is clicked
  // again afterwards if that's what the translator wanted.
  const [pendingLoss, setPendingLoss] = useState<{
    ref: string;
    lostWords: string[];
    commit: () => void;
  } | null>(null);

  const say = useCallback((text: string, severity: "info" | "warning" = "warning") => {
    setNotice({ text, severity });
  }, []);

  // Hydrate both lanes on verse change: server text first, then any persisted
  // draft (unsaved typing from this browser) on top. Keyed on the CANONICAL
  // row verse (base.verse), never the displayed one — a `\v 6-9` row opened at
  // verse 7 drafts and PATCHes v=6 (ScriptureLane.tsx:88-95).
  useEffect(() => {
    if (verseNum == null) return;
    for (const bv of TARGET_LANES) {
      const base = bases[bv];
      const key = base ? verseKey(book, chapter, base.verse, bv) : `none:${bv}:${verseNum}`;
      if (hydratedKeyRef.current[bv] === key) continue;
      hydratedKeyRef.current[bv] = key;
      dirtyRef.current[bv] = false;
      const fallback = base ? extractEditableText(base.content) : "";
      setValues((prev) => ({ ...prev, [bv]: fallback }));
      if (!base) continue;
      void drafts.get(key).then((rec) => {
        if (hydratedKeyRef.current[bv] !== key) return;
        const plain = (rec?.payload as { plainText?: unknown } | undefined)?.plainText;
        if (typeof plain === "string") {
          // A restored draft IS unsaved typing — mark dirty synchronously so
          // the resync effect below can't adopt a new baseline over it.
          if (normalizeEditable(plain) !== fallback) dirtyRef.current[bv] = true;
          setValues((prev) => ({ ...prev, [bv]: plain }));
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, chapter, verseNum, bases]);

  // Adopt new SERVER content while the lane is clean (a sibling editor's save,
  // our own applyLocalVerse after enqueue) — ScriptureLane.tsx:150-153.
  useEffect(() => {
    for (const bv of TARGET_LANES) {
      if (dirtyRef.current[bv]) continue;
      setValues((prev) => (prev[bv] === baselines[bv] ? prev : { ...prev, [bv]: baselines[bv] }));
    }
  }, [baselines]);

  const laneDirty = (bv: TargetLane): boolean =>
    Boolean(bases[bv]) && normalizeEditable(values[bv]) !== baselines[bv];
  const hasDiff = TARGET_LANES.some(laneDirty);
  useUnsavedGuard(hasDiff);

  // Every keystroke goes to the IndexedDB drafts store so unsaved typing
  // survives a reload / tab close. The outbox is untouched until Save —
  // nothing leaves the browser here. Payload shape { plainText } matches
  // ScriptureLane so the two surfaces never mis-read each other's records.
  function handleLaneChange(bv: TargetLane, next: string) {
    setValues((prev) => ({ ...prev, [bv]: next }));
    const base = bases[bv];
    if (!base) return;
    const key = verseKey(book, chapter, base.verse, bv);
    if (normalizeEditable(next) === baselines[bv]) {
      dirtyRef.current[bv] = false;
      void drafts.clear(key);
      return;
    }
    // Synchronous, before the async draft write: the resync effect must never
    // adopt a new baseline over typing that hasn't reached IndexedDB yet.
    dirtyRef.current[bv] = true;
    void drafts.set(key, { plainText: next }, base.version, {
      kind: "verse",
      book,
      chapter,
      verse: base.verse,
      bibleVersion: bv,
    });
  }

  // ── outbox reconciliation ────────────────────────────────────────────────
  // Saves leave through the outbox, so late failures never reach a local
  // catch — they arrive as outbox results (ScriptureScreen.tsx:239-261).
  useEffect(() => {
    return onOutboxResult((op, result) => {
      const target = op.target;
      if (target.kind === "verse" && target.book === book) {
        if (result.kind === "fatal" && LANE_REPLACEMENT_REASONS.has(result.reason)) {
          setLaneReplacement((prev) => ({ ...prev, [target.bibleVersion]: result.reason }));
        } else if (result.kind === "fatal") {
          say(
            t("flowScripture.saveFailed", {
              lane: versionLabel(projectConfig, target.bibleVersion),
              reason: result.reason,
            }),
          );
        } else if (result.kind === "conflict" && op.status === "conflict") {
          say(
            t("flowScripture.verseConflict", {
              book,
              chapter: target.chapter,
              verse: target.verse,
              lane: versionLabel(projectConfig, target.bibleVersion),
            }),
          );
        } else if (result.kind === "ok") {
          setLock(null);
        }
      }
      if (
        result.kind === "locked" &&
        (target.kind === "verse" || target.kind === "verse_status") &&
        target.book === book
      ) {
        setLock(result.lockBody);
      }
      if (target.kind === "verse_status" && target.book === book && result.kind === "fatal") {
        say(
          t("flowScripture.approveNotRecorded", {
            chapter: target.chapter,
            verse: target.verse,
            reason: result.reason,
          }),
        );
        applyLocalVerseStatus(target.verse, false);
        setStatuses((prev) => {
          if (prev[target.verse] !== "approved") return prev;
          const restored = prevStatusRef.current[target.verse];
          const next = { ...prev };
          if (restored) next[target.verse] = restored;
          else delete next[target.verse];
          return next;
        });
      }
    });
  }, [book, projectConfig, say, applyLocalVerseStatus, t]);

  // ── lane derivation (evidence-based, ported from ScriptureScreen:514-544) ─
  function laneInfo(bv: TargetLane) {
    const laneState = projectConfig?.laneState?.[LANE_STATE_KEY[bv]] ?? null;
    const rows = data?.verses?.[bv];
    const laneOmitted = Boolean(data) && (!rows || Object.keys(rows).length === 0);
    const pendingReplacement =
      Boolean(laneState?.pendingTarget) || Boolean(laneReplacement[bv]);
    const textReadOnly = Boolean(laneState?.config.textReadOnly);
    return { laneOmitted, pendingReplacement, textReadOnly };
  }

  // ── navigation between verses ────────────────────────────────────────────
  const nextUnstatused = useCallback(
    (from: number, table: Record<number, VerseTerminal>): number => {
      if (!queueVerses) return -1;
      for (let i = 1; i <= queueVerses.length; i++) {
        const idx = (from + i) % queueVerses.length;
        if (!table[queueVerses[idx]]) return idx;
      }
      return -1;
    },
    [queueVerses],
  );

  const advanceAfter = useCallback(
    (v: number, next: VerseTerminal) => {
      if (!queueVerses) return;
      const table = { ...statuses, [v]: next };
      if (reviewing) {
        if (cursor >= queueVerses.length - 1) setView("done");
        else setCursor(cursor + 1);
        return;
      }
      const nxt = nextUnstatused(cursor, table);
      if (nxt === -1) setView("done");
      else setCursor(nxt);
    },
    [queueVerses, statuses, reviewing, cursor, nextUnstatused],
  );

  // One cursor, three controls: the bottom Prev/Next buttons, the topbar
  // chevrons, and swipe all drive these two guards. The guards mirror the
  // buttons' disabled logic exactly, so swipe (which has no `disabled`
  // attribute) can never do anything a button couldn't.
  function goPrev() {
    if (busy || cursor === 0) return;
    setCursor((c) => Math.max(0, c - 1));
  }
  function goNext() {
    if (busy) return;
    if (cursor < total - 1) setCursor((c) => c + 1);
    else if (statusedCount >= total && total > 0) setView("done");
  }
  // Horizontal touch swipe pages the queue. rtl is the TARGET-language
  // direction (the content being paged), not the UI chrome's. The hook
  // ignores touches starting in the lane textareas; disabled on the done
  // view, whose verbs are Continue/Review, not paging. Also disabled during
  // phone focus mode (Codex review, PR #171 finding 1) — same convention as
  // TranslateNotesScreen.tsx's swipe gate — so a swipe can't page away from
  // a focused lane and leave focus mode stuck (belt-and-suspenders with the
  // view==="done" reset above, which covers the case where paging away
  // doesn't change verseNum at all).
  const swipe = useSwipeNav({
    onPrev: goPrev,
    onNext: goNext,
    enabled: view !== "done" && !focusMode,
    rtl: versionIsRtl(projectConfig, "ULT"),
  });

  // ── writes ───────────────────────────────────────────────────────────────
  // One lane's save, the exact ScriptureScreen.handleSaveLane path. Returns
  // "noop" when there was nothing to save, "queued" (with the op id) when the
  // edit is in the outbox, or "blocked" when the alignment guard put the
  // decision to the user instead.
  type LaneSave = { kind: "noop" } | { kind: "blocked" } | { kind: "queued"; opId: string };
  async function saveLane(bv: TargetLane): Promise<LaneSave> {
    const base = bases[bv];
    if (!base) return { kind: "noop" };
    const plain = values[bv];
    const oldEditable = extractEditableText(base.content);
    const key = verseKey(book, chapter, base.verse, bv);
    // No-op guard: a save with no real change must not bump the version. Also
    // clear the stranded keystroke draft so "unsaved" stays truthful.
    if (oldEditable === normalizeEditable(plain)) {
      dirtyRef.current[bv] = false;
      void drafts.clear(key);
      return { kind: "noop" };
    }
    const result = smartEditVerse(base.content, oldEditable, plain);
    // Editing a word's text unaligns that word by design; say so rather than
    // letting it be discovered later (ScriptureScreen.tsx:340-352).
    const before = countUnalignedTargetWords(
      (base.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    const after = countUnalignedTargetWords(
      (result.content as { verseObjects?: unknown[] } | null)?.verseObjects,
    );
    if (after - before > 0) {
      say(
        t("flowScripture.wordsUnaligned", {
          count: after - before,
          book,
          chapter,
          verse: base.verse,
          lane: versionLabel(projectConfig, bv),
        }),
        "info",
      );
    }
    const newPlainText = extractPlainText(result.content);
    const delta = analyzeAlignmentDelta(base.content, result.content);
    // The enforced predicate lives in guardBlocksSave — never narrow it here.
    if (guardBlocksSave(delta, "text_edit")) {
      setPendingLoss({
        ref: `${book} ${chapter}:${base.verse} ${versionLabel(projectConfig, bv)}`,
        lostWords: delta.unexpectedLosses.map((l) => l.text),
        commit: () => {
          void outbox.enqueueVerse(
            book,
            chapter,
            base.verse,
            bv,
            base.version,
            { content: result.content, plain_text: newPlainText, alignment_intent: "alignment_edit" },
            { sourceGeneration: base.source_generation },
          );
          applyLocalVerse({ ...base, plain_text: newPlainText, content: result.content } as VerseDto);
          dirtyRef.current[bv] = false;
        },
      });
      return { kind: "blocked" };
    }
    const op = await outbox.enqueueVerse(
      book,
      chapter,
      base.verse,
      bv,
      base.version,
      { content: result.content, plain_text: newPlainText, alignment_intent: "text_edit" },
      { sourceGeneration: base.source_generation },
    );
    applyLocalVerse({ ...base, plain_text: newPlainText, content: result.content } as VerseDto);
    dirtyRef.current[bv] = false;
    return { kind: "queued", opId: op.id };
  }

  // Save draft: enqueue both dirty lanes. The outbox is the durable commit
  // (offline-safe; failures surface via the listener above), so this doesn't
  // block on the network — matching ScriptureScreen's own Save.
  async function handleSave() {
    if (verseNum == null || busy || !canEditRole) return;
    setBusy(true);
    setNotice(null);
    try {
      let blocked = false;
      for (const bv of TARGET_LANES) {
        const r = await saveLane(bv);
        if (r.kind === "blocked") blocked = true;
      }
      if (blocked) return; // the pendingLoss dialog owns the next step
      setStatuses((prev) => ({
        ...prev,
        [verseNum]: prev[verseNum] === "approved" ? "approved" : "saved",
      }));
      setToast(t("flowScripture.toastDraftSaved"));
    } finally {
      setBusy(false);
    }
  }

  // Approve verse: save-then-status, saves AWAITED — "Approved" is never
  // claimed over text the server refused (the notes screen's save-then-
  // validate discipline, applied to the verse done flag).
  async function handleApprove() {
    if (verseNum == null || busy || !canEditRole) return;
    setBusy(true);
    setNotice(null);
    try {
      for (const bv of TARGET_LANES) {
        const r = await saveLane(bv);
        if (r.kind === "blocked") return; // dialog explains; not approved
        if (r.kind !== "queued") continue;
        const settled = await waitForOp(r.opId);
        if (settled === null) {
          say(t("flowScripture.approveQueuedNotConfirmed"));
          return;
        }
        if (settled.kind !== "ok") {
          if (settled.kind === "locked") {
            setLock(settled.lockBody);
            say(t("flowScripture.approveLocked"));
          } else if (settled.kind === "conflict") {
            say(t("flowScripture.approveConflict"));
          } else {
            say(
              t("flowScripture.approveSaveFailed", {
                lane: versionLabel(projectConfig, bv),
                reason: settled.reason,
              }),
            );
          }
          return;
        }
      }
      applyLocalVerseStatus(verseNum, true);
      void outbox.enqueueVerseStatus(book, chapter, verseNum, true);
      prevStatusRef.current[verseNum] = statuses[verseNum];
      setStatuses((prev) => ({ ...prev, [verseNum]: "approved" }));
      setToast(t("flowScripture.toastVerseApproved"));
      advanceAfter(verseNum, "approved");
    } finally {
      setBusy(false);
    }
  }

  // ── render gates (every hook above this line, unconditionally) ───────────
  if (status === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="error">{t("flowScripture.loadError", { book, chapter })}</Alert>
      </Box>
    );
  }
  if (!data || !queueVerses) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
        <CircularProgress />
      </Stack>
    );
  }

  const done = view === "done";
  const approvedCount = queueVerses.filter((v) => statuses[v] === "approved").length;
  const savedCount = queueVerses.filter((v) => statuses[v] === "saved").length;

  // One chip per lane. Precedence is the shared resolver's (#348/#358), NOT an
  // inline copy: a dirty current lane must win over the verse's approved verdict
  // (#342/#366) — otherwise the translator who jumped here for the unsaved text
  // sees "Approved" and it's hidden. laneChip only renders the OPEN verse, so
  // both lanes are isCurrent; laneDirty subsumes a restored draft (hydration
  // marks it dirty), so hasLiveDiff is the signal and draftPresent stays false.
  function laneChip(bv: TargetLane): { kind: FlowStatusKind; label: string } {
    const base = bases[bv];
    const status = resolveFlowChipStatus({
      isCurrent: true,
      hasLiveDiff: laneDirty(bv),
      draftPresent: false,
      approved: verseNum != null && statuses[verseNum] === "approved",
      skipped: false,
      pending: base?.updated_by != null, // human-touched save → "Edited"
      aquifer: false,
      aiDrafted: false,
    });
    // Empty lane reads "No data" — but never let that hide the verse's approved
    // verdict (preserves the prior approved-over-empty-lane behavior). A dirty
    // or human-touched lane can't be base-less, so this only fires for the
    // untouched/approved cases.
    if (!base && status !== "approved") {
      return { kind: "skip", label: t("flowScripture.chipNoData") };
    }
    return { kind: flowChipKind(status), label: scriptureChipLabel(status, t) };
  }

  const nextChapter = chapter + 1;
  const hasNextChapter = chapterCount === null ? true : nextChapter <= chapterCount;

  const sub = translationMode
    ? t("flowScripture.subTranslation", {
        book,
        chapter,
        source: (projectConfig?.translationSource?.languageCode ?? "en").toUpperCase(),
        target: targetLabel,
      })
    : t("flowScripture.subPlain", { book, chapter, target: targetLabel });

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

  const tagSx = {
    display: "inline-flex",
    alignItems: "center",
    gap: 0.75,
    fontSize: "0.6875rem",
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
  };

  // A render FUNCTION, not a nested component: declaring a component inside
  // the render body mints a new type every render, and React would remount the
  // subtree — dropping the textarea's focus on every keystroke.
  function renderLaneCard(bv: TargetLane) {
    const base = bases[bv];
    const info = laneInfo(bv);
    const display = versionLabel(projectConfig, bv);
    const targetRtl = versionIsRtl(projectConfig, bv);
    const chip = laneChip(bv);
    const canEdit =
      canEditRole && Boolean(base) && !info.pendingReplacement && !info.textReadOnly;
    // Plain absence is NOT evidence of a replacement — say what is actually
    // known (the distinction ScriptureScreen.tsx:729-749 draws).
    let disabledReason: string | null = null;
    if (info.pendingReplacement) {
      disabledReason = t("flowScripture.laneAwaitingReplacement", { lane: display });
    } else if (info.textReadOnly) {
      disabledReason = t("flowScripture.laneReadOnly", { lane: display });
    } else if (!canEditRole) {
      disabledReason = t("flowScripture.viewOnly");
    } else if (!base) {
      disabledReason = t("flowScripture.laneNoText", { lane: display });
    }
    return (
      <Box component="section" aria-label={t("flowScripture.laneAria", { lane: bv })} sx={cardSx}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography component="p" sx={{ ...tagSx, m: 0 }}>
            {bv}
            {display !== bv && (
              <>
                <Box component="span" sx={{ color: INSPIRE, fontWeight: 700 }} aria-hidden="true">
                  →
                </Box>
                {display}
              </>
            )}
          </Typography>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.75}
            sx={{ marginInlineStart: "auto" }}
          >
            {/* a quiet single-lane hand-off to the Align screen, which owns
                lane choice (see the 2026-08-10 header section). Rendered on
                phone too (kept size="small" so the lane-card header doesn't
                wrap at a 480px column width). */}
            {verseNum != null && (
              <Button
                size="small"
                title={t("flowScripture.alignTitle", { book, chapter, verse: verseNum })}
                onClick={() => {
                  location.hash = `#/alignment/${book}/${chapter}/${verseNum}`;
                }}
                sx={{ minHeight: 32, paddingInline: 1, color: ACCENT, fontWeight: 700 }}
              >
                {t("flowScripture.align")}
              </Button>
            )}
            <FlowStatusChip kind={chip.kind} label={chip.label} />
          </Stack>
        </Stack>
        <Typography component="p" sx={{ ...tagSx, mt: 0, mb: 0.75 }}>
          {t("flowScripture.yourText", { lane: display })}
        </Typography>
        <TextField
          multiline
          fullWidth
          minRows={3}
          maxRows={14}
          value={values[bv]}
          disabled={!canEdit}
          onChange={(e) => handleLaneChange(bv, e.target.value)}
          onFocus={handleLaneFocus}
          onBlur={handleLaneBlur}
          inputProps={{
            dir: targetRtl ? "rtl" : "ltr",
            spellCheck: false,
            "aria-label": t("flowScripture.laneInputAria", { lane: display }),
          }}
          sx={{
            "& .MuiInputBase-root": {
              fontFamily: SCRIPTURE_FONT_STACK,
              fontSize: "1.03rem",
              lineHeight: 1.55,
              bgcolor: "action.hover",
              borderRadius: "9px",
              alignItems: "flex-start",
              textAlign: "start",
            },
            "& .MuiOutlinedInput-notchedOutline": {
              borderWidth: "1.5px",
              borderColor: canEdit ? INSPIRE : "divider",
            },
          }}
        />
        {disabledReason && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            {disabledReason}
          </Typography>
        )}
      </Box>
    );
  }

  // One verse row in the md+ list pane: verse number · one-line snippet
  // (target text when a lane has it, else the original-language line) · the
  // verse's terminal status chip. An untouched verse is chipless — the
  // absence IS the "untouched" mark. Selecting a row moves the SAME cursor
  // Prev/Next drives; from the done view it reopens that verse.
  function renderVerseRow(v: number, idx: number) {
    const ultText = verseIndexes.ULT?.[v]?.plain_text ?? "";
    const ustText = verseIndexes.UST?.[v]?.plain_text ?? "";
    const usesTarget = ultText.trim().length > 0 || ustText.trim().length > 0;
    const snippet = usesTarget
      ? ultText.trim().length > 0
        ? ultText
        : ustText
      : (verseIndexes[sourceLane]?.[v]?.plain_text ?? "");
    const st = statuses[v];
    const isSelected = !done && idx === cursor;
    return (
      <Box
        key={v}
        component="button"
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => {
          setCursor(idx);
          if (view !== "verses") setView("verses");
        }}
        sx={{
          ...cardSx,
          display: "flex",
          alignItems: "center",
          gap: 1.25,
          width: "100%",
          cursor: "pointer",
          font: "inherit",
          color: "inherit",
          paddingBlock: 1,
          ...(isSelected
            ? { borderColor: INSPIRE, bgcolor: alpha(INSPIRE, dark ? 0.12 : 0.06) }
            : {}),
          "&:hover": { borderColor: INSPIRE },
        }}
      >
        <Typography
          sx={{
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            color: REF_COLOR,
            flex: "none",
            minWidth: 22,
            textAlign: "start",
          }}
        >
          {v}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          dir="auto"
          sx={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontFamily: SCRIPTURE_FONT_STACK,
            textAlign: "start",
          }}
        >
          {snippet.trim().length > 0 ? snippet : "—"}
        </Typography>
        {st && (
          <FlowStatusChip
            kind={st === "approved" ? "approved" : "edited"}
            label={
              st === "approved" ? t("flowScripture.chipApproved") : t("flowScripture.chipDraftSaved")
            }
          />
        )}
      </Box>
    );
  }

  // The two honest verbs (Redraft is hidden; see header). Phone: fixed to the
  // viewport bottom, exactly as before. md+ pane: sticky at the pane's
  // bottom, pinned there by margin-block-start:auto when the content is short
  // (the words screen's pane pattern). Deliberately NOT gated by focusMode
  // (issue #164) — see the comment at focusMode's declaration.
  const actionBar = (
    <Box
      component="footer"
      // Guard the verbs from the swipe surface: a horizontal drag that
      // starts on Save/Approve must never page the queue.
      data-no-swipe
      sx={
        wide
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
          maxWidth: wide ? "none" : COLUMN_PX,
          mx: "auto",
          paddingInline: wide ? 2.5 : 2,
          paddingBlockStart: 1.5,
          paddingBlockEnd: wide ? 1.5 : "calc(12px + env(safe-area-inset-bottom))",
        }}
      >
        <Button
          disabled={busy || !canEditRole}
          title={
            canEditRole ? t("flowScripture.saveDraftTitle") : t("flowScripture.viewOnly")
          }
          onClick={() => void handleSave()}
          sx={{
            flex: 1,
            minHeight: 50,
            borderRadius: "12px",
            fontWeight: 700,
            bgcolor: skip.soft,
            color: skip.ink,
            "&:hover": { bgcolor: skip.soft },
          }}
        >
          {t("flowScripture.saveDraft")}
        </Button>
        <Button
          disabled={busy || !canEditRole}
          title={
            canEditRole ? t("flowScripture.approveVerseTitle") : t("flowScripture.viewOnly")
          }
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
          }}
        >
          {t("flowScripture.approveVerse")}
        </Button>
      </Stack>
    </Box>
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
      {/* topbar — rendered into the global flow bar via FlowHeader (#299).
          Hidden in phone focus mode (issue #164) to free space for the
          keyboard — same convention as TranslateNotesScreen.tsx. */}
      {!focusMode && (
        <FlowHeader>
          <Box
            sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: 2, paddingBlock: 1.5 }}
          >
            <Stack direction="row" alignItems="center" spacing={isTabletUp ? 1.25 : 0.5}>
              <IconButton
                aria-label={t("flowScripture.backToPackage", { book })}
                onClick={() => {
                  location.hash = `#/package/${book}`;
                }}
                sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
              >
                <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
              </IconButton>
              <Box sx={isTabletUp ? { minWidth: 0 } : PHONE_TITLE_SX}>
                <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                  {isTabletUp ? t("flowScripture.title") : t("common.passageRef", { book, chapter })}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                  {isTabletUp ? sub : t("flowScripture.title")}
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
                {done
                  ? t("flowScripture.ofTotal", { n: total, total })
                  : t("flowScripture.verseOfTotal", { n: Math.min(cursor + 1, total), total })}
              </Typography>
              {/* compact prev/next — the same cursor and disabled logic as the
                  bottom buttons (goPrev/goNext), also disabled on the done view
                  where the bottom pair doesn't render. */}
              <Stack direction="row" spacing={0.75} sx={{ flex: "none" }}>
                <IconButton
                  aria-label={t("flowScripture.prevVerse")}
                  size="small"
                  disabled={done || busy || cursor === 0}
                  onClick={goPrev}
                  sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
                >
                  <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
                </IconButton>
                <IconButton
                  aria-label={t("flowScripture.nextVerse")}
                  size="small"
                  disabled={done || busy || (cursor >= total - 1 && statusedCount < total)}
                  onClick={goNext}
                  sx={{ bgcolor: skip.soft, width: 30, height: 30, flex: "none" }}
                >
                  <ChevronRightIcon fontSize="small" sx={chevronFlip} />
                </IconButton>
              </Stack>
            </Stack>
            <Box
              sx={{ height: 4, borderRadius: "2px", bgcolor: skip.soft, mt: 1.25, overflow: "hidden" }}
            >
              <Box
                sx={{
                  height: "100%",
                  borderRadius: "2px",
                  bgcolor: INSPIRE,
                  transition: "width 0.35s ease",
                  width: total === 0 ? "0%" : `${(statusedCount / total) * 100}%`,
                }}
              />
            </Box>
          </Box>
        </FlowHeader>
      )}

      {/* md+ desk (the words screen's pattern, after docs/mockups/desktop-first/
          _design.css .desk/.rail/.panel): 1440px centred grid — verse-list pane
          on the inline-start side, panel-chromed detail pane filling the rest.
          Grid column order follows the document direction, so this is RTL-safe
          as-is. On the phone both wrappers collapse (display: contents) and the
          centred column renders exactly as before. */}
      <Box
        sx={
          wide
            ? {
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
              }
            : { display: "contents" }
        }
      >
        {/* verse-list pane (md+ only) */}
        {wide && (
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
            {queueVerses.map(renderVerseRow)}
          </Box>
        )}
        {/* detail pane (md+: panel chrome + its own scroller; phone: inert) */}
        <Box
          sx={
            wide
              ? {
                  minHeight: 0,
                  overflowY: "auto",
                  bgcolor: "background.paper",
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: "14px",
                  display: "flex",
                  flexDirection: "column",
                }
              : { display: "contents" }
          }
        >
          <Box
            // Swipe left/right pages the verse queue — this Box is the verse
            // content container at BOTH widths (phone centred column and md+
            // detail-pane body). The hook ignores touches that start in the
            // lane textareas, and it no-ops on the done view (enabled: false).
            {...swipe}
            sx={
              wide
                ? {
                    flex: "none",
                    paddingInline: 2.5,
                    paddingBlockStart: 2,
                    paddingBlockEnd: 2,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.5,
                  }
                : {
                    maxWidth: COLUMN_PX,
                    mx: "auto",
                    paddingInline: 2,
                    paddingBlockStart: 2,
                    // room for the viewport-fixed action bar
                    paddingBlockEnd: done ? 4 : 15,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.5,
                  }
            }
          >
            {lock && (
              // Real here, unlike the notes screen: verse PATCH is not lock-exempt,
              // so a save during an AI run is refused and dropped.
              <LockBanner pipelineType={lock.pipelineType} startedAt={lock.startedAt ?? null} />
            )}

            {notice && (
              <Alert severity={notice.severity} onClose={() => setNotice(null)}>
                {notice.text}
              </Alert>
            )}

            {!canEditRole && (
              <Alert severity="info">{t("flowScripture.viewOnlyEditors")}</Alert>
            )}

            {total === 0 ? (
              <Alert severity="info">{t("flowScripture.noVerses", { book, chapter })}</Alert>
            ) : done ? (
              <Box sx={{ ...cardSx, textAlign: "center", paddingBlock: 4.5 }}>
                <Box
                  component="svg"
                  width="96"
                  height="96"
                  viewBox="0 0 96 96"
                  aria-hidden="true"
                  sx={{ mx: "auto", display: "block" }}
                >
                  <circle cx="48" cy="48" r="46" fill={ok.soft} />
                  <circle cx="48" cy="48" r="36" fill={ok.main} />
                  <path
                    d="M33 49 L44 60 L64 37"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Box>
                <Typography component="h2" sx={{ fontSize: "1.375rem", fontWeight: 700, mt: 1.5 }}>
                  {t("flowScripture.completeTitle", { book, chapter })}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  {[
                    approvedCount > 0
                      ? t("flowScripture.approvedTally", { count: approvedCount })
                      : null,
                    savedCount > 0 ? t("flowScripture.savedTally", { count: savedCount }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || t("flowScripture.verseTally", { count: total })}
                </Typography>
                <Stack spacing={1}>
                  <Button
                    variant="contained"
                    disabled={!hasNextChapter}
                    onClick={() => {
                      location.hash = `#/scripture/${book}/${nextChapter}`;
                    }}
                    sx={{
                      minHeight: 52,
                      borderRadius: "12px",
                      fontWeight: 700,
                      bgcolor: INSPIRE,
                      color: "#06293B",
                      "&:hover": { bgcolor: INSPIRE_DEEP },
                    }}
                  >
                    {hasNextChapter
                      ? t("flowScripture.continueTo", { book, chapter: nextChapter })
                      : t("flowScripture.bookComplete", { book, chapter: nextChapter })}
                  </Button>
                  <Button
                    onClick={() => {
                      setReviewing(true);
                      setCursor(0);
                      setView("verses");
                    }}
                    sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                  >
                    {t("flowScripture.reviewAgain")}
                  </Button>
                </Stack>
              </Box>
            ) : (
              <>
                {/* scripture reference + the lane-agnostic original-language line.
                    The mockup's per-lane published-source line does not exist in
                    this app's data — see the header. */}
                <Box sx={cardSx}>
                  <Typography sx={{ fontSize: "0.875rem", fontWeight: 700, color: REF_COLOR, mb: 0.75 }}>
                    {book} {chapter}:{verseNum}
                  </Typography>
                  <Box
                    // Long-press text selection on the original-language line
                    // involves a horizontal drag — never let it page the queue.
                    data-no-swipe
                    sx={{
                      bgcolor: "action.hover",
                      borderRadius: "9px",
                      paddingBlock: 1.25,
                      paddingInline: 1.5,
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        display: "block",
                        fontSize: "0.656rem",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                        mb: 0.375,
                      }}
                    >
                      {sourceLabel}
                    </Box>
                    <Typography
                      component="p"
                      dir={sourceRtl ? "rtl" : "ltr"}
                      sx={{
                        fontFamily: SCRIPTURE_FONT_STACK,
                        fontSize: sourceRtl ? "1.25rem" : "1.03rem",
                        lineHeight: 1.6,
                        m: 0,
                        textAlign: "start",
                      }}
                    >
                      {sourceDto?.plain_text ?? (
                        <Box component="em" sx={{ fontSize: "0.875rem", fontFamily: "inherit" }}>
                          {t("flowScripture.noSourceText", { source: sourceLabel })}
                        </Box>
                      )}
                    </Typography>
                  </Box>
                </Box>

                {/* the two target lanes */}
                {renderLaneCard("ULT")}
                {renderLaneCard("UST")}

                {/* dual-mode hand-off to the Align screen (both lanes side by
                    side); the per-lane buttons above cover single mode.
                    Rendered on phone too, right above Previous/Next. */}
                {verseNum != null && (
                  <Stack direction="row" justifyContent="flex-end">
                    <Button
                      variant="outlined"
                      size="small"
                      title={t("flowScripture.alignBothTitle", { book, chapter, verse: verseNum })}
                      onClick={() => {
                        location.hash = `#/alignment/${book}/${chapter}/${verseNum}/dual`;
                      }}
                      sx={{
                        minHeight: 40,
                        borderRadius: "10px",
                        fontWeight: 700,
                        color: ACCENT,
                        borderColor: INSPIRE,
                        borderWidth: "1.5px",
                      }}
                    >
                      {t("flowScripture.alignBoth")}
                    </Button>
                  </Stack>
                )}

                {/* previous / next — hidden in phone focus mode (issue #164) */}
                {!focusMode && (
                  <Stack direction="row" justifyContent="space-between" spacing={1.25}>
                    <Button
                      startIcon={<ChevronLeftIcon sx={chevronFlip} />}
                      disabled={cursor === 0 || busy}
                      onClick={goPrev}
                      sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                    >
                      {t("flowScripture.previous")}
                    </Button>
                    <Button
                      endIcon={<ChevronRightIcon sx={chevronFlip} />}
                      disabled={busy || (cursor >= total - 1 && statusedCount < total)}
                      onClick={goNext}
                      sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                    >
                      {t("flowScripture.next")}
                    </Button>
                  </Stack>
                )}
              </>
            )}
          </Box>
          {/* md+: the action bar lives inside the pane, sticky at its bottom */}
          {wide && !done && total > 0 && verseNum != null && actionBar}
        </Box>
      </Box>

      {/* phone action bar — viewport-fixed, exactly as before */}
      {!wide && !done && total > 0 && verseNum != null && actionBar}

      {/* alignment-loss confirm — the same decision ScriptureScreen puts to the
          user; typing is kept either way. */}
      <Dialog open={Boolean(pendingLoss)} onClose={() => setPendingLoss(null)}>
        <DialogTitle>{t("flowScripture.lossTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {pendingLoss && pendingLoss.lostWords.length > 0
              ? t("flowScripture.lossBodyWithWords", {
                  count: pendingLoss.lostWords.length,
                  ref: pendingLoss.ref,
                  words: pendingLoss.lostWords.slice(0, 6).join(", "),
                })
              : t("flowScripture.lossBody", {
                  count: pendingLoss?.lostWords.length ?? 0,
                  ref: pendingLoss?.ref ?? "",
                })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingLoss(null)} sx={{ minHeight: 44 }}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            sx={{ minHeight: 44 }}
            onClick={() => {
              pendingLoss?.commit();
              setPendingLoss(null);
            }}
          >
            {t("flowScripture.saveAnyway")}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={toast !== null}
        message={toast ?? ""}
        autoHideDuration={1400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        // Phone: clear the viewport-fixed action bar; md+: the bar is in the
        // pane, so the toast sits at the normal offset.
        sx={{ bottom: wide ? 24 : 96 }}
      />
    </Box>
  );
}
