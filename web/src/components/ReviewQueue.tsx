// t2-review: the Notes/Questions review queue, ported faithfully from
// docs/flows/ui/t2-review.html against the app's real data + save machinery.
// Explicit-Save-only; drafts persist via web/src/sync/drafts.ts; saves go
// through the outbox exactly like NoteCard.tsx.
//
// Three bands, per docs/flows/02-architecture.md D1:
//   phone   (<560)  card-at-a-time + a "This verse" bottom sheet + fixed action bar
//   tablet  (560-899) queue rail + hero work card + COLLAPSIBLE verse context
//   desktop (>=900) queue rail + work card + persistent verse-context column
// The tablet band deliberately does NOT reproduce the mockup's own defect
// (docs/flows/05-functional-preview-findings.md §4.3): the rail is narrower so
// the work card stays the hero, and the verse context is collapsed-not-deleted
// rather than being replaced by the phone affordance.
//
// Chapter locks are NOT uniform (findings §2.7, verified in api/src/rows.ts):
//   PATCH  — tn is EXEMPT (rows.ts `if (kind !== "tn")` before the lock check);
//            tq/twl are locked.
//   DELETE — locked for EVERY kind, tn included ("no carve-out for tn here").
//   POST /api/rows — locked (a run will rearrange the row set when it lands).
//   /validate /preserve /hint /trash /restore — no lock check at all.
// The card disables exactly what the server would actually reject — no more.
// Disabling note editing during a run would block writes the server accepts.
//
// 428 is a client bug, not a merge case (findings §2.3): it means we sent a
// write with no If-Match. It is logged, the chapter is re-read, and the write
// is retried once — the merge prompt is never shown for it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { TopBar } from "./TopBar";
import { QuoteBuilderPopper } from "./QuoteBuilderPopper";
import { collectStrongs } from "./HebrewLine";
import { FlowActionBar } from "./flows/FlowActionBar";
import { LockBanner } from "./flows/FlowBanners";
import { FlowStatusChip } from "./flows/FlowStatusChip";
import { ReviewRail, railItemsFromRows } from "./flows/ReviewRail";
import { ReviewContextPanel } from "./flows/ReviewContextPanel";
import { versionLabel } from "../lib/versionLabels";
import { ReviewSourceStrip } from "./flows/ReviewSourceStrip";
import { ReviewHistoryDialog } from "./flows/ReviewHistoryDialog";
import { ReviewConflictDialog } from "./flows/ReviewConflictDialog";
import { ReviewQuestionsGrid } from "./flows/ReviewQuestionsGrid";
import { useChapter } from "../hooks/useChapter";
import { useLayoutBand } from "../hooks/useLayoutBand";
import { useLexicon } from "../hooks/useLexicon";
import { useNoteTemplates } from "../hooks/useNoteTemplates";
import { useProjectConfig } from "../hooks/useProjectConfig";
import { useUnsavedGuard } from "../hooks/useUnsavedGuard";
import { outbox, onOutboxResult, type OutboxOp } from "../sync/outbox";
import { drafts, rowKey, type DraftRecord } from "../sync/drafts";
import {
  buildVerseIndex,
  coveredLaneSlices,
  noteCoveredVerses,
  verseObjectsOf,
} from "../lib/verseRange";
import { buildTnQuickRequest } from "../lib/tnQuickRequest";
import { isApprovableRow } from "../lib/reviewApproval";
import { buildQuoteFromSelection, selectionFromQuote } from "../lib/quoteBuilder";
import { shortSupport } from "../lib/supportReference";
import type { HighlightKey } from "../lib/highlight";
import { SCRIPTURE_FONT_STACK } from "../theme";
import i18n from "../i18n";
import {
  api,
  ApiError,
  type ChapterLockedBody,
  type TnRow,
  type TqRow,
} from "../sync/api";

type RowKindTQ = "tn" | "tq";
type QueueRow = TnRow | TqRow;

export interface ReviewQueueProps {
  book: string;
  chapter: number;
  onNavigate: (book: string, chapter: number, verse?: number) => void;
}

// TnRow.note / TqRow.response come across with literal "\n" escape sequences
// (see the source TSV format) rather than real newlines.
function unescapeNewlines(text: string | null | undefined): string {
  return (text ?? "").replace(/\\n/g, "\n");
}

// i18n keys for the row fields this screen can patch — the map stores KEY
// NAMES, not display text, so it stays language-independent at module scope.
// Anything unmapped falls back to the raw column name rather than being
// silently prettified into something that might not match what the API
// actually changed. `lower` is the sentence-inline form, supplied as its own
// key rather than produced by lower-casing a translated string.
const FIELD_LABEL_KEYS: Record<string, { label: string; lower: string }> = {
  note: { label: "flowReview.field.note", lower: "flowReview.fieldLower.note" },
  question: { label: "flowReview.field.question", lower: "flowReview.fieldLower.question" },
  response: { label: "flowReview.field.response", lower: "flowReview.fieldLower.response" },
  quote: { label: "flowReview.field.quote", lower: "flowReview.fieldLower.quote" },
  occurrence: { label: "flowReview.field.occurrence", lower: "flowReview.fieldLower.occurrence" },
  verse: { label: "flowReview.field.verse", lower: "flowReview.fieldLower.verse" },
  ref_raw: { label: "flowReview.field.refRaw", lower: "flowReview.fieldLower.refRaw" },
  sort_order: { label: "flowReview.field.sortOrder", lower: "flowReview.fieldLower.sortOrder" },
};

function fieldLabel(t: TFunction, field: string): string {
  const entry = FIELD_LABEL_KEYS[field];
  return entry ? t(entry.label) : field;
}

function fieldLabelLower(t: TFunction, field: string): string {
  const entry = FIELD_LABEL_KEYS[field];
  return entry ? t(entry.lower) : field;
}

// "quote", "quote and occurrence" — names what conflicted, nothing more.
function joinFieldLabels(t: TFunction, labels: string[]): string {
  if (labels.length === 0) return t("flowReview.common.queuedFallback");
  if (labels.length === 1) return labels[0];
  return t("flowReview.common.listAnd", {
    list: labels.slice(0, -1).join(t("flowReview.common.listSeparator")),
    last: labels[labels.length - 1],
  });
}

// Render any patch/row value as display text. Absent stays "" so the dialog can
// show an explicit "(empty)" rather than a blank box.
function displayFieldValue(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? unescapeNewlines(value) : String(value);
}

function refFor(book: string, row: QueueRow): string {
  return row.verse === 0 ? `${book} ${row.chapter} intro` : `${book} ${row.chapter}:${row.verse}`;
}

function stateLabel(
  state: TnRow["translation_state"] | TqRow["translation_state"],
): "draft" | "edited" | "validated" {
  return state === "validated" || state === "edited" ? state : "draft";
}

// Single-use midpoint placement for "insert note after this one". Shell.tsx
// has an equivalent private helper; it isn't exported, and this screen needs
// only the "after" case.
function sortOrderAfter(list: QueueRow[], refId: string): number {
  const idx = list.findIndex((r) => r.id === refId);
  if (idx < 0) return ((list[list.length - 1]?.sort_order ?? list.length * 100) + 100);
  const targetSort = list[idx].sort_order ?? (idx + 1) * 100;
  const nextSort = list[idx + 1]?.sort_order ?? targetSort + 200;
  return (targetSort + nextSort) / 2;
}

export function ReviewQueue({ book, chapter, onNavigate }: ReviewQueueProps) {
  const { t } = useTranslation();
  const { band } = useLayoutBand();
  const isPhone = band === "phone";
  const isDesktop = band === "desktop";

  const projectConfig = useProjectConfig();
  const isAuthoringMode = projectConfig?.mode === "authoring";
  const templateMap = useNoteTemplates();

  const {
    status,
    data,
    refetch,
    applyLocalRowPatch,
    applyLocalRowReplacement,
    applyLocalRowDelete,
    applyLocalRowInsert,
  } = useChapter(book, chapter);

  const [activeKind, setActiveKind] = useState<RowKindTQ>("tn");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const baselineRef = useRef<string>("");
  const hydratedKeyRef = useRef<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const quoteButtonRef = useRef<HTMLButtonElement | null>(null);
  const templateButtonRef = useRef<HTMLButtonElement | null>(null);

  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeSeverity, setNoticeSeverity] = useState<"info" | "warning">("info");
  const [approveAllProgress, setApproveAllProgress] = useState<{ done: number; total: number } | null>(null);
  const [approveAllError, setApproveAllError] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);
  const [chapterLock, setChapterLock] = useState<ChapterLockedBody | null>(null);
  const [draftRecords, setDraftRecords] = useState<DraftRecord[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
  const [gridView, setGridView] = useState(false);
  // Unsaved grid cell edits live HERE rather than inside ReviewQuestionsGrid:
  // the selected tq row's response is edited by both the grid cell and the
  // card's Draft box, and both persist under the same drafts key
  // (rowKey("tq", book, id)). Two independent copies would each write that key
  // and erase the other's typing.
  const [gridEdits, setGridEdits] = useState<
    Record<string, { question?: string; response?: string }>
  >({});
  const gridHydratedRef = useRef<string | null>(null);
  // Last draft payload written per grid row, so a re-run that changed nothing
  // doesn't re-hit IndexedDB.
  const gridDraftWrittenRef = useRef<Record<string, string>>({});
  const [suggesting, setSuggesting] = useState(false);
  const [templateAnchor, setTemplateAnchor] = useState<HTMLElement | null>(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteKeys, setQuoteKeys] = useState<Set<HighlightKey>>(() => new Set());
  const [retargetOpen, setRetargetOpen] = useState(false);
  const [retargetValue, setRetargetValue] = useState("");
  // The 409 body carries ONLY { version, deleted_at } (api/src/rows.ts) — no
  // content, no updated_at. `serverVersion` is everything we learn from it;
  // the row itself has to be re-read (conflictRow) before we can show or adopt
  // "theirs".
  const [conflict, setConflict] = useState<{ op: OutboxOp; serverVersion: number | null } | null>(null);
  const [conflictRow, setConflictRow] = useState<TnRow | TqRow | null>(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  const [conflictError, setConflictError] = useState<string | null>(null);
  // One 428 retry per row, ever. A second means the bug is structural, not a
  // race, and looping on it would just churn the network.
  const retried428Ref = useRef<Set<string>>(new Set());

  const say = useCallback((message: string, severity: "info" | "warning" = "info") => {
    setNotice(message);
    setNoticeSeverity(severity);
  }, []);

  // "404" / "error" — the status token every failure notice interpolates.
  const statusOf = (err: unknown): string =>
    err instanceof ApiError ? String(err.status) : t("flowReview.common.errorWord");

  const rows = useMemo<QueueRow[]>(() => {
    if (!data) return [];
    const list: QueueRow[] = activeKind === "tn" ? data.tn : data.tq;
    return [...list].sort((a, b) => a.verse - b.verse || ((a.sort_order ?? 0) - (b.sort_order ?? 0)));
  }, [data, activeKind]);

  // Keep the selection valid for the active queue — pick the first row when
  // nothing is selected, the selection belonged to the other queue, or the
  // row disappeared (e.g. a peer deleted it).
  useEffect(() => {
    if (rows.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !rows.some((r) => r.id === selectedId)) {
      setSelectedId(rows[0].id);
    }
  }, [rows, selectedId]);

  const selectedIndex = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;

  const fieldName = activeKind === "tn" ? "note" : "response";
  const contentOf = (row: QueueRow): string =>
    unescapeNewlines(activeKind === "tn" ? (row as TnRow).note : (row as TqRow).response);

  // Hydrate the editor when the selection changes: prefer a persisted draft
  // (unsaved typing from this browser), fall back to the row's own content.
  useEffect(() => {
    if (!selectedRow) return;
    const key = rowKey(activeKind, book, selectedRow.id);
    if (hydratedKeyRef.current === key) return;
    hydratedKeyRef.current = key;
    const fallback = contentOf(selectedRow);
    baselineRef.current = fallback;
    setDraftValue(fallback);
    let cancelled = false;
    void drafts.get(key).then((rec) => {
      if (cancelled || hydratedKeyRef.current !== key) return;
      const payload = rec?.payload as
        | { patch?: Record<string, unknown>; baseline?: Record<string, unknown> }
        | undefined;
      const patchVal = payload?.patch?.[fieldName];
      if (typeof patchVal === "string") setDraftValue(unescapeNewlines(patchVal));
      const baselineVal = payload?.baseline?.[fieldName];
      if (typeof baselineVal === "string") baselineRef.current = unescapeNewlines(baselineVal);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRow?.id, activeKind, book]);

  const hasDiff = draftValue !== baselineRef.current;

  // The grid can hold an unsaved `question` for the selected row under the very
  // same drafts key. Read it here so a card keystroke rewrites the record WITH
  // it instead of replacing it and dropping the question the user typed.
  const selectedGridQuestion =
    activeKind === "tq" && selectedRow ? gridEdits[selectedRow.id]?.question : undefined;

  // A trashed note is read-only in this editor (the Draft field below is
  // disabled): trash deliberately discards unsaved text, so nothing may write
  // it back to the store.
  const isTrashed =
    activeKind === "tn" && selectedRow ? (selectedRow as TnRow).trashed_at != null : false;

  // Stash every keystroke to the drafts store (explicit-Save-only: this never
  // triggers a network write on its own). Cleared automatically by drafts.ts
  // once the outbox confirms a save.
  useEffect(() => {
    if (!selectedRow) return;
    // Never re-create the record handleToggleTrash just cleared (#359) — the
    // same guard NoteCard's persist effect gets from `readOnly`.
    if (isTrashed) return;
    const key = rowKey(activeKind, book, selectedRow.id);
    const patch: Record<string, string> = {};
    const baseline: Record<string, string> = {};
    if (draftValue !== baselineRef.current) {
      patch[fieldName] = draftValue;
      baseline[fieldName] = baselineRef.current;
    }
    if (activeKind === "tq" && typeof selectedGridQuestion === "string") {
      const rowQuestion = (selectedRow as TqRow).question ?? "";
      if (selectedGridQuestion !== rowQuestion) {
        patch.question = selectedGridQuestion;
        baseline.question = rowQuestion;
      }
    }
    if (Object.keys(patch).length > 0) {
      void drafts.set(key, { patch, baseline }, selectedRow.version, {
        kind: "row",
        rowKind: activeKind,
        id: selectedRow.id,
        book,
        chapter: selectedRow.chapter,
        verse: selectedRow.verse,
      });
    } else {
      void drafts.clear(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draftValue,
    selectedRow?.id,
    selectedRow?.version,
    activeKind,
    book,
    selectedGridQuestion,
    isTrashed,
  ]);

  // ── grid cell drafts ──────────────────────────────────────────────────────
  // Restore cell edits a previous session left in IndexedDB. Once per chapter;
  // the write effect below owns the store from then on.
  useEffect(() => {
    const hydrationKey = `${book}:${chapter}`;
    if (gridHydratedRef.current === hydrationKey) return;
    // Chapter changed — the old chapter's edits are already persisted and must
    // not leak into this one's rows.
    if (gridHydratedRef.current !== null) setGridEdits({});
    gridHydratedRef.current = hydrationKey;
    gridDraftWrittenRef.current = {};
    let cancelled = false;
    void drafts.list().then((all) => {
      if (cancelled || gridHydratedRef.current !== hydrationKey) return;
      const seeded: Record<string, { question?: string; response?: string }> = {};
      for (const rec of all) {
        if (rec.quarantined) continue;
        const m = rec.meta;
        if (m.kind !== "row" || m.rowKind !== "tq") continue;
        if (m.book !== book || m.chapter !== chapter) continue;
        const patch = (rec.payload as { patch?: Record<string, unknown> } | undefined)?.patch;
        const entry: { question?: string; response?: string } = {};
        // Stored verbatim — the value in `patch` is exactly what a Save would
        // send, so it goes back into the cell as-is (no unescaping: the grid
        // works in the row's own raw domain).
        if (typeof patch?.question === "string") entry.question = patch.question;
        if (typeof patch?.response === "string") entry.response = patch.response;
        if (entry.question !== undefined || entry.response !== undefined) seeded[m.id] = entry;
      }
      // Anything typed while the read was in flight wins.
      if (Object.keys(seeded).length > 0) setGridEdits((prev) => ({ ...seeded, ...prev }));
    });
    return () => {
      cancelled = true;
    };
  }, [book, chapter]);

  const tqRows = data?.tq;
  // Persist every cell edit, and drop entries that match the server row again —
  // a stale equal-to-server entry would mask a peer's later change. The
  // selected row is skipped: the card effect above owns that key and writes
  // both fields for it.
  useEffect(() => {
    if (!tqRows) return;
    const ids = Object.keys(gridEdits);
    if (ids.length === 0) return;
    const settled: string[] = [];
    for (const id of ids) {
      const row = tqRows.find((r) => r.id === id);
      // Row is gone from the chapter (deleted by us or a peer). Forget the
      // entry; leave any persisted draft alone rather than destroying text.
      if (!row) {
        settled.push(id);
        continue;
      }
      const entry = gridEdits[id];
      const patch: Record<string, string> = {};
      const baseline: Record<string, string> = {};
      for (const field of ["question", "response"] as const) {
        const value = entry[field];
        if (typeof value === "string" && value !== (row[field] ?? "")) {
          patch[field] = value;
          baseline[field] = row[field] ?? "";
        }
      }
      // The card effect owns the selected row's key, and the mirror effect
      // below owns its entry — leave both alone here. (Pruning it would fight
      // the mirror: one deletes the entry, the other puts it straight back.)
      const isSelected = activeKind === "tq" && selectedId === id;
      if (isSelected) continue;
      if (Object.keys(patch).length === 0) {
        settled.push(id);
        delete gridDraftWrittenRef.current[id];
        void drafts.clear(rowKey("tq", book, id));
        continue;
      }
      // This effect re-runs on every card keystroke too (the mirror below
      // touches the map). Skip the IndexedDB write when nothing about this
      // row's draft changed.
      const signature = `${row.version}:${JSON.stringify(patch)}`;
      if (gridDraftWrittenRef.current[id] === signature) continue;
      gridDraftWrittenRef.current[id] = signature;
      void drafts.set(rowKey("tq", book, id), { patch, baseline }, row.version, {
        kind: "row",
        rowKind: "tq",
        id,
        book,
        chapter: row.chapter,
        verse: row.verse,
      });
    }
    if (settled.length > 0) {
      setGridEdits((prev) => {
        const next = { ...prev };
        for (const id of settled) delete next[id];
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }
  }, [gridEdits, tqRows, activeKind, selectedId, book]);

  // The grid cell and the card's Draft box are two views of one value for the
  // selected row's response, so a card keystroke has to show up in the cell.
  const handleGridEdit = useCallback(
    (id: string, field: "question" | "response", value: string) => {
      if (field === "response" && activeKind === "tq" && id === selectedId) setDraftValue(value);
      setGridEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    },
    [activeKind, selectedId],
  );

  // …and the reverse: mirror the card's text back into the edit map. Without
  // this, switching to Notes (or to another row) hands the key to the effect
  // above, which would rewrite it from the map alone and drop the response the
  // user typed in the card box.
  // It also keeps the selected row's entry honest, since the effect that prunes
  // clean entries skips this row: a mirrored response is retracted once the
  // card is back on the server value, and a question that matches the row again
  // (just saved) is dropped so it can't mask a peer's later change.
  useEffect(() => {
    if (activeKind !== "tq" || !selectedRow) return;
    const id = selectedRow.id;
    const rowQuestion = (selectedRow as TqRow).question ?? "";
    setGridEdits((prev) => {
      const cur = prev[id];
      const entry: { question?: string; response?: string } = {};
      if (typeof cur?.question === "string" && cur.question !== rowQuestion) {
        entry.question = cur.question;
      }
      if (hasDiff) entry.response = draftValue;
      const same =
        (cur?.question ?? undefined) === entry.question &&
        (cur?.response ?? undefined) === entry.response;
      if (same) return prev;
      const next = { ...prev };
      if (entry.question === undefined && entry.response === undefined) delete next[id];
      else next[id] = entry;
      return next;
    });
  }, [activeKind, selectedRow, hasDiff, draftValue]);

  // ── "N unsaved" across the whole queue ────────────────────────────────────
  useEffect(() => drafts.subscribe(setDraftRecords), []);
  const chapterDrafts = useMemo(
    () =>
      draftRecords.filter(
        (r) =>
          !r.quarantined &&
          r.meta.kind === "row" &&
          (r.meta.rowKind === "tn" || r.meta.rowKind === "tq") &&
          r.meta.book === book &&
          r.meta.chapter === chapter,
      ),
    [draftRecords, book, chapter],
  );

  // Reload / tab-close guard. Drafts already persist, but a translator who
  // reloads past them still has to notice and re-save; and the card's editor
  // text is React state until its debounce-free draft write lands, so the
  // in-memory dirt has to be part of the signal too.
  const gridDirty = useMemo(() => {
    if (!tqRows) return false;
    return tqRows.some((row) => {
      const entry = gridEdits[row.id];
      if (!entry) return false;
      return (
        (typeof entry.question === "string" && entry.question !== (row.question ?? "")) ||
        (typeof entry.response === "string" && entry.response !== (row.response ?? ""))
      );
    });
  }, [gridEdits, tqRows]);
  useUnsavedGuard(hasDiff || gridDirty);

  function goToFirstUnsaved() {
    const first = chapterDrafts[0];
    if (!first || first.meta.kind !== "row") return;
    const kind = first.meta.rowKind === "tq" ? "tq" : "tn";
    setActiveKind(kind);
    setSelectedId(first.meta.id);
    // The Save button may not exist yet on this render (band/queue switch);
    // focusing on the next frame is enough to land on it once it does.
    requestAnimationFrame(() => saveButtonRef.current?.focus());
  }

  // ── outbox reconciliation: 409 merge, chapter lock, 428 client bug ────────
  useEffect(
    () =>
      onOutboxResult((op, result) => {
        if (op.target.kind !== "row") return;
        if (op.target.book !== book) return;
        if (op.target.rowKind !== "tn" && op.target.rowKind !== "tq") return;

        if (result.kind === "ok") {
          setChapterLock(null);
          return;
        }
        if (result.kind === "conflict") {
          // A 409 is NOT automatically a question for the user. The outbox
          // auto-heals the healable ones — a sort_order-only patch, or one
          // whose fields the peer never touched — by re-arming the op as
          // "pending" (outbox.ts:1029-1036), yet it still notifies listeners
          // with kind "conflict" (outbox.ts:1103). Prompting on that would
          // offer "Keep theirs" for an op that is still queued and about to
          // succeed; taking it would drop a live edit (and, for the two-op
          // sort_order swap, half the swap). The op's settled status is the
          // real signal — same test SyncStatusBar.tsx:114 uses.
          if (op.status !== "conflict") return;
          // All the 409 gives us is the version. Open the prompt immediately so
          // the user isn't left wondering why Save went quiet, then re-read the
          // row to fill in what "theirs" actually says.
          const currentBody = result.current as { version?: unknown } | null | undefined;
          const serverVersion =
            currentBody && typeof currentBody.version === "number" ? currentBody.version : null;
          const rowKind = op.target.rowKind as RowKindTQ;
          const id = op.target.id;
          setConflict({ op, serverVersion });
          setConflictRow(null);
          setConflictError(null);
          setConflictLoading(true);
          void (async () => {
            try {
              // There is a GET /api/rows/:kind/:id route (rows.ts:320) but no
              // client method for it in sync/api.ts, so the chapter read is the
              // available way to get the full row.
              const fresh = await api.getChapter(book, chapter);
              const list: QueueRow[] = rowKind === "tn" ? fresh.tn : fresh.tq;
              const row = list.find((r) => r.id === id) ?? null;
              setConflictRow(row);
              if (!row) {
                setConflictError(i18n.t("flowReview.conflictNotice.rowGone"));
              }
            } catch (e) {
              setConflictError(
                i18n.t("flowReview.conflictNotice.readFailed", {
                  status: e instanceof ApiError ? e.status : i18n.t("flowReview.common.errorWord"),
                }),
              );
            } finally {
              setConflictLoading(false);
            }
          })();
          return;
        }
        if (result.kind === "locked") {
          setChapterLock(result.lockBody);
          return;
        }
        if (result.kind === "fatal" && result.reason === "http 428") {
          // Client bug, never a merge prompt (findings §2.3): log it, re-read
          // the row, retry the same write once against the fresh version. The
          // re-read is a direct GET rather than useChapter's refetch because we
          // need the fresh version value here, not on a later render.
          console.error(
            "[ReviewQueue] 428 precondition_required: a row write left without an If-Match header",
            { rowKind: op.target.rowKind, id: op.target.id, patch: op.patch },
          );
          const rowKind = op.target.rowKind as RowKindTQ;
          const id = op.target.id;
          const patch = op.patch;
          // Carry the original op's baseline through the retry — dropping it
          // would disable the 409 auto-heal tier (sync/rowConflict.ts) on the
          // re-sent write.
          const baseline = op.baseline;
          const retryKey = `${rowKind}:${id}`;
          if (retried428Ref.current.has(retryKey)) {
            say(i18n.t("flowReview.queue.preconditionTwice"), "warning");
            return;
          }
          retried428Ref.current.add(retryKey);
          void (async () => {
            try {
              const fresh = await api.getChapter(book, chapter);
              const list: QueueRow[] = rowKind === "tn" ? fresh.tn : fresh.tq;
              const row = list.find((r) => r.id === id);
              if (!row) return;
              await outbox.enqueueRow(rowKind, id, row.version, patch, {
                book,
                ...(baseline !== undefined ? { baseline } : {}),
              });
              await refetch();
            } catch {
              say(i18n.t("flowReview.queue.preconditionRetryFailed"), "warning");
            }
          })();
          return;
        }
        if (result.kind === "fatal") {
          say(i18n.t("flowReview.queue.saveParked", { reason: result.reason }), "warning");
        }
      }),
    // `t` is deliberately NOT a dependency: react-i18next hands out a new `t`
    // on every language change, which would tear down and re-register this
    // outbox subscription (and its in-flight 428 retry) mid-save. The strings
    // above go through i18n.t instead.
    [book, chapter, refetch, say],
  );

  // ── lock gating (findings §2.7 — the lock is NOT uniform) ─────────────────
  const locked = chapterLock !== null;
  const saveLocked = locked && activeKind === "tq"; // tn PATCH is lock-exempt
  // DELETE has NO exemption for any kind — rows.ts runs the lock check before
  // every delete ("no carve-out for tn here"). Gate it exactly like a tq save.
  const deleteLocked = locked;
  const createLocked = locked; // POST /api/rows is locked
  const lockReasonSave = t("flowReview.lock.save");
  const lockReasonDelete = t("flowReview.lock.delete");
  const lockReasonCreate = t("flowReview.lock.create");

  // ── source-language lane (drives the quote strip's label + direction) ─────
  const hasHebrewSource = Boolean(data?.verses?.UHB);
  const sourceLabel = hasHebrewSource ? t("flowTranslate.hebrew") : t("flowTranslate.greek");
  const sourceDir: "ltr" | "rtl" = hasHebrewSource ? "rtl" : "ltr";

  const sourceIndex = useMemo(
    () => buildVerseIndex(data?.verses?.UHB ?? data?.verses?.UGNT),
    [data?.verses],
  );
  const ultIndex = useMemo(() => buildVerseIndex(data?.verses?.ULT), [data?.verses]);
  const ustIndex = useMemo(() => buildVerseIndex(data?.verses?.UST), [data?.verses]);

  const uhbStrongs = useMemo(() => {
    const set = new Set<string>();
    const byVerse = data?.verses?.UHB ?? data?.verses?.UGNT;
    if (byVerse) {
      for (const v of Object.values(byVerse)) {
        const objs = verseObjectsOf(v);
        if (objs) for (const s of collectStrongs(objs)) set.add(s);
      }
    }
    return [...set];
  }, [data?.verses]);
  const lexiconMap = useLexicon(uhbStrongs);

  const sourceVo = selectedRow ? verseObjectsOf(sourceIndex[selectedRow.verse]) : null;
  const ultVo = selectedRow ? verseObjectsOf(ultIndex[selectedRow.verse]) : null;
  const ustVo = selectedRow ? verseObjectsOf(ustIndex[selectedRow.verse]) : null;

  // ── writes ────────────────────────────────────────────────────────────────
  async function handleSave() {
    if (!selectedRow || !hasDiff || saving || saveLocked) return;
    setSaving(true);
    try {
      const patch = { [fieldName]: draftValue };
      const baseline = { [fieldName]: baselineRef.current };
      applyLocalRowPatch(activeKind, selectedRow.id, patch as Partial<TnRow & TqRow>);
      await outbox.enqueueRow(activeKind, selectedRow.id, selectedRow.version, patch, { book, baseline });
      baselineRef.current = draftValue;
    } finally {
      setSaving(false);
    }
  }

  function handleUndo() {
    if (!selectedRow || !hasDiff) return;
    setDraftValue(baselineRef.current);
    say(t("flowReview.queue.reverted"));
  }

  async function handleApprove() {
    if (!selectedRow || approving) return;
    // Never validate a trashed note: it would promote a row the editor already
    // threw away into the nightly context-repo export's few-shot set (see the
    // handleApproveAll comment). The Approve button is disabled for trashed rows;
    // this guards any other path (e.g. keyboard) to the same rule.
    if (activeKind === "tn" && (selectedRow as TnRow).trashed_at != null) return;
    setApproving(true);
    setNotice(null);
    try {
      const updated =
        activeKind === "tn"
          ? await api.validateNote(selectedRow.id, book, true)
          : await api.validateQuestion(selectedRow.id, book, true);
      applyLocalRowReplacement(activeKind, updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        say(t("flowReview.queue.approveNeedsDraft"), "warning");
      } else {
        say(t("flowReview.queue.approveFailed", { status: statusOf(err) }), "warning");
      }
    } finally {
      setApproving(false);
    }
  }

  // Sequential per-row validate calls — there is no bulk-validate endpoint.
  // A per-row failure is skipped, not fatal: the batch runs to the end and a
  // summary of what could not be approved is reported afterwards. The exception
  // is a batch-fatal status (401/403), which stops the loop — see the catch.
  async function handleApproveAll(kind: RowKindTQ) {
    if (!data || approveAllProgress) return;
    const source: QueueRow[] = kind === "tn" ? data.tn : data.tq;
    // Only rows that actually have a draft to validate are approvable (see
    // isApprovableRow): the server refuses to validate a never-drafted row
    // (translation_state IS NULL) or a trashed note, so including those made
    // Approve-all 404 and halt on the first pristine row, and put a number on the
    // button the click could never reach (#238). tq has no trashed_at, so the
    // trashed guard is a no-op there.
    const list = source.filter(isApprovableRow);
    setApproveAllError(null);
    if (list.length === 0) return;
    setApproveAllProgress({ done: 0, total: list.length });
    let approved = 0;
    let firstFailure: { row: QueueRow; status: number | null } | null = null;
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      try {
        const updated =
          kind === "tn"
            ? await api.validateNote(row.id, book, true)
            : await api.validateQuestion(row.id, book, true);
        applyLocalRowReplacement(kind, updated);
        approved += 1;
      } catch (err) {
        // Skip this row and keep going — one rejection (a raced trash, a stale
        // client row, a server guard 404) must never abort the rest of the batch (#238).
        const failStatus = err instanceof ApiError ? err.status : null;
        if (!firstFailure) {
          firstFailure = { row, status: failStatus };
        }
        // ...with one exception: 401 (session dead) and 403 (role refused) are
        // properties of the CALLER, not of this row, so they are certain to repeat
        // for every remaining row. Grinding on would fire hundreds of doomed
        // requests — each 401 also burns its own silent-refresh POST, since
        // refreshAuthOnce() only coalesces *concurrent* callers and this loop is
        // sequential — behind an already-visible session-expired banner. Stop and
        // report how far we got.
        if (failStatus === 401 || failStatus === 403) break;
      }
      setApproveAllProgress({ done: i + 1, total: list.length });
    }
    setApproveAllProgress(null);
    if (firstFailure) {
      const st = firstFailure.status;
      // The validate endpoints are lock-exempt (api/src/rows.ts:1186-1189), so
      // a 409 here can only be workspace_mismatch, which reloads the page —
      // there is no reachable "chapter locked by an AI run" case to hint at.
      const extra = st === 404 ? t("flowReview.queue.approveAllExtraNoDraft") : "";
      setApproveAllError(
        t("flowReview.queue.approveAllPartial", {
          ref: refFor(book, firstFailure.row),
          status: st ?? t("flowReview.common.errorWord"),
          extra,
          approved,
          failed: list.length - approved,
          total: list.length,
        }),
      );
    }
  }

  async function handleAddRow(kind: RowKindTQ) {
    if (createLocked || addPending) return;
    setAddPending(true);
    const verse = selectedRow?.verse ?? 1;
    const ref_raw = verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`;
    try {
      const body: Record<string, unknown> =
        kind === "tn"
          ? { book, chapter, verse, ref_raw, note: "" }
          : { book, chapter, verse, ref_raw, question: "", response: "" };
      const created = await api.createRow<TnRow | TqRow>(kind, body);
      applyLocalRowInsert(kind, created);
      setActiveKind(kind);
      setSelectedId(created.id);
      say(kind === "tn" ? t("flowReview.queue.noteAdded") : t("flowReview.queue.questionAdded"));
    } catch (err) {
      say(t("flowReview.queue.addFailed", { status: statusOf(err) }), "warning");
    } finally {
      setAddPending(false);
    }
  }

  // tq is a hard DELETE (F.3); tn gets the visible, restorable trash (F.1).
  async function handleDeleteQuestion(row: TqRow) {
    if (deleteLocked) return;
    applyLocalRowDelete("tq", row.id);
    await outbox.enqueueDeleteRow("tq", row.id, row.version, book);
    say(t("flowReview.queue.deleted", { ref: refFor(book, row) }));
  }

  async function handleToggleTrash() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    const wasTrashed = row.trashed_at != null;
    try {
      const updated = wasTrashed
        ? await api.restoreNote(row.id, book)
        : await api.trashNote(row.id, book);
      applyLocalRowReplacement("tn", updated);
      if (!wasTrashed) {
        // Trash discards unsaved edits. The trashed row stays selected, so an
        // unsaved draft would otherwise survive the trash (hasDiff stays true;
        // the persist effect re-keys and never clears it) as an orphan that
        // keeps counting toward the "N unsaved" reminder — issue #359, the
        // classic-surface twin of the flows fix in #349/#353. Snap BOTH the
        // editor value and the baseline to server truth — the same derivation
        // the hydration effect uses — so hasDiff drops, the trashed row stops
        // rendering the discarded text as if it were saved (trash doesn't bump
        // the version, so nothing re-hydrates), a later Restore can't leave one
        // keystroke away from saving discarded text, and there's no
        // stale-closure window if the user types while the request is in
        // flight. Then drop the drafts record.
        const next = unescapeNewlines(updated.note);
        setDraftValue(next);
        baselineRef.current = next;
        void drafts.clear(rowKey("tn", book, row.id));
      }
      say(
        wasTrashed
          ? t("flowReview.queue.restoredFromTrash")
          : t("flowReview.queue.movedToTrash"),
      );
    } catch (err) {
      say(t("flowReview.queue.trashFailed", { status: statusOf(err) }), "warning");
    }
  }

  async function handleSetPreserve(value: boolean) {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      applyLocalRowReplacement("tn", await api.setPreserveNote(row.id, book, value));
    } catch {
      say(t("flowReview.queue.preserveFailed"), "warning");
    }
  }

  function handleTogglePreserve() {
    if (!selectedRow || activeKind !== "tn") return;
    void handleSetPreserve(!(selectedRow as TnRow).preserve);
  }

  async function handleToggleHint() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    try {
      applyLocalRowReplacement("tn", await api.setHintNote(row.id, book, !row.hint));
    } catch {
      say(t("flowReview.queue.hintFailed"), "warning");
    }
  }

  // ── tn-only chrome: reorder / insert-after / retarget ─────────────────────
  const verseSiblings = useMemo(
    () => (selectedRow ? rows.filter((r) => r.verse === selectedRow.verse) : []),
    [rows, selectedRow],
  );
  const siblingPos = selectedRow ? verseSiblings.findIndex((r) => r.id === selectedRow.id) : -1;

  function reorderBlockedReason(delta: -1 | 1): string | null {
    if (activeKind !== "tn") return t("flowReview.queue.reorderNotesOnly");
    if (!selectedRow || siblingPos < 0) return t("flowReview.queue.noNoteSelected");
    const other = verseSiblings[siblingPos + delta];
    if (!other) {
      return delta === -1
        ? t("flowReview.queue.alreadyFirst")
        : t("flowReview.queue.alreadyLast");
    }
    if (selectedRow.sort_order == null || other.sort_order == null) {
      return t("flowReview.queue.noSortOrder");
    }
    return null;
  }

  async function handleReorder(delta: -1 | 1) {
    if (!selectedRow || reorderBlockedReason(delta)) return;
    const other = verseSiblings[siblingPos + delta];
    const a = selectedRow.sort_order as number;
    const b = other.sort_order as number;
    // sort_order-only patches are last-write-wins; the outbox auto-heals a 409
    // on them rather than raising a merge prompt (see outbox.ts).
    applyLocalRowPatch("tn", selectedRow.id, { sort_order: b } as Partial<TnRow & TqRow>);
    applyLocalRowPatch("tn", other.id, { sort_order: a } as Partial<TnRow & TqRow>);
    // baseline = each row's pre-swap sort_order, so a 409 raised by an unrelated
    // field can auto-heal (sync/rowConflict.ts) instead of prompting.
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, { sort_order: b }, {
      book,
      baseline: { sort_order: a },
    });
    await outbox.enqueueRow("tn", other.id, other.version, { sort_order: a }, {
      book,
      baseline: { sort_order: b },
    });
    say(t("flowReview.queue.moved"));
  }

  async function handleInsertAfter() {
    if (!selectedRow || activeKind !== "tn" || createLocked) return;
    const ref_raw = selectedRow.verse === 0 ? `${chapter}:intro` : `${chapter}:${selectedRow.verse}`;
    try {
      const created = await api.createRow<TnRow>("tn", {
        book,
        chapter,
        verse: selectedRow.verse,
        ref_raw,
        note: "",
        sort_order: sortOrderAfter(verseSiblings, selectedRow.id),
      });
      applyLocalRowInsert("tn", created, { afterId: selectedRow.id });
      setSelectedId(created.id);
      say(t("flowReview.queue.noteInserted"));
    } catch (err) {
      say(t("flowReview.queue.insertFailed", { status: statusOf(err) }), "warning");
    }
  }

  async function handleRetarget() {
    if (!selectedRow || activeKind !== "tn") return;
    const verse = Number.parseInt(retargetValue, 10);
    if (!Number.isFinite(verse) || verse < 0) {
      say(t("flowReview.queue.enterVerseNumber"), "warning");
      return;
    }
    setRetargetOpen(false);
    const ref_raw = verse === 0 ? `${chapter}:intro` : `${chapter}:${verse}`;
    const patch = { verse, ref_raw };
    const baseline = { verse: selectedRow.verse, ref_raw: selectedRow.ref_raw };
    applyLocalRowPatch("tn", selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, patch, { book, baseline });
    say(t("flowReview.queue.retargeted", { book, chapter, verse }));
  }

  // ── draft toolbar: Suggest (tn-quick) + Template ──────────────────────────
  const suggestBlockedReason = (() => {
    if (activeKind !== "tn") return t("flowReview.queue.suggestNotesOnly");
    if (!selectedRow) return t("flowReview.queue.noNoteSelected");
    const row = selectedRow as TnRow;
    if (!row.support_reference) return t("flowReview.queue.suggestNeedsSupportRef");
    if (!row.quote) return t("flowReview.queue.suggestNeedsQuote");
    return null;
  })();

  async function handleSuggest() {
    if (!data || !selectedRow || activeKind !== "tn" || suggestBlockedReason) return;
    setSuggesting(true);
    try {
      const built = buildTnQuickRequest(selectedRow as TnRow, data);
      if (!built.ok) {
        // The two unalignable-quote reasons need different copy: the
        // "copy the support phrase exactly from ULT" advice only applies
        // when the user typed English (#346).
        const msg =
          built.error.reason === "missing_ult_verse"
            ? t("flowReview.queue.missingUltVerse")
            : built.error.reason === "missing_ust_verse"
              ? t("flowReview.queue.missingUstVerse")
              : built.error.reason === "source_quote_not_found"
                ? t("flowReview.queue.sourceQuoteNotAligned", {
                    label: versionLabel(projectConfig, "ULT"),
                  })
                : built.error.reason === "hebrew_not_found"
                  ? t("flowReview.queue.quoteNotAligned")
                  : t("flowReview.queue.aiPrereqMissing");
        say(msg, "warning");
        return;
      }
      const res = await api.tnQuick(built.request);
      setDraftValue(res.note);
      say(
        res.warnings.length > 0
          ? t("flowReview.queue.aiDraftWithWarnings", { warnings: res.warnings.join(" ") })
          : t("flowReview.queue.aiDraftInserted"),
        res.warnings.length > 0 ? "warning" : "info",
      );
    } catch (err) {
      say(t("flowReview.queue.aiSuggestFailed", { status: statusOf(err) }), "warning");
    } finally {
      setSuggesting(false);
    }
  }

  const templateVariants =
    activeKind === "tn" && selectedRow && (selectedRow as TnRow).support_reference
      ? (templateMap[shortSupport((selectedRow as TnRow).support_reference as string)] ?? [])
      : [];

  function applyTemplate(bodyMd: string) {
    setTemplateAnchor(null);
    setDraftValue((prev) => (prev.trim().length === 0 ? bodyMd : `${prev}\n\n${bodyMd}`));
    say(t("flowReview.queue.templateInserted"));
  }

  // ── quote builder ─────────────────────────────────────────────────────────
  function openQuoteBuilder() {
    if (!selectedRow || activeKind !== "tn") return;
    const row = selectedRow as TnRow;
    setQuoteKeys(selectionFromQuote(sourceVo, row.quote, row.occurrence));
    setQuoteOpen(true);
  }

  async function commitQuote() {
    if (!selectedRow || activeKind !== "tn") return;
    const built = buildQuoteFromSelection(sourceVo, quoteKeys);
    setQuoteOpen(false);
    if (!built) {
      say(t("flowReview.queue.noSourceWords"), "warning");
      return;
    }
    const row = selectedRow as TnRow;
    const patch = { quote: built.quote, occurrence: built.occurrence };
    const baseline = { quote: row.quote, occurrence: row.occurrence };
    applyLocalRowPatch("tn", selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow("tn", selectedRow.id, selectedRow.version, patch, { book, baseline });
    say(t("flowReview.queue.quoteRebuilt"));
  }

  // ── history restore ───────────────────────────────────────────────────────
  async function handleUseVersion(text: string, fromVersion: number) {
    if (!selectedRow) return;
    setHistoryOpen(false);
    const patch = { [fieldName]: text };
    applyLocalRowPatch(activeKind, selectedRow.id, patch as Partial<TnRow & TqRow>);
    await outbox.enqueueRow(activeKind, selectedRow.id, selectedRow.version, patch, {
      book,
      baseline: { [fieldName]: baselineRef.current },
      restoredFromVersion: fromVersion,
    });
    baselineRef.current = text;
    setDraftValue(text);
  }

  // ── 409 merge resolution ──────────────────────────────────────────────────
  // "Mine" comes from our own outbox op. "Theirs" comes from the RE-READ row
  // (conflictRow) — never from the 409 body, which carries only version +
  // deleted_at.
  //
  // A row 409 can arrive for ANY patch this screen enqueues, not just the note
  // text: {quote, occurrence}, {verse, ref_raw} and {sort_order} all go through
  // the same outbox. So the conflicted fields are read off the op's own patch
  // rather than assumed to be note/response.
  const conflictTarget = conflict && conflict.op.target.kind === "row" ? conflict.op.target : null;
  const conflictTextField = conflictTarget?.rowKind === "tq" ? "response" : "note";
  const conflictKeys = conflict ? Object.keys(conflict.op.patch) : [];
  // "Textual" = the note/response text is the ONLY thing that conflicted. Only
  // then is the big two-column text compare (and resetting the editor) honest.
  const isTextConflict =
    conflictKeys.length === 1 && conflictKeys[0] === conflictTextField;
  const conflictTheirs: string | null = conflictRow
    ? unescapeNewlines(
        conflictTextField === "response"
          ? (conflictRow as TqRow).response
          : (conflictRow as TnRow).note,
      )
    : null;
  const conflictFields = conflict
    ? conflictKeys.map((field) => {
        const theirsRaw = conflictRow
          ? (conflictRow as unknown as Record<string, unknown>)[field]
          : undefined;
        return {
          field,
          label: fieldLabel(t, field),
          labelLower: fieldLabelLower(t, field),
          mine: displayFieldValue(conflict.op.patch[field]),
          theirs: conflictRow ? displayFieldValue(theirsRaw) : null,
        };
      })
    : [];
  // Prefer the re-read row's version: if a third write landed between the 409
  // and our read, resolving against the older number would just 409 again.
  const conflictVersion = conflictRow?.version ?? conflict?.serverVersion ?? null;

  function closeConflict() {
    setConflict(null);
    setConflictRow(null);
    setConflictError(null);
    setConflictLoading(false);
  }

  async function keepMine() {
    if (!conflict || conflictVersion == null) {
      closeConflict();
      return;
    }
    await outbox.resolveConflict(conflict.op.id, conflictVersion);
    closeConflict();
    say(t("flowReview.queue.keptMine"));
  }

  async function keepTheirs() {
    // Requires the re-read row: without it we do not know what "theirs" is,
    // and adopting an unknown value would be a guess. The dialog disables the
    // button in that state; this is the matching guard.
    if (!conflict || !conflictRow) return;
    const op = conflict.op;
    const theirsText = conflictTheirs ?? "";
    const textual = isTextConflict;
    await outbox.drop(op.id);
    if (op.target.kind === "row") {
      const kind = op.target.rowKind === "tq" ? "tq" : "tn";
      applyLocalRowReplacement(kind, conflictRow);
      // The drafts store and the editor state belong to the note/response text
      // ONLY. Clearing them for a quote / retarget / reorder conflict would
      // throw away unsaved typing that had nothing to do with the conflict.
      if (textual) {
        void drafts.clear(rowKey(op.target.rowKind, book, op.target.id));
        if (selectedRow?.id === op.target.id && activeKind === kind) {
          baselineRef.current = theirsText;
          setDraftValue(theirsText);
        }
      }
    }
    closeConflict();
    say(
      textual
        ? t("flowReview.queue.keptTheirs")
        : t("flowReview.queue.discardedMine", {
            fields: joinFieldLabels(
              t,
              conflictFields.map((f) => f.labelLower),
            ),
          }),
    );
  }

  function goCard(delta: number) {
    if (rows.length === 0) return;
    const pos = selectedIndex === -1 ? 0 : selectedIndex;
    setSelectedId(rows[(pos + delta + rows.length) % rows.length].id);
  }

  // ── render gates (every hook above this line, unconditionally) ────────────
  if (status === "idle" || status === "loading") {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
        <Stack alignItems="center" justifyContent="center" sx={{ flex: 1 }}>
          <CircularProgress />
        </Stack>
      </Stack>
    );
  }
  if (status === "error" || !data) {
    return (
      <Stack sx={{ height: "100%", minHeight: 0 }}>
        <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
        <Box sx={{ p: 3 }}>
          <Alert severity="error">{t("flowScripture.loadError", { book, chapter })}</Alert>
        </Box>
      </Stack>
    );
  }

  // Same filter handleApproveAll uses (isApprovableRow): counting rows the click
  // can never reach — trashed notes, or pristine rows the server won't validate —
  // would put a number on the button that Approve-all can never work down (#238).
  const unapprovedNotes = data.tn.filter(isApprovableRow).length;
  const unapprovedQuestions = data.tq.filter(isApprovableRow).length;
  const rowState = selectedRow ? stateLabel(selectedRow.translation_state) : "draft";
  const chipKind = isTrashed ? "trashed" : rowState === "validated" ? "approved" : rowState;
  // A bridged note/question (ref_raw e.g. "13:26-27") must show every covered
  // verse's scripture, not just its leading verse — the old leading-verse
  // `ultIndex[selectedRow.verse]?.plain_text` lookup silently dropped the rest
  // (issue #388). `coveredLaneSlices` joins the covered verses' plainText and
  // reduces to the single leading verse for the common singleton (and intro
  // rows), so non-bridged rows are unchanged. Mirrors TranslateNotesScreen.
  const coveredVerses = selectedRow ? noteCoveredVerses(selectedRow) : [];
  const ultText = coveredLaneSlices(ultIndex, sourceIndex, coveredVerses).plainText;
  const ustText = coveredLaneSlices(ustIndex, sourceIndex, coveredVerses).plainText;
  const verseTwl = selectedRow ? data.twl.filter((w) => w.verse === selectedRow.verse) : [];
  const sourceQuestion =
    selectedRow && activeKind === "tq" ? ((selectedRow as TqRow).question ?? "") : null;

  const showGrid = isAuthoringMode && activeKind === "tq" && gridView;
  // Card keystrokes are the selected row's response; show them in its cell.
  const gridEditsView =
    activeKind === "tq" && selectedRow && hasDiff
      ? { ...gridEdits, [selectedRow.id]: { ...gridEdits[selectedRow.id], response: draftValue } }
      : gridEdits;
  const contextBody = (
    <ReviewContextPanel
      ultText={ultText}
      ustText={ustText}
      litLabel={versionLabel(projectConfig, "ULT")}
      simLabel={versionLabel(projectConfig, "UST")}
      twl={verseTwl}
      sourceDir={sourceDir}
    />
  );

  const railBlock = (
    <ReviewRail
      activeKind={activeKind}
      items={railItemsFromRows(activeKind, rows, (r) => refFor(book, r))}
      selectedId={selectedId}
      onSelect={setSelectedId}
      unapprovedNotes={unapprovedNotes}
      unapprovedQuestions={unapprovedQuestions}
      onApproveAll={handleApproveAll}
      approveProgress={approveAllProgress}
      approveError={approveAllError}
      onDismissApproveError={() => setApproveAllError(null)}
      onAddRow={handleAddRow}
      addDisabled={createLocked}
      addDisabledReason={lockReasonCreate}
      addPending={addPending}
    />
  );

  const actionButtons = (
    <>
      <Button variant="outlined" onClick={handleUndo} disabled={!hasDiff} sx={{ flex: 1, minHeight: 44 }}>
        {t("common.undo")}
      </Button>
      <Tooltip title={saveLocked ? lockReasonSave : ""}>
        <span style={{ flex: 1, display: "flex" }}>
          <Button
            ref={saveButtonRef}
            variant="outlined"
            onClick={handleSave}
            disabled={!hasDiff || saving || saveLocked}
            sx={{ flex: 1, minHeight: 44 }}
          >
            {saving ? t("flowReview.common.saving") : t("common.save")}
          </Button>
        </span>
      </Tooltip>
      <Tooltip title={isTrashed ? t("flowReview.queue.approveTrashedTooltip") : ""}>
        <span style={{ flex: 1, display: "flex" }}>
          <Button
            variant="contained"
            color="success"
            onClick={handleApprove}
            disabled={approving || isTrashed}
            sx={{ flex: 1, minHeight: 44 }}
          >
            {approving ? t("flowReview.common.approving") : t("common.approve")}
          </Button>
        </span>
      </Tooltip>
    </>
  );

  return (
    <Stack sx={{ height: "100%", minHeight: 0 }}>
      <TopBar book={book} chapter={chapter} showNavigation={false} onNavigate={onNavigate} />
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: isPhone ? 12 : 0 }}>
        {chapterLock && (
          <Box sx={{ px: 2, pt: 1.5 }}>
            <LockBanner
              pipelineType={chapterLock.pipelineType}
              startedAt={chapterLock.startedAt}
              // "Mark notes to keep" SETS preserve — it never un-sets it. The
              // banner's job is to save the note from the sweep, and /preserve
              // is lock-exempt so it works while the run is still going.
              onMarkKeep={
                activeKind === "tn" && selectedRow && !(selectedRow as TnRow).preserve
                  ? () => void handleSetPreserve(true)
                  : undefined
              }
            />
          </Box>
        )}

        <Stack sx={{ px: 2, pt: 2 }} direction="row" alignItems="center" spacing={2} flexWrap="wrap">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={activeKind}
            onChange={(_e, val: RowKindTQ | null) => {
              if (val) setActiveKind(val);
            }}
          >
            <ToggleButton value="tn">{t("flowReview.queue.tabNotes")}</ToggleButton>
            <ToggleButton value="tq">{t("flowReview.queue.tabQuestions")}</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {notice && (
          <Box sx={{ px: 2, pt: 1.5 }}>
            <Alert severity={noticeSeverity} onClose={() => setNotice(null)}>
              {notice}
            </Alert>
          </Box>
        )}

        <Box
          sx={{
            display: "grid",
            gap: 2,
            p: 2,
            maxWidth: 1320,
            mx: "auto",
            alignItems: "start",
            gridTemplateColumns: isDesktop
              ? "240px minmax(0, 1fr) 320px"
              : band === "tablet"
                ? // Deliberately narrower than the mockup's 220px/0.85fr rail:
                  // findings §4.3 measured that at 43% of a 560px viewport,
                  // leaving the hero card ~296px. 180px keeps the work card the
                  // hero D1 asks for.
                  "180px minmax(0, 1fr)"
                : "minmax(0, 1fr)",
          }}
        >
          {!isPhone && railBlock}

          {/* Work column */}
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1.25 }}>
              <Typography variant="body2" fontWeight={600} color="text.secondary">
                {rows.length === 0
                  ? t("flowScripture.ofTotal", { n: 0, total: 0 })
                  : t("flowScripture.ofTotal", { n: selectedIndex + 1, total: rows.length })}
              </Typography>
              {chapterDrafts.length > 0 && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={t("flowReview.common.unsavedCount", { count: chapterDrafts.length })}
                  onClick={goToFirstUnsaved}
                  title={t("flowReview.queue.goToFirstUnsaved")}
                />
              )}
              <Box sx={{ flex: 1 }} />
              {!isDesktop && (
                <Button size="small" variant="outlined" onClick={() => (isPhone ? setSheetOpen(true) : setContextOpen((v) => !v))}>
                  {t("flowReview.queue.thisVerse")}
                </Button>
              )}
              {isAuthoringMode && activeKind === "tq" && (
                <Button
                  size="small"
                  variant="outlined"
                  aria-pressed={gridView}
                  onClick={() => setGridView((v) => !v)}
                >
                  {gridView ? t("flowReview.queue.cardView") : t("flowReview.queue.gridView")}
                </Button>
              )}
              <Button
                size="small"
                variant="outlined"
                onClick={() => setHistoryOpen(true)}
                disabled={!selectedRow}
              >
                {t("flowReview.common.history")}
              </Button>
            </Stack>

            {isPhone && rows.length > 0 && (
              <Stack direction="row" alignItems="center" justifyContent="center" spacing={2} sx={{ mb: 1.5 }}>
                <Button size="small" onClick={() => goCard(-1)} disabled={rows.length <= 1} aria-label={t("flowReview.queue.previousCard")}>
                  ‹
                </Button>
                <Typography variant="body2" color="text.secondary">
                  {t("flowScripture.ofTotal", { n: selectedIndex + 1, total: rows.length })}
                </Typography>
                <Button size="small" onClick={() => goCard(1)} disabled={rows.length <= 1} aria-label={t("flowReview.queue.nextCard")}>
                  ›
                </Button>
              </Stack>
            )}

            {showGrid && (
              <ReviewQuestionsGrid
                rows={rows as TqRow[]}
                refFor={(r) => refFor(book, r)}
                locked={locked}
                edits={gridEditsView}
                onEditCell={handleGridEdit}
                onSaveRow={(row, patch) => {
                  applyLocalRowPatch("tq", row.id, patch as Partial<TnRow & TqRow>);
                  void outbox.enqueueRow("tq", row.id, row.version, patch, {
                    book,
                    baseline: { question: row.question ?? "", response: row.response ?? "" },
                  });
                  // Saving the selected row from the grid also saves what the
                  // card's Draft box holds (they are one value) — move its
                  // baseline too, or the card stays "dirty" and re-writes the
                  // draft the store is about to clear.
                  if (selectedRow?.id === row.id) baselineRef.current = patch.response;
                }}
                onDeleteRow={(row) => void handleDeleteQuestion(row)}
              />
            )}

            {!selectedRow ? (
              <Alert severity="info">
                {activeKind === "tn"
                  ? t("flowReview.queue.noNotes")
                  : t("flowReview.queue.noQuestions")}
              </Alert>
            ) : (
              <Box
                sx={{
                  border: 1,
                  borderColor: "divider",
                  borderRadius: 1,
                  p: 2,
                  bgcolor: "background.paper",
                  opacity: isTrashed ? 0.75 : 1,
                }}
              >
                <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
                  <Typography variant="overline" color="text.secondary">
                    {activeKind === "tn"
                      ? t("flowReview.queue.kindNote")
                      : t("flowReview.queue.kindQuestion")}
                  </Typography>
                  <FlowStatusChip kind={chipKind} />
                  <Typography variant="caption" color="text.secondary">
                    {refFor(book, selectedRow)}
                  </Typography>
                  <Box sx={{ flex: 1 }} />
                  {activeKind === "tn" && (
                    <Stack direction="row" spacing={0.5}>
                      {([-1, 1] as const).map((delta) => {
                        const reason = reorderBlockedReason(delta);
                        return (
                          <Tooltip
                            key={delta}
                            title={
                              reason ??
                              (delta === -1
                                ? t("flowReview.queue.moveUp")
                                : t("flowReview.queue.moveDown"))
                            }
                          >
                            <span>
                              <Button
                                size="small"
                                variant="outlined"
                                disabled={reason !== null}
                                onClick={() => void handleReorder(delta)}
                                aria-label={
                                  delta === -1
                                    ? t("flowReview.queue.moveUp")
                                    : t("flowReview.queue.moveDown")
                                }
                                sx={{ minWidth: 44, minHeight: 44 }}
                              >
                                {delta === -1 ? "↑" : "↓"}
                              </Button>
                            </span>
                          </Tooltip>
                        );
                      })}
                      <Tooltip
                        title={createLocked ? lockReasonCreate : t("flowReview.queue.insertAfter")}
                      >
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            disabled={createLocked}
                            onClick={() => void handleInsertAfter()}
                            aria-label={t("flowReview.queue.insertAfter")}
                            sx={{ minWidth: 44, minHeight: 44 }}
                          >
                            +
                          </Button>
                        </span>
                      </Tooltip>
                      <Tooltip title={t("flowReview.queue.retargetTitle")}>
                        <span>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => {
                              setRetargetValue(String(selectedRow.verse));
                              setRetargetOpen(true);
                            }}
                            aria-label={t("flowReview.queue.retargetTitle")}
                            sx={{ minWidth: 44, minHeight: 44 }}
                          >
                            ⟳
                          </Button>
                        </span>
                      </Tooltip>
                    </Stack>
                  )}
                </Stack>

                {activeKind === "tn" && (
                  <ReviewSourceStrip
                    label={sourceLabel}
                    dir={sourceDir}
                    quote={(selectedRow as TnRow).quote}
                    occurrence={(selectedRow as TnRow).occurrence}
                    supportReference={(selectedRow as TnRow).support_reference}
                    onBuildFromSource={sourceVo ? openQuoteBuilder : undefined}
                    buildDisabledReason={
                      sourceVo
                        ? t("flowReview.queue.pickSourceWords")
                        : t("flowReview.queue.noSourceVerse", { label: sourceLabel })
                    }
                    buildButtonRef={quoteButtonRef}
                  />
                )}

                {sourceQuestion !== null && (
                  // "Q:" is UI language and keeps the UI direction; the question
                  // is project language, so it is its own dir="auto" element
                  // (content-driven, #256): an Arabic question reads RTL under an
                  // LTR UI (#533). A block flex item, so a multi-line question
                  // keeps one direction across its line breaks.
                  <Box
                    sx={{
                      display: "flex",
                      gap: 0.75,
                      bgcolor: "action.hover",
                      borderRadius: 1,
                      paddingInline: 1.5,
                      paddingBlock: 1,
                      mb: 1.5,
                      whiteSpace: "pre-wrap",
                      fontSize: "0.9rem",
                      textAlign: "start",
                      fontFamily: SCRIPTURE_FONT_STACK,
                    }}
                  >
                    <Box component="span" sx={{ flex: "none" }}>
                      {t("flowReview.queue.questionPrefix")}
                    </Box>
                    <Box component="span" dir="auto" sx={{ flex: 1, minWidth: 0 }}>
                      {sourceQuestion}
                    </Box>
                  </Box>
                )}

                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 1 }}>
                  <Tooltip title={suggestBlockedReason ?? t("flowReview.queue.suggestTooltip")}>
                    <span>
                      <Button
                        size="small"
                        variant="outlined"
                        disabled={suggestBlockedReason !== null || suggesting}
                        onClick={() => void handleSuggest()}
                        sx={{ borderRadius: 999, minHeight: 44 }}
                      >
                        {suggesting
                          ? t("flowReview.queue.drafting")
                          : t("flowReview.queue.suggest")}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip
                    title={
                      activeKind !== "tn"
                        ? t("flowReview.queue.templatesNotesOnly")
                        : templateVariants.length === 0
                          ? t("flowReview.queue.noTemplateForRef")
                          : t("flowReview.queue.insertTemplate")
                    }
                  >
                    <span>
                      <Button
                        ref={templateButtonRef}
                        size="small"
                        variant="outlined"
                        disabled={templateVariants.length === 0}
                        onClick={(e) => setTemplateAnchor(e.currentTarget)}
                        sx={{ borderRadius: 999, minHeight: 44 }}
                      >
                        {t("translation.template")}
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>

                <TextField
                  multiline
                  fullWidth
                  minRows={4}
                  label={t("translation.draftLabel")}
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  disabled={saveLocked || isTrashed}
                  // Direction follows the *content* (dir="auto"), as in the
                  // Translate notes/questions editors (#256): an Arabic draft
                  // reads RTL under an LTR UI, English placeholder stays LTR (#533).
                  inputProps={{ dir: "auto", "data-dirty": hasDiff ? "true" : "false" }}
                />

                <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
                  <Chip
                    size="small"
                    label={t("noteCard.preserve")}
                    variant={activeKind === "tn" && (selectedRow as TnRow).preserve ? "filled" : "outlined"}
                    color={activeKind === "tn" && (selectedRow as TnRow).preserve ? "primary" : "default"}
                    onClick={activeKind === "tn" ? handleTogglePreserve : undefined}
                    disabled={activeKind !== "tn"}
                    title={activeKind !== "tn" ? t("flowReview.queue.preserveNotesOnly") : undefined}
                  />
                  <Chip
                    size="small"
                    label={t("noteCard.hint")}
                    variant={activeKind === "tn" && (selectedRow as TnRow).hint ? "filled" : "outlined"}
                    color={activeKind === "tn" && (selectedRow as TnRow).hint ? "primary" : "default"}
                    onClick={activeKind === "tn" ? handleToggleHint : undefined}
                    disabled={activeKind !== "tn"}
                    title={activeKind !== "tn" ? t("flowReview.queue.hintNotesOnly") : undefined}
                  />
                  {activeKind === "tn" ? (
                    <Chip
                      size="small"
                      label={isTrashed ? t("flowReview.queue.restore") : t("flowReview.queue.trash")}
                      variant={isTrashed ? "filled" : "outlined"}
                      onClick={handleToggleTrash}
                      title={
                        isTrashed
                          ? t("flowReview.queue.restoreTooltip")
                          : t("flowReview.queue.trashTooltip")
                      }
                    />
                  ) : (
                    <Chip
                      size="small"
                      label={t("common.delete")}
                      color="error"
                      variant="outlined"
                      disabled={deleteLocked}
                      onClick={
                        deleteLocked ? undefined : () => void handleDeleteQuestion(selectedRow as TqRow)
                      }
                      title={
                        deleteLocked
                          ? lockReasonDelete
                          : t("flowReview.queue.deleteQuestionTooltip")
                      }
                    />
                  )}
                </Stack>

                {!isPhone && (
                  <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
                    {actionButtons}
                  </Stack>
                )}
              </Box>
            )}

            {/* Tablet: verse context stays available, collapsed — it is NOT
                replaced by the phone sheet (findings §4.3). */}
            {band === "tablet" && selectedRow && (
              <Collapse in={contextOpen}>
                <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, mt: 2 }}>
                  <Typography variant="overline" color="text.secondary">
                    {t("flowReview.queue.thisVerse")}
                  </Typography>
                  <Box sx={{ mt: 1 }}>{contextBody}</Box>
                </Box>
              </Collapse>
            )}
          </Box>

          {/* Desktop: persistent verse-context column */}
          {isDesktop && selectedRow && (
            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                borderRadius: 1,
                p: 1.5,
                position: "sticky",
                top: 8,
                maxHeight: "78vh",
                overflowY: "auto",
                bgcolor: "background.paper",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                {t("flowReview.queue.thisVerse")}
              </Typography>
              <Box sx={{ mt: 1 }}>{contextBody}</Box>
            </Box>
          )}
        </Box>
      </Box>

      {isPhone && selectedRow && <FlowActionBar>{actionButtons}</FlowActionBar>}

      {/* Phone: "This verse" bottom sheet — read-only context, never a second
          work surface (D1). */}
      <Drawer anchor="bottom" open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <Box sx={{ p: 2, maxHeight: "78vh", overflowY: "auto" }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            {t("flowReview.queue.thisVerseSheet")}
          </Typography>
          {contextBody}
        </Box>
      </Drawer>

      <Menu anchorEl={templateAnchor} open={Boolean(templateAnchor)} onClose={() => setTemplateAnchor(null)}>
        {/* `tpl`, not `t` — the outer `t` is the translation function. */}
        {templateVariants.map((tpl, i) => (
          <MenuItem
            key={`${tpl.type}-${i}`}
            onClick={() => applyTemplate(tpl.body)}
            sx={{ maxWidth: 420 }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600}>
                {tpl.type}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {tpl.body}
              </Typography>
            </Box>
          </MenuItem>
        ))}
      </Menu>

      {selectedRow && (
        <ReviewHistoryDialog
          open={historyOpen}
          kind={activeKind}
          rowId={selectedRow.id}
          book={book}
          currentVersion={selectedRow.version}
          trashed={isTrashed}
          onClose={() => setHistoryOpen(false)}
          onRestoreFromTrash={
            isTrashed
              ? () => {
                  setHistoryOpen(false);
                  void handleToggleTrash();
                }
              : undefined
          }
          onUseVersion={(text, from) => void handleUseVersion(text, from)}
        />
      )}

      <ReviewConflictDialog
        open={conflict !== null}
        kind={conflictTextField === "response" ? "tq" : "tn"}
        fields={conflictFields}
        textual={isTextConflict}
        theirsLoaded={conflictRow !== null}
        theirsVersion={conflictVersion}
        // From the re-read row. The 409 body has no updated_at at all.
        theirsUpdatedAt={conflictRow?.updated_at ?? null}
        loadingTheirs={conflictLoading}
        theirsError={conflictError}
        onKeepMine={() => void keepMine()}
        onKeepTheirs={() => void keepTheirs()}
        onClose={closeConflict}
      />

      <Dialog open={retargetOpen} onClose={() => setRetargetOpen(false)}>
        <DialogTitle>{t("flowReview.queue.retargetTitle")}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            type="number"
            margin="dense"
            label={t("flowReview.queue.retargetFieldLabel", { book, chapter })}
            value={retargetValue}
            onChange={(e) => setRetargetValue(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetargetOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={() => void handleRetarget()}>
            {t("flowReview.queue.retargetAction")}
          </Button>
        </DialogActions>
      </Dialog>

      {selectedRow && activeKind === "tn" && (
        <QuoteBuilderPopper
          open={quoteOpen}
          anchorEl={quoteButtonRef.current}
          book={book}
          chapter={chapter}
          verse={selectedRow.verse}
          uhbVerseObjects={sourceVo}
          ultVerseObjects={ultVo}
          ustVerseObjects={ustVo}
          lexiconMap={lexiconMap}
          selectedKeys={quoteKeys}
          onToggleKey={(key) =>
            setQuoteKeys((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          onSelectKeys={(keys) =>
            setQuoteKeys((prev) => {
              const next = new Set(prev);
              for (const k of keys) next.add(k);
              return next;
            })
          }
          onCancel={() => setQuoteOpen(false)}
          onCommit={() => void commitQuote()}
        />
      )}
    </Stack>
  );
}
