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
import { isLiveOp, targetKey } from "./outboxTargeting.ts";

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

// Whether a live op for the row `key` (other than `excludeOpId`) holds this
// draft, so nothing else may clear it: that op's own 200 settles it. (The
// outbox settle may still settle the fields no live op sends; see
// settleUnheldFields.)
// Live means pending, in flight, conflicted, or failed but due to re-send on
// its own (a fatal failed op never re-sends). It holds the draft only if it
// could settle it: a delete, an op whose patch is unreadable, or one sending at
// least one of the draft's fields; a draft with no readable patch is held by
// any live op. An unreadable outbox (null) holds it. Shared by the outbox
// settle (rowDraftAfterOp) and the flows screens' post-save clear
// (drafts.clearRowIfSaved) so the two cannot drift (#618 review).
export function liveRowOpHoldsDraft(
  draft: DraftRecord,
  key: string,
  queued: OutboxOp[] | null,
  excludeOpId?: string,
): boolean {
  if (queued === null) return true;
  const draftPatch = (draft.payload as { patch?: unknown }).patch;
  const draftFields =
    draftPatch && typeof draftPatch === "object" ? Object.keys(draftPatch as Record<string, unknown>) : null;
  const couldSettle = (o: OutboxOp) => {
    if (o.action === "delete" || draftFields === null) return true;
    const p = o.patch as unknown;
    if (!p || typeof p !== "object") return true;
    return draftFields.some((k) => k in (p as Record<string, unknown>));
  };
  return queued.some((o) => isLaterLiveRowOp(o, key, excludeOpId) && couldSettle(o));
}

function isLaterLiveRowOp(o: OutboxOp, key: string, excludeOpId: string | undefined): boolean {
  return o.id !== excludeOpId && targetKey(o.target) === key && isLiveOp(o);
}

// The fields live ops for the row `key` (other than `excludeOpId`) will send,
// or null when one of them could touch any field (a delete, an unreadable
// patch) or the outbox could not be read.
function laterLiveRowFields(
  key: string,
  queued: OutboxOp[] | null,
  excludeOpId: string,
): Set<string> | null {
  if (queued === null) return null;
  const fields = new Set<string>();
  for (const o of queued) {
    if (!isLaterLiveRowOp(o, key, excludeOpId)) continue;
    const p = o.patch as unknown;
    if (o.action === "delete" || !p || typeof p !== "object") return null;
    for (const k of Object.keys(p as Record<string, unknown>)) fields.add(k);
  }
  return fields;
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
// Only a later op that could settle the draft holds it: a delete, an op whose
// patch is unreadable, or one sending at least one of the draft's fields. A
// reorder ({sort_order}), another field's save or an AI apply never settles a
// {note} draft, so deferring to it would strand the draft as a phantom
// "unsaved", and typing back to the pre-save text would then clear it with
// nothing sent while the server keeps this op's text (#618 review round 4). A
// draft whose own patch is unreadable defers to any later op, as before.
// A deferring op whose holding op is later discarded, dropped or fatally
// failed is handled by rowDraftAfterConfirm / rowDraftAfterRelease (#632 item 1).
//
// In a deferred draft, every field a later live op sends is left exactly as it
// is, baseline included: the later op will settle it. Rebasing it to this op's
// values would let a reopened editor see the draft (N1) equal to its baseline
// (N1) and drop it before the later op lands N2, which is the loss above; and
// a settle working from a stale outbox read could write its baseline over the
// later op's (#618 review). The fields this op sent that NO later live op
// sends are settled now (settleUnheldFields): no later op would ever settle
// them, so a ReviewQueue draft {response, question} saved as {response} then
// {question} would otherwise keep a phantom unsaved response (#632 item 5). A
// later delete or unreadable patch, or an unreadable outbox, holds the whole
// draft as before.
//
// When this op is the last live one and the draft survives, its baseline is
// rebased: each field this op sent and the baseline holds takes the sent
// value, which the server now holds. Otherwise a remounted editor restores the
// pre-save baseline, typing back to it reads as "no change" and silently drops
// the draft, and the next Save carries the wrong baseline into 409
// classification.
export function rowDraftAfterOp(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "id" | "target" | "patch"> & Partial<Pick<OutboxOp, "action">>,
  queued: OutboxOp[] | null,
): "clear" | DraftRecord | undefined {
  if (!draft) return undefined;
  if (op.action === "delete") return "clear";
  const key = targetKey(op.target);
  if (liveRowOpHoldsDraft(draft, key, queued, op.id)) {
    return settleUnheldFields(draft, op, laterLiveRowFields(key, queued, op.id));
  }
  if (rowDraftSettledByOp(draft, op)) return "clear";
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


// rowDraftAfterOp plus the `confirmed` record (#632 item 1). The outbox settle
// (drafts.settleRowAfterOp) calls this, not rowDraftAfterOp. `landedVersion`
// is the row version this op's 200 returned.
//
// When a later live op holds the draft, this op's 200 leaves the held fields
// for that op to settle. If that op then never confirms (discarded, dropped as
// "locked", or fatally failed), nothing else knows what this op landed, so the
// draft would keep a stale baseline and a phantom "unsaved" reminder. So the
// held fields this op sent are recorded on the draft (DraftRecord.confirmed),
// with the version they landed at (confirmedVersion). rowDraftAfterRelease
// re-settles from them when the holding op is discarded after a 409 that
// carried the server row; otherwise the record waits for a later confirm that
// chained from it (#650). With no landed version nothing is recorded.
//
// The record is folded into a later confirm only when that op chained from it
// (its expectedVersion is the recorded version, as version threading makes
// it): it then treats the recorded fields as sent too, its own values winning.
// A confirm that did not chain from it (the record was left behind, e.g. the
// holding op was discarded in another tab) cannot vouch for it, so the record
// is dropped unused. Either way a confirm that settles drops the record, and
// one that defers again records its own values. The draft's patch is judged
// against the record by rowDraftAfterOp's rules, so typing the server never got
// (a refused save's text included) is never cleared or shrunk, only rebased.
export function rowDraftAfterConfirm(
  draft: DraftRecord | undefined,
  op: Pick<OutboxOp, "id" | "target" | "patch"> & Partial<Pick<OutboxOp, "action" | "expectedVersion">>,
  queued: OutboxOp[] | null,
  landedVersion: number | undefined,
): "clear" | DraftRecord | undefined {
  if (!draft) return undefined;
  if (op.action === "delete") return "clear";
  const chained =
    typeof draft.confirmedVersion === "number" && op.expectedVersion === draft.confirmedVersion;
  const confirmed = chained ? draft.confirmed : undefined;
  const sent = op.patch as unknown;
  const sentObject = !!sent && typeof sent === "object";
  const effective = sentObject && confirmed ? { ...op, patch: { ...confirmed, ...(sent as Record<string, unknown>) } } : op;
  const next = rowDraftAfterOp(draft, effective, queued);
  if (next === "clear") return "clear";
  let nextConfirmed: Record<string, unknown> | undefined;
  let nextVersion: number | undefined;
  if (!sentObject) {
    // An unreadable patch proves nothing about the server: keep any record.
    nextConfirmed = draft.confirmed;
    nextVersion = draft.confirmedVersion;
  } else if (typeof landedVersion === "number") {
    nextConfirmed = heldConfirmedFields(draft, effective, queued);
    nextVersion = nextConfirmed ? landedVersion : undefined;
  }
  if (sameFields(nextConfirmed, draft.confirmed) && nextVersion === draft.confirmedVersion) return next;
  const base = withoutRecord(next ?? draft);
  return nextConfirmed ? { ...base, confirmed: nextConfirmed, confirmedVersion: nextVersion } : base;
}

// Re-settle a row draft from its `confirmed` record after `released`, an op
// that may have held it, left without confirming (#632 item 1): dropped as
// "locked", ended "fatal", or discarded by the user ("drop"). `queued` is the
// outbox read after it left. Only record fields still known to be the server's
// are settled; text whose value is not on the server now is never cleared:
//   * locked: an AI apply is about to overwrite the row, so nothing is known.
//     The draft is left as it is.
//   * a discarded conflicted op: its 409 carried the server row
//     (conflictCurrent). Only fields where that row still equals the record
//     are settled; the others are proven stale and leave the record. No server
//     row: nothing is known, the draft is left.
//   * fatal, or a discarded failed op: nothing is known, so the draft is left
//     as it is, record included (#650). The row PATCH handler
//     (api/src/rows.ts) returns its fatal refusals (400, 403, 404, 428) before
//     it compares versions, so a refusal does not prove the row is still at
//     the recorded version: another user may have written since. A
//     max-attempts op's last 5xx may have committed. A stale "unsaved"
//     reminder is safe; clearing text the server does not hold is not. The
//     record stays, since a later confirm folds it in only when that op
//     chained from the recorded version and got a 200, which proves it.
// A draft with no record, or whose patch cannot be read, is left alone, as is
// one the released op could not have held (it sent none of the recorded
// fields).
export function rowDraftAfterRelease(
  draft: DraftRecord | undefined,
  released: Pick<OutboxOp, "target" | "patch" | "status"> &
    Partial<Pick<OutboxOp, "action" | "conflictCurrent">>,
  reason: "locked" | "fatal" | "drop",
  queued: OutboxOp[] | null,
): "clear" | DraftRecord | undefined {
  const confirmed = draft?.confirmed;
  if (!draft || !confirmed || reason === "locked") return undefined;
  const patch = (draft.payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object") return undefined;
  const rp = released.patch as unknown;
  const couldHold =
    released.action === "delete" ||
    !rp ||
    typeof rp !== "object" ||
    Object.keys(confirmed).some((k) => k in (rp as Record<string, unknown>));
  if (!couldHold) return undefined;
  if (released.status !== "conflict") return undefined;
  const current = released.conflictCurrent as unknown;
  if (!current || typeof current !== "object") return undefined;
  const cur = current as Record<string, unknown>;
  const trusted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(confirmed)) {
    if (k in cur && rowValueKey(cur[k]) === rowValueKey(v)) trusted[k] = v;
  }
  if (Object.keys(trusted).length === 0) return withoutRecord(draft);
  const next = rowDraftAfterConfirm(
    { ...draft, confirmed: trusted },
    { id: "", target: released.target, action: "patch", patch: {}, expectedVersion: draft.confirmedVersion },
    queued,
    draft.confirmedVersion,
  );
  // Still held by another op: keep only the fields still known to be right.
  if (next === undefined && !sameFields(trusted, confirmed)) return { ...draft, confirmed: trusted };
  return next;
}

// drafts.set() rebuilds the record on every keystroke. The `confirmed` record
// says what the server holds, which typing does not change, so a re-write
// keeps it (review round 1: an editor still open after the earlier save's 200
// would otherwise erase it, and the later save's failure would find nothing).
export function withCarriedConfirm(prev: DraftRecord | undefined, next: DraftRecord): DraftRecord {
  if (!prev?.confirmed || next.confirmed) return next;
  return { ...next, confirmed: prev.confirmed, confirmedVersion: prev.confirmedVersion };
}

function withoutRecord(draft: DraftRecord): DraftRecord {
  const { confirmed: _c, confirmedVersion: _v, ...base } = draft;
  return base;
}


// The fields of `op` a later live op still holds: every sent field when the
// hold covers any field (laterLiveRowFields null), else the shared ones.
// Undefined when nothing holds the draft or no sent field is held.
function heldConfirmedFields(
  draft: DraftRecord,
  op: Pick<OutboxOp, "id" | "target" | "patch">,
  queued: OutboxOp[] | null,
): Record<string, unknown> | undefined {
  const key = targetKey(op.target);
  if (!liveRowOpHoldsDraft(draft, key, queued, op.id)) return undefined;
  const held = laterLiveRowFields(key, queued, op.id);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op.patch as Record<string, unknown>)) {
    if (held === null || held.has(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sameFields(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (!a || !b) return a === b;
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => k in b && a[k] === b[k]);
}

// rowDraftAfterOp's partial settle while a later live op holds the draft
// (#632 item 5). `held` is every field a later live op will send (null: hold
// the whole draft). For each field this op sent that no later op sends, the
// server now keeps this op's value: drop it from the draft's patch when the
// draft holds that same value, and rebase its baseline. Held fields are left
// exactly as they are, patch and baseline, for the later op to settle.
function settleUnheldFields(
  draft: DraftRecord,
  op: Pick<OutboxOp, "patch">,
  held: Set<string> | null,
): "clear" | DraftRecord | undefined {
  if (held === null) return undefined;
  const payload = draft.payload as { patch?: unknown; baseline?: unknown };
  const sent = op.patch as unknown;
  if (!payload.patch || typeof payload.patch !== "object" || !sent || typeof sent !== "object") return undefined;
  const sentFields = sent as Record<string, unknown>;
  const patch = { ...(payload.patch as Record<string, unknown>) };
  const hasBaseline = !!payload.baseline && typeof payload.baseline === "object";
  const baseline = hasBaseline ? { ...(payload.baseline as Record<string, unknown>) } : undefined;
  let changed = false;
  for (const k of Object.keys(sentFields)) {
    if (held.has(k)) continue;
    if (k in patch && rowValueKey(patch[k]) === rowValueKey(sentFields[k])) {
      delete patch[k];
      changed = true;
    }
    if (baseline && k in baseline && baseline[k] !== sentFields[k]) {
      baseline[k] = sentFields[k];
      changed = true;
    }
  }
  if (!changed) return undefined;
  if (Object.keys(patch).length === 0) return "clear";
  return { ...draft, payload: { ...draft.payload, patch, ...(baseline ? { baseline } : {}) } };
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
