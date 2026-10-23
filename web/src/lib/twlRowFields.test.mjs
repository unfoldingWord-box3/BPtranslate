// Regression tests for issue #613: the words table's Undo used a snapshot that
// refreshed only when the row's version changed. Between Save and the server's
// acknowledgement the row already holds the saved value (optimistic patch, same
// version), so Undo restored the pre-save value and a second Save reverted the
// user's own edit. Undo now resets to twlBaseline(row), which by construction is
// never dirty against the row.
import test from "node:test";
import assert from "node:assert/strict";
import { twlBaseline, twlDiff } from "./twlRowFields.ts";

const row = { orig_words: "דָּבָר", tw_link: "rc://*/tw/dict/bible/kt/word", occurrence: 1, version: 3 };

test("baseline normalizes null quote and occurrence", () => {
  assert.deepEqual(twlBaseline({ orig_words: null, tw_link: null, occurrence: null }), {
    quote: "",
    twLink: null,
    occurrence: 1,
  });
});

test("undo target is never dirty against the row (null fields)", () => {
  const r = { orig_words: null, tw_link: null, occurrence: null };
  assert.deepEqual(twlDiff(r, twlBaseline(r)), {});
});

test("after an optimistic save (same version), undo restores the saved value", () => {
  const patched = { ...row, orig_words: "אֱלֹהִים" }; // version unchanged: no server ack yet
  const undone = twlBaseline(patched);
  assert.equal(undone.quote, "אֱלֹהִים");
  assert.deepEqual(twlDiff(patched, undone), {});
});

test("diff reports only changed fields", () => {
  assert.deepEqual(twlDiff(row, { quote: "x", twLink: row.tw_link, occurrence: 2 }), {
    orig_words: "x",
    occurrence: 2,
  });
});
