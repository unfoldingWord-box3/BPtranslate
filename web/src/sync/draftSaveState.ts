// Generation fencing for draft saves. A verse draft is rewritten on every
// keystroke, but the outbox 200 that eventually confirms a Save was captured
// from ONE exact draft write. Without a fence, that 200 clears whatever draft
// currently sits under the key — including newer typing the user did while the
// request was in flight (the persistence-not-confirmation contract in
// CLAUDE.md "Note save semantics" breaks: the newer text survives only in
// React state and dies on reload). Each draft write gets an opaque generation;
// a save carries the generation it captured into the outbox
// (OutboxOp.draftGeneration), and the success handler clears only that
// generation (drafts.clearGeneration).
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a
// plain Node script (draftSaveState.test.mjs) — same reasoning as
// outboxTargeting.ts.

import type { DraftRecord } from "./drafts.ts";
import type { OutboxOp } from "./outbox.ts";
import { extractEditableText, normalizeEditable } from "../lib/usfm.ts";
import { isMaxAttemptsBlocked, targetKey } from "./outboxTargeting.ts";

function legacyOpCapturedDraft(draft: DraftRecord, op: OutboxOp): boolean {
  const draftPlain = (draft.payload as { plainText?: unknown }).plainText;
  if (typeof draftPlain !== "string") return false;
  const queuedContent = (op.patch as { content?: unknown }).content;
  if (queuedContent === undefined) return false;
  return extractEditableText(queuedContent) === normalizeEditable(draftPlain);
}

// True only while this exact verse target is actively making its way to the
// server. Conflicts and failed operations deliberately return false: those need
// the existing off-screen reminder and recovery UI rather than being hidden.
export function verseDraftHasActiveSave(draft: DraftRecord, ops: OutboxOp[]): boolean {
  if (draft.meta.kind !== "verse") return false;
  const meta = draft.meta;
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  return ops.some((op) => {
    const target = op.target;
    // Operations persisted by the previous app version have no generation.
    // Require exact payload provenance: target + timestamp alone cannot tell a
    // text save from an unrelated alignment/restore/find-replace operation.
    const capturesDraft = op.draftGeneration
      ? op.draftGeneration === generation
      : legacyOpCapturedDraft(draft, op);
    return (
      (op.status === "pending" || op.status === "in_flight") &&
      capturesDraft &&
      target.kind === "verse" &&
      target.book === meta.book &&
      target.chapter === meta.chapter &&
      target.verse === meta.verse &&
      target.bibleVersion === meta.bibleVersion
    );
  });
}

export function generationForSuccessfulOp(
  draft: DraftRecord | undefined,
  op: OutboxOp,
): string | undefined {
  if (!draft) return undefined;
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  if (op.draftGeneration) {
    return op.draftGeneration === generation ? generation : undefined;
  }
  // Upgrade compatibility for an operation queued before draft generations
  // existed. Clear only when its durable queued content reconstructs to the
  // exact editable text in the draft; otherwise provenance is unknowable.
  return legacyOpCapturedDraft(draft, op) ? generation : undefined;
}

// Row editors keep display text in their drafts (NoteCard: real newlines) but
// NoteCard's Save sends TSV text (a literal backslash-n). Compare both in
// display form, the same conversion tsvToDisplay does.
function rowValueKey(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\\n/g, "\n") : v;
}

// Whether a row save's 200 settles the row draft, judged by content alone.
// True when every field in the draft's patch was sent by this op with an equal
// value. Every row editor stores only the fields it changed (NoteCard,
// QuestionCard/QuestionsTable, WordsTable, ReviewQueue card and grid, flows
// Translate Notes/Questions), so such a draft holds nothing this save did not
// put on the server, however often it was re-written and at whatever version.
// A draft holding a field this op did not send, or a different value, is kept:
// usually typing done after the Save, which must survive even when the editor
// unmounted before the 200 and never re-wrote it (#618).
//
// Known gaps, both shared with the old version rule on main:
//   * A field typed back to its pre-save value while the save is pending drops
//     out of the editor's patch (it equals the editor's baseline). If the
//     editor then unmounts before the 200, the remaining fields can match and
//     the draft clears; the server keeps the saved value, and the revert is lost.
//   * A draft also survives a 200 from an op that did not send its fields
//     (reorder, find/replace, AI apply, a history restore with other text).
//     That is unsaved typing, so it stays as an "unsaved" reminder.
//
// A confirmed delete settles any draft (the row is gone). A draft with no
// readable patch (an older or adopted shape) keeps the old unconditional clear,
// so it can't leave a permanent stale reminder. An op whose patch is not an
// object cannot prove anything was sent, so the draft is kept.
export function rowDraftSettledByOp(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "patch"> & Partial<Pick<OutboxOp, "action">>,
): boolean {
  if (!draft) return false;
  if (op.action === "delete") return true;
  const patch = (draft.payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object") return true;
  const sent = op.patch as unknown;
  if (!sent || typeof sent !== "object") return false;
  const sentFields = sent as Record<string, unknown>;
  return Object.entries(patch as Record<string, unknown>).every(
    ([k, v]) => k in sentFields && rowValueKey(v) === rowValueKey(sentFields[k]),
  );
}

// What a row op's 200 does to the row draft: "clear" it, replace it with the
// returned record, or leave it (undefined).
//
// `queued` is the outbox as read just before the decision (null when it could
// not be read). While another op for the same row is still live (pending,
// in flight, conflicted, or failed but due to re-send on its own) the draft is
// left for that op's 200 to settle: an earlier save's 200 must not clear a
// draft whose text a later save will overwrite (save N1, save N2, type back to
// N1, unmount: clearing on N1's 200 would leave N2 on the server and lose N1).
// A fatal failed op never re-sends, so it does not hold the draft.
//
// A draft that is not cleared gets its baseline rebased: each field this op
// sent and the baseline holds takes the sent value, which the server now
// holds. Otherwise a remounted editor restores the pre-save baseline, typing
// back to it reads as "no change" and silently drops the draft, and the next
// Save carries the wrong baseline into 409 classification.
export function rowDraftAfterOp(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "id" | "target" | "patch"> & Partial<Pick<OutboxOp, "action">>,
  queued: OutboxOp[] | null,
): "clear" | DraftRecord | undefined {
  if (!draft) return undefined;
  if (op.action === "delete") return "clear";
  const key = targetKey(op.target);
  const laterQueued =
    queued === null ||
    queued.some(
      (o) =>
        o.id !== op.id &&
        targetKey(o.target) === key &&
        (o.status === "pending" || o.status === "in_flight" || o.status === "conflict" || isMaxAttemptsBlocked(o)),
    );
  if (!laterQueued && rowDraftSettledByOp(draft, op)) return "clear";
  const payload = draft.payload as { baseline?: unknown };
  const baseline = payload.baseline;
  const sent = op.patch as unknown;
  if (!baseline || typeof baseline !== "object" || !sent || typeof sent !== "object") return undefined;
  const sentFields = sent as Record<string, unknown>;
  const next = { ...(baseline as Record<string, unknown>) };
  let changed = false;
  for (const k of Object.keys(sentFields)) {
    if (k in next && next[k] !== sentFields[k]) {
      next[k] = sentFields[k];
      changed = true;
    }
  }
  return changed ? { ...draft, payload: { ...draft.payload, baseline: next } } : undefined;
}

// True when a row draft's patch is exactly the given saved values: every saved
// field present with an equal value, and no other field. An editor that moves
// its baseline only after the save's 200 calls this to drop a draft it wrote
// with the already-saved text (#616 review). When in doubt it keeps the draft:
// a field missing from the patch means "equal to the draft's baseline", which
// may be newer typing (e.g. a response typed back to its old value).
export function rowDraftHoldsSaved(
  draft: DraftRecord | undefined,
  saved: Record<string, unknown>,
): boolean {
  const patch = (draft?.payload as { patch?: Record<string, unknown> } | undefined)?.patch;
  if (!patch || typeof patch !== "object") return false;
  const savedKeys = Object.keys(saved);
  if (savedKeys.length === 0 || Object.keys(patch).length !== savedKeys.length) return false;
  return savedKeys.every((k) => k in patch && patch[k] === saved[k]);
}

// Associate a save only with the draft whose payload it actually captured.
// If typing raced ahead after the click, the payload differs and the older save
// must not clear that newer generation when it succeeds.
export function generationForSavedPlain(
  draft: DraftRecord | undefined,
  plain: string,
): string | undefined {
  if (!draft) return undefined;
  const payload = draft.payload as { plainText?: unknown };
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  return payload.plainText === plain ? generation : undefined;
}
