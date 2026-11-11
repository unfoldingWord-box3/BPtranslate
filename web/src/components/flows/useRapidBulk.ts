// Rapid check bulk actions (issue #829): Approve, Redo with AI and Not needed
// on the notes the translator has checked in NotesRapidCheck. Kept out of
// TranslateNotesScreen so that file only wires it up.
//
// Every bulk action applies the per-row safety rules of the status circle
// (approveOtherRow, #828) to each row: a note with unsaved typing (a draft in
// the store, or the open note's live diff) or any write still in the outbox is
// skipped and reported, never acted on. Rows run one at a time, a failure
// skips that row, and 401/403 stop the run (ReviewQueue.handleApproveAll).
//
// Decisions (see the PR for #829):
// - Approve sends `bulk: true`. A checked range is not a one-at-a-time read of
//   each note, so it keeps any admin_bulk_state stamp (api/src/rows.ts,
//   HAND_APPROVAL_CLAUSE): a stamped row stays out of the AI examples until a
//   person approves it on its own. The open note with an unsaved edit goes
//   through the screen's handleApprove (save, then approve), which is a hand
//   approval like Ctrl+Enter.
// - Approve has no Undo: un-approving sets 'edited', not the state the note
//   had before (validateNote(id, book, false)), so an "Undo" would not undo.
// - Not needed has Undo: trash only sets trashed_at, and restore clears it.
// - Redo with AI starts ONE row-scoped translate job for the checked notes
//   (pipelineStore.start with translate.rowIds, the path the intro Redo and
//   the classic note card's re-run use), not one AI call per note. The server
//   takes at most 50 row ids per job, so larger selections go in chunks.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import { api, ApiError, isChapterLockedBody, type TnRow } from "../../sync/api";
import { versionMismatchRow } from "../../lib/versionMismatch";
import { outbox } from "../../sync/outbox";
import { drafts, rowKey } from "../../sync/drafts";
import { pipelineStore, getSessionKey } from "../../sync/pipelineStore";
import { isApprovableRow } from "../../lib/reviewApproval";
import { isAiProviderNotConfigured } from "../../lib/aiProviderErrors";
import { redoOutcome } from "../../lib/applySkipped";
import { escapeNewlines, waitForOp } from "./translateShared";
import { snapshotMismatch, stillAsProposed, type RapidSnapshot } from "./rapidAssistant";

type CardStatus = "approved" | "skipped";

// The server's cap on translate.rowIds (api/src/pipelines.ts TranslateOptions).
const MAX_ROWS_PER_JOB = 50;

// stateChanged: only the assistant's Apply counts it (the note changed since the proposal, #878, #883).
type SkipReason = "unsaved" | "pending" | "changed" | "stateChanged" | "locked" | "noDraft" | "approved" | "notNeeded" | "failed";
const REASONS: SkipReason[] = ["unsaved", "pending", "changed", "stateChanged", "locked", "noDraft", "approved", "notNeeded", "failed"];

export interface RapidBulkResult {
  text: string;
  severity: "success" | "info" | "warning";
}

/** What one bulk verb did, before it is turned into the result line. */
interface RunOut {
  left: string[];
  count: number;
  skipped: Record<SkipReason, number>;
  stopped: boolean;
  /** Another bulk action (or a save) was running: nothing was tried. */
  blocked?: boolean;
  /** Edits sent to the outbox but not confirmed before the wait ran out: they may still save. */
  unconfirmed?: number;
}

/** What the assistant's Apply sends (issue #858): edits carry the version the proposal was made against. */
export interface AssistantSelection {
  edits: { id: string; note: string; version: number }[];
  approve: string[];
  notNeeded: string[];
  /** Each note's version when the proposal was asked for. */
  versions: ReadonlyMap<string, number>;
  /** Each note's translation_state then: approving does not bump the version. */
  states: ReadonlyMap<string, string | null>;
}

export interface RapidBulkArgs {
  book: string;
  chapter: number;
  /** The open note (the screen's cursor row). */
  currentId: string | null;
  /** The open note has typing that differs from its saved text. */
  hasDiff: boolean;
  /** Other notes with unsaved typing in the drafts store. */
  draftRowIds: ReadonlySet<string>;
  rowById: ReadonlyMap<string, TnRow>;
  statuses: Record<string, CardStatus>;
  setStatuses: Dispatch<SetStateAction<Record<string, CardStatus>>>;
  applyLocalRowReplacement: (kind: "tn", row: TnRow) => void;
  refetch: () => Promise<unknown>;
  /** Refetch and re-seed the open note from the new data. */
  reload: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setEditing: (b: boolean) => void;
  /** The screen's Save & approve for the open note; true when it approved.
   *  `stay` keeps the cursor (and so the rows shown) where it is. */
  handleApprove: (opts?: { stay?: boolean }) => Promise<boolean>;
  aiUnavailable: string | null;
  t: TFunction;
}

export function useRapidBulk(a: RapidBulkArgs) {
  const { book, chapter, t } = a;
  const scope = `${book}:${chapter}`;
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(RapidBulkResult & { scope: string }) | null>(null);
  // The rows the last Not needed set aside, and the status each had before,
  // so Undo puts back exactly what that action changed.
  const [undoable, setUndoable] = useState<{ scope: string; ids: string[]; prev: Record<string, CardStatus | undefined> } | null>(null);
  // Redo jobs this screen started: job id → the row ids it covers and the
  // bulk Redo they belong to. A selection over 50 notes is several jobs; the
  // result line reports once, when the last of them settles.
  const redoJobsRef = useRef(new Map<string, { batch: number; rowIds: string[] }>());
  const redoBatchesRef = useRef(new Map<number, { open: number; drafted: number; kept: number; failed: string | null }>());
  const nextBatchRef = useRef(0);

  function summarize(lead: string, skipped: Record<SkipReason, number>, stopped: boolean): RapidBulkResult {
    const parts = REASONS.filter((r) => skipped[r] > 0).map((r) => t(`flowTranslate.rapid.bulk.why.${r}`, { count: skipped[r] }));
    const total = REASONS.reduce((n, r) => n + skipped[r], 0);
    let text = lead;
    if (total > 0) {
      text += " " + t("flowTranslate.rapid.bulk.skipped", { count: total, reasons: parts.join(t("flowTranslate.rapid.bulk.listSep")) });
    }
    if (stopped) text += " " + t("flowTranslate.rapid.bulk.stopped");
    return { text, severity: total > 0 || stopped ? "warning" : "success" };
  }

  const emptySkips = (): Record<SkipReason, number> =>
    Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<SkipReason, number>;

  // Rows the server would reject for an edit still waiting in this browser.
  // An unreadable outbox counts as pending for every row (fail closed).
  async function pendingRowIds(): Promise<Set<string> | null> {
    const ops = await outbox.listWithUncommitted().catch(() => null);
    if (!ops) return null;
    const s = new Set<string>();
    for (const o of ops) {
      if (o.target.kind === "row" && o.target.rowKind === "tn" && o.target.book === book) s.add(o.target.id);
    }
    return s;
  }

  // Rows with a draft in the store, read now rather than from the screen's
  // subscription, whose first snapshot lands a moment after the screen opens.
  // A failed read counts as a draft (fail closed).
  async function storedDraftIds(ids: string[]): Promise<Set<string>> {
    const found = await Promise.all(
      ids.map((id) =>
        drafts.get(rowKey("tn", book, id)).then(
          (rec) => rec != null,
          () => true,
        ),
      ),
    );
    return new Set(ids.filter((_, i) => found[i]));
  }

  // The open note's live diff, the screen's draft set, or a stored draft. The
  // open note's draft can still be loading right after the cursor moves
  // (hasDiff false for a moment), so all three are checked.
  function unsaved(id: string, stored: ReadonlySet<string>): boolean {
    return (id === a.currentId && a.hasDiff) || a.draftRowIds.has(id) || stored.has(id);
  }

  // Not needed and Redo send no version, so a peer's edit since this screen
  // loaded would be set aside or redrafted unseen. Read the chapter fresh
  // once and skip any row whose version moved. Null when the read fails.
  async function changedSinceShown(ids: string[]): Promise<Set<string> | null> {
    try {
      const fresh = await api.getChapter(book, chapter);
      const byId = new Map(fresh.tn.map((r) => [r.id, r]));
      return new Set(ids.filter((id) => byId.get(id)?.version !== a.rowById.get(id)?.version));
    } catch {
      return null;
    }
  }

  // The open note's editor closes while a bulk action works on it, so no new
  // typing starts under an approval or a set-aside.
  function closeOpenEditor(ids: string[]) {
    if (a.currentId && ids.includes(a.currentId)) a.setEditing(false);
  }

  function show(r: RapidBulkResult) {
    setResult({ ...r, scope });
  }

  function failureKind(err: unknown): "stop" | "locked" | "changed" | "noDraft" | "failed" {
    if (!(err instanceof ApiError)) return "failed";
    if (err.status === 401 || err.status === 403) return "stop";
    if (isChapterLockedBody(err.body)) return "locked";
    // Only a version_mismatch means someone changed the row; any other 409
    // (workspace_mismatch, say) is a plain failure.
    if (versionMismatchRow(err)) return "changed";
    if (err.status === 404) return "noDraft";
    return "failed";
  }

  const blockedRun = (ids: string[]): RunOut => ({ left: ids, count: 0, skipped: emptySkips(), stopped: false, blocked: true });

  /** Approve the checked notes. Returns the ids left unapproved. */
  async function approve(ids: string[]): Promise<string[]> {
    const r = await runApprove(ids);
    if (!r.blocked) show(summarize(t("flowTranslate.rapid.bulk.approved", { count: r.count }), r.skipped, r.stopped));
    return r.left;
  }

  async function runApprove(ids: string[]): Promise<RunOut> {
    if (running || a.busy || ids.length === 0) return blockedRun(ids);
    setRunning(true);
    setResult(null);
    setUndoable(null);
    const skipped = emptySkips();
    const left: string[] = [];
    let approved = 0;
    let stopped = false;
    let refetchNeeded = false;
    let openChanged = false;
    try {
      let others = ids;
      // The open note with an unsaved edit: Save & approve, as Ctrl+Enter
      // does (D2 in the design record). It runs first, while the screen's
      // handler still holds the text the user is looking at.
      if (a.currentId && a.hasDiff && ids.includes(a.currentId)) {
        others = ids.filter((id) => id !== a.currentId);
        if (await a.handleApprove({ stay: true })) approved++;
        else {
          skipped.failed++;
          left.push(a.currentId);
        }
      }
      a.setBusy(true);
      closeOpenEditor(others);
      const pending = await pendingRowIds();
      const stored = await storedDraftIds(others);
      for (const [i, id] of others.entries()) {
        const r = a.rowById.get(id);
        if (!r) {
          skipped.failed++;
          left.push(id);
          continue;
        }
        if (unsaved(id, stored)) {
          skipped.unsaved++;
          left.push(id);
          continue;
        }
        if (a.statuses[id] === "approved") continue; // already approved: nothing to do
        if (a.statuses[id] === "skipped" || r.trashed_at != null) {
          skipped.notNeeded++;
          left.push(id);
          continue;
        }
        if (!isApprovableRow(r)) {
          skipped.noDraft++;
          left.push(id);
          continue;
        }
        if (!pending || pending.has(id)) {
          skipped.pending++;
          left.push(id);
          continue;
        }
        try {
          // Approve exactly what is on screen: a peer's edit or set-aside
          // since then comes back 409 instead of being approved unseen.
          const updated = await api.validateNote(id, book, true, {
            bulk: true,
            expectedVersion: r.version,
            expectedState: r.translation_state === "ai_draft" || r.translation_state === "edited" ? r.translation_state : undefined,
          });
          a.applyLocalRowReplacement("tn", updated);
          a.setStatuses((prev) => ({ ...prev, [id]: "approved" }));
          approved++;
        } catch (err) {
          const kind = failureKind(err);
          left.push(id);
          if (kind === "stop") {
            stopped = true;
            // Never tried: still unapproved, so it stays checked.
            left.push(...others.slice(i + 1));
            break;
          }
          skipped[kind]++;
          if (kind === "changed") {
            refetchNeeded = true;
            if (id === a.currentId) openChanged = true;
          }
        }
      }
    } finally {
      a.setBusy(false);
      setRunning(false);
    }
    // One refetch for the whole run, not one per 409. The open note's editor
    // is keyed on its id plus a reload counter, so a plain refetch would leave
    // it showing the old text: reload re-seeds it (#850, as Not needed does).
    if (openChanged) a.reload();
    else if (refetchNeeded) void a.refetch();
    return { left, count: approved, skipped, stopped };
  }

  /** Mark the checked notes Not needed. Returns the ids left untouched. */
  async function notNeeded(ids: string[]): Promise<string[]> {
    const r = await runNotNeeded(ids);
    if (!r.blocked) show(summarize(t("flowTranslate.rapid.bulk.notNeededDone", { count: r.count }), r.skipped, r.stopped));
    return r.left;
  }

  async function runNotNeeded(ids: string[]): Promise<RunOut> {
    if (running || a.busy || ids.length === 0) return blockedRun(ids);
    setRunning(true);
    setResult(null);
    setUndoable(null);
    a.setBusy(true);
    const skipped = emptySkips();
    const left: string[] = [];
    const done: string[] = [];
    const prev: Record<string, CardStatus | undefined> = {};
    let stopped = false;
    let refetchNeeded = false;
    let openChanged = false;
    try {
      closeOpenEditor(ids);
      const pending = await pendingRowIds();
      const stored = await storedDraftIds(ids);
      const changed = await changedSinceShown(ids);
      for (const [i, id] of ids.entries()) {
        const r = a.rowById.get(id);
        if (!r) {
          skipped.failed++;
          left.push(id);
          continue;
        }
        // Unsaved typing would be lost: set-aside clears a note's draft, and
        // Undo (restore) cannot bring the typing back.
        if (unsaved(id, stored)) {
          skipped.unsaved++;
          left.push(id);
          continue;
        }
        if (a.statuses[id] === "skipped" || r.trashed_at != null) continue; // already set aside
        if (!pending || pending.has(id)) {
          skipped.pending++;
          left.push(id);
          continue;
        }
        if (!changed || changed.has(id)) {
          skipped[changed ? "changed" : "failed"]++;
          if (changed) {
            refetchNeeded = true;
            if (id === a.currentId) openChanged = true;
          }
          left.push(id);
          continue;
        }
        try {
          // Pinned to the version and state on screen (#837): a peer's edit
          // or approval that lands after the re-read above is refused, not
          // set aside unseen.
          // Always sent, null included: null pins "still has no state".
          const shownState = r.translation_state ?? null;
          const updated = await api.trashNote(id, book, { expectedVersion: r.version, expectedState: shownState });
          prev[id] = a.statuses[id];
          a.applyLocalRowReplacement("tn", updated);
          a.setStatuses((p) => ({ ...p, [id]: "skipped" }));
          if (id === a.currentId) a.setEditing(false);
          done.push(id);
        } catch (err) {
          const kind = failureKind(err);
          left.push(id);
          if (kind === "stop") {
            stopped = true;
            left.push(...ids.slice(i + 1));
            break;
          }
          skipped[kind === "noDraft" ? "failed" : kind]++;
          if (kind === "changed") {
            // The row as it is now, on screen at once; the refetch follows.
            const current = versionMismatchRow<TnRow>(err);
            if (current) a.applyLocalRowReplacement("tn", current);
            refetchNeeded = true;
            if (id === a.currentId) openChanged = true;
          }
        }
      }
    } finally {
      a.setBusy(false);
      setRunning(false);
    }
    // The open note's editor is keyed on its id plus a reload counter, so a
    // plain refetch would leave it showing the old text: reload re-seeds it.
    if (openChanged) a.reload();
    else if (refetchNeeded) void a.refetch();
    if (done.length > 0) setUndoable({ scope, ids: done, prev });
    return { left, count: done.length, skipped, stopped };
  }

  /**
   * Save the assistant's proposed note texts (issue #858). The same per-row
   * rules as Approve: unsaved typing, a write still in the outbox, a note set
   * aside, or a version that is no longer the one the proposal was made
   * against are skipped and counted. Each edit goes through the outbox like a
   * typed save and waits for its result (saveDraft's wait). The edited note
   * ends up 'edited' on the server, so it still needs approval. With `snap`
   * (the assistant's Apply), a note whose approval state changed since the
   * proposal is skipped too: approving does not bump the version, so the
   * edit would otherwise move a note approved since then back to Edited
   * (#878). The edit also carries the snapshot's state to the server, which
   * refuses it when the note has moved off it there (#880).
   */
  async function runEdits(edits: AssistantSelection["edits"], snap?: RapidSnapshot): Promise<RunOut> {
    if (edits.length === 0) return { left: [], count: 0, skipped: emptySkips(), stopped: false };
    const ids = edits.map((e) => e.id);
    if (running || a.busy) return blockedRun(ids);
    setRunning(true);
    setResult(null);
    setUndoable(null);
    a.setBusy(true);
    const skipped = emptySkips();
    const left: string[] = [];
    let saved = 0;
    let unconfirmed = 0;
    let refetchNeeded = false;
    let openChanged = false;
    try {
      closeOpenEditor(ids);
      const pending = await pendingRowIds();
      const stored = await storedDraftIds(ids);
      for (const e of edits) {
        const r = a.rowById.get(e.id);
        if (!r) {
          skipped.failed++;
          left.push(e.id);
          continue;
        }
        if (unsaved(e.id, stored)) {
          skipped.unsaved++;
          left.push(e.id);
          continue;
        }
        if (a.statuses[e.id] === "skipped" || r.trashed_at != null) {
          skipped.notNeeded++;
          left.push(e.id);
          continue;
        }
        if (!pending || pending.has(e.id)) {
          skipped.pending++;
          left.push(e.id);
          continue;
        }
        if (r.version !== e.version) {
          skipped.changed++;
          refetchNeeded = true;
          if (e.id === a.currentId) openChanged = true;
          left.push(e.id);
          continue;
        }
        // The row on screen already shows the new state, so nothing reloads.
        if (snap && snapshotMismatch(e.id, snap, r) === "stateChanged") {
          skipped.stateChanged++;
          left.push(e.id);
          continue;
        }
        const patch = { note: escapeNewlines(e.note) };
        // The server re-checks the state (#880): an approval this tab has not
        // seen yet, or one landing after the check above, refuses the edit.
        const expectedState = snap?.states.has(e.id) ? (snap.states.get(e.id) ?? null) : undefined;
        try {
          const op = await outbox.enqueueRow("tn", e.id, r.version, patch, {
            book,
            baseline: { note: r.note },
            ...(expectedState !== undefined ? { expectedState } : {}),
          });
          const res = await waitForOp(op.id);
          if (res === null) {
            // Still queued (or the lane is read-only): not confirmed, so not
            // counted as edited. It is not a skip either, since the outbox may
            // still send it, so it gets its own line (#860).
            unconfirmed++;
            left.push(e.id);
          } else if (res.kind === "ok") {
            const u = res.updated as TnRow | null;
            a.applyLocalRowReplacement("tn", u && u.id === e.id && typeof u.version === "number" ? u : { ...r, ...patch });
            // Like a typed save: an edit takes the note off Approved.
            a.setStatuses((p) => {
              if (p[e.id] === undefined) return p;
              const next = { ...p };
              delete next[e.id];
              return next;
            });
            saved++;
            if (e.id === a.currentId) openChanged = true;
          } else {
            left.push(e.id);
            if (res.kind === "conflict") {
              // The held write is the assistant's, not typing: discard it.
              void outbox.drop(op.id, { onlyIfStatus: "conflict" }).catch(() => undefined);
              skipped.changed++;
              refetchNeeded = true;
              if (e.id === a.currentId) openChanged = true;
            } else if (res.kind === "locked") {
              skipped.locked++;
            } else if (res.kind === "fatal" && res.reason === "state_mismatch") {
              // The note changed on the server since the proposal, unseen by
              // this tab (its approval, a set-aside, or, after an auto-heal,
              // another field's edit): count it as such and reload so the note
              // shows it. The outbox already deleted the op (#883 item 4), and
              // the screen's outbox listener sets its status circle (item 1).
              skipped.stateChanged++;
              refetchNeeded = true;
            } else {
              void outbox.drop(op.id, { onlyIfStatus: "failed" }).catch(() => undefined);
              skipped.failed++;
            }
          }
        } catch {
          skipped.failed++;
          left.push(e.id);
        }
      }
    } finally {
      a.setBusy(false);
      setRunning(false);
    }
    // The open note's editor is keyed on its id plus a reload counter, so a
    // plain refetch would leave it showing the old text: reload re-seeds it.
    if (openChanged) a.reload();
    else if (refetchNeeded || saved > 0) void a.refetch();
    return { left, count: saved, skipped, stopped: false, unconfirmed };
  }

  /**
   * Apply what the user ticked on an assistant proposal: edits first, then
   * approvals, then Not needed, each through the rules above. One result line.
   * Edits win over an approval of the same note (the caller drops those), so
   * the stale-version row a later step reads is never one an earlier step
   * changed.
   */
  async function applyAssistant(sel: AssistantSelection): Promise<RapidBulkResult & { retryable?: boolean }> {
    if (running || a.busy) return { text: t("assistant.apply.busy"), severity: "warning", retryable: true };
    const skipped = emptySkips();
    const parts: string[] = [];
    let stopped = false;
    const addSkips = (s: Record<SkipReason, number>) => {
      for (const k of REASONS) skipped[k] += s[k];
    };
    const merge = (r: RunOut) => {
      addSkips(r.skipped);
      stopped = stopped || r.stopped;
    };
    // Approve and Not needed act on the note as it is now, so a note changed
    // since the assistant read it (its version, or its approval state, which
    // approving does not version) is skipped, like an edit. A note no longer
    // on the screen is a failure, as in the plain runners. The open note with
    // unsaved typing is skipped too: plain Approve would save and approve that
    // typing, which the proposal never showed. Each step's skips are counted
    // into its own tally and reported only if the run reaches that step.
    const unchanged = (ids: string[], into: Record<SkipReason, number>) => {
      const r = stillAsProposed(ids, sel, a.rowById);
      into.changed += r.changed;
      into.stateChanged += r.stateChanged;
      into.failed += r.missing;
      return r.ids;
    };
    const approveSkips = emptySkips();
    const approveIds = unchanged(sel.approve, approveSkips).filter((id) => {
      if (id === a.currentId && a.hasDiff) {
        approveSkips.unsaved++;
        return false;
      }
      return true;
    });
    const notNeededSkips = emptySkips();
    const notNeededIds = unchanged(sel.notNeeded, notNeededSkips);
    const noRun: RunOut = { left: [], count: 0, skipped: emptySkips(), stopped: false };
    const edits = await runEdits(sel.edits, sel);
    if (edits.blocked) return { text: t("assistant.apply.busy"), severity: "warning", retryable: true };
    if (sel.edits.length > 0) {
      merge(edits);
      parts.push(t("assistant.apply.edited", { count: edits.count }));
      if (edits.unconfirmed) parts.push(t("assistant.apply.stillSaving", { count: edits.unconfirmed }));
    }
    if (!stopped && sel.approve.length > 0) {
      // All of them skipped above: still report the count (0) with the reasons.
      const r = approveIds.length > 0 ? await runApprove(approveIds) : noRun;
      if (r.blocked) return { text: t("assistant.apply.busy"), severity: "warning" };
      addSkips(approveSkips);
      merge(r);
      parts.push(t("flowTranslate.rapid.bulk.approved", { count: r.count }));
    }
    if (!stopped && sel.notNeeded.length > 0) {
      // All of them skipped above: still report the count (0) with the reasons.
      const r = notNeededIds.length > 0 ? await runNotNeeded(notNeededIds) : noRun;
      if (r.blocked) return { text: t("assistant.apply.busy"), severity: "warning" };
      addSkips(notNeededSkips);
      merge(r);
      parts.push(t("flowTranslate.rapid.bulk.notNeededDone", { count: r.count }));
    }
    const out = summarize(parts.join(" "), skipped, stopped);
    if (edits.unconfirmed) out.severity = "warning";
    show(out);
    return out;
  }

  /** Bring back the notes the last bulk Not needed set aside. */
  async function undo() {
    const u = undoable;
    if (!u || u.scope !== scope || running || a.busy) return;
    setRunning(true);
    setResult(null);
    setUndoable(null);
    a.setBusy(true);
    const skipped = emptySkips();
    const restoredIds = new Set<string>();
    // A 404 means the nightly job has finalized the set-aside: no retry.
    const gone = new Set<string>();
    let restored = 0;
    let stopped = false;
    try {
      for (const id of u.ids) {
        try {
          const updated = await api.restoreNote(id, book);
          a.applyLocalRowReplacement("tn", updated);
          a.setStatuses((p) => {
            const next = { ...p };
            const before = u.prev[id];
            if (before === undefined) delete next[id];
            else next[id] = before;
            return next;
          });
          restored++;
          restoredIds.add(id);
        } catch (err) {
          const kind = failureKind(err);
          if (kind === "stop") {
            stopped = true;
            break;
          }
          if (kind === "noDraft") gone.add(id);
          skipped[kind === "locked" ? "locked" : "failed"]++;
        }
      }
    } finally {
      a.setBusy(false);
      setRunning(false);
    }
    // Rows Undo could not reach (refused, or never tried after a stop) stay
    // undoable, so pressing Undo again retries exactly those.
    const rest = u.ids.filter((id) => !restoredIds.has(id) && !gone.has(id));
    if (rest.length > 0) setUndoable({ scope, ids: rest, prev: u.prev });
    show(summarize(t("flowTranslate.rapid.bulk.restored", { count: restored }), skipped, stopped));
  }

  /** Start one AI redraft for the checked notes. Returns the ids not sent. */
  async function redo(ids: string[]): Promise<string[]> {
    if (running || a.busy || ids.length === 0) return ids;
    if (a.aiUnavailable) {
      show({ text: a.aiUnavailable, severity: "warning" });
      return ids;
    }
    setRunning(true);
    setResult(null);
    setUndoable(null);
    a.setBusy(true);
    const skipped = emptySkips();
    const left: string[] = [];
    const eligible: string[] = [];
    let startedCount = 0;
    let failure: string | null = null;
    let refetchNeeded = false;
    let openChanged = false;
    const alreadyOver: Parameters<typeof settleRedo>[0][] = [];
    const batchId = ++nextBatchRef.current;
    const batch = { open: 0, drafted: 0, kept: 0, failed: null as string | null };
    // Registered before the first start: a job can end before the next starts.
    redoBatchesRef.current.set(batchId, batch);
    try {
      const pending = await pendingRowIds();
      const stored = await storedDraftIds(ids);
      const changed = await changedSinceShown(ids);
      for (const id of ids) {
        const r = a.rowById.get(id);
        if (!r) {
          skipped.failed++;
          left.push(id);
        } else if (unsaved(id, stored)) {
          // The new draft would land under the typing, which would then hide it.
          skipped.unsaved++;
          left.push(id);
        } else if (a.statuses[id] === "approved" || r.translation_state === "validated") {
          // A redraft replaces approved text and cannot be undone.
          skipped.approved++;
          left.push(id);
        } else if (a.statuses[id] === "skipped" || r.trashed_at != null) {
          skipped.notNeeded++;
          left.push(id);
        } else if (!pending || pending.has(id)) {
          skipped.pending++;
          left.push(id);
        } else if (!changed || changed.has(id)) {
          // A peer's edit since this screen loaded would be redrafted unseen.
          skipped[changed ? "changed" : "failed"]++;
          if (changed) {
            refetchNeeded = true;
            if (id === a.currentId) openChanged = true;
          }
          left.push(id);
        } else eligible.push(id);
      }
      for (let i = 0; i < eligible.length; i += MAX_ROWS_PER_JOB) {
        const chunk = eligible.slice(i, i + MAX_ROWS_PER_JOB);
        try {
          const started = await pipelineStore.start({
            pipelineType: "translate",
            book,
            startChapter: chapter,
            endChapter: chapter,
            sessionKey: getSessionKey(),
            translate: { rowIds: chunk },
          });
          // A job id already tracked (a covering job answered for this chunk
          // too) keeps reporting to whichever batch tracked it first.
          if (!redoJobsRef.current.has(started.jobId)) {
            batch.open++;
            redoJobsRef.current.set(started.jobId, { batch: batchId, rowIds: chunk });
          }
          startedCount += chunk.length;
          closeOpenEditor(chunk);
          // The job may already be over (a covering job answered for it).
          const existing = pipelineStore.get(started.jobId);
          if (existing && (existing.state === "done" || existing.state === "failed" || existing.state === "cancelled")) {
            alreadyOver.push(existing);
          }
        } catch (err) {
          left.push(...eligible.slice(i));
          failure = isAiProviderNotConfigured(err)
            ? t("pipeline.aiKeyNotConfigured")
            : t("flowTranslate.rapid.bulk.redoFailed", {
                status: err instanceof ApiError ? err.status : t("flowTranslate.genericError"),
              });
          break;
        }
      }
    } finally {
      a.setBusy(false);
      setRunning(false);
    }
    // The open note's editor is keyed on its id plus a reload counter, so a
    // plain refetch would leave it showing the old text: reload re-seeds it
    // (#853, as Not needed and Approve do).
    if (openChanged) a.reload();
    else if (refetchNeeded) void a.refetch();
    const lead = t("flowTranslate.rapid.bulk.redoStarted", { count: startedCount });
    const r = summarize(lead, skipped, false);
    show(failure ? { text: `${r.text} ${failure}`, severity: "warning" } : { ...r, severity: r.severity === "success" ? "info" : r.severity });
    if (batch.open === 0) redoBatchesRef.current.delete(batchId);
    for (const job of alreadyOver) settleRedo(job);
    return left;
  }

  function settleRedo(job: { job_id: string; state: string; apply_skipped_json?: string | null; error_message?: string | null }) {
    const entry = redoJobsRef.current.get(job.job_id);
    if (!entry) return;
    redoJobsRef.current.delete(job.job_id);
    const batch = redoBatchesRef.current.get(entry.batch);
    if (!batch) return;
    batch.open--;
    if (job.state !== "done") batch.failed = job.error_message ?? job.state;
    else {
      const kept = entry.rowIds.filter((id) => redoOutcome(job, id) === "kept").length;
      batch.kept += kept;
      batch.drafted += entry.rowIds.length - kept;
      a.reload();
    }
    if (batch.open > 0) return;
    redoBatchesRef.current.delete(entry.batch);
    const parts: string[] = [];
    if (batch.drafted + batch.kept > 0) {
      parts.push(t("flowTranslate.rapid.bulk.redoDone", { drafted: batch.drafted, kept: batch.kept }));
    }
    if (batch.failed) parts.push(t("flowTranslate.rapid.bulk.redoFailed", { status: batch.failed }));
    show({ text: parts.join(" "), severity: batch.failed ? "warning" : batch.kept > 0 ? "info" : "success" });
  }
  // The store listeners below subscribe once; they call the latest render's
  // settleRedo through this ref.
  const settleRef = useRef(settleRedo);
  useEffect(() => {
    settleRef.current = settleRedo;
  });

  useEffect(
    () =>
      pipelineStore.onComplete((job) => {
        if (job.pipeline_type !== "translate") return;
        settleRef.current(job);
      }),
    [],
  );
  // A cancelled or dismissed job leaves the store without a completion event.
  useEffect(
    () =>
      pipelineStore.subscribe((list) => {
        for (const jobId of [...redoJobsRef.current.keys()]) {
          const job = list.find((j) => j.job_id === jobId);
          if (!job || job.state === "cancelled") settleRef.current({ job_id: jobId, state: "cancelled" });
        }
      }),
    [],
  );

  return {
    running,
    result: result && result.scope === scope ? { text: result.text, severity: result.severity } : null,
    dismiss: () => {
      setResult(null);
      setUndoable(null);
    },
    approve,
    applyEdits: (edits: AssistantSelection["edits"]) => runEdits(edits),
    applyAssistant,
    redo,
    notNeeded,
    undo: undoable && undoable.scope === scope ? () => void undo() : null,
  };
}
