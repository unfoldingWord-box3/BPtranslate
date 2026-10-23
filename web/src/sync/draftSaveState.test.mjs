// Tests for web/src/sync/draftSaveState.ts — the generation fence that stops
// a save confirmation (outbox 200) from clearing a NEWER draft the user typed
// while the request was in flight, and stops the off-screen "Save X?" toast
// from nagging about a draft whose exact payload is already on its way to the
// server. Pure module (no IndexedDB / api.ts), so it runs from a plain Node
// strip-types script.

import assert from "node:assert/strict";
import {
  generationForSavedPlain,
  generationForSuccessfulOp,
  rowDraftHoldsSaved,
  rowDraftAfterOp,
  rowDraftSettledByOp,
  verseDraftHasActiveSave,
} from "./draftSaveState.ts";

const draft = {
  key: "verse:MIC:5:0:ULT",
  payload: { plainText: "\\q1" },
  expectedVersion: 0,
  updatedAt: 1,
  generation: "g-intro",
  meta: { kind: "verse", book: "MIC", chapter: 5, verse: 0, bibleVersion: "ULT" },
};

function op(status, overrides = {}) {
  return {
    id: `op-${status}`,
    target: { kind: "verse", book: "MIC", chapter: 5, verse: 0, bibleVersion: "ULT", ...overrides },
    action: "patch",
    patch: {},
    expectedVersion: 0,
    queuedAt: 1,
    attempts: 0,
    status,
    draftGeneration: "g-intro",
  };
}

assert.equal(verseDraftHasActiveSave(draft, [op("pending")]), true, "pending save suppresses reminder");
assert.equal(verseDraftHasActiveSave(draft, [op("in_flight")]), true, "in-flight save suppresses reminder");
assert.equal(verseDraftHasActiveSave(draft, [op("conflict")]), false, "conflicted save remains recoverable");
assert.equal(verseDraftHasActiveSave(draft, [op("failed")]), false, "failed save remains recoverable");
assert.equal(verseDraftHasActiveSave(draft, [op("pending", { verse: 1 })]), false, "verse 1 save does not hide intro draft");
assert.equal(verseDraftHasActiveSave(draft, [op("pending", { bibleVersion: "UST" })]), false, "other version does not hide intro draft");
assert.equal(
  verseDraftHasActiveSave(draft, [{ ...op("pending"), draftGeneration: "g-older" }]),
  false,
  "older in-flight save does not hide newer typing",
);
const legacyOp = {
  ...op("pending"),
  queuedAt: 2,
  draftGeneration: undefined,
  patch: { content: { verseObjects: [{ type: "quote", tag: "q1" }] } },
};
assert.equal(verseDraftHasActiveSave(draft, [legacyOp]), true, "pre-upgrade pending save suppresses its old draft");
assert.equal(
  verseDraftHasActiveSave({ ...draft, payload: { plainText: "\\q1\u00a0\n\u200b" } }, [legacyOp]),
  true,
  "pre-upgrade save matches raw editor whitespace after normalization",
);
assert.equal(
  verseDraftHasActiveSave({ ...draft, payload: { plainText: "\\q1 changed" } }, [legacyOp]),
  false,
  "pre-upgrade save does not hide newer text",
);
const unrelatedLegacyOp = {
  ...legacyOp,
  patch: { content: { verseObjects: [{ type: "word", tag: "w", text: "unrelated" }] } },
};
assert.equal(
  verseDraftHasActiveSave(draft, [unrelatedLegacyOp]),
  false,
  "unrelated legacy verse operation does not hide the text draft",
);

assert.equal(generationForSavedPlain(draft, "\\q1"), "g-intro", "matching payload carries its generation");
assert.equal(generationForSavedPlain(draft, "\\q1 changed"), undefined, "newer text is not cleared by older save");
assert.equal(
  generationForSavedPlain({ ...draft, generation: undefined }, "\\q1"),
  "legacy:1",
  "legacy draft gets a stable cleanup identity",
);
assert.equal(generationForSuccessfulOp(draft, legacyOp), "g-intro", "pre-upgrade success clears the draft it captured");
assert.equal(
  generationForSuccessfulOp({ ...draft, payload: { plainText: "\\q1 changed" } }, legacyOp),
  undefined,
  "pre-upgrade success preserves newer typing",
);
assert.equal(
  generationForSuccessfulOp(draft, unrelatedLegacyOp),
  undefined,
  "unrelated legacy verse success preserves the text draft",
);
assert.equal(
  generationForSuccessfulOp(undefined, op("pending")),
  undefined,
  "no draft (e.g. quarantined record hidden by drafts.get) means nothing to clear",
);

// A row save's 200 settles the row draft by CONTENT (#616, #618). Every editor
// stores only the fields it changed, so a draft whose every field was sent with
// the same value holds nothing the server does not now have: clear it, however
// often it was re-written and at whatever version. A draft holding a field the
// save did not send, or a different value, is newer typing: keep it. A version
// fence (#616) lost typing done after Save when the editor unmounted before the
// 200 (#618); a per-write generation fence left stale drafts when an editor
// re-wrote the same text while the save was pending (#618 review F1).
const rowDraft = (patch, extra = {}) => ({
  key: "row:twl:ZEC:w2wo",
  payload: { patch },
  expectedVersion: 6,
  updatedAt: 1,
  generation: "g1",
  meta: { kind: "row", rowKind: "twl", id: "w2wo", book: "ZEC", chapter: 1, verse: 1 },
  ...extra,
});
const rowOp = (patch) => ({
  target: { kind: "row", rowKind: "twl", id: "w2wo", book: "ZEC" },
  expectedVersion: 6,
  patch,
});
assert.equal(rowDraftSettledByOp(rowDraft({ orig_words: "X" }), rowOp({ orig_words: "X" })), true, "plain save settles its draft");
assert.equal(
  rowDraftSettledByOp(rowDraft({ orig_words: "XY" }), rowOp({ orig_words: "X" })),
  false,
  "#618: typing after Save (same version, editor since unmounted) survives",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ orig_words: "X" }, { expectedVersion: 7, generation: "g9" }), rowOp({ orig_words: "X" })),
  true,
  "F1: a re-write of the sent text at any version or generation is still settled",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ orig_words: "XY" }, { expectedVersion: 7 }), rowOp({ orig_words: "X" })),
  false,
  "#616: typing re-persisted against the confirmed version survives",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ note: "typing" }), rowOp({ sort_order: 3 })),
  false,
  "a save that did not send the draft's field (reorder) leaves the typing alone",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ question: "q2", response: "r2" }), rowOp({ question: "q2" })),
  false,
  "a draft field the save did not send keeps the draft",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ response: "r2" }), rowOp({ question: "q1", response: "r2" })),
  true,
  "grid save sends both fields; a one-field draft equal to what was sent is settled",
);
// NoteCard drafts hold display text (real newlines); its Save sends TSV (\\n).
assert.equal(
  rowDraftSettledByOp(rowDraft({ note: "a\nb", support_reference: null }), rowOp({ note: "a\\nb", support_reference: null })),
  true,
  "display-form draft equals the TSV-form patch it was saved as",
);
assert.equal(
  rowDraftSettledByOp(rowDraft({ note: "a\nbc" }), rowOp({ note: "a\\nb" })),
  false,
  "newline-normalized compare still sees newer typing",
);
assert.equal(rowDraftSettledByOp(rowDraft({ occurrence: 2 }), rowOp({ occurrence: 2 })), true, "non-string values compare as-is");
assert.equal(rowDraftSettledByOp(rowDraft({ occurrence: 2 }), rowOp({ occurrence: 3 })), false, "different number survives");
assert.equal(rowDraftSettledByOp(undefined, rowOp({ note: "x" })), false, "no draft means nothing to clear");
assert.equal(
  rowDraftSettledByOp(rowDraft({ note: "typing" }), { ...rowOp({}), action: "delete" }),
  true,
  "a confirmed delete settles the deleted row's draft (as before)",
);
assert.equal(
  rowDraftSettledByOp({ ...rowDraft({}), payload: { note: "legacy shape" } }, rowOp({ note: "x" })),
  true,
  "a draft with no readable patch keeps the old unconditional clear",
);
assert.equal(
  rowDraftSettledByOp({ ...rowDraft({}), payload: { patch: "nonsense" } }, rowOp({ note: "x" })),
  true,
  "a non-object patch keeps the old unconditional clear",
);
// #618 review A3: an op whose patch is not an object cannot prove the draft was sent.
assert.equal(rowDraftSettledByOp(rowDraft({ note: "x" }), { ...rowOp({}), patch: undefined }), false, "non-object op.patch keeps the draft");
assert.equal(rowDraftSettledByOp(rowDraft({ note: "x" }), { ...rowOp({}), patch: "x" }), false, "string op.patch keeps the draft");

// #618 review A1: an earlier op's 200 must not settle the draft while a later
// op for the same row is still queued. Save N1 (A), save N2 (B), type back to
// N1, unmount: A's 200 would clear the N1 draft and B's 200 leaves N2 on the
// server, losing N1. The last op's 200 settles it instead.
// #618 review A2: a draft that survives keeps its baseline in step with what
// the server now holds, for the fields this op sent.
const opA = { ...rowOp({ note: "N1" }), id: "A", status: "in_flight" };
const queuedOp = (over = {}) => ({ ...rowOp({ note: "N2" }), id: "B", status: "pending", ...over });
const n1Draft = rowDraft({ note: "N1" });
assert.equal(rowDraftAfterOp(n1Draft, opA, [opA]), "clear", "no later op: the matching draft is settled");
assert.notEqual(rowDraftAfterOp(n1Draft, opA, [opA, queuedOp()]), "clear", "A1: a later queued op for the row defers the clear");
assert.notEqual(rowDraftAfterOp(n1Draft, opA, [queuedOp({ status: "conflict" })]), "clear", "a conflicted later op still defers");
assert.notEqual(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ status: "failed", lastError: "max_attempts_exceeded" })]),
  "clear",
  "a failed op that will re-send on its own still defers",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ status: "failed", lastError: "http 403" })]),
  "clear",
  "a fatal failed op never re-sends, so it does not defer",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ target: { ...rowOp({}).target, id: "other" } })]),
  "clear",
  "an op for another row does not defer",
);
assert.notEqual(rowDraftAfterOp(n1Draft, opA, null), "clear", "an unreadable outbox cannot prove nothing is queued: keep");
assert.equal(rowDraftAfterOp(undefined, opA, [opA]), undefined, "no draft, nothing to do");
assert.equal(
  rowDraftAfterOp(rowDraft({ note: "typing" }), { ...rowOp({}), id: "D", action: "delete" }, [queuedOp()]),
  "clear",
  "a confirmed delete clears the draft",
);
const based = (patch, baseline) => ({ ...rowDraft(patch), payload: { patch, baseline } });
const rebased = rowDraftAfterOp(based({ note: "N1 more" }, { note: "N0", quote: "q0", support_reference: null }), opA, [opA]);
assert.deepEqual(
  rebased?.payload,
  { patch: { note: "N1 more" }, baseline: { note: "N1", quote: "q0", support_reference: null } },
  "A2: a surviving draft's baseline takes the values this op sent, other fields untouched",
);
assert.equal(rebased?.generation, "g1", "the rebase keeps the draft's identity");
const deferred = rowDraftAfterOp(based({ note: "N1" }, { note: "N0" }), opA, [queuedOp()]);
assert.deepEqual(deferred?.payload?.baseline, { note: "N1" }, "a deferred draft is rebased to what the server now holds");
assert.equal(
  rowDraftAfterOp(based({ note: "N1 more" }, { question: "q0" }), opA, [opA]),
  undefined,
  "a baseline without the sent field is left alone",
);
assert.equal(rowDraftAfterOp(rowDraft({ note: "N1 more" }), opA, [opA]), undefined, "a draft with no baseline is left alone");

// #616 review A1: the flows screens move their baseline only after the 200. A
// draft re-written at v+1 before that (refetch during the save) holds exactly
// the saved text, so it must be cleared once the baseline moves. A draft that
// holds anything else is newer typing and stays.
const tnDraft = (patch) => ({ ...rowDraft({}, { expectedVersion: 7 }), payload: { patch, baseline: { note: "old" } } });
assert.equal(rowDraftHoldsSaved(tnDraft({ note: "saved" }), { note: "saved" }), true, "draft equal to the saved text");
assert.equal(rowDraftHoldsSaved(tnDraft({ note: "saved more" }), { note: "saved" }), false, "newer typing survives");
// A field missing from the patch means "equal to the draft's baseline", not
// "don't care": saved {q2, r2}, refetch to v+1 mid-save, user types the
// response back to r1 -> draft {question: q2}. Clearing it would lose r1.
assert.equal(
  rowDraftHoldsSaved(tnDraft({ question: "q2" }), { question: "q2", response: "r2" }),
  false,
  "partial patch: a saved field missing from the patch keeps the draft",
);
assert.equal(
  rowDraftHoldsSaved(tnDraft({ question: "q2", response: "r2" }), { question: "q2", response: "r2" }),
  true,
  "patch covering every saved field with equal values",
);
assert.equal(
  rowDraftHoldsSaved(tnDraft({ question: "q2", response: "r2", ref_raw: "1:2" }), { question: "q2", response: "r2" }),
  false,
  "extra field beyond the saved ones keeps the draft",
);
assert.equal(
  rowDraftHoldsSaved(tnDraft({ question: "q2", response: "r2" }), { question: "q2", response: "r" }),
  false,
  "one field differs: keep",
);
assert.equal(rowDraftHoldsSaved(tnDraft({}), { note: "saved" }), false, "empty patch is not ours to clear");
assert.equal(rowDraftHoldsSaved(undefined, { note: "saved" }), false, "no draft");

console.log("draftSaveState: 57 passed");
