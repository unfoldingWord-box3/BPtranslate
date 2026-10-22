// Issue #602 (follow-up to #561, decision B): Approve (/validate), Not needed
// (/trash) and Restore (/restore) on a note are refused while an AI TRANSLATE
// run will write that note.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/chapterLockApproveTrash.test.mjs
//
// THE BUG. #561 locked tn PATCH / create / delete during a translate run, but
// left these three routes lock-exempt. applyTranslateTnRow (pipelineImport.ts)
// sets translation_state='ai_draft' and replaces the note text on apply, and
// never looks at trashed_at, so an Approve made mid-run was silently undone and
// a trashed (or restored) note got the AI draft written into it.
//
// /preserve and /hint stay exempt: the translate apply never writes those bits,
// so a toggle made mid-run survives the apply.
//
// Same harness as chapterLockTranslate.test.mjs: the REAL Hono router against
// the REAL migration schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { bulkReviewState } from "./reviewState.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

const BOOK = "ZEC";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  // translation_state='ai_draft': /validate only acts on rows the translate
  // pipeline has drafted (setTnTranslationState guards on IS NOT NULL).
  const ins = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, translation_state, trashed_at)
     VALUES (?, ?, ?, ?, ?, 'old note', 10, 3, 9, 'ai_draft', ?)`,
  );
  ins.run("in01", BOOK, 0, 0, "front:intro", null);
  ins.run("c1v1", BOOK, 1, 1, "1:1", null);
  ins.run("c1v5", BOOK, 1, 5, "1:5", null);
  ins.run("c1tr", BOOK, 1, 7, "1:7", 500); // already trashed, for /restore
  ins.run("c2v1", BOOK, 2, 1, "2:1", null);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  app.post("/api/books/:book/review-state", bulkReviewState);
  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const post = (id, action, body) =>
    app.request(
      `/api/rows/tn/${id}/${action}?book=${BOOK}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      },
      env,
      ctx,
    );
  let n = 0;
  const job = (pipelineType, start, end, state = "running", options = null) =>
    sqlite
      .prepare(
        `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, options_json, created_at)
         VALUES (?, 9, ?, ?, ?, ?, 's', ?, ?, ?)`,
      )
      .run(`job-${++n}`, pipelineType, BOOK, start, end, state, options ? JSON.stringify(options) : null, 1000 + n);
  const row = (id) => sqlite.prepare(`SELECT translation_state, trashed_at FROM tn_rows WHERE id = ?`).get(id);
  const sweep = (body, query = "") =>
    app.request(
      `/api/books/${BOOK}/review-state${query}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env,
      ctx,
    );
  return { post, job, row, sweep, sqlite };
}

const approve = (post, id) => post(id, "validate", { value: 1 });
const trash = (post, id) => post(id, "trash");
const restore = (post, id) => post(id, "restore");

test("during a running chapter-wide translate on chapter 1, Approve / Not needed / Restore on a chapter-1 note are refused", async () => {
  const { post, job, row } = fresh();
  job("translate", 1, 1);

  const a = await approve(post, "c1v1");
  assert.equal(a.status, 409, "Approve is refused");
  const body = await a.json();
  assert.equal(body.error, "chapter_locked");
  assert.equal(body.pipelineType, "translate", "same body shape as the PATCH refusal");
  assert.equal(typeof body.jobId, "string");
  assert.equal(typeof body.startedAt, "number");
  assert.equal(row("c1v1").translation_state, "ai_draft", "the row was not approved");

  const t = await trash(post, "c1v1");
  assert.equal(t.status, 409, "Not needed is refused");
  assert.equal((await t.json()).error, "chapter_locked");
  assert.equal(row("c1v1").trashed_at, null, "the row was not trashed");

  const r = await restore(post, "c1tr");
  assert.equal(r.status, 409, "Restore is refused");
  assert.equal((await r.json()).error, "chapter_locked");
  assert.equal(row("c1tr").trashed_at, 500, "the row stayed trashed");

  assert.equal((await approve(post, "in01")).status, 409, "the book intro is covered by a run starting at chapter 1");
  assert.equal((await trash(post, "in01")).status, 409);

  assert.equal((await approve(post, "c2v1")).status, 200, "a chapter outside the run stays open");
  assert.equal((await trash(post, "c2v1")).status, 200);
});

test("with no job, Approve / Not needed / Restore succeed", async () => {
  const { post, row } = fresh();
  assert.equal((await approve(post, "c1v1")).status, 200);
  assert.equal(row("c1v1").translation_state, "validated");
  assert.equal((await trash(post, "c1v5")).status, 200);
  assert.notEqual(row("c1v5").trashed_at, null);
  assert.equal((await restore(post, "c1tr")).status, 200);
  assert.equal(row("c1tr").trashed_at, null);
});

test("a finished or queued translate job locks nothing", async () => {
  const { post, job } = fresh();
  job("translate", 1, 1, "done");
  job("translate", 1, 1, "queued");
  assert.equal((await approve(post, "c1v1")).status, 200);
  assert.equal((await trash(post, "c1v1")).status, 200);
});

test("during a non-translate job, Approve / Not needed / Restore succeed", async () => {
  const { post, job } = fresh();
  job("notes", 1, 1);
  assert.equal((await approve(post, "c1v1")).status, 200);
  assert.equal((await trash(post, "c1v5")).status, 200);
  assert.equal((await restore(post, "c1tr")).status, 200);
});

test("a row-scoped translate redraft locks only its own row", async () => {
  const { post, job } = fresh();
  job("translate", 1, 1, "running", { resourceType: "tn", rowIds: ["c1v1"] });
  assert.equal((await approve(post, "c1v1")).status, 409, "the redrafted note cannot be approved");
  assert.equal((await trash(post, "c1v1")).status, 409, "the redrafted note cannot be trashed");
  assert.equal((await approve(post, "c1v5")).status, 200, "another note in the chapter can be approved");
  assert.equal((await trash(post, "c1v5")).status, 200, "another note in the chapter can be trashed");
  assert.equal((await restore(post, "c1tr")).status, 200, "another note in the chapter can be restored");
  assert.equal((await approve(post, "in01")).status, 200, "the intro is not in the selection");
});

test("an unknown row is still a 404, not a lock refusal", async () => {
  const { post, job } = fresh();
  job("translate", 1, 1);
  assert.equal((await approve(post, "nope")).status, 404);
  assert.equal((await trash(post, "nope")).status, 404);
});

test("preserve and hint stay lock-exempt during a chapter-wide translate (the apply never writes those bits)", async () => {
  const { post, job } = fresh();
  job("translate", 1, 1);
  assert.equal((await post("c1v1", "preserve", { value: 1 })).status, 200);
  assert.equal((await post("c1v1", "hint", { value: 1 })).status, 200);
});

// Review R2: un-approve ("Revoke example") protects nothing by being refused —
// the apply resets the row to ai_draft anyway — so only approving is locked.
test("un-approve (validate value=0) is let through during a chapter-wide translate", async () => {
  const { post, job, row } = fresh();
  job("translate", 1, 1);
  const r = await post("c1v1", "validate", { value: 0 });
  assert.equal(r.status, 200);
  assert.equal(row("c1v1").translation_state, "edited");
});

// Review R1: the admin bulk review-state sweep set rows to validated with no
// version bump, so the translate apply's CAS did not catch it and the run
// silently undid the sweep. An approve sweep that reaches any note a running
// translate will write is refused as a whole.
test("an approve sweep over a chapter a translate run will write is refused with 409 chapter_locked", async () => {
  const { sweep, job, row } = fresh();
  job("translate", 1, 1);

  const r = await sweep({ resource: "tn", state: "approved", chapter: 1 });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.error, "chapter_locked");
  assert.equal(body.pipelineType, "translate");
  assert.equal(row("c1v1").translation_state, "ai_draft", "nothing was swept");

  assert.equal((await sweep({ resource: "tn", state: "approved", allChapters: true })).status, 409, "a whole-book sweep too");
  assert.equal((await sweep({ resource: "tn", state: "approved", chapter: 1 }, "?dryRun=1")).status, 409, "the dry run says so up front");

  const ok = await sweep({ resource: "tn", state: "approved", chapter: 2 });
  assert.equal(ok.status, 200, "a chapter outside the run can be swept");
  assert.equal(row("c2v1").translation_state, "validated");

  assert.equal((await sweep({ resource: "tn", state: "needs_review", chapter: 1 })).status, 200, "a needs_review sweep is let through");
});

test("an approve sweep with no job, a finished job, or a non-translate job succeeds", async () => {
  const a = fresh();
  assert.equal((await a.sweep({ resource: "tn", state: "approved", chapter: 1 })).status, 200);
  assert.equal(a.row("c1v1").translation_state, "validated");

  const b = fresh();
  b.job("translate", 1, 1, "done");
  b.job("notes", 1, 1);
  assert.equal((await b.sweep({ resource: "tn", state: "approved", chapter: 1 })).status, 200);
});

test("an approve sweep is refused only when it reaches a row a row-scoped redraft will write", async () => {
  const { sweep, job, sqlite } = fresh();
  job("translate", 1, 1, "running", { resourceType: "tn", rowIds: ["c1v1"] });
  assert.equal((await sweep({ resource: "tn", state: "approved", chapter: 1 })).status, 409, "c1v1 is in chapter 1");
  assert.equal((await sweep({ resource: "tn", state: "approved", chapter: 2 })).status, 200, "another chapter is not selected");
  // A trashed row is not swept, so it does not block the sweep either.
  sqlite.prepare(`UPDATE tn_rows SET trashed_at = 1 WHERE id = 'c1v1'`).run();
  assert.equal((await sweep({ resource: "tn", state: "approved", chapter: 1 })).status, 200);
});

test("a whole-book approve sweep is refused when a redraft of the book intro is running", async () => {
  const { sweep, job } = fresh();
  job("translate", 1, 1, "running", { resourceType: "tn", rowIds: ["in01"] });
  assert.equal((await sweep({ resource: "tn", state: "approved", allChapters: true })).status, 409);
  assert.equal((await sweep({ resource: "tn", state: "approved", chapter: 1 })).status, 200, "chapter 1 holds no selected row");
});
