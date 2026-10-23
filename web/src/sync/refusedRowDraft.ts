// Keep the text of a refused row save (issue #647). The classic tQ table/card
// and tW-link row compare their fields with the cached row, which Save patches
// optimistically, so they clear their draft right after Save. If the server
// then refuses the save (a fatal 4xx, or a 409 "chapter_locked" the outbox
// drops), nothing else holds what the user typed: it is on screen only until
// a reload. drafts.ts calls rowDraftAfterRefusal on those results and writes
// the returned record, so the text shows as "N unsaved" and the editor
// restores it when it mounts.
//
// The written fields are recorded on the draft as `refused`: the values the
// server refused, which the cached row still shows. The other helpers here keep
// that record honest for the life of the draft:
//   * withCarriedRefusal: an editor re-write keeps refused fields its diff
//     leaves out (its diff is against the cached row, so they look unchanged);
//   * rowDraftOnNoDiff: an editor's "no diff" clear keeps the refused text;
//   * afterConfirmKeepingRefusal: a confirmed save ends the record only for the
//     fields it sent;
//   * rowDraftAfterRefusedDiscard: discarding the failed op takes back what its
//     refusal wrote.
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a
// plain Node script (refusedRowDraft.test.mjs), like draftSaveState.ts.

import type { DraftRecord } from "./drafts.ts";
import type { OutboxOp, OutboxResult } from "./outbox.ts";
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

type Fields = Record<string, unknown>;

// NoteCard keeps display text (real newlines) and sends TSV text (a literal
// backslash-n); compare in display form, as draftSaveState.ts does.
function same(a: unknown, b: unknown): boolean {
  const key = (v: unknown) => (typeof v === "string" ? v.replace(/\\n/g, "\n") : v);
  return key(a) === key(b);
}

function asFields(v: unknown): Fields | undefined {
  return v && typeof v === "object" ? (v as Fields) : undefined;
}

function nonEmpty(f: Fields | undefined): f is Fields {
  return !!f && Object.keys(f).length > 0;
}

function withRefused(draft: DraftRecord, refused: Fields): DraftRecord {
  const { refused: _r, ...base } = draft;
  return Object.keys(refused).length > 0 ? { ...base, refused } : base;
}

// Whether a result is a refusal whose text should be kept. A fatal 404 means
// the row is gone (deleted meanwhile): there is nothing to save the text to,
// and a draft for it would be a permanent phantom "unsaved".
export function keepsRefusedText(result: OutboxResult): boolean {
  if (result.kind === "locked") return true;
  return result.kind === "fatal" && result.reason !== "http 404";
}

// The draft record to write for `key` after `op` was refused, or undefined to
// leave the store as it is. `queued` is the outbox read after the refusal.
//
// Newer text always wins, field by field. A sent field is written back only
// when nothing newer holds it:
//   * the draft's baseline has it (NoteCard and the flows screens pin their
//     baseline to the server copy, so they already track that field);
//   * the draft's patch holds other text for it (typing after the Save);
//   * a live save for the row queued after this one sends it (newer text; if
//     it is refused too, its own refusal writes it back).
// A draft patch already holding the sent value (the refusal beat the editor's
// post-Save clear) only gets the field marked refused, so that clear keeps it.
// Nothing is written while a later delete for the row is queued, or when the
// outbox could not be read: an unreadable outbox cannot show there is no newer
// save, and writing could put older text over it. A new draft needs a place
// to file it: the op's draftRef (set by the classic tQ / tW-link saves).
export function rowDraftAfterRefusal(
  key: string,
  existing: DraftRecord | undefined,
  op: Pick<OutboxOp, "id" | "target" | "action" | "patch" | "expectedVersion" | "queuedAt"> &
    Partial<Pick<OutboxOp, "draftRef" | "seq">>,
  queued: OutboxOp[] | null,
  at: { now: number; generation: string },
): DraftRecord | undefined {
  if (op.target.kind !== "row" || op.action === "delete") return undefined;
  if (queued === null || existing?.quarantined) return undefined;
  const sent = asFields(op.patch);
  if (!sent) return undefined;
  const editorFields = EDITOR_FIELDS[op.target.rowKind] ?? [];

  const rowKey = targetKey(op.target);
  const isLater = (o: OutboxOp) =>
    o.queuedAt > op.queuedAt || (o.queuedAt === op.queuedAt && (o.seq ?? 0) > (op.seq ?? 0));
  const heldByLater = new Set<string>();
  for (const o of queued) {
    if (o.id === op.id || targetKey(o.target) !== rowKey || !isLiveOp(o) || !isLater(o)) continue;
    if (o.action === "delete") return undefined;
    const p = asFields(o.patch);
    if (!p) continue;
    for (const k of Object.keys(p)) heldByLater.add(k);
  }

  const payload = (existing?.payload ?? {}) as { patch?: unknown; baseline?: unknown };
  const draftPatch = asFields(payload.patch);
  if (existing && !draftPatch) return undefined;
  const patchIn = draftPatch ?? {};
  const baselineIn = asFields(payload.baseline) ?? {};
  const refusedIn = existing?.refused ?? {};

  // `added` fields go into the patch (and the record); `marked` ones are
  // already in the patch with the sent value and only join the record.
  const added: Fields = {};
  const marked: Fields = {};
  for (const [k, v] of Object.entries(sent)) {
    if (!editorFields.includes(k) || k in baselineIn || heldByLater.has(k)) continue;
    if (!(k in patchIn)) added[k] = v;
    else if (same(patchIn[k], v)) {
      if (!(k in refusedIn && same(refusedIn[k], v))) marked[k] = v;
    } else if (k in refusedIn && same(patchIn[k], refusedIn[k])) {
      // The draft holds only an earlier refused value, not newer typing: this
      // later refusal's text replaces it (round-2 review B1(b)).
      added[k] = v;
    }
  }
  if (!nonEmpty(added) && !nonEmpty(marked)) return undefined;
  const refused = { ...refusedIn, ...marked, ...added };

  if (existing) {
    return {
      ...existing,
      payload: { ...existing.payload, patch: { ...patchIn, ...added } },
      updatedAt: at.now,
      generation: at.generation,
      refused,
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
    refused,
  };
}

// drafts.set() for a row: keep `prev`'s refused fields in the rewritten draft.
// The classic editors diff against the cached row, which still shows the
// refused text, so their new patch leaves those fields out; without this,
// editing another field would drop the refused text from the store (review
// A1). A refused field the new patch holds keeps the user's newer text, and
// stays in the record so typing back to the refused text (no diff again) can
// restore it (rowDraftOnNoDiff). A field the new draft's baseline holds is the
// editor's own to track (NoteCard): neither carried nor recorded.
export function withCarriedRefusal(prev: DraftRecord | undefined, next: DraftRecord): DraftRecord {
  if (!nonEmpty(prev?.refused) || next.quarantined) return next;
  const payload = next.payload as { patch?: unknown; baseline?: unknown };
  const patch = asFields(payload.patch);
  if (!patch) return next;
  const baseline = asFields(payload.baseline) ?? {};
  const refused: Fields = {};
  const carried: Fields = {};
  for (const [k, v] of Object.entries(prev.refused)) {
    if (k in baseline) continue;
    refused[k] = v;
    if (!(k in patch)) carried[k] = v;
  }
  if (!nonEmpty(refused)) return next;
  return { ...next, payload: { ...next.payload, patch: { ...patch, ...carried } }, refused };
}

// An editor's "no diff" clear (drafts.clearUnlessRefused). `current` is what
// the editor shows (its field values, in the form its Save sends); `queued` is
// the outbox (null when unreadable). No diff against the cached row means every
// field the editor shows is on the row already, either confirmed or in a save
// on its way, so the draft keeps only refused text that is still pending:
//   * a refused field the editor shows unchanged stays;
//   * a refused field showing other text that a live save for the row sends is
//     superseded: the user saved newer text over it (round-2 review B1). It
//     leaves the draft, or a remount would restore the refused text over it.
//     If that save is refused too, its own refusal writes its text back;
//   * a refused field showing other text that no live save sends stays: the
//     cached row went back to the server copy (a later 200 for another field,
//     or another user's live update), and the refused text was never saved.
// So a draft with a refused record becomes exactly the refused text still
// pending ("clear" when none is; undefined to leave it as it is).
export function rowDraftOnNoDiff(
  rec: DraftRecord,
  current: Fields,
  queued: OutboxOp[] | null,
): "clear" | DraftRecord | undefined {
  if (rec.quarantined) return undefined;
  if (!nonEmpty(rec.refused)) return "clear";
  const patch = asFields((rec.payload as { patch?: unknown }).patch) ?? {};
  const savedLive = (k: string, v: unknown) =>
    queued !== null &&
    queued.some((o) => {
      if (targetKey(o.target) !== rec.key || !isLiveOp(o)) return false;
      const p = asFields(o.patch);
      return !!p && k in p && same(p[k], v);
    });
  const refused: Fields = {};
  for (const [k, v] of Object.entries(rec.refused)) {
    if (k in current && !same(current[k], v) && savedLive(k, current[k])) continue;
    refused[k] = v;
  }
  if (!nonEmpty(refused)) return "clear";
  const keys = Object.keys(patch);
  const sameRecord =
    Object.keys(refused).length === Object.keys(rec.refused).length;
  if (sameRecord && keys.length === Object.keys(refused).length && keys.every((k) => k in refused && patch[k] === refused[k])) {
    return undefined;
  }
  return withRefused({ ...rec, payload: { ...rec.payload, patch: { ...refused } } }, refused);
}

// Wraps the outbox settle (rowDraftAfterConfirm's result `next` for draft
// `rec`) after `op` was confirmed. That settle already keeps a draft holding a
// field the op did not send, so a refused field the op left out survives. A
// refused field the op did send is now on the server with the op's value, so
// the refused value is no longer what the row shows: it leaves the record, and
// leaves the patch too where the patch still holds just that refused value
// (round-2 review B1(a)), so stale refused text cannot be restored over the
// saved text. Other text in the patch for the field is newer typing: kept.
export function afterConfirmKeepingRefusal(
  rec: DraftRecord,
  next: "clear" | DraftRecord | undefined,
  op: Pick<OutboxOp, "patch">,
): "clear" | DraftRecord | undefined {
  if (next === "clear") return next;
  const base = next ?? rec;
  const sent = asFields(op.patch);
  if (!nonEmpty(base.refused) || !sent) return next;
  const refused = { ...base.refused };
  const patchIn = asFields((base.payload as { patch?: unknown }).patch);
  const patch = patchIn ? { ...patchIn } : undefined;
  let stripped = false;
  for (const k of Object.keys(sent)) {
    if (!(k in refused)) continue;
    if (patch && k in patch && same(patch[k], refused[k])) delete patch[k];
    delete refused[k];
    stripped = true;
  }
  if (!stripped) return next;
  if (patch && Object.keys(patch).length === 0) return "clear";
  return withRefused(patch ? { ...base, payload: { ...base.payload, patch } } : base, refused);
}

// The user discarded `op`, a failed (refused) save (review A5). What its
// refusal wrote back goes too, so Discard drops the text as it did before
// #647: each refused field holding this op's value leaves the record, and
// leaves the patch where the patch still holds that value (newer typing
// stays). "clear" when nothing is left; undefined to leave the draft alone.
export function rowDraftAfterRefusedDiscard(
  rec: DraftRecord | undefined,
  op: Pick<OutboxOp, "patch">,
): "clear" | DraftRecord | undefined {
  if (!rec || rec.quarantined || !nonEmpty(rec.refused)) return undefined;
  const sent = asFields(op.patch);
  const patchIn = asFields((rec.payload as { patch?: unknown }).patch);
  if (!sent || !patchIn) return undefined;
  const refused = { ...rec.refused };
  const patch = { ...patchIn };
  let changed = false;
  for (const [k, v] of Object.entries(sent)) {
    if (!(k in refused) || !same(refused[k], v)) continue;
    delete refused[k];
    if (k in patch && same(patch[k], v)) delete patch[k];
    changed = true;
  }
  if (!changed) return undefined;
  if (Object.keys(patch).length === 0) return "clear";
  return withRefused({ ...rec, payload: { ...rec.payload, patch } }, refused);
}
