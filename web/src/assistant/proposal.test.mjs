import test from "node:test";
import assert from "node:assert/strict";
import { actionCount, echoContent, noteDiff, normalizeActions, proposalKey, selectedActions } from "./proposal.ts";

const acts = (o) => ({ edits: [], approve: [], notNeeded: [], ...o });

test("normalizeActions: an edit wins over approve and not-needed for the same note", () => {
  const n = normalizeActions(acts({ edits: [{ id: "a", note: "x" }], approve: ["a", "b"], notNeeded: ["a", "c"] }));
  assert.deepEqual(n.approve, ["b"]);
  assert.deepEqual(n.notNeeded, ["c"]);
  assert.equal(n.edits.length, 1);
});

test("normalizeActions: duplicates collapse, an id in both lists is dropped from both", () => {
  const n = normalizeActions(acts({ edits: [{ id: "a", note: "1" }, { id: "a", note: "2" }], approve: ["b", "b", "c"], notNeeded: ["c", "d"] }));
  assert.deepEqual(n.edits, [{ id: "a", note: "1" }]);
  assert.deepEqual(n.approve, ["b"]);
  assert.deepEqual(n.notNeeded, ["d"]);
});

test("selectedActions: everything is ticked until a key is in the untick set", () => {
  const a = acts({ edits: [{ id: "a", note: "x" }, { id: "b", note: "y" }], approve: ["c"], notNeeded: ["d"] });
  assert.equal(actionCount(selectedActions(a, new Set())), 4);
  const s = selectedActions(a, new Set([proposalKey("e", "a"), proposalKey("n", "d")]));
  assert.deepEqual(s, { edits: [{ id: "b", note: "y" }], approve: ["c"], notNeeded: [] });
  // the same id under another kind is a different row
  assert.equal(actionCount(selectedActions(a, new Set([proposalKey("a", "a")]))), 4);
});

test("echoContent: appends a plain summary only when something was proposed", () => {
  assert.equal(echoContent("Hi", acts({})), "Hi");
  assert.equal(echoContent("Done", acts({ edits: [{ id: "a", note: "x" }], approve: ["b", "c"] })), "Done\n\n(Proposed 1 edit, 2 approvals)");
});

test("noteDiff: unescapes newlines and diffs Arabic words, not the whole text", () => {
  const d = noteDiff("هذا الكتاب جيد\\nسطر", "هذا الكتاب ممتاز\nسطر");
  assert.ok(d.some((o) => o.type === "del" && o.text.includes("جيد")));
  assert.ok(d.some((o) => o.type === "add" && o.text.includes("ممتاز")));
  assert.ok(d.some((o) => o.type === "eq" && o.text.includes("الكتاب")));
  assert.equal(d.filter((o) => o.type !== "add").map((o) => o.text).join(""), "هذا الكتاب جيد\nسطر");
});
