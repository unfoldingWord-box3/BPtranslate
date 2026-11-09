// Tests for the per-chapter AI draft quality scorecard (issue #816,
// api/src/draftScorecard.ts).
//
//  1. The pure metric functions: normalized edit-distance similarity, median,
//     the closing-period-after-`]` correction rule, the English-source rule,
//     draft → translate-job matching, and the per-chapter rollup that ties them
//     together (missing drafts, English-source exclusions, counts that
//     reconcile).
//  2. The loader SQL against the REAL schema (every file in api/migrations,
//     applied in order to node:sqlite), so "the latest ai_pipeline edit_log row
//     per validated note" is checked as SQL, not as a hand-copied query.
//  3. The route: admin-only (an editor gets 403), and a real admin response.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/draftScorecard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { SignJWT } from "jose";

import { attachAuth, requireAdmin } from "./auth.ts";
import {
  editSimilarity,
  median,
  closingPeriodOutcome,
  isEnglishSourceDraft,
  matchDraftJob,
  buildScorecard,
  loadScorecardInputs,
  draftScorecard,
} from "./draftScorecard.ts";

// ── 1. Pure metrics ─────────────────────────────────────────────────────────

test("editSimilarity: identical, empty, and fully different strings", () => {
  assert.equal(editSimilarity("abc", "abc"), 1);
  assert.equal(editSimilarity("", ""), 1);
  assert.equal(editSimilarity("abc", ""), 0);
  assert.equal(editSimilarity("", "abc"), 0);
  assert.equal(editSimilarity("abc", "xyz"), 0);
});

test("editSimilarity: 1 − levenshtein / longer length", () => {
  // kitten → sitting: distance 3, longer length 7.
  assert.equal(editSimilarity("kitten", "sitting"), 1 - 3 / 7);
  // One added character at the end (the closing period case).
  assert.equal(editSimilarity("[نص]", "[نص]."), 1 - 1 / 5);
  // A change in the middle with a long shared prefix and suffix.
  assert.equal(editSimilarity("aaaaXbbbb", "aaaaYbbbb"), 1 - 1 / 9);
});

test("editSimilarity counts code points, not UTF-16 units", () => {
  // "𝔸" is one code point but two UTF-16 units.
  assert.equal(editSimilarity("𝔸b", "𝔸c"), 0.5);
});

test("editSimilarity stays fast at book scale (worst case: every note fully rewritten)", () => {
  // A real book is ~3,000 validated notes, mostly small edits, which cost far
  // less because the shared prefix and suffix are stripped first. The worst
  // case is every 400-character note rewritten end to end; 600 such pairs
  // (a fifth of a book) keep the suite quick and extrapolate linearly.
  const a = "ب".repeat(200) + "ت".repeat(200);
  const b = "ت".repeat(200) + "ب".repeat(200);
  const t0 = performance.now();
  for (let i = 0; i < 600; i++) editSimilarity(a + i, b + i);
  const ms = performance.now() - t0;
  // A coarse guard against an accidental blow-up (a cubic loop, no prefix
  // strip), not a benchmark: ~1s locally under the full parallel suite, so the
  // limit leaves room for a slow CI runner. A Worker request's CPU budget is 30s.
  assert.ok(ms < 8_000, `600 worst-case pairs took ${Math.round(ms)}ms`);
});

test("median: odd, even, empty", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("closingPeriodOutcome: eligible only when the draft ends with ]", () => {
  assert.equal(closingPeriodOutcome("ترجمة بديلة: [نص]", "ترجمة بديلة: [نص]."), "made");
  assert.equal(closingPeriodOutcome("ترجمة بديلة: [نص]", "ترجمة بديلة: [نص]"), "not_made");
  // Trailing whitespace is ignored on both sides.
  assert.equal(closingPeriodOutcome("[نص]  ", "[نص]. "), "made");
  // A final that was rewritten to end some other way did not add the period.
  assert.equal(closingPeriodOutcome("[نص]", "نص آخر."), "not_made");
  // Draft already has the period, or does not end with ] at all.
  assert.equal(closingPeriodOutcome("[نص].", "[نص]."), "ineligible");
  assert.equal(closingPeriodOutcome("نص.", "نص."), "ineligible");
  assert.equal(closingPeriodOutcome("", "."), "ineligible");
});

test("isEnglishSourceDraft: the draft equals the English source note (trimmed)", () => {
  assert.equal(isEnglishSourceDraft("Here Jesus speaks.", "Here Jesus speaks."), true);
  assert.equal(isEnglishSourceDraft("Here Jesus speaks. ", " Here Jesus speaks."), true);
  assert.equal(isEnglishSourceDraft("هنا يتكلم يسوع.", "Here Jesus speaks."), false);
  // No English note known, or an empty one: never a match.
  assert.equal(isEnglishSourceDraft("x", undefined), false);
  assert.equal(isEnglishSourceDraft("", ""), false);
});

const job = (o) => ({
  jobId: o.jobId,
  startChapter: o.start ?? 1,
  endChapter: o.end ?? 1,
  createdAt: o.createdAt ?? 100,
  updatedAt: o.updatedAt ?? 1000,
  editLogWatermark: o.watermark === undefined ? null : o.watermark,
  contextRef: o.contextRef === undefined ? "org/ctx@abc" : o.contextRef,
  resourceType: o.resourceType ?? null,
});

test("matchDraftJob: picks the latest translate job that covers the chapter and brackets the draft", () => {
  const jobs = [
    job({ jobId: "old", start: 1, end: 3, createdAt: 100, updatedAt: 200, watermark: 10, contextRef: "o/c@old" }),
    job({ jobId: "new", start: 2, end: 2, createdAt: 300, updatedAt: 400, watermark: 50, contextRef: "o/c@new" }),
  ];
  // Chapter 2, drafted at 350 with log id 60: both cover it, "new" is the later one.
  assert.equal(matchDraftJob({ chapter: 2, draftLogId: 60, draftedAt: 350 }, jobs)?.jobId, "new");
  // Chapter 1 is only in "old".
  assert.equal(matchDraftJob({ chapter: 1, draftLogId: 20, draftedAt: 150 }, jobs)?.jobId, "old");
  // A draft written after the job last updated was not that job's apply.
  assert.equal(matchDraftJob({ chapter: 1, draftLogId: 70, draftedAt: 500 }, jobs), null);
  // A draft logged before the job's watermark predates the job.
  assert.equal(matchDraftJob({ chapter: 2, draftLogId: 40, draftedAt: 350 }, [jobs[1]]), null);
});

test("matchDraftJob: front matter (chapter 0) rides with a job starting at chapter 1", () => {
  const jobs = [job({ jobId: "j", start: 1, end: 2 })];
  assert.equal(matchDraftJob({ chapter: 0, draftLogId: 5, draftedAt: 150 }, jobs)?.jobId, "j");
  assert.equal(matchDraftJob({ chapter: 0, draftLogId: 5, draftedAt: 150 }, [job({ jobId: "k", start: 2, end: 3 })]), null);
});

test("matchDraftJob: no watermark falls back to created_at; tq-only jobs never match", () => {
  const legacy = job({ jobId: "legacy", createdAt: 100, updatedAt: 300, watermark: null });
  assert.equal(matchDraftJob({ chapter: 1, draftLogId: 1, draftedAt: 150 }, [legacy])?.jobId, "legacy");
  assert.equal(matchDraftJob({ chapter: 1, draftLogId: 1, draftedAt: 50 }, [legacy]), null);
  const tq = job({ jobId: "tq", resourceType: "tq" });
  assert.equal(matchDraftJob({ chapter: 1, draftLogId: 1, draftedAt: 150 }, [tq]), null);
});

const row = (o) => ({
  id: o.id,
  chapter: o.chapter ?? 1,
  finalNote: o.final ?? null,
  draftLogId: o.draft === undefined ? null : (o.logId ?? 1),
  draftedAt: o.draft === undefined ? null : (o.at ?? 150),
  draftNote: o.draft === undefined ? null : o.draft,
});

test("buildScorecard: per-chapter counts reconcile and metrics follow the rules", () => {
  const rows = [
    // Chapter 1: two unchanged, one edited, one closing-period fix, one missing draft.
    row({ id: "a1", chapter: 1, draft: "نص أ", final: "نص أ" }),
    row({ id: "a2", chapter: 1, draft: "نص ب", final: "نص ب" }),
    row({ id: "a3", chapter: 1, draft: "نص ج", final: "نص ج معدل" }),
    row({ id: "a4", chapter: 1, draft: "ترجمة: [نص]", final: "ترجمة: [نص]." }),
    row({ id: "a5", chapter: 1, final: "نص بلا مسودة" }),
    // Chapter 2: one English-source draft (excluded), one eligible-but-not-needed.
    row({ id: "b1", chapter: 2, draft: "Here Jesus speaks.", final: "هنا يتكلم يسوع." }),
    row({ id: "b2", chapter: 2, draft: "ترجمة: [نص]", final: "ترجمة: [نص]" }),
  ];
  const english = new Map([
    [1, new Map([["a1", "English a1"]])],
    [2, new Map([["b1", "Here Jesus speaks."], ["b2", "English b2"]])],
  ]);
  const jobs = [job({ jobId: "j", start: 1, end: 2, contextRef: "BSOJ/ctx@0123456789abcdef" })];
  const sc = buildScorecard(rows, jobs, english);

  const ch1 = sc.chapters.find((c) => c.chapter === 1);
  assert.equal(ch1.validated, 5);
  assert.equal(ch1.noDraft, 1);
  assert.equal(ch1.englishSource, 0);
  assert.equal(ch1.compared, 4);
  assert.equal(ch1.unchanged, 2);
  assert.equal(ch1.englishChecked, true);
  // Similarities: 1, 1, 1 − 5/9 ("نص ج" → "نص ج معدل" adds 5 chars), 1 − 1/12.
  const sims = [1, 1, 1 - 5 / 9, 1 - 1 / 12].sort((x, y) => x - y);
  assert.equal(ch1.medianSimilarity, (sims[1] + sims[2]) / 2);
  assert.deepEqual(ch1.closingPeriod, { eligible: 1, made: 1 });
  assert.deepEqual(ch1.contextPacks, [{ ref: "BSOJ/ctx@0123456789abcdef", count: 4 }]);
  assert.equal(ch1.untracedDrafts, 0);

  const ch2 = sc.chapters.find((c) => c.chapter === 2);
  assert.equal(ch2.validated, 2);
  assert.equal(ch2.englishSource, 1);
  assert.equal(ch2.compared, 1);
  assert.equal(ch2.unchanged, 1);
  assert.equal(ch2.medianSimilarity, 1);
  assert.deepEqual(ch2.closingPeriod, { eligible: 1, made: 0 });
  // The English-source draft is excluded from the context-pack tally too.
  assert.deepEqual(ch2.contextPacks, [{ ref: "BSOJ/ctx@0123456789abcdef", count: 1 }]);

  // Book total is computed from rows, not by averaging chapters.
  assert.equal(sc.total.validated, 7);
  assert.equal(sc.total.compared, 5);
  assert.equal(sc.total.unchanged, 3);
  assert.equal(sc.total.noDraft, 1);
  assert.equal(sc.total.englishSource, 1);
  assert.deepEqual(sc.total.closingPeriod, { eligible: 2, made: 1 });
  for (const c of [...sc.chapters, sc.total]) {
    assert.equal(c.validated, c.compared + c.noDraft + c.englishSource, `chapter ${c.chapter} reconciles`);
  }
});

test("buildScorecard: a chapter whose English source was not read excludes nothing", () => {
  const rows = [row({ id: "x", chapter: 3, draft: "Same text", final: "Same text" })];
  const sc = buildScorecard(rows, [], new Map());
  const ch = sc.chapters[0];
  assert.equal(ch.englishChecked, false);
  assert.equal(ch.englishSource, 0);
  assert.equal(ch.compared, 1);
  assert.equal(ch.unchanged, 1);
});

test("buildScorecard: a chapter with no drafts reports null metrics, not zeros", () => {
  const sc = buildScorecard([row({ id: "n", chapter: 4, final: "x" })], [], new Map([[4, new Map()]]));
  const ch = sc.chapters[0];
  assert.equal(ch.compared, 0);
  assert.equal(ch.unchangedPct, null);
  assert.equal(ch.medianSimilarity, null);
  assert.deepEqual(ch.contextPacks, []);
});

test("buildScorecard: job-without-contextRef and no-surviving-job are told apart", () => {
  const rows = [
    row({ id: "r1", chapter: 1, draft: "د", final: "د", at: 150, logId: 5 }),
    row({ id: "r2", chapter: 1, draft: "د", final: "د", at: 9999, logId: 500 }),
  ];
  const jobs = [job({ jobId: "raw", contextRef: null, createdAt: 100, updatedAt: 200, watermark: 1 })];
  const ch = buildScorecard(rows, jobs, new Map([[1, new Map()]])).chapters[0];
  assert.deepEqual(ch.contextPacks, [{ ref: null, count: 1 }]);
  assert.equal(ch.untracedDrafts, 1);
});

// ── 2. Loader SQL against the real schema ───────────────────────────────────

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    async first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

const BOOK = "LUK";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'admin')`).run();
  return sqlite;
}

function seedTn(sqlite, r) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state, deleted_at, trashed_at)
       VALUES (?, ?, ?, 1, ?, ?, 3, ?, ?, ?)`,
    )
    .run(r.id, r.book ?? BOOK, r.chapter, `${r.chapter}:1`, r.note, r.state ?? "validated", r.deleted ?? null, r.trashed ?? null);
}

function seedLog(sqlite, r) {
  sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, action, payload_json, source, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(r.kind ?? "tn", r.id, r.book === undefined ? BOOK : r.book, r.action ?? "update", JSON.stringify({ id: r.id, note: r.note }), r.source ?? null, r.at ?? 150);
}

test("loadScorecardInputs reads validated live rows with their LATEST ai_pipeline draft", async () => {
  const sqlite = freshDb();
  seedTn(sqlite, { id: "aaaa", chapter: 1, note: "final a" });
  seedLog(sqlite, { id: "aaaa", source: "ai_pipeline", note: "old draft", at: 100 });
  seedLog(sqlite, { id: "aaaa", source: "ai_pipeline", note: "new draft", at: 200 });
  seedLog(sqlite, { id: "aaaa", source: null, note: "final a", at: 300 }); // the human edit
  // Pre-0017 audit rows carry a NULL book and still count.
  seedTn(sqlite, { id: "bbbb", chapter: 2, note: "final b" });
  seedLog(sqlite, { id: "bbbb", book: null, source: "ai_pipeline", note: "draft b" });
  // Another book's row with the same id must not leak in.
  seedLog(sqlite, { id: "cccc", book: "MRK", source: "ai_pipeline", note: "wrong book" });
  seedTn(sqlite, { id: "cccc", chapter: 2, note: "final c" });
  // A tq audit row with the same id is not a tN draft.
  seedLog(sqlite, { id: "cccc", kind: "tq", source: "ai_pipeline", note: "tq draft" });
  // Not validated, deleted, trashed, or another book: all left out.
  seedTn(sqlite, { id: "dddd", chapter: 1, note: "x", state: "edited" });
  seedTn(sqlite, { id: "eeee", chapter: 1, note: "x", deleted: 5 });
  seedTn(sqlite, { id: "ffff", chapter: 1, note: "x", trashed: 5 });
  seedTn(sqlite, { id: "gggg", chapter: 1, note: "x", book: "MRK" });
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state,
                                  options_json, created_at, updated_at, edit_log_watermark)
       VALUES ('j1', 1, 'translate', ?, 1, 2, 's', 'done', ?, 50, 400, 0),
              ('j2', 1, 'notes', ?, 1, 2, 's', 'done', NULL, 50, 400, 0),
              ('j3', 1, 'translate', ?, 1, 2, 's', 'done', 'not json', 50, 400, 0)`,
    )
    .run(BOOK, JSON.stringify({ contextRef: "BSOJ/ctx@abc123", resourceType: "tn" }), BOOK, BOOK);

  const { rows, jobs } = await loadScorecardInputs(makeDb(sqlite), BOOK);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ["aaaa", "bbbb", "cccc"]);
  assert.equal(byId.aaaa.draftNote, "new draft");
  assert.equal(byId.aaaa.finalNote, "final a");
  assert.equal(byId.aaaa.draftedAt, 200);
  assert.equal(byId.bbbb.draftNote, "draft b");
  assert.equal(byId.cccc.draftLogId, null, "another book's or another kind's audit row is not this row's draft");
  assert.deepEqual(
    jobs.map((j) => [j.jobId, j.contextRef, j.resourceType]).sort(),
    [["j1", "BSOJ/ctx@abc123", "tn"], ["j3", null, null]],
  );
});

// ── 3. Route: admin only ────────────────────────────────────────────────────

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";

async function token(role) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: "ada", role, ws: "default" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("1")
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.get("/api/books/:book/draft-scorecard", requireAdmin, draftScorecard);
  return app;
}

test("GET /api/books/:book/draft-scorecard is admin-only and returns the scorecard", async () => {
  const sqlite = freshDb();
  seedTn(sqlite, { id: "aaaa", chapter: 1, note: "final" });
  seedLog(sqlite, { id: "aaaa", source: "ai_pipeline", note: "final" });
  const env = { JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: ISSUER, DCS_BASE_URL: "https://git.door43.org", DB: makeDb(sqlite) };
  const app = buildApp();
  // The English source read must never reach the network from a test.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("no network in tests");
  };
  try {
    const anon = await app.request("/api/books/LUK/draft-scorecard", {}, env);
    assert.equal(anon.status, 401);

    const editor = await app.request(
      "/api/books/LUK/draft-scorecard",
      { headers: { cookie: `be_access=${await token("editor")}` } },
      env,
    );
    assert.equal(editor.status, 403);

    const admin = await app.request(
      "/api/books/luk/draft-scorecard",
      { headers: { cookie: `be_access=${await token("admin")}` } },
      env,
    );
    assert.equal(admin.status, 200);
    const body = await admin.json();
    assert.equal(body.book, "LUK");
    assert.equal(body.chapters.length, 1);
    assert.equal(body.chapters[0].compared, 1);
    assert.equal(body.chapters[0].unchanged, 1);
    assert.equal(body.chapters[0].unchangedPct, 100);

    const bad = await app.request(
      "/api/books/XYZ/draft-scorecard",
      { headers: { cookie: `be_access=${await token("admin")}` } },
      env,
    );
    assert.equal(bad.status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});
