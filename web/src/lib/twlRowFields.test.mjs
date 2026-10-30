// Regression tests for issue #613: the words table's Undo used a snapshot that
// refreshed only when the row's version changed. Between Save and the server's
// acknowledgement the row already holds the saved value (optimistic patch, same
// version), so Undo restored the pre-save value and a second Save reverted the
// user's own edit. Undo now resets to twlBaseline(row), which by construction is
// never dirty against the row.
import test from "node:test";
import assert from "node:assert/strict";
import { twlBaseline, twlDiff, twlReconcile } from "./twlRowFields.ts";

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

// Issue #616: WordRow reset its fields from the row whenever row.version changed.
// The server's confirmation of a Save bumps the version, so text typed between
// Save and that confirmation was overwritten and its draft cleared. On a row
// change a field now adopts the new value only if the user hasn't edited it
// since the last sync (local still equals the previous baseline).
const base = { quote: "דָּבָר", twLink: "rc://*/tw/dict/bible/kt/word", occurrence: 1 };

test("server ack after Save keeps typing made before the ack", () => {
  const saved = { ...base, quote: "דָּבָרX" }; // optimistic save already applied
  const local = { ...saved, quote: "דָּבָרXY" }; // typed after Save
  // The ack bumps only the version, so the baseline values are unchanged.
  assert.deepEqual(twlReconcile(saved, { ...saved }, local), local);
});

test("untouched fields adopt a remote change; edited fields keep the typing", () => {
  const local = { ...base, quote: "edited" };
  const next = { quote: "remote", twLink: "rc://*/tw/dict/bible/kt/other", occurrence: 2 };
  assert.deepEqual(twlReconcile(base, next, local), {
    quote: "edited",
    twLink: "rc://*/tw/dict/bible/kt/other",
    occurrence: 2,
  });
});

test("with no local edits the fields become the new baseline", () => {
  const next = { quote: "remote", twLink: null, occurrence: 3 };
  assert.deepEqual(twlReconcile(base, next, { ...base }), next);
});
