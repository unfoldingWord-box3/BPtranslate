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
  rowDraftAfterConfirm,
  rowDraftAfterRelease,
  withCarriedConfirm,
  liveRowOpHoldsDraft,
  rowDraftSettledByOp,
  verseDraftHasActiveSave,
  withPendingReverts,
  isPendingRowSave,
  rowSaveEnded,
  pendingRevertSave,
  revertMarks,
  isEditorsPendingSave,
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
// #618 review round 3, Claude F1: a deferred draft keeps its baseline. Save N1
// (A), save N2 (B), type back to N1, leave. If A's 200 rebased the baseline to
// N1, reopening the row before B lands would see draft == baseline, drop the
// draft, and B would leave N2 on the server: N1 lost. Only the last op rebases.
assert.equal(
  rowDraftAfterOp(based({ note: "N1" }, { note: "N0" }), opA, [queuedOp()]),
  undefined,
  "F1: a deferred draft is left untouched (no baseline rebase while a later op is queued)",
);
// Codex F2: A's settle read the outbox while B was live, then B settled and
// rebased the baseline to N2. A must not write its N1 over that.
assert.equal(
  rowDraftAfterOp(based({ note: "N1" }, { note: "N2" }), opA, [opA, queuedOp()]),
  undefined,
  "F2: a settle that saw a later op queued writes nothing, so it cannot undo the later op's rebase",
);
// #618 review round 4, Claude F1: only a later op that could settle the draft
// holds it. A reorder ({sort_order}) queued behind the note save can never
// settle a {note} draft, so deferring to it would strand the draft (phantom
// "unsaved"; typing back to N0 would then clear it with nothing sent).
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [opA, queuedOp({ patch: { sort_order: 3 } })]),
  "clear",
  "R4: a later op that sends none of the draft's fields does not defer the clear",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ patch: { note: "N2", support_reference: null } })]),
  undefined,
  "R4: a later op that shares a field with the draft still defers",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ action: "delete", patch: {} })]),
  undefined,
  "R4: a later delete still defers (it settles any draft)",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ patch: undefined })]),
  undefined,
  "R4: a later op with an unreadable patch still defers",
);
assert.equal(
  rowDraftAfterOp({ ...rowDraft({}), payload: { note: "legacy shape" } }, opA, [queuedOp({ patch: { sort_order: 3 } })]),
  undefined,
  "R4: a draft with no readable patch keeps deferring to any later op",
);
assert.equal(
  rowDraftAfterOp(n1Draft, opA, [queuedOp({ patch: { sort_order: 3 }, status: "conflict" })]),
  "clear",
  "R4: a non-overlapping op does not defer whatever its status",
);
// #618 review round 5 (Codex): the flows screens' own post-save clear
// (drafts.clearRowIfSaved) must apply the same hold as the outbox settle. The
// screen saved N1 and its op is already gone from the outbox; a later save B
// (N2) for the row is still live and the draft was typed back to N1. Clearing
// it would let B land N2 and lose N1.
const rowK = "row:twl:ZEC:w2wo";
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, [queuedOp()]), true, "R5: a live overlapping op holds a draft holding exactly the saved values");
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, []), false, "R5: no live op: clear as before");
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, null), true, "R5: an unreadable outbox keeps the draft");
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, [queuedOp({ patch: { sort_order: 3 } })]), false, "R5: a non-overlapping op does not hold it");
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, [queuedOp({ status: "failed", lastError: "http 403" })]), false, "R5: a fatal failed op does not hold it");
assert.equal(liveRowOpHoldsDraft(n1Draft, "row:twl:ZEC:other", [queuedOp()]), false, "R5: an op for another row does not hold it");
assert.equal(liveRowOpHoldsDraft(n1Draft, rowK, [queuedOp()], "B"), false, "R5: the excluded op (the one being settled) does not hold it");
assert.equal(
  rowDraftAfterOp(based({ note: "N1 more" }, { note: "N0" }), opA, null),
  undefined,
  "an unreadable outbox neither clears nor rebases",
);
assert.equal(
  rowDraftAfterOp(based({ note: "N1 more" }, { question: "q0" }), opA, [opA]),
  undefined,
  "a baseline without the sent field is left alone",
);
assert.equal(rowDraftAfterOp(rowDraft({ note: "N1 more" }), opA, [opA]), undefined, "a draft with no baseline is left alone");

// #632 item 5: partial-overlap stranding. ReviewQueue's card draft holds
// {response, question} but its Save sends only the field. Op1 {response: R1},
// op2 {question: Q1}, unmount before both 200s. Op1 defers (op2 shares
// `question`), op2 keeps the draft (it did not send `response`): a phantom
// unsaved response R1 against baseline R0 while the server holds R1. Op1 now
// settles the fields no later live op sends, and leaves the rest to op2.
const tqDraft = (patch, baseline) => ({ ...rowDraft(patch), payload: { patch, baseline } });
const op1 = { ...rowOp({ response: "R1" }), id: "1", status: "in_flight" };
const op2 = { ...rowOp({ question: "Q1" }), id: "2", status: "pending" };
const afterOp1 = rowDraftAfterOp(
  tqDraft({ response: "R1", question: "Q1" }, { response: "R0", question: "Q0" }),
  op1,
  [op1, op2],
);
assert.deepEqual(
  afterOp1?.payload,
  { patch: { question: "Q1" }, baseline: { response: "R1", question: "Q0" } },
  "#632.5: op1 settles the field no later op sends; the shared field is left to op2",
);
assert.equal(afterOp1?.generation, "g1", "#632.5: the partial settle keeps the draft's identity");
assert.equal(rowDraftAfterOp(afterOp1, op2, [op2]), "clear", "#632.5: op2's 200 then settles the rest");
// A field op1 sent that a later op also sends stays exactly as it was, patch
// and baseline (round 3 F1: N1 survives a queued N2).
assert.deepEqual(
  rowDraftAfterOp(
    tqDraft({ note: "N1", support_reference: "X" }, { note: "N0", support_reference: "X0" }),
    { ...rowOp({ note: "N1", support_reference: "X" }), id: "A", status: "in_flight" },
    [queuedOp({ patch: { note: "N2" } })],
  )?.payload,
  { patch: { note: "N1" }, baseline: { note: "N0", support_reference: "X" } },
  "#632.5: the held field keeps its value and baseline; only the unshared field settles",
);
// Typing after op1 on a field no later op sends stays unsaved, but its baseline
// follows the server (R1), so typing back to R1 later is not a silent drop.
assert.deepEqual(
  rowDraftAfterOp(tqDraft({ response: "R2", question: "Q1" }, { response: "R0", question: "Q0" }), op1, [op2])?.payload,
  { patch: { response: "R2", question: "Q1" }, baseline: { response: "R1", question: "Q0" } },
  "#632.5: newer typing on an unshared field is kept, with its baseline rebased",
);
const t5Draft = tqDraft({ response: "R1", question: "Q1" }, { response: "R0", question: "Q0" });
assert.equal(rowDraftAfterOp(t5Draft, op1, [op2, queuedOp({ id: "D", action: "delete", patch: {} })]), undefined, "#632.5: a later delete holds everything");
assert.equal(rowDraftAfterOp(t5Draft, op1, [op2, queuedOp({ id: "U", patch: undefined })]), undefined, "#632.5: a later unreadable patch holds everything");
assert.equal(rowDraftAfterOp(t5Draft, op1, null), undefined, "#632.5: an unreadable outbox holds everything");
assert.equal(
  rowDraftAfterOp(t5Draft, op1, [op2, queuedOp({ id: "R", patch: { response: "R9" } })]),
  undefined,
  "#632.5: a later op sending the field too defers it, so nothing settles",
);
assert.equal(
  rowDraftAfterOp({ ...rowDraft({}), payload: { note: "legacy shape" } }, opA, [queuedOp()]),
  undefined,
  "#632.5: a draft with no readable patch is still held whole",
);

// #632 item 1: a deferred settle whose holding op never confirms. Save N1 (A),
// save N2 (B); A's 200 defers to B. If B is then discarded after a conflict,
// dropped as "locked", or fails fatally, nothing used to settle the draft: a
// stale "unsaved" reminder against baseline N0 while the server holds N1, and
// typing back to N0 cleared it with nothing sent. A's deferral now records
// what it landed on the draft (`confirmed`, at the version A landed), and the
// release re-settles from it, only where that value is still the server's.
// A sent at v6 and landed at v7; B was threaded to v7 (threadVersionToSiblings).
const rowTarget = rowOp({}).target;
const opB = (over = {}) => queuedOp({ expectedVersion: 7, ...over });
const heldN1 = rowDraftAfterConfirm(based({ note: "N1" }, { note: "N0" }), opA, [opB()], 7);
assert.deepEqual(
  heldN1?.payload,
  { patch: { note: "N1" }, baseline: { note: "N0" } },
  "#632.1: a deferred settle still leaves patch and baseline to the later op",
);
assert.deepEqual(heldN1?.confirmed, { note: "N1" }, "#632.1: the deferred settle records what it landed");
assert.equal(heldN1?.confirmedVersion, 7, "#632.1: ...and the version it landed at");
assert.equal(heldN1?.generation, "g1", "#632.1: recording keeps the draft's identity");
assert.equal(
  rowDraftAfterConfirm(based({ note: "N1" }, { note: "N0" }), opA, [opB()], undefined)?.confirmed,
  undefined,
  "#632.1: no landed version, nothing recorded",
);
const failedB = opB({ status: "failed", lastError: "http 403" });
// #650: a fatal release or a discarded failed op proves nothing about the
// server row, so the draft is left as it is, record included (it waits for a
// later confirm that chains from it). Only a discarded 409 settles (below).
assert.equal(rowDraftAfterRelease(heldN1, failedB, "fatal", [failedB]), undefined, "#650: B failed fatally, the draft is left as it is");
assert.equal(
  rowDraftAfterRelease(heldN1, failedB, "fatal", [opB({ id: "C", status: "conflict" })]),
  undefined,
  "#632.1: another conflicted op still holds it",
);
assert.equal(rowDraftAfterRelease(heldN1, failedB, "fatal", null), undefined, "#632.1: an unreadable outbox holds it");
// #650: a refusal does not prove the row is still at the recorded version. The
// row PATCH handler (api/src/rows.ts) returns its 400/403/404/428 refusals
// before it compares versions (its only fatal after the check is a 404 for a
// row deleted meanwhile), so another user may have written X at v8 before B
// was refused. A draft equal to
// the record (N1) must be kept, not cleared. Same for a discarded max-attempts
// op, whose last 5xx may have committed.
for (const lastError of ["http 403", "http 404", "http 400", "http 428"]) {
  const refused = rowDraftAfterRelease(heldN1, opB({ status: "failed", lastError }), "fatal", []);
  assert.equal(refused, undefined, `#650: a fatal ${lastError} release leaves the draft (patch, baseline, record) as it is`);
}
const droppedFailed = rowDraftAfterRelease(heldN1, opB({ status: "failed", lastError: "max_attempts_exceeded" }), "drop", []);
assert.equal(droppedFailed, undefined, "#650: discarding a max-attempts op leaves the draft (patch, baseline, record) as it is");
// The kept record still settles the draft once a later save that chained from
// it (C, another field at v7) gets a 200, which proves the row was at v7.
assert.equal(
  rowDraftAfterConfirm(heldN1, opB({ id: "C", status: "in_flight", patch: { quote: "Q2" } }), [], 8),
  "clear",
  "#650: a later chained confirm still settles against the kept record",
);
// The refused save's own text is never cleared or shrunk: only the baseline
// moves to what A landed (here proven by a discarded 409 whose row holds N1),
// so typing back to N0 later is a real change.
const heldN2 = rowDraftAfterConfirm(based({ note: "N2" }, { note: "N0" }), opA, [opB()], 7);
const releasedN2 = rowDraftAfterRelease(heldN2, opB({ status: "conflict", conflictCurrent: { note: "N1", version: 8 } }), "drop", []);
assert.deepEqual(
  releasedN2?.payload,
  { patch: { note: "N2" }, baseline: { note: "N1" } },
  "#632.1: B's refused text N2 stays in the draft; the baseline follows the server (N1)",
);
assert.equal(releasedN2?.confirmed, undefined, "#632.1: a release that settles drops the record");
// Review round 1, F1: a 409 proves the server moved on. Another user wrote X
// after A landed; B 409s and is discarded. The draft (typed back to N1) is
// not on the server, so it must be kept.
const conflictedB = (current) => opB({ status: "conflict", conflictCurrent: current });
const movedOn = rowDraftAfterRelease(heldN1, conflictedB({ note: "X", version: 8 }), "drop", []);
assert.notEqual(movedOn, "clear", "F1: a discard after a 409 never clears text the server no longer holds");
assert.deepEqual(movedOn?.payload, heldN1.payload, "F1: the draft's patch and baseline are kept as they were");
assert.equal(movedOn?.confirmed, undefined, "F1: the disproved record is dropped");
assert.equal(
  rowDraftAfterRelease(heldN1, conflictedB({ note: "N1", quote: "Q9", version: 8 }), "drop", []),
  "clear",
  "F1: the 409's row still holds N1 (another field moved): the draft settles",
);
assert.equal(rowDraftAfterRelease(heldN1, conflictedB(undefined), "drop", []), undefined, "F1: a conflict with no server row proves nothing");
assert.equal(rowDraftAfterRelease(heldN1, opB(), "locked", []), undefined, "F1: locked (an AI apply will overwrite the row): leave the draft");
// F5: a fatal op that did not chain from the record does not settle against it
// either (#650: no fatal release does).
assert.equal(
  rowDraftAfterRelease(heldN1, opB({ status: "failed", lastError: "http 403", expectedVersion: 12 }), "fatal", []),
  undefined,
  "F5: an op that did not chain from the record leaves the draft as it is",
);
assert.equal(
  rowDraftAfterRelease(heldN1, opB({ status: "failed", lastError: "http 403", patch: { sort_order: 3 } }), "fatal", []),
  undefined,
  "#632.1: a released op that could not hold the draft (a reorder) changes nothing",
);
// F3: a draft whose patch cannot be read is never cleared by a release.
assert.equal(
  rowDraftAfterRelease({ ...rowDraft({}), payload: { note: "legacy shape" }, confirmed: { note: "N1" }, confirmedVersion: 7 }, failedB, "fatal", []),
  undefined,
  "F3: a release never clears an unreadable draft, record or not",
);
// B confirms instead: B's values win over A's record, and the record goes.
const afterB = rowDraftAfterConfirm(heldN1, opB({ status: "in_flight" }), [], 8);
assert.deepEqual(
  afterB?.payload,
  { patch: { note: "N1" }, baseline: { note: "N2" } },
  "#632.1: B's 200 keeps the typed-back N1 and rebases to N2, not A's N1",
);
assert.equal(afterB?.confirmed, undefined, "#632.1: B's settle drops A's record");
// B itself deferred to C: the record now holds B's value.
const bDeferred = rowDraftAfterConfirm(heldN1, opB({ status: "in_flight" }), [opB({ id: "C", patch: { note: "N3" }, expectedVersion: 8 })], 8);
assert.deepEqual(bDeferred?.confirmed, { note: "N2" }, "#632.1: a later deferral overwrites the record with its own values");
assert.equal(bDeferred?.confirmedVersion, 8, "#632.1: ...at its own landed version");
// F5: a record left behind (B discarded in another tab) is folded only into a
// confirm that chained from it. Record {quote: Q1} at v7; a much later save of
// the note alone at v12 must not settle the quote against the stale record.
const staleRecord = { ...tqDraft({ quote: "Q1", note: "N5" }, { quote: "Q0", note: "N0" }), confirmed: { quote: "Q1" }, confirmedVersion: 7 };
const lateC = { ...rowOp({ note: "N5" }), id: "C", status: "in_flight", expectedVersion: 12 };
const afterLateC = rowDraftAfterConfirm(staleRecord, lateC, [], 13);
assert.deepEqual(
  afterLateC?.payload,
  { patch: { quote: "Q1", note: "N5" }, baseline: { quote: "Q0", note: "N5" } },
  "F5: an unchained confirm ignores the stale record (the quote stays unsaved)",
);
assert.equal(afterLateC?.confirmed, undefined, "F5: ...and drops it");
assert.equal(
  rowDraftAfterConfirm(staleRecord, { ...lateC, expectedVersion: 7 }, [], 8),
  "clear",
  "F5: a confirm that chained from the record folds it in",
);
// Only held fields are recorded; the rest settled at once (#632 item 5).
assert.deepEqual(
  rowDraftAfterConfirm(
    tqDraft({ response: "R1", question: "Q1" }, { response: "R0", question: "Q0" }),
    { ...rowOp({ response: "R1", question: "Q1" }), id: "1", status: "in_flight" },
    [{ ...rowOp({ question: "Q2" }), id: "2", status: "pending" }],
    7,
  ),
  {
    ...tqDraft({ question: "Q1" }, { response: "R1", question: "Q0" }),
    confirmed: { question: "Q1" },
    confirmedVersion: 7,
  },
  "#632.1: only the field the later op holds is recorded",
);
assert.equal(rowDraftAfterConfirm(n1Draft, opA, [opA], 7), "clear", "#632.1: no later op, a plain settle as before");
assert.equal(rowDraftAfterRelease(n1Draft, failedB, "fatal", []), undefined, "#632.1: no record, a release does nothing");
// F2 (Codex) / F4: set() rebuilds the record on every keystroke; an editor
// still open after A's 200 must not erase the record, or B's failure finds
// nothing to settle against.
const typed = { ...rowDraft({ note: "N1 more" }), generation: "g2" };
assert.deepEqual(
  withCarriedConfirm(heldN1, typed),
  { ...typed, confirmed: { note: "N1" }, confirmedVersion: 7 },
  "F4: a re-write keeps the record",
);
assert.equal(withCarriedConfirm(n1Draft, typed), typed, "F4: nothing to carry");
assert.equal(withCarriedConfirm(undefined, typed), typed, "F4: no previous record");

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

// #632 item 2: type-back of one field plus an edit of another while a save is
// pending. Baseline {quote: Q0, note: N0}; Save {note: N1}; while it is
// pending, type the note back to N0 and edit the quote to Q1, then leave. The
// editor's diff against its pre-save baseline leaves `note` out (N0 equals the
// baseline), so the draft was {quote: Q1}; the 200 then rebased baseline.note
// to N1 and the reopened row showed the server's N1 as clean, the revert lost.
// Editors now keep a field in the draft patch while its value differs from
// what their pending save sent (withPendingReverts).
const pendingSent = { note: "N1" };
assert.deepEqual(
  withPendingReverts({ quote: "Q1" }, { quote: "Q1", note: "N0", support_reference: null }, pendingSent),
  { quote: "Q1", note: "N0" },
  "#632.2: a field typed back to its baseline while a save sends other text stays in the draft patch",
);
const typedBack = based({ quote: "Q1", note: "N0" }, { quote: "Q0", note: "N0", support_reference: null });
const typedBackAfter = rowDraftAfterOp(typedBack, opA, [opA]);
assert.deepEqual(
  typedBackAfter?.payload,
  { patch: { quote: "Q1", note: "N0" }, baseline: { quote: "Q0", note: "N1", support_reference: null } },
  "#632.2: on the 200 the draft keeps note N0 against the rebased baseline N1, so a reopen shows it unsaved",
);
assert.deepEqual(
  withPendingReverts({}, { note: "N0" }, pendingSent),
  { note: "N0" },
  "#632.2: all fields typed back while the save is pending: the revert is kept too",
);
assert.deepEqual(
  rowDraftAfterOp(based({ note: "N0" }, { note: "N0" }), opA, [opA])?.payload,
  { patch: { note: "N0" }, baseline: { note: "N1" } },
  "#632.2: a kept revert is not settled by the save it reverts, only rebased",
);
// The normal type-back is unchanged: nothing pending, or the pending save
// sends the very value typed, leaves the field out and an empty diff clears.
assert.deepEqual(withPendingReverts({}, { note: "N0" }, undefined), {}, "#632.2: no pending save: a type-back still clears");
assert.deepEqual(withPendingReverts({}, { note: "N1" }, pendingSent), {}, "#632.2: text equal to the pending save is not a revert");
assert.deepEqual(
  withPendingReverts({}, { note: "a\nb" }, { note: "a\\nb" }),
  {},
  "#632.2: display text equal to the TSV text sent is not a revert",
);
const ownPatch = { note: "N2" };
assert.equal(withPendingReverts(ownPatch, { note: "N2" }, pendingSent), ownPatch, "#632.2: a field already in the patch keeps its value");
assert.deepEqual(
  withPendingReverts({}, { note: "N0" }, { sort_order: 3 }),
  {},
  "#632.2: a sent field the editor does not show is ignored",
);

// #632 item 2 review A1/A2: an editor's protection lasts exactly as long as
// its save can still land. It ends on the outbox result of THAT save (ok,
// fatal, locked) or when the user discards it; a 409 waiting for keep-mine
// or a retry keeps it. The save is recognised by row and patch, since
// NoteCard's save goes through Shell and never sees its op id.
const tnTarget = { rowKind: "tn", id: "abcd", book: "ZEC" };
const savedPatch = { note: "N1" };
const tnOp = (over = {}) => ({
  id: "x",
  target: { kind: "row", rowKind: "tn", id: "abcd", book: "ZEC" },
  action: "patch",
  patch: { note: "N1" },
  expectedVersion: 4,
  ...over,
});
assert.equal(isPendingRowSave(savedPatch, tnOp(), tnTarget), true, "A1: the editor's own save is recognised");
assert.equal(isPendingRowSave(savedPatch, tnOp({ expectedVersion: 9 }), tnTarget), true, "A1: a re-sent save (healed conflict) is still recognised");
assert.equal(isPendingRowSave(savedPatch, tnOp({ patch: { note: "N2" } }), tnTarget), false, "A1: another save of the row is not");
assert.equal(isPendingRowSave(savedPatch, tnOp({ patch: { note: "N1", quote: "q" } }), tnTarget), false, "A1: a wider patch is not");
assert.equal(isPendingRowSave(savedPatch, tnOp({ target: { kind: "row", rowKind: "tn", id: "other", book: "ZEC" } }), tnTarget), false, "A1: another row is not");
assert.equal(isPendingRowSave(savedPatch, tnOp({ target: { kind: "row", rowKind: "tn", id: "abcd", book: "HAG" } }), tnTarget), false, "A1: another book is not");
assert.equal(isPendingRowSave(savedPatch, tnOp({ action: "delete" }), tnTarget), false, "A1: a delete is not");
assert.equal(rowSaveEnded({ kind: "ok" }), true, "A1: a 200 ends the protection");
assert.equal(rowSaveEnded({ kind: "fatal", reason: "http 422" }), true, "A1: a refusal ends it");
assert.equal(rowSaveEnded({ kind: "locked" }), true, "A1: a locked drop ends it");
assert.equal(rowSaveEnded({ kind: "conflict" }), false, "A1: a 409 awaiting keep-mine keeps it");
assert.equal(rowSaveEnded({ kind: "retry", reason: "http 503" }), false, "A1: a retry keeps it");

// #658: a field kept by withPendingReverts is marked in the draft with what the
// pending save sent, and a remounted editor restores the protection only from
// a live op that sends exactly that value.
const ownSave = { patch: { note: "N1\\nb" }, shown: { note: "N1\nb" } };
assert.deepEqual(
  revertMarks({ quote: "Q1" }, { quote: "Q1", note: "N0" }, ownSave),
  { note: { sent: "N1\\nb", shown: "N1\nb" } },
  "#658: a kept field is marked with the sent and display values",
);
assert.equal(revertMarks({ quote: "Q1", note: "N2" }, { quote: "Q1", note: "N2" }, ownSave), undefined, "#658: a field in the diff is typing, not a type-back");
assert.equal(revertMarks({ quote: "Q1" }, { quote: "Q1" }, undefined), undefined, "#658: no pending save, no marks");
assert.deepEqual(
  revertMarks({}, { note: "N0" }, { patch: { note: "N1" }, shown: {} }),
  { note: { sent: "N1", shown: "N1" } },
  "#658: shown defaults to the sent value",
);

const markedDraft = (patch, reverted) => ({ ...rowDraft({}), payload: { patch, baseline: { quote: "Q0", note: "N0" }, ...(reverted ? { reverted } : {}) } });
const n0Back = markedDraft({ quote: "Q1", note: "N0" }, { note: { sent: "N1", shown: "N1" } });
const liveN1 = tnOp({ id: "op1", status: "in_flight" });
assert.deepEqual(
  pendingRevertSave(n0Back, [liveN1], tnTarget),
  { patch: { note: "N1" }, shown: { note: "N1" }, opId: "op1" },
  "#658: a marked field with its save still live restores the protection",
);
assert.equal(pendingRevertSave(n0Back, [liveN1], tnTarget, new Set(["op1"])), undefined, "#658 A2: an op heard ending after the read is not restored");
assert.equal(pendingRevertSave(undefined, [liveN1], tnTarget), undefined, "#658: no draft, nothing to protect");
assert.equal(pendingRevertSave(n0Back, [], tnTarget), undefined, "#658: no live op, nothing to protect");
assert.equal(pendingRevertSave(n0Back, [tnOp({ id: "op1", status: "failed", lastError: "http 422" })], tnTarget), undefined, "#658: a refused op will not land");
assert.equal(pendingRevertSave(n0Back, [tnOp({ id: "op1", status: "done" })], tnTarget), undefined, "#658: a finished op is not live");
assert.deepEqual(pendingRevertSave(n0Back, [tnOp({ id: "op1", status: "conflict" })], tnTarget)?.opId, "op1", "#658: a 409 awaiting keep-mine can still land");
assert.equal(pendingRevertSave(n0Back, [tnOp({ id: "d", status: "pending", action: "delete", patch: {} })], tnTarget), undefined, "#658: a delete is not a save");
assert.equal(
  pendingRevertSave(n0Back, [tnOp({ id: "o", status: "pending", target: { kind: "row", rowKind: "tn", id: "other", book: "ZEC" } })], tnTarget),
  undefined,
  "#658: another row's op does not count",
);
assert.equal(pendingRevertSave(n0Back, [tnOp({ id: "x", status: "pending", patch: { note: "X" } })], tnTarget), undefined, "#658 A1: an op sending another value is not this save");
assert.equal(
  pendingRevertSave(markedDraft({ quote: "Q1" }, { note: { sent: "N1", shown: "N1" } }), [liveN1], tnTarget),
  undefined,
  "#658: a mark whose field left the patch (typed again) restores nothing",
);
// Review A1/F1: save N1, edit the quote, unmount; the 200 rebases the baseline
// to N1 and leaves note N1 in the patch, so note equals its baseline without
// any type-back. A later remount next to another live save of the note must
// not adopt it.
const f1 = { ...rowDraft({}), payload: { patch: { quote: "Q1", note: "N1" }, baseline: { quote: "Q0", note: "N1" } } };
assert.equal(pendingRevertSave(f1, [tnOp({ id: "x", status: "pending", patch: { note: "X" } })], tnTarget), undefined, "#658 A1: a rebased field with no mark is not a type-back");
assert.deepEqual(
  pendingRevertSave(n0Back, [tnOp({ id: "op1", status: "in_flight", patch: { note: "N1", quote: "Q9" } })], tnTarget)?.patch,
  { note: "N1" },
  "#658 A3: only the marked fields are restored, not the op's whole patch",
);
assert.deepEqual(
  pendingRevertSave(n0Back, [liveN1, tnOp({ id: "op2", status: "pending", patch: { note: "N1" } })], tnTarget)?.opId,
  "op2",
  "#658: the newest op sending the marked value wins",
);
assert.deepEqual(
  pendingRevertSave(markedDraft({ note: "a\nb" }, { note: { sent: "N1\\nx", shown: "N1\nx" } }), [tnOp({ id: "t", status: "pending", patch: { note: "N1\\nx" } })], tnTarget)?.shown,
  { note: "N1\nx" },
  "#658 A4: the display form comes from the mark",
);
assert.equal(isEditorsPendingSave({ patch: { note: "N1" }, shown: {}, opId: "op1" }, tnOp({ id: "op1", patch: { note: "N1", quote: "q" } }), tnTarget), true, "#658: a recovered save ends by op id");
assert.equal(isEditorsPendingSave({ patch: { note: "N1" }, shown: {}, opId: "op1" }, tnOp({ id: "op2" }), tnTarget), false, "#658: another op with the same patch does not end a recovered save");
assert.equal(isEditorsPendingSave({ patch: { note: "N1" }, shown: {} }, tnOp({ id: "any" }), tnTarget), true, "#658: an editor's own save still ends by row and patch");

console.log("draftSaveState: 110 passed");
