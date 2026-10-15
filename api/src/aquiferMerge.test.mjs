// Unit tests for the Aquifer merge planner (aquiferMerge.ts) — issue #584.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aquiferMerge.test.mjs
//
// `applyImport` replays what aquiferDrafts does with the plan against an
// in-memory table (delete replaceId, then insert the draft under pickId's rule:
// keep the en_tn id when free, else mint), so the tests assert on the resulting
// rows, not just on the plan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { planAquiferMerge } from "./aquiferMerge.ts";

const REF = "1:1";
const row = (id, state, over = {}) => ({
  id, ref_raw: REF, quote: "ὁ ἀδελφὸς", occurrence: 1, note: "en", translation_state: state, ...over,
});
const note = (enId, over = {}) => ({ ref: REF, enId, quote: "ὁ ἀδελφὸς", occurrence: 1, ...over });

const never = () => false;
const inAll = () => true;

let minted = 0;
function applyImport(table, tombstoneIds, notes, isTranslated = never) {
  const live = table.filter((r) => !r.deleted);
  const { approveIds, decisions } = planAquiferMerge(live, notes, isTranslated, inAll);
  for (const id of approveIds) table.find((r) => r.id === id).translation_state = "validated";
  const used = new Set([...table.map((r) => r.id), ...tombstoneIds]);
  let skipped = 0;
  notes.forEach((n, i) => {
    const d = decisions[i];
    if (d.action === "skip") { skipped++; return; }
    if (d.replaceId) {
      table.splice(table.findIndex((r) => r.id === d.replaceId), 1);
      used.delete(d.replaceId);
    }
    let id = n.enId && !used.has(n.enId) ? n.enId : `m${++minted}`;
    used.add(id);
    table.push({ ...row(id, "ai_draft", { ref_raw: n.ref, quote: n.quote, occurrence: n.occurrence }), draft: true });
  });
  return { skipped, approveIds, decisions };
}
const drafts = (t) => t.filter((r) => r.translation_state === "ai_draft").map((r) => r.id).sort();

// The issue's two same-key en_tn rows (figs-metaphor + figs-exclusive on one word).
const twoNotes = () => [note("aaaa"), note("bbbb")];

test("two same-key rows: first import replaces both, re-import still leaves exactly two drafts", () => {
  const table = [row("aaaa", null), row("bbbb", null)];
  applyImport(table, new Set(), twoNotes());
  assert.deepEqual(drafts(table), ["aaaa", "bbbb"]);
  assert.equal(table.length, 2);
  for (let i = 0; i < 3; i++) applyImport(table, new Set(), twoNotes());
  assert.deepEqual(drafts(table), ["aaaa", "bbbb"]);
  assert.equal(table.length, 2);
});

test("approve one of two same-key rows: it is protected, the other is still replaced", () => {
  const table = [row("aaaa", null), row("bbbb", null)];
  applyImport(table, new Set(), twoNotes());
  table.find((r) => r.id === "aaaa").translation_state = "validated";
  table.find((r) => r.id === "aaaa").note = "approved text";
  const bBefore = table.find((r) => r.id === "bbbb");
  const { skipped } = applyImport(table, new Set(), twoNotes());
  assert.equal(skipped, 1);
  assert.equal(table.length, 2);
  assert.equal(table.find((r) => r.id === "aaaa").note, "approved text");
  assert.equal(table.find((r) => r.id === "aaaa").translation_state, "validated");
  const bAfter = table.find((r) => r.id === "bbbb");
  assert.notEqual(bAfter, bBefore, "bbbb draft was replaced by a fresh draft");
  assert.equal(bAfter.translation_state, "ai_draft");
});

test("edited row protects only its own id, same as validated", () => {
  const table = [row("aaaa", "edited"), row("bbbb", "ai_draft")];
  const { decisions } = applyImport(table, new Set(), twoNotes());
  assert.deepEqual(decisions.map((d) => d.action), ["skip", "insert"]);
  assert.equal(table.find((r) => r.id === "aaaa").translation_state, "edited");
});

test("row whose id equals enId but whose quote a human edited is protected by id", () => {
  // The quote no longer matches the incoming note, so the old key would miss it
  // and land a duplicate draft beside the edited row.
  const table = [row("aaaa", "edited", { quote: "human fixed quote" })];
  const { decisions } = applyImport(table, new Set(), [note("aaaa")]);
  assert.deepEqual(decisions, [{ action: "skip" }]);
  assert.equal(table.length, 1);
});

test("draft whose quote was edited is still found and replaced by id (no duplicate)", () => {
  const table = [row("aaaa", "ai_draft", { quote: "something else" })];
  applyImport(table, new Set(), [note("aaaa")]);
  assert.equal(table.length, 1);
  assert.deepEqual(drafts(table), ["aaaa"]);
});

test("minted/unmatched notes (no enId) keep the (ref, quote, occurrence) key", () => {
  // A previous import minted these two drafts; the notes still have no enId.
  const table = [row("m_x", "ai_draft"), row("m_y", "ai_draft", { quote: "other", occurrence: 1 })];
  const notes = [note(null), note(null, { quote: "other" })];
  applyImport(table, new Set(), notes);
  assert.equal(table.length, 2);
  assert.ok(!table.some((r) => r.id === "m_x" || r.id === "m_y"), "both old drafts were replaced");
  // A protected row with the same key still suppresses an enId-less note.
  const t2 = [row("aaaa", "validated")];
  assert.deepEqual(applyImport(t2, new Set(), [note(null)]).decisions, [{ action: "skip" }]);
  assert.equal(t2.length, 1);
});

test("occurrence still distinguishes keyed notes", () => {
  const t = [row("aaaa", "validated", { occurrence: 1 })];
  const { decisions } = applyImport(t, new Set(), [note(null, { occurrence: 2 })]);
  assert.deepEqual(decisions, [{ action: "insert", replaceId: null }]);
});

test("two same-key minted drafts: a re-import consumes one row per note, no overwrite", () => {
  const table = [row("m_1", "ai_draft"), row("m_2", "ai_draft")];
  const { decisions } = applyImport(table, new Set(), [note(null), note(null)]);
  assert.deepEqual(decisions.map((d) => d.replaceId).sort(), ["m_1", "m_2"]);
  assert.equal(table.length, 2);
});

test("id-matched rows are not stolen by an earlier key-matched note", () => {
  // The enId-less note sits first and shares the key with bbbb, which belongs
  // to the second note by id.
  const table = [row("bbbb", "ai_draft")];
  const { decisions } = planAquiferMerge(table, [note(null), note("bbbb")], never, inAll);
  assert.deepEqual(decisions, [
    { action: "insert", replaceId: null },
    { action: "insert", replaceId: "bbbb" },
  ]);
});

test("soft-deleted ids stay used: the draft mints instead of reusing the tombstone id", () => {
  // Tombstones are not passed to the planner (deleted_at IS NULL), so the enId has
  // no live row; the caller's used-id set makes pickId mint a fresh id.
  const table = [];
  applyImport(table, new Set(["aaaa"]), [note("aaaa")]);
  assert.equal(table.length, 1);
  assert.notEqual(table[0].id, "aaaa");
});

test("approved row no note owns by id still covers an id-matched placeholder with the same key", () => {
  // e.g. a translated ar_tn row with its own id next to an English placeholder:
  // the draft must not land a duplicate beside approved content.
  const rows = [row("vvvv", "validated"), row("aaaa", null)];
  const { decisions } = planAquiferMerge(rows, [note("aaaa")], never, inAll);
  assert.deepEqual(decisions, [{ action: "skip" }]);
});

test("an id-claimed validated twin does not suppress an enId note with no live row", () => {
  // aaaa is validated and owned by its own note; bbbb's row is gone, so the
  // second note is a real second note and gets its draft.
  const rows = [row("aaaa", "validated")];
  const { decisions } = planAquiferMerge(rows, [note("aaaa"), note("bbbb")], never, inAll);
  assert.deepEqual(decisions, [{ action: "skip" }, { action: "insert", replaceId: null }]);
});

test("a protected row no note owns by id still covers an enId note whose own row is gone", () => {
  const t = [row("zzzz", "validated")];
  assert.deepEqual(applyImport(t, new Set(), [note("aaaa")]).decisions, [{ action: "skip" }]);
});

test("existing target-language rows are bulk-approved and protected; scope limits approval only", () => {
  const rows = [
    row("aaaa", null, { note: "translated", ref_raw: "1:1" }),
    row("cccc", null, { note: "translated", ref_raw: "2:1" }),
  ];
  const plan = planAquiferMerge(
    rows,
    [note("aaaa"), note("cccc", { ref: "2:1" })],
    (r) => r.note === "translated",
    (ref) => ref.startsWith("1:"),
  );
  assert.deepEqual(plan.approveIds, ["aaaa"]);
  assert.deepEqual(plan.decisions, [{ action: "skip" }, { action: "skip" }]);
});
