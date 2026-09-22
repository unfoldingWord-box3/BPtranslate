// Step 5 of docs/translate-internal-runner.md, wired end to end: the
// dispatchNext fork, the pollPipelineJob status source, and the pipelineImport
// byte source, driven through REAL SQLite with every migration applied.
//
// Why real SQLite rather than a fake-D1 SQL-text stub (which the sibling
// pipelineDispatchTimeout.test.mjs uses for its own, narrower claims): the
// claim here is that the internal runner reaches the SAME rows the proxy runner
// does — state, upstream_job_id, runner, current_skill, output_json, the staged
// pending_imports and the edit_log provenance stamp. A stub that answers
// whatever SQL it is handed would pass all of that vacuously.
//
// `fetch` is replaced with a counter that THROWS. Every internal-runner
// assertion below therefore doubles as a proof that nothing spoke to the Fly
// bot: had any branch fallen back to the proxy path, the test would fail rather
// than quietly pass against a network stub.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelineInternalRunner.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { SignJWT } from "jose";

import { dispatchNext, pollAllNonTerminal, pipelines } from "./pipelines.ts";
import { attachAuth } from "./auth.ts";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { outKey } from "./translate/storage.ts";
import { memoryBlobStore } from "./translate/fixtures.mjs";

const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const API_KEY = "sk-ant-api03-PLAINTEXT-MUST-NEVER-LEAVE-DISPATCH";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function freshSqlite() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  // ar-bsoj so classify() recognizes an "BSOJ/ar_tn" manifest entry as tn —
  // the realistic shape for a translate job, not the English-root default.
  sqlite.prepare(`INSERT INTO project_config (id, preset, overrides_json, updated_at) VALUES (1, 'ar-bsoj', NULL, 0)`).run();
  return sqlite;
}

// Unique per test: getProjectConfig memoizes by workspace slug with a TTL, so
// sharing one slug across tests in this process would leak config between them.
let slugSeq = 0;
function freshEnv(sqlite, extra = {}) {
  const WORKSPACE_SLUG = `ws-${++slugSeq}`;
  clearProjectConfigCache(WORKSPACE_SLUG);
  const created = [];
  const blobs = memoryBlobStore();
  const env = {
    DB: makeDb(sqlite),
    BLOBS: blobs,
    BT_API_TOKEN: "tok",
    AI_KEY_WRAPPING_KEY: WRAPPING_KEY,
    WORKSPACE_SLUG,
    created,
    blobs,
    // The post-apply "refresh your tab" hint is best-effort and swallows its
    // own errors; stubbed only to keep that noise out of the test output.
    CHAPTER_ROOM: {
      idFromName: () => "room",
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
    TRANSLATE_WORKFLOW: {
      async create(opts) {
        created.push(opts);
        return { id: opts.id };
      },
    },
    ...extra,
  };
  return env;
}

const realFetch = globalThis.fetch;
async function withNoFetch(fn) {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    throw new Error(`the internal runner must never call the bot (attempted ${String(url)})`);
  };
  try {
    return await fn(() => calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function withFetch(impl, fn) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl(url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const TRANSLATE_OPTIONS = {
  resourceType: "tn",
  targetLang: "ar",
  targetOrg: "BSOJ",
  sourceRef: "unfoldingWord/en_tn@master",
  literalRef: "BSOJ/ar_glt@master",
  simplifiedRef: "BSOJ/ar_gst@master",
  delivery: "editor",
  branchOnly: true,
  model: "opus",
  direction: "rtl",
};

function seedQueuedTranslateJob(sqlite, { jobId = "job-1", options = TRANSLATE_OPTIONS } = {}) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
          session_key, state, options_json, created_at, updated_at)
       VALUES (?, 1, 'translate', 'OBA', 1, 1, ?, 'queued', ?, 100, 100)`,
    )
    .run(jobId, `sess-${jobId}`, JSON.stringify(options));
}

async function seedByoKey(sqlite, { provider = "claude", model = "claude-opus-5" } = {}) {
  const { ciphertextB64, ivB64 } = await encryptApiKey(WRAPPING_KEY, API_KEY);
  sqlite
    .prepare(
      `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at)
       VALUES (1, ?, ?, ?, ?, 'ATED', 1, 0)`,
    )
    .run(provider, model, ciphertextB64, ivB64);
}

function jobRow(sqlite, jobId = "job-1") {
  return sqlite.prepare(`SELECT * FROM pipeline_jobs WHERE job_id = ?`).all(jobId)[0];
}

// ---------------------------------------------------------------------------
// dispatchNext
// ---------------------------------------------------------------------------

test("dispatchNext (internal): creates the Workflow instance and stamps the row, without touching the bot", async () => {
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite);
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });

  const fetchCount = await withNoFetch(async (count) => {
    await dispatchNext(env);
    return count();
  });

  assert.equal(fetchCount, 0, "no upstream POST was attempted");
  assert.equal(env.created.length, 1, "exactly one Workflow instance was created");

  const { id, params } = env.created[0];
  assert.equal(id, `translate-${env.WORKSPACE_SLUG}-job-1`, "instance id is workspace-scoped");
  assert.equal(params.workspace, env.WORKSPACE_SLUG, "params.workspace is set — the Workflow re-points its env from it");
  assert.equal(params.jobId, "job-1");
  assert.equal(params.provider, "claude");
  assert.equal(params.model, "claude-opus-5");

  const row = jobRow(sqlite);
  assert.equal(row.state, "running", "the same transition the proxy path makes on a successful dispatch");
  assert.equal(row.upstream_job_id, id, "the instance id takes upstream_job_id's place as 'the run executing this job'");
  assert.equal(row.runner, "internal", "the runner is pinned at dispatch, so a later PIPELINE_MODE flip can't strand the row");
  assert.equal(row.error_kind, null);
});

test("dispatchNext (internal): the decrypted key never reaches the persisted Workflow params", async () => {
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite);
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });

  await withNoFetch(async () => dispatchNext(env));

  // Cloudflare persists params for the instance's lifetime, so this is the
  // assertion that keeps a BYO key out of Cloudflare's own storage.
  const serialized = JSON.stringify(env.created[0]);
  assert.equal(serialized.includes(API_KEY), false, "the plaintext key is absent from everything passed to create()");
  assert.equal(/sk-ant/.test(serialized), false, "no credential-shaped substring reached create()");
  // Nor anywhere in D1: dispatch writes only state/upstream_job_id/runner.
  const dump = JSON.stringify(sqlite.prepare(`SELECT * FROM pipeline_jobs`).all());
  assert.equal(dump.includes(API_KEY), false, "the plaintext key is absent from the job row");
});

test("dispatchNext: every gate-off case still dispatches to the bot, byte-for-byte as before", async () => {
  // PIPELINE_MODE off.
  {
    const sqlite = freshSqlite();
    seedQueuedTranslateJob(sqlite);
    await seedByoKey(sqlite);
    const env = freshEnv(sqlite); // no PIPELINE_MODE
    await withFetch(
      async () => new Response(JSON.stringify({ jobId: "bot-1", provider: "claude" }), { status: 200 }),
      async (calls) => {
        await dispatchNext(env);
        assert.equal(calls.length, 1, "the upstream POST still happens");
        assert.match(calls[0].url, /\/api\/pipeline\/start$/);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.apiKey, API_KEY, "the proxy path still carries the key to the bot — unchanged");
      },
    );
    assert.equal(env.created.length, 0, "no Workflow instance");
    const row = jobRow(sqlite);
    assert.equal(row.state, "running");
    assert.equal(row.upstream_job_id, "bot-1", "the BOT's job id, as before");
    assert.equal(row.runner, null, "proxy rows are left unstamped (NULL reads as proxy)");
  }
  // Mode on, but no BYO key (the shared uW subscription).
  {
    const sqlite = freshSqlite();
    seedQueuedTranslateJob(sqlite);
    const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });
    await withFetch(
      async () => new Response(JSON.stringify({ jobId: "bot-2" }), { status: 200 }),
      async (calls) => {
        await dispatchNext(env);
        assert.equal(calls.length, 1, "a shared-subscription job stays on the bot");
      },
    );
    assert.equal(env.created.length, 0);
    assert.equal(jobRow(sqlite).runner, null);
  }
  // Mode on, BYO key, but a provider with no in-Worker adapter.
  {
    const sqlite = freshSqlite();
    seedQueuedTranslateJob(sqlite);
    await seedByoKey(sqlite, { provider: "openai", model: "gpt-5.5" });
    const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });
    await withFetch(
      async () => new Response(JSON.stringify({ jobId: "bot-3", provider: "openai" }), { status: 200 }),
      async (calls) => {
        await dispatchNext(env);
        assert.equal(calls.length, 1, "an un-ported provider stays on the bot");
      },
    );
    assert.equal(env.created.length, 0);
  }
});

test("dispatchNext: an article job stays on the bot even with the flag fully on, key intact", async () => {
  // The internal runner has TSV steps only (guardAndSourceStep throws
  // resource_not_supported_internal for an article job), while the bot
  // translates tw/ta today. Every gate but the family one is ON here, so this
  // proves the family gate alone is what keeps a working capability working.
  // DELETE THIS TEST WITH THE GATE in phase 2, when article steps land.
  for (const [resourceType, book, botJobId] of [["tw", "TW", "bot-tw"], ["ta", "TA", "bot-ta"]]) {
    const sqlite = freshSqlite();
    sqlite
      .prepare(
        `INSERT INTO pipeline_jobs
           (job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, state, options_json, created_at, updated_at)
         VALUES ('job-1', 1, 'translate', ?, 0, 0, 'sess-article', 'queued', ?, 100, 100)`,
      )
      .run(book, JSON.stringify({ ...TRANSLATE_OPTIONS, resourceType, articleId: "bible/kt/god" }));
    await seedByoKey(sqlite);
    const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });

    await withFetch(
      async () => new Response(JSON.stringify({ jobId: botJobId, provider: "claude" }), { status: 200 }),
      async (calls) => {
        await dispatchNext(env);
        assert.equal(calls.length, 1, `${resourceType} still POSTs to the bot`);
        const body = JSON.parse(calls[0].init.body);
        assert.equal(body.apiKey, API_KEY, `${resourceType}: the BYO key still reaches the bot, so the run is billed to the org`);
        assert.equal(body.provider, "claude");
      },
    );

    assert.equal(env.created.length, 0, `${resourceType}: no Workflow instance was created`);
    const row = jobRow(sqlite);
    assert.equal(row.state, "running");
    assert.equal(row.upstream_job_id, botJobId);
    assert.equal(row.runner, null, `${resourceType}: the row is left unstamped, i.e. proxy`);
  }
});

test("dispatchNext (internal): a create() failure fails the job and frees the slot", async () => {
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite);
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { PIPELINE_MODE: "internal" });
  env.TRANSLATE_WORKFLOW = {
    async create() {
      throw new Error("workflow create rejected");
    },
  };

  await withNoFetch(async () => dispatchNext(env));

  const row = jobRow(sqlite);
  assert.equal(row.state, "failed", "failed, not left holding the single dispatch slot");
  assert.equal(row.error_kind, "sdk_error", "the same error kind the proxy path uses for a rejected dispatch");
  assert.match(row.error_message, /translate_workflow_create_failed/);
  assert.equal(row.upstream_job_id, null, "no run id is recorded for a run that never started");
});

test("dispatchNext (internal, no BT_API_TOKEN): still creates the instance — the bot token is no longer a prerequisite (#467)", async () => {
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite);
  await seedByoKey(sqlite);
  // The whole point of the port: a deployment with a BYO key and
  // PIPELINE_MODE=internal but NO bot token must run internal jobs. Before #467
  // the BT_API_TOKEN gate at the top of dispatchNext returned before the fork.
  const env = freshEnv(sqlite, { PIPELINE_MODE: "internal", BT_API_TOKEN: undefined });

  const fetchCount = await withNoFetch(async (count) => {
    await dispatchNext(env);
    return count();
  });

  assert.equal(fetchCount, 0, "no upstream POST was attempted");
  assert.equal(env.created.length, 1, "the internal runner dispatched with no bot token present");
  const row = jobRow(sqlite);
  assert.equal(row.state, "running");
  assert.equal(row.runner, "internal");
  assert.equal(row.error_kind, null);
});

test("dispatchNext (proxy, no BT_API_TOKEN): fails the job cleanly instead of POSTing `Bearer undefined` (#467)", async () => {
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite);
  // No BYO key → this translate job routes to the Fly proxy. With no bot token
  // there is nothing to POST to, so it must fail closed rather than send a bogus
  // bearer. (Removing the top-of-function early return means the row now gets
  // claimed and then failed here, freeing the single slot.)
  const env = freshEnv(sqlite, { PIPELINE_MODE: "internal", BT_API_TOKEN: undefined });

  const fetchCount = await withNoFetch(async (count) => {
    await dispatchNext(env);
    return count();
  });

  assert.equal(fetchCount, 0, "no `Bearer undefined` request was ever sent upstream");
  assert.equal(env.created.length, 0, "no Workflow instance — this was a proxy job");
  const row = jobRow(sqlite);
  assert.equal(row.state, "failed", "the slot is freed, not held on a job that can never run");
  assert.equal(row.error_kind, "pipeline_api_disabled");
});

// ---------------------------------------------------------------------------
// pollPipelineJob (driven through pollAllNonTerminal, the cron's entry point)
// ---------------------------------------------------------------------------

function seedRunningInternalJob(sqlite, wfStatus, { jobId = "job-1" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
          state, upstream_job_id, runner, wf_status_json, created_at, updated_at)
       VALUES (?, 1, 'translate', 'OBA', 1, 1, ?, 'running', ?, 'internal', ?, unixepoch(), unixepoch())`,
    )
    .run(jobId, `sess-${jobId}`, `translate-ws-${jobId}`, wfStatus == null ? null : JSON.stringify(wfStatus));
}

function wf(state, current, output) {
  return {
    version: 1,
    runner: "internal",
    state,
    current: { chapter: 1, skill: "translate-tn", startedAt: "2026-09-15T11:00:00.000Z", ...current },
    updatedAt: "2026-09-15T11:30:00.000Z",
    ...(output ? { output } : {}),
  };
}

// A proxy job (runner NULL) that already reached 'running' on the Fly bot — the
// row #469 cares about: dispatched while BT_API_TOKEN was present, still in
// flight when the token is removed. attempt_count defaults to 0.
function seedRunningProxyJob(sqlite, { jobId = "proxy-1", upstreamId = "bot-1" } = {}) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
          state, upstream_job_id, runner, created_at, updated_at)
       VALUES (?, 1, 'translate', 'OBA', 1, 1, ?, 'running', ?, NULL, unixepoch(), unixepoch())`,
    )
    .run(jobId, `sess-${jobId}`, upstreamId);
}

// Route-level harness (mirrors viewerGuard.test.mjs) for GET /:jobId, whose 503
// capability gate #469's second fix moves behind the row's stamped runner.
const ROUTE_SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const ROUTE_ISSUER = "bible-editor";
function routeApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.route("/api/pipelines", pipelines);
  return app;
}
async function editorToken(sub = "1") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: "translator", role: "editor" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ROUTE_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(ROUTE_SIGNING));
}
function getReq(token) {
  return { method: "GET", headers: { cookie: `be_access=${token}` } };
}

test("pollPipelineJob (internal): a running status keeps the row running and refreshes the progress chip", async () => {
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, wf("running", { status: "batch 3/11" }));
  const env = freshEnv(sqlite);

  const calls = await withNoFetch(async (count) => {
    await pollAllNonTerminal(env);
    return count();
  });

  assert.equal(calls, 0, "the status came from wf_status_json, not from the bot");
  const row = jobRow(sqlite);
  assert.equal(row.state, "running");
  assert.equal(row.current_skill, "translate-tn");
  assert.equal(row.current_status, "batch 3/11");
  assert.equal(row.output_json, null, "output_json IS NULL is still the not-yet-imported flag");
  assert.ok(row.raw_status_json.includes("translate-tn"), "the synthesized status is stored where the bot's JSON would be");
});

test("pollPipelineJob (internal): an unwritten status column is read as running, never as failed", async () => {
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, null);
  const env = freshEnv(sqlite);
  await withNoFetch(async () => pollAllNonTerminal(env));
  const row = jobRow(sqlite);
  assert.equal(row.state, "running", "a just-created instance must not be mistaken for a dead one");
  assert.equal(row.error_kind, null);
});

test("pollPipelineJob (internal): a failed status drives the same terminal transition as an upstream failure", async () => {
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, wf("failed", { status: "failed", errorKind: "invalid_key", error: "provider rejected the key" }));
  const env = freshEnv(sqlite);

  await withNoFetch(async () => pollAllNonTerminal(env));

  const row = jobRow(sqlite);
  assert.equal(row.state, "failed");
  assert.equal(row.error_kind, "invalid_key", "errorKind rides through unchanged — the UI chip reads this");
  assert.equal(row.error_message, "provider rejected the key");
});

test("pollPipelineJob (internal): done with no output finalizes without an import", async () => {
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }));
  const env = freshEnv(sqlite);
  await withNoFetch(async () => pollAllNonTerminal(env));
  assert.equal(jobRow(sqlite).state, "done");
});

test("pollAllNonTerminal (no BT_API_TOKEN): still advances an internal job — the cron is not gated on the bot (#467)", async () => {
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, wf("failed", { status: "failed", errorKind: "invalid_key", error: "provider rejected the key" }));
  // Before #467 the token gate at the top of pollAllNonTerminal returned early,
  // so on a token-less internal deployment the 5-minute cron never advanced a
  // running internal job past 'running'.
  const env = freshEnv(sqlite, { BT_API_TOKEN: undefined });

  const calls = await withNoFetch(async (count) => {
    await pollAllNonTerminal(env);
    return count();
  });

  assert.equal(calls, 0, "the status came from wf_status_json, never the bot");
  const row = jobRow(sqlite);
  assert.equal(row.state, "failed", "the internal job reached its terminal state with no bot token present");
  assert.equal(row.error_kind, "invalid_key");
});

test("pollAllNonTerminal (no BT_API_TOKEN): a running proxy job is skipped — no `Bearer undefined`, no attempt_count burned (#469)", async () => {
  const sqlite = freshSqlite();
  // The token was present when this proxy job reached 'running', then removed
  // mid-run. The sweep must NOT fetch the bot with `Bearer undefined` (the
  // throwing fetch would surface it) and must NOT advance attempt_count toward
  // the poll cap — a token outage is recoverable, so the job is left untouched.
  seedRunningProxyJob(sqlite);
  const env = freshEnv(sqlite, { BT_API_TOKEN: undefined });

  const calls = await withNoFetch(async (count) => {
    await pollAllNonTerminal(env);
    return count();
  });

  assert.equal(calls, 0, "no `Bearer undefined` request was attempted against the bot");
  const row = jobRow(sqlite, "proxy-1");
  assert.equal(row.state, "running", "the proxy job is left recoverable, not marched toward auto-fail");
  assert.equal(row.attempt_count, 0, "a token-less sweep does not consume the proxy job's poll budget");
});

// ---------------------------------------------------------------------------
// GET /api/pipelines/:jobId capability gate (#469 fix 2)
// ---------------------------------------------------------------------------

test("GET /:jobId (internal): a running internal job still returns its status after config flips off — availability follows the stamped runner, not current config (#469)", async () => {
  const sqlite = freshSqlite();
  // Dispatched internally (runner='internal'); config later flipped so the
  // deployment is no longer AI-configured (no BT_API_TOKEN, PIPELINE_MODE off).
  // The status lives in D1, so the owning client must still poll it — a 503 from
  // the capability probe would strand a legitimately in-flight job.
  seedRunningInternalJob(sqlite, wf("running", { status: "batch 3/11" }));
  const env = freshEnv(sqlite, {
    BT_API_TOKEN: undefined,
    JWT_SIGNING_KEY: ROUTE_SIGNING,
    JWT_ISSUER: ROUTE_ISSUER,
  });
  const app = routeApp();
  const tok = await editorToken("1");

  const res = await withNoFetch(async () => app.request("/api/pipelines/job-1", getReq(tok), env));
  assert.equal(res.status, 200, "the internal job's status is served, not a 503 from the capability gate");
  const body = await res.json();
  assert.equal(body.state, "running", "the stored wf_status_json is returned as the job status");
});

test("GET /:jobId (proxy / bogus): the capability probe still 503s for non-internal rows under a token-less deployment (#467 unchanged)", async () => {
  const sqlite = freshSqlite();
  seedRunningProxyJob(sqlite);
  const env = freshEnv(sqlite, {
    BT_API_TOKEN: undefined,
    JWT_SIGNING_KEY: ROUTE_SIGNING,
    JWT_ISSUER: ROUTE_ISSUER,
  });
  const app = routeApp();
  const tok = await editorToken("1");

  await withNoFetch(async () => {
    // A proxy row is not stamped 'internal', so the gate still fires.
    const proxy = await app.request("/api/pipelines/proxy-1", getReq(tok), env);
    assert.equal(proxy.status, 503, "a running proxy job on a token-less deployment still hits the capability gate");
    // The AiScreen "is AI configured?" probe (a bogus id) still 503s too.
    const bogus = await app.request("/api/pipelines/does-not-exist", getReq(tok), env);
    assert.equal(bogus.status, 503, "the bogus-id probe still reports the deployment as unconfigured");
  });
});

// ---------------------------------------------------------------------------
// The import byte source
// ---------------------------------------------------------------------------

const TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tab12\t\t\tחֲז֖וֹן\t1\tرؤيا عوبديا",
].join("\n");

function seedTargetTnRow(sqlite) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note, version, updated_at)
       VALUES ('ab12', 'OBA', 1, 1, '1:1', NULL, NULL, 'חֲז֖וֹן', 1, 'The vision of Obadiah', 1, 100)`,
    )
    .run();
}

const MANIFEST = [
  { delivery: "editor", type: "tn", repo: "BSOJ/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
  { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
];

test("import (internal): output bytes come from R2 under the job's own prefix, with provenance unchanged", async () => {
  const sqlite = freshSqlite();
  seedTargetTnRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST));
  const env = freshEnv(sqlite);
  // Exactly where TranslateWorkflow's merge-report step puts it (design §C).
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), TN_TSV);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");

  const calls = await withNoFetch(async (count) => {
    await pollAllNonTerminal(env);
    return count();
  });
  assert.equal(calls, 0, "nothing was fetched from the bot's output endpoint");

  const row = jobRow(sqlite);
  assert.equal(row.state, "done");
  assert.ok(row.output_json, "output_json is written, marking the import complete");

  // The apply itself is untouched code — assert it actually ran on the R2 bytes.
  const tn = sqlite.prepare(`SELECT note, translation_state, version FROM tn_rows WHERE id = 'ab12'`).all()[0];
  assert.equal(tn.note, "رؤيا عوبديا", "the Arabic draft from R2 landed on the target row");
  assert.equal(tn.translation_state, "ai_draft");
  assert.equal(tn.version, 2);

  // Provenance (design §C: "Provenance untouched"). All three keys are the
  // EDITOR's job id — the internal runner has no separate upstream id at all.
  const staged = sqlite.prepare(`SELECT job_id, kind, accepted_at FROM pending_imports`).all();
  assert.equal(staged.length, 1, "the report sidecar is skipped, the tn file is staged");
  assert.equal(staged[0].job_id, "job-1");
  assert.equal(staged[0].kind, "tn");
  assert.ok(staged[0].accepted_at, "the proposal was accepted by the apply");

  const audit = sqlite.prepare(`SELECT source, row_key, action FROM edit_log WHERE kind = 'tn'`).all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].source, "ai_pipeline", "the row-level AI chip still keys on source='ai_pipeline'");
  assert.equal(audit[0].row_key, "ab12");
  assert.equal(audit[0].action, "update");
});

test("import (internal): a missing R2 object fails the import rather than silently importing nothing", async () => {
  const sqlite = freshSqlite();
  seedTargetTnRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST));
  const env = freshEnv(sqlite); // R2 deliberately empty

  const quiet = console.error;
  console.error = () => {};
  try {
    await withNoFetch(async () => pollAllNonTerminal(env));
  } finally {
    console.error = quiet;
  }

  const row = jobRow(sqlite);
  assert.equal(row.state, "running", "held at running for the one documented import retry");
  assert.equal(row.error_kind, "import_failed");
  assert.match(row.error_message, /not found/);
  assert.equal(row.output_json, null, "the job is NOT marked imported");
});

test("import (internal): a traversing manifest path is rejected before it addresses R2", async () => {
  const sqlite = freshSqlite();
  seedTargetTnRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, [
    { delivery: "editor", type: "tn", repo: "BSOJ/ar_tn", path: "tn_OBA.tsv", file: "../../other-org/job-9/out/tn_OBA.tsv" },
  ]));
  const env = freshEnv(sqlite);
  // Plant the bytes a traversal would reach, so a guard failure would be
  // visible as a successful (wrong-tenant) import rather than an empty read.
  env.blobs.map.set("pipeline-output/other-org/job-9/out/tn_OBA.tsv", TN_TSV);

  const quiet = console.error;
  console.error = () => {};
  try {
    await withNoFetch(async () => pollAllNonTerminal(env));
  } finally {
    console.error = quiet;
  }

  const row = jobRow(sqlite);
  assert.equal(row.error_kind, "import_failed");
  assert.match(row.error_message, /unsafe output file/);
  const tn = sqlite.prepare(`SELECT note FROM tn_rows WHERE id = 'ab12'`).all()[0];
  assert.equal(tn.note, "The vision of Obadiah", "no cross-prefix bytes were applied");
});
