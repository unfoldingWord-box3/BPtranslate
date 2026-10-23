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

// A row save's 200 settles the row draft by content: only when every field in
// the draft's patch was sent with an equal value. Every row editor stores only
// the fields it changed (NoteCard, QuestionCard/QuestionsTable, WordsTable,
// ReviewQueue card and grid, flows Translate Notes/Questions), so such a draft
// holds nothing the server does not now have, however often it was re-written
// and at whatever version. A draft holding a field the save did not send, or a
// different value, is typing done after the Save and survives — even when the
// editor unmounted before the 200 and never re-wrote it (#618). Version (#616)
// and per-write generation fences each failed one of those cases.
//
// A confirmed delete settles any draft (the row is gone, and no editor would
// ever reopen it). A record with no readable patch (an older or adopted shape)
// keeps the old unconditional clear, so it can't leave a permanent stale
// reminder.
export function rowDraftSettledByOp(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "patch"> & Partial<Pick<OutboxOp, "action">>,
): boolean {
  if (!draft) return false;
  if (op.action === "delete") return true;
  const patch = (draft.payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object") return true;
  const sent = op.patch;
  return Object.entries(patch as Record<string, unknown>).every(
    ([k, v]) => k in sent && rowValueKey(v) === rowValueKey(sent[k]),
  );
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
