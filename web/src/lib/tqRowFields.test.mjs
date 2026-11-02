// Regression tests for issue #617: QuestionCard and QuestionsTable reset their
// fields from the row whenever row.version changed. The server's confirmation of
// a Save bumps the version, so text typed between Save and that confirmation was
// overwritten and its draft cleared (the words table had the same bug, #616).
// On a row change a field now adopts the new value only if the user hasn't
// edited it since the last baseline.
import test from "node:test";
import assert from "node:assert/strict";
import { tqCardBaseline, tqTableBaseline } from "./tqRowFields.ts";
import { reconcileField } from "./twlRowFields.ts";

const row = { ref_raw: "1:1", question: "Who was Zechariah?", response: "The son of Berechiah.", version: 3 };

const reconcileAll = (prev, next, local) =>
  Object.fromEntries(Object.keys(local).map((k) => [k, reconcileField(prev[k], next[k], local[k])]));

test("card baseline shows TSV \\n escapes as newlines and null as empty", () => {
  assert.deepEqual(tqCardBaseline({ question: "a\\nb", response: null }), { question: "a\nb", response: "" });
});

test("table baseline keeps raw text and maps null to empty", () => {
  assert.deepEqual(tqTableBaseline({ ref_raw: null, question: "a\\nb", response: null }), {
    refRaw: "",
    question: "a\\nb",
    response: "",
  });
});

for (const [name, baseline] of [["card", tqCardBaseline], ["table", tqTableBaseline]]) {
  test(`${name}: server ack after Save keeps typing made before the ack`, () => {
    const saved = { ...row, question: "Who was Zechariah? X" }; // optimistic save applied
    const acked = { ...saved, version: 4 }; // the ack bumps only the version
    const local = { ...baseline(saved), question: "Who was Zechariah? XY" }; // typed after Save
    assert.deepEqual(reconcileAll(baseline(saved), baseline(acked), local), local);
  });

  test(`${name}: untouched fields adopt a remote change; edited fields keep the typing`, () => {
    const local = { ...baseline(row), question: "edited" };
    const remote = { ...row, question: "remote q", response: "remote r", version: 4 };
    const got = reconcileAll(baseline(row), baseline(remote), local);
    assert.equal(got.question, "edited");
    assert.equal(got.response, "remote r");
  });

  test(`${name}: an unedited row follows the server`, () => {
    const remote = { ...row, question: "remote q", version: 4 };
    assert.deepEqual(reconcileAll(baseline(row), baseline(remote), baseline(row)), baseline(remote));
  });
}
