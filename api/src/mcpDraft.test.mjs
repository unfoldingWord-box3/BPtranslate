// Issue #670 part (b): the chat MCP tools bpt_draft and bpt_job_status.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/mcpDraft.test.mjs
//
// bpt_draft starts an AI draft through the REAL POST /api/pipelines/start,
// behind the REAL auth, CSRF and viewer middleware index.ts mounts, against the
// REAL migration schema; only the bot is faked (globalThis.fetch). Drafting from
// chat is admin-only (Benjamin, 2026-10-30): the chat principal is capped at
// editor, so the tool asks chatIsAdmin, which reads the user's real role in the
// workspace, as index.ts does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { pipelines, jobResultCounts } from "./pipelines.ts";
import { attachAuth, chatWriteEnv, requireCsrf } from "./auth.ts";
import { chatIsAdmin } from "./chatLinks.ts";
import { requireWorkspaceMatch } from "./workspaces.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { dispatch } from "./mcp.ts";
import { encryptApiKey } from "./aiKeyCrypto.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";

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

const BOOK = "TIT";
const ADMIN = "a".repeat(40);
const EDITOR = "e".repeat(40);
const VIEWER = "v".repeat(40);
const OTHER_ADMIN = "o".repeat(40);
const WRAPPING_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const API_KEY = "sk-test-chat-draft";

let slugSeq = 0;

async function fresh({ orgKey = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  const user = sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (?, ?, ?)`);
  user.run(9, 909, "boss");
  user.run(10, 910, "ed");
  user.run(11, 911, "reader");
  user.run(12, 912, "boss2");
  const role = sqlite.prepare(`INSERT INTO user_roles (dcs_username, role) VALUES (?, ?)`);
  role.run("boss", "admin");
  role.run("ed", "editor");
  role.run("boss2", "admin");
  sqlite.prepare(`INSERT INTO project_config (id, preset, overrides_json, updated_at) VALUES (1, 'ar-bsoj', NULL, 0)`).run();
  if (orgKey) {
    const { ciphertextB64, ivB64 } = await encryptApiKey(WRAPPING_KEY, API_KEY);
    sqlite
      .prepare(
        `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version, updated_at)
         VALUES (1, 'openai', 'gpt-5.5', ?, ?, 'DRAF', 1, 0)`,
      )
      .run(ciphertextB64, ivB64);
  }

  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireWorkspaceMatch);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/pipelines", pipelines);

  const WORKSPACE_SLUG = `d${++slugSeq}`;
  clearProjectConfigCache(WORKSPACE_SLUG);
  const env = {
    DB: makeDb(sqlite),
    WORKSPACE_SLUG,
    BT_API_TOKEN: "tok",
    AI_KEY_WRAPPING_KEY: WRAPPING_KEY,
    CHAPTER_ROOM: {
      idFromName: () => "room",
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) }),
    },
  };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const asJson = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
  // As index.ts builds it (sessionFor).
  const sessionFor = (principal) => ({
    workspace: { slug: WORKSPACE_SLUG, label: "Default", org: "Org" },
    principal,
    getJson: async (path) => asJson(await app.request(path, {}, env, ctx)),
    send: async (method, path, body, ifMatch) => {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (ifMatch !== undefined) headers["If-Match"] = String(ifMatch);
      return asJson(
        await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, chatWriteEnv(env, principal), ctx),
      );
    },
    packageRefs: async () => ({}),
    sourceNotes: async () => ({ ok: false, reason: "test" }),
    confirmMac: async () => null,
    isAdmin: () => chatIsAdmin(env, principal.username),
    jobResults: (jobId) => jobResultCounts(env, jobId),
  });
  // Chat principals are capped at editor (chatLinks.ts chatRole), admins too.
  const sessions = {
    [ADMIN]: sessionFor({ userId: 9, username: "boss", role: "editor", linkId: 1 }),
    [EDITOR]: sessionFor({ userId: 10, username: "ed", role: "editor", linkId: 2 }),
    [VIEWER]: sessionFor({ userId: 11, username: "reader", role: null, linkId: 3 }),
    [OTHER_ADMIN]: sessionFor({ userId: 12, username: "boss2", role: "editor", linkId: 4 }),
  };
  const toolCtx = { session: async (t) => sessions[t] ?? null, claimLink: async () => ({ ok: false }) };
  const call = async (name, args, token = ADMIN) => {
    const reply = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { session_token: token, ...args } } },
      toolCtx,
    );
    return { isError: reply.result.isError === true, data: JSON.parse(reply.result.content[0].text) };
  };
  const jobs = () => sqlite.prepare(`SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, options_json FROM pipeline_jobs ORDER BY created_at, job_id`).all().map((r) => ({ ...r }));
  return { sqlite, env, call, jobs, toolCtx };
}

// The fake bot: POST /api/pipeline/start answers a job id; GET answers a
// running status at chapter 1.
const realFetch = globalThis.fetch;
async function withBot(fn, { status = { state: "running", current: { chapter: 1, skill: "translate-tn", status: "verse 3 of 12", startedAt: "2026-11-02T10:00:00Z" } } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/api/pipeline/start")) {
      return new Response(JSON.stringify({ jobId: "bot-1", provider: "openai" }), { status: 200 });
    }
    return new Response(JSON.stringify({ jobId: "bot-1", pipelineType: "translate", ...status, updatedAt: "2026-11-02T10:01:00Z", createdAt: "2026-11-02T10:00:00Z" }), { status: 200 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const DRAFT = { book: BOOK, kind: "tn", chapter: 1, verse_start: 2, verse_end: 4 };

test("bpt_draft: an admin starts a verse-range translate through the real start route; the job records the chat link", async () => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    const r = await call("bpt_draft", DRAFT);
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.status, "running");
    assert.ok(r.data.job_id);
    const all = jobs();
    assert.equal(all.length, 1);
    const j = all[0];
    assert.equal(j.job_id, r.data.job_id);
    assert.equal(j.user_id, 9, "the job belongs to the linked admin");
    assert.equal(j.pipeline_type, "translate");
    assert.deepEqual([j.book, j.start_chapter, j.end_chapter], [BOOK, 1, 1]);
    assert.equal(j.session_key, "chat/link-1", "the chat origin is recorded on the job");
    const opts = JSON.parse(j.options_json);
    assert.equal(opts.resourceType, "tn");
    assert.equal(opts.verseStart, 2);
    assert.equal(opts.verseEnd, 4);
    const start = calls.filter((c) => c.url.endsWith("/api/pipeline/start"));
    assert.equal(start.length, 1, "dispatched to the bot once");
    assert.equal(start[0].body.apiKey, API_KEY, "on the org's own key");
  });
});

test("bpt_draft: row ids scope the job to those notes", async () => {
  const { call, jobs } = await fresh();
  await withBot(async () => {
    const r = await call("bpt_draft", { book: BOOK, kind: "tq", chapter: 2, ids: ["q002", "q001"] });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    const opts = JSON.parse(jobs()[0].options_json);
    assert.equal(opts.resourceType, "tq");
    assert.deepEqual(opts.rowIds, ["q001", "q002"]);
  });
});

test("bpt_draft: an editor and a viewer are refused before anything is read or started", async () => {
  for (const token of [EDITOR, VIEWER]) {
    const { call, jobs } = await fresh();
    await withBot(async (calls) => {
      const r = await call("bpt_draft", DRAFT, token);
      assert.equal(r.isError, true, JSON.stringify(r.data));
      assert.match(r.data.error, token === EDITOR ? /admins only/ : /cannot edit/);
      assert.equal(calls.length, 0, "the bot was not called");
      assert.equal(jobs().length, 0, "no job was enqueued");
    });
  }
});

test("bpt_draft: with no org AI key the refusal says so and nothing is enqueued", async () => {
  const { call, jobs } = await fresh({ orgKey: false });
  await withBot(async (calls) => {
    const r = await call("bpt_draft", DRAFT);
    assert.equal(r.isError, true, JSON.stringify(r.data));
    assert.match(r.data.error, /no AI key of its own/);
    assert.match(r.data.error, /Nothing was started/);
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});

test("bpt_draft: a bare chapter, ids with a verse range, and verse 0 are refused as input", async () => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    for (const args of [
      { book: BOOK, kind: "tn", chapter: 1 },
      { ...DRAFT, ids: ["ab12"] },
      { book: BOOK, kind: "tn", chapter: 1, verse_start: 0 },
      { book: BOOK, kind: "tw", chapter: 1, verse_start: 1 },
    ]) {
      const r = await call("bpt_draft", args);
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});

test("bpt_draft: the same draft twice points at the running job; another admin's same draft is reported busy", async () => {
  const { call, jobs } = await fresh();
  await withBot(async () => {
    const first = await call("bpt_draft", DRAFT);
    const again = await call("bpt_draft", DRAFT);
    assert.equal(again.isError, false, JSON.stringify(again.data));
    assert.equal(again.data.status, "already_running");
    assert.equal(again.data.job_id, first.data.job_id);
    const other = await call("bpt_draft", DRAFT, OTHER_ADMIN);
    assert.equal(other.isError, false, JSON.stringify(other.data));
    assert.equal(other.data.status, "busy");
    assert.equal(other.data.job_id, first.data.job_id);
    assert.equal(other.data.started_by, "boss");
    assert.equal(jobs().length, 1);
  });
});

test("bpt_job_status: the starter sees state and progress, and result counts once proposals are staged", async () => {
  const { call, sqlite } = await fresh();
  await withBot(async () => {
    const started = await call("bpt_draft", DRAFT);
    const s = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.equal(s.isError, false, JSON.stringify(s.data));
    assert.equal(s.data.job_id, started.data.job_id);
    assert.equal(s.data.state, "running");
    assert.equal(s.data.book, BOOK);
    assert.deepEqual(s.data.progress, { chapter: 1, step: "translate-tn", status: "verse 3 of 12" });
    assert.deepEqual(s.data.results, {}, "nothing staged yet");

    const pi = sqlite.prepare(
      `INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json, accepted_at, rejected_at) VALUES (?, ?, ?, 1, ?, '{}', ?, ?)`,
    );
    pi.run(started.data.job_id, "tn", BOOK, 2, 100, null);
    pi.run(started.data.job_id, "tn", BOOK, 3, 100, null);
    pi.run(started.data.job_id, "tn", BOOK, 4, null, 100);
    pi.run(started.data.job_id, "tn", BOOK, 4, null, null);
    const s2 = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.deepEqual(s2.data.results, { tn: { proposed: 4, applied: 2, rejected: 1 } });
  });
});

test("bpt_job_status: another user's job, a job in another workspace and an unknown id all get the same not-found answer", async () => {
  const a = await fresh();
  const b = await fresh();
  await withBot(async () => {
    const mine = await a.call("bpt_draft", DRAFT);
    const there = await b.call("bpt_draft", DRAFT);
    assert.equal(there.isError, false, JSON.stringify(there.data));
    const answers = [
      await a.call("bpt_job_status", { job_id: mine.data.job_id }, OTHER_ADMIN),
      await a.call("bpt_job_status", { job_id: mine.data.job_id }, EDITOR),
      await a.call("bpt_job_status", { job_id: there.data.job_id }),
      await a.call("bpt_job_status", { job_id: "no-such-job" }),
    ];
    for (const r of answers) {
      assert.equal(r.isError, true, JSON.stringify(r.data));
      assert.match(r.data.error, /No job with that id that you started in this project/);
    }
    const viewer = await a.call("bpt_job_status", { job_id: mine.data.job_id }, VIEWER);
    assert.equal(viewer.isError, true);
  });
});
