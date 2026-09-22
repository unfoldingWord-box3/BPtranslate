// Tests for packageLifecycle.ts (the package hub lifecycle card's pure logic).
// Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/packageLifecycle.test.mjs
// Not a framework; failures exit non-zero. Mirrors bookSummary.test.mjs.

import {
  classifySnapshot,
  draftsAwaitingReview,
  isTerminalRunStatus,
  latestPerResource,
  progressPercent,
  reviewProgress,
} from "./packageLifecycle.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── reviewProgress ──────────────────────────────────────────────────────────

const ch = (chapter, verses, tn, tq, rollup = {}) => ({ chapter, verses, tn, tq, twl: 0, ...rollup });

assert(
  reviewProgress([ch(1, 10, 5, 3), ch(2, 8, 4, 2)]) === null,
  "no rollup fields anywhere -> null (older API build, hide progress)",
);

{
  const p = reviewProgress([
    ch(1, 10, 5, 3, { tnValidated: 2, tqValidated: 1, versesDone: 4 }),
    ch(2, 8, 4, 2, { tnValidated: 4, tqValidated: 0, versesDone: 0 }),
  ]);
  assert(p !== null, "rollup present -> progress object");
  assert(p.notes.done === 6 && p.notes.total === 9, "notes sum tnValidated / tn");
  assert(p.questions.done === 1 && p.questions.total === 5, "questions sum tqValidated / tq");
  assert(p.verses.done === 4 && p.verses.total === 18, "verses sum versesDone / verses");
}

{
  // Mixed: one chapter from a cache predating the rollup — missing fields count 0.
  const p = reviewProgress([
    ch(1, 10, 5, 3, { tnValidated: 5, tqValidated: 3, versesDone: 10 }),
    ch(2, 8, 4, 2),
  ]);
  assert(p !== null && p.notes.done === 5 && p.notes.total === 9, "missing per-chapter fields coerce to 0");
}

// ── draftsAwaitingReview (issue #104 rollup extension) ──────────────────────

assert(
  draftsAwaitingReview([ch(1, 10, 5, 3, { tnValidated: 2 }), ch(2, 8, 4, 2)]) === null,
  "validated-only rollup (API predates the state breakdown) -> null, not 0",
);

{
  const a = draftsAwaitingReview([
    ch(1, 10, 5, 3, { tnAiDraft: 2, tnEdited: 1, tnNoState: 2, tqAiDraft: 1, tqEdited: 0, tqNoState: 1 }),
    ch(2, 8, 4, 2, { tnAiDraft: 0, tnEdited: 1, tnNoState: 3, tqAiDraft: 0, tqEdited: 2, tqNoState: 0 }),
  ]);
  assert(a !== null, "state breakdown present -> object");
  assert(a.notes === 4, "notes awaiting review = ai_draft + edited across chapters");
  assert(a.questions === 3, "questions awaiting review = ai_draft + edited across chapters");
}

{
  // NoState rows are untranslated source, never a review backlog.
  const a = draftsAwaitingReview([ch(1, 10, 9, 4, { tnAiDraft: 0, tnEdited: 0, tnNoState: 9, tqNoState: 4 })]);
  assert(a !== null && a.notes === 0 && a.questions === 0, "rows with no translation_state are not a backlog");
}

assert(progressPercent({ done: 0, total: 0 }) === 0, "0/0 -> 0% (no divide-by-zero)");
assert(progressPercent({ done: 3, total: 12 }) === 25, "3/12 -> 25%");
assert(progressPercent({ done: 15, total: 12 }) === 100, "overshoot clamps to 100");

// ── classifySnapshot ────────────────────────────────────────────────────────

const snap = (over = {}) => ({ rows_exported: 0, error: null, pr_error: null, ...over });

{
  const o = classifySnapshot(snap({ rows_exported: 46 }));
  assert(o.kind === "committed" && o.rows === 46 && o.prProblem === null, "error NULL -> committed with rows");
}
{
  const o = classifySnapshot(snap({ rows_exported: 46, pr_error: "pr_create_failed" }));
  assert(o.kind === "committed" && o.prProblem === "pr_create_failed", "pr_error surfaces on committed rows");
}
{
  const o = classifySnapshot(snap({ error: "held_for_review:17" }));
  assert(o.kind === "held" && o.count === 17, "held_for_review:<n> -> held with parsed count");
}
{
  const o = classifySnapshot(snap({ error: "unchanged" }));
  assert(o.kind === "unchanged", "unchanged -> unchanged");
}
{
  const o = classifySnapshot(snap({ error: "error:branch ref corrupt" }));
  assert(o.kind === "error" && o.detail === "branch ref corrupt", "error:<msg> -> error with detail");
}
for (const reason of ["dry_run", "no_service_token", "no_rows", "stale_master:sha_mismatch", "held_out:tn", "shrink_guard:rows", "lane_export_disabled"]) {
  const o = classifySnapshot(snap({ error: reason }));
  assert(o.kind === "skipped" && o.reason === reason, `named skip '${reason}' -> skipped`);
}
{
  const o = classifySnapshot(snap({ error: "held_for_review:notanumber" }));
  assert(o.kind === "skipped", "malformed held_for_review count falls back to skipped");
}

// ── latestPerResource ───────────────────────────────────────────────────────

const row = (id, resource, over = {}) => ({
  id,
  book: "ZEC",
  resource,
  branch: null,
  commit_sha: null,
  committed_at: id,
  rows_exported: 0,
  error: null,
  pr_number: null,
  pr_error: null,
  ...over,
});

{
  const out = latestPerResource([
    row(9, "tn"),
    row(3, "tn", { error: "dry_run" }),
    row(7, "tq"),
    row(8, "ult"),
    row(2, "ctx"), // context pack — not a book resource, omitted
  ]);
  assert(out.length === 3, "one entry per seen resource, unknown resources omitted");
  assert(out[0].resource === "ult" && out[1].resource === "tn" && out[2].resource === "tq",
    "canonical order ult..tq regardless of input order");
  assert(out[1].id === 9, "picks max id per resource, not input order");
}
assert(latestPerResource([]).length === 0, "no snapshots -> empty list");

// ── isTerminalRunStatus ─────────────────────────────────────────────────────

for (const s of ["complete", "errored", "terminated"]) {
  assert(isTerminalRunStatus(s), `'${s}' is terminal`);
}
for (const s of ["queued", "running", "paused", "waiting", "unknown", null, undefined]) {
  assert(!isTerminalRunStatus(s), `'${s}' is not terminal`);
}

if (failed > 0) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("packageLifecycle.test.mjs: all assertions passed");
