// Issue #945: a finished translate run's notes and questions are applied in
// batches, not one row at a time.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelineApplyBatched.test.mjs
//
// Before #945 applyJobOutput awaited a SELECT and then a three-statement
// batch for every note (two D1 round trips each, ~0.4 s per note on the live
// Worker), so LUK 18's 161 notes took over a minute with the chapter locked.
//
// These tests pin two things:
//   1. Parity. A run with a row in every outcome (drafted, touched, approved,
//      Not needed, English echo, no match, the book intro, a duplicate
//      proposal for one row) leaves exactly the rows, versions, edit_log
//      entries, accepted proposals, skip report and alerts the per-row code
//      left. The expected values below were captured from the per-row code
//      on main at 4979c359 before the change.
//   2. Round trips. The fake D1 counts every awaited call (first / all / run /
//      batch); a 161-note run must stay far below two per note.
//
// Same harness as pipelineApplySkipsTouched.test.mjs: the real migrations in
// node:sqlite behind a minimal D1 shim, with the job seeded already staged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { importJobOutput } from "./pipelineImport.ts";
import { clearSourceNotesCache } from "./sourceNotes.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// CAPTURE945=1 rewrites the fixtures from the code under test. It was run once,
// on the per-row code, to record the expected values.
function expectFixture(name, actual) {
  const file = join(FIXTURES, name);
  if (process.env.CAPTURE945 === "1") {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(file, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  assert.deepEqual(actual, JSON.parse(readFileSync(file, "utf8")));
}

function makeDb(sqlite, counter) {
  // D1 caps a statement at 100 bound parameters; node:sqlite does not.
  const check = (args) => {
    if (args.length > 100) throw new Error(`too many bound parameters (${args.length})`);
  };
  const exec = (sql, args) => {
    check(args);
    const r = sqlite.prepare(sql).run(...args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const rowsOf = (sql, args) => {
    check(args);
    return sqlite.prepare(sql).all(...args);
  };
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    exec: () => exec(sql, args),
    all() {
      counter.trips += 1;
      return { results: rowsOf(sql, args), success: true };
    },
    first() {
      counter.trips += 1;
      const r = rowsOf(sql, args);
      return r.length ? r[0] : null;
    },
    run() {
      counter.trips += 1;
      return exec(sql, args);
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      counter.trips += 1;
      counter.batches.push(stmts.length);
      if (stmts.length > 100) throw new Error(`batch of ${stmts.length} statements`);
      // Atomic, as D1's batch is.
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const BOOK = "ZEC";
const JOB = "job-945";
const SOURCE_REF = "unfoldingWord/en_tn@v99";

// The English source notes the job translated from (served by a stubbed
// fetch). e1's draft below is this text copied back.
const EN_TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:5\te1\t\t\tx\t1\tThe English note e1",
  "1:1\td1\t\t\tx\t1\tEnglish d1",
].join("\n");

function fresh({ draftCount = 3, tq = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  const now = Math.floor(Date.now() / 1000);
  const queuedAt = now - 100;
  // id, chapter, verse, state, trashed_at
  const tnSeed = [];
  for (let i = 1; i <= draftCount; i++) tnSeed.push([`d${i}`, 1, i, "ai_draft", null]);
  tnSeed.push(
    ["t1", 1, 2, "ai_draft", null], // touched after the enqueue
    ["a1", 1, 3, "validated", null], // approved before a whole-chapter run
    ["x1", 1, 4, "ai_draft", 500], // marked Not needed
    ["e1", 1, 5, null, null], // the draft is the English copied back
    ["in0", 0, 0, null, null], // the book intro, rides along with chapter 1
    ["c2", 2, 1, null, null], // outside the job's chapter range: no match
  );
  const insTn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, updated_at, translation_state, trashed_at)
     VALUES (?, ?, ?, ?, ?, ?, 10, 3, 9, 100, ?, ?)`,
  );
  for (const [id, ch, v, state, trashed] of tnSeed) insTn.run(id, BOOK, ch, v, `${ch}:${v}`, `old ${id}`, state, trashed);
  const insTq = sqlite.prepare(
    `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, updated_by, updated_at, translation_state)
     VALUES (?, ?, 1, ?, ?, ?, ?, 10, 3, 9, 100, ?)`,
  );
  const tqSeed = [];
  for (let i = 1; i <= draftCount; i++) tqSeed.push([`q${i}`, i, "ai_draft"]);
  tqSeed.push(["qt1", 2, "ai_draft"], ["qa1", 3, "validated"]);
  for (const [id, v, state] of tqSeed) insTq.run(id, BOOK, v, `1:${v}`, `old q ${id}`, `old r ${id}`, state);

  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, staged_at, options_json, edit_log_watermark)
       VALUES (?, 9, 'translate', ?, 1, 1, 's', 'running', ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM edit_log))`,
    )
    .run(JOB, BOOK, queuedAt, now, JSON.stringify({ sourceRef: SOURCE_REF }));
  // A person edits t1 / qt1 after the job was queued.
  const touch = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, created_at)
     VALUES (?, ?, ?, 9, 2, 3, 'update', ?)`,
  );
  touch.run(tq ? "tq" : "tn", tq ? "qt1" : "t1", BOOK, now - 10);

  const prop = sqlite.prepare(
    `INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  if (tq) {
    for (const [id, v] of tqSeed) {
      prop.run(JOB, "tq", BOOK, 1, v, JSON.stringify({ id, question: `AI q ${id}`, response: `AI r ${id}` }));
    }
    prop.run(JOB, "tq", BOOK, 1, 9, JSON.stringify({ id: "qzz", question: "AI q zz", response: "AI r zz" }));
    // A second proposal for q2 in the same job.
    prop.run(JOB, "tq", BOOK, 1, 2, JSON.stringify({ id: "q2", question: "AI q q2 again", response: "AI r q2 again" }));
  } else {
    for (const [id, ch, v] of tnSeed) {
      const note = id === "e1" ? "The English note e1" : `AI note ${id}`;
      prop.run(JOB, "tn", BOOK, ch, v, JSON.stringify({ id, note }));
    }
    prop.run(JOB, "tn", BOOK, 1, 9, JSON.stringify({ id: "zz99", note: "AI note zz99" })); // no such row
    prop.run(JOB, "tn", BOOK, 1, 9, JSON.stringify({ note: "AI note with no id" })); // no id at all
    // A second proposal for d2 in the same job: it must land on top of the
    // first, exactly as the per-row code did (version +2, two edit_log rows).
    prop.run(JOB, "tn", BOOK, 1, 2, JSON.stringify({ id: "d2", note: "AI note d2 again" }));
  }

  const counter = { trips: 0, batches: [] };
  const env = { DB: makeDb(sqlite, counter) };
  const apply = async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (/tn_ZEC\.tsv/.test(String(url))) return new Response(EN_TN_TSV, { status: 200 });
      throw new Error(`unexpected fetch ${String(url)}`);
    };
    clearSourceNotesCache();
    try {
      return await importJobOutput(
        env,
        {
          jobId: JOB,
          pipelineType: "translate",
          book: BOOK,
          startChapter: 1,
          endChapter: 1,
          cfg: { mode: "translation" },
        },
        [],
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  return { sqlite, env, counter, apply };
}

function snapshot(sqlite) {
  return {
    tn: sqlite.prepare(`SELECT id, note, version, translation_state, trashed_at, updated_by FROM tn_rows ORDER BY id`).all(),
    tq: sqlite
      .prepare(`SELECT id, question, response, version, translation_state, updated_by FROM tq_rows ORDER BY id`)
      .all(),
    editLog: sqlite
      .prepare(
        `SELECT kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source
           FROM edit_log WHERE source = 'ai_pipeline' ORDER BY row_key, new_version`,
      )
      .all(),
    pending: sqlite
      .prepare(
        `SELECT kind, payload_json, accepted_at IS NOT NULL AS accepted, accepted_by, rejected_at
           FROM pending_imports ORDER BY id`,
      )
      .all(),
    alerts: sqlite.prepare(`SELECT username, source, message, link_url FROM system_alerts ORDER BY id`).all(),
    skipped: JSON.parse(
      sqlite.prepare(`SELECT apply_skipped_json FROM pipeline_jobs WHERE job_id = ?`).get(JOB).apply_skipped_json ?? "null",
    ),
  };
}

const plain = (x) => JSON.parse(JSON.stringify(x));

test("#945 parity: a tn run with every outcome writes what the per-row apply wrote", async () => {
  const { sqlite, apply } = fresh();
  const result = await apply();
  const snap = plain(snapshot(sqlite));
  expectFixture("apply945-tn.json", plain({ result, snap }));
});

test("#945 parity: a tq run with every outcome writes what the per-row apply wrote", async () => {
  const { sqlite, apply } = fresh({ tq: true });
  const result = await apply();
  const snap = plain(snapshot(sqlite));
  expectFixture("apply945-tq.json", plain({ result, snap }));
});

test("#945: a retried apply writes nothing twice", async () => {
  const { sqlite, apply } = fresh();
  await apply();
  const first = plain(snapshot(sqlite));
  sqlite.prepare(`UPDATE pipeline_jobs SET import_claimed_at = NULL WHERE job_id = ?`).run(JOB);
  await apply();
  const second = plain(snapshot(sqlite));
  assert.deepEqual(second.tn, first.tn, "no row was bumped again");
  assert.deepEqual(second.editLog, first.editLog, "no edit_log row was added");
});

test("#945: an apply cut off between two write batches resumes on retry without writing anything twice", async () => {
  const clean = fresh({ draftCount: 40 });
  await clean.apply();
  const expected = plain(snapshot(clean.sqlite));

  const { sqlite, env, apply } = fresh({ draftCount: 40 });
  const realBatch = env.DB.batch;
  let writeBatches = 0;
  env.DB.batch = async (stmts) => {
    if (stmts.length >= 3 && /UPDATE tn_rows/.test(stmts[0].sql ?? "") && ++writeBatches === 2) {
      throw new Error("Worker cut off mid-apply");
    }
    return realBatch(stmts);
  };
  await assert.rejects(apply(), /cut off/);
  const partial = sqlite.prepare(`SELECT COUNT(*) AS n FROM tn_rows WHERE version = 4`).get().n;
  assert.ok(partial > 0 && partial < 40, `the first batch landed and the rest did not (${partial} drafted)`);
  env.DB.batch = realBatch;
  await apply();
  const after = plain(snapshot(sqlite));
  assert.deepEqual(after.tn, expected.tn, "every row ends where a clean run left it");
  assert.deepEqual(after.editLog, expected.editLog, "one edit_log row per write, none doubled");
  assert.deepEqual(
    after.pending.map((p) => p.accepted),
    expected.pending.map((p) => p.accepted),
    "the same proposals are accepted",
  );
});

test("#945 round trips: a 161-note run takes far fewer than two D1 calls per note", async () => {
  const { sqlite, counter, apply } = fresh({ draftCount: 161 });
  await apply();
  const drafted = sqlite.prepare(`SELECT COUNT(*) AS n FROM tn_rows WHERE note LIKE 'AI note d%'`).get().n;
  assert.equal(drafted, 161, "every note was drafted");
  console.log(`#945 round trips for a 161-note apply: ${counter.trips} (batches: ${counter.batches.join(",")})`);
  assert.ok(counter.trips < 40, `expected under 40 D1 round trips, got ${counter.trips}`);
});

test("#945: a person's edit landing between the read and the batch keeps their work; the rest of the batch applies", async () => {
  const { sqlite, env, apply } = fresh();
  const realBatch = env.DB.batch;
  let raced = false;
  env.DB.batch = async (stmts) => {
    if (!raced && stmts.length > 3) {
      raced = true;
      // A translator's save of d3 lands after the apply read it.
      sqlite.prepare(`UPDATE tn_rows SET note = 'human d3', version = version + 1 WHERE id = 'd3'`).run();
    }
    return realBatch(stmts);
  };
  const result = await apply();
  assert.ok(raced, "the race was injected");
  const row = (id) => plain(sqlite.prepare(`SELECT note, version FROM tn_rows WHERE id = ?`).get(id));
  assert.deepEqual(row("d3"), { note: "human d3", version: 4 }, "the human edit is kept");
  assert.deepEqual(row("d1"), { note: "AI note d1", version: 4 }, "a row in the same batch still applied");
  const log = sqlite.prepare(`SELECT COUNT(*) AS n FROM edit_log WHERE row_key = 'd3' AND source = 'ai_pipeline'`).get();
  assert.equal(log.n, 0, "no edit_log row for the write that lost");
  const pending = sqlite
    .prepare(`SELECT accepted_at FROM pending_imports WHERE json_extract(payload_json, '$.id') = 'd3'`)
    .get();
  assert.equal(pending.accepted_at, null, "its proposal stays unresolved");
  assert.equal(result.applied.tnHintExpanded, 4, "d1, d2 (twice) and in0 drafted; d3 lost");
});
