// Issue #601, option B (decided 2026-11-02): an AI translate apply skips a note
// a person changed after the job was queued, and reports what it skipped.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelineApplySkipsTouched.test.mjs
//
// THE BUG. #561 / #602 lock notes only while a translate job RUNS. A job can
// wait in the queue a long time; an edit, Approve, Not needed or Restore made
// during that wait was accepted, and when the job later applied,
// applyTranslateTnRow read the row's version fresh, won its CAS and wrote the
// AI draft over the person's work.
//
// Same harness as chapterLockApproveTrash.test.mjs: the REAL Hono router and
// the REAL migration schema. The touch goes through the real route, so the
// edit_log row the apply reads is written exactly as in production. The job is
// seeded already staged (staged_at set), so importJobOutput goes straight to
// the apply phase with the seeded pending_imports rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { bulkReviewState } from "./reviewState.ts";
import { importJobOutput } from "./pipelineImport.ts";

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
const JOB = "job-601";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  const ins = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, translation_state, trashed_at)
     VALUES (?, ?, 1, ?, ?, 'old note', 10, 3, 9, 'ai_draft', ?)`,
  );
  ins.run("c1v1", BOOK, 1, "1:1", null);
  ins.run("c1v2", BOOK, 2, "1:2", null);
  ins.run("c1v3", BOOK, 3, "1:3", null);
  ins.run("c1tr", BOOK, 7, "1:7", 500); // already trashed, for /restore

  // The chapter-wide translate job, queued 100s ago. created_at is the enqueue
  // time (pipelines.ts INSERTs the 'queued' row with created_at = unixepoch()).
  const now = Math.floor(Date.now() / 1000);
  const queuedAt = now - 100;
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, staged_at)
       VALUES (?, 9, 'translate', ?, 1, 1, 's', 'queued', ?, ?)`,
    )
    .run(JOB, BOOK, queuedAt, now);
  // One AI proposal per note, as staging would have written them.
  const prop = sqlite.prepare(
    `INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES (?, 'tn', ?, 1, ?, ?)`,
  );
  for (const [id, verse] of [["c1v1", 1], ["c1v2", 2], ["c1v3", 3], ["c1tr", 7]]) {
    prop.run(JOB, BOOK, verse, JSON.stringify({ id, note: `AI note ${id}` }));
  }

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
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) },
      env,
      ctx,
    );
  const patch = (id, version, body) =>
    app.request(
      `/api/rows/tn/${id}?book=${BOOK}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": String(version) },
        body: JSON.stringify(body),
      },
      env,
      ctx,
    );
  const sweep = (body) =>
    app.request(
      `/api/books/${BOOK}/review-state`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      env,
      ctx,
    );
  // The queue reaches this job: it runs, then its output is applied.
  const apply = async () => {
    sqlite.prepare(`UPDATE pipeline_jobs SET state = 'running' WHERE job_id = ?`).run(JOB);
    return importJobOutput(
      env,
      { jobId: JOB, pipelineType: "translate", book: BOOK, startChapter: 1, endChapter: 1, cfg: {} },
      [],
    );
  };
  const row = (id) =>
    sqlite.prepare(`SELECT note, version, translation_state, trashed_at FROM tn_rows WHERE id = ?`).get(id);
  const proposal = (id) =>
    sqlite
      .prepare(`SELECT accepted_at, rejected_at FROM pending_imports WHERE job_id = ? AND json_extract(payload_json, '$.id') = ?`)
      .get(JOB, id);
  const alerts = () => sqlite.prepare(`SELECT username, message, link_url FROM system_alerts`).all();
  return { sqlite, post, patch, sweep, apply, row, proposal, alerts, queuedAt };
}

function assertDrafted(t, id) {
  const r = t.row(id);
  assert.equal(r.note, `AI note ${id}`, `${id} got the AI draft`);
  assert.equal(r.translation_state, "ai_draft");
  assert.notEqual(t.proposal(id).accepted_at, null, `${id}'s proposal is resolved`);
}

test("a note EDITED while the job was queued keeps the translator's text", async () => {
  const t = fresh();
  const res = await t.patch("c1v1", 3, { note: "translator text" });
  assert.equal(res.status, 200, "the edit is accepted while the job is only queued");

  const out = await t.apply();

  const r = t.row("c1v1");
  assert.equal(r.note, "translator text", "the AI draft did not overwrite the edit");
  assert.equal(r.version, 4, "the apply did not write the row");
  assert.equal(t.proposal("c1v1").accepted_at, null, "the proposal is left unapplied");
  assert.equal(out.applied.tnSkippedTouched, 1);
  assert.deepEqual(out.applied.tnSkippedTouchedIds, ["c1v1"]);
  assertDrafted(t, "c1v2");
  assertDrafted(t, "c1v3");
});

test("a note APPROVED while the job was queued stays approved", async () => {
  const t = fresh();
  assert.equal((await t.post("c1v1", "validate", { value: 1 })).status, 200);

  const out = await t.apply();

  const r = t.row("c1v1");
  assert.equal(r.translation_state, "validated", "the approval was not undone");
  assert.equal(r.note, "old note");
  assert.equal(out.applied.tnSkippedTouched, 1);
  assertDrafted(t, "c1v2");
});

test("a note marked NOT NEEDED while the job was queued gets no AI draft", async () => {
  const t = fresh();
  assert.equal((await t.post("c1v1", "trash")).status, 200);

  const out = await t.apply();

  const r = t.row("c1v1");
  assert.notEqual(r.trashed_at, null, "still trashed");
  assert.equal(r.note, "old note", "no AI text was written into the trashed note");
  assert.equal(out.applied.tnSkippedTouched, 1);
});

test("a note RESTORED while the job was queued keeps its restored text", async () => {
  const t = fresh();
  assert.equal((await t.post("c1tr", "restore")).status, 200);

  const out = await t.apply();

  const r = t.row("c1tr");
  assert.equal(r.trashed_at, null);
  assert.equal(r.note, "old note");
  assert.equal(out.applied.tnSkippedTouched, 1);
  assert.deepEqual(out.applied.tnSkippedTouchedIds, ["c1tr"]);
});

test("an admin approve sweep while the job was queued is kept too", async () => {
  const t = fresh();
  const res = await t.sweep({ resource: "tn", target: "approved", chapter: 1 });
  assert.equal(res.status, 200, await res.clone().text());

  const out = await t.apply();

  for (const id of ["c1v1", "c1v2", "c1v3"]) {
    assert.equal(t.row(id).translation_state, "validated", `${id} stays approved`);
    assert.equal(t.row(id).note, "old note");
  }
  assert.equal(out.applied.tnSkippedTouched, 3);
});

test("the skipped notes are reported to the person who started the job", async () => {
  const t = fresh();
  await t.patch("c1v1", 3, { note: "translator text" });
  await t.post("c1v2", "validate", { value: 1 });

  await t.apply();

  const list = t.alerts();
  assert.equal(list.length, 1, "one alert for the job");
  assert.equal(list[0].username, "translator");
  assert.match(list[0].message, /2 notes/);
  assert.match(list[0].message, /1:1/);
  assert.match(list[0].message, /1:2/);
  assert.equal(list[0].link_url, `#/${BOOK}/1`);
});

test("nothing touched: every note is drafted and no alert is written", async () => {
  const t = fresh();
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assertDrafted(t, "c1v2");
  assertDrafted(t, "c1v3");
  assert.equal(out.applied.tnSkippedTouched, 0);
  assert.equal(t.alerts().length, 0);
});

test("an edit made BEFORE the job was queued does not stop the draft", async () => {
  const t = fresh();
  t.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, created_at)
       VALUES ('tn', 'c1v1', ?, 9, 2, 3, 'update', ?)`,
    )
    .run(BOOK, t.queuedAt - 50);
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("a Keep or hint toggle after queueing does not stop the draft (the apply never writes those bits)", async () => {
  const t = fresh();
  assert.equal((await t.post("c1v1", "preserve", { value: 1 })).status, 200);
  assert.equal((await t.post("c1v2", "hint", { value: 1 })).status, 200);
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assertDrafted(t, "c1v2");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("an un-approve after queueing does not stop the draft", async () => {
  const t = fresh();
  t.sqlite.prepare(`UPDATE tn_rows SET translation_state = 'validated' WHERE id = 'c1v1'`).run();
  assert.equal((await t.post("c1v1", "validate", { value: 0 })).status, 200);
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("machine writes after queueing (AI, reimport) do not stop the draft", async () => {
  const t = fresh();
  const ins = t.sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
     VALUES ('tn', ?, ?, 9, 3, 3, 'update', ?)`,
  );
  ins.run("c1v1", BOOK, "ai_pipeline");
  ins.run("c1v2", BOOK, "dcs_reimport");
  ins.run("c1v3", BOOK, "hint_expansion");
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assertDrafted(t, "c1v2");
  assertDrafted(t, "c1v3");
  assert.equal(out.applied.tnSkippedTouched, 0);
});
