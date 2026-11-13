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

import { dispatchNext, enqueueFollowUp, enqueueFollowUpFromChain, pollAllNonTerminal, pipelines } from "./pipelines.ts";
import { attachAuth } from "./auth.ts";
import { tnQuick } from "./tnQuick.ts";
import { templates } from "./templates.ts";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";
import { clearSourceNotesCache } from "./sourceNotes.ts";
import { isEnglishEcho } from "./pipelineImport.ts";
import { outKey } from "./translate/storage.ts";
import { memoryBlobStore } from "./translate/fixtures.mjs";

const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const API_KEY = "sk-ant-api03-PLAINTEXT-MUST-NEVER-LEAVE-DISPATCH";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
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
    // The apply's English-echo check (#794) reads the English notes from
    // Door43. That is not the bot, so it is not counted; it still fails, and
    // the check fails open.
    if (String(url).startsWith("https://git.door43.org/")) throw new Error(`Door43 is offline in this test`);
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
  // (Mode on but no org key used to ride the shared uW subscription on the bot.
  // It now fails at dispatch instead: see the #551 tests below.)
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
  // An org key for a provider with no in-Worker adapter → this translate job
  // routes to the Fly proxy. With no bot token there is nothing to POST to, so
  // it must fail closed rather than send a bogus bearer. (Removing the
  // top-of-function early return means the row now gets claimed and then failed
  // here, freeing the single slot.)
  await seedByoKey(sqlite, { provider: "openai", model: "gpt-5.5" });
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
// #551 part A: translate jobs run on the org's own key or not at all. There is
// no shared unfoldingWord account to fall back to.
// ---------------------------------------------------------------------------

function seedDefaultProviderRow(sqlite) {
  // What DELETE /api/ai-provider leaves behind: provider='default', no key.
  sqlite
    .prepare(
      `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at)
       VALUES (1, 'default', NULL, NULL, NULL, NULL, 2, 0)`,
    )
    .run();
}

test("dispatchNext (#551): a queued translate job whose org has no key fails, and nothing is posted to the bot", async () => {
  for (const [label, seed] of [
    ["no ai_provider_config row", () => {}],
    ["provider='default' (key cleared)", seedDefaultProviderRow],
  ]) {
    for (const mode of [undefined, "internal"]) {
      const sqlite = freshSqlite();
      seedQueuedTranslateJob(sqlite);
      seed(sqlite);
      const env = freshEnv(sqlite, mode ? { PIPELINE_MODE: mode } : {});

      const fetchCount = await withNoFetch(async (count) => {
        await dispatchNext(env);
        return count();
      });

      const tag = `${label}, PIPELINE_MODE=${mode ?? "unset"}`;
      assert.equal(fetchCount, 0, `${tag}: no upstream POST on the shared account`);
      assert.equal(env.created.length, 0, `${tag}: no Workflow instance`);
      const row = jobRow(sqlite);
      assert.equal(row.state, "failed", `${tag}: the job fails loudly instead of waiting forever`);
      // #575: the real reason, so the UI says "an admin should check the AI
      // settings" instead of "retrying usually fixes this".
      assert.equal(row.error_kind, "ai_provider_unavailable", tag);
      assert.equal(row.error_message, "ai_provider_not_configured", tag);
    }
  }
});

test("dispatchNext (#575): a queued translate job whose stored key can't be decrypted fails as ai_provider_key_decrypt_failed, and nothing is posted", async () => {
  for (const mode of [undefined, "internal"]) {
    const sqlite = freshSqlite();
    seedQueuedTranslateJob(sqlite);
    await seedByoKey(sqlite);
    // The key was wrapped with WRAPPING_KEY; dispatch now holds a different
    // (valid-length) wrapping key, as after a rotation.
    const rotated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const env = freshEnv(sqlite, { ...(mode ? { PIPELINE_MODE: mode } : {}), AI_KEY_WRAPPING_KEY: rotated });

    const fetchCount = await withNoFetch(async (count) => {
      await dispatchNext(env);
      return count();
    });

    const tag = `PIPELINE_MODE=${mode ?? "unset"}`;
    assert.equal(fetchCount, 0, `${tag}: no upstream POST`);
    assert.equal(env.created.length, 0, `${tag}: no Workflow instance`);
    const row = jobRow(sqlite);
    assert.equal(row.state, "failed", tag);
    assert.equal(row.error_kind, "ai_provider_key_decrypt_failed", tag);
    assert.equal(row.error_message, "stored provider key could not be decrypted (wrapping key rotated?)", tag);
  }
});

test("dispatchNext (#551 switch-off): a queued legacy generate/notes/tqs job fails as ai_needs_org_key, even with an org key, and nothing is posted", async () => {
  for (const type of ["generate", "notes", "tqs"]) {
    for (const withKey of [false, true]) {
      const sqlite = freshSqlite();
      sqlite
        .prepare(
          `INSERT INTO pipeline_jobs
             (job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
              session_key, state, options_json, created_at, updated_at)
           VALUES ('job-legacy', 1, ?, 'OBA', 1, 1, 'sess-legacy', 'queued', NULL, 100, 100)`,
        )
        .run(type);
      if (withKey) await seedByoKey(sqlite);
      const env = freshEnv(sqlite);

      const fetchCount = await withNoFetch(async (count) => {
        await dispatchNext(env);
        return count();
      });

      const tag = `${type}, org key ${withKey ? "set" : "unset"}`;
      assert.equal(fetchCount, 0, `${tag}: nothing reaches the bot on the shared account`);
      assert.equal(env.created.length, 0, `${tag}: no Workflow instance`);
      const row = jobRow(sqlite, "job-legacy");
      assert.equal(row.state, "failed", tag);
      assert.equal(row.error_kind, "ai_needs_org_key", tag);
    }
  }
});

test("dispatchNext (#551 switch-off): legacy jobs queued ahead of a translate job are failed and the translate job dispatches in the same call", async () => {
  const sqlite = freshSqlite();
  for (const [jobId, type, created] of [["legacy-a", "notes", 10], ["legacy-b", "generate", 20]]) {
    sqlite
      .prepare(
        `INSERT INTO pipeline_jobs
           (job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, state, options_json, created_at, updated_at)
         VALUES (?, 1, ?, 'OBA', 1, 1, ?, 'queued', NULL, ?, ?)`,
      )
      .run(jobId, type, `sess-${jobId}`, created, created);
  }
  seedQueuedTranslateJob(sqlite); // created_at 100: behind both legacy jobs
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite);
  await withFetch(
    async () => new Response(JSON.stringify({ jobId: "bot-1", provider: "claude" }), { status: 200 }),
    async (calls) => {
      await dispatchNext(env);
      assert.equal(calls.length, 1, "exactly one POST: the translate job");
      assert.equal(JSON.parse(calls[0].init.body).pipelineType, "translate");
    },
  );
  for (const id of ["legacy-a", "legacy-b"]) {
    const row = jobRow(sqlite, id);
    assert.equal(row.state, "failed", id);
    assert.equal(row.error_kind, "ai_needs_org_key", id);
  }
  assert.equal(jobRow(sqlite).state, "running", "the translate job was not left waiting for the next cron tick");
});

// A translate job with an org key still dispatches with that key: covered by
// "dispatchNext: every gate-off case still dispatches to the bot" above and
// "POST /start (#551): translate with an org key gets past the key check" below.

function postReq(token, body) {
  return {
    method: "POST",
    headers: { cookie: `be_access=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const START_TRANSLATE = {
  pipelineType: "translate",
  book: "OBA",
  startChapter: 1,
  endChapter: 1,
  sessionKey: "sess-start-551",
};

test("POST /start (#551): translate with no org key is refused with 409 ai_provider_not_configured; nothing is enqueued", async () => {
  for (const [label, seed] of [
    ["no ai_provider_config row", () => {}],
    ["provider='default' (key cleared)", seedDefaultProviderRow],
  ]) {
    // With and without the bot token: "add a key" is the more actionable error,
    // so it must win over pipeline_api_disabled.
    for (const token of ["tok", undefined]) {
      const sqlite = freshSqlite();
      seed(sqlite);
      const env = freshEnv(sqlite, {
        BT_API_TOKEN: token,
        JWT_SIGNING_KEY: ROUTE_SIGNING,
        JWT_ISSUER: ROUTE_ISSUER,
      });
      const app = routeApp();
      const tok = await editorToken("1", env.WORKSPACE_SLUG);
      const tag = `${label}, BT_API_TOKEN=${token ? "set" : "unset"}`;

      const { res, fetchCount } = await withNoFetch(async (count) => {
        const res = await app.request("/api/pipelines/start", postReq(tok, START_TRANSLATE), env);
        return { res, fetchCount: count() };
      });

      assert.equal(res.status, 409, tag);
      assert.deepEqual(await res.json(), { error: "ai_provider_not_configured" }, tag);
      assert.equal(fetchCount, 0, `${tag}: no fetch`);
      assert.equal(env.created.length, 0, `${tag}: no Workflow instance`);
      const jobs = sqlite.prepare(`SELECT COUNT(*) AS n FROM pipeline_jobs`).all()[0].n;
      assert.equal(jobs, 0, `${tag}: no pipeline_jobs row was enqueued`);
    }
  }
});

test("POST /start (#551): a keyless org with a same-scope translate job already queued gets the key error, not already_running", async () => {
  // A job queued before the deploy is doomed (dispatchNext fails it). Dedup
  // must not answer already_running/conflict pointing at it; the key error wins.
  const sqlite = freshSqlite();
  seedQueuedTranslateJob(sqlite, { jobId: "pre-deploy" });
  sqlite.prepare(`UPDATE pipeline_jobs SET book = 'OBA', start_chapter = 1, end_chapter = 1 WHERE job_id = 'pre-deploy'`).run();
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const app = routeApp();
  const tok = await editorToken("1", env.WORKSPACE_SLUG);

  const { res, fetchCount } = await withNoFetch(async (count) => {
    const res = await app.request("/api/pipelines/start", postReq(tok, START_TRANSLATE), env);
    return { res, fetchCount: count() };
  });

  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "ai_provider_not_configured" });
  assert.equal(fetchCount, 0);
  const jobs = sqlite.prepare(`SELECT job_id, state FROM pipeline_jobs`).all();
  assert.deepEqual(jobs.map((j) => j.job_id), ["pre-deploy"], "nothing new was enqueued");
});

test("POST /start (#551): translate with an org key gets past the key check and carries the key to the bot", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite, { provider: "openai", model: "gpt-5.5" });
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const app = routeApp();
  const tok = await editorToken("1", env.WORKSPACE_SLUG);

  await withFetch(
    async () => new Response(JSON.stringify({ jobId: "bot-start", provider: "openai" }), { status: 200 }),
    async (calls) => {
      const res = await app.request("/api/pipelines/start", postReq(tok, START_TRANSLATE), env);
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal((await res.json()).status, "running");
      assert.equal(calls.length, 1, "dispatched to the bot");
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.provider, "openai");
      assert.equal(body.model, "gpt-5.5");
      assert.equal(body.apiKey, API_KEY, "the org's own key is what the bot runs on");
    },
  );
});

test("POST /start (#551 switch-off): generate/notes/tqs are refused with 409 ai_needs_org_key, even with an org key; nothing is enqueued", async () => {
  for (const pipelineType of ["generate", "notes", "tqs"]) {
    for (const withKey of [false, true]) {
      const sqlite = freshSqlite();
      if (withKey) await seedByoKey(sqlite);
      const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
      const app = routeApp();
      const tok = await editorToken("1", env.WORKSPACE_SLUG);
      const tag = `${pipelineType}, org key ${withKey ? "set" : "unset"}`;

      const { res, fetchCount } = await withNoFetch(async (count) => {
        const res = await app.request(
          "/api/pipelines/start",
          postReq(tok, { pipelineType, book: "OBA", startChapter: 1, endChapter: 1, sessionKey: `sess-${pipelineType}` }),
          env,
        );
        return { res, fetchCount: count() };
      });

      assert.equal(res.status, 409, tag);
      assert.deepEqual(await res.json(), { error: "ai_needs_org_key" }, tag);
      assert.equal(fetchCount, 0, `${tag}: no fetch`);
      const jobs = sqlite.prepare(`SELECT COUNT(*) AS n FROM pipeline_jobs`).all()[0].n;
      assert.equal(jobs, 0, `${tag}: no pipeline_jobs row was enqueued`);
    }
  }
});

test("POST /start (#551 switch-off): a translate job whose followUpChain holds a legacy step is refused; nothing is enqueued", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const tok = await editorToken("1", env.WORKSPACE_SLUG);
  const { res, fetchCount } = await withNoFetch(async (count) => {
    const res = await routeApp().request(
      "/api/pipelines/start",
      postReq(tok, { ...START_TRANSLATE, followUpChain: [{ pipelineType: "notes" }] }),
      env,
    );
    return { res, fetchCount: count() };
  });
  assert.equal(res.status, 409, await res.clone().text());
  assert.deepEqual(await res.json(), { error: "ai_needs_org_key" });
  assert.equal(fetchCount, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM pipeline_jobs`).all()[0].n, 0);
});

function sideRouteApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.route("/api/tn-quick", tnQuick);
  app.route("/api/templates", templates);
  return app;
}

test("POST /api/tn-quick (#551 switch-off): refused with 409 ai_needs_org_key, even with an org key and the bot token; nothing is posted", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const tok = await editorToken("1", env.WORKSPACE_SLUG);
  const { res, fetchCount } = await withNoFetch(async (count) => {
    const res = await sideRouteApp().request("/api/tn-quick", postReq(tok, { book: "OBA" }), env);
    return { res, fetchCount: count() };
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "ai_needs_org_key" });
  assert.equal(fetchCount, 0);
});

test("POST /api/templates/unit/draft (#551 switch-off): refused with 409 ai_needs_org_key, even with an org key and the bot token; nothing is posted", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite);
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const tok = await editorToken("1", env.WORKSPACE_SLUG);
  const req = postReq(tok, {});
  req.headers["If-Match"] = "1";
  const { res, fetchCount } = await withNoFetch(async (count) => {
    const res = await sideRouteApp().request("/api/templates/unit/draft?id=t-1", req, env);
    return { res, fetchCount: count() };
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "ai_needs_org_key" });
  assert.equal(fetchCount, 0);
});

// ---------------------------------------------------------------------------
// pollPipelineJob (driven through pollAllNonTerminal, the cron's entry point)
// ---------------------------------------------------------------------------

function seedRunningInternalJob(sqlite, wfStatus, { jobId = "job-1", startChapter = 1, endChapter = 1, options = null } = {}) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs
         (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key,
          state, upstream_job_id, runner, wf_status_json, options_json, created_at, updated_at)
       VALUES (?, 1, 'translate', 'OBA', ?, ?, ?, 'running', ?, 'internal', ?, ?, unixepoch(), unixepoch())`,
    )
    .run(jobId, startChapter, endChapter, `sess-${jobId}`, `translate-ws-${jobId}`, wfStatus == null ? null : JSON.stringify(wfStatus), options == null ? null : JSON.stringify(options));
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
async function editorToken(sub = "1", ws) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username: "translator", role: "editor", ws })
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

// #496: the skipped proxy job above still holds the single dispatch slot, so
// the queue is wedged until the token returns or the 48h sweep frees it. The
// sweep must say so in the Worker log: one line per tick (not one per job),
// naming the jobs, and silent when nothing was skipped.
async function captureSkipWarnings(fn) {
  const realWarn = console.warn;
  const lines = [];
  console.warn = (...args) => {
    const line = args.map(String).join(" ");
    if (line.includes("BT_API_TOKEN unset")) lines.push(line);
    else realWarn(...args);
  };
  try {
    await fn();
  } finally {
    console.warn = realWarn;
  }
  return lines;
}

test("pollAllNonTerminal (no BT_API_TOKEN): skipped proxy jobs are logged once per tick, naming them (#496)", async () => {
  const sqlite = freshSqlite();
  seedRunningProxyJob(sqlite, { jobId: "proxy-1", upstreamId: "bot-1" });
  seedRunningProxyJob(sqlite, { jobId: "proxy-2", upstreamId: "bot-2" });
  seedRunningInternalJob(sqlite, wf("running", { status: "batch 1/2" }), { jobId: "internal-1" });
  const env = freshEnv(sqlite, { BT_API_TOKEN: undefined });

  const lines = await captureSkipWarnings(async () => {
    await withNoFetch(async () => pollAllNonTerminal(env));
    await withNoFetch(async () => pollAllNonTerminal(env));
  });

  assert.equal(lines.length, 2, `one line per tick, not one per skipped job: ${JSON.stringify(lines)}`);
  for (const line of lines) {
    assert.match(line, /skipped 2 /, "the line counts the skipped proxy jobs");
    assert.ok(line.includes(`workspace=${env.WORKSPACE_SLUG}`), "the line names the workspace whose queue is wedged");
    assert.ok(line.includes("proxy-1") && line.includes("proxy-2"), "the line names the jobs holding the slot");
    assert.ok(!line.includes("internal-1"), "internal jobs are polled, not skipped, so they are not listed");
  }
  assert.equal(jobRow(sqlite, "proxy-1").state, "running", "logging does not change what the sweep does to the job");
  assert.equal(jobRow(sqlite, "proxy-1").attempt_count, 0);
});

test("pollAllNonTerminal: no skip line when nothing was skipped (#496)", async () => {
  // Token-less deployment with only internal jobs: nothing is skipped.
  const sqlite = freshSqlite();
  seedRunningInternalJob(sqlite, wf("running", { status: "batch 1/2" }));
  const env = freshEnv(sqlite, { BT_API_TOKEN: undefined });
  const lines = await captureSkipWarnings(() => withNoFetch(async () => pollAllNonTerminal(env)));
  assert.deepEqual(lines, []);

  // Token present: the proxy job is polled against the bot, not skipped.
  const sqlite2 = freshSqlite();
  seedRunningProxyJob(sqlite2);
  const env2 = freshEnv(sqlite2);
  let botCalls = 0;
  const lines2 = await captureSkipWarnings(() =>
    withFetch(
      async () => {
        botCalls++;
        return new Response(JSON.stringify({ state: "running" }), { status: 200 });
      },
      async () => pollAllNonTerminal(env2),
    ),
  );
  assert.ok(botCalls > 0, "with a token the proxy job is polled");
  assert.deepEqual(lines2, []);
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
  const tok = await editorToken("1", env.WORKSPACE_SLUG);

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
  const tok = await editorToken("1", env.WORKSPACE_SLUG);

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

// The book introduction is the tN row 'front:intro', stored as chapter 0. The
// translate run already selects it for a job that starts at chapter 1
// (sliceChapterRows), but staging and apply both scoped rows to
// [start_chapter, end_chapter], so the paid-for translation of it was dropped.
const INTRO_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "front:intro\tfr01\t\t\t\t\tمقدمة سفر عوبديا",
].join("\n");

function seedBookIntroRow(sqlite) {
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, updated_at)
       VALUES ('fr01', 'OBA', 0, 0, 'front:intro', 'Introduction to Obadiah', 1, 100)`,
    )
    .run();
}

test("import (internal): a job starting at chapter 1 lands the translated book introduction (front:intro, chapter 0)", async () => {
  const sqlite = freshSqlite();
  seedBookIntroRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST));
  const env = freshEnv(sqlite);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), INTRO_TSV);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");

  await withNoFetch(async () => pollAllNonTerminal(env));

  const row = sqlite.prepare(`SELECT note, translation_state, version FROM tn_rows WHERE id = 'fr01'`).all()[0];
  assert.equal(row.note, "مقدمة سفر عوبديا", "the translated intro landed on its chapter-0 row");
  assert.equal(row.translation_state, "ai_draft");
  assert.equal(row.version, 2);
});

test("import (internal): a row-scoped chapter 1 job leaves the book introduction alone unless it named it", async () => {
  // The output is the whole target book, so the intro row in it is the DCS copy.
  for (const [rowIds, lands] of [[["ab12"], false], [["fr01"], true]]) {
    const sqlite = freshSqlite();
    seedBookIntroRow(sqlite);
    seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST), { options: { rowIds } });
    const env = freshEnv(sqlite);
    env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), INTRO_TSV);
    env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");

    await withNoFetch(async () => pollAllNonTerminal(env));

    const row = sqlite.prepare(`SELECT note, version FROM tn_rows WHERE id = 'fr01'`).all()[0];
    assert.equal(row.version, lands ? 2 : 1, `rowIds ${JSON.stringify(rowIds)}: intro ${lands ? "lands" : "untouched"}`);
    assert.equal(row.note === "مقدمة سفر عوبديا", lands);
  }
});

test("import (internal): options_json that is the literal null does not throw and counts as whole-range", async () => {
  const sqlite = freshSqlite();
  seedBookIntroRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST));
  sqlite.prepare(`UPDATE pipeline_jobs SET options_json = 'null' WHERE job_id = 'job-1'`).run();
  const env = freshEnv(sqlite);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), INTRO_TSV);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");

  await withNoFetch(async () => pollAllNonTerminal(env));

  const row = sqlite.prepare(`SELECT version FROM tn_rows WHERE id = 'fr01'`).all()[0];
  assert.equal(row.version, 2, "the intro landed; the null options did not break the import");
});

test("import (internal): a job that does not start at chapter 1 leaves the book introduction alone", async () => {
  const sqlite = freshSqlite();
  seedBookIntroRow(sqlite);
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST), { startChapter: 2, endChapter: 2 });
  const env = freshEnv(sqlite);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), INTRO_TSV);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");

  await withNoFetch(async () => pollAllNonTerminal(env));

  const row = sqlite.prepare(`SELECT note, translation_state, version FROM tn_rows WHERE id = 'fr01'`).all()[0];
  assert.equal(row.note, "Introduction to Obadiah", "chapter 0 is outside a chapter 2-only job");
  assert.equal(row.version, 1);
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

// ---------------------------------------------------------------------------
// Row- and verse-scoped translate jobs (#559)
// ---------------------------------------------------------------------------
//
// The output file is the WHOLE target book: the rows the job translated plus
// every other row as it sits on DCS. A single-note "rerun AI" on LUK 7
// (rowIds ["xgg9"]) applied all 174 rows of the chapter, replacing 173 Arabic
// notes (170 validated) with the English source text. Only the rows the job
// selected may land; the rest of the file is the DCS copy, which can be older
// than D1.

// Row cd34 is the one the job does NOT select. Its D1 copy is newer than the
// DCS copy in the file (validated Arabic in D1, English in the file).
const SCOPE_TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tab12\t\t\tחֲז֖וֹן\t1\tرؤيا عوبديا",
  "1:2\tcd34\t\t\tקָטֹ֛ן\t1\tThe English source note",
].join("\n");

function seedScopeTnRows(sqlite) {
  seedTargetTnRow(sqlite);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, quote, occurrence, note, translation_state, version, updated_at)
       VALUES ('cd34', 'OBA', 1, 2, '1:2', 'קָטֹ֛ן', 1, 'ملاحظة عربية معتمدة', 'validated', 7, 100)`,
    )
    .run();
}

const SCOPE_TQ_TSV = [
  "Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse",
  "1:1\tqa12\t\t\t\tسؤال مترجم\tجواب مترجم",
  "1:2\tqb34\t\t\t\tThe English question\tThe English response",
].join("\n");

function seedScopeTqRows(sqlite) {
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, translation_state, version, updated_at)
       VALUES ('qa12', 'OBA', 1, 1, '1:1', 'Old question', 'Old response', NULL, 1, 100),
              ('qb34', 'OBA', 1, 2, '1:2', 'سؤال عربي معتمد', 'جواب عربي معتمد', 'validated', 4, 100)`,
    )
    .run();
}

const TQ_MANIFEST = [{ delivery: "editor", type: "tq", repo: "BSOJ/ar_tq", path: "tq_OBA.tsv", file: "tq_OBA.tsv" }];

async function runScopedImport(sqlite, { manifest, file, bytes, options, fetchImpl }) {
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, manifest), { options });
  const env = freshEnv(sqlite);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", file), bytes);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");
  if (fetchImpl) await withFetch(fetchImpl, async () => pollAllNonTerminal(env));
  else await withNoFetch(async () => pollAllNonTerminal(env));
  assert.equal(jobRow(sqlite).state, "done", "the import completed");
}

function tnRow(sqlite, id) {
  return { ...sqlite.prepare(`SELECT note, translation_state, version FROM tn_rows WHERE id = ?`).all(id)[0] };
}
function tqRow(sqlite, id) {
  return { ...sqlite.prepare(`SELECT question, response, translation_state, version FROM tq_rows WHERE id = ?`).all(id)[0] };
}

test("import (internal, #559): a rowIds tn job updates only the named row; a newer D1 row it did not name is untouched", async () => {
  const sqlite = freshSqlite();
  seedScopeTnRows(sqlite);
  await runScopedImport(sqlite, { manifest: MANIFEST, file: "tn_OBA.tsv", bytes: SCOPE_TN_TSV, options: { rowIds: ["ab12"] } });

  const a = tnRow(sqlite, "ab12");
  assert.equal(a.note, "رؤيا عوبديا", "the named row got its translation");
  assert.equal(a.translation_state, "ai_draft");
  assert.equal(a.version, 2);

  assert.deepEqual(
    tnRow(sqlite, "cd34"),
    { note: "ملاحظة عربية معتمدة", translation_state: "validated", version: 7 },
    "the row the job did not name keeps its D1 note, state and version",
  );
  const audit = sqlite.prepare(`SELECT row_key FROM edit_log WHERE kind = 'tn'`).all().map((r) => r.row_key);
  assert.deepEqual(audit, ["ab12"], "only the named row was written");
});

test("import (internal, #559): a rowIds tq job updates only the named row", async () => {
  const sqlite = freshSqlite();
  seedScopeTqRows(sqlite);
  await runScopedImport(sqlite, { manifest: TQ_MANIFEST, file: "tq_OBA.tsv", bytes: SCOPE_TQ_TSV, options: { rowIds: ["qa12"] } });

  const a = tqRow(sqlite, "qa12");
  assert.equal(a.question, "سؤال مترجم", "the named question got its translation");
  assert.equal(a.translation_state, "ai_draft");
  assert.equal(a.version, 2);

  assert.deepEqual(
    tqRow(sqlite, "qb34"),
    { question: "سؤال عربي معتمد", response: "جواب عربي معتمد", translation_state: "validated", version: 4 },
    "the question the job did not name keeps its D1 text, state and version",
  );
});

test("import (internal, #559): a verse-range tn job leaves rows outside the range untouched", async () => {
  const sqlite = freshSqlite();
  seedScopeTnRows(sqlite);
  // Select verse 1 only; cd34 (1:2) is outside it.
  await runScopedImport(sqlite, { manifest: MANIFEST, file: "tn_OBA.tsv", bytes: SCOPE_TN_TSV, options: { verseStart: 1, verseEnd: 1 } });

  assert.equal(tnRow(sqlite, "ab12").version, 2, "the in-range row was drafted");
  assert.deepEqual(
    tnRow(sqlite, "cd34"),
    { note: "ملاحظة عربية معتمدة", translation_state: "validated", version: 7 },
    "the out-of-range row keeps its D1 note, state and version",
  );
});

test("import (internal, #559): a verse-range tq job leaves rows outside the range untouched", async () => {
  const sqlite = freshSqlite();
  seedScopeTqRows(sqlite);
  // verseStart alone: the end defaults to the start, as in selectRows.
  await runScopedImport(sqlite, { manifest: TQ_MANIFEST, file: "tq_OBA.tsv", bytes: SCOPE_TQ_TSV, options: { verseStart: 2 } });

  assert.equal(tqRow(sqlite, "qb34").version, 5, "the in-range question was drafted");
  assert.deepEqual(
    tqRow(sqlite, "qa12"),
    { question: "Old question", response: "Old response", translation_state: null, version: 1 },
    "the out-of-range question is untouched",
  );
});

// ---------------------------------------------------------------------------
// Whole-chapter runs keep approved rows; English echoes are not applied (#794)
// ---------------------------------------------------------------------------
//
// Option B (decided 2026-11-12): a whole-chapter AI run (no rowIds, no verse
// range) skips approved notes and questions and lists them as kept. A narrowed
// run (one-note redo, verse range) still redrafts them. A note draft that is
// word-for-word the English source note is not applied, and the run reports it.

test("import (internal, #794): a whole-chapter tn job keeps an approved note as it is and reports it as kept", async () => {
  const sqlite = freshSqlite();
  seedScopeTnRows(sqlite);
  await runScopedImport(sqlite, { manifest: MANIFEST, file: "tn_OBA.tsv", bytes: SCOPE_TN_TSV, options: null });

  assert.equal(tnRow(sqlite, "ab12").version, 2, "the unapproved row is drafted");
  assert.equal(tnRow(sqlite, "ab12").translation_state, "ai_draft");
  assert.deepEqual(
    tnRow(sqlite, "cd34"),
    { note: "ملاحظة عربية معتمدة", translation_state: "validated", version: 7 },
    "the approved row keeps its note, state and version",
  );
  const report = JSON.parse(jobRow(sqlite).apply_skipped_json);
  assert.equal(report.tnApproved, 1);
  assert.deepEqual(report.tnApprovedIds, ["cd34"]);
  assert.equal(report.tnTouched, undefined, "kept-because-approved is not mixed into the changed-by-people keys");
  // Door43 is unreachable here (withNoFetch), so the English check fails open
  // and says so.
  assert.match(report.tnEnglishCheckNotRun, /Could not read the English notes/);
  const alerts = sqlite
    .prepare(`SELECT message, link_url FROM system_alerts WHERE source = 'translate_tn_kept_approved:job-1'`)
    .all();
  assert.equal(alerts.length, 1, "the starter gets a kept-because-approved alert");
  assert.match(alerts[0].message, /OBA 1:2/);
  assert.equal(alerts[0].link_url, "#/OBA/1");
});

test("import (internal, #794): a whole-chapter tq job keeps an approved question as it is and reports it as kept", async () => {
  const sqlite = freshSqlite();
  seedScopeTqRows(sqlite);
  await runScopedImport(sqlite, { manifest: TQ_MANIFEST, file: "tq_OBA.tsv", bytes: SCOPE_TQ_TSV, options: { resourceType: "tq" } });

  assert.equal(tqRow(sqlite, "qa12").version, 2, "the unapproved question is drafted");
  assert.deepEqual(
    tqRow(sqlite, "qb34"),
    { question: "سؤال عربي معتمد", response: "جواب عربي معتمد", translation_state: "validated", version: 4 },
    "the approved question keeps its text, state and version",
  );
  const report = JSON.parse(jobRow(sqlite).apply_skipped_json);
  assert.equal(report.tqApproved, 1);
  assert.deepEqual(report.tqApprovedIds, ["qb34"]);
  assert.equal(report.tnEnglishCheckNotRun, undefined, "the English check is for notes only");
  const alerts = sqlite.prepare(`SELECT message FROM system_alerts WHERE source = 'translate_tq_kept_approved:job-1'`).all();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /OBA 1:2/);
});

// cd34's proposal here is Arabic, so the redraft below is a real translation.
const REDO_TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tab12\t\t\tחֲז֖וֹן\t1\tرؤيا عوبديا",
  "1:2\tcd34\t\t\tקָטֹ֛ן\t1\tمسودة عربية جديدة",
].join("\n");

for (const [label, options] of [
  ["a one-note redo (rowIds)", { resourceType: "tn", rowIds: ["cd34"] }],
  ["a verse-range job", { resourceType: "tn", verseStart: 2, verseEnd: 2 }],
]) {
  test(`import (internal, #794): ${label} still redrafts an approved note`, async () => {
    const sqlite = freshSqlite();
    seedScopeTnRows(sqlite);
    await runScopedImport(sqlite, { manifest: MANIFEST, file: "tn_OBA.tsv", bytes: REDO_TN_TSV, options });
    assert.deepEqual(tnRow(sqlite, "cd34"), { note: "مسودة عربية جديدة", translation_state: "ai_draft", version: 8 });
    const report = JSON.parse(jobRow(sqlite).apply_skipped_json ?? "{}");
    assert.equal(report.tnApproved, undefined, "nothing was kept for being approved");
  });
}

// The English source notes on Door43, as readBookSourceNotes fetches them.
// ab12's English has straight quotes and a double space; the AI "draft" below
// is the same text, which staging curls and collapses, so the compare must
// normalize the English the same way to catch it. cd34's English is links
// only, so a draft identical to it is a legitimate translation and is applied.
const EN_TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  '1:1\tab12\t\t\tחֲז֖וֹן\t1\tThe "vision"  of Obadiah',
  "1:2\tcd34\t\t\tקָטֹ֛ן\t1\t[[rc://*/ta/man/translate/figs-metaphor]]",
].join("\n");
const ECHO_TN_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  '1:1\tab12\t\t\tחֲז֖וֹן\t1\tThe "vision" of Obadiah ',
  "1:2\tcd34\t\t\tקָטֹ֛ן\t1\t[[rc://*/ta/man/translate/figs-metaphor]]",
].join("\n");

function seedEchoTnRows(sqlite) {
  seedTargetTnRow(sqlite);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, quote, occurrence, note, translation_state, version, updated_at)
       VALUES ('cd34', 'OBA', 1, 2, '1:2', 'קָטֹ֛ן', 1, 'مسودة قديمة', 'ai_draft', 3, 100)`,
    )
    .run();
}

// Serves the English tN from "Door43"; any other URL (the bot) throws.
function door43Fetch(tsv) {
  return async (url) => {
    if (/\/raw\/branch\/master\/tn_OBA\.tsv$/.test(String(url))) return new Response(tsv, { status: 200 });
    throw new Error(`unexpected fetch ${String(url)}`);
  };
}

test("import (internal, #794): a note draft that is the English source note is not applied and is reported", async () => {
  const sqlite = freshSqlite();
  seedEchoTnRows(sqlite);
  clearSourceNotesCache();
  await runScopedImport(sqlite, {
    manifest: MANIFEST,
    file: "tn_OBA.tsv",
    bytes: ECHO_TN_TSV,
    options: { resourceType: "tn" },
    fetchImpl: door43Fetch(EN_TN_TSV),
  });

  assert.deepEqual(
    tnRow(sqlite, "ab12"),
    { note: "The vision of Obadiah", translation_state: null, version: 1 },
    "the English echo did not land",
  );
  assert.deepEqual(
    tnRow(sqlite, "cd34"),
    { note: "[[rc://*/ta/man/translate/figs-metaphor]]", translation_state: "ai_draft", version: 4 },
    "a links-only note identical to the English is applied",
  );
  const report = JSON.parse(jobRow(sqlite).apply_skipped_json);
  assert.equal(report.tnSameAsEnglish, 1);
  assert.deepEqual(report.tnSameAsEnglishIds, ["ab12"]);
  assert.equal(report.tnEnglishCheckNotRun, undefined, "the English was read, so the check ran");
  const alerts = sqlite.prepare(`SELECT message FROM system_alerts WHERE source = 'translate_tn_same_as_english:job-1'`).all();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /OBA 1:1/);
  const pending = sqlite.prepare(`SELECT accepted_at FROM pending_imports WHERE payload_json LIKE '%"ab12"%'`).all();
  assert.equal(pending[0].accepted_at, null, "the echoed proposal is left unresolved");
});

test("isEnglishEcho (#794): the compare rules", () => {
  // Staging curls quotes and collapses double spaces; NFC and trimming as well.
  assert.equal(isEnglishEcho("The “vision” of Obadiah", 'The "vision"  of Obadiah '), true);
  assert.equal(isEnglishEcho("é", "é"), true, "NFC on both sides");
  assert.equal(isEnglishEcho("رؤيا عوبديا", "The vision of Obadiah"), false);
  assert.equal(isEnglishEcho("", ""), false, "an empty English never counts");
  assert.equal(isEnglishEcho("x", undefined), false, "no English for this id");
  assert.equal(isEnglishEcho(null, "x"), false);
  // Links only: legitimately the same in every language.
  assert.equal(isEnglishEcho("[[rc://*/tw/dict/bible/kt/god]]", "[[rc://*/tw/dict/bible/kt/god]]"), false);
  assert.equal(isEnglishEcho("https://example.org/a", "https://example.org/a"), false);
  // A link with English words around it is still English.
  assert.equal(isEnglishEcho("See: [[rc://*/tw/dict/bible/kt/god]]", "See: [[rc://*/tw/dict/bible/kt/god]]"), true);
});

// The job translated from a pinned English commit, and the English on master
// has moved on since. The echo check must compare against the English the job
// actually translated from (options_json.sourceRef), not master.
const PINNED_SHA = "0123456789abcdef0123456789abcdef01234567";
const EN_TN_MASTER_TSV = [
  "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
  "1:1\tab12\t\t\tחֲז֖וֹן\t1\tA reworded English note on master",
  "1:2\tcd34\t\t\tקָטֹ֛ן\t1\t[[rc://*/ta/man/translate/figs-metaphor]]",
].join("\n");

test("import (internal, #794): the English echo check reads the English at the job's pinned sourceRef", async () => {
  const sqlite = freshSqlite();
  seedEchoTnRows(sqlite);
  clearSourceNotesCache();
  const urls = [];
  await runScopedImport(sqlite, {
    manifest: MANIFEST,
    file: "tn_OBA.tsv",
    bytes: ECHO_TN_TSV,
    options: { resourceType: "tn", sourceRef: `unfoldingWord/en_tn@${PINNED_SHA}` },
    fetchImpl: async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith(`/unfoldingWord/en_tn/raw/commit/${PINNED_SHA}/tn_OBA.tsv`)) return new Response(EN_TN_TSV, { status: 200 });
      if (u.endsWith("/raw/branch/master/tn_OBA.tsv")) return new Response(EN_TN_MASTER_TSV, { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    },
  });

  assert.deepEqual(
    tnRow(sqlite, "ab12"),
    { note: "The vision of Obadiah", translation_state: null, version: 1 },
    "the draft equals the English at the pinned commit, so it is not applied",
  );
  const report = JSON.parse(jobRow(sqlite).apply_skipped_json);
  assert.deepEqual(report.tnSameAsEnglishIds, ["ab12"]);
  assert.equal(urls.length, 1, "one English read for the job");
});

test("import (internal, #794): an Approve landing between the row read and the write is reported as kept-approved", async () => {
  const sqlite = freshSqlite();
  seedScopeTnRows(sqlite);
  sqlite.prepare(`UPDATE tn_rows SET translation_state = NULL WHERE id = 'cd34'`).run();
  seedRunningInternalJob(sqlite, wf("done", { status: "done" }, MANIFEST), { options: { resourceType: "tn" } });
  const env = freshEnv(sqlite);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "tn_OBA.tsv"), REDO_TN_TSV);
  env.blobs.map.set(outKey(env.WORKSPACE_SLUG, "job-1", "translate-report-1-1.json"), "{}");
  // A reviewer approves cd34 just before its guarded UPDATE runs. Approve does
  // not bump the version, so only the state guard stops the write.
  const batch = env.DB.batch.bind(env.DB);
  let fired = 0;
  env.DB.batch = async (stmts) => {
    const s = stmts[0];
    if (/UPDATE tn_rows\s+SET note/.test(s?.sql ?? "") && (s.args ?? []).includes("cd34")) {
      fired++;
      sqlite.prepare(`UPDATE tn_rows SET translation_state = 'validated' WHERE id = 'cd34'`).run();
    }
    return batch(stmts);
  };
  await withNoFetch(async () => pollAllNonTerminal(env));

  assert.equal(fired, 1, "the approval landed inside the apply's window");
  assert.deepEqual(tnRow(sqlite, "cd34"), { note: "ملاحظة عربية معتمدة", translation_state: "validated", version: 7 });
  const report = JSON.parse(jobRow(sqlite).apply_skipped_json);
  assert.deepEqual(report.tnApprovedIds, ["cd34"], "the late approval is listed as kept");
});

test("import (proxy, #794): the bot path keeps an approved note and drops an English echo too", async () => {
  const sqlite = freshSqlite();
  seedTargetTnRow(sqlite);
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, quote, occurrence, note, translation_state, version, updated_at)
       VALUES ('cd34', 'OBA', 1, 2, '1:2', 'קָטֹ֛ן', 1, 'ملاحظة عربية معتمدة', 'validated', 7, 100)`,
    )
    .run();
  seedRunningProxyJob(sqlite, { jobId: "proxy-1", upstreamId: "bot-1" });
  const env = freshEnv(sqlite);
  clearSourceNotesCache();
  const botOut = [
    "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote",
    '1:1\tab12\t\t\tחֲז֖וֹן\t1\tThe "vision" of Obadiah',
    "1:2\tcd34\t\t\tקָטֹ֛ן\t1\tThe English source note",
  ].join("\n");
  const status = {
    jobId: "bot-1",
    state: "done",
    current: { chapter: 1, skill: "translate-tn", status: "done" },
    output: [{ delivery: "editor", type: "tn", repo: "BSOJ/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" }],
  };
  const english = door43Fetch(EN_TN_TSV);
  await withFetch(
    async (url, init) => {
      const u = String(url);
      if (u.includes("/api/pipeline/bot-1/output")) return new Response(botOut, { status: 200 });
      if (u.endsWith("/api/pipeline/bot-1")) return new Response(JSON.stringify(status), { status: 200 });
      return english(url, init);
    },
    async () => pollAllNonTerminal(env),
  );

  assert.equal(jobRow(sqlite, "proxy-1").state, "done", "the import completed");
  assert.deepEqual(tnRow(sqlite, "ab12"), { note: "The vision of Obadiah", translation_state: null, version: 1 });
  assert.deepEqual(tnRow(sqlite, "cd34"), { note: "ملاحظة عربية معتمدة", translation_state: "validated", version: 7 });
  const report = JSON.parse(jobRow(sqlite, "proxy-1").apply_skipped_json);
  assert.deepEqual(report, { tnApproved: 1, tnApprovedIds: ["cd34"], tnSameAsEnglish: 1, tnSameAsEnglishIds: ["ab12"] });
});

test("POST /start (#794): a one-note redo of an approved note is not answered by a running whole-chapter job", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite);
  seedScopeTnRows(sqlite); // ab12 not approved, cd34 approved
  // The covering job: a whole-chapter tn translate of OBA 1, in flight.
  seedRunningProxyJob(sqlite, { jobId: "chapter-job", upstreamId: "bot-chapter" });
  sqlite.prepare(`UPDATE pipeline_jobs SET options_json = ? WHERE job_id = 'chapter-job'`).run(JSON.stringify({ resourceType: "tn" }));
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const app = routeApp();
  const tok = await editorToken("1", env.WORKSPACE_SLUG);
  const start = (rowIds) =>
    withFetch(
      async () => new Response(JSON.stringify({ jobId: "bot-new", provider: "claude" }), { status: 200 }),
      async () => app.request("/api/pipelines/start", postReq(tok, { ...START_TRANSLATE, translate: { rowIds } }), env),
    );

  const draftRedo = await start(["ab12"]);
  assert.equal(draftRedo.status, 200, await draftRedo.clone().text());
  const draftBody = await draftRedo.json();
  assert.equal(draftBody.status, "already_running", "a note the chapter job will redraft is covered by it");
  assert.equal(draftBody.jobId, "chapter-job");

  const approvedRedo = await start(["cd34"]);
  assert.equal(approvedRedo.status, 200, await approvedRedo.clone().text());
  const approvedBody = await approvedRedo.json();
  assert.notEqual(approvedBody.status, "already_running", "the chapter job would keep the approved note, so the redo starts");
  assert.notEqual(approvedBody.jobId, "chapter-job");
  const started = sqlite.prepare(`SELECT options_json FROM pipeline_jobs WHERE job_id = ?`).all(approvedBody.jobId)[0];
  assert.deepEqual(JSON.parse(started.options_json).rowIds, ["cd34"], "a new row-scoped job was enqueued");
});

// ── edit_log watermark (#601, migration 0076) ─────────────────────────────
// Every enqueue path stamps the highest edit_log.id at queue time, so the
// translate apply can tell an edit made after the enqueue from one made before,
// even inside the same second. Children inherit their parent's watermark.

function seedEditLog(sqlite, n) {
  const ins = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action) VALUES ('tn', 'x', 'OBA', 1, 1, 2, 'update')`,
  );
  for (let i = 0; i < n; i++) ins.run();
}

test("POST /start stamps the job with the edit_log watermark", async () => {
  const sqlite = freshSqlite();
  await seedByoKey(sqlite, { provider: "openai", model: "gpt-5.5" });
  seedEditLog(sqlite, 3);
  const env = freshEnv(sqlite, { JWT_SIGNING_KEY: ROUTE_SIGNING, JWT_ISSUER: ROUTE_ISSUER });
  const app = routeApp();
  const tok = await editorToken("1", env.WORKSPACE_SLUG);
  await withFetch(
    async () => new Response(JSON.stringify({ jobId: "bot-wm", provider: "openai" }), { status: 200 }),
    async () => {
      const res = await app.request("/api/pipelines/start", postReq(tok, START_TRANSLATE), env);
      assert.equal(res.status, 200, await res.clone().text());
    },
  );
  const rows = sqlite.prepare(`SELECT edit_log_watermark FROM pipeline_jobs`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].edit_log_watermark, 3);
});

function seedParent(sqlite, watermark) {
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, updated_at, edit_log_watermark)
       VALUES ('parent', 1, 'translate', 'OBA', 1, 1, 'sess-parent', 'done', 100, 100, ?)`,
    )
    .run(watermark);
}

for (const [label, enqueue] of [
  [
    "follow-up",
    (env) =>
      enqueueFollowUp(env, {
        parentJobId: "parent",
        parentSessionKey: "sess-parent",
        pipelineType: "translate",
        book: "OBA",
        startChapter: 1,
        endChapter: 1,
        followUpOptionsJson: JSON.stringify({ resourceType: "tq" }),
        userId: 1,
      }),
  ],
  [
    "chain",
    (env) =>
      enqueueFollowUpFromChain(env, {
        parentJobId: "parent",
        parentSessionKey: "sess-parent",
        book: "OBA",
        startChapter: 1,
        endChapter: 1,
        chainJson: JSON.stringify([{ pipelineType: "translate", options: { resourceType: "tq" } }]),
        userId: 1,
      }),
  ],
]) {
  test(`a ${label} child inherits its parent's edit_log watermark`, async () => {
    const sqlite = freshSqlite();
    seedParent(sqlite, 2);
    seedEditLog(sqlite, 5); // edits between the parent's and the child's enqueue
    await enqueue(freshEnv(sqlite));
    const child = sqlite.prepare(`SELECT edit_log_watermark FROM pipeline_jobs WHERE job_id != 'parent'`).all();
    assert.equal(child.length, 1);
    assert.equal(child[0].edit_log_watermark, 2, "edits after the parent was queued still count for the child");
  });

  test(`a ${label} child of a pre-watermark parent gets the current watermark`, async () => {
    const sqlite = freshSqlite();
    seedParent(sqlite, null);
    seedEditLog(sqlite, 4);
    await enqueue(freshEnv(sqlite));
    const child = sqlite.prepare(`SELECT edit_log_watermark FROM pipeline_jobs WHERE job_id != 'parent'`).all();
    assert.equal(child[0].edit_log_watermark, 4);
  });
}
