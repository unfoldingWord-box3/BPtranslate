// Request-building for the admin "set review state" page (#296). The body is
// sent to POST /api/books/:book/review-state, whose parser rejects an ambiguous
// or empty scope — so the form must map to exactly one of chapter / range /
// whole book, and never silently widen to the whole book.
import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewSweepBody, parseReviewStateSwept, reviewStatePatches, reviewStateSnapshot } from "./reviewStateSweep.ts";
// The real server-side parser: every body the page builds must be accepted by
// it and mean the same scope, so the page and the route cannot drift apart.
import { parseSweepRequest } from "../../../api/src/reviewState.ts";

const base = { resource: "tn", target: "approved", wholeBook: false };

test("one chapter (from === to) sends { chapter }", () => {
  const r = buildReviewSweepBody({ ...base, from: 3, to: 3 });
  assert.deepEqual(r, { ok: true, body: { resource: "tn", state: "approved", chapter: 3 } });
});

test("a range sends chapterStart / chapterEnd", () => {
  const r = buildReviewSweepBody({ ...base, resource: "tq", target: "needs_review", from: 2, to: 5 });
  assert.deepEqual(r, {
    ok: true,
    body: { resource: "tq", state: "needs_review", chapterStart: 2, chapterEnd: 5 },
  });
});

test("whole book sends allChapters and ignores the chapter pickers", () => {
  const r = buildReviewSweepBody({ ...base, wholeBook: true, from: 2, to: 1 });
  assert.deepEqual(r, { ok: true, body: { resource: "tn", state: "approved", allChapters: true } });
});

test("a missing chapter is an error, never a whole-book sweep", () => {
  assert.deepEqual(buildReviewSweepBody({ ...base, from: null, to: 4 }), { ok: false, error: "no_chapter" });
  assert.deepEqual(buildReviewSweepBody({ ...base, from: 4, to: null }), { ok: false, error: "no_chapter" });
});

test("a reversed range is an error", () => {
  assert.deepEqual(buildReviewSweepBody({ ...base, from: 5, to: 2 }), { ok: false, error: "range_reversed" });
});

test("every body the page builds is accepted by the server parser with the same scope", () => {
  const cases = [
    [{ ...base, from: 1, to: 1 }, { start: 1, end: 1 }],
    [{ ...base, from: 1, to: 14 }, { start: 1, end: 14 }],
    [{ ...base, target: "needs_review", wholeBook: true, from: null, to: null }, null],
  ];
  for (const [form, range] of cases) {
    const built = buildReviewSweepBody(form);
    assert.equal(built.ok, true);
    const parsed = parseSweepRequest(built.body);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.resource, form.resource);
    assert.equal(parsed.target, form.target);
    assert.deepEqual(parsed.range, range);
  }
});

// ── Live update for open chapter tabs (#395) ─────────────────────────────────

test("parseReviewStateSwept accepts the server's chapter.review_state_swept shape", () => {
  const ev = { type: "chapter.review_state_swept", book: "ZEC", chapter: 1, resource: "tn", state: "approved" };
  assert.deepEqual(parseReviewStateSwept(ev), { book: "ZEC", chapter: 1, resource: "tn", state: "approved" });
});

test("parseReviewStateSwept rejects other events and malformed ones", () => {
  assert.equal(parseReviewStateSwept({ type: "chapter.pipeline_applied", book: "ZEC", chapter: 1 }), null);
  assert.equal(
    parseReviewStateSwept({ type: "chapter.review_state_swept", book: "ZEC", chapter: 1, resource: "twl", state: "approved" }),
    null,
  );
  assert.equal(
    parseReviewStateSwept({ type: "chapter.review_state_swept", book: "ZEC", chapter: "1", resource: "tn", state: "approved" }),
    null,
  );
  assert.equal(parseReviewStateSwept(null), null);
});

test("reviewStatePatches returns only rows whose state moved, and never touches content", () => {
  const local = [
    { id: "a", note: "local text", translation_state: null },
    { id: "b", note: "x", translation_state: "validated" },
    { id: "c", note: "y", translation_state: "edited" },
  ];
  const fresh = [
    { id: "a", note: "server text", translation_state: "validated" },
    { id: "b", note: "x", translation_state: "validated" },
    { id: "c", note: "y", translation_state: "validated" },
    { id: "new", note: "z", translation_state: "validated" },
  ];
  assert.deepEqual(reviewStatePatches(local, fresh), [
    { id: "a", translation_state: "validated" },
    { id: "c", translation_state: "validated" },
  ]);
});

test("reviewStatePatches skips rows whose local state changed while the refetch was in flight", () => {
  const atEvent = [
    { id: "a", translation_state: "edited" },
    { id: "b", translation_state: "edited" },
  ];
  const since = reviewStateSnapshot(atEvent);
  // The translator approved "b" by hand after the refetch started; the server
  // read predates that click.
  const local = [
    { id: "a", translation_state: "edited" },
    { id: "b", translation_state: "validated" },
    { id: "late", translation_state: null },
  ];
  const fresh = [
    { id: "a", translation_state: "validated" },
    { id: "b", translation_state: "edited" },
    { id: "late", translation_state: "validated" },
  ];
  assert.deepEqual(reviewStatePatches(local, fresh, since), [{ id: "a", translation_state: "validated" }]);
});
