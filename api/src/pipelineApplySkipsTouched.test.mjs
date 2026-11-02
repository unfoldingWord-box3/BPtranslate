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
import { pipelines } from "./pipelines.ts";

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

// watermark: true stamps edit_log_watermark the way pipelines.ts does (inside
// the INSERT); false leaves it NULL, as on a job queued before migration 0076.
// beforeEnqueue: edit_log touches written before the job is queued.
// kind: "tq" seeds a translate-questions job instead (#725): tq rows q1v1-q1v3
// and one question proposal each. A translate job produces one resource kind.
function fresh({ options = null, watermark = true, beforeEnqueue = [], kind = "tn" } = {}) {
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
  ins.run("c1in", BOOK, 0, "1:intro", null); // chapter intro (verse 0)
  const insQ = sqlite.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, updated_by, translation_state)
     VALUES (?, ?, 1, ?, ?, 'old question', 'old response', 10, 3, 9, 'ai_draft')`,
  );
  insQ.run("q1v1", BOOK, 1, "1:1");
  insQ.run("q1v2", BOOK, 2, "1:2");
  insQ.run("q1v3", BOOK, 3, "1:3");

  // The chapter-wide translate job, queued 100s ago. created_at is the enqueue
  // time (pipelines.ts INSERTs the 'queued' row with created_at = unixepoch()).
  const now = Math.floor(Date.now() / 1000);
  const queuedAt = now - 100;
  for (const { rowKey, at } of beforeEnqueue) {
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, created_at)
         VALUES (?, ?, ?, 9, 2, 3, 'update', ?)`,
      )
      .run(kind, rowKey, BOOK, at ?? queuedAt);
  }
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, staged_at, options_json, edit_log_watermark)
       VALUES (?, 9, 'translate', ?, 1, 1, 's', 'queued', ?, ?, ?, ${watermark ? "(SELECT COALESCE(MAX(id), 0) FROM edit_log)" : "NULL"})`,
    )
    .run(JOB, BOOK, queuedAt, now, options ? JSON.stringify(options) : null);
  // One AI proposal per note, as staging would have written them.
  const prop = sqlite.prepare(
    `INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES (?, ?, ?, 1, ?, ?)`,
  );
  if (kind === "tq") {
    for (const [id, verse] of [["q1v1", 1], ["q1v2", 2], ["q1v3", 3]]) {
      prop.run(JOB, "tq", BOOK, verse, JSON.stringify({ id, question: `AI question ${id}`, response: `AI response ${id}` }));
    }
  } else {
    for (const [id, verse] of [["c1v1", 1], ["c1v2", 2], ["c1v3", 3], ["c1tr", 7], ["c1in", 0]]) {
      prop.run(JOB, "tn", BOOK, verse, JSON.stringify({ id, note: `AI note ${id}` }));
    }
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  app.post("/api/books/:book/review-state", bulkReviewState);
  app.route("/api/pipelines", pipelines);
  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const post = (id, action, body) =>
    app.request(
      `/api/rows/${kind}/${id}/${action}?book=${BOOK}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) },
      env,
      ctx,
    );
  const patch = (id, version, body) =>
    app.request(
      `/api/rows/${kind}/${id}?book=${BOOK}`,
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
    kind === "tq"
      ? sqlite.prepare(`SELECT question, response, version, translation_state FROM tq_rows WHERE id = ?`).get(id)
      : sqlite.prepare(`SELECT note, version, translation_state, trashed_at FROM tn_rows WHERE id = ?`).get(id);
  const proposal = (id) =>
    sqlite
      .prepare(`SELECT accepted_at, rejected_at FROM pending_imports WHERE job_id = ? AND json_extract(payload_json, '$.id') = ?`)
      .get(JOB, id);
  const alerts = () => sqlite.prepare(`SELECT username, message, link_url FROM system_alerts`).all();
  const stored = () => {
    const r = sqlite.prepare(`SELECT apply_skipped_json FROM pipeline_jobs WHERE job_id = ?`).get(JOB);
    return r.apply_skipped_json === null ? null : JSON.parse(r.apply_skipped_json);
  };
  // A hand-written edit_log row: for sources and timestamps the routes can't
  // produce here (chat, machine writers, a chosen second).
  const logTouch = (rowKey, { book = BOOK, action = "update", source = null, at = Math.floor(Date.now() / 1000) } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, created_at)
         VALUES (?, ?, ?, 9, 3, 3, ?, ?, ?)`,
      )
      .run(kind, rowKey, book, action, source, at);
  const get = (path) => app.request(path, { method: "GET" }, env, ctx);
  return { sqlite, post, patch, sweep, apply, row, proposal, alerts, stored, logTouch, get, queuedAt };
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

  for (const id of ["c1v1", "c1v2", "c1v3", "c1in"]) {
    assert.equal(t.row(id).translation_state, "validated", `${id} stays approved`);
    assert.equal(t.row(id).note, "old note");
  }
  assert.equal(out.applied.tnSkippedTouched, 4);
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
  const t = fresh({ beforeEnqueue: [{ rowKey: "c1v1", at: Math.floor(Date.now() / 1000) - 150 }] });
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

test("the skip report is stored on the job for the status and list APIs", async () => {
  const t = fresh();
  await t.patch("c1v1", 3, { note: "translator text" });
  await t.apply();
  assert.deepEqual(t.stored(), { tnTouched: 1, tnTouchedIds: ["c1v1"] });
});

test("nothing skipped: the stored skip report is empty", async () => {
  const t = fresh();
  await t.apply();
  assert.equal(t.stored(), null);
});

test("a touch from the chat counts as a person", async () => {
  const t = fresh();
  t.logTouch("c1v1", { source: "chat" });
  const out = await t.apply();
  assert.equal(t.row("c1v1").note, "old note");
  assert.equal(out.applied.tnSkippedTouched, 1);
});

test("a history restore (PATCH with restored_from_version) while queued is kept", async () => {
  const t = fresh();
  const res = await t.patch("c1v1", 3, { note: "older text", restored_from_version: 1 });
  assert.equal(res.status, 200);
  const out = await t.apply();
  assert.equal(t.row("c1v1").note, "older text");
  assert.equal(out.applied.tnSkippedTouched, 1);
});

test("a retried import gives the same counts and replaces the alert", async () => {
  const t = fresh();
  await t.patch("c1v1", 3, { note: "translator text" });
  const first = await t.apply();
  // The one-retry path: the failed import released its claim.
  t.sqlite.prepare(`UPDATE pipeline_jobs SET import_claimed_at = NULL WHERE job_id = ?`).run(JOB);
  const second = await t.apply();
  assert.equal(first.applied.tnSkippedTouched, 1);
  assert.equal(second.applied.tnSkippedTouched, 1, "the skipped proposal is skipped again, not applied");
  assert.equal(t.row("c1v1").note, "translator text");
  assert.equal(t.alerts().length, 1, "the alert is replaced, not duplicated");
  assert.deepEqual(t.stored(), { tnTouched: 1, tnTouchedIds: ["c1v1"] });
});

// Same second, both orders. The enqueue and the edit can share a unixepoch()
// second; the edit_log watermark orders them exactly (edit_log.id).
test("same second, edit after the enqueue: a chapter-wide job keeps the note", async () => {
  const t = fresh();
  t.logTouch("c1v1", { at: t.queuedAt });
  const out = await t.apply();
  assert.equal(t.row("c1v1").note, "old note");
  assert.equal(out.applied.tnSkippedTouched, 1);
});

test("same second, edit after the enqueue: a Redo of that note keeps the edit", async () => {
  const t = fresh({ options: { resourceType: "tn", rowIds: ["c1v1"] } });
  t.logTouch("c1v1", { at: t.queuedAt });
  const out = await t.apply();
  assert.equal(t.row("c1v1").note, "old note", "an edit committed after the Redo was queued is not overwritten");
  assert.equal(out.applied.tnSkippedTouched, 1);
});

test("same second, edit before the enqueue: a Redo of that note still drafts it", async () => {
  const t = fresh({
    options: { resourceType: "tn", rowIds: ["c1v1"] },
    beforeEnqueue: [{ rowKey: "c1v1" }], // at the enqueue second
  });
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("same second, edit before the enqueue: a chapter-wide job drafts it too", async () => {
  const t = fresh({ beforeEnqueue: [{ rowKey: "c1v1" }] });
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("a job queued before the watermark existed falls back to seconds", async () => {
  // NULL watermark: a touch in a later second counts, an earlier one does not,
  // and an enqueue-second touch counts unless the job is a Redo of that note.
  const t = fresh({ watermark: false, beforeEnqueue: [{ rowKey: "c1v2", at: Math.floor(Date.now() / 1000) - 150 }] });
  t.logTouch("c1v1", { at: t.queuedAt + 1 });
  t.logTouch("c1v3", { at: t.queuedAt });
  const out = await t.apply();
  assert.equal(t.row("c1v1").note, "old note", "later second: kept");
  assertDrafted(t, "c1v2");
  assert.equal(t.row("c1v3").note, "old note", "enqueue second, chapter-wide: kept");
  assert.deepEqual(out.applied.tnSkippedTouchedIds.sort(), ["c1v1", "c1v3"]);

  const r = fresh({ watermark: false, options: { resourceType: "tn", rowIds: ["c1v1"] } });
  r.logTouch("c1v1", { at: r.queuedAt });
  await r.apply();
  assertDrafted(r, "c1v1");
});

test("a touch on the same row id in another book does not count", async () => {
  const t = fresh();
  t.logTouch("c1v1", { book: "MAL" });
  const out = await t.apply();
  assertDrafted(t, "c1v1");
  assert.equal(out.applied.tnSkippedTouched, 0);
});

test("a skipped chapter intro (verse 0) is listed as the intro", async () => {
  const t = fresh();
  t.logTouch("c1in");
  await t.apply();
  assert.match(t.alerts()[0].message, /1:intro/);
  assert.doesNotMatch(t.alerts()[0].message, /1:0\b/);
});

test("the job status and list APIs return the skip report", async () => {
  const t = fresh();
  await t.patch("c1v1", 3, { note: "translator text" });
  await t.apply();
  t.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'done', runner = 'internal', upstream_job_id = 'wf' WHERE job_id = ?`).run(JOB);

  const status = await t.get(`/api/pipelines/${JOB}`);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).applySkipped, { tnTouched: 1, tnTouchedIds: ["c1v1"] });

  const list = await t.get(`/api/pipelines?state=done`);
  assert.equal(list.status, 200);
  const job = (await list.json()).jobs.find((j) => j.job_id === JOB);
  assert.deepEqual(JSON.parse(job.apply_skipped_json), { tnTouched: 1, tnTouchedIds: ["c1v1"] });
});

// ── Questions (#725) ─────────────────────────────────────────────────────────
// The same gap for a translate job over translationQuestions: applyTranslateTqRow
// read the row version at apply time, so its CAS passed and the AI draft
// overwrote a question a person edited or approved while the job waited.

function assertQuestionDrafted(t, id) {
  const r = t.row(id);
  assert.equal(r.question, `AI question ${id}`, `${id} got the AI draft`);
  assert.equal(r.translation_state, "ai_draft");
  assert.notEqual(t.proposal(id).accepted_at, null, `${id}'s proposal is resolved`);
}

test("tq: a question EDITED while the job was queued keeps the translator's text", async () => {
  const t = fresh({ kind: "tq" });
  const res = await t.patch("q1v1", 3, { question: "translator question" });
  assert.equal(res.status, 200, "the edit is accepted while the job is only queued");

  const out = await t.apply();

  const r = t.row("q1v1");
  assert.equal(r.question, "translator question", "the AI draft did not overwrite the edit");
  assert.equal(r.response, "old response");
  assert.equal(r.version, 4, "the apply did not write the row");
  assert.equal(t.proposal("q1v1").accepted_at, null, "the proposal is left unapplied");
  assert.equal(out.applied.tqSkippedTouched, 1);
  assert.deepEqual(out.applied.tqSkippedTouchedIds, ["q1v1"]);
  assert.equal(out.applied.tqUpdated, 2);
  assert.equal(out.applied.tnSkippedTouched, 0);
  assertQuestionDrafted(t, "q1v2");
  assertQuestionDrafted(t, "q1v3");
});

test("tq: a question APPROVED while the job was queued stays approved", async () => {
  const t = fresh({ kind: "tq" });
  assert.equal((await t.post("q1v1", "validate", { value: 1 })).status, 200);

  const out = await t.apply();

  const r = t.row("q1v1");
  assert.equal(r.translation_state, "validated", "the approval was not undone");
  assert.equal(r.question, "old question");
  assert.equal(out.applied.tqSkippedTouched, 1);
  assert.deepEqual(out.applied.tqSkippedTouchedIds, ["q1v1"]);
  assertQuestionDrafted(t, "q1v2");
});

test("tq: an admin approve sweep while the job was queued is kept", async () => {
  const t = fresh({ kind: "tq" });
  const res = await t.sweep({ resource: "tq", target: "approved", chapter: 1 });
  assert.equal(res.status, 200, await res.clone().text());

  const out = await t.apply();

  for (const id of ["q1v1", "q1v2", "q1v3"]) {
    assert.equal(t.row(id).translation_state, "validated", `${id} stays approved`);
    assert.equal(t.row(id).question, "old question");
  }
  assert.equal(out.applied.tqSkippedTouched, 3);
});

test("tq: the skipped questions are reported to the starter, in words that fit questions", async () => {
  const t = fresh({ kind: "tq" });
  await t.patch("q1v1", 3, { question: "translator question" });
  await t.post("q1v2", "validate", { value: 1 });

  await t.apply();

  const list = t.alerts();
  assert.equal(list.length, 1, "one alert for the job");
  assert.equal(list[0].username, "translator");
  assert.match(list[0].message, /2 questions/);
  assert.match(list[0].message, /1:1/);
  assert.match(list[0].message, /1:2/);
  assert.doesNotMatch(list[0].message, /\bnotes?\b/, "says questions, not notes");
  assert.doesNotMatch(list[0].message, /Not needed|restored/, "questions have no Not needed or Restore");
  assert.match(list[0].message, /Run the AI on a question again if you want a draft for it\.$/);
  assert.equal(list[0].link_url, `#/${BOOK}/1`);
});

test("tq: the skip report is stored on the job and returned by the status API", async () => {
  const t = fresh({ kind: "tq" });
  await t.patch("q1v1", 3, { question: "translator question" });
  await t.apply();
  assert.deepEqual(t.stored(), { tqTouched: 1, tqTouchedIds: ["q1v1"] });

  t.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'done', runner = 'internal', upstream_job_id = 'wf' WHERE job_id = ?`).run(JOB);
  const status = await t.get(`/api/pipelines/${JOB}`);
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).applySkipped, { tqTouched: 1, tqTouchedIds: ["q1v1"] });
});

test("tq: nothing touched: every question is drafted, no alert, no stored report", async () => {
  const t = fresh({ kind: "tq" });
  const out = await t.apply();
  assertQuestionDrafted(t, "q1v1");
  assertQuestionDrafted(t, "q1v2");
  assertQuestionDrafted(t, "q1v3");
  assert.equal(out.applied.tqSkippedTouched, 0);
  assert.equal(t.alerts().length, 0);
  assert.equal(t.stored(), null);
});

test("tq: an edit made BEFORE the job was queued does not stop the draft", async () => {
  const t = fresh({ kind: "tq", beforeEnqueue: [{ rowKey: "q1v1", at: Math.floor(Date.now() / 1000) - 150 }] });
  const out = await t.apply();
  assertQuestionDrafted(t, "q1v1");
  assert.equal(out.applied.tqSkippedTouched, 0);
});

test("tq: a touch on a NOTE with the same id does not stop a question's draft", async () => {
  const t = fresh({ kind: "tq" });
  t.sqlite
    .prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', 'q1v1', ?, 9, 3, 4, 'update')`,
    )
    .run(BOOK);
  const out = await t.apply();
  assertQuestionDrafted(t, "q1v1");
  assert.equal(out.applied.tqSkippedTouched, 0);
});
