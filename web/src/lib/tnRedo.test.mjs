import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAPTER_REDO_TIMEOUT_MS,
  INTRO_REDO_TIMEOUT_MS,
  introRedoTimeoutMs,
  isIntroTnRow,
  redoErrorIsAiUnconfigured,
  tnRedoBlockedReason,
  tnRedoUsesPipeline,
} from "./tnRedo.ts";

const msgs = {
  aiUnavailable: null,
  noNoteSelected: "no-note",
  needsSupportRef: "needs-ref",
  needsQuote: "needs-quote",
};

test("intro rows (verse 0) use the pipeline redo path", () => {
  assert.equal(isIntroTnRow({ verse: 0 }), true);
  assert.equal(tnRedoUsesPipeline({ verse: 0 }), true);
  assert.equal(tnRedoUsesPipeline({ verse: 1 }), false);
});

test("intro redo is not blocked by missing support_reference or quote", () => {
  const intro = { verse: 0, support_reference: null, quote: null };
  assert.equal(tnRedoBlockedReason(intro, msgs), null);
});

test("verse-note redo still requires support_reference and quote", () => {
  assert.equal(
    tnRedoBlockedReason({ verse: 1, support_reference: null, quote: "x" }, msgs),
    "needs-ref",
  );
  assert.equal(
    tnRedoBlockedReason(
      { verse: 1, support_reference: "rc://*/ta/man/translate/figs-metaphor", quote: "" },
      msgs,
    ),
    "needs-quote",
  );
  assert.equal(
    tnRedoBlockedReason(
      {
        verse: 1,
        support_reference: "rc://*/ta/man/translate/figs-metaphor",
        quote: "the word",
      },
      msgs,
    ),
    null,
  );
});

test("#551 switch-off: verse-note redo (tn-quick) is blocked with the org-key message; intro redo is not", () => {
  const off = { ...msgs, quickNeedsOrgKey: "needs-org-key" };
  const complete = {
    verse: 1,
    support_reference: "rc://*/ta/man/translate/figs-metaphor",
    quote: "the word",
  };
  assert.equal(tnRedoBlockedReason(complete, off), "needs-org-key");
  // Before the quote/support-ref hints: no point asking for a quote it can't use.
  assert.equal(tnRedoBlockedReason({ verse: 1, support_reference: null, quote: null }, off), "needs-org-key");
  assert.equal(tnRedoBlockedReason({ verse: 0, support_reference: null, quote: null }, off), null);
});

test("intro redo timeout scales up when start() answers already_running (#376)", () => {
  // A row-scoped Redo that latches onto a broader in-flight chapter job (~1h)
  // must not be flipped to a false `timeout` failure by the 15-minute budget.
  assert.equal(introRedoTimeoutMs("already_running"), CHAPTER_REDO_TIMEOUT_MS);
  assert.ok(CHAPTER_REDO_TIMEOUT_MS > INTRO_REDO_TIMEOUT_MS);
  // The chapter budget must comfortably clear the documented ~1h chapter run.
  assert.ok(CHAPTER_REDO_TIMEOUT_MS >= 60 * 60 * 1000);
});

test("intro redo keeps the short budget for a fresh single-row run", () => {
  assert.equal(introRedoTimeoutMs("running"), INTRO_REDO_TIMEOUT_MS);
  assert.equal(introRedoTimeoutMs("queued"), INTRO_REDO_TIMEOUT_MS);
  assert.equal(INTRO_REDO_TIMEOUT_MS, 15 * 60 * 1000);
});

test("only the explicit not-configured codes latch Redo off; transient failures stay retryable", () => {
  // These three mean AI drafting is genuinely not set up → permanent grey-out.
  assert.equal(redoErrorIsAiUnconfigured("tn_quick_disabled"), true);
  assert.equal(redoErrorIsAiUnconfigured("anthropic_api_key_missing"), true);
  assert.equal(redoErrorIsAiUnconfigured("pipeline_api_disabled"), true);

  // A bare/transient upstream failure must NOT latch. The proxy forwards an
  // overloaded bot's 503 verbatim, so classifying by status once disabled Redo
  // for the whole session on a single hiccup (the "greyed out and nothing
  // happened" report). No error code → transient → button stays usable.
  assert.equal(redoErrorIsAiUnconfigured(""), false);
  assert.equal(redoErrorIsAiUnconfigured(null), false);
  assert.equal(redoErrorIsAiUnconfigured(undefined), false);
  assert.equal(redoErrorIsAiUnconfigured("model_call_failed"), false);
  assert.equal(redoErrorIsAiUnconfigured("some_other_upstream_error"), false);
});

test("aiUnavailable and missing row still block every path", () => {
  assert.equal(tnRedoBlockedReason(null, msgs), "no-note");
  assert.equal(
    tnRedoBlockedReason(
      { verse: 0 },
      { ...msgs, aiUnavailable: "ai-off" },
    ),
    "ai-off",
  );
});
