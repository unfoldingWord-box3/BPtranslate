// Tests for web/src/sync/refusedRowDraft.ts (issue #647): when a row save is
// refused (a fatal 4xx, or a 409 "chapter_locked" the outbox drops), the text
// it carried is written back to the row's draft so it is not lost. The classic
// tQ / tW-link editors cleared their draft at Save, so before this the text
// lived only in React state.

import test from "node:test";
import assert from "node:assert/strict";
import { rowDraftAfterRefusal } from "./refusedRowDraft.ts";

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
  const later = op({ question: "ABCD" }, { id: "op-2", status: "pending" });
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
  const del = op({}, { id: "op-2", status: "pending", action: "delete" });
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
