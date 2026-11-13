// TranslateWorkflow.run() executed by a REAL Workflows engine.
//
// Everything else about the internal runner is covered by unit tests over the
// step bodies (translate/workflowSteps.test.mjs). The one thing those cannot
// touch is run() itself: `step.do`, its retry policy, the workspace re-point on
// `this.env`, and the engine's NonRetryableError check are runtime behaviour.
// A hand-written `step` double would only re-assert what we already believe.
//
// So this suite boots workerd (miniflare) with the real `cloudflare:workflows`
// engine, the real D1 (every migration applied), the real R2, and the real
// TranslateWorkflow class, and drives it through `env.TRANSLATE_WORKFLOW
// .create()` — see translate/workflowHarness.mjs. Nothing inside the Worker is
// stubbed. The only fakes are outside it: miniflare's `outboundService` serves
// every fetch the Worker makes, so the DCS endpoints and the Anthropic Messages
// API are in-process and the suite touches no network — while the real
// @anthropic-ai/sdk streaming client, SSE parse and all, runs inside workerd.
//
// The five things this proves, none of which source inspection can:
//   1. A whole run succeeds: guard-and-source → context → 11 batch steps →
//      merge-report, with the recorded OBA dry run replayed as the model's
//      replies, produces the recorded tn_OBA.tsv byte for byte; wf_status_json
//      lands `done`; pipeline_jobs.state / output_json are never written.
//   2. The re-point re-points: a run for workspace A reads A's provider key and
//      writes A's D1 row and A's R2 prefix, with a second, differently-seeded
//      tenant present. A missing / unknown workspace refuses without modifying
//      one column of EITHER tenant's row — job ids collide across tenant
//      databases, so recording that refusal was itself a cross-tenant write.
//   3. Non-retryability is real: a deterministic provider failure runs the batch
//      step ONCE (one billed call); a checks failure runs it once (two calls —
//      the in-step draft+repair loop, not a step retry); a transient failure is
//      retried by the engine and the run completes. This is the regression test
//      for `new NonRetryableError(msg, kind)`, which set `.name` to the kind and
//      so defeated the engine's own fatality check.
//   4. Idempotency, and its cost-shaped twin: an instance whose batch output is
//      already in R2 makes zero model calls; a step retry that follows a billed
//      draft resumes from that draft rather than buying it again, and still
//      bills the org for it; and an R2 refusal of a paid batch's output is
//      retried against the engine's own persisted step return, not the provider.
//   5. No decrypted key in anything the runtime persists — step returns,
//      instance output/error, wf_status_json, the D1 row, R2, or the engine's
//      own on-disk instance state.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/workflowEngine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FAIL_PUTS_KEY, anthropicErrorResponse, anthropicStreamResponse, r2Keys, r2Text, startEngine } from "./workflowHarness.mjs";
import { fixture, fixturePackFiles } from "./fixtures.mjs";
import { batchNn } from "./storage.ts";
import { BEGIN_OUTPUT, END_OUTPUT } from "./llm.ts";
import { encryptApiKey } from "../aiKeyCrypto.ts";

const DRY = "dry-run-ar-OBA/";
const WRAP = Buffer.alloc(32, 7).toString("base64");
// Two tenants, two different keys: which key reaches the provider is the proof
// of which D1 the re-pointed env actually read.
const KEY_A = "sk-ant-api03-WORKSPACEAAAAAAAAAAAAAAAAAAAA0001";
const KEY_B = "sk-ant-api03-WORKSPACEBBBBBBBBBBBBBBBBBBBB0002";
const MODEL = "claude-sonnet-5";
const JOB = "job-1";

const WORKSPACES = JSON.stringify([
  { slug: "bsoj", label: "BSOJ", org: "BSOJ", binding: "DB" },
  { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
]);

const PARAMS = Object.freeze({
  jobId: JOB, workspace: "bsoj", userId: 1,
  resourceType: "tn", book: "OBA", startChapter: 1, endChapter: 1,
  targetLang: "ar", direction: "rtl",
  sourceRef: "unfoldingWord/en_tn@master",
  sourceLiteralRef: "unfoldingWord/en_ult@master", sourceSimplifiedRef: "unfoldingWord/en_ust@master",
  targetOrg: "ar_gl", repoName: "ar_tn",
  provider: "claude", model: MODEL, thinking: "medium",
});

// A one-batch slice of the same job (OBA 1:1 = 14 rows), so the retry, failure
// and idempotency proofs cost one provider call instead of eleven. A verse
// selection resolves to mergeMode "by-id", which requires an existing target
// book — so every scenario built on SMALL serves one (ARABIC_BOOK below).
const SMALL = Object.freeze({ ...PARAMS, verseStart: 1, verseEnd: 1 });

// --- recorded dry run ------------------------------------------------------

/** Every recorded Arabic row of the OBA dry run, by ID, plus the TSV header. */
const RECORDED = (() => {
  const rows = new Map();
  let header = "";
  for (let i = 0; i < 11; i++) {
    const lines = fixture(`${DRY}work/batch-${batchNn(i)}-out.tsv`).split("\n");
    header = lines[0];
    for (const line of lines.slice(1)) if (line) rows.set(line.split("\t")[1], line);
  }
  return { header, rows };
})();

const wrapped = (body) => `Here you go.\n\n${BEGIN_OUTPUT}\n${body}\n${END_OUTPUT}\n`;

/** Row IDs of the source TSV the prompt inlines, in source order. */
function promptRowIds(user) {
  const src = /-----BEGIN SOURCE CONTENT-----\n([\s\S]*?)\n-----END SOURCE CONTENT-----/.exec(user);
  assert.ok(src, "prompt must inline the source TSV");
  return src[1].split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]);
}

/** The recorded reply for exactly the rows this prompt asked about. */
function recordedReply(user, { drop = 0 } = {}) {
  const ids = promptRowIds(user);
  const kept = drop > 0 ? ids.slice(0, ids.length - drop) : ids;
  const body = kept.map((id) => {
    const row = RECORDED.rows.get(id);
    assert.ok(row, `recorded row for ${id}`);
    return row;
  }).join("\n");
  return wrapped(`${RECORDED.header}\n${body}`);
}

const MIB = 1024 * 1024;

// A padding unit for an oversized output: one space plus four Arabic letters.
// Deliberately harmless to every deterministic check — no tab or newline, no
// rc:// link, no digit, never two spaces in a row — so the inflated output
// VALIDATES and reaches the step return exactly as a normal one would.
const PAD_UNIT = " كلمة";

/** The recorded reply for this prompt, with every Note inflated by `units` pads. */
function inflatedReply(user, units) {
  const pad = PAD_UNIT.repeat(units);
  return recordedReply(user).split("\n").map((line) => {
    if (!line.includes("\t") || line.startsWith("Reference\t")) return line;
    const cells = line.split("\t");
    cells[cells.length - 1] += pad;
    return cells.join("\t");
  }).join("\n");
}

// --- outbound (DCS + Anthropic), the only fakes, and both outside the Worker -

/** The recorded Arabic tn_OBA.tsv, used as the already-published target book. */
const ARABIC_BOOK = fixture(`${DRY}tn_OBA.tsv`);

function dcsFiles({ withTarget = null } = {}) {
  const files = { "unfoldingWord/en_tn/tn_OBA.tsv": fixture("tn_OBA.tsv") };
  for (const [p, body] of Object.entries(fixturePackFiles())) files[`ar_gl/translation-context/${p}`] = body;
  if (withTarget != null) files["ar_gl/ar_tn/tn_OBA.tsv"] = withTarget;
  return files;
}

/** Returned by a `dcs` hook to make that fetch fail with a 500 (a retryable transport error). */
const DCS_500 = Symbol("dcs-500");

/**
 * Serves every fetch the Worker makes. `reply(ctx)` decides the Anthropic
 * response; `dcs(key, files)` may override a DCS lookup (string = 200, null =
 * 404, DCS_500 = 500). Anything not DCS and not Anthropic is refused loudly,
 * which is how the suite knows it is not silently reaching the network.
 */
function outbound({ files, reply, dcs }) {
  const state = { modelCalls: 0, apiKeys: [], models: [], dcs: [], blocked: [] };
  const handler = async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "api.anthropic.com") {
      state.modelCalls += 1;
      const apiKey = request.headers.get("x-api-key");
      state.apiKeys.push(apiKey);
      const body = JSON.parse(await request.text());
      state.models.push(body.model);
      return reply({ n: state.modelCalls, apiKey, body, user: body.messages[0].content, system: body.system });
    }
    if (url.hostname === "git.door43.org") {
      state.dcs.push(url.pathname);
      const m = /^\/([^/]+)\/([^/]+)\/raw\/(?:branch|commit)\/[^/]+\/(.+)$/.exec(url.pathname);
      if (m) {
        const key = `${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`;
        const body = dcs ? dcs(key, files) : files[key] ?? null;
        if (body === DCS_500) return new Response("", { status: 500 });
        if (body != null) return new Response(body, { status: 200 });
      }
      return new Response("", { status: 404 });
    }
    state.blocked.push(url.href);
    return new Response("outbound blocked by the harness", { status: 599 });
  };
  return { state, handler };
}

// --- tenants ---------------------------------------------------------------

async function seedTenant(d1, { jobId = JOB, state = "running", provider = "claude", model = MODEL, key }) {
  await d1.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  await d1.prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, runner, upstream_job_id)
     VALUES (?1, 1, 'translate', 'OBA', 1, 1, 'sess', ?2, 'internal', ?3)`,
  ).bind(jobId, state, `translate-x-${jobId}`).run();
  const { ciphertextB64, ivB64 } = await encryptApiKey(WRAP, key);
  await d1.prepare(
    `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version) VALUES (1, ?1, ?2, ?3, ?4, ?5, 1)`,
  ).bind(provider, model, ciphertextB64, ivB64, key.slice(-4)).run();
}

/**
 * One engine + two populated tenants. Fresh per test: workerd boot plus 2 × 76
 * migrations is about a second, and shared D1 state between proofs would make
 * every assertion order-dependent.
 */
async function scenario({ files = dcsFiles({ withTarget: ARABIC_BOOK }), reply, dcs, tenantA = {}, tenantB = {}, persist = false, failPutsSuffix } = {}) {
  const out = outbound({ files, reply, dcs });
  const persistDir = persist ? mkdtempSync(join(tmpdir(), "bem-wf-")) : undefined;
  const engine = await startEngine({
    d1: { DB: "tenant-a", DB_ORG2: "tenant-b" },
    r2: ["BLOBS"],
    vars: { WORKSPACES, AI_KEY_WRAPPING_KEY: WRAP },
    outbound: out.handler,
    persistDir,
    ...(failPutsSuffix ? { failPutsSuffix } : {}),
  });
  await seedTenant(await engine.d1("DB"), { key: KEY_A, ...tenantA });
  await seedTenant(await engine.d1("DB_ORG2"), { key: KEY_B, ...tenantB });
  return { engine, out, persistDir, state: out.state };
}

const jobRow = async (engine, binding, jobId = JOB) =>
  (await engine.d1(binding)).prepare(`SELECT * FROM pipeline_jobs WHERE job_id = ?1`).bind(jobId).first();

const wfStatus = async (engine, binding, jobId = JOB) => {
  const row = await jobRow(engine, binding, jobId);
  return row?.wf_status_json ? JSON.parse(row.wf_status_json) : null;
};

/** Every byte the engine persisted on disk, as one string per file. */
function persistedBlobs(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p, "latin1"));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Proof 1 — a whole run, under the engine
// ---------------------------------------------------------------------------

test("engine: a whole run reproduces the recorded OBA dry run and never writes state/output_json", async (t) => {
  // No target book on DCS: the run covers the whole book, so the range merge is
  // allowed to create it — the same shape as the recorded dry run.
  const s = await scenario({ files: dcsFiles(), reply: ({ user, apiKey, body }) => {
    assert.equal(apiKey, KEY_A, "the key the Workflow decrypted from tenant A reaches the provider");
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, true, "the adapter streams (non-streaming rejects long max_tokens)");
    assert.match(user, /"batchFile": "batch-\d\d\.tsv"/, "prompt inlines the task JSON");
    return anthropicStreamResponse({ text: recordedReply(user), model: MODEL });
  } });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run(`translate-bsoj-${JOB}`, PARAMS);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.deepEqual(status.output, {
    jobId: JOB, workspace: "bsoj", batchCount: 11, rowCount: 153,
    bookFile: "tn_OBA.tsv", reportFile: "translate-report-1-1.json",
    calls: 11, costUsd: status.output.costUsd,
  });
  assert.ok(status.output.costUsd > 0, "the report prices the run");
  assert.equal(s.state.modelCalls, 11, "one billed call per batch, no step re-runs");
  assert.deepEqual(s.state.blocked, [], "no fetch left the harness");

  // The engine really ran 14 steps, in order, each with its own persisted return.
  const bucket = await s.engine.r2();
  const keys = await r2Keys(bucket);
  for (let i = 0; i < 11; i++) {
    const nn = batchNn(i);
    assert.equal(await r2Text(bucket, `pipeline-output/bsoj/job-1/work/batch-${nn}.tsv`), fixture(`${DRY}work/batch-${nn}.tsv`), `work/batch-${nn}.tsv byte-identical to the bot's`);
    assert.equal(await r2Text(bucket, `pipeline-output/bsoj/job-1/work/batch-${nn}-out.tsv`), fixture(`${DRY}work/batch-${nn}-out.tsv`), `work/batch-${nn}-out.tsv persisted as returned`);
    assert.ok(keys.includes(`pipeline-output/bsoj/job-1/work/batch-${nn}-pack.md`));
    assert.ok(keys.includes(`pipeline-output/bsoj/job-1/work/batch-${nn}-task.json`));
  }
  assert.equal(
    await r2Text(bucket, "pipeline-output/bsoj/job-1/out/tn_OBA.tsv"),
    fixture(`${DRY}tn_OBA.tsv`),
    "merged out/ book byte-identical to the recorded dry run",
  );
  const report = JSON.parse(await r2Text(bucket, "pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.generatedBy, "bible-editor/translate");
  assert.equal(report.llm.calls, 11);
  assert.equal(report.checks.ok, true);

  const wf = await wfStatus(s.engine, "DB");
  assert.equal(wf.state, "done");
  assert.deepEqual(wf.output, [
    { delivery: "editor", type: "tn", repo: "ar_gl/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
    { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
  ]);

  // The D1 ownership contract, now asserted against what the engine actually wrote.
  const row = await jobRow(s.engine, "DB");
  assert.equal(row.state, "running", "the Workflow never writes pipeline_jobs.state");
  assert.equal(row.output_json, null, "the Workflow never writes output_json");
  assert.equal(row.current_skill, "translate-tn");
  assert.equal(row.current_status, "done", "merge-report's done status is the last thing written");
});

// ---------------------------------------------------------------------------
// Proof 2 — the workspace re-point
// ---------------------------------------------------------------------------

test("engine: a run for workspace B reads B's key, writes B's D1 and B's R2 prefix only", async (t) => {
  const s = await scenario({ reply: ({ user, apiKey }) => {
    assert.equal(apiKey, KEY_B, "the re-pointed env decrypted tenant B's key, not the default binding's");
    return anthropicStreamResponse({ text: recordedReply(user), model: MODEL });
  } });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-org2-job-1", { ...SMALL, workspace: "org2" });
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(status.output.workspace, "org2");
  assert.equal(s.state.modelCalls, 1);
  assert.deepEqual([...new Set(s.state.apiKeys)], [KEY_B]);

  // D1: only tenant B learned anything.
  const b = await wfStatus(s.engine, "DB_ORG2");
  assert.equal(b.state, "done");
  assert.equal(await wfStatus(s.engine, "DB"), null, "tenant A's row was never written");
  assert.equal((await jobRow(s.engine, "DB")).current_status, null, "tenant A's row has no progress either");

  // R2 is one bucket shared by every tenant; the slug prefix is the isolation.
  const keys = await r2Keys(await s.engine.r2());
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((k) => !k.startsWith("pipeline-output/org2/")), [], "every key written is under B's prefix");
});

test("engine: a missing or unknown workspace refuses without touching ANY tenant's row", async (t) => {
  const s = await scenario({ reply: () => { throw new Error("the model must never be called"); } });
  t.after(() => s.engine.dispose());

  const { workspace, ...noWorkspace } = SMALL;
  assert.equal(workspace, "bsoj");

  // Both tenants hold a row for THIS job id, and that collision is the point:
  // status.writeWfStatus is an UPDATE keyed by job_id alone, so a refusal
  // recorded against the still-raw default binding lands on whichever org owns
  // that id there. run() used to build deps before the resolve precisely so a
  // refusal could be recorded — which made every refusal a cross-tenant write.
  const before = { DB: await jobRow(s.engine, "DB"), DB_ORG2: await jobRow(s.engine, "DB_ORG2") };

  const missing = await s.engine.run("translate-missing-ws", noWorkspace);
  assert.equal(missing.status, "errored");
  const unknown = await s.engine.run("translate-unknown-ws", { ...SMALL, workspace: "retired-org" });
  assert.equal(unknown.status, "errored");

  // Measured, and the reason run() logs the refusal: the engine reports a
  // NonRetryableError thrown out of run() as a generic WorkflowFatalError and
  // DROPS the message, so the instance error does not name the kind. With no
  // row to write it to either, console.error is the only channel left — hence
  // the log line in translateWorkflow.ts carrying jobId, slug and kind.
  for (const status of [missing, unknown]) {
    assert.equal(status.error?.name, "WorkflowFatalError");
    assert.doesNotMatch(JSON.stringify(status.error), /workspace_(missing|unknown)/,
      "if the engine ever starts propagating the message, say so here instead of relying on the log");
  }

  // THE regression assertion: not one column of either row moved — not
  // wf_status_json, not current_skill / current_status, not even updated_at.
  // The refusal is loud in the instance and silent in every database, and the
  // row is left to pipelines.ts's poll-count / 48h sweeps.
  for (const binding of ["DB", "DB_ORG2"]) {
    assert.deepEqual(await jobRow(s.engine, binding), before[binding], `${binding}: a refusal modified a tenant row`);
  }

  // And nothing else was touched either — org2's D1 is the one resolveWorkspace()
  // would have handed back for an unknown slug if the guard were not there.
  assert.equal(s.state.modelCalls, 0);
  assert.deepEqual(await r2Keys(await s.engine.r2()), []);
});

// ---------------------------------------------------------------------------
// Proof 3 — non-retryability, for real
// ---------------------------------------------------------------------------

test("engine: a deterministic provider failure runs the batch step exactly once", async (t) => {
  const s = await scenario({ reply: () => anthropicErrorResponse(401, "authentication_error", "invalid x-api-key") });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-invalid-key", SMALL);
  assert.equal(status.status, "errored");
  // THE regression assertion. The batch step is configured retries.limit 2, so
  // a NonRetryableError the engine does not recognise gives 3 calls, not 1 —
  // which is exactly what `new NonRetryableError(msg, kind)` used to produce.
  assert.equal(s.state.modelCalls, 1, "invalid_key must cost exactly one billed call");

  const wf = await wfStatus(s.engine, "DB");
  assert.equal(wf.state, "failed");
  // The kind has to survive the engine's isolate hop, which rebuilds the error
  // as `${name}: ${message}` — before classifyStepError learned to look past
  // that prefix, every catch-all failure was filed as `internal_error`.
  assert.equal(wf.current.errorKind, "invalid_key");
  assert.doesNotMatch(wf.current.error, /^[A-Za-z]*Error:/, "the engine's name prefix is stripped from the recorded message");
});

test("engine: a persistent checks failure costs the in-step repair pass only, never a step retry", async (t) => {
  const s = await scenario({ reply: ({ user }) =>
    // Drop one row every time: `missing-row` is an error-severity check, so
    // both the draft and the repair pass fail and runBatch gives up.
    anthropicStreamResponse({ text: recordedReply(user, { drop: 1 }), model: MODEL }) });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-checks", SMALL);
  assert.equal(status.status, "errored");
  assert.equal(s.state.modelCalls, 2, "draft + repair inside ONE step attempt (a step retry would give 4 or 6)");

  const wf = await wfStatus(s.engine, "DB");
  assert.equal(wf.state, "failed");
  assert.equal(wf.current.errorKind, "checks_failed");
  assert.deepEqual(await r2Keys(await s.engine.r2()).then((k) => k.filter((x) => x.includes("-out.tsv"))), [],
    "a failing batch persists no output, so a re-run cannot reuse it");
});

test("engine: a transient DCS failure is retried by the engine and the run completes", async (t) => {
  // guard-and-source carries the infra retry policy (3 × 5s exponential), so
  // two failures and a success is the cheapest honest exercise of a retry.
  let sourceHits = 0;
  const s = await scenario({
    dcs: (key, files) => {
      if (key !== "unfoldingWord/en_tn/tn_OBA.tsv") return files[key] ?? null;
      sourceHits += 1;
      return sourceHits <= 2 ? DCS_500 : files[key];
    },
    reply: ({ user }) => anthropicStreamResponse({ text: recordedReply(user), model: MODEL }),
  });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-flaky-source", SMALL);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.ok(sourceHits >= 3, `the engine re-ran guard-and-source (source fetched ${sourceHits}×)`);
  assert.equal(s.state.modelCalls, 1, "the retried step is the failing one; batches still cost one call");
});

test("engine: a transient provider failure is retried by the batch step and the run completes", async (t) => {
  const s = await scenario({ reply: ({ n, user }) =>
    (n === 1
      ? anthropicErrorResponse(429, "rate_limit_error", "slow down")
      : anthropicStreamResponse({ text: recordedReply(user), model: MODEL })) });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-rate-limited", SMALL);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(s.state.modelCalls, 2, "rate_limited is retryable: the engine re-ran the batch step");
  assert.equal((await wfStatus(s.engine, "DB")).state, "done");
});

test("engine: a transient failure after a billed draft resumes from the draft instead of re-drafting", async (t) => {
  // The double-spend window review finding: runBatch bills a draft, the draft
  // fails checks, and the repair call then dies on a provider transient. The
  // step is retryable (correctly — a 429 recovers), so the engine re-runs it;
  // without a durable draft that re-run buys the draft a SECOND time.
  const s = await scenario({ reply: ({ n, user }) => {
    if (n === 1) return anthropicStreamResponse({ text: recordedReply(user, { drop: 1 }), model: MODEL });
    if (n === 2) return anthropicErrorResponse(429, "rate_limit_error", "slow down");
    return anthropicStreamResponse({ text: recordedReply(user), model: MODEL });
  } });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-draft-resume", SMALL);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  // THE regression assertion: 3, not 4. The retried step entered at the repair
  // pass with the stored draft, so it bought one call instead of two. (3 HTTP
  // requests, of which 2 are completions the org was billed for and 1 is the
  // 429 that produced nothing.)
  assert.equal(s.state.modelCalls, 3, "the step retry must not re-buy the draft it already paid for");

  const bucket = await s.engine.r2();
  const keys = await r2Keys(bucket);
  assert.ok(keys.includes("pipeline-output/bsoj/job-1/work/batch-01-draft.json"),
    "the billed draft was persisted BEFORE the repair call, which is what made the resume possible");
  assert.ok(keys.includes("pipeline-output/bsoj/job-1/work/batch-01-out.tsv"));
  assert.equal((await wfStatus(s.engine, "DB")).state, "done");

  // …and the org is billed for BOTH completions. The isolate that bought the
  // draft died; the charge did not die with it. Before this was carried across
  // the resume the report showed the repair pass alone, so a run the org paid
  // twice for reported once — and the report is the only bill they see.
  //
  // The price is IN the draft object, not beside it: R2 is atomic per object
  // and atomic across none, so a text/price pair could land half of itself.
  assert.deepEqual(keys.filter((k) => k.includes("-draft")), ["pipeline-output/bsoj/job-1/work/batch-01-draft.json"],
    "one object holds the draft and its price; there is no second key to lose");
  const draft = JSON.parse(await r2Text(bucket, "pipeline-output/bsoj/job-1/work/batch-01-draft.json"));
  assert.deepEqual(draft.calls?.map((c) => c.usage), [{ inputTokens: 5000, outputTokens: 3000 }]);
  assert.ok(draft.output.includes("\t"), "and the draft TSV the resume reads back rides in it");
  assert.equal(status.output.calls, 2, "the run's result counts the paid-for draft as well as the repair pass");
  const report = JSON.parse(await r2Text(bucket, "pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.llm.calls, 2, "and so does the report the org reads");
  assert.equal(report.llm.inputTokens, 10000, "every billed input token, across both isolates");
  assert.equal(report.llm.outputTokens, 6000);
  assert.ok(report.llm.estimatedCostUsd > 0);
  assert.equal(status.output.costUsd, report.llm.estimatedCostUsd);
});

test("engine: one R2 refusal while storing a billed draft cannot separate it from its price", async (t) => {
  // The draft is written mid-step, so the step's own retries cannot cover it —
  // persistBilled's in-step retries are all it has. When the price lived in a
  // separate best-effort put, one refusal there landed the draft without its
  // ledger, and the resumed batch billed the repair pass alone. One object
  // means one put, so the refusal is either absorbed or loses the whole draft.
  const s = await scenario({
    failPutsSuffix: "-draft.json",
    reply: ({ n, user }) => {
      if (n === 1) return anthropicStreamResponse({ text: recordedReply(user, { drop: 1 }), model: MODEL });
      if (n === 2) return anthropicErrorResponse(429, "rate_limit_error", "slow down");
      return anthropicStreamResponse({ text: recordedReply(user), model: MODEL });
    },
  });
  t.after(() => s.engine.dispose());

  // One refusal: enough to have destroyed the sidecar, not enough to exhaust
  // persistBilled's budget of three.
  const bucket = await s.engine.r2();
  await bucket.put(FAIL_PUTS_KEY, "1");

  const status = await s.engine.run("translate-bsoj-draft-put-refused", SMALL, { binding: "FLAKY_R2_WORKFLOW" });
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(await bucket.head(FAIL_PUTS_KEY), null, "the injected R2 refusal really fired");
  assert.equal(s.state.modelCalls, 3, "the step retry still resumed from the draft rather than re-drafting");

  const draft = JSON.parse(await r2Text(bucket, "pipeline-output/bsoj/job-1/work/batch-01-draft.json"));
  assert.deepEqual(draft.calls?.map((c) => c.usage), [{ inputTokens: 5000, outputTokens: 3000 }],
    "the ledger survived the refusal in the same object as the draft it belongs to");

  // THE assertion: the bill the org reads is the whole bill, refusal or not.
  assert.equal(status.output.calls, 2);
  const report = JSON.parse(await r2Text(bucket, "pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.llm.calls, 2, "both completions, after an R2 refusal in the middle of recording one");
  assert.equal(report.llm.inputTokens, 10000);
});

test("engine: an output too large for a step return is persisted inside the paying step, and bought once", async (t) => {
  // Cloudflare refuses to persist a non-stream step result over 1 MiB. batch-NN
  // returns its output, so an unbounded return is a step that cannot commit —
  // the engine retries it, and the retry re-buys the batch. Nothing bounded the
  // output: batches are capped by rows and source characters, and the
  // deterministic checks tolerate arbitrary growth in a translated column.
  const s = await scenario({ reply: ({ user }) =>
    anthropicStreamResponse({ text: inflatedReply(user, 9000), model: MODEL }) });
  t.after(() => s.engine.dispose());

  const status = await s.engine.run("translate-bsoj-oversized", SMALL);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(s.state.modelCalls, 1, "an oversized batch must never cause a second paid call");

  const bucket = await s.engine.r2();
  const out = await r2Text(bucket, "pipeline-output/bsoj/job-1/work/batch-01-out.tsv");
  assert.ok(Buffer.byteLength(out, "utf8") > MIB, `the output really is oversized (${Buffer.byteLength(out, "utf8")} bytes)`);

  // THE assertion, against what the engine itself persisted: every step return
  // of this run, together, is smaller than the cap ONE of them would have blown.
  const returns = Buffer.byteLength(JSON.stringify(status.__LOCAL_DEV_STEP_OUTPUTS ?? null), "utf8");
  assert.ok(returns > 2, "the engine really recorded per-step returns");
  assert.ok(returns < MIB, `no step return may approach the 1 MiB cap (all of them together were ${returns} bytes)`);
  assert.equal((await wfStatus(s.engine, "DB")).state, "done");
});

test("engine: an R2 refusal after a billed batch is retried, and replays the output instead of re-buying it", async (t) => {
  // Finding B. The provider call is made in batch-NN, which RETURNS the output;
  // batch-NN-persist writes it. Cloudflare persists a step's return before the
  // next step runs, so the paid output is already durable when the write is
  // attempted — and the write is therefore allowed to be retryable. Done inside
  // one step, this same R2 failure could only be answered by paying again or by
  // failing the batch.
  const s = await scenario({ reply: ({ user }) => anthropicStreamResponse({ text: recordedReply(user), model: MODEL }) });
  t.after(() => s.engine.dispose());

  // THREE refusals, deliberately: the previous shape retried the put three
  // times INSIDE the paying step, so a single refusal would be absorbed there
  // and would not tell the two designs apart. Three exhausts that budget and
  // lands on the step's own retries — where the old shape had already given up
  // non-retryably (output_persist_failed) and this one has not.
  const bucket = await s.engine.r2();
  await bucket.put(FAIL_PUTS_KEY, "3");

  const status = await s.engine.run("translate-bsoj-r2-refuses", SMALL, { binding: "FLAKY_R2_WORKFLOW" });
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(await bucket.head(FAIL_PUTS_KEY), null, "all three injected R2 failures really fired");

  // THE assertion: one provider call, for a run whose durable write failed.
  assert.equal(s.state.modelCalls, 1, "the persist retry replayed the stored output; it must not re-buy the batch");
  assert.ok(await r2Text(bucket, "pipeline-output/bsoj/job-1/work/batch-01-out.tsv"), "and the output did land, on the retry");
  assert.equal(status.output.calls, 1);
  assert.equal((await wfStatus(s.engine, "DB")).state, "done");
});

// ---------------------------------------------------------------------------
// Proof 4 — idempotency
// ---------------------------------------------------------------------------

test("engine: a re-run whose batch output is already in R2 makes zero model calls", async (t) => {
  const s = await scenario({ reply: ({ user }) => anthropicStreamResponse({ text: recordedReply(user), model: MODEL }) });
  t.after(() => s.engine.dispose());

  const first = await s.engine.run("translate-bsoj-first", SMALL);
  assert.equal(first.status, "complete", `instance errored: ${JSON.stringify(first.error)}`);
  assert.equal(s.state.modelCalls, 1);

  const before = s.state.modelCalls;
  const again = await s.engine.run("translate-bsoj-rerun", SMALL);
  assert.equal(again.status, "complete", `instance errored: ${JSON.stringify(again.error)}`);
  assert.equal(s.state.modelCalls - before, 0, "the validated R2 output was reused, not re-bought");
  assert.equal(again.output.rowCount, first.output.rowCount);
  assert.equal(again.output.calls, 0, "the report records zero billed calls for the reused run");
});

// ---------------------------------------------------------------------------
// Proof 5 — the decrypted key never reaches anything persisted
// ---------------------------------------------------------------------------

test("engine: the decrypted key appears in nothing the runtime persists, even when the provider echoes it", async (t) => {
  // Deliberately NOT an `sk-ant-…` string: the pattern redactor would scrub that
  // shape on its own, which would hide a failure of the literal-key scrub
  // (llm.scrubSecrets with the batch's own key). This one only that can remove.
  const SCRUB_KEY = "provider-live-credential-DO-NOT-LEAK-0001";
  const s = await scenario({
    persist: true,
    tenantA: { key: SCRUB_KEY },
    // The provider echoes the key back in an error body — the case that made
    // sanitizeBatchError rebuild the error instead of editing its message.
    reply: ({ n, user, apiKey }) =>
      (n === 1
        ? anthropicStreamResponse({ text: recordedReply(user), model: MODEL })
        : anthropicErrorResponse(400, "invalid_request_error", `bad request for key ${apiKey}`)),
  });
  t.after(() => s.engine.dispose());

  const ok = await s.engine.run("translate-bsoj-keyscan-ok", SMALL);
  assert.equal(ok.status, "complete", `instance errored: ${JSON.stringify(ok.error)}`);

  // Second job id → fresh R2 prefix → no reuse → the echoing error path runs.
  await (await s.engine.d1("DB")).prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, runner)
     VALUES ('job-2', 1, 'translate', 'OBA', 1, 1, 'sess', 'running', 'internal')`,
  ).run();
  const bad = await s.engine.run("translate-bsoj-keyscan-echo", { ...SMALL, jobId: "job-2" });
  assert.equal(bad.status, "errored");
  const failed = await wfStatus(s.engine, "DB", "job-2");
  assert.equal(failed.state, "failed");
  assert.ok(failed.current.error.length > 0, "the failure still says something useful");

  const surfaces = [];
  for (const status of [ok, bad]) surfaces.push(JSON.stringify(status));
  for (const jobId of [JOB, "job-2"]) surfaces.push(JSON.stringify(await jobRow(s.engine, "DB", jobId)));
  const bucket = await s.engine.r2();
  for (const key of await r2Keys(bucket)) {
    surfaces.push(key);
    surfaces.push(await r2Text(bucket, key));
  }
  for (const [i, text] of surfaces.entries()) {
    assert.ok(!text.includes(SCRUB_KEY), `surface ${i} leaks the decrypted key`);
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{16,}/.test(text), `surface ${i} leaks an anthropic-shaped key`);
  }
  // The error that carried the key is still informative once scrubbed.
  assert.match(failed.current.error, /provider_error/);
  // Step returns are persisted by the engine and handed back verbatim here.
  assert.ok(JSON.stringify(ok.__LOCAL_DEV_STEP_OUTPUTS).length > 2, "the engine really recorded per-step returns");

  // And the engine's own on-disk instance state (params, step outputs, errors).
  await s.engine.dispose();
  const blobs = persistedBlobs(s.persistDir);
  assert.ok(blobs.length > 0, "the engine really wrote instance state to disk");
  for (const blob of blobs) {
    assert.ok(!blob.includes(SCRUB_KEY), "the engine persisted the decrypted key to disk");
  }
});

// ---------------------------------------------------------------------------
// Proof 6 — a whole-chapter run does not buy approved rows (#895)
// ---------------------------------------------------------------------------

const SOURCE_IDS = fixture("tn_OBA.tsv").split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]);

async function approveInD1(engine, ids) {
  const d1 = await engine.d1("DB");
  for (const id of ids) {
    await d1.prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, translation_state, version, updated_at)
       VALUES (?1, 'OBA', 1, 1, '1:1', 'معتمدة', 'validated', 1, 0)`,
    ).bind(id).run();
  }
}

test("engine (#895): approved rows are never in a prompt, and the merge is not refused for leaving them out", async (t) => {
  const prompted = [];
  const s = await scenario({ reply: ({ user }) => {
    prompted.push(...promptRowIds(user));
    return anthropicStreamResponse({ text: recordedReply(user), model: MODEL });
  } });
  t.after(() => s.engine.dispose());
  // 30 approved rows: past the shrink policy's floor against the 153-row base.
  const approved = SOURCE_IDS.slice(1, 31);
  await approveInD1(s.engine, approved);

  const status = await s.engine.run(`translate-bsoj-${JOB}`, PARAMS);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(status.output.rowCount, SOURCE_IDS.length - 30);
  assert.deepEqual(prompted.filter((id) => approved.includes(id)), [], "no approved row reached the provider");
  assert.equal(prompted.length, SOURCE_IDS.length - 30, "every other row did");
  assert.equal((await wfStatus(s.engine, "DB")).state, "done");
});

test("engine (#895): a fully approved chapter makes zero model calls and finishes done", async (t) => {
  const s = await scenario({ reply: () => { throw new Error("the provider must not be called"); } });
  t.after(() => s.engine.dispose());
  await approveInD1(s.engine, SOURCE_IDS);

  const status = await s.engine.run(`translate-bsoj-${JOB}`, PARAMS);
  assert.equal(status.status, "complete", `instance errored: ${JSON.stringify(status.error)}`);
  assert.equal(s.state.modelCalls, 0);
  assert.equal(status.output.batchCount, 0);
  assert.equal(status.output.rowCount, 0);
  assert.deepEqual(s.state.blocked, [], "no fetch left the harness");
  const wf = await wfStatus(s.engine, "DB");
  assert.equal(wf.state, "done");
  assert.equal(wf.output.length, 2, "the out/ book and report are delivered, so the import runs and lists the kept rows");
});
