// Keep the text of a refused row save (issue #647). The classic tQ table/card
// and tW-link row compare their fields with the cached row, which Save patches
// optimistically, so they clear their draft right after Save. If the server
// then refuses the save (a fatal 4xx, or a 409 "chapter_locked" the outbox
// drops), nothing else holds what the user typed: it is on screen only until
// a reload. drafts.ts calls rowDraftAfterRefusal on those results and writes
// the returned record, so the text shows as "N unsaved" and the editor
// restores it when it mounts.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a
// plain Node script (refusedRowDraft.test.mjs), like draftSaveState.ts.

import type { DraftRecord } from "./drafts.ts";
import type { OutboxOp } from "./outbox.ts";
import { isLiveOp, targetKey } from "./outboxTargeting.ts";

// The fields each classic editor restores from a row draft. Other fields a row
// save can carry (sort_order from a reorder, verse/ref_raw from a tN move) are
// not typing and have no editor to restore them, so they would only leave a
// phantom "unsaved" reminder.
const EDITOR_FIELDS: Record<string, readonly string[]> = {
  tn: ["quote", "note", "support_reference"],
  tq: ["ref_raw", "question", "response"],
  twl: ["orig_words", "tw_link", "occurrence"],
};

// The draft record to write for `key` after `op` was refused, or undefined to
// leave the store as it is. `queued` is the outbox read after the refusal.
//
// Newer text always wins, field by field. A field is written back only when
// nothing newer holds it:
//   * the draft already holds it (in its patch, or in its baseline, which
//     NoteCard and the flows screens pin to the server copy, so a field absent
//     from their patch was typed back to the server value on purpose);
//   * a later live save for the row sends it (that save carries newer text;
//     if it is refused too, its own refusal writes it back).
// Nothing is written while a delete for the row is queued, or when the outbox
// could not be read. The record keeps the draft's other fields and records the
// written fields as `refused`, which stops an editor's "no diff" clear from
// dropping it (drafts.clearUnlessRefused). A new draft needs a place to file
// it: the op's draftRef (set by the classic editors' save) gives the verse.
export function rowDraftAfterRefusal(
  key: string,
  existing: DraftRecord | undefined,
  op: Pick<OutboxOp, "id" | "target" | "action" | "patch" | "expectedVersion"> & Partial<Pick<OutboxOp, "draftRef">>,
  queued: OutboxOp[] | null,
  at: { now: number; generation: string },
): DraftRecord | undefined {
  if (op.target.kind !== "row" || op.action === "delete") return undefined;
  if (queued === null || existing?.quarantined) return undefined;
  const sent = op.patch as unknown;
  if (!sent || typeof sent !== "object") return undefined;
  const editorFields = EDITOR_FIELDS[op.target.rowKind] ?? [];

  const rowKey = targetKey(op.target);
  const heldByLater = new Set<string>();
  for (const o of queued) {
    if (o.id === op.id || targetKey(o.target) !== rowKey || !isLiveOp(o)) continue;
    if (o.action === "delete") return undefined;
    const p = o.patch as unknown;
    if (!p || typeof p !== "object") return undefined;
    for (const k of Object.keys(p as Record<string, unknown>)) heldByLater.add(k);
  }

  const payload = (existing?.payload ?? {}) as { patch?: unknown; baseline?: unknown };
  const draftPatch = payload.patch && typeof payload.patch === "object" ? (payload.patch as Record<string, unknown>) : {};
  const draftBaseline =
    payload.baseline && typeof payload.baseline === "object" ? (payload.baseline as Record<string, unknown>) : {};
  if (existing && !(payload.patch && typeof payload.patch === "object")) return undefined;

  const added: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sent as Record<string, unknown>)) {
    if (!editorFields.includes(k)) continue;
    if (k in draftPatch || k in draftBaseline || heldByLater.has(k)) continue;
    added[k] = v;
  }
  if (Object.keys(added).length === 0) return undefined;

  if (existing) {
    return {
      ...existing,
      payload: { ...existing.payload, patch: { ...draftPatch, ...added } },
      updatedAt: at.now,
      generation: at.generation,
      refused: { ...(existing.refused ?? {}), ...added },
    };
  }
  if (!op.draftRef) return undefined;
  return {
    key,
    payload: { patch: added },
    expectedVersion: op.expectedVersion,
    updatedAt: at.now,
    generation: at.generation,
    meta: {
      kind: "row",
      rowKind: op.target.rowKind,
      id: op.target.id,
      book: op.target.book,
      chapter: op.draftRef.chapter,
      verse: op.draftRef.verse,
    },
    refused: added,
  };
}
