// Issue #561 (decision B): while an AI TRANSLATE run covers a chapter, that
// chapter's notes are read-only until the run finishes.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/chapterLockTranslate.test.mjs
//
// THE BUG. tn PATCH was lock-exempt for every pipeline type, on the theory
// that editing a note "keeps" it. A translate run ignores keep/hint:
// applyTranslateTnRow (pipelineImport.ts) reads the row's version at apply
// time and writes its draft over whatever is there, so a human edit made
// mid-run was silently replaced. The book introduction (chapter 0) was not
// covered by the chapter lock at all, although a translate job that starts at
// chapter 1 translates it too (sliceChapterRows / parseOutputEntry).
//
// Driven through the REAL Hono router against the REAL migration schema: the
// fix is a branch in the PATCH handler plus a SQL predicate, and re-typing
// either would prove nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { activePipelineForChapter } from "./chapterLock.ts";

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
  const ins = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by)
     VALUES (?, ?, ?, ?, ?, 'old note', 10, 3, 9)`,
  );
  ins.run("in01", BOOK, 0, 0, "front:intro");
  ins.run("c1v1", BOOK, 1, 1, "1:1");
  ins.run("c2v1", BOOK, 2, 1, "2:1");
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, updated_by)
       VALUES ('q1v1', ?, 1, 1, '1:1', 'Q?', 'A.', 10, 3, 9)`,
    )
    .run(BOOK);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const req = (method, kind, id, body) =>
    app.request(
      `/api/rows/${kind}/${id}?book=${BOOK}`,
      {
        method,
        headers: { "if-match": "3", "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
      ctx,
    );
  const job = (pipelineType, start, end, state = "running") =>
    sqlite
      .prepare(
        `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state)
         VALUES (?, 9, ?, ?, ?, ?, 's', ?)`,
      )
      .run(`${pipelineType}-${start}-${state}`, pipelineType, BOOK, start, end, state);
  return { sqlite, env, req, job };
}

test("a running translate job on chapter 1 locks note edits on chapter 1 AND the book intro (chapter 0)", async () => {
  const { req, job } = fresh();
  job("translate", 1, 1);

  const c1 = await req("PATCH", "tn", "c1v1", { note: "human edit" });
  assert.equal(c1.status, 409, "chapter 1 note PATCH is refused");
  assert.equal((await c1.json()).error, "chapter_locked");

  const c0 = await req("PATCH", "tn", "in01", { note: "human edit" });
  assert.equal(c0.status, 409, "book intro note PATCH is refused");
  const body = await c0.json();
  assert.equal(body.error, "chapter_locked");
  assert.equal(body.pipelineType, "translate", "the 409 names the translate run so the client can explain it");

  const del = await req("DELETE", "tn", "in01");
  assert.equal(del.status, 409, "book intro note DELETE is refused too");

  const c2 = await req("PATCH", "tn", "c2v1", { note: "human edit" });
  assert.equal(c2.status, 200, "a chapter outside the run stays editable");
});

test("a non-translate job keeps today's carve-out: editing a note is allowed", async () => {
  const { req, job } = fresh();
  job("notes", 1, 1);

  const c1 = await req("PATCH", "tn", "c1v1", { note: "human edit" });
  assert.equal(c1.status, 200, "tn PATCH during a notes run still lands (editing keeps the note)");

  const c0 = await req("PATCH", "tn", "in01", { note: "human edit" });
  assert.equal(c0.status, 200, "a notes run does not cover the book intro");

  const tq = await req("PATCH", "tq", "q1v1", { question: "Q2?" });
  assert.equal(tq.status, 409, "control: tq still locks during any run");
});

test("activePipelineForChapter: chapter 0 is covered only by a translate job that starts at chapter 1", async () => {
  const a = fresh();
  a.job("translate", 1, 3);
  assert.equal((await activePipelineForChapter(a.env, BOOK, 0))?.pipelineType, "translate");
  assert.equal((await activePipelineForChapter(a.env, BOOK, 2))?.pipelineType, "translate");

  const b = fresh();
  b.job("translate", 2, 3);
  assert.equal(await activePipelineForChapter(b.env, BOOK, 0), null, "a job starting at chapter 2 does not cover the intro");

  const c = fresh();
  c.job("notes", 1, 1);
  assert.equal(await activePipelineForChapter(c.env, BOOK, 0), null, "a non-translate job does not cover the intro");

  const d = fresh();
  d.job("translate", 1, 1, "queued");
  assert.equal(await activePipelineForChapter(d.env, BOOK, 0), null, "a queued job locks nothing");
  assert.equal(await activePipelineForChapter(d.env, BOOK, 1), null, "a queued job locks nothing");

  const e = fresh();
  e.job("translate", 1, 1, "done");
  assert.equal(await activePipelineForChapter(e.env, BOOK, 0), null, "a finished job locks nothing");
});
