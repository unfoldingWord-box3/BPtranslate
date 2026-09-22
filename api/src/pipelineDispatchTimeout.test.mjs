// Regression coverage for upstream issue #493: dispatchNext's upstream POST
// used to have no timeout at all, so a slow POST (cold start / slow proxy)
// could outlive STUCK_DISPATCH_THRESHOLD_SECONDS (120s) — the */5
// stale-dispatch sweep would fail the row and free the slot while the
// original POST was still in flight, and that same tick's dispatchNext
// safety net could then dispatch a SECOND job, double-occupying the
// single-slot bot.
//
// PROGRESSES upstream #493; DOES NOT FULLY CLOSE IT — see upstream #511.
// When dispatchNext's own DISPATCH_POST_TIMEOUT_MS fires, we cannot tell
// whether the upstream POST actually landed. Rather than free the slot
// immediately on that ambiguity (which would just relocate the
// double-dispatch race from "the sweep races a live POST" to "our own
// timeout races a POST that might still land"), the row is marked ambiguous
// (stays 'dispatching', still holds the slot) and only finally freed by a
// dedicated, longer-than-usual sweep in pollAllNonTerminal — see
// AMBIGUOUS_DISPATCH_GRACE_SECONDS's doc comment in pipelines.ts for the
// full reasoning and its documented limits.
//
// The first sections use a fake-D1/fetch-stub pattern: they prove the SQL
// text and bind wiring and which code path ran, not SQL semantics.
//
// The final section below is a real-SQLite integration test, deliberately —
// the NULL-safety bug it covers is exactly the class a fake-D1 SQL-text
// regex check cannot catch: a WHERE clause that reads as correct English but
// is semantically wrong under SQLite's three-valued NULL logic would still
// pass every guard-text-is-present assertion. Only a real SQLite engine can
// prove a NULL-safety fix is actually NULL-safe.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineDispatchTimeout.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dispatchNext, pollAllNonTerminal } from "./pipelines.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Fake D1 for dispatchNext, with bind-value capture on fail()'s and
// markDispatchAmbiguous's UPDATEs so these tests can assert error_kind/
// error_message and which one ran, not just that some query ran. The seeded
// job is pipeline_type 'notes', which skips this fork's generate stamp check
// and translate per-org AI provider block — the dispatch POST path under
// test is shared by all pipeline types.
function fakeDispatchEnv() {
  const env = {
    BT_API_TOKEN: "tok",
    queries: [],
    failCalls: [],
    ambiguousCalls: [],
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        if (/SELECT dcs_username FROM users/.test(sql)) {
          return { bind: () => ({ first: async () => ({ dcs_username: "translator" }) }) };
        }
        if (/SET state = 'dispatching', updated_at = unixepoch\(\)/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        }
        if (/SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,[\s\S]*session_key, options_json/.test(sql)) {
          const dispatchingJob = {
            job_id: "job-dispatch",
            user_id: 1,
            pipeline_type: "notes",
            book: "NUM",
            start_chapter: 27,
            end_chapter: 27,
            session_key: "sess-dispatch",
            options_json: null,
            source_generation: null,
            source_owner: null,
            source_repo: null,
            source_ref: null,
            source_stamps_json: null,
          };
          return { first: async () => dispatchingJob, bind: () => ({ first: async () => dispatchingJob }) };
        }
        // fail()'s UPDATE (api/src/pipelines.ts's `const fail = async (kind,
        // message) => ...`) — capture the bound (kind, message) so the
        // timeout-vs-network-error distinction is provable, not just trusted.
        if (/SET state = 'failed', error_kind = \?2, error_message = \?3/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.failCalls.push({ jobId: args[0], kind: args[1], message: args[2] });
                return { meta: { changes: 1 } };
              },
            }),
          };
        }
        // markDispatchAmbiguous's UPDATE — deliberately does NOT set `state`
        // (that's the whole point: the row stays 'dispatching', still
        // holding the slot). Distinguished from fail()'s UPDATE by the
        // absence of `state = 'failed'` in its SQL text.
        if (/SET error_kind = \?2, error_message = \?3, updated_at = unixepoch\(\)\s*\n\s*WHERE job_id = \?1 AND state = 'dispatching'/.test(sql)) {
          return {
            bind: (...args) => ({
              run: async () => {
                env.ambiguousCalls.push({ jobId: args[0], kind: args[1], message: args[2] });
                return { meta: { changes: 1 } };
              },
            }),
          };
        }
        // The promote-to-running UPDATE — succeeds so the happy path lands.
        if (/SET state = 'running', upstream_job_id = \?2/.test(sql)) {
          return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        }
        // Anything else — inert.
        return {
          all: async () => ({ results: [] }),
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
    },
  };
  return env;
}

const originalFetch = globalThis.fetch;
async function withFetch(impl, fn) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("\n[dispatchNext's upstream POST carries a timeout signal]");
await withFetch(
  async () => new Response(JSON.stringify({ jobId: "bot-job-1" }), { status: 200 }),
  async (calls) => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(calls.length === 1, "the upstream POST was issued");
    assert(
      calls[0]?.init?.signal instanceof AbortSignal,
      "the fetch init carries an AbortSignal — the #493 fix was not silently dropped",
    );
  },
);

console.log("\n[a timed-out dispatch POST is marked ambiguous, NOT failed immediately — the slot stays held]");
await withFetch(
  async () => {
    // What Node's fetch/undici actually throws when an AbortSignal.timeout()
    // signal fires mid-request.
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  },
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.failCalls.length === 0, "fail() was NOT called — state must stay 'dispatching', not jump to 'failed'");
    assert(env.ambiguousCalls.length === 1, "markDispatchAmbiguous's UPDATE ran exactly once");
    assert(env.ambiguousCalls[0]?.kind === "transient_outage", "ambiguous marker uses transient_outage as its kind");
    assert(
      env.ambiguousCalls[0]?.message === "upstream_dispatch_timeout",
      `ambiguous marker names the timeout (got ${JSON.stringify(env.ambiguousCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a timeout during the response BODY read (not just connect/headers) is caught the same way]");
await withFetch(
  async () => ({
    // fetch() itself resolves fine (headers arrived) — the AbortSignal fires
    // later, while streaming the body, which is exactly what dispatchNext's
    // `await upstream.text()` call exercises. This must be caught by its own
    // try/catch, not escape past it and reject dispatchNext uncaught.
    ok: true,
    status: 200,
    text: async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  }),
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env); // must not throw/reject
    assert(env.failCalls.length === 0, "fail() was NOT called for a body-read timeout either");
    assert(env.ambiguousCalls.length === 1, "markDispatchAmbiguous's UPDATE ran exactly once for a body-read timeout");
    assert(
      env.ambiguousCalls[0]?.message === "upstream_dispatch_timeout",
      `body-read timeout marker names the timeout (got ${JSON.stringify(env.ambiguousCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a NON-timeout failure reading the response body is ALSO ambiguous, not an immediate fail]");
await withFetch(
  async () => ({
    // fetch() resolved — headers arrived, which PROVES the request reached
    // the bot. A stream error here (connection reset, decode error — NOT a
    // TimeoutError) is just as ambiguous as a timeout would be: unlike a
    // pre-connection failure, there is no "definitely never reached
    // upstream" reading of an error that happens after we already have a
    // Response. Must route to markDispatchAmbiguous, not fail().
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("terminated: ECONNRESET");
    },
  }),
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.failCalls.length === 0, "fail() was NOT called for a non-timeout body-read failure");
    assert(
      env.ambiguousCalls.length === 1,
      "markDispatchAmbiguous's UPDATE ran exactly once for a non-timeout body-read failure — headers already arrived",
    );
  },
);

console.log("\n[a NON-OK status whose body also fails to read is NOT ambiguous — the status line already proves rejection]");
await withFetch(
  async () => ({
    // The bot's status line (already fully received, independent of the
    // body stream) says REJECTED — a definitive negative signal. The body
    // failing to read too must not override that with a ~300s ambiguous
    // hold: there is nothing to wait and see about.
    ok: false,
    status: 409,
    text: async () => {
      throw new Error("terminated: ECONNRESET");
    },
  }),
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.ambiguousCalls.length === 0, "a non-OK status is never held as ambiguous, even when its body is unreadable");
    assert(env.failCalls.length === 1, "fail() was called exactly once");
    assert(env.failCalls[0]?.kind === "sdk_error", `classified as sdk_error, not transient_outage (got ${env.failCalls[0]?.kind})`);
    assert(
      /409/.test(env.failCalls[0]?.message ?? ""),
      `failure message names the status code (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

console.log("\n[a pre-connection network failure (fetch() itself rejects, no Response at all) is NOT ambiguous — still fails the row immediately]");
await withFetch(
  async () => {
    throw new TypeError("fetch failed");
  },
  async () => {
    const env = fakeDispatchEnv();
    await dispatchNext(env);
    assert(env.ambiguousCalls.length === 0, "a genuine pre-connection failure is never marked ambiguous");
    assert(env.failCalls.length === 1, "fail() was called exactly once");
    assert(env.failCalls[0]?.kind === "transient_outage", "still classified as transient_outage");
    assert(
      env.failCalls[0]?.message === "upstream_unreachable",
      `non-timeout network errors keep the original message (got ${JSON.stringify(env.failCalls[0]?.message)})`,
    );
  },
);

// ─── The two backstop sweeps in pollAllNonTerminal ─────────────────────────
// Fake D1 covering the full pollAllNonTerminal call: its backstop sweeps, the
// poll-batch SELECT (no rows), and the safety-net dispatchNext call at the
// end (claim UPDATE reports 0 changes, so dispatchNext no-ops immediately —
// this section only cares about the sweeps, not dispatch behavior, which the
// tests above already cover).
function fakeSweepEnv() {
  const env = {
    BT_API_TOKEN: "tok",
    genericSweepBinds: null,
    ambiguousSweepBinds: null,
    DB: {
      prepare(sql) {
        if (/error_message = 'auto-failed: dispatch did not complete'/.test(sql)) {
          return {
            bind: (...args) => {
              env.genericSweepBinds = args;
              return { run: async () => ({ meta: { changes: 0 } }) };
            },
          };
        }
        if (/error_message = 'auto-failed: dispatch POST timed out and never confirmed landing upstream/.test(sql)) {
          return {
            bind: (...args) => {
              env.ambiguousSweepBinds = args;
              return { run: async () => ({ meta: { changes: 0 } }) };
            },
          };
        }
        return {
          all: async () => ({ results: [] }),
          bind: () => ({
            run: async () => ({ meta: { changes: 0 } }),
            first: async () => null,
            all: async () => ({ results: [] }),
          }),
        };
      },
      batch: async () => [],
    },
  };
  return env;
}

console.log("\n[pollAllNonTerminal: the generic stuck-dispatch sweep excludes ambiguous-marked rows]");
{
  const env = fakeSweepEnv();
  await pollAllNonTerminal(env);
  assert(env.genericSweepBinds !== null, "the generic STUCK_DISPATCH_THRESHOLD_SECONDS sweep ran");
  assert(env.genericSweepBinds?.[0] === 120, `generic sweep still uses the 120s threshold (got ${env.genericSweepBinds?.[0]})`);
  assert(
    env.genericSweepBinds?.[1] === "transient_outage" && env.genericSweepBinds?.[2] === "upstream_dispatch_timeout",
    "generic sweep's exclusion clause is bound to the same marker markDispatchAmbiguous stamps",
  );
}

console.log("\n[pollAllNonTerminal: the ambiguous-dispatch grace-period sweep runs with its own, longer threshold]");
{
  const env = fakeSweepEnv();
  await pollAllNonTerminal(env);
  assert(env.ambiguousSweepBinds !== null, "the ambiguous-dispatch grace-period sweep ran");
  assert(
    env.ambiguousSweepBinds?.[0] === 300,
    `ambiguous sweep's grace period is longer than the generic 120s threshold — one extra */5 cron cycle (got ${env.ambiguousSweepBinds?.[0]})`,
  );
  assert(
    env.ambiguousSweepBinds?.[1] === "transient_outage" && env.ambiguousSweepBinds?.[2] === "upstream_dispatch_timeout",
    "ambiguous sweep targets exactly the marker markDispatchAmbiguous stamps",
  );
}

// ─── Real-SQLite NULL-safety proof for the exclusion clause ────────────────
// The fake-D1 tests above prove the SQL TEXT and bind wiring; they cannot
// prove the WHERE clause is semantically correct under SQLite's
// three-valued NULL logic (a fake D1 stub that just regex-matches SQL text
// would pass even if `NOT (a = ?2 AND b = ?3)` silently excluded every
// NULL/NULL row — exactly the bug this section exists to catch). Real
// node:sqlite, every migration applied in order.
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
  // BT_API_TOKEN must be set — pollAllNonTerminal's early guard (`if
  // (!env.BT_API_TOKEN) return;`) would otherwise skip every sweep, silently
  // passing every assertion below for the wrong reason.
  return { sqlite, env: { DB: makeDb(sqlite), BT_API_TOKEN: "tok" } };
}

function seedDispatchingJob(sqlite, { jobId, updatedAt, errorKind = null, errorMessage = null }) {
  sqlite
    .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator') ON CONFLICT(id) DO NOTHING`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
          session_key, state, error_kind, error_message, updated_at)
       VALUES (?, 1, 'notes', 'NUM', 27, 27, 'sess', 'dispatching', ?, ?, ?)`,
    )
    .run(jobId, errorKind, errorMessage, updatedAt);
}

console.log("\n[NULL-safety: an ORDINARY dead dispatch (error_kind/message untouched — the column default) is still caught by the generic sweep]");
{
  const { sqlite, env } = freshEnv();
  // Died 200s ago — past STUCK_DISPATCH_THRESHOLD_SECONDS (120s), never
  // reached dispatchNext's own catch block, so error_kind/error_message are
  // genuinely NULL (the column default — see the 0008 migration), not
  // merely absent from an INSERT list. pollAllNonTerminal reads
  // `unixepoch()` for its own "now" — node:sqlite's unixepoch() reflects the
  // real wall clock, so seed relative to that.
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  seedDispatchingJob(sqlite, { jobId: "job-ordinary-dead", updatedAt: realNow - 200 });

  await pollAllNonTerminal(env);

  const row = sqlite.prepare("SELECT state, error_kind FROM pipeline_jobs WHERE job_id = ?").get("job-ordinary-dead");
  assert(
    row.state === "failed",
    `an ordinary NULL/NULL dead dispatch IS caught and failed by the generic sweep — the slot is not wedged forever (got state=${row.state})`,
  );
  assert(row.error_kind === "interrupted", `failed via the generic sweep's own error_kind, not the ambiguous marker (got ${row.error_kind})`);
}

console.log("\n[NULL-safety: an ambiguous-marked row is still excluded from the generic sweep and caught by its own grace-period sweep instead]");
{
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  // Marked ambiguous 200s ago: past the generic sweep's 120s threshold
  // (must NOT be caught there) but under the ambiguous sweep's own 300s
  // grace period (must NOT be caught yet either) — proves the two sweeps'
  // thresholds are genuinely independent, not just their marker filters.
  seedDispatchingJob(sqlite, {
    jobId: "job-ambiguous-recent",
    updatedAt: realNow - 200,
    errorKind: "transient_outage",
    errorMessage: "upstream_dispatch_timeout",
  });
  // Marked ambiguous 400s ago: past BOTH thresholds — must be caught by the
  // grace-period sweep now.
  seedDispatchingJob(sqlite, {
    jobId: "job-ambiguous-expired",
    updatedAt: realNow - 400,
    errorKind: "transient_outage",
    errorMessage: "upstream_dispatch_timeout",
  });

  await pollAllNonTerminal(env);

  const recent = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-ambiguous-recent");
  assert(
    recent.state === "dispatching",
    `an ambiguous row still within its 300s grace period stays 'dispatching' — the slot stays held (got ${recent.state})`,
  );

  const expired = sqlite.prepare("SELECT state, error_kind FROM pipeline_jobs WHERE job_id = ?").get("job-ambiguous-expired");
  assert(
    expired.state === "failed",
    `an ambiguous row past its 300s grace period IS finally failed, freeing the slot (got ${expired.state})`,
  );
  assert(
    expired.error_kind === "transient_outage",
    `the grace-period sweep's own failure is also transient_outage (got ${expired.error_kind})`,
  );
}

// ─── #456: terminate an orphaned translate Workflow instance on force-fail ──
// A Worker that died in dispatchNext's create()→'running' UPDATE window leaves
// a translate row 'dispatching' while its TranslateWorkflow instance keeps
// making paid calls. The stuck-dispatch sweep must terminate that instance,
// rebuilt from the deterministic translateInstanceId(workspace, jobId).
function seedStuckDispatch(sqlite, { jobId, pipelineType, updatedAt }) {
  sqlite
    .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator') ON CONFLICT(id) DO NOTHING`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, updated_at)
       VALUES (?, 1, ?, 'OBA', 1, 1, 'sess', 'dispatching', ?)`,
    )
    .run(jobId, pipelineType, updatedAt);
}

console.log("\n[#456: the stuck-dispatch sweep terminates the orphaned translate Workflow instance, and only translate jobs]");
{
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  // Both died 200s ago (past the 120s threshold), no ambiguous marker, runner
  // never stamped — exactly the create()→UPDATE crash window.
  seedStuckDispatch(sqlite, { jobId: "job-orphan-wf", pipelineType: "translate", updatedAt: realNow - 200 });
  seedStuckDispatch(sqlite, { jobId: "job-notes-dead", pipelineType: "notes", updatedAt: realNow - 200 });

  const terminated = [];
  env.WORKSPACE_SLUG = "bsoj";
  env.TRANSLATE_WORKFLOW = {
    async get(id) {
      return { id, terminate: async () => { terminated.push(id); } };
    },
    async create() {
      throw new Error("the sweep must never create an instance");
    },
  };

  await pollAllNonTerminal(env);

  const orphan = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-orphan-wf");
  assert(orphan.state === "failed", `the orphaned translate dispatch is still force-failed (got ${orphan.state})`);
  assert(
    terminated.length === 1 && terminated[0] === "translate-bsoj-job-orphan-wf",
    `its Workflow instance is terminated by deterministic id, and the non-translate dead dispatch is left alone (got ${JSON.stringify(terminated)})`,
  );
  const notes = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-notes-dead");
  assert(notes.state === "failed", `the non-translate dead dispatch is still failed too (got ${notes.state})`);
}

console.log("\n[#456: a translate job whose create() never landed force-fails without error (terminate throws → swallowed)]");
{
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  seedStuckDispatch(sqlite, { jobId: "job-no-instance", pipelineType: "translate", updatedAt: realNow - 200 });

  let terminateAttempts = 0;
  env.WORKSPACE_SLUG = "bsoj";
  env.TRANSLATE_WORKFLOW = {
    // get() throwing models "no such instance": create() never landed.
    async get() { terminateAttempts++; throw new Error("instance not found"); },
    async create() { throw new Error("the sweep must never create an instance"); },
  };

  let threw = false;
  try {
    await pollAllNonTerminal(env);
  } catch {
    threw = true;
  }
  assert(!threw, "pollAllNonTerminal does not throw when an instance cannot be found");
  assert(terminateAttempts === 1, `it still attempts the terminate for the translate job (got ${terminateAttempts})`);
  const row = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-no-instance");
  assert(row.state === "failed", `the row force-fails regardless of the terminate outcome (got ${row.state})`);
}

console.log("\n[#456: a dispatch rescued to 'running' between the capture SELECT and the force-fail UPDATE is NOT terminated]");
{
  // The capture SELECT and the force-fail UPDATE are two separate statements.
  // dispatchNext's own `state='running', runner='internal'` UPDATE carries no
  // `WHERE state='dispatching'` guard, so a still-live dispatch can land it in
  // between: the force-fail then no-ops and the instance is legitimately
  // running. Terminating on the SELECT's say-so would kill a live paid job and
  // leave a 'running' row holding the single global dispatch slot until the 48h
  // sweep. Modelled deterministically by flipping the row the instant before
  // the force-fail UPDATE executes.
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  seedStuckDispatch(sqlite, { jobId: "job-rescued", pipelineType: "translate", updatedAt: realNow - 200 });

  const inner = env.DB;
  env.DB = {
    prepare(sql) {
      const stmt = inner.prepare(sql);
      if (!/error_message = 'auto-failed: dispatch did not complete'/.test(sql)) return stmt;
      const wrap = (st) => ({
        ...st,
        bind: (...a) => wrap(st.bind(...a)),
        run() {
          sqlite
            .prepare("UPDATE pipeline_jobs SET state = 'running', runner = 'internal', updated_at = unixepoch() WHERE job_id = ?")
            .run("job-rescued");
          return st.run();
        },
      });
      return wrap(stmt);
    },
    batch: inner.batch.bind(inner),
  };

  const terminated = [];
  env.WORKSPACE_SLUG = "bsoj";
  env.TRANSLATE_WORKFLOW = {
    async get(id) {
      return { id, terminate: async () => { terminated.push(id); } };
    },
    async create() { throw new Error("the sweep must never create an instance"); },
  };

  await pollAllNonTerminal(env);

  const row = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-rescued");
  assert(row.state === "running", `the rescued job is left running, not force-failed (got ${row.state})`);
  assert(
    terminated.length === 0,
    `its live Workflow instance is NOT terminated (got ${JSON.stringify(terminated)})`,
  );
}

// ─── #456: the two OTHER force-fail paths (48h no-progress + poll-cap) ──────
// Once a translate job reaches 'running', the dispatch sweep above no longer
// covers it — but the 48h no-progress sweep and the MAX_POLL_ATTEMPTS backstop
// can still force-fail a runner='internal' row whose TranslateWorkflow instance
// is alive and still making paid model calls. #464 closed this leak only for
// the dispatch crash window; these two paths must terminate the instance too.
// A running/paused row DOES carry runner='internal' (unlike the crash window),
// so that is the precise capture signal.
function seedRunningJob(sqlite, { jobId, runner, updatedAt, attemptCount = 0, state = "running" }) {
  sqlite
    .prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator') ON CONFLICT(id) DO NOTHING`)
    .run();
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, runner, attempt_count, updated_at)
       VALUES (?, 1, 'translate', 'OBA', 1, 1, 'sess', ?, ?, ?, ?)`,
    )
    .run(jobId, state, runner, attemptCount, updatedAt);
}

console.log("\n[#456: the 48h no-progress and poll-cap sweeps terminate a live internal translate instance; a proxy job's is left alone]");
{
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  // Internal, running, no progress for well over 48h → caught by the 48h sweep.
  seedRunningJob(sqlite, { jobId: "job-48h", runner: "internal", updatedAt: realNow - 200000 });
  // Internal, running, FRESH updated_at but polled past the cap (MAX_POLL_ATTEMPTS
  // = 100) → caught by the independent poll-count backstop, not the time one.
  seedRunningJob(sqlite, { jobId: "job-pollcap", runner: "internal", updatedAt: realNow, attemptCount: 101 });
  // Proxy, running, no progress for over 48h → force-failed, but has no Workflow
  // instance, so it must not be captured/terminated (runner != 'internal').
  seedRunningJob(sqlite, { jobId: "job-proxy-48h", runner: "proxy", updatedAt: realNow - 200000 });
  // Internal, healthy (fresh updated_at, well under the cap) → neither sweep
  // touches it, so it is never terminated.
  seedRunningJob(sqlite, { jobId: "job-healthy", runner: "internal", updatedAt: realNow, attemptCount: 1 });

  const terminated = [];
  env.WORKSPACE_SLUG = "bsoj";
  env.TRANSLATE_WORKFLOW = {
    async get(id) {
      return { id, terminate: async () => { terminated.push(id); } };
    },
    async create() { throw new Error("the sweep must never create an instance"); },
  };

  await pollAllNonTerminal(env);

  const j48 = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-48h");
  const jcap = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-pollcap");
  const jproxy = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-proxy-48h");
  assert(j48.state === "failed", `the 48h-stuck internal job is force-failed (got ${j48.state})`);
  assert(jcap.state === "failed", `the poll-cap-exhausted internal job is force-failed (got ${jcap.state})`);
  assert(jproxy.state === "failed", `the 48h-stuck proxy job is force-failed too (got ${jproxy.state})`);
  const set = new Set(terminated);
  assert(
    set.has("translate-bsoj-job-48h") && set.has("translate-bsoj-job-pollcap"),
    `both force-failed internal instances are terminated by deterministic id (got ${JSON.stringify(terminated)})`,
  );
  assert(
    !set.has("translate-bsoj-job-proxy-48h") && !set.has("translate-bsoj-job-healthy"),
    `neither the proxy job (no instance) nor the still-healthy internal job is terminated (got ${JSON.stringify(terminated)})`,
  );
}

console.log("\n[#456: a running internal job rescued to 'done' between the capture and the force-fail UPDATE is NOT terminated]");
{
  // Same live-rescue race as the dispatch test, one step later in the job's
  // life: a poll can land the job terminal ('done') between the capture SELECT
  // and the 48h force-fail UPDATE. Re-reading state after the UPDATE must leave
  // the legitimately-finished job's instance alone. Modelled deterministically
  // by flipping the row to 'done' the instant before the 48h UPDATE runs.
  const { sqlite, env } = freshEnv();
  const realNow = sqlite.prepare("SELECT unixepoch() AS n").get().n;
  seedRunningJob(sqlite, { jobId: "job-running-rescued", runner: "internal", updatedAt: realNow - 200000 });

  const inner = env.DB;
  env.DB = {
    prepare(sql) {
      const stmt = inner.prepare(sql);
      if (!/error_message = 'auto-failed: no progress for 48h'/.test(sql)) return stmt;
      const wrap = (st) => ({
        ...st,
        bind: (...a) => wrap(st.bind(...a)),
        run() {
          sqlite
            .prepare("UPDATE pipeline_jobs SET state = 'done', updated_at = unixepoch() WHERE job_id = ?")
            .run("job-running-rescued");
          return st.run();
        },
      });
      return wrap(stmt);
    },
    batch: inner.batch.bind(inner),
  };

  const terminated = [];
  env.WORKSPACE_SLUG = "bsoj";
  env.TRANSLATE_WORKFLOW = {
    async get(id) {
      return { id, terminate: async () => { terminated.push(id); } };
    },
    async create() { throw new Error("the sweep must never create an instance"); },
  };

  await pollAllNonTerminal(env);

  const row = sqlite.prepare("SELECT state FROM pipeline_jobs WHERE job_id = ?").get("job-running-rescued");
  assert(row.state === "done", `the rescued running job is left 'done', not force-failed (got ${row.state})`);
  assert(
    terminated.length === 0,
    `its live Workflow instance is NOT terminated (got ${JSON.stringify(terminated)})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll pipelineDispatchTimeout assertions passed.");
