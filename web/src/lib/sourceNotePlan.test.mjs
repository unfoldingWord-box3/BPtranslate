// Tests for web/src/lib/sourceNotePlan.ts: which source each chapter's English
// source note is read from when a book has per-book / per-chapter tN source
// overrides (issue #691). Server twin: api/src/sourceNotes.ts (tested in
// api/src/mcp.test.mjs). Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/sourceNotePlan.test.mjs

import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSourceNotes,
  noteSourceForChapter,
  parseSourceQuestionTsv,
  parseSourceTsv,
  planRepos,
  refChapter,
  repoKey,
} from "./sourceNotePlan.ts";

const HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n";
const tsv = (rows) => HEADER + rows.map(([ref, id, note]) => `${ref}\t${id}\t\t\tq\t1\t${note}`).join("\n") + "\n";

const EN = { org: "unfoldingWord", repo: "en_tn" };
const OTHER = { org: "OtherOrg", repo: "other_tn" };
const THIRD = { org: "ThirdOrg", repo: "third_tn" };
const plan = {
  base: EN,
  ranges: [
    { chapter_start: 1, chapter_end: 3, ...OTHER },
    { chapter_start: 8, chapter_end: 9, ...THIRD },
  ],
};

test("refChapter reads the chapter the way import does (front → 0, ranges → first)", () => {
  assert.equal(refChapter("front:intro"), 0);
  assert.equal(refChapter("3:intro"), 3);
  assert.equal(refChapter("3:5-7"), 3);
  assert.equal(refChapter(""), 0);
});

test("parseSourceTsv keeps the hook's old parsing: BOM, CRLF, header by content, \\n unescaped", () => {
  const m = parseSourceTsv("﻿" + HEADER + "1:1\tab12\t\tfigs-x\tq\t1\tLine one\\nLine two\r\n");
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("ab12"), { note: "Line one\nLine two", quote: "q", supportReference: "figs-x", reference: "1:1" });
});

// The server leaves Aquifer ranges out of the plan (they read the base), so
// chapter 5 here stands for an Aquifer chapter.
test("noteSourceForChapter: a dcs range, two ranges in one book, and the base", () => {
  assert.deepEqual(noteSourceForChapter(plan, 2), OTHER);
  assert.deepEqual(noteSourceForChapter(plan, 8), THIRD);
  assert.deepEqual(noteSourceForChapter(plan, 4), EN);
  assert.deepEqual(noteSourceForChapter(plan, 5), EN);
  assert.deepEqual(noteSourceForChapter(plan, 0), EN);
  assert.equal(noteSourceForChapter({ base: null, ranges: [] }, 4), null);
});

test("planRepos lists each Door43 repo to fetch once", () => {
  assert.deepEqual(planRepos(plan).map(repoKey), [repoKey(EN), repoKey(OTHER), repoKey(THIRD)]);
  assert.deepEqual(planRepos({ base: EN, ranges: [{ chapter_start: 1, chapter_end: 2, org: "unfoldingword", repo: "EN_TN" }] }).length, 1);
});

test("mergeSourceNotes takes each chapter's note from the source that chapter resolves to", () => {
  // Every source carries id "ab12" in chapter 2, with different text.
  const byRepo = new Map([
    [repoKey(EN), parseSourceTsv(tsv([["front:intro", "fr00", "EN front"], ["2:1", "ab12", "EN two"], ["4:1", "cd34", "EN four"], ["5:1", "ef56", "EN five"], ["8:1", "gh78", "EN eight"]]))],
    [repoKey(OTHER), parseSourceTsv(tsv([["2:1", "ab12", "OTHER two"], ["3:1", "ij90", "OTHER three"], ["4:1", "zz99", "OTHER four"]]))],
    [repoKey(THIRD), parseSourceTsv(tsv([["8:1", "gh78", "THIRD eight"]]))],
  ]);
  const m = mergeSourceNotes(plan, byRepo);
  assert.equal(m.get("ab12")?.note, "OTHER two", "an overridden chapter shows the override's note");
  assert.equal(m.get("ij90")?.note, "OTHER three");
  assert.equal(m.get("gh78")?.note, "THIRD eight", "a second range resolves on its own");
  assert.equal(m.get("cd34")?.note, "EN four", "a chapter no override covers keeps the project-wide note");
  assert.equal(m.get("fr00")?.note, "EN front");
  assert.equal(m.get("ef56")?.note, "EN five", "an Aquifer chapter (no dcs range) keeps the project-wide note");
  assert.equal(m.has("zz99"), false, "an override's rows outside its own chapters do not count");
});

test("mergeSourceNotes with no overrides is the base file unchanged", () => {
  const baseMap = parseSourceTsv(tsv([["1:1", "ab12", "one"], ["2:1", "cd34", "two"]]));
  const m = mergeSourceNotes({ base: EN, ranges: [] }, new Map([[repoKey(EN), baseMap]]));
  assert.deepEqual([...m.entries()], [...baseMap.entries()]);
});

test("a source that failed to load contributes nothing; the others still show", () => {
  const m = mergeSourceNotes(plan, new Map([[repoKey(EN), parseSourceTsv(tsv([["4:1", "cd34", "EN four"], ["2:1", "ab12", "EN two"]]))]]));
  assert.equal(m.get("cd34")?.note, "EN four");
  assert.equal(m.has("ab12"), false, "the overridden chapter does not fall back to the project-wide note");
});

test("no project-wide tN repo (base null): a dcs range still reads its repo, other chapters get nothing", () => {
  const noBase = { base: null, ranges: [{ chapter_start: 1, chapter_end: 2, ...OTHER }] };
  assert.deepEqual(noteSourceForChapter(noBase, 1), OTHER);
  assert.equal(noteSourceForChapter(noBase, 3), null);
  assert.deepEqual(planRepos(noBase).map(repoKey), [repoKey(OTHER)], "no fetch for a null base");
  const m = mergeSourceNotes(noBase, new Map([[repoKey(OTHER), parseSourceTsv(tsv([["1:1", "ab12", "OTHER one"], ["3:1", "cd34", "OTHER three"]]))]]));
  assert.equal(m.get("ab12")?.note, "OTHER one");
  assert.equal(m.has("cd34"), false, "a chapter no override covers has no note");
});

test("no project-wide tN repo, whole-book override: the server sends it as the base", () => {
  const whole = { base: OTHER, ranges: [] };
  assert.deepEqual(noteSourceForChapter(whole, 7), OTHER);
  assert.deepEqual(planRepos(whole).map(repoKey), [repoKey(OTHER)]);
});

// ── tQ (issue #695) ────────────────────────────────────────────────────────
// The English source question beside a tQ row follows the tQ source plan the
// same way (GET /api/books/:book/sources → tqQuestionSources). Aquifer is
// tN-only, so a tQ plan only ever carries Door43 ranges.
const Q_HEADER = "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse\n";
const qtsv = (rows) => Q_HEADER + rows.map(([ref, id, q]) => `${ref}\t${id}\t\t\t0\t${q}\tA: ${q}`).join("\n") + "\n";
const EN_TQ = { org: "unfoldingWord", repo: "en_tq" };
const RU_TQ = { org: "ru_gl", repo: "ru_tq" };

test("parseSourceQuestionTsv keeps the hook's old parsing: BOM, CRLF, header by content, \\n unescaped", () => {
  const m = parseSourceQuestionTsv("﻿" + Q_HEADER + "1:1\tab12\t\tq\t0\tWho?\\nWhy?\tHim.\\nBecause.\r\n");
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("ab12"), { question: "Who?\nWhy?", response: "Him.\nBecause.", quote: "q", reference: "1:1" });
});

test("tQ: a dcs chapter range shows the override's question for its chapters only", () => {
  const tqPlan = { base: EN_TQ, ranges: [{ chapter_start: 1, chapter_end: 2, ...RU_TQ }] };
  const byRepo = new Map([
    [repoKey(EN_TQ), parseSourceQuestionTsv(qtsv([["1:1", "ab12", "EN one"], ["5:1", "cd34", "EN five"]]))],
    [repoKey(RU_TQ), parseSourceQuestionTsv(qtsv([["1:1", "ab12", "RU one"], ["2:3", "ef56", "RU two"], ["5:1", "cd34", "RU five"]]))],
  ]);
  const m = mergeSourceNotes(tqPlan, byRepo);
  assert.equal(m.get("ab12")?.question, "RU one", "an overridden chapter shows the override's question");
  assert.equal(m.get("ab12")?.response, "A: RU one");
  assert.equal(m.get("ef56")?.question, "RU two");
  assert.equal(m.get("cd34")?.question, "EN five", "a chapter no override covers keeps the project-wide question");
});

test("tQ: no override is the project-wide file unchanged", () => {
  const baseMap = parseSourceQuestionTsv(qtsv([["1:1", "ab12", "one"], ["2:1", "cd34", "two"]]));
  const m = mergeSourceNotes({ base: EN_TQ, ranges: [] }, new Map([[repoKey(EN_TQ), baseMap]]));
  assert.deepEqual([...m.entries()], [...baseMap.entries()]);
});

test("tQ: a whole-book override (sent as the base) replaces the project-wide file", () => {
  const whole = { base: RU_TQ, ranges: [] };
  assert.deepEqual(planRepos(whole).map(repoKey), [repoKey(RU_TQ)], "only the override is fetched");
  const m = mergeSourceNotes(whole, new Map([[repoKey(RU_TQ), parseSourceQuestionTsv(qtsv([["1:1", "ab12", "RU one"], ["9:1", "gh78", "RU nine"]]))]]));
  assert.equal(m.get("ab12")?.question, "RU one");
  assert.equal(m.get("gh78")?.question, "RU nine");
});
