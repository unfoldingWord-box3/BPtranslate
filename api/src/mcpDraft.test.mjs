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
//
// #747 (Benjamin chose option B): bpt_draft is two calls. A preview (no
// confirm_token) starts nothing and lists the rows the run would redo, how many
// of them are approved (a run on chosen rows or a verse range redrafts approved
// rows; only a whole-chapter run keeps them, and chat refuses whole chapters),
// and a token signed for bpt_draft alone. Only a confirm with that token, the
// same arguments and the same rows starts the run. The `draft` helper below
// does both steps for tests about what happens after the start.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { pipelines, jobResultCounts } from "./pipelines.ts";
import { chapters } from "./chapters.ts";
import { attachAuth, chatConfirmMac, chatWriteEnv, requireCsrf } from "./auth.ts";
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

// signingKey: false runs with no JWT_SIGNING_KEY (no confirm tokens at all).
// macIgnoresPurpose signs every tool's token under one prefix, to show the
// token body's own purpose tag still keeps the tools apart.
async function fresh({ orgKey = true, signingKey = true, macIgnoresPurpose = false } = {}) {
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
  // TIT 1: tn rows on verses 1 to 6 (and an intro row); TIT 2: three tq rows.
  const tn = sqlite.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES (?, ?, 1, ?, ?, 'n', 10, 1, 'validated')`);
  tn.run("in01", BOOK, 0, "1:intro");
  for (let v = 1; v <= 6; v++) tn.run(`t00${v}`, BOOK, v, `1:${v}`);
  const tq = sqlite.prepare(`INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, version, translation_state) VALUES (?, ?, 2, ?, ?, 'q?', 'a.', 1, 'validated')`);
  tq.run("q001", BOOK, 1, "2:1");
  tq.run("q002", BOOK, 2, "2:2");
  tq.run("q003", BOOK, 3, "2:3");
  // Written a minute ago: bpt_bulk_set_state's preview leaves out rows written
  // in its own second, and the #747 tests preview it on these rows.
  sqlite.exec(`UPDATE tn_rows SET updated_at = unixepoch() - 60; UPDATE tq_rows SET updated_at = unixepoch() - 60;`);
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
  app.route("/api/chapters", chapters);

  const WORKSPACE_SLUG = `d${++slugSeq}`;
  clearProjectConfigCache(WORKSPACE_SLUG);
  const env = {
    DB: makeDb(sqlite),
    WORKSPACE_SLUG,
    BT_API_TOKEN: "tok",
    AI_KEY_WRAPPING_KEY: WRAPPING_KEY,
    ...(signingKey ? { JWT_SIGNING_KEY: "test-signing-key" } : {}),
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
    // As index.ts wires it.
    confirmMac: (data, purpose) => chatConfirmMac(env, data, macIgnoresPurpose ? "bpt_bulk_set_state" : purpose),
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
  // Preview, then confirm with its token: the two calls a reviewer's yes sits
  // between. A refused preview comes back as it is.
  const draft = async (args, token = ADMIN) => {
    const preview = await call("bpt_draft", args, token);
    if (preview.isError) return preview;
    assert.equal(preview.data.status, "preview", JSON.stringify(preview.data));
    return call("bpt_draft", { ...args, confirm_token: preview.data.confirm_token }, token);
  };
  return { sqlite, env, call, draft, jobs, toolCtx };
}

// bp-assistant's start contract (unfoldingWord/bp-assistant src/api/pipeline.js,
// StartBodySchema + OptionsSchema, read 2026-11-02): options is .strict() with
// no verse keys, verse scoping is top-level verseStart/verseEnd (1 to 200), and
// rowIds match /^[a-z][a-z0-9]{3}$/. The fake bot answers 400 like the real
// one when a start breaks it.
const BOT_OPTION_KEYS = new Set([
  "model", "fresh", "contentTypes", "noAlign", "alignOnly", "textOnly", "noIntro", "pauseBeforeATs",
  "resourceType", "articleId", "articleUrl", "sourceLang", "targetLang", "targetOrg", "repoName",
  "sourceRef", "contextRef", "literalRef", "simplifiedRef", "writeContextBack", "branchOnly",
  "delivery", "direction", "rowIds", "hints", "kept",
]);
function botStartProblem(b) {
  const o = b.options ?? {};
  const unknown = Object.keys(o).filter((k) => !BOT_OPTION_KEYS.has(k));
  if (unknown.length) return `options: unrecognized keys ${unknown.join(", ")}`;
  if (o.rowIds && !o.rowIds.every((id) => /^[a-z][a-z0-9]{3}$/.test(id))) return "options.rowIds: invalid id";
  for (const k of ["verseStart", "verseEnd"]) {
    if (b[k] != null && !(Number.isInteger(b[k]) && b[k] >= 1 && b[k] <= 200)) return `${k}: out of range`;
  }
  if (b.verseEnd != null && b.verseStart == null) return "verseEnd without verseStart";
  return null;
}

// The fake bot: POST /api/pipeline/start answers a job id (or 400, as above);
// GET answers a running status at chapter 1.
const realFetch = globalThis.fetch;
async function withBot(fn, { status = { state: "running", current: { chapter: 1, skill: "translate-tn", status: "verse 3 of 12", startedAt: "2026-11-02T10:00:00Z" } }, startStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("/api/pipeline/start")) {
      const problem = botStartProblem(calls.at(-1).body);
      if (problem) return new Response(JSON.stringify({ error: "invalid_body", message: problem }), { status: 400 });
      if (startStatus !== 200) return new Response(JSON.stringify({ error: "bot_down" }), { status: startStatus });
      return new Response(JSON.stringify({ jobId: "bot-1", provider: "openai" }), { status: 200 });
    }
    // The bot's StatusResponse (pipelines.ts) carries the scope too.
    return new Response(JSON.stringify({ jobId: "bot-1", pipelineType: "translate", scope: { book: BOOK, startChapter: 1, endChapter: 1 }, ...status, updatedAt: "2026-11-02T10:01:00Z", createdAt: "2026-11-02T10:00:00Z" }), { status: 200 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const DRAFT = { book: BOOK, kind: "tn", chapter: 1, verse_start: 2, verse_end: 4 };

test("bpt_draft: an admin starts a verse-range translate through the real start route; the job records the chat link", async () => {
  const { call, draft, jobs } = await fresh();
  await withBot(async (calls) => {
    const r = await draft(DRAFT);
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
    assert.equal(start[0].body.verseStart, 2, "verse scope rides at the top level, as the bot reads it");
    assert.equal(start[0].body.verseEnd, 4);
    assert.equal(start[0].body.options.verseStart, undefined, "and not in the bot's strict options");
  });
});

test("bpt_draft: row ids scope the job to those notes", async () => {
  const { draft, jobs } = await fresh();
  await withBot(async () => {
    const r = await draft({ book: BOOK, kind: "tq", chapter: 2, ids: ["q002", "q001"] });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.status, "running");
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
  const { draft, jobs } = await fresh({ orgKey: false });
  await withBot(async (calls) => {
    const r = await draft(DRAFT);
    assert.equal(r.isError, true, JSON.stringify(r.data));
    assert.match(r.data.error, /no AI key of its own/);
    assert.match(r.data.error, /Nothing was started/);
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});

test("bpt_draft: a bare chapter, a range or ids covering the whole chapter, ids with a verse range, verse 0 or past 200, and nothing to draft are refused", async () => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    for (const [args, why] of [
      [{ book: BOOK, kind: "tn", chapter: 1 }, /whole chapter/],
      [{ book: BOOK, kind: "tn", chapter: 1, verse_start: 1, verse_end: 6 }, /whole chapter/],
      [{ book: BOOK, kind: "tn", chapter: 1, verse_start: 1, verse_end: 150 }, /whole chapter/],
      [{ book: BOOK, kind: "tq", chapter: 2, ids: ["q001", "q002", "q003"] }, /whole chapter/],
      [{ ...DRAFT, ids: ["t002"] }, /not both/],
      [{ book: BOOK, kind: "tn", chapter: 1, verse_start: 0 }, /verse_start/],
      [{ book: BOOK, kind: "tn", chapter: 1, verse_start: 2, verse_end: 100000 }, /verse_end/],
      [{ book: BOOK, kind: "tw", chapter: 1, verse_start: 1 }, /kind/],
      [{ book: BOOK, kind: "tn", chapter: 9, verse_start: 1 }, /no tn notes/],
      [{ book: "JUD", kind: "tn", chapter: 1, verse_start: 1 }, /no tn notes/],
      [{ book: BOOK, kind: "tq", chapter: 1, verse_start: 1 }, /no tq notes/],
      [{ book: BOOK, kind: "tn", chapter: 1, verse_start: 7, verse_end: 9 }, /no tn notes in TIT 1:7-9/],
      [{ book: BOOK, kind: "tn", chapter: 1, ids: ["t002", "zz99"] }, /zz99/],
    ]) {
      const r = await call("bpt_draft", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.data.error, why, JSON.stringify([args, r.data]));
    }
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});

test("bpt_draft: the same draft twice points at the running job; another admin's same draft is reported busy", async () => {
  const { draft, jobs } = await fresh();
  await withBot(async () => {
    const first = await draft(DRAFT);
    const again = await draft(DRAFT);
    assert.equal(again.isError, false, JSON.stringify(again.data));
    assert.equal(again.data.status, "already_running");
    assert.equal(again.data.job_id, first.data.job_id);
    const other = await draft(DRAFT, OTHER_ADMIN);
    assert.equal(other.isError, false, JSON.stringify(other.data));
    assert.equal(other.data.status, "busy");
    assert.equal(other.data.job_id, undefined, "another user's job id is not handed out: bpt_job_status would not show it");
    assert.equal(other.data.started_by, "boss");
    assert.match(other.data.message, /boss/);
    assert.match(other.data.message, /only they|web app/);
    assert.equal(jobs().length, 1);
  });
});

test("bpt_job_status: the starter sees state and progress, and result counts once proposals are staged", async () => {
  const { call, draft, sqlite } = await fresh();
  await withBot(async () => {
    const started = await draft(DRAFT);
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

    // #729: notes the apply left alone because a person changed them after
    // the job was queued.
    sqlite
      .prepare(`UPDATE pipeline_jobs SET state = 'done', apply_skipped_json = ? WHERE job_id = ?`)
      .run(JSON.stringify({ tnTouched: 1, tnTouchedIds: ["t003"] }), started.data.job_id);
    const s3 = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.equal(s3.data.state, "done");
    assert.deepEqual(s3.data.kept_because_changed_by_people, { tn: 1, tn_ids: ["t003"] });
  });
});

test("bpt_job_status: questions and tW/tA articles kept because a person changed them are reported, not just notes (#760)", async () => {
  const { call, draft, sqlite } = await fresh();
  await withBot(async () => {
    const started = await draft(DRAFT);
    const setReport = (report) =>
      sqlite
        .prepare(`UPDATE pipeline_jobs SET state = 'done', apply_skipped_json = ? WHERE job_id = ?`)
        .run(JSON.stringify(report), started.data.job_id);

    setReport({ tqTouched: 1, tqTouchedIds: ["q1"] });
    const q = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.equal(q.isError, false, JSON.stringify(q.data));
    assert.deepEqual(q.data.kept_because_changed_by_people, { tq: 1, tq_ids: ["q1"] });

    setReport({ articleTouched: 2, articleTouchedPaths: ["bible/kt/god.md", "bible/kt/love.md"] });
    const a = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.deepEqual(a.data.kept_because_changed_by_people, {
      articles: 2,
      article_paths: ["bible/kt/god.md", "bible/kt/love.md"],
    });

    setReport({ tnTouched: 1, tnTouchedIds: ["t003"], tqTouched: 2, tqTouchedIds: ["q1", "q2"] });
    const both = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.deepEqual(both.data.kept_because_changed_by_people, { tn: 1, tn_ids: ["t003"], tq: 2, tq_ids: ["q1", "q2"] });
  });
});

test("bpt_job_status: rows kept because approved, English echoes not applied and a skipped English check are reported apart (#794)", async () => {
  const { call, draft, sqlite } = await fresh();
  await withBot(async () => {
    const started = await draft(DRAFT);
    const setReport = (report) =>
      sqlite
        .prepare(`UPDATE pipeline_jobs SET state = 'done', apply_skipped_json = ? WHERE job_id = ?`)
        .run(JSON.stringify(report), started.data.job_id);

    setReport({
      tnTouched: 1,
      tnTouchedIds: ["t003"],
      tnApproved: 2,
      tnApprovedIds: ["t001", "t002"],
      tnSameAsEnglish: 1,
      tnSameAsEnglishIds: ["t004"],
    });
    const s = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.equal(s.isError, false, JSON.stringify(s.data));
    assert.deepEqual(s.data.kept_because_changed_by_people, { tn: 1, tn_ids: ["t003"] });
    assert.deepEqual(s.data.kept_because_approved, { tn: 2, tn_ids: ["t001", "t002"] });
    assert.deepEqual(s.data.not_applied_same_as_english, { tn: 1, tn_ids: ["t004"] });
    assert.equal(s.data.english_check_not_run, undefined);

    setReport({ tqApproved: 1, tqApprovedIds: ["q1"], tnEnglishCheckNotRun: "Could not read the English notes." });
    const q = await call("bpt_job_status", { job_id: started.data.job_id });
    assert.deepEqual(q.data.kept_because_approved, { tq: 1, tq_ids: ["q1"] });
    assert.equal(q.data.kept_because_changed_by_people, undefined);
    assert.equal(q.data.not_applied_same_as_english, undefined);
    assert.equal(q.data.english_check_not_run, "Could not read the English notes.");
  });
});

test("bpt_job_status: another user's job, a job in another workspace and an unknown id all get the same not-found answer", async () => {
  const a = await fresh();
  const b = await fresh();
  await withBot(async () => {
    const mine = await a.draft(DRAFT);
    const there = await b.draft(DRAFT);
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

test("bpt_draft: a run the bot refuses comes back as a plain refusal with the failed job's id, not an internal error", async () => {
  const { call, draft, jobs } = await fresh();
  await withBot(
    async () => {
      const r = await draft(DRAFT);
      assert.equal(r.isError, true, JSON.stringify(r.data));
      assert.doesNotMatch(r.data.error, /Internal error/);
      const j = jobs()[0];
      assert.equal(j.state, "failed");
      assert.match(r.data.error, new RegExp(j.job_id));
      assert.match(r.data.error, /Nothing is running/);

      // The failed job never reached the bot (no upstream id); its stored
      // reason still reaches bpt_job_status.
      const st = await call("bpt_job_status", { job_id: j.job_id });
      assert.equal(st.isError, false, JSON.stringify(st.data));
      assert.equal(st.data.state, "failed");
      assert.ok(st.data.error?.kind, JSON.stringify(st.data));
      assert.match(String(st.data.error.message), /503/);
      assert.equal(st.data.progress, undefined);
    },
    { startStatus: 503 },
  );
});

// ── #747: preview, then a confirm that covers exactly that list ─────────────

const tokenBody = (tok) => JSON.parse(Buffer.from(tok.split(".")[0], "base64url").toString("utf8"));
const RANGE = { book: BOOK, kind: "tn", chapter: 1, verse_start: 2, verse_end: 4 };
const tnStates = (sqlite) =>
  sqlite.prepare(`SELECT translation_state AS s FROM tn_rows WHERE id IN ('t002','t003','t004') ORDER BY id`).all().map((x) => x.s);

test("bpt_draft preview: starts nothing, lists the rows it would redo and how many approved ones it would replace", async () => {
  const { call, sqlite, jobs } = await fresh();
  // t003 already needs review; t004 is Not needed (trashed), which the apply
  // leaves alone (#735), so it is neither redone nor counted.
  sqlite.prepare(`UPDATE tn_rows SET translation_state = 'edited' WHERE id = 't003'`).run();
  sqlite.prepare(`UPDATE tn_rows SET trashed_at = 100 WHERE id = 't004'`).run();
  await withBot(async (calls) => {
    const r = await call("bpt_draft", DRAFT);
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.status, "preview");
    assert.deepEqual([r.data.book, r.data.kind, r.data.chapter, r.data.verse_start, r.data.verse_end], [BOOK, "tn", 1, 2, 4]);
    assert.equal(r.data.will_redraft, 2);
    assert.deepEqual(r.data.rows.map((x) => [x.id, x.ref, x.state]), [["t002", "TIT 1:2", "validated"], ["t003", "TIT 1:3", "edited"]]);
    assert.equal(r.data.approved_will_be_replaced, 1, "a verse-range run redrafts approved rows (#794 keeps them only for a whole chapter)");
    assert.deepEqual(r.data.approved_ids, ["t002"]);
    assert.equal(r.data.left_alone.length, 1, JSON.stringify(r.data.left_alone));
    assert.deepEqual([r.data.left_alone[0].reason, r.data.left_alone[0].count, r.data.left_alone[0].ids], ["trashed", 1, ["t004"]]);
    assert.equal(typeof r.data.confirm_token, "string");
    assert.match(r.data.message, /Nothing was started/);
    assert.match(r.data.message, /1 of them approved/);
    assert.equal(calls.length, 0, "the bot was not called");
    assert.equal(jobs().length, 0, "no job was enqueued");
    assert.equal(tokenBody(r.data.confirm_token).p, "bpt_draft", "the token body names the tool it is for");
  });
});

test("bpt_draft confirm: the token starts exactly the previewed scope, by verse range or by ids", async () => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    const p = await call("bpt_draft", DRAFT);
    const r = await call("bpt_draft", { ...DRAFT, confirm_token: p.data.confirm_token });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.status, "running");
    assert.equal(jobs().length, 1);
    const opts = JSON.parse(jobs()[0].options_json);
    assert.deepEqual([opts.verseStart, opts.verseEnd, opts.rowIds], [2, 4, undefined]);
    assert.equal(calls.filter((c) => c.url.endsWith("/api/pipeline/start")).length, 1);
  });
  const two = await fresh();
  await withBot(async () => {
    const args = { book: BOOK, kind: "tq", chapter: 2, ids: ["q002", "q001"] };
    const p = await two.call("bpt_draft", args);
    assert.equal(p.data.will_redraft, 2, JSON.stringify(p.data));
    assert.equal(p.data.approved_will_be_replaced, 2);
    // The same ids in another order are the same list.
    const r = await two.call("bpt_draft", { ...args, ids: ["q001", "q002"], confirm_token: p.data.confirm_token });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.deepEqual(JSON.parse(two.jobs()[0].options_json).rowIds, ["q001", "q002"]);
  });
});

test("bpt_draft confirm: tampered, expired, other-scope, other-ids, other-link and bpt_bulk_set_state tokens are refused and start nothing", async (t) => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    const p = await call("bpt_draft", DRAFT);
    const token = p.data.confirm_token;
    const idsArgs = { book: BOOK, kind: "tn", chapter: 1, ids: ["t002", "t003", "t004"] };
    const idsToken = (await call("bpt_draft", idsArgs)).data.confirm_token;
    const refused = async (args, tok = ADMIN) => {
      const r = await call("bpt_draft", args, tok);
      assert.equal(r.isError, true, JSON.stringify([args, r.data]));
      assert.match(r.data.error, /Nothing was started/);
      return r.data.error;
    };
    // Tampered: the scope widened in the body, the signature kept; a bent MAC.
    const [body, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...tokenBody(token), ve: 5 })).toString("base64url")}.${mac}`;
    assert.match(await refused({ ...DRAFT, verse_end: 5, confirm_token: forged }), /not one this tool issued/);
    assert.match(await refused({ ...DRAFT, confirm_token: `${body}.${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}` }), /not one this tool issued/);
    await refused({ ...DRAFT, confirm_token: "not-a-token" });
    // Other scope than the preview's.
    assert.match(await refused({ ...DRAFT, verse_end: 5, confirm_token: token }), /different preview/);
    await refused({ ...DRAFT, verse_start: 3, confirm_token: token });
    await refused({ book: BOOK, kind: "tq", chapter: 2, verse_start: 1, verse_end: 2, confirm_token: token });
    // Other ids: one more, one fewer, and the same rows asked for by verse range.
    await refused({ ...idsArgs, ids: [...idsArgs.ids, "t005"], confirm_token: idsToken });
    await refused({ ...idsArgs, ids: ["t002", "t003"], confirm_token: idsToken });
    assert.match(await refused({ ...DRAFT, confirm_token: idsToken }), /different preview/);
    assert.match(await refused({ ...idsArgs, confirm_token: token }), /different preview/);
    // Another admin's link.
    await refused({ ...DRAFT, confirm_token: token }, OTHER_ADMIN);
    // A bpt_bulk_set_state preview token for the very same book, kind,
    // chapter and verse range: only the tool it was issued for differs.
    const bulk = await call("bpt_bulk_set_state", RANGE);
    assert.equal(typeof bulk.data.confirm_token, "string", JSON.stringify(bulk.data));
    assert.match(await refused({ ...DRAFT, confirm_token: bulk.data.confirm_token }), /not one this tool issued/);
    // Expired: ten minutes and a bit later.
    const real = Date.now();
    t.mock.method(Date, "now", () => real + 11 * 60_000);
    assert.match(await refused({ ...DRAFT, confirm_token: token }), /expired/);
    t.mock.restoreAll();

    assert.equal(calls.length, 0, "the bot was never called");
    assert.equal(jobs().length, 0, "nothing was enqueued");
    // The genuine token, with the same arguments, still works.
    const ok = await call("bpt_draft", { ...DRAFT, confirm_token: token });
    assert.equal(ok.data.status, "running", JSON.stringify(ok.data));
  });
});

test("a bpt_draft token cannot confirm bpt_bulk_set_state: the approved rows stay approved", async () => {
  const { call, sqlite } = await fresh();
  const p = await call("bpt_draft", RANGE);
  assert.equal(typeof p.data.confirm_token, "string", JSON.stringify(p.data));
  const r = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: p.data.confirm_token });
  assert.equal(r.isError, true, JSON.stringify(r.data));
  assert.match(r.data.error, /not one this tool issued/);
  assert.match(r.data.error, /Nothing was changed/);
  assert.deepEqual(tnStates(sqlite), ["validated", "validated", "validated"]);
});

test("the token body's purpose tag alone keeps the tools apart, even if both signed under one prefix", async () => {
  const { call, sqlite, jobs } = await fresh({ macIgnoresPurpose: true });
  await withBot(async (calls) => {
    const bulk = await call("bpt_bulk_set_state", RANGE);
    const r = await call("bpt_draft", { ...RANGE, confirm_token: bulk.data.confirm_token });
    assert.equal(r.isError, true, JSON.stringify(r.data));
    assert.match(r.data.error, /not one this tool issued/);
    const d = await call("bpt_draft", RANGE);
    const b = await call("bpt_bulk_set_state", { ...RANGE, confirm_token: d.data.confirm_token });
    assert.equal(b.isError, true, JSON.stringify(b.data));
    assert.match(b.data.error, /not one this tool issued/);
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
    assert.deepEqual(tnStates(sqlite), ["validated", "validated", "validated"]);
  });
});

test("bpt_draft confirm: a row approved, edited or added in the range after the preview means a new preview, and nothing starts", async () => {
  for (const change of [
    (s) => s.prepare(`UPDATE tn_rows SET translation_state = 'validated' WHERE id = 't003'`).run(),
    (s) => s.prepare(`UPDATE tn_rows SET note = 'changed', version = version + 1 WHERE id = 't002'`).run(),
    (s) => s.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES ('t033', ?, 1, 3, '1:3', 'n', 20, 1, 'edited')`).run(BOOK),
  ]) {
    const { call, sqlite, jobs } = await fresh();
    sqlite.prepare(`UPDATE tn_rows SET translation_state = 'edited' WHERE id = 't003'`).run();
    await withBot(async (calls) => {
      const p = await call("bpt_draft", DRAFT);
      change(sqlite);
      const r = await call("bpt_draft", { ...DRAFT, confirm_token: p.data.confirm_token });
      assert.equal(r.isError, true, JSON.stringify(r.data));
      assert.match(r.data.error, /changed since the preview/);
      assert.match(r.data.error, /Nothing was started/);
      assert.equal(calls.length, 0);
      assert.equal(jobs().length, 0);
    });
  }
});

test("bpt_draft preview: a note whose reference spans verses is in a range it overlaps, as the run selects it", async () => {
  const { call, sqlite } = await fresh();
  sqlite.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES ('t045', ?, 1, 4, '1:4-5', 'n', 20, 1, 'validated')`).run(BOOK);
  const r = await call("bpt_draft", { book: BOOK, kind: "tn", chapter: 1, verse_start: 5, verse_end: 5 });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.deepEqual(r.data.rows.map((x) => x.id).sort(), ["t005", "t045"]);
  assert.equal(r.data.approved_will_be_replaced, 2);
});

test("bpt_draft preview: a long selection lists the first 100 rows and says how many more; the token covers them all", async () => {
  const { call, sqlite, jobs } = await fresh();
  const tn = sqlite.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES (?, ?, 1, 3, '1:3', 'n', 30, 1, 'validated')`);
  for (let i = 0; i < 110; i++) tn.run(`m${String(i).padStart(3, "0")}`, BOOK);
  await withBot(async () => {
    const p = await call("bpt_draft", DRAFT);
    assert.equal(p.isError, false, JSON.stringify(p.data).slice(0, 500));
    assert.equal(p.data.will_redraft, 113);
    assert.equal(p.data.rows.length, 100);
    assert.equal(p.data.more_rows_not_listed, 13);
    assert.equal(p.data.approved_will_be_replaced, 113);
    assert.equal(p.data.approved_ids.length, 100);
    assert.equal(tokenBody(p.data.confirm_token).n, 113, "the token counts every row, not just the listed ones");
    assert.ok(Buffer.byteLength(JSON.stringify(p.data)) < 16_000, "well under BT Servant's 32 KB result limit");
    const r = await call("bpt_draft", { ...DRAFT, confirm_token: p.data.confirm_token });
    assert.equal(r.data.status, "running", JSON.stringify(r.data));
    assert.equal(jobs().length, 1);
  });
});

// Review of #747 (Grok, open model, Claude F5): the token must not grow with the
// selection, or a big range pushes the result past BT Servant's 32 KB limit and
// the reviewer can never confirm. It carries a fixed-size digest of the rows.
test("bpt_draft preview: 800 rows stay well under 32 KB as sent, and a change to any one of them still refuses the confirm", async () => {
  for (const changed of ["m000", "m799"]) {
    const { call, sqlite, jobs } = await fresh();
    const tn = sqlite.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES (?, ?, 1, 3, '1:3', 'n', 30, 1, 'validated')`);
    for (let i = 0; i < 800; i++) tn.run(`m${String(i).padStart(3, "0")}`, BOOK);
    await withBot(async (calls) => {
      const p = await call("bpt_draft", DRAFT);
      assert.equal(p.isError, false, JSON.stringify(p.data).slice(0, 500));
      assert.equal(p.data.will_redraft, 803);
      // mcp.ts sends the result as JSON text inside the JSON-RPC reply, so it
      // is encoded twice on the wire.
      const wire = Buffer.byteLength(JSON.stringify(JSON.stringify(p.data)));
      assert.ok(wire < 20_000, `result is ${wire} bytes as sent`);
      assert.ok(p.data.confirm_token.length < 600, `token is ${p.data.confirm_token.length} characters`);
      sqlite.prepare(`UPDATE tn_rows SET version = version + 1 WHERE id = ?`).run(changed);
      const r = await call("bpt_draft", { ...DRAFT, confirm_token: p.data.confirm_token });
      assert.equal(r.isError, true, JSON.stringify(r.data));
      assert.match(r.data.error, /changed since the preview/);
      assert.equal(calls.length, 0);
      assert.equal(jobs().length, 0);
    });
  }
});

// Review of #747 (Codex, Claude F4, open model): the whole-chapter guard must use
// the same reference-overlap selection the run uses. A range whose start is past
// the first row's verse can still select every row through a spanning reference.
test("bpt_draft: a range or id list that selects every live row of the chapter is refused as a whole chapter, preview and confirm", async () => {
  const { call, sqlite, jobs } = await fresh();
  // TIT 2 questions: 2:1-2, 2:2, 2:3. Verses 2-3 overlap all three.
  sqlite.prepare(`UPDATE tq_rows SET ref_raw = '2:1-2' WHERE id = 'q001'`).run();
  // TIT 3: one note on 3:4-5. Verse 5 overlaps it.
  sqlite.prepare(`INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, translation_state) VALUES ('s045', ?, 3, 4, '3:4-5', 'n', 10, 1, 'validated')`).run(BOOK);
  await withBot(async (calls) => {
    for (const args of [
      { book: BOOK, kind: "tq", chapter: 2, verse_start: 2, verse_end: 3 },
      { book: BOOK, kind: "tn", chapter: 3, verse_start: 5 },
    ]) {
      const r = await call("bpt_draft", args);
      assert.equal(r.isError, true, JSON.stringify([args, r.data]));
      assert.match(r.data.error, /whole chapter/);
    }
    // A note marked Not needed is no reason to call the rest a part of the
    // chapter: verses 2-6 select every live verse note once t001 is trashed,
    // and so do ids naming every live note.
    sqlite.prepare(`UPDATE tn_rows SET trashed_at = 100 WHERE id = 't001'`).run();
    const range = { book: BOOK, kind: "tn", chapter: 1, verse_start: 2, verse_end: 6 };
    assert.match((await call("bpt_draft", range)).data.error, /whole chapter/);
    const idsArgs = { book: BOOK, kind: "tn", chapter: 1, ids: ["in01", "t002", "t003", "t004", "t005", "t006"] };
    assert.match((await call("bpt_draft", idsArgs)).data.error, /whole chapter/);
    // The confirm checks it too: a token from before the trash no longer starts.
    sqlite.prepare(`UPDATE tn_rows SET trashed_at = NULL WHERE id = 't001'`).run();
    const p = await call("bpt_draft", range);
    assert.equal(p.isError, false, JSON.stringify(p.data));
    sqlite.prepare(`UPDATE tn_rows SET trashed_at = 100 WHERE id = 't001'`).run();
    const c = await call("bpt_draft", { ...range, confirm_token: p.data.confirm_token });
    assert.equal(c.isError, true, JSON.stringify(c.data));
    assert.match(c.data.error, /whole chapter/);
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});

test("bpt_draft confirm: a repeated id is sent once, in order", async () => {
  const { call, jobs } = await fresh();
  await withBot(async (calls) => {
    const args = { book: BOOK, kind: "tn", chapter: 1, ids: ["t003", "t002", "t003"] };
    const p = await call("bpt_draft", args);
    assert.equal(p.data.will_redraft, 2, JSON.stringify(p.data));
    const r = await call("bpt_draft", { ...args, confirm_token: p.data.confirm_token });
    assert.equal(r.data.status, "running", JSON.stringify(r.data));
    assert.deepEqual(JSON.parse(jobs()[0].options_json).rowIds, ["t002", "t003"]);
    assert.deepEqual(calls.find((x) => x.url.endsWith("/api/pipeline/start")).body.options.rowIds, ["t002", "t003"]);
  });
});

test("chatConfirmMac signs each tool under its own prefix, and bpt_bulk_set_state's prefix is unchanged", async () => {
  const env = { JWT_SIGNING_KEY: "test-signing-key" };
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.JWT_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hmac = async (s) => Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(s))).toString("base64url");
  const bulk = await chatConfirmMac(env, "body", "bpt_bulk_set_state");
  const draft = await chatConfirmMac(env, "body", "bpt_draft");
  assert.notEqual(bulk, draft);
  assert.equal(bulk, await hmac("bpt_bulk_set_state:v1\nbody"), "tokens issued before #747 still verify");
  assert.equal(draft, await hmac("bpt_draft:v1\nbody"));
});

test("bpt_draft: with no signing key the preview is refused and nothing starts", async () => {
  const { call, jobs } = await fresh({ signingKey: false });
  await withBot(async (calls) => {
    const r = await call("bpt_draft", DRAFT);
    assert.equal(r.isError, true, JSON.stringify(r.data));
    assert.match(r.data.error, /not set up on this server/);
    assert.match(r.data.error, /Nothing was started/);
    assert.equal(calls.length, 0);
    assert.equal(jobs().length, 0);
  });
});
