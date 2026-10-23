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

// Row drafts carry no generation, so a row save's 200 is fenced by version: it
// settles the draft only if the draft was written at or before the version the
// save was sent against. A draft written against a later version holds typing
// the editor re-persisted after the save was confirmed, and must survive
// (#616). Older drafts (the save was re-based after a 409) are still settled.
export function rowDraftSettledByOp(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "expectedVersion">,
): boolean {
  return !!draft && draft.expectedVersion <= op.expectedVersion;
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
