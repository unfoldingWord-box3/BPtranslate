// Tests for web/src/sync/refusedRowDraft.ts (issue #647): when a row save is
// refused (a fatal 4xx, or a 409 "chapter_locked" the outbox drops), the text
// it carried is written back to the row's draft so it is not lost. The classic
// tQ / tW-link editors cleared their draft at Save, so before this the text
// lived only in React state.

import test from "node:test";
import assert from "node:assert/strict";
import {
  afterConfirmKeepingRefusal,
  keepsRefusedText,
  rowDraftAfterRefusal,
  rowDraftAfterRefusedDiscard,
  rowDraftOnNoDiff,
  withCarriedRefusal,
} from "./refusedRowDraft.ts";

const target = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC" };
const meta = { kind: "row", rowKind: "tq", id: "q-1", book: "ZEC", chapter: 9, verse: 2 };

function op(patch, extra = {}) {
  return {
    id: "op-1",
    target,
    action: "patch",
    patch,
    expectedVersion: 4,
    queuedAt: 0,
    attempts: 1,
    status: "failed",
    draftRef: { chapter: 9, verse: 2 },
    ...extra,
  };
}

function draft(payload, extra = {}) {
  return {
    key: "row:tq:ZEC:q-1",
    payload,
    expectedVersion: 4,
    updatedAt: 1,
    generation: "g-old",
    meta,
    ...extra,
  };
}

const at = { now: 100, generation: "g-new" };

test("no draft: the refused text becomes the row's draft, marked refused", () => {
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [], at);
  assert.deepEqual(out, {
    key: "row:tq:ZEC:q-1",
    payload: { patch: { question: "ABC" } },
    expectedVersion: 4,
    updatedAt: 100,
    generation: "g-new",
    meta,
    refused: { question: "ABC" },
  });
});

test("newer typing wins: a field the draft already holds is left as typed", () => {
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", draft({ patch: { question: "ABCD" } }), op({ question: "ABC" }), [], at);
  assert.equal(out, undefined);
});

test("A2: a draft still holding the refused value for a field gets it marked refused", () => {
  // The refusal beat the editor's post-Save clear: the draft still holds what
  // was sent. Marking it lets the following no-diff clear keep it.
  const existing = draft({ patch: { question: "ABC" } });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", existing, op({ question: "ABC" }), [], at);
  assert.deepEqual(out.payload, { patch: { question: "ABC" } });
  assert.deepEqual(out.refused, { question: "ABC" });
  // Already marked with that value: nothing to write.
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", out, op({ question: "ABC" }), [], at), undefined);
});

test("a field the draft does not hold is added; the draft's own fields stay", () => {
  const existing = draft({ patch: { response: "R2" } }, { confirmed: { response: "R1" }, confirmedVersion: 4 });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", existing, op({ question: "ABC", response: "R-old" }), [], at);
  assert.deepEqual(out, {
    ...existing,
    payload: { patch: { response: "R2", question: "ABC" } },
    updatedAt: 100,
    generation: "g-new",
    refused: { question: "ABC" },
  });
});

test("a draft with a baseline for the field (NoteCard, flows) already tracks it: nothing added", () => {
  // NoteCard pins its baseline to the server copy, so a field missing from the
  // patch means the user typed it back to the server value.
  const existing = draft({ patch: { quote: "q" }, baseline: { quote: "q0", note: "n0", support_reference: null } }, {
    key: "row:tn:ZEC:n-1",
    meta: { ...meta, rowKind: "tn", id: "n-1" },
  });
  const tnOp = op({ note: "typed" }, { target: { ...target, rowKind: "tn", id: "n-1" } });
  assert.equal(rowDraftAfterRefusal("row:tn:ZEC:n-1", existing, tnOp, [], at), undefined);
});

test("a later live save for the same field holds newer text: that field is not written back", () => {
  const later = op({ question: "ABCD" }, { id: "op-2", status: "pending", queuedAt: 5 });
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [later], at), undefined);
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC", response: "R" }), [later], at);
  assert.deepEqual(out.payload, { patch: { response: "R" } });
  assert.deepEqual(out.refused, { response: "R" });
});

test("a refused later op that is no longer live (failed, or another row's) does not hold the field", () => {
  const failed = op({ question: "ABCD" }, { id: "op-2", status: "failed", lastError: "http 422" });
  const otherRow = op({ question: "X" }, { id: "op-3", status: "pending", target: { ...target, id: "q-2" } });
  const self = op({ question: "ABC" }, { status: "failed" });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [failed, otherRow, self], at);
  assert.deepEqual(out.payload, { patch: { question: "ABC" } });
});

test("a pending delete for the row, or an unreadable outbox, writes nothing", () => {
  const del = op({}, { id: "op-2", status: "pending", action: "delete", queuedAt: 5 });
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [del], at), undefined);
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), null, at), undefined);
});

test("only editor text fields are kept: a reorder or move is not", () => {
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ sort_order: 3 }), [], at), undefined);
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ sort_order: 3, response: "R" }), [], at);
  assert.deepEqual(out.payload, { patch: { response: "R" } });
  const tn = op({ verse: 3, ref_raw: "9:3", sort_order: 1 }, { target: { ...target, rowKind: "tn" } });
  assert.equal(rowDraftAfterRefusal("row:tn:ZEC:q-1", undefined, tn, [], at), undefined);
});

test("tW-link and tN fields the classic editors restore are kept", () => {
  const twl = op({ orig_words: "קדש", tw_link: "rc://*/tw/dict/bible/kt/holy", occurrence: 2 }, {
    target: { ...target, rowKind: "twl" },
  });
  const outTwl = rowDraftAfterRefusal("row:twl:ZEC:q-1", undefined, twl, [], at);
  assert.deepEqual(outTwl.payload.patch, { orig_words: "קדש", tw_link: "rc://*/tw/dict/bible/kt/holy", occurrence: 2 });
  assert.equal(outTwl.meta.rowKind, "twl");
  const tn = op({ note: "line\\nnext", quote: "q", support_reference: null }, { target: { ...target, rowKind: "tn" } });
  const outTn = rowDraftAfterRefusal("row:tn:ZEC:q-1", undefined, tn, [], at);
  assert.deepEqual(outTn.payload.patch, { note: "line\\nnext", quote: "q", support_reference: null });
});

test("a delete, a non-row op, or no place to file it (no draft, no draftRef) writes nothing", () => {
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({}, { action: "delete" }), [], at), undefined);
  const verse = op({ content: [] }, { target: { kind: "verse", book: "ZEC", chapter: 9, verse: 2, bibleVersion: "ULT" } });
  assert.equal(rowDraftAfterRefusal("verse:ZEC:9:2:ULT", undefined, verse, [], at), undefined);
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }, { draftRef: undefined }), [], at), undefined);
});

test("an existing draft without a draftRef on the op still gets the text, under the draft's meta", () => {
  const existing = draft({ patch: { response: "R2" } });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", existing, op({ question: "ABC" }, { draftRef: undefined }), [], at);
  assert.deepEqual(out.payload.patch, { response: "R2", question: "ABC" });
  assert.equal(out.meta, meta);
});

test("a quarantined draft is left alone", () => {
  const existing = draft({ patch: {} }, { quarantined: "lane frozen" });
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", existing, op({ question: "ABC" }), [], at), undefined);
});

test("a second refusal adds to the refused record", () => {
  const first = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [], at);
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", first, op({ response: "R" }, { id: "op-2" }), [], { now: 200, generation: "g-3" });
  assert.deepEqual(out.payload.patch, { question: "ABC", response: "R" });
  assert.deepEqual(out.refused, { question: "ABC", response: "R" });
});

test("only a live save queued after the refused one holds a field; an unreadable patch is skipped", () => {
  const earlier = op({ question: "OLD" }, { id: "op-0", status: "conflict", queuedAt: -5 });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [earlier], at);
  assert.deepEqual(out.payload, { patch: { question: "ABC" } });
  const sameMsLater = op({ question: "ABCD" }, { id: "op-2", status: "pending", queuedAt: 0, seq: 2 });
  assert.equal(rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }, { seq: 1 }), [sameMsLater], at), undefined);
  const odd = op(null, { id: "op-3", status: "pending", queuedAt: 5 });
  const out2 = rowDraftAfterRefusal("row:tq:ZEC:q-1", undefined, op({ question: "ABC" }), [odd], at);
  assert.deepEqual(out2.payload, { patch: { question: "ABC" } });
});

test("A6: a fatal that means the row is gone keeps nothing; other refusals do", () => {
  assert.equal(keepsRefusedText({ kind: "fatal", reason: "http 404" }), false);
  assert.equal(keepsRefusedText({ kind: "fatal", reason: "http 422" }), true);
  assert.equal(keepsRefusedText({ kind: "fatal", reason: "http 403" }), true);
  assert.equal(keepsRefusedText({ kind: "locked", lockBody: { error: "chapter_locked", jobId: "j" } }), true);
  assert.equal(keepsRefusedText({ kind: "ok", updated: {} }), false);
  assert.equal(keepsRefusedText({ kind: "conflict", current: {} }), false);
});

const refusedDraft = (patch, refused, extra = {}) => draft({ patch }, { refused, ...extra });

test("A1: a re-write keeps refused fields the new patch leaves out", () => {
  // Refused question, then the user edits response: the editor's diff against
  // the optimistic row is {response} only.
  const prev = refusedDraft({ question: "ABC" }, { question: "ABC" });
  const next = draft({ patch: { response: "R2" } }, { generation: "g-2", updatedAt: 9 });
  const out = withCarriedRefusal(prev, next);
  assert.deepEqual(out.payload, { patch: { response: "R2", question: "ABC" } });
  assert.deepEqual(out.refused, { question: "ABC" });
  assert.equal(out.generation, "g-2");
});

test("A1: a field the new patch holds wins, and stays refused so a later no-diff can restore it", () => {
  const prev = refusedDraft({ question: "ABC" }, { question: "ABC" });
  const next = draft({ patch: { question: "ABCX" } });
  const out = withCarriedRefusal(prev, next);
  assert.deepEqual(out.payload, { patch: { question: "ABCX" } });
  assert.deepEqual(out.refused, { question: "ABC" });
});

test("A1: a draft with a baseline for the field (NoteCard) carries nothing; no refused record, no change", () => {
  const prev = refusedDraft({ note: "N" }, { note: "N" });
  const next = draft({ patch: {}, baseline: { note: "n0", quote: "q", support_reference: null } });
  assert.equal(withCarriedRefusal(prev, next), next);
  const plain = draft({ patch: { response: "R" } });
  assert.equal(withCarriedRefusal(draft({ patch: {} }), plain), plain);
  assert.equal(withCarriedRefusal(undefined, plain), plain);
});

test("A1: backspacing to no diff keeps exactly the refused text", () => {
  // Typed ABCX over the refused ABC, then back to ABC: the editor sees no diff.
  const rec = refusedDraft({ question: "ABCX", response: "R2" }, { question: "ABC" });
  const out = rowDraftOnNoDiff(rec, { question: "ABC", response: "R2" }, []);
  assert.deepEqual(out.payload, { patch: { question: "ABC" } });
  assert.deepEqual(out.refused, { question: "ABC" });
  assert.equal(rowDraftOnNoDiff(refusedDraft({ question: "ABC" }, { question: "ABC" }), { question: "ABC" }, []), undefined);
  assert.equal(rowDraftOnNoDiff(draft({ patch: { question: "x" } }), {}, []), "clear");
  assert.equal(rowDraftOnNoDiff(refusedDraft({}, {}, { quarantined: "q" }), {}, []), undefined);
});

test("B1: no diff because the user saved newer text for the refused field: the refused text is superseded", () => {
  // Refused ABC, then typed XYZ and saved: the row shows XYZ and a live save sends it.
  const rec = refusedDraft({ question: "XYZ" }, { question: "ABC" });
  const op2 = op({ question: "XYZ" }, { id: "op-2", status: "pending", queuedAt: 5 });
  assert.equal(rowDraftOnNoDiff(rec, { question: "XYZ" }, [op2]), "clear");
  // Another refused field still showing stays.
  const two = refusedDraft({ question: "XYZ", response: "R" }, { question: "ABC", response: "R" });
  const out = rowDraftOnNoDiff(two, { question: "XYZ", response: "R" }, [op2]);
  assert.deepEqual(out.payload, { patch: { response: "R" } });
  assert.deepEqual(out.refused, { response: "R" });
});

test("B1: no diff with other text on screen but no live save sending it (row reverted to the server copy): kept", () => {
  const rec = refusedDraft({ question: "ABC" }, { question: "ABC" });
  assert.equal(rowDraftOnNoDiff(rec, { question: "SERVER" }, []), undefined);
  // A failed save is not live; an unreadable outbox keeps it too.
  const failed = op({ question: "SERVER" }, { id: "op-2", status: "failed", lastError: "http 422" });
  assert.equal(rowDraftOnNoDiff(rec, { question: "SERVER" }, [failed]), undefined);
  assert.equal(rowDraftOnNoDiff(rec, { question: "SERVER" }, null), undefined);
});

test("B1(a): the superseding save's 200 drops the stale refused text from the patch too", () => {
  // The no-diff shrink ran before the live save was visible: draft holds ABC.
  const rec = refusedDraft({ question: "ABC" }, { question: "ABC" });
  assert.equal(afterConfirmKeepingRefusal(rec, undefined, op({ question: "XYZ" })), "clear");
  const withOther = refusedDraft({ question: "ABC", ref_raw: "9:3" }, { question: "ABC" });
  const out = afterConfirmKeepingRefusal(withOther, undefined, op({ question: "XYZ" }));
  assert.deepEqual(out.payload, { patch: { ref_raw: "9:3" } });
  assert.equal("refused" in out, false);
});

test("B1(b): a later refusal replaces text that is only the earlier refused value", () => {
  const rec = refusedDraft({ question: "ABC" }, { question: "ABC" });
  const out = rowDraftAfterRefusal("row:tq:ZEC:q-1", rec, op({ question: "XYZ" }, { id: "op-2" }), [], at);
  assert.deepEqual(out.payload, { patch: { question: "XYZ" } });
  assert.deepEqual(out.refused, { question: "XYZ" });
});

test("A1: a confirmed save that did not send a refused field keeps it; one that sent it ends the record", () => {
  const rec = refusedDraft({ question: "ABC", response: "R2" }, { question: "ABC" });
  // rowDraftAfterConfirm left the draft (question unsent): kept as is.
  assert.equal(afterConfirmKeepingRefusal(rec, undefined, op({ response: "R2" })), undefined);
  const rebased = { ...rec, payload: { ...rec.payload, baseline: { response: "R2" } } };
  assert.equal(afterConfirmKeepingRefusal(rec, rebased, op({ response: "R2" })), rebased);
  assert.equal(afterConfirmKeepingRefusal(rec, "clear", op({ question: "ABC" })), "clear");
  // A save that sent question (other text) confirms the server holds that,
  // so the refused value is no longer what the row shows.
  const typed = refusedDraft({ question: "ABCD" }, { question: "ABC" });
  const out = afterConfirmKeepingRefusal(typed, undefined, op({ question: "XYZ" }));
  assert.deepEqual(out.payload, { patch: { question: "ABCD" } });
  assert.equal("refused" in out, false);
});

test("A5: discarding the failed op removes the text it wrote back", () => {
  const failed = op({ question: "ABC", response: "R" });
  assert.equal(rowDraftAfterRefusedDiscard(refusedDraft({ question: "ABC", response: "R" }, { question: "ABC", response: "R" }), failed), "clear");
  // Other typing in the draft stays; so does newer text in a refused field.
  const mixed = refusedDraft({ question: "ABCD", response: "R", ref_raw: "9:2" }, { question: "ABC", response: "R" });
  const out = rowDraftAfterRefusedDiscard(mixed, failed);
  assert.deepEqual(out.payload, { patch: { question: "ABCD", ref_raw: "9:2" } });
  assert.equal("refused" in out, false);
  // A record from another refusal (other value) is not this op's to drop.
  const other = refusedDraft({ question: "Q2" }, { question: "Q2" });
  assert.equal(rowDraftAfterRefusedDiscard(other, failed), undefined);
  assert.equal(rowDraftAfterRefusedDiscard(draft({ patch: { question: "ABC" } }), failed), undefined);
  assert.equal(rowDraftAfterRefusedDiscard(undefined, failed), undefined);
});
