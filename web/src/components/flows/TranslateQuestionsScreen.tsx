// TranslateQuestionsScreen — the translationQuestions queue, built to the
// approved "Translate Questions — Titus 1" mockup and following the patterns
// TranslateNotesScreen established (drafts store, save-then-validate, frozen
// queue, edited-as-chip; one centred column on phones — see the 2026-08-10
// responsive block below for md+).
//
// What differs from the notes screen, and why:
//
//   * TWO target fields per row — `question` and `response`. Each is tapped and
//     edited independently, but they share ONE drafts record (the tq draft key
//     rowKey("tq", book, id) is already shared with ReviewQueue's grid + card,
//     and its payload is a patch carrying whichever of the two fields is dirty).
//     Both fields also share one status chip, because Approve/Not-needed are
//     decisions about the row, not about a field.
//
//   * NO quote highlight in the scripture card. tq rows carry a quote column in
//     the TSV, but the mockup deliberately shows plain ULT/UST here: the
//     translator is comparing a whole question to a whole verse, not a phrase.
//
//   * NO "Not needed" verb, unlike the notes screen. Questions are meant to get
//     CHANGED, not dropped — the goal is full coverage, so a question the
//     translator dislikes is fixed by editing the target text and then approving
//     it. There is exactly one verb: Approve. (This is also the only
//     honest option in the API: tq has POST /rows/tq/:id/validate
//     (api/src/rows.ts:1174) but NO trash/restore — those are tn-only
//     (rows.ts:1220, :1233) — and TqRow has no `trashed_at` field at all
//     (web/src/sync/api.ts:59-82). There is nothing a skip could write.)
//
//   * NO "Redo" button (hidden per Benjamin, 2026-08-07 — it shipped disabled,
//     and a permanently disabled verb earns no screen space). There is no
//     synchronous tq drafting endpoint (no tq-quick analogue of api.tnQuick);
//     questions ARE re-draftable, but only via an async chapter-scoped
//     `translate` pipeline job (Shell.tsx — pipelineStore.start with
//     { pipelineType: "translate", translate: { resourceType: "tq", rowIds } }).
//     If users ask for per-question redo, bring the button back wired to that.
//
//   * Chapter lock: unlike tn, tq PATCH is NOT lock-exempt (api/src/rows.ts:597
//     — the carve-out covers tn only), so a save during an AI run comes back 409
//     locked and is dropped rather than overwritten. /validate IS lock-exempt
//     (rows.ts:1173). The banner therefore says something real here.
//
// ── 2026-08-10 responsive layouts (Benjamin) ─────────────────────────────────
//
// Phone (<900px) is unchanged: one centred column, viewport-fixed Approve bar.
// At md+ (900px — the same breakpoint TranslateWordsScreen and ArticlesScreen
// use) the screen becomes master-detail after the desk-class primitives in
// docs/mockups/desktop-first/_design.css (.desk / .panel): a 1440px centred
// grid with a scrollable list pane (340-380px — the question queue as rows:
// verse ref, question preview, status chip) on the inline-start side and a
// panel-chromed detail pane holding the current card stack, with the Approve
// bar sticky at the pane's bottom instead of fixed to the viewport. Selecting
// a list row moves the SAME cursor the phone Prev/Next buttons drive; from the
// done view it also re-enters review mode, like the done list's own rows (the
// done view's embedded row list is hidden at md+ — the list pane already shows
// it). Logical properties only — the grid order itself flips under RTL.
//
// ── 2026-08-10 nav additions (Benjamin) ──────────────────────────────────────
//
// Prev/Next lives at the top AND the bottom: compact icon-only chevrons sit in
// the topbar beside the "N of M" count (both widths), driving the SAME cursor
// as the bottom Previous/Next buttons with the same disabled logic. The card
// stack is also swipeable (useSwipeNav) — the handlers are spread on the phone
// column and the md+ detail pane; swipe direction follows the TARGET language's
// reading direction (the content being paged), and the hook itself ignores
// touches that start in inputs, textareas, or [data-no-swipe].
//
// 409 handling is deliberately minimal, as on the notes screen: a banner saying
// another editor changed the row, with a reload affordance.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlowHeader, PHONE_COUNT_SX, PHONE_TITLE_SX } from "./FlowHeader";
import { useTranslation } from "react-i18next";
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
import SaveIcon from "@mui/icons-material/Save";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";

import { LockBanner } from "./FlowBanners";
import { FlowStatusChip, type FlowStatusKind } from "./FlowStatusChip";
import { escapeNewlines, isAquiferDraftRow, unescapeNewlines, waitForOp } from "./translateShared";
import { useSwipeNav } from "./useSwipeNav";
import type { FlowScreenContext } from "./types";

import { useBook } from "../../hooks/useBook";
import { useChapter } from "../../hooks/useChapter";
import { useProjectConfig, isTranslationProject } from "../../hooks/useProjectConfig";
import { useSourceQuestions } from "../../hooks/useSourceQuestions";
import { useUnsavedGuard } from "../../hooks/useUnsavedGuard";
import { resolveSourceRef } from "../../lib/sourceRef";
import {
  buildVerseIndex,
  coveredLaneSlices,
  noteCoveredVerses,
  noteRefLabel,
} from "../../lib/verseRange";
import { realChapters } from "../../lib/bookSummary";
import { resolveFlowChipStatus, flowChipKind, type FlowChipStatus } from "../../lib/flowStatusChip";
import { drafts, rowKey } from "../../sync/drafts";
import { onOutboxResult, outbox } from "../../sync/outbox";
import { api, ApiError, type ChapterLockedBody, type TqRow } from "../../sync/api";
import { SCRIPTURE_FONT_STACK } from "../../theme";

export interface TranslateQuestionsScreenProps extends FlowScreenContext {
  book: string;
  chapter: number;
  // Optional deep-link verse (a manual URL edit, or browser Back/Forward).
  // Seeds the queue cursor to the first queue entry at or after this verse on
  // mount/chapter change, and re-seeks it on any later same-chapter change to
  // this prop (see the dedicated seek effect below) — without rebuilding the
  // queue. Mirrors TranslateNotesScreen's `verse`.
  verse?: number;
  // Optional deep-link row id (#/questions/{book}/{ch}/{vs}?row={id}) — the
  // SyncStatusBar "N unsaved" jump menu sends it so the cursor lands on the
  // exact question holding the draft, not just the verse's first card. When the
  // id isn't in the queue (a stale link) the verse seek still applies. Mirrors
  // TranslateNotesScreen's `rowId`.
  rowId?: string;
}

// A card finishes exactly one way: approved. "Edited" is a chip, not a terminal
// state — editing a draft does not approve it.
type CardStatus = "approved";

// The two editable target fields on a tq row.
type Field = "question" | "response";
const FIELDS: Field[] = ["question", "response"];

// Content width — the mockup's 430px phone shell, given a little more room.
const COLUMN_PX = 480;

// Shared with QaPair below and with the queue-row previews further down this
// file — no theme/state dependency, so it's a plain module constant rather
// than something threaded through props.
const langTagSx = {
  display: "block",
  fontSize: "0.656rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "text.secondary",
  m: 0,
};

interface QaPairProps {
  field: Field;
  sourceText: string | null;
  value: string;
  editing: boolean;
  // md+ vs phone: governs both the reveal-scroll behavior below and (via the
  // caller) whether the on-screen-keyboard focus mode applies at all.
  wide: boolean;
  targetLabel: string;
  sourceLangLabel: string;
  translationMode: boolean;
  hasSourceProjection: boolean;
  chipKind: FlowStatusKind;
  chipLabel: string;
  hl: string;
  inspire: string;
  // Disables the Save button while a save/approve is in flight (parent's `busy`).
  saving: boolean;
  onChange: (value: string) => void;
  onStartEdit: () => void;
  onDone: () => void;
}

// One field pair: the source line (quiet, read-only) directly above the
// target line (normal ink, tap-to-edit) — grouped by FIELD, so the eye never
// crosses a language boundary between two different fields.
//
// Hoisted to module scope (2026-08-15, mobile polish fix): this used to be
// declared inside TranslateQuestionsScreen's body, which meant every parent
// render (i.e. every keystroke, since typing calls the parent's setValues)
// created a NEW QaPair function identity, so React unmounted/remounted the
// whole subtree on every character — losing focus, caret position, and IME
// composition state, and re-firing the focus/scroll effect below on every
// keystroke instead of once per edit session. All parent-closure state it
// used to read directly is now threaded through as explicit props.
function QaPair({
  sourceText,
  value,
  editing,
  wide,
  targetLabel,
  sourceLangLabel,
  translationMode,
  hasSourceProjection,
  chipKind,
  chipLabel,
  hl,
  inspire,
  saving,
  onChange,
  onStartEdit,
  onDone,
}: QaPairProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Entering edit mode focuses the textarea without letting the browser's own
  // autoFocus scroll fire mid-keyboard-open (which, combined with the
  // same-frame height change on phones, loses the user's place); we drive the
  // scroll ourselves, a frame later, once layout has settled.
  //
  // Scroll policy differs by width: at md+ (wide) there's no on-screen
  // keyboard to fight, so this only needs to reveal the field if it's off
  // screen ("nearest", matching the old autoFocus reveal behavior — desktop
  // is otherwise untouched). On phone, the keyboard hasn't necessarily
  // finished opening (and resizing the viewport) by the first rAF, so we
  // center once now AND register a one-shot visualViewport 'resize' listener
  // that re-centers when the keyboard finishes animating in — removed after
  // it fires once, or after 1500ms if it never does.
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus({ preventScroll: true });
    const raf = requestAnimationFrame(() => {
      containerRef.current?.scrollIntoView({ block: wide ? "nearest" : "center" });
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const vv = !wide && typeof window !== "undefined" ? window.visualViewport : null;

    function cleanupVv() {
      if (vv) vv.removeEventListener("resize", handleResize);
      if (timeoutId) clearTimeout(timeoutId);
    }
    function handleResize() {
      containerRef.current?.scrollIntoView({ block: "center" });
      cleanupVv();
    }
    if (vv) {
      vv.addEventListener("resize", handleResize);
      timeoutId = setTimeout(cleanupVv, 1500);
    }

    return () => {
      cancelAnimationFrame(raf);
      cleanupVv();
    };
  }, [editing, wide]);
  return (
    <Box>
      <Box
        sx={{
          bgcolor: "action.hover",
          borderRadius: "9px",
          paddingBlock: 1,
          paddingInline: 1.25,
          mb: 1,
        }}
      >
        <Box component="span" sx={langTagSx}>
          {sourceLangLabel}
        </Box>
        {sourceText ? (
          <Typography
            sx={{ color: "text.secondary", fontSize: "0.94rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}
          >
            {sourceText}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {translationMode
              ? hasSourceProjection
                ? t("flowQuestions.noSourceForQuestion")
                : t("flowQuestions.noSourceRepo")
              : t("flowQuestions.authoringNoSource")}
          </Typography>
        )}
      </Box>

      <Box ref={containerRef}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Box component="span" sx={langTagSx}>
            {targetLabel}
          </Box>
          <Box sx={{ ml: "auto" }}>
            <FlowStatusChip kind={chipKind} label={chipLabel} />
          </Box>
        </Stack>

        {editing ? (
          <>
            <TextField
              inputRef={inputRef}
              multiline
              fullWidth
              minRows={3}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              // dir="auto" follows the *content*, not the project language, so
              // English placeholder text renders LTR while genuine Arabic renders
              // RTL — no bidi-mangling of LTR content in an RTL project (#256).
              inputProps={{ dir: "auto" }}
              sx={{
                "& .MuiOutlinedInput-root": {
                  bgcolor: "action.hover",
                  borderRadius: "9px",
                  fontSize: "0.97rem",
                  lineHeight: 1.55,
                },
                "& .MuiOutlinedInput-notchedOutline": {
                  borderWidth: "1.5px",
                  borderColor: inspire,
                },
              }}
            />
            <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1 }}>
              <Button
                disabled={saving}
                onClick={onDone}
                startIcon={<SaveIcon />}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                {t("flowTranslate.save")}
              </Button>
            </Stack>
          </>
        ) : (
          <>
            <Box
              role="button"
              tabIndex={0}
              // Content-driven direction (see the editor TextField above; #256).
              dir="auto"
              onClick={onStartEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onStartEdit();
                }
              }}
              sx={{
                cursor: "text",
                borderRadius: "6px",
                paddingBlock: 0.25,
                paddingInline: 0.5,
                marginBlock: -0.25,
                marginInline: -0.5,
                fontSize: "0.97rem",
                lineHeight: 1.55,
                whiteSpace: "pre-wrap",
                textAlign: "start",
                "&:hover": { background: hl },
              }}
            >
              {value.trim().length > 0 ? (
                value
              ) : (
                <Box component="em" sx={{ color: "text.secondary" }}>
                  {t("flowQuestions.nothingDrafted", { target: targetLabel })}
                </Box>
              )}
            </Box>
            <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
              {t("flowQuestions.tapToEdit")}
            </Typography>
          </>
        )}
      </Box>
    </Box>
  );
}

interface LaneProps {
  label: string;
  text: string | null;
  labelFontFamily: string | undefined;
}

// Read-only scripture reference lane (ULT/UST) shown above a question card.
//
// Hoisted to module scope (2026-08-16, nested-component audit, issue #172):
// same remount-on-every-render risk as the QaPair hoist above — `theme` is
// now an explicit `labelFontFamily` prop instead of a closed-over value.
function Lane({ label, text, labelFontFamily }: LaneProps) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        bgcolor: "action.hover",
        borderRadius: "9px",
        paddingBlock: 1.25,
        paddingInline: 1.5,
        fontFamily: SCRIPTURE_FONT_STACK,
        fontSize: "1.03rem",
        lineHeight: 1.55,
        "& + &": { mt: 1 },
      }}
    >
      <Box component="span" sx={{ ...langTagSx, fontFamily: labelFontFamily, mb: 0.375 }}>
        {label}
      </Box>
      {text != null ? (
        // dir="auto" follows the *content*: Arabic lane text lays out RTL with
        // trailing punctuation on the correct side, English stays LTR.
        <Box component="span" dir="auto" sx={{ display: "block", textAlign: "start" }}>
          {text}
        </Box>
      ) : (
        <Box component="em" sx={{ color: "text.secondary", fontSize: "0.875rem" }}>
          {t("flowQuestions.noLaneText", { label })}
        </Box>
      )}
    </Box>
  );
}

export default function TranslateQuestionsScreen({
  book,
  chapter,
  verse,
  rowId,
}: TranslateQuestionsScreenProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  // --hl from docs/flows/ui/_tokens.css: the ground the "Edited" chip and the
  // tap-to-edit hover share.
  const HL = dark ? "rgba(49, 173, 227, 0.26)" : "rgba(49, 173, 227, 0.18)";
  const INSPIRE = "#31ADE3";
  const INSPIRE_DEEP = "#1B84B8";
  const ACCENT = dark ? INSPIRE : INSPIRE_DEEP;
  // .ref in the mockup: Ocean in light, Cultivate in dark.
  const REF_COLOR = dark ? "#70C9CC" : "#014263";
  const { ok, skip } = theme.palette.flows;
  // md+ (>=900px, the words screen's breakpoint): master-detail side by side
  // instead of the phone's single centred column.
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  // Phone (<560): the title row shares one bar with the account controls
  // (#299), so it shows the passage reference instead of the long title and
  // drops secondary icons (#517).
  const isTabletUp = useMediaQuery(theme.breakpoints.up("tablet"));
  // Chevron glyphs don't flip with CSS direction on their own — mirror them
  // under RTL so "previous"/"next" keep pointing the right way (the scripture
  // screen's chevronFlip pattern).
  const chevronFlip = theme.direction === "rtl" ? { transform: "scaleX(-1)" } : undefined;

  const projectConfig = useProjectConfig();
  const translationMode = isTranslationProject(projectConfig);
  const targetLabel = projectConfig?.languageName || t("flowQuestions.targetFallback");
  // Reading direction of the TARGET text — what swipe paging follows (the
  // content being paged, not the UI chrome; ScriptureColumn's targetRtl idiom).
  const targetRtl = projectConfig?.direction === "rtl";
  const litLabel = projectConfig?.litLabel || "ULT";
  const simLabel = projectConfig?.simLabel || "UST";
  const sourceLangLabel = (
    projectConfig?.translationSource?.languageCode ?? "en"
  ).toUpperCase();

  // The English source question/answer live in the PUBLISHED source repo, not in
  // D1: in a translation-mode workspace the row's OWN question/response ARE the
  // target being drafted (useSourceQuestions.ts:3-7; ResourceColumn.tsx:376-380
  // wires it exactly this way). Null projection = no tQ source configured → the
  // source lines degrade to a plain statement rather than echoing the target.
  const sourceProjection = useMemo(
    () => resolveSourceRef(projectConfig?.translationSource, "tq"),
    [projectConfig],
  );
  const sourceQuestions = useSourceQuestions(translationMode ? book : null, sourceProjection);

  const { status, data, refetch, applyLocalRowPatch, applyLocalRowReplacement } = useChapter(
    book,
    chapter,
  );
  const { summary } = useBook(book, true);
  const chapterCount = summary ? realChapters(summary).length : null;

  // ── queue ────────────────────────────────────────────────────────────────
  // Frozen once per chapter so the denominator ("3 of 8") and the progress bar
  // stay stable while the translator works.
  const chapterKey = `${book}:${chapter}`;
  const [queue, setQueue] = useState<{ key: string; ids: string[] } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({});
  const [editedIds, setEditedIds] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<"cards" | "done">("cards");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    if (!data || data.book !== book || data.chapter !== chapter) return;
    if (queue?.key === chapterKey) return;
    const ordered = [...data.tq].sort(
      (a, b) => a.verse - b.verse || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    const seed: Record<string, CardStatus> = {};
    for (const r of ordered) if (r.translation_state === "validated") seed[r.id] = "approved";
    const firstOpen = ordered.findIndex((r) => !seed[r.id]);
    setQueue({ key: chapterKey, ids: ordered.map((r) => r.id) });
    setStatuses(seed);
    setEditedIds(new Set());
    const rowIdx = rowId != null ? ordered.findIndex((r) => r.id === rowId) : -1;
    if (rowIdx >= 0) {
      // An exact question id wins over the verse seek — several questions can
      // share a verse, and the id names the one the deep link (e.g. the
      // "N unsaved" jump menu) actually meant. Mirrors TranslateNotesScreen.
      setCursor(rowIdx);
    } else if (verse != null) {
      // A verse past the last question's verse has no >= match (-1); clamp to
      // the last card rather than falling back to index 0.
      const seekIdx = ordered.findIndex((r) => r.verse >= verse);
      setCursor(seekIdx < 0 ? (ordered.length > 0 ? ordered.length - 1 : 0) : seekIdx);
    } else {
      setCursor(firstOpen < 0 ? 0 : firstOpen);
    }
    // A deep-linked verse or question always lands on the card view, even when
    // every question is already approved — "done" would otherwise discard the
    // requested target.
    setView(verse != null || rowIdx >= 0 ? "cards" : ordered.length > 0 && firstOpen < 0 ? "done" : "cards");
    setReviewing(false);
    // `verse`/`rowId` deliberately not deps beyond this — this effect builds the
    // queue and seeds its cursor once per mount/chapter change (the
    // `queue?.key === chapterKey` guard above). A later same-chapter change to
    // either is handled by the dedicated re-seek effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, book, chapter, queue, chapterKey]);

  const rowById = useMemo(() => {
    const m = new Map<string, TqRow>();
    for (const r of data?.tq ?? []) m.set(r.id, r);
    return m;
  }, [data]);

  const queueIds = queue?.key === chapterKey ? queue.ids : null;
  const total = queueIds?.length ?? 0;
  const currentId = queueIds && cursor < queueIds.length ? queueIds[cursor] : null;
  const row = currentId ? (rowById.get(currentId) ?? null) : null;
  const statusedCount = queueIds ? queueIds.filter((id) => statuses[id]).length : 0;

  // Re-seek the cursor when `verse`/`rowId` change while the queue is already
  // built for the current chapter — e.g. editing the URL from #/questions/RUT/1
  // to #/questions/RUT/1/9, or a second "N unsaved" jump to a different question
  // in the same chapter. Cross-chapter deep links are handled by the queue
  // rebuild above. Guarded on an actual change (via the refs) so it never fires
  // on plain Prev/Next, a status change, or unrelated re-renders. Mirrors the
  // notes screen's re-seek effect; `rowId` wins over `verse`.
  const prevVerseRef = useRef(verse);
  const prevRowIdRef = useRef(rowId);
  useEffect(() => {
    if (prevVerseRef.current === verse && prevRowIdRef.current === rowId) return;
    prevVerseRef.current = verse;
    prevRowIdRef.current = rowId;
    if (!queueIds || queueIds.length === 0) return;
    if (rowId != null) {
      const rowIdx = queueIds.indexOf(rowId);
      if (rowIdx >= 0) {
        setCursor(rowIdx);
        setView("cards");
        return;
      }
    }
    if (verse == null) {
      // The verse segment was dropped (Back/Forward or a manual URL edit).
      // Restore the same no-verse init the queue-build path uses.
      const firstOpen = queueIds.findIndex((id) => !statuses[id]);
      setCursor(firstOpen < 0 ? 0 : firstOpen);
      setView(firstOpen < 0 ? "done" : "cards");
      return;
    }
    const seekIdx = queueIds.findIndex((id) => (rowById.get(id)?.verse ?? -Infinity) >= verse);
    setCursor(seekIdx < 0 ? queueIds.length - 1 : seekIdx);
    setView("cards");
  }, [verse, rowId, queueIds, rowById, statuses]);

  // Question rows in THIS book holding persisted unsaved typing (IndexedDB
  // drafts from this browser). Drives the list pane's "Unsaved" chip so a
  // translator following the top bar's "N unsaved" jump can see exactly which
  // question it meant — the open card's own live diff is covered by hasDiff.
  // Mirrors TranslateNotesScreen's draftRowIds.
  const [draftRowIds, setDraftRowIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // `active` fences the subscription's initial async snapshot: subscribe()
    // fires from a listAll() promise that unsubscribe does NOT cancel, so on a
    // book change the outgoing effect's late snapshot could otherwise mark
    // colliding row ids (ids are only unique per book) Unsaved.
    let active = true;
    const unsub = drafts.subscribe((list) => {
      if (!active) return;
      const ids = new Set<string>();
      for (const d of list) {
        if (d.quarantined) continue;
        if (d.meta.kind === "row" && d.meta.rowKind === "tq" && d.meta.book === book) {
          ids.add(d.meta.id);
        }
      }
      setDraftRowIds(ids);
    });
    return () => {
      active = false;
      unsub();
    };
  }, [book]);

  // ── editor state ─────────────────────────────────────────────────────────
  // One value + one baseline per field; one drafts record for the pair.
  const [values, setValues] = useState<Record<Field, string>>({ question: "", response: "" });
  const baselineRef = useRef<Record<Field, string>>({ question: "", response: "" });
  // "Hydration for this key has started" — set synchronously, guards against
  // re-entering the hydrate branch and against a stale async lookup landing
  // after a newer row change.
  const hydratedKeyRef = useRef<string | null>(null);
  // "Hydration for this key has FULLY settled" (sync setup *and* the async
  // drafts.get() lookup resolved) — deliberately React state, not a ref. See
  // issue #167 and the comment on the hydrate/stash effects below.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editingField, setEditingField] = useState<Field | null>(null);
  // Phone focus mode (2026-08-15, mobile polish): with the on-screen keyboard
  // up there is almost no room, so an active edit on a narrow viewport hides
  // the surrounding chrome (topbar, Approve bar, Prev/Next) and leaves only
  // the scripture/source context cards, the editor, and its Done button.
  // Wide/desktop behavior is untouched — this is always false there.
  const focusMode = !wide && editingField !== null;

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; severity: "info" | "warning" } | null>(null);
  // The row a settled 409 belongs to — not a bare flag. The outbox listener
  // hears every conflict in this book, including leftover ops from earlier
  // sessions or another tab; a flag painted "another editor changed THIS
  // note" on whatever card happened to be open (2026-10-03 report). Keyed by
  // id, the banner shows only on its own card; conflicts on other rows stay
  // in SyncStatusBar's conflict panel, which lists every conflicted op.
  const [conflictRowId, setConflictRowId] = useState<string | null>(null);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);

  const say = useCallback((text: string, severity: "info" | "warning" = "warning") => {
    setNotice({ text, severity });
  }, []);

  // Hydrate both fields on card change: a persisted draft (unsaved typing
  // from this browser) wins over the row's own content.
  //
  // Third issue-#167 fix, this one for React StrictMode (web/src/main.tsx —
  // enabled): on a component's first mount, StrictMode runs this effect,
  // immediately runs its cleanup (cancelled = true), then re-runs the effect
  // body — simulating a fast unmount/remount, dev-only. The re-run used to
  // bail out at `if (hydratedKeyRef.current === nonceKey) return;` alone
  // (already true, set synchronously by the first run) and do nothing else;
  // meanwhile the first run's own drafts.get() eventually resolves but bails
  // at its `cancelled` check, so setSettledKey never fires for that row —
  // the initially-mounted card could never persist a draft, since the stash
  // effect's settledKey guard stayed permanently unmet for it.
  //
  // Fix: only skip entirely once BOTH hydratedKeyRef and settledKey already
  // match this nonceKey. When hydratedKeyRef matches but settledKey doesn't
  // (StrictMode's second invocation, or any other race that left a lookup
  // stranded), skip re-running the *synchronous* setup — values/baseline are
  // already right, no need to reset them — but still start a *fresh*,
  // independently-cancellable lookup. Only one of the two invocations' async
  // callbacks can ever be live (the other's cleanup already flipped its own
  // `cancelled`), so exactly one settles the key; a data-application race
  // between overlapping lookups still can't happen, since that's guarded by
  // each callback's own `cancelled` closure exactly as before. `fallback` is
  // computed unconditionally (cheap, pure) so it's available to the .then()
  // below on either path — it's only the setValues/baselineRef/setEditingField
  // side effects that must not re-run on the retry path.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tq", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (hydratedKeyRef.current === nonceKey && settledKey === nonceKey) return;
    const fallback: Record<Field, string> = {
      question: unescapeNewlines(row.question),
      response: unescapeNewlines(row.response),
    };
    if (hydratedKeyRef.current !== nonceKey) {
      hydratedKeyRef.current = nonceKey;
      baselineRef.current = { ...fallback };
      setValues(fallback);
      setEditingField(null);
    }
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== nonceKey) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      if (payload) {
        const nextValues = { ...fallback };
        const nextBaseline = { ...fallback };
        for (const f of FIELDS) {
          const patchVal = payload.patch?.[f];
          if (typeof patchVal === "string") nextValues[f] = unescapeNewlines(patchVal);
          const baselineVal = payload.baseline?.[f];
          if (typeof baselineVal === "string") nextBaseline[f] = unescapeNewlines(baselineVal);
        }
        baselineRef.current = nextBaseline;
        setValues(nextValues);
      }
      // Mark this key fully settled — sync setup AND the async lookup have
      // both landed — whether or not a persisted draft was found. This is
      // STATE, not a ref: setting it is guaranteed to produce a render/effect
      // pass, so the stash effect below is never left waiting on a pass that
      // depends on some *other* setState call happening to fire too. See
      // issue #167 (three separate bugs fixed by this split and the guard
      // above, all documented here and on the stash effect).
      setSettledKey(nonceKey);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id, book, reloadNonce, settledKey]);

  const dirtyFields = FIELDS.filter((f) => values[f] !== baselineRef.current[f]);
  const hasDiff = dirtyFields.length > 0;

  // Stash every keystroke. Nothing leaves the browser here — the draft store
  // is what makes "no save on blur, no save on unmount" safe. Only the dirty
  // fields go into the patch, matching the shape ReviewQueue writes under
  // this key (ReviewQueue.tsx:390-422) so the two never mis-read each
  // other's records.
  //
  // Guarded on settledKey, not merely on "hydration started" (issue #167,
  // two related bugs found in review):
  //
  // 1. A guard based on a REF that lags one commit behind row?.id (the
  //    original attempt) assumed the hydration effect's setValues always
  //    produces a follow-up render for the lagging ref to catch up on —
  //    which held for this file (setValues always gets a fresh object
  //    literal) but not for TranslateNotesScreen.tsx's plain string state,
  //    so both files were moved off that shape together.
  // 2. A guard based on hydratedKeyRef ALONE (set synchronously the instant
  //    hydration *starts*, the second attempt) is worse: it treats the
  //    hydrate effect's own synchronous setValues(fallback) commit as
  //    "already hydrated," so this effect can run — and call drafts.clear()
  //    — before the async drafts.get() lookup has resolved. Concretely: row
  //    change to B (which has a persisted draft) → hydrate branch sets
  //    baseline=fallback, calls setValues(fallback) (a REAL render, fresh
  //    object) → THIS effect re-runs in the very next commit, sees
  //    values === baseline field-for-field (both "fallback," since the
  //    async lookup hasn't overwritten it yet) → clears the persisted draft
  //    in IndexedDB before it was ever read.
  //
  // settledKey is set only from inside the async lookup's .then(), so it
  // can't go true until the read has actually completed — independent of
  // whichever setState calls happen to fire along the way, in either
  // effect.
  useEffect(() => {
    if (!row) return;
    const key = rowKey("tq", book, row.id);
    const nonceKey = `${key}#${reloadNonce}`;
    if (settledKey !== nonceKey) return;
    const patch: Record<string, string> = {};
    const baseline: Record<string, string> = {};
    for (const f of FIELDS) {
      if (values[f] === baselineRef.current[f]) continue;
      // Sent and stashed in the stored escaped form; see escapeNewlines.
      patch[f] = escapeNewlines(values[f]);
      baseline[f] = escapeNewlines(baselineRef.current[f]);
    }
    if (Object.keys(patch).length > 0) {
      void drafts.set(key, { patch, baseline }, row.version, {
        kind: "row",
        rowKind: "tq",
        id: row.id,
        book,
        chapter: row.chapter,
        verse: row.verse,
      });
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, row?.id, row?.version, book, reloadNonce, settledKey]);

  useUnsavedGuard(hasDiff);

  // ── outbox reconciliation ────────────────────────────────────────────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row" || op.target.rowKind !== "tq" || op.target.book !== book) {
          return;
        }
        if (result.kind === "ok") {
          setChapterLock(null);
          return;
        }
        if (result.kind === "locked") {
          setChapterLock(result.lockBody);
          return;
        }
        // Only a settled conflict is a question for the user: the outbox
        // auto-heals the healable ones and still notifies listeners.
        if (result.kind === "conflict" && op.status === "conflict") {
          setConflictRowId(op.target.id);
        }
      }),
    [book, t],
  );

  // ── scripture context ────────────────────────────────────────────────────
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);

  // A question whose `ref_raw` spans verses ("1:2-3", "1:2,4") must show the
  // text of every verse it covers, not just the leading one — tq refs are
  // free-typed, so ranges are at least as likely here as in tn (#351, same bug
  // as #341). No OL index is passed: tq questions carry no quote, so the lanes
  // render plain text and never need a highlight anchor.
  const coveredVerses = useMemo(() => (row ? noteCoveredVerses(row) : []), [row]);
  const ultText = useMemo(
    () => coveredLaneSlices(ultIndex, undefined, coveredVerses).plainText,
    [ultIndex, coveredVerses],
  );
  const ustText = useMemo(
    () => coveredLaneSlices(ustIndex, undefined, coveredVerses).plainText,
    [ustIndex, coveredVerses],
  );

  const sourceQuestion = row ? (sourceQuestions.get(row.id) ?? null) : null;

  // ── navigation between cards ─────────────────────────────────────────────
  const nextUnstatused = useCallback(
    (from: number, table: Record<string, CardStatus>): number => {
      if (!queueIds) return -1;
      for (let i = 1; i <= queueIds.length; i++) {
        const idx = (from + i) % queueIds.length;
        if (!table[queueIds[idx]]) return idx;
      }
      return -1;
    },
    [queueIds],
  );

  const advanceAfter = useCallback(
    (id: string, next: CardStatus) => {
      if (!queueIds) return;
      const table = { ...statuses, [id]: next };
      if (reviewing) {
        if (cursor >= queueIds.length - 1) setView("done");
        else setCursor(cursor + 1);
        return;
      }
      const nxt = nextUnstatused(cursor, table);
      if (nxt === -1) setView("done");
      else setCursor(nxt);
    },
    [queueIds, statuses, reviewing, cursor, nextUnstatused],
  );

  // Swipe anywhere on the card stack to page between questions — the same
  // cursor and clamping the Prev/Next buttons use. The hook ignores touches
  // that start in inputs/textareas/[data-no-swipe], so editing is unaffected.
  const swipeNav = useSwipeNav({
    onPrev: () => setCursor((c) => Math.max(0, c - 1)),
    onNext: () => setCursor((c) => Math.min(total - 1, c + 1)),
    enabled: view === "cards" && total > 1 && !focusMode,
    rtl: targetRtl,
  });

  // ── writes ───────────────────────────────────────────────────────────────
  // Save-then-validate, in that order and awaited: /validate does not carry a
  // version, so a PATCH that landed after it would demote the row straight back
  // to 'edited' server-side. The outbox stays the only thing that talks to
  // /api/rows — we just wait for its result before approving.
  async function saveDraft(target: TqRow): Promise<boolean> {
    const patch: { question?: string; response?: string } = {};
    const baseline: Record<string, string> = {};
    for (const f of FIELDS) {
      if (values[f] === baselineRef.current[f]) continue;
      // Sent and stashed in the stored escaped form; see escapeNewlines.
      patch[f] = escapeNewlines(values[f]);
      baseline[f] = escapeNewlines(baselineRef.current[f]);
    }
    if (Object.keys(patch).length === 0) return true;
    applyLocalRowPatch("tq", target.id, patch);
    const op = await outbox.enqueueRow("tq", target.id, target.version, patch, { book, baseline });
    const result = await waitForOp(op.id);
    if (result === null) {
      say(t("flowQuestions.editQueued"));
      return false;
    }
    if (result.kind !== "ok") {
      if (result.kind === "conflict") {
        setConflictRowId(target.id);
      } else if (result.kind === "locked") {
        setChapterLock(result.lockBody);
        say(t("flowQuestions.aiRunDropped"));
      } else {
        say(t("flowQuestions.saveFailed", { reason: result.reason }));
      }
      return false;
    }
    baselineRef.current = { ...values };
    setEditedIds((prev) => new Set(prev).add(target.id));
    // Mirror the server's demotion locally so the row object stays consistent
    // with what a refetch will report: a content edit demotes an AI draft or a
    // previously-validated target row to 'edited' (see the CASE in
    // api/src/rows.ts — English-root rows with a NULL state are left untouched,
    // so we must not invent an 'edited' state for them). The Pending chip itself
    // is driven by editedIds too, so it shows this session regardless; this keeps
    // translation_state honest for genuine target rows across a refetch.
    if (target.translation_state === "ai_draft" || target.translation_state === "validated") {
      applyLocalRowPatch("tq", target.id, { translation_state: "edited" });
    }
    // Saving without approving demotes the row, so drop any prior Approved status.
    setStatuses((prev) => {
      if (prev[target.id] === undefined) return prev;
      const next = { ...prev };
      delete next[target.id];
      return next;
    });
    return true;
  }

  // "Save" persists the edit to the server without approving it. Editing a
  // question is not the same as finishing it: a translator can save progress and
  // approve later, and the row then carries the Pending chip. This replaced
  // "Done", which only closed the editor and never touched the server — a close
  // that looked like a save but wasn't. saveDraft persists every dirty field, so
  // one Save from either field commits both.
  async function handleSave() {
    if (!row || busy) return;
    if (!hasDiff) {
      setEditingField(null);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (await saveDraft(row)) {
        setEditingField(null);
        setToast(t("flowTranslate.toastSaved"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!row || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      if (hasDiff && !(await saveDraft(row))) return;
      const updated = await api.validateQuestion(row.id, book, true);
      applyLocalRowReplacement("tq", updated);
      setStatuses((prev) => ({ ...prev, [row.id]: "approved" }));
      setEditingField(null);
      setToast(t("translation.stateApproved"));
      advanceAfter(row.id, "approved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say(t("flowQuestions.approveNeedsDraft"));
      } else {
        say(
          t("flowQuestions.approveFailed", {
            status: err instanceof ApiError ? err.status : t("flowQuestions.genericError"),
          }),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function reloadRow() {
    setConflictRowId(null);
    void refetch().then(() => setReloadNonce((n) => n + 1));
  }

  // ── render gates (every hook above this line, unconditionally) ───────────
  if (status === "error") {
    return (
      <Box sx={{ p: 3, maxWidth: COLUMN_PX, mx: "auto" }}>
        <Alert severity="error">
          {t("flowQuestions.loadError", { book, chapter })}
        </Alert>
      </Box>
    );
  }
  if (!data || !queueIds) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
        <CircularProgress />
      </Stack>
    );
  }

  const done = view === "done";
  // Approved-as-is vs approved-after-editing. Every question ends in one of the
  // two, so the pair sums to the total.
  const approvedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && !editedIds.has(id),
  ).length;
  const editedCount = queueIds.filter(
    (id) => statuses[id] === "approved" && editedIds.has(id),
  ).length;

  // Label copy for a resolved chip status, tq's wording. Precedence lives in
  // resolveFlowChipStatus (#348); this only maps status → tq label. tq has no
  // "skipped" verdict today (kept for exhaustiveness). "aquifer" is a defensive
  // parallel to the notes screen — tq is not an Aquifer target today (#295).
  const questionChipLabel = (status: FlowChipStatus): string => {
    switch (status) {
      case "editing":
        return t("translation.stateEdited");
      case "unsaved":
        return t("flowTranslate.status.unsaved");
      case "approved":
        return t("translation.stateApproved");
      case "skipped":
        return t("flowTranslate.notNeeded");
      case "pending":
        return t("flowTranslate.status.pending");
      case "aquifer":
        return t("flowTranslate.status.aquiferImport");
      case "aiDraft":
        return t("translation.stateAiDraft");
      case "draft":
        return t("translation.draftLabel");
    }
  };
  // One chip for the row — both fields share it, because the decision is about
  // the row and not about a field. Unsaved text (the open card's live diff, or a
  // persisted draft on any other row) wins over the saved verdict (#342): the
  // resolver judges the current row by its live diff and every other row by
  // whether a draft is persisted for it — so a drafted row is never hidden
  // behind "Approved", on desktop OR phone.
  function chipFor(
    id: string,
    rowForChip: TqRow | null,
    isCurrent: boolean,
  ): { kind: FlowStatusKind; label: string } {
    const s = statuses[id];
    const status = resolveFlowChipStatus({
      isCurrent,
      hasLiveDiff: hasDiff,
      draftPresent: draftRowIds.has(id),
      approved: s === "approved",
      skipped: false,
      pending: editedIds.has(id) || rowForChip?.translation_state === "edited",
      aquifer:
        rowForChip?.translation_state === "ai_draft" && isAquiferDraftRow(rowForChip),
      aiDrafted:
        rowForChip?.translation_state === "ai_draft" ||
        rowForChip?.latest_source === "ai_pipeline",
    });
    return { kind: flowChipKind(status), label: questionChipLabel(status) };
  }

  const chip = row
    ? chipFor(row.id, row, true)
    : { kind: "draft" as FlowStatusKind, label: t("translation.draftLabel") };

  const nextChapter = chapter + 1;
  const hasNextChapter = chapterCount === null ? true : nextChapter <= chapterCount;

  const sub = translationMode
    ? t("flowQuestions.subTranslation", { book, chapter, source: sourceLangLabel, target: targetLabel })
    : t("flowQuestions.subAuthoring", { book, chapter, target: targetLabel });

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

  const labelSx = {
    display: "flex",
    alignItems: "center",
    gap: 1,
    fontSize: "0.6875rem",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase" as const,
    color: "text.secondary",
    mb: 1,
  };

  // md+ list pane: one row per question — verse ref, question preview, the
  // row's status chip (the same chipFor the card uses). Selecting a row moves
  // the SAME cursor the phone Prev/Next buttons drive; from the done view it
  // also re-enters review mode, exactly like the done list's own rows.
  const queueRow = (id: string, i: number) => {
    const r = rowById.get(id) ?? null;
    // Unsaved text wins over the saved verdict — the resolver surfaces it as
    // "Unsaved" on any non-open drafted row and "Edited" on the open card's live
    // diff, so a drafted row is never hidden behind "Approved". Mirrors the
    // notes list rows.
    const c = chipFor(id, r, id === currentId);
    const isSelected = !done && id === currentId;
    return (
      <Box
        key={id}
        component="button"
        type="button"
        aria-current={isSelected ? "true" : undefined}
        onClick={() => {
          if (done) {
            setReviewing(true);
            setView("cards");
          }
          setCursor(i);
        }}
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
          <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>
            {r
              ? r.verse === 0
                ? t("flowQuestions.introRef", { book, chapter })
                : // Same range-aware label as the card, so a bridged question
                  // reads "1:2-3" in the list too (#351).
                  `${book} ${noteRefLabel(r)}`
              : id}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {unescapeNewlines(r?.question) || "—"}
          </Typography>
        </Box>
        <FlowStatusChip kind={c.kind} label={c.label} />
        <ChevronRightIcon
          fontSize="small"
          sx={{
            color: "text.secondary",
            flex: "none",
            transform: theme.direction === "rtl" ? "scaleX(-1)" : "none",
          }}
        />
      </Box>
    );
  };

  // The one verb. Phone: fixed to the viewport bottom, as before. md+ pane:
  // sticky at the detail pane's bottom, pinned there by margin-block-start:auto
  // when the content is short — the words screen's pane pattern.
  const actionBar = (pane: boolean) =>
    !done && total > 0 && row ? (
      <Box
        component="footer"
        // Guard the verbs from the swipe surface: a horizontal drag that
        // starts on Approve must never page the queue.
        data-no-swipe
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
            disabled={busy}
            onClick={() => void handleApprove()}
            startIcon={<CheckIcon />}
            sx={{
              flex: 1,
              minHeight: 50,
              borderRadius: "12px",
              fontWeight: 700,
              bgcolor: ok.main,
              color: "#fff",
              "&:hover": { bgcolor: ok.main, filter: "brightness(0.95)" },
            }}
          >
            {t("flowTranslate.saveApprove")}
          </Button>
        </Stack>
      </Box>
    ) : null;

  // The card stack (banners + the current card / done view) is identical at
  // every width — only its container differs (phone: the centred column;
  // md+: the panel-chromed detail pane).
  const columnBody = (
    <>
        {chapterLock && (
          // Unlike notes, tq PATCH is NOT lock-exempt: saves are refused with a
          // 409 while a run holds the chapter. Approve still lands.
          <LockBanner pipelineType={chapterLock.pipelineType} startedAt={chapterLock.startedAt} />
        )}

        {row && conflictRowId === row.id && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" onClick={reloadRow}>
                {t("flowQuestions.reloadQuestion")}
              </Button>
            }
          >
            {t("flowQuestions.conflict")}
          </Alert>
        )}

        {notice && (
          <Alert severity={notice.severity} onClose={() => setNotice(null)}>
            {notice.text}
          </Alert>
        )}

        {total === 0 ? (
          <Alert severity="info">{t("flowQuestions.noQuestions", { book, chapter })}</Alert>
        ) : done ? (
          <>
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
                {t("flowQuestions.reviewedHeading", { book, chapter })}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("flowQuestions.allApproved", { count: total })}
              </Typography>
            </Box>

            <Stack direction="row" spacing={1.25}>
              {[
                { n: approvedCount, label: t("flowQuestions.approvedAsIs"), color: ok.main },
                { n: editedCount, label: t("translation.stateEdited"), color: ACCENT },
                { n: total, label: t("flowQuestions.total"), color: theme.palette.text.secondary },
              ].map((s) => (
                <Box key={s.label} sx={{ ...cardSx, flex: 1, textAlign: "center", paddingInline: 0.75 }}>
                  <Typography
                    component="b"
                    sx={{
                      display: "block",
                      fontSize: "1.5rem",
                      lineHeight: 1.15,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      color: s.color,
                    }}
                  >
                    {s.n}
                  </Typography>
                  <Typography
                    component="span"
                    sx={{ fontSize: "0.75rem", fontWeight: 600, color: "text.secondary", whiteSpace: "nowrap" }}
                  >
                    {s.label}
                  </Typography>
                </Box>
              ))}
            </Stack>

            {/* md+: the list pane already shows exactly these rows */}
            {!wide && (
            <Stack spacing={1.25}>
              {queueIds.map((id, i) => {
                const r = rowById.get(id) ?? null;
                // Same Unsaved-wins precedence as the md+ list pane above — via
                // the shared resolver, so the current row holding a persisted
                // draft is no longer mislabeled "Approved" here (#348 part 2).
                const c = chipFor(id, r, id === currentId);
                return (
                  <Box
                    key={id}
                    component="button"
                    onClick={() => {
                      setReviewing(true);
                      setCursor(i);
                      setView("cards");
                    }}
                    sx={{
                      ...cardSx,
                      display: "flex",
                      alignItems: "center",
                      gap: 1.5,
                      width: "100%",
                      cursor: "pointer",
                      font: "inherit",
                      color: "inherit",
                      "&:hover": { borderColor: INSPIRE },
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600, fontSize: "0.97rem" }}>
                        {r
                          ? r.verse === 0
                            ? t("flowQuestions.introRef", { book, chapter })
                            : `${book} ${noteRefLabel(r)}`
                          : id}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {unescapeNewlines(r?.question) || "—"}
                      </Typography>
                    </Box>
                    <FlowStatusChip kind={c.kind} label={c.label} />
                  </Box>
                );
              })}
            </Stack>
            )}

            <Stack spacing={1} sx={{ mt: 0.5 }}>
              <Button
                variant="contained"
                disabled={!hasNextChapter}
                onClick={() => {
                  location.hash = `#/questions/${book}/${nextChapter}`;
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
                  ? t("flowQuestions.continueToChapter", { chapter: nextChapter })
                  : t("flowQuestions.bookComplete", { book, chapter: nextChapter })}
              </Button>
              <Button
                onClick={() => {
                  setReviewing(true);
                  setCursor(0);
                  setView("cards");
                }}
                sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
              >
                {t("flowQuestions.reviewAgain")}
              </Button>
            </Stack>
          </>
        ) : !row ? (
          <Box sx={cardSx}>
            <Typography variant="body2" color="text.secondary">
              {t("flowQuestions.rowGone")}
            </Typography>
            <Button
              sx={{ mt: 1 }}
              onClick={() => setCursor((c) => Math.min(c + 1, total - 1))}
              disabled={cursor >= total - 1}
            >
              {t("flowQuestions.nextQuestion")}
            </Button>
          </Box>
        ) : (
          <>
            {/* scripture — no quote highlight: tq is a whole-verse question */}
            <Box sx={cardSx}>
              <Typography sx={{ fontSize: "0.875rem", fontWeight: 700, color: REF_COLOR, mb: 0.75 }}>
                {row.verse === 0
                  ? t("flowQuestions.introRef", { book, chapter: row.chapter })
                  : // `ref_raw` is the only place a question's range lives
                    // (tq_rows has no verse_end); noteRefLabel prints it when it
                    // names the span the lanes actually show, else falls back to
                    // chapter:verse (#351).
                    `${book} ${noteRefLabel(row)}`}
              </Typography>
              <Lane label={litLabel} text={ultText} labelFontFamily={theme.typography.fontFamily} />
              <Lane label={simLabel} text={ustText} labelFontFamily={theme.typography.fontFamily} />
            </Box>

            {/* question */}
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                {t("questions.question")}
              </Typography>
              <QaPair
                field="question"
                sourceText={sourceQuestion?.question ?? null}
                value={values.question}
                editing={editingField === "question"}
                wide={wide}
                targetLabel={targetLabel}
                sourceLangLabel={sourceLangLabel}
                translationMode={translationMode}
                hasSourceProjection={sourceProjection !== null}
                chipKind={chip.kind}
                chipLabel={chip.label}
                hl={HL}
                inspire={INSPIRE}
                saving={busy}
                onChange={(v) => setValues((prev) => ({ ...prev, question: v }))}
                onStartEdit={() => setEditingField("question")}
                onDone={() => void handleSave()}
              />
            </Box>

            {/* expected answer */}
            <Box sx={cardSx}>
              <Typography component="p" sx={labelSx}>
                <Box
                  component="span"
                  sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: INSPIRE }}
                />
                {t("flowQuestions.expectedAnswer")}
              </Typography>
              <QaPair
                field="response"
                sourceText={sourceQuestion?.response ?? null}
                value={values.response}
                editing={editingField === "response"}
                wide={wide}
                targetLabel={targetLabel}
                sourceLangLabel={sourceLangLabel}
                translationMode={translationMode}
                hasSourceProjection={sourceProjection !== null}
                chipKind={chip.kind}
                chipLabel={chip.label}
                hl={HL}
                inspire={INSPIRE}
                saving={busy}
                onChange={(v) => setValues((prev) => ({ ...prev, response: v }))}
                onStartEdit={() => setEditingField("response")}
                onDone={() => void handleSave()}
              />
            </Box>

            {/* previous / next — hidden in phone focus mode (keyboard-up
                editing) so the editor gets the room */}
            {!focusMode && (
              <Stack direction="row" justifyContent="space-between" spacing={1.25}>
                <Button
                  startIcon={<ChevronLeftIcon />}
                  disabled={cursor === 0}
                  onClick={() => setCursor((c) => Math.max(0, c - 1))}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  {t("flowQuestions.previous")}
                </Button>
                <Button
                  endIcon={<ChevronRightIcon />}
                  disabled={cursor >= total - 1}
                  onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
                  sx={{ minHeight: 44, color: "text.secondary", fontWeight: 700 }}
                >
                  {t("flowQuestions.next")}
                </Button>
              </Stack>
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
      {/* topbar — rendered into the global flow bar via FlowHeader (#299).
          Hidden in phone focus mode — an active edit on a narrow viewport
          gets the keyboard-constrained screen to itself. */}
      {!focusMode && (
      <FlowHeader>
        <Box sx={{ maxWidth: wide ? 1440 : COLUMN_PX, mx: "auto", paddingInline: isTabletUp ? 2 : 1, paddingBlock: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={isTabletUp ? 1.25 : 0.5}>
            <IconButton
              aria-label={t("flowQuestions.backToPackage", { book })}
              onClick={() => {
                location.hash = `#/package/${book}`;
              }}
              sx={{ bgcolor: skip.soft, width: 34, height: 34, flex: "none" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Box sx={isTabletUp ? { minWidth: 0 } : PHONE_TITLE_SX}>
              <Typography component="h1" sx={{ fontSize: "1.0625rem", fontWeight: 700, m: 0 }}>
                {isTabletUp ? t("flowQuestions.title") : t("common.passageRef", { book, chapter })}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
                {isTabletUp ? sub : t("flowQuestions.title")}
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
                ...(isTabletUp ? {} : PHONE_COUNT_SX),
              }}
            >
              {done
                ? t("flowQuestions.pagerCount", { current: total, total })
                : t("flowQuestions.pagerCount", { current: Math.min(cursor + 1, total), total })}
            </Typography>
            {/* Verse view entry point (#447): jump to the alignment-joined
                verse fidelity surface for the active card's verse. Disabled in
                the done state or on an empty chapter; on an intro question
                (chapter or verse 0) it clamps to verse 1 of that chapter rather
                than no-opping (#453). */}
            {isTabletUp && (
              <IconButton
                size="small"
                aria-label={t("flowQuestions.openVerseView")}
                disabled={!row}
                onClick={() => {
                  if (row) location.hash = `#/verse/${book}/${Math.max(1, row.chapter)}/${Math.max(1, row.verse)}`;
                }}
                sx={{ flex: "none" }}
              >
                <ViewColumnIcon fontSize="small" />
              </IconButton>
            )}
            {/* compact prev/next — the same cursor and disabled logic as the
                bottom Previous/Next buttons */}
            <Stack direction="row" spacing={0.25} sx={{ flex: "none" }}>
              <IconButton
                aria-label={t("flowQuestions.previousQuestion")}
                size="small"
                disabled={done || cursor === 0}
                onClick={() => setCursor((c) => Math.max(0, c - 1))}
              >
                <ChevronLeftIcon fontSize="small" sx={chevronFlip} />
              </IconButton>
              <IconButton
                aria-label={t("flowQuestions.nextQuestion")}
                size="small"
                disabled={done || cursor >= total - 1}
                onClick={() => setCursor((c) => Math.min(total - 1, c + 1))}
              >
                <ChevronRightIcon fontSize="small" sx={chevronFlip} />
              </IconButton>
            </Stack>
          </Stack>
          <Box
            sx={{
              height: 4,
              borderRadius: "2px",
              bgcolor: skip.soft,
              mt: 1.25,
              overflow: "hidden",
            }}
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

      {wide ? (
        /* desk (the words screen's md+ pattern, after the desk-class
           primitives in docs/mockups/desktop-first/_design.css): 1440px
           centred grid — the question queue as a scrollable list pane on the
           inline-start side, a panel-chromed detail pane holding the current
           card stack. Grid column order follows the document direction, so
           this is RTL-safe as-is. */
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
            {queueIds.map(queueRow)}
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
            {/* flex column so the action bar's margin-block-start:auto pins
                it to the pane's bottom even when the content is short */}
            <Box
              {...swipeNav}
              sx={{
                height: "100%",
                minHeight: 0,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <Box
                sx={{
                  flex: "none",
                  paddingInline: 2.5,
                  paddingBlockStart: 2,
                  // the action bar is in-flow below, so only a small gap
                  paddingBlockEnd: 2,
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.5,
                }}
              >
                {columnBody}
              </Box>
              {actionBar(true)}
            </Box>
          </Box>
        </Box>
      ) : (
        <Box
          {...swipeNav}
          sx={{
            maxWidth: COLUMN_PX,
            mx: "auto",
            paddingInline: 2,
            paddingBlockStart: 2,
            // room for the viewport-fixed action bar — collapsed in phone
            // focus mode, where the action bar itself is hidden
            paddingBlockEnd: done ? 4 : focusMode ? 2 : 15,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
          }}
        >
          {columnBody}
        </Box>
      )}

      {!wide && !focusMode && actionBar(false)}

      <Snackbar
        open={toast !== null}
        message={toast ?? ""}
        autoHideDuration={1400}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: wide ? 24 : 96 }}
      />
    </Box>
  );
}
