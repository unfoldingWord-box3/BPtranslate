// #944: the poll cap (MAX_POLL_ATTEMPTS) counts polls WITHOUT PROGRESS, not
// every poll. Before this, every */5 cron tick bumped attempt_count for each
// running and paused job and nothing reset it, so any run still going (or
// paused waiting on a usage limit) was force-failed after 100 ticks ≈ 8h20m.
//
// Real node:sqlite with every migration applied, driven through real
// pollAllNonTerminal ticks (no seeded counters), so the reset and the cap are
// exercised the way the cron exercises them.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelinePollProgress.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pollAllNonTerminal } from "./pipelines.ts";
import { runningStatus, writeWfStatus } from "./translate/status.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
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

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const terminated = [];
  const env = {
    DB: makeDb(sqlite),
    BT_API_TOKEN: "tok",
    WORKSPACE_SLUG: "bsoj",
    TRANSLATE_WORKFLOW: {
      async get(id) {
        return { id, terminate: async () => { terminated.push(id); } };
      },
      async create() { throw new Error("the sweep must never create an instance"); },
    },
  };
  sqlite
    .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator') ON CONFLICT(id) DO NOTHING`)
    .run();
  return { sqlite, env, terminated };
}

function seedJob(sqlite, { jobId, runner, state = "running", updatedAt }) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
          state, runner, upstream_job_id, attempt_count, updated_at)
       VALUES (?, 1, 'translate', 'OBA', 1, 1, 'sess', ?, ?, ?, 0, ?)`,
    )
    .run(jobId, state, runner, `up-${jobId}`, updatedAt);
}

// The internal runner's status channel, through the REAL single writer
// (translate/status.ts), which also sets current_skill, current_status and
// updated_at on the row in the same UPDATE. A test helper that wrote only
// wf_status_json hid the first version of this fix never resetting for
// internal jobs (review of #944).
async function writeStatus(env, jobId, status) {
  const scope = { chapter: 1, skill: "translate", startedAt: "2026-11-19T00:00:00.000Z" };
  assert.ok(await writeWfStatus(env.DB, jobId, runningStatus(scope, status)));
}

const row = (sqlite, jobId) =>
  sqlite.prepare("SELECT state, error_message, attempt_count, updated_at FROM pipeline_jobs WHERE job_id = ?").get(jobId);
const now = (sqlite) => sqlite.prepare("SELECT unixepoch() AS n").get().n;

test("an internal running job that reports progress on every tick survives well past 100 ticks (#944)", async () => {
  const { sqlite, env, terminated } = freshEnv();
  seedJob(sqlite, { jobId: "job-progress", runner: "internal", updatedAt: now(sqlite) });
  for (let tick = 1; tick <= 110; tick++) {
    await writeStatus(env, "job-progress", `batch ${tick}/200 done`);
    await pollAllNonTerminal(env);
    const r = row(sqlite, "job-progress");
    assert.equal(r.state, "running", `still running at tick ${tick} (${r.error_message})`);
  }
  assert.ok(row(sqlite, "job-progress").attempt_count <= 1, "each progressing poll resets the no-progress count");
  assert.deepEqual(terminated, []);
});

test("an internal running job with no progress is still force-failed at the cap and its Workflow terminated (#944)", async () => {
  const { sqlite, env, terminated } = freshEnv();
  seedJob(sqlite, { jobId: "job-frozen", runner: "internal", updatedAt: now(sqlite) });
  await writeStatus(env, "job-frozen", "batch 3/200 done");
  let failedAt = null;
  for (let tick = 1; tick <= 110 && failedAt === null; tick++) {
    await pollAllNonTerminal(env);
    if (row(sqlite, "job-frozen").state === "failed") failedAt = tick;
  }
  // Tick 1 records the first status (a change from nothing), which resets the
  // count; ticks 2-102 are 101 polls without progress, and the sweep at the
  // start of tick 103 fails a row whose count is > 100. (On main, with no
  // reset, it failed at tick 102.)
  assert.equal(failedAt, 103, `force-failed on the tick after 101 polls without progress (got ${failedAt})`);
  assert.equal(row(sqlite, "job-frozen").error_message, "auto-failed: poll attempts exhausted");
  assert.deepEqual(terminated, ["translate-bsoj-job-frozen"]);
});

test("an internal running job with no status written yet is not kept alive by the synthesized clock (#944)", async () => {
  // With wf_status_json NULL, readInternalStatus fills updatedAt from the
  // clock, so it differs on every poll; that must not count as progress.
  const { sqlite, env, terminated } = freshEnv();
  seedJob(sqlite, { jobId: "job-nostatus", runner: "internal", updatedAt: now(sqlite) });
  let failedAt = null;
  for (let tick = 1; tick <= 110 && failedAt === null; tick++) {
    await pollAllNonTerminal(env);
    if (row(sqlite, "job-nostatus").state === "failed") failedAt = tick;
  }
  assert.equal(failedAt, 103, `force-failed after 101 polls without progress (got ${failedAt})`);
  assert.deepEqual(terminated, ["translate-bsoj-job-nostatus"]);
});

test("a proxy running job whose bot status advances every tick survives well past 100 ticks (#944)", async (t) => {
  const { sqlite, env } = freshEnv();
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let tickNo = 0;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        jobId: "up-job-bot",
        pipelineType: "translate",
        scope: { book: "OBA", startChapter: 1, endChapter: 1 },
        state: "running",
        current: { chapter: 1, skill: "translate", status: `batch ${tickNo}/200 done`, startedAt: "2026-11-19T00:00:00.000Z" },
        updatedAt: new Date().toISOString(),
        createdAt: "2026-11-19T00:00:00.000Z",
        interrupted: false,
      }),
      { status: 200 },
    );
  seedJob(sqlite, { jobId: "job-bot", runner: "proxy", updatedAt: now(sqlite) });
  for (tickNo = 1; tickNo <= 110; tickNo++) {
    await pollAllNonTerminal(env);
    const r = row(sqlite, "job-bot");
    assert.equal(r.state, "running", `still running at tick ${tickNo} (${r.error_message})`);
  }
});

test("a paused_for_usage_limit job survives past 100 ticks, keeps its updated_at, and the 48h sweep still fails it (#944)", async (t) => {
  const { sqlite, env, terminated } = freshEnv();
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const paused = {
    jobId: "up-job-paused",
    pipelineType: "translate",
    scope: { book: "OBA", startChapter: 1, endChapter: 1 },
    state: "paused_for_usage_limit",
    current: { chapter: 1, skill: "translate", status: "waiting for usage limit", startedAt: "2026-11-19T00:00:00.000Z" },
    updatedAt: "2026-11-19T00:00:00.000Z",
    createdAt: "2026-11-19T00:00:00.000Z",
    interrupted: false,
  };
  let tickNo = 0;
  // The status line changes on some ticks (a countdown, a retry counter): that
  // must not refresh updated_at while the job stays paused.
  globalThis.fetch = async () => {
    const status = tickNo % 3 === 0 ? `waiting for usage limit (${tickNo})` : paused.current.status;
    return new Response(JSON.stringify({ ...paused, current: { ...paused.current, status } }), { status: 200 });
  };

  seedJob(sqlite, { jobId: "job-paused", runner: "proxy", state: "paused_for_usage_limit", updatedAt: now(sqlite) });
  await pollAllNonTerminal(env);
  // Backdate so a refresh would be visible (unixepoch() has 1s resolution and
  // these ticks run in milliseconds).
  const pausedSince = now(sqlite) - 3600;
  sqlite.prepare("UPDATE pipeline_jobs SET updated_at = ? WHERE job_id = ?").run(pausedSince, "job-paused");
  for (tickNo = 2; tickNo <= 110; tickNo++) {
    await pollAllNonTerminal(env);
    const r = row(sqlite, "job-paused");
    assert.equal(r.state, "paused_for_usage_limit", `still paused at tick ${tickNo} (${r.error_message})`);
  }
  assert.equal(
    row(sqlite, "job-paused").updated_at,
    pausedSince,
    "a poll that sees the job still paused leaves updated_at alone, so the 48h clock can bind",
  );

  // 48h later with still no change: the no-progress sweep frees the slot.
  sqlite.prepare("UPDATE pipeline_jobs SET updated_at = ? WHERE job_id = ?").run(now(sqlite) - 86400 * 2 - 60, "job-paused");
  await pollAllNonTerminal(env);
  const r = row(sqlite, "job-paused");
  assert.equal(r.state, "failed");
  assert.equal(r.error_message, "auto-failed: no progress for 48h");
  assert.deepEqual(terminated, [], "a proxy job has no Workflow instance to terminate");
});
