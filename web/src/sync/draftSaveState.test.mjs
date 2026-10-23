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

// Issue #616: a row save's 200 cleared the row draft unconditionally. An editor
// that re-writes its draft against the confirmed version (typing done between
// Save and the 200) lost that draft when the clear landed after the re-write.
// A row draft is settled by the op only if it was written at or before the
// version the op was sent against.
const rowDraft = (expectedVersion) => ({
  key: "row:twl:ZEC:w2wo",
  payload: { patch: { orig_words: "XY" } },
  expectedVersion,
  updatedAt: 1,
  meta: { kind: "row", rowKind: "twl", id: "w2wo", book: "ZEC", chapter: 1, verse: 1 },
});
const rowOp = { target: { kind: "row", rowKind: "twl", id: "w2wo", book: "ZEC" }, expectedVersion: 6 };
assert.equal(rowDraftSettledByOp(rowDraft(6), rowOp), true, "draft at the op's version is settled by its 200");
assert.equal(rowDraftSettledByOp(rowDraft(4), rowOp), true, "draft older than the op (re-based after a 409) is settled");
assert.equal(
  rowDraftSettledByOp(rowDraft(7), rowOp),
  false,
  "draft re-written against the confirmed version holds newer typing and survives",
);
assert.equal(rowDraftSettledByOp(undefined, rowOp), false, "no draft means nothing to clear");
assert.equal(
  rowDraftSettledByOp({ ...rowDraft(6), expectedVersion: undefined }, rowOp),
  true,
  "legacy/adopted draft without a numeric version keeps the old unconditional clear",
);

// #616 review A1: the flows screens move their baseline only after the 200. A
// draft re-written at v+1 before that (refetch during the save) holds exactly
// the saved text, so it must be cleared once the baseline moves. A draft that
// holds anything else is newer typing and stays.
const tnDraft = (patch) => ({ ...rowDraft(7), payload: { patch, baseline: { note: "old" } } });
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

console.log("draftSaveState: 31 passed");
