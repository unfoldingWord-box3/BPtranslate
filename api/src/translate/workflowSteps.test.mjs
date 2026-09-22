// workflowSteps.ts: the TranslateWorkflow step bodies driven end to end with a
// real-SQLite D1 (every migration applied, incl. 0073), a Map-backed R2, a
// URL-keyed DCS fetch fake and a transport that replays the recorded OBA dry
// run. No Workflows runtime is invented — translateWorkflow.ts only maps these
// functions onto step.do (see translateWorkflowWorkspace.test.mjs for the env
// re-point it performs first).
//
// What this proves:
//   * guard-and-source → context → batch-01..11 → merge-report reproduces the
//     recorded tn_OBA.tsv byte-for-byte from the recorded model replies, writing
//     the design-§C R2 layout and a bot-shaped wf_status_json along the way,
//     while never touching pipeline_jobs.state / output_json;
//   * a batch whose validated output is already in R2 is reused without a
//     provider call (step-retry idempotency, design risk 4);
//   * cooperative cancel: a cancelled row fails step 1 and every batch step
//     non-retryably; ai_provider_changed / provider_not_supported_internal /
//     ai_provider_unavailable are non-retryable; provider transients stay
//     retryable;
//   * the decrypted key never appears in params, thrown messages, or the
//     wf_status_json written by record-failure — even when the provider echoes
//     it back (design risk 3).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/workflowSteps.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as steps from "./workflowSteps.ts";
import * as storage from "./storage.ts";
import { parseWfStatus } from "./status.ts";
import { BEGIN_OUTPUT, END_OUTPUT, TranslateProviderError } from "./llm.ts";
import { encryptApiKey } from "../aiKeyCrypto.ts";
import { FIXTURES, fixture, fixturePackFiles, memoryBlobStore } from "./fixtures.mjs";

const KEY = "sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEY0001";
const WRAP = Buffer.alloc(32, 7).toString("base64");
const DRY = "dry-run-ar-OBA/";
const WS = "bsoj";
const JOB = "job-1";

const PARAMS = Object.freeze({
  jobId: JOB, workspace: WS, userId: 1,
  resourceType: "tn", book: "OBA", startChapter: 1, endChapter: 1,
  targetLang: "ar", direction: "rtl",
  sourceRef: "unfoldingWord/en_tn@master",
  sourceLiteralRef: "unfoldingWord/en_ult@master", sourceSimplifiedRef: "unfoldingWord/en_ust@master",
  targetOrg: "ar_gl", repoName: "ar_tn",
  provider: "claude", model: "claude-sonnet-5", thinking: "medium",
});

// --- fakes -----------------------------------------------------------------

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async all() { return { results: sqlite.prepare(sql).all(...args), success: true }; },
    async first() { const r = sqlite.prepare(sql).all(...args); return r.length ? r[0] : null; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => mk(sql, []) };
}

async function freshSqlite({ provider = "claude", model = "claude-sonnet-5", state = "running" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, f), "utf8"));
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'translator')`).run();
  sqlite.prepare(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, runner, upstream_job_id)
     VALUES (?, 1, 'translate', 'OBA', 1, 1, 'sess', ?, 'internal', 'translate-bsoj-job-1')`,
  ).run(JOB, state);
  const { ciphertextB64, ivB64 } = await encryptApiKey(WRAP, KEY);
  sqlite.prepare(
    `INSERT INTO ai_provider_config (id, provider, model, key_ciphertext, key_iv, key_hint, version) VALUES (1, ?, ?, ?, ?, ?, 1)`,
  ).run(provider, model, ciphertextB64, ivB64, KEY.slice(-4));
  return sqlite;
}

/** DCS raw fake keyed by org/repo/path — so the target repo can 404 while the source serves. */
function dcsFetch(files) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const m = /^https:\/\/git\.door43\.org\/([^/]+)\/([^/]+)\/raw\/(?:branch|commit)\/[^/]+\/(.+)$/.exec(url);
    if (m) {
      const key = `${m[1]}/${m[2]}/${decodeURIComponent(m[3])}`;
      if (files[key] != null) return { status: 200, ok: true, headers: null, text: async () => files[key], json: async () => JSON.parse(files[key]) };
    }
    return { status: 404, ok: false, headers: null, text: async () => "" };
  };
  return { calls, impl };
}

function dcsFiles({ withTarget = null, source = null } = {}) {
  const files = { "unfoldingWord/en_tn/tn_OBA.tsv": source ?? fixture("tn_OBA.tsv") };
  for (const [p, body] of Object.entries(fixturePackFiles())) files[`ar_gl/translation-context/${p}`] = body;
  if (withTarget != null) files["ar_gl/ar_tn/tn_OBA.tsv"] = withTarget;
  return files;
}

const wrapped = (body) => `Here you go.\n\n${BEGIN_OUTPUT}\n${body}\n${END_OUTPUT}\n`;

/** Every recorded Arabic row of the OBA dry run, by ID, plus the TSV header. */
const RECORDED = (() => {
  const rows = new Map();
  let header = "";
  for (let i = 0; i < 11; i++) {
    const lines = fixture(`${DRY}work/batch-${storage.batchNn(i)}-out.tsv`).split("\n");
    header = lines[0];
    for (const line of lines.slice(1)) if (line) rows.set(line.split("\t")[1], line);
  }
  return { header, rows };
})();

/**
 * Replays the recorded model reply for exactly the rows the prompt's source
 * content carries (so whole batches AND by-id/verse subsets get the right rows,
 * in source order). Asserts the prompt shape and that the decrypted key arrived.
 */
function replayTransport() {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    assert.match(req.user, /"batchFile": "batch-\d\d\.tsv"/, "prompt must inline the task JSON with batchFile");
    assert.equal(req.apiKey, KEY, "the decrypted org key reaches the transport");
    assert.equal(req.model, "claude-sonnet-5");
    const src = /-----BEGIN SOURCE CONTENT-----\n([\s\S]*?)\n-----END SOURCE CONTENT-----/.exec(req.user);
    assert.ok(src, "prompt must inline the source TSV");
    const ids = src[1].split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]);
    const body = ids.map((id) => { const r = RECORDED.rows.get(id); assert.ok(r, `recorded row for ${id}`); return r; }).join("\n");
    return { text: wrapped(`${RECORDED.header}\n${body}`), usage: { inputTokens: 5000, outputTokens: 3000 }, stopReason: "end_turn" };
  };
  return { calls, transport };
}

async function scenario(opts = {}) {
  const sqlite = await freshSqlite(opts);
  const blobs = memoryBlobStore();
  const fetchFake = dcsFetch(dcsFiles(opts));
  const replay = replayTransport();
  const deps = {
    db: makeDb(sqlite), blobs, workspaceSlug: WS, wrappingKey: WRAP,
    startedAt: "2026-09-15T10:00:00.000Z", fetchImpl: fetchFake.impl,
    transport: opts.transport === null ? undefined : (opts.transport ?? replay.transport),
    now: () => new Date("2026-09-15T10:05:00.000Z"),
  };
  const row = () => sqlite.prepare(`SELECT * FROM pipeline_jobs WHERE job_id = ?`).get(JOB);
  const wf = () => parseWfStatus(row().wf_status_json);
  return { sqlite, blobs, deps, fetchFake, replay, row, wf };
}

const kindOf = (fn) => fn().then(() => { throw new Error("expected rejection"); }, (err) => steps.classifyStepError(err));

/**
 * The two steps the Workflow runs per batch, composed: batch-NN buys the output
 * and RETURNS it, batch-NN-persist writes it. Most proofs below care about the
 * pair, so they drive it through here; the ones that care about the seam drive
 * steps.batchTranslateStep / steps.batchPersistStep directly.
 */
async function batchStep(deps, params, index, batchCount) {
  const translated = await steps.batchTranslateStep(deps, params, index, batchCount);
  return steps.batchPersistStep(deps, params, translated);
}

// --- tests -------------------------------------------------------------------

test("params → TranslateParams: defaults, names, mergeMode and skill resolve as the bot would", () => {
  const p = steps.paramsToTranslateParams(PARAMS);
  assert.equal(p.skill, "translate-tn");
  assert.equal(p.mergeMode, "range");
  assert.equal(p.contextRef, "ar_gl/translation-context@master");
  assert.equal(p.contextRefExplicit, false);
  assert.equal(p.targetLangName, "Arabic");
  assert.equal(p.direction, "rtl");
  assert.equal(p.targetLiteralRef, "ar_gl/ar_glt@master");
  assert.equal(p.thinking, "medium");
  const byId = steps.paramsToTranslateParams({ ...PARAMS, rowIds: ["ab12"] });
  assert.equal(byId.mergeMode, "by-id");
  // Persisted params carry provider + model only — there is no key field to leak.
  const json = JSON.stringify(PARAMS);
  assert.ok(!/apiKey|api_key|ciphertext/i.test(json));
  assert.ok(!json.includes(KEY));
});

test("full run: source → context → 11 batches → merge reproduces the recorded tn_OBA.tsv, in the §C R2 layout", async () => {
  const s = await scenario();
  const { deps } = s;

  const src = await steps.guardAndSourceStep(deps, PARAMS);
  assert.deepEqual(src, { batchCount: 11, rowCount: 153, coversWholeBook: true });
  for (let i = 0; i < 11; i++) {
    const nn = storage.batchNn(i);
    assert.equal(s.blobs.map.get(`pipeline-output/bsoj/job-1/work/batch-${nn}.tsv`), fixture(`${DRY}work/batch-${nn}.tsv`), `work/batch-${nn}.tsv byte-identical to the bot's`);
  }
  assert.equal(s.wf().state, "running");
  assert.match(s.row().current_status, /^source: 153 row\(s\) from unfoldingWord\/en_tn@master — 11 batch\(es\)$/);
  assert.equal(s.row().current_skill, "translate-tn");

  const ctx = await steps.contextStep(deps, PARAMS, src.batchCount);
  assert.equal(ctx.perBatch.length, 11);
  assert.equal(ctx.hasContent, true);
  assert.equal(ctx.contextSha, null, "branches API 404s in the fake → sha unresolved, not fatal");
  assert.ok(ctx.perBatch[0].slugs.includes("figs-metaphor"));
  assert.ok(s.blobs.map.has("pipeline-output/bsoj/job-1/work/batch-01-pack.md"));
  const task = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-11-task.json"));
  assert.equal(task.task, "translate-tsv-batch");
  assert.equal(task.batchFile, "batch-11.tsv");
  assert.equal(task.outputFile, "batch-11-out.tsv");
  assert.ok(!JSON.stringify(ctx).includes("Translation context"), "context step returns no pack bodies");
  assert.match(s.row().current_status, /^context pack: ar_gl\/translation-context@master — 1 templates, 5 terms, 2 examples$/);

  const results = [];
  for (let i = 0; i < src.batchCount; i++) {
    const r = await batchStep(deps, PARAMS, i, src.batchCount);
    results.push(r);
    assert.equal(r.nn, storage.batchNn(i));
    assert.equal(r.attempts, 1);
    assert.equal(r.calls, 1);
    assert.equal(r.reused, false);
    assert.equal(r.inputTokens, 5000);
    assert.ok(r.costUsd > 0);
    assert.equal(s.blobs.map.get(`pipeline-output/bsoj/job-1/work/batch-${r.nn}-out.tsv`), fixture(`${DRY}work/batch-${r.nn}-out.tsv`), `out ${r.nn} persisted as returned`);
    assert.equal(s.row().current_status, `batch ${r.nn}/11 done (${r.rowCount} rows, 1 attempt(s))`);
  }
  assert.equal(s.replay.calls.length, 11);
  assert.equal(results.reduce((n, r) => n + r.rowCount, 0), 153);
  assert.equal(s.wf().state, "running", "batch steps never write done");

  // §C parity, asserted as a SET and not just key by key: a clean run writes
  // the recorded dry-run work directory and nothing besides. The stored draft
  // (batch-NN-draft.json) exists only on the failed-checks path, and moving the
  // output write into its own step must not add, drop or rename anything here.
  //
  // The one standing difference from the recording is batch-NN-task.json, which
  // this runner writes and the committed dry run does not carry. That predates
  // the step split; it is pinned here so it stays a known, single divergence
  // rather than cover for the next one.
  const workFiles = [...s.blobs.map.keys()].filter((k) => k.startsWith(`pipeline-output/${WS}/${JOB}/work/`)).sort();
  const recorded = readdirSync(new URL(`${DRY}work/`, FIXTURES));
  const expected = [
    ...recorded,
    ...Array.from({ length: 11 }, (_, i) => `batch-${storage.batchNn(i)}-task.json`),
  ].map((f) => `pipeline-output/${WS}/${JOB}/work/${f}`).sort();
  assert.deepEqual(workFiles, expected);

  const merged = await steps.mergeReportStep(deps, PARAMS, src, ctx, results);
  assert.equal(merged.rowCount, 153);
  assert.equal(merged.bookFile, "tn_OBA.tsv");
  assert.equal(merged.reportFile, "translate-report-1-1.json");
  assert.equal(merged.calls, 11);
  assert.equal(s.blobs.map.get("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), fixture(`${DRY}tn_OBA.tsv`), "merged book byte-identical to the bot's dry run");

  const report = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.generatedBy, "bible-editor/translate");
  assert.equal(report.jobId, JOB);
  assert.equal(report.rowCount, 153);
  assert.equal(report.batches.length, 11);
  assert.deepEqual(report.batches[0].templateFallbacks, ctx.perBatch[0].templateFallbacks);
  assert.equal(report.checks.ok, true);
  assert.equal(report.checks.errorCount, 0);
  assert.equal(report.llm.calls, 11);
  assert.equal(report.llm.provider, "claude");
  assert.equal(report.llm.inputTokens, 55000);
  assert.equal(report.selection.mergeMode, "range");

  const done = s.wf();
  assert.equal(done.state, "done");
  assert.equal(done.current.status, "done");
  assert.equal(done.current.startedAt, "2026-09-15T10:00:00.000Z");
  assert.deepEqual(done.output, [
    { delivery: "editor", type: "tn", repo: "ar_gl/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
    { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
  ]);
  // Ownership contract: the Workflow never writes state or output_json.
  assert.equal(s.row().state, "running");
  assert.equal(s.row().output_json, null);

  // The manifest's `file` resolves through the same guarded key builder step 5 will use.
  assert.equal(storage.outKey(WS, JOB, done.output[0].file), "pipeline-output/bsoj/job-1/out/tn_OBA.tsv");
  // Everything ever written to the row is key-free.
  for (const v of Object.values(s.row())) assert.ok(!String(v).includes(KEY));
});

test("batch step reuses a validated output already in R2 without calling the provider", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const first = await batchStep(s.deps, PARAMS, 2, src.batchCount);
  assert.equal(first.reused, false);
  assert.equal(s.replay.calls.length, 1);

  const bomb = { ...s.deps, transport: async () => { throw new Error("must not be called"); } };
  const again = await batchStep(bomb, PARAMS, 2, src.batchCount);
  assert.deepEqual(again, { nn: "03", rowCount: first.rowCount, attempts: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, reused: true });
  assert.match(s.row().current_status, /^batch 03\/11 reused from previous attempt/);

  // A leftover that no longer validates is retranslated, not trusted.
  s.blobs.map.set("pipeline-output/bsoj/job-1/work/batch-03-out.tsv", "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tzz99\t\t\tx\t1\tbroken\n");
  const redo = await batchStep(s.deps, PARAMS, 2, src.batchCount);
  assert.equal(redo.reused, false);
  assert.equal(s.replay.calls.length, 2);
});

test("cooperative cancel: a cancelled or externally-failed row fails step 1 and every batch step non-retryably", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'cancelled' WHERE job_id = ?`).run(JOB);
  let f = await kindOf(() => batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "cancelled");
  assert.equal(f.retryable, false);
  assert.equal(s.replay.calls.length, 0, "no provider call after cancel");
  f = await kindOf(() => steps.guardAndSourceStep(s.deps, PARAMS));
  assert.equal(f.errorKind, "cancelled");

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'failed' WHERE job_id = ?`).run(JOB);
  f = await kindOf(() => batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "job_not_running");
  assert.equal(f.retryable, false);

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'dispatching' WHERE job_id = ?`).run(JOB);
  await steps.assertJobLive(s.deps, JOB);

  s.sqlite.prepare(`DELETE FROM pipeline_jobs WHERE job_id = ?`).run(JOB);
  f = await kindOf(() => steps.assertJobLive(s.deps, JOB));
  assert.equal(f.errorKind, "job_missing");
});

test("provider gate inside the batch step: changed / unsupported / unavailable are non-retryable", async () => {
  // Provider switched after dispatch → refuse, don't bill the new vendor.
  let s = await scenario();
  let src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  s.sqlite.prepare(`UPDATE ai_provider_config SET provider = 'openai', model = 'gpt-5.5' WHERE id = 1`).run();
  let f = await kindOf(() => batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_changed");
  assert.equal(f.retryable, false);
  assert.equal(s.replay.calls.length, 0);

  // Dispatched for a provider with no in-Worker adapter (no injected transport).
  s = await scenario({ provider: "openai", model: "gpt-5.5", transport: null });
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  f = await kindOf(() => batchStep(s.deps, { ...PARAMS, provider: "openai", model: "gpt-5.5" }, 0, src.batchCount));
  assert.equal(f.errorKind, "provider_not_supported_internal");
  assert.equal(f.retryable, false);

  // Org cleared its key mid-run.
  s = await scenario();
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  s.sqlite.prepare(`UPDATE ai_provider_config SET key_ciphertext = NULL, key_iv = NULL WHERE id = 1`).run();
  f = await kindOf(() => batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_unavailable");
  assert.match(f.message, /api_key_missing/);

  // Wrapping key rotated → stored key undecryptable.
  s = await scenario();
  src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  f = await kindOf(() => batchStep({ ...s.deps, wrappingKey: Buffer.alloc(32, 9).toString("base64") }, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "ai_provider_key_decrypt_failed");
  assert.equal(f.retryable, false);
});

test("source-side guards: missing source and empty selection are non-retryable; DCS 5xx stays retryable", async () => {
  let s = await scenario();
  let f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, book: "ZEC" }));
  assert.equal(f.errorKind, "source_not_found");
  assert.equal(f.retryable, false);

  f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, rowIds: ["nope"] }));
  assert.equal(f.errorKind, "no_source_rows");
  assert.match(f.message, /rowIds nope/);

  f = await kindOf(() => steps.guardAndSourceStep(s.deps, { ...PARAMS, resourceType: "tw", articleId: "kt/god" }));
  assert.equal(f.errorKind, "resource_not_supported_internal");

  s = await scenario();
  const flaky = { ...s.deps, fetchImpl: async () => ({ status: 502, ok: false, headers: null, text: async () => "bad gateway" }) };
  f = await kindOf(() => steps.guardAndSourceStep(flaky, PARAMS));
  assert.equal(f.errorKind, "internal_error");
  assert.equal(f.retryable, true, "an infra error keeps the step's retry budget");
  assert.match(f.message, /HTTP 502/);
});

test("by-id subset merges into an existing target book; range merge with an existing book replaces the chapter", async () => {
  // Existing target = the bot's finished Arabic book; re-translate two rows by id.
  const finished = fixture(`${DRY}tn_OBA.tsv`);
  const s = await scenario({ withTarget: finished });
  const rowIds = ["jdr1", "gn3t"]; // 1:1 (recorded batch 01) and 1:8 (recorded batch 05)
  const params = { ...PARAMS, rowIds };
  const src = await steps.guardAndSourceStep(s.deps, params);
  assert.deepEqual(src, { batchCount: 1, rowCount: 2, coversWholeBook: false });
  const sourceIds = s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-01.tsv");
  assert.deepEqual(sourceIds.split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]), rowIds, "the single batch holds exactly the selected rows, in source order");
  const ctx = await steps.contextStep(s.deps, params, 1);
  const r = await batchStep(s.deps, params, 0, 1);
  assert.equal(r.rowCount, 2);
  const merged = await steps.mergeReportStep(s.deps, params, src, ctx, [r]);
  assert.equal(merged.rowCount, src.rowCount);
  assert.equal(s.blobs.map.get("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), finished, "by-id update of identical rows leaves the book byte-identical");
  const report = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.selection.mergeMode, "by-id");
  assert.deepEqual(report.selection.rowIds, rowIds);
});

test("by-id with no existing target book fails merge_failed (non-retryable), as the bot does", async () => {
  const s = await scenario();
  const params = { ...PARAMS, verseStart: 1, verseEnd: 1 };
  const src = await steps.guardAndSourceStep(s.deps, params);
  const ctx = await steps.contextStep(s.deps, params, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await batchStep(s.deps, params, i, src.batchCount));
  const f = await kindOf(() => steps.mergeReportStep(s.deps, params, src, ctx, results));
  assert.equal(f.errorKind, "merge_failed");
  assert.equal(f.retryable, false);
  assert.match(f.message, /requires an existing target book/);
});

test("key hygiene: a provider that echoes the key back never leaks it into errors or wf_status_json", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  // Deterministic provider failure carrying the key (and an Authorization header) in its body.
  const echo = { ...s.deps, transport: async () => { const e = new Error(`bad request: key ${KEY} rejected; Authorization: Bearer ${KEY}`); e.status = 400; throw e; } };
  let err;
  try { await batchStep(echo, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  assert.ok(err instanceof TranslateProviderError);
  assert.equal(err.code, "provider_error");
  assert.ok(!err.message.includes(KEY), `message leaked the key: ${err.message}`);
  assert.ok(!String(err.cause?.message ?? "").includes(KEY), "cause message scrubbed too");
  const f = await steps.recordFailure(s.deps, PARAMS, err);
  assert.equal(f.errorKind, "provider_error");
  assert.equal(f.retryable, false);
  const wf = s.wf();
  assert.equal(wf.state, "failed");
  assert.equal(wf.current.errorKind, "provider_error");
  assert.equal(wf.current.status, "failed");
  assert.ok(!s.row().wf_status_json.includes(KEY));
  assert.ok(!(s.row().error_message ?? "").includes(KEY));
  assert.equal(s.row().state, "running", "record-failure does not flip state either");

  // Transient failure with the key in a nested cause: still retryable, still scrubbed.
  const over = { ...s.deps, transport: async () => { const inner = new Error(`socket closed for ${KEY}`); const e = new Error("Overloaded", { cause: inner }); e.status = 529; throw e; } };
  try { await batchStep(over, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  const c = steps.classifyStepError(err);
  assert.equal(c.errorKind, "provider_overloaded");
  assert.equal(c.retryable, true);
  assert.ok(!JSON.stringify({ m: err.message, c: err.cause?.message, cc: err.cause?.cause?.message }).includes(KEY));

  // A non-Error throw is wrapped and scrubbed rather than escaping raw.
  const raw = { ...s.deps, transport: async () => { throw `string failure ${KEY}`; } };
  try { await batchStep(raw, PARAMS, 0, src.batchCount); } catch (e) { err = e; }
  assert.ok(!String(err.message ?? err).includes(KEY));
});

test("classifyStepError: kinds survive the [kind] message prefix; provider codes keep their retryable flag", () => {
  let c = steps.classifyStepError(new steps.TranslateStepError("ai_provider_changed", "x"));
  assert.deepEqual(c, { errorKind: "ai_provider_changed", message: "x", retryable: false });
  // What run() sees after the engine rethrows a NonRetryableError: message + name only.
  c = steps.classifyStepError(new Error("[checks_failed] batch 02 still failing"));
  assert.deepEqual(c, { errorKind: "checks_failed", message: "batch 02 still failing", retryable: false });
  c = steps.classifyStepError(new Error("[rate_limited] claude rate_limited: 429"));
  assert.equal(c.retryable, true);
  c = steps.classifyStepError(new TranslateProviderError("timeout", "claude", "claude timeout: hung"));
  assert.deepEqual(c, { errorKind: "timeout", message: "claude timeout: hung", retryable: true });
  c = steps.classifyStepError(new TranslateProviderError("invalid_key", "claude", `claude invalid_key: ${KEY}`));
  assert.equal(c.retryable, false);
  assert.ok(!c.message.includes(KEY), "pattern scrub applies even without the literal key");
  c = steps.classifyStepError(new Error("D1_ERROR: database is locked"));
  assert.deepEqual(c, { errorKind: "internal_error", message: "D1_ERROR: database is locked", retryable: true });
  c = steps.classifyStepError("plain string");
  assert.equal(c.errorKind, "internal_error");
});

test("resolveWorkflowWorkspace: missing and unknown slugs are non-retryable, never silently list[0]", () => {
  const env = {
    DB: { prepare() {} }, DB_ORG2: { prepare() {} },
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2" },
    ]),
  };
  assert.equal(steps.resolveWorkflowWorkspace(env, { workspace: "org2" }).binding, "DB_ORG2");
  for (const params of [{}, { workspace: null }, { workspace: "" }, null, undefined]) {
    const err = (() => { try { steps.resolveWorkflowWorkspace(env, params); } catch (e) { return e; } })();
    assert.equal(steps.classifyStepError(err).errorKind, "workspace_missing", JSON.stringify(params));
    assert.equal(steps.classifyStepError(err).retryable, false);
  }
  const unknown = (() => { try { steps.resolveWorkflowWorkspace(env, { workspace: "retired-org" }); } catch (e) { return e; } })();
  assert.equal(steps.classifyStepError(unknown).errorKind, "workspace_unknown");
});

/** Every string reachable from a value: own enumerable props, nested, cycle-safe. */
function deepStrings(value, seen = new Set(), out = []) {
  if (value == null) return out;
  if (typeof value === "string") { out.push(value); return out; }
  if (typeof value !== "object" && typeof value !== "function") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Error) {
    // name/message/stack/cause are not enumerable on an Error — walk them explicitly.
    for (const k of ["name", "message", "stack"]) deepStrings(value[k], seen, out);
    deepStrings(value.cause, seen, out);
  }
  for (const v of Object.values(value)) deepStrings(v, seen, out);
  if (Array.isArray(value)) for (const v of value) deepStrings(v, seen, out);
  return out;
}

test("error hygiene: nothing leaving batchStep carries the key — not .stack, not a cause chain, not transportResults/llmCalls", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);

  // A provider failure that echoes the key in every place the old in-place
  // scrub missed: the message (so .stack's header carries it at construction),
  // a nested cause, and the non-message properties the engine persists.
  const leaky = {
    ...s.deps,
    transport: async () => {
      const inner = new Error(`inner: Authorization: Bearer ${KEY}`);
      const e = new Error(`bad request: key ${KEY} rejected`, { cause: inner });
      e.status = 400;
      e.transportResults = [{ text: `echo ${KEY}`, usage: { inputTokens: 1, outputTokens: 1 } }];
      throw e;
    },
  };
  let err;
  try { await batchStep(leaky, PARAMS, 0, src.batchCount); } catch (e) { err = e; }

  assert.ok(err instanceof TranslateProviderError, "still classified as a provider error");
  assert.equal(err.code, "provider_error");
  assert.ok(typeof err.stack === "string" && err.stack.length > 0);
  assert.ok(!err.stack.includes(KEY), "the stack (materialized at construction) must not carry the key");
  assert.equal(err.cause, undefined, "the original cause chain is dropped, not scrubbed in place");
  assert.equal(err.transportResults, undefined, "raw transport records never leave the key's scope");
  assert.equal(err.llmCalls, undefined, "priced-call records never leave the key's scope either");
  for (const str of deepStrings(err)) {
    assert.ok(!str.includes(KEY), `a reachable string leaked the key: ${str.slice(0, 120)}`);
  }
  // Only our own primitive fields carry a value. (The class's declared optional
  // fields still exist as own keys — class fields are defined, not just typed —
  // but they must be undefined, which is what the asserts above pin.)
  const carried = Object.entries(err).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
  assert.deepEqual(carried, ["code", "errorKind", "name", "provider", "retryable", "status"], "no unexpected data rides along");

  // …and the same holds for what record-failure then persists.
  await steps.recordFailure(s.deps, PARAMS, err);
  assert.ok(!s.row().wf_status_json.includes(KEY));
});

test("sanitizeBatchError: rebuilds the error, and an unclassified throw after a billed call is non-retryable", () => {
  // Provider errors keep their kind and retryability; everything else is dropped.
  const provider = new TranslateProviderError("rate_limited", "claude", `claude rate_limited: ${KEY}`, { status: 429, retryAfterSeconds: 30 });
  provider.transportResults = [{ text: KEY }];
  provider.llmCalls = [{ costUsd: 1, model: "claude-sonnet-5" }];
  const clean = steps.sanitizeBatchError(provider, KEY);
  assert.notEqual(clean, provider, "a NEW error, never the mutated original");
  assert.equal(steps.classifyStepError(clean).errorKind, "rate_limited");
  assert.equal(steps.classifyStepError(clean).retryable, true);
  assert.equal(clean.status, 429);
  assert.equal(clean.retryAfterSeconds, 30);
  assert.equal(clean.transportResults, undefined);
  assert.equal(clean.llmCalls, undefined);
  assert.ok(!clean.stack.includes(KEY));
  assert.ok(provider.message.includes(KEY), "the original is left untouched (we no longer mutate it)");

  // A step error keeps its own kind and flag.
  const stepErr = steps.sanitizeBatchError(new steps.TranslateStepError("cancelled", "job x was cancelled", { retryable: false }), KEY);
  assert.deepEqual(steps.classifyStepError(stepErr), { errorKind: "cancelled", message: "job x was cancelled", retryable: false });

  // An unclassified error came out of the LLM path — a bug in our adapter,
  // possibly after the model answered and the org was billed. Retrying buys two
  // more billed calls for the same crash.
  for (const raw of [new TypeError(`cannot read x of ${KEY}`), `string failure ${KEY}`]) {
    const c = steps.classifyStepError(steps.sanitizeBatchError(raw, KEY));
    assert.equal(c.errorKind, "internal_error_after_call");
    assert.equal(c.retryable, false, "unknown errors after a billed call must NOT be retried");
    assert.ok(!c.message.includes(KEY));
  }
});

test("retryableStepError: a retryable failure keeps its kind through the engine's rethrow", () => {
  // The engine rethrows a step's final error into run() with message/name only,
  // so a rate_limited failure that exhausted its retries used to record
  // internal_error. classifyStepError must round-trip the tag.
  for (const kind of ["rate_limited", "timeout", "provider_overloaded", "network_error", "internal_error"]) {
    const tagged = steps.retryableStepError({ errorKind: kind, message: "upstream said no", retryable: true });
    assert.ok(!(tagged instanceof TranslateProviderError), "a freshly built plain Error — no provider object reaches the engine");
    const c = steps.classifyStepError(new Error(tagged.message)); // what survives the hop
    assert.equal(c.errorKind, kind);
    assert.equal(c.retryable, true, `${kind} must stay retryable after the round trip`);
  }
});

test("merge-report re-checks cancel before writing out/ and a done manifest", async () => {
  const s = await scenario({ withTarget: fixture(`${DRY}tn_OBA.tsv`) });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await batchStep(s.deps, PARAMS, i, src.batchCount));

  s.sqlite.prepare(`UPDATE pipeline_jobs SET state = 'cancelled' WHERE job_id = ?`).run(JOB);
  const f = await kindOf(() => steps.mergeReportStep(s.deps, PARAMS, src, ctx, results));
  assert.equal(f.errorKind, "cancelled");
  assert.equal(f.retryable, false);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "no out/ file for a cancelled job");
  assert.notEqual(s.wf().state, "done", "no done manifest either");
});

test("merge base guards: an absent target refuses a partial book, and a shrinking merge is refused", async () => {
  // 1. Base absent + the run covered the whole source book → allowed (the first
  //    translation of a new language; that is the full OBA run above). Base
  //    absent + a partial run → refused: a wrongly defaulted targetOrg/repoName
  //    404s exactly like a genuine bootstrap, and the out/ file would then hold
  //    only the translated range, which step 5 imports as the whole book.
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const results = [];
  for (let i = 0; i < src.batchCount; i++) results.push(await batchStep(s.deps, PARAMS, i, src.batchCount));

  const partial = { ...src, coversWholeBook: false };
  const f = await kindOf(() => steps.mergeReportStep(s.deps, PARAMS, partial, ctx, results));
  assert.equal(f.errorKind, "target_book_absent");
  assert.equal(f.retryable, false);
  assert.match(f.message, /ar_gl\/ar_tn@master/);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "nothing written on refusal");

  // …unless the job explicitly asked to create the file.
  const created = await steps.mergeReportStep(s.deps, { ...PARAMS, createIfAbsent: true }, partial, ctx, results);
  assert.equal(created.rowCount, 153);

  // 2. Shrink guard: the target holds the finished 153-row book, but this run's
  //    source fetch returned only two rows (a truncated or stale source).
  //    Merging the range would replace 153 rows with 2 — the export's
  //    shrink-refusal policy, applied to the merge base.
  const finished = fixture(`${DRY}tn_OBA.tsv`);
  const sourceLines = fixture("tn_OBA.tsv").split("\n");
  const truncatedSource = [sourceLines[0], sourceLines[1], sourceLines[2], ""].join("\n");
  const t = await scenario({ withTarget: finished, source: truncatedSource });
  const tsrc = await steps.guardAndSourceStep(t.deps, PARAMS);
  assert.equal(tsrc.coversWholeBook, true, "a truncated source looks complete to step 1 — only the base reveals it");
  const tctx = await steps.contextStep(t.deps, PARAMS, tsrc.batchCount);
  const tres = [await batchStep(t.deps, PARAMS, 0, tsrc.batchCount)];
  const g = await kindOf(() => steps.mergeReportStep(t.deps, PARAMS, tsrc, tctx, tres));
  assert.equal(g.errorKind, "merge_shrink_refused");
  assert.equal(g.retryable, false);
  assert.match(g.message, /would leave 2 rows where the fetched base has 153/);
  assert.ok(!t.blobs.map.has("pipeline-output/bsoj/job-1/out/tn_OBA.tsv"), "the shrunken book is never written");
});

test("context step: a DCS transport failure on the scripture pack retries instead of persisting a context-free pack", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);

  // The context pack itself resolves; the four USFM fetches 5xx.
  const flaky = {
    ...s.deps,
    fetchImpl: async (url) => (/\.usfm$/.test(url)
      ? { status: 503, ok: false, headers: null, text: async () => "upstream" }
      : s.deps.fetchImpl(url)),
  };
  const f = await kindOf(() => steps.contextStep(flaky, PARAMS, src.batchCount));
  assert.equal(f.errorKind, "scripture_fetch_failed");
  assert.equal(f.retryable, true, "a transient DCS failure keeps the step's retry budget");
  assert.match(f.message, /HTTP 503/);
  assert.ok(!s.blobs.map.has("pipeline-output/bsoj/job-1/work/batch-01-pack.md"), "no context-free pack persisted");

  // A target Bible that simply does not exist yet still degrades to "absent".
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  assert.equal(ctx.hasContent, true);
  assert.ok(s.blobs.map.get("pipeline-output/bsoj/job-1/work/batch-01-pack.md").length > 0);
});

// --- double-spend windows around a billed provider call ----------------------
//
// A batch step that has already paid the provider is the one place where a
// plain "let the step retry" costs real money. These three pin the three
// mitigations: the R2 put of a billed output is retried in-step and then fails
// NON-retryably; a billed draft is persisted before the repair call and resumed
// from on the next attempt; and a stored draft that validates is promoted
// instead of being re-bought.

/** The recorded reply for exactly the rows this prompt asked about, optionally short. */
function replayReply(user, { drop = 0 } = {}) {
  const src = /-----BEGIN SOURCE CONTENT-----\n([\s\S]*?)\n-----END SOURCE CONTENT-----/.exec(user);
  assert.ok(src, "prompt must inline the source TSV");
  const ids = src[1].split("\n").slice(1).filter(Boolean).map((l) => l.split("\t")[1]);
  const kept = drop > 0 ? ids.slice(0, ids.length - drop) : ids;
  const body = kept.map((id) => { const r = RECORDED.rows.get(id); assert.ok(r, `recorded row for ${id}`); return r; }).join("\n");
  return { text: wrapped(`${RECORDED.header}\n${body}`), usage: { inputTokens: 5000, outputTokens: 3000 }, stopReason: "end_turn" };
}

test("the billed output leaves the paying step as its RETURN value, and nothing writes it there", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  const translated = await steps.batchTranslateStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(s.replay.calls.length, 1);
  // The seam: the step that spent the money hands the output back instead of
  // writing it, so the engine persists it before the write is even attempted.
  assert.equal(translated.outputText, fixture(`${DRY}work/batch-01-out.tsv`));
  assert.equal(s.blobs.map.has(keys.output), false, "batch-NN must not write the output itself");
  // ...and it is a step return, so it must still be free of the decrypted key.
  assert.ok(!JSON.stringify(translated).includes(KEY));

  const persisted = await steps.batchPersistStep(s.deps, PARAMS, translated);
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`));
  assert.equal(persisted.outputText, undefined, "the accounting handed on to merge-report carries no payload");
  assert.equal(persisted.calls, 1);
});

// A padding unit for an oversized output: one space plus four Arabic letters.
// Deliberately harmless to every deterministic check — no tab or newline, no
// rc:// link, no digit, and never two spaces in a row — so the inflated output
// VALIDATES. That is the point: batch size is bounded by rows and source
// characters, and nothing bounds how far a translated column may expand.
const PAD_UNIT = " كلمة";
const MIB = 1024 * 1024;

/** The recorded reply for this prompt, with every Note inflated by `units` pads. */
function inflatedReply(user, units) {
  const reply = replayReply(user);
  const pad = PAD_UNIT.repeat(units);
  const text = reply.text.split("\n").map((line) => {
    if (!line.includes("\t") || line.startsWith("Reference\t")) return line;
    const cells = line.split("\t");
    cells[cells.length - 1] += pad;
    return cells.join("\t");
  }).join("\n");
  return { ...reply, text };
}

test("an output too large to return from the step is persisted inside it, and is never bought twice", async () => {
  // Finding: batch-NN returns `outputText`, and Cloudflare refuses to persist a
  // non-stream step result over 1 MiB. An unbounded return is therefore a
  // step that cannot commit — so the engine retries it, and the retry re-buys
  // the batch. The exact failure the persist split was introduced to prevent.
  let replyBytes = 0;
  let calls = 0;
  const s = await scenario({ transport: async (req) => {
    calls += 1;
    const reply = inflatedReply(req.user, 9000);
    replyBytes = Buffer.byteLength(reply.text, "utf8");
    return reply;
  } });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  const translated = await steps.batchTranslateStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(calls, 1);
  assert.ok(replyBytes > MIB, `the fixture must actually be oversized (was ${replyBytes} bytes)`);

  // THE assertion: whatever the model produced, what the engine is asked to
  // persist fits. Everything else here follows from how that is achieved.
  const returned = Buffer.byteLength(JSON.stringify(translated), "utf8");
  assert.ok(returned < MIB, `the step return must fit under Cloudflare's 1 MiB step-result cap (was ${returned} bytes)`);

  // How: the paying step wrote it itself and returned the same marker a reused
  // output returns, so batch-NN-persist has nothing to do.
  assert.equal(translated.outputText, null, "an oversized output is not returned");
  const stored = s.blobs.map.get(keys.output);
  assert.ok(Buffer.byteLength(stored, "utf8") > MIB, "the oversized output is durable in R2 instead");
  assert.equal(translated.calls, 1);

  const persisted = await steps.batchPersistStep(s.deps, PARAMS, translated);
  assert.equal(s.blobs.map.get(keys.output), stored, "the persist step neither rewrites nor clobbers it");
  assert.equal(persisted.calls, 1);

  // And the cost claim, which is the whole reason the size matters: re-running
  // the paying step — what the engine does when a step return will not commit
  // — finds a validated output and buys nothing.
  const again = await batchStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(calls, 1, "an oversized batch must never cause a second paid call");
  assert.equal(again.reused, true);
  assert.equal(again.calls, 0);
});

test("an R2 refusal in the persist step is retryable, and its retry replays the output instead of re-buying it", async () => {
  const s = await scenario();
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  const translated = await steps.batchTranslateStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(s.replay.calls.length, 1);

  let puts = 0;
  const flaky = {
    ...s.deps,
    blobs: {
      ...s.blobs,
      async put(key, value, opts) {
        if (key !== keys.output) return s.blobs.put(key, value, opts);
        puts += 1;
        throw new Error("R2 PutObject: 500 internal error");
      },
    },
  };
  const f = await kindOf(() => steps.batchPersistStep(flaky, PARAMS, translated));
  // THE regression assertion. Non-retryable was the old answer, and it was the
  // only one available while the put lived inside the paying step: a retry
  // there found no stored output and bought the batch again. The output now
  // survives in the step return, so the write is allowed to keep trying.
  assert.equal(f.retryable, true, "the write of an already-durable output must earn its retries");
  assert.equal(puts, 1);

  // What the engine does next: re-run ONLY the persist step, with the return
  // value it persisted for batch-01 replayed into it.
  const again = await steps.batchPersistStep(s.deps, PARAMS, translated);
  assert.equal(s.replay.calls.length, 1, "the retry cost no provider call at all");
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`));
  assert.equal(again.calls, 1);
});

test("a billed draft survives the step: a transient failure after it resumes at the repair pass instead of re-drafting", async () => {
  const prompts = [];
  let phase = 1;
  const transport = async (req) => {
    prompts.push(req.user);
    if (phase === 1) {
      // Drop a row: `missing-row` is error-severity, so the draft fails checks
      // and runBatch goes on to the repair pass.
      phase = 2;
      return replayReply(req.user, { drop: 1 });
    }
    if (phase === 2) {
      // ...which dies on a provider transient. The draft is already paid for.
      phase = 3;
      throw new TranslateProviderError("rate_limited", "claude", "slow down");
    }
    return replayReply(req.user);
  };
  const s = await scenario({ transport });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  const f = await kindOf(() => batchStep(s.deps, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "rate_limited");
  assert.equal(f.retryable, true, "a provider transient still earns the step its retry");
  assert.equal(prompts.length, 2, "one draft, then a repair call that never landed");
  assert.ok(s.blobs.map.has(keys.draft), "the billed draft is durable BEFORE the repair call is made");
  assert.equal(s.blobs.map.has(keys.output), false, "and nothing validated, so there is no output yet");
  // What it COST is durable too, and in the SAME object — one R2 put, so there
  // is no interval in which the draft exists without its price. Without this
  // the resumed step below reports only the repair call, and the run's report
  // bills the org for one call when it paid for two.
  const draft = JSON.parse(s.blobs.map.get(keys.draft));
  assert.deepEqual(draft.calls?.map((c) => c.usage), [{ inputTokens: 5000, outputTokens: 3000 }],
    "the draft object carries the calls that bought it");
  assert.equal(typeof draft.output, "string");
  assert.ok(draft.output.includes("\t"), "the draft TSV itself rides in the same object");

  // What the engine does next: re-run the same step.
  const again = await batchStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(prompts.length, 3, "the retry bought ONE call — without the stored draft it would re-draft AND repair");
  assert.match(prompts[2], /FAILED deterministic validation/, "the retry entered at the repair pass");
  assert.equal(again.reused, false);
  assert.equal(again.attempts, 2, "which is pass 2 of 2: the resumed draft was pass 1");
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`));
  // THE accounting assertion: 2 calls, not 1. The isolate that bought the draft
  // died, the org's card did not un-charge, and the report is the org's bill.
  assert.equal(again.calls, 2, "the resumed batch bills the draft it inherited as well as the repair pass");
  assert.equal(again.inputTokens, 10000);
  assert.equal(again.outputTokens, 6000);

  // And it reaches the report the org actually reads.
  const rest = [];
  for (let i = 1; i < src.batchCount; i++) rest.push(await batchStep(s.deps, PARAMS, i, src.batchCount));
  const ctx = await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const merged = await steps.mergeReportStep(s.deps, PARAMS, src, ctx, [again, ...rest]);
  assert.equal(merged.calls, src.batchCount + 1, "one call per batch, plus the draft batch-01 paid for twice");
  const report = JSON.parse(s.blobs.map.get("pipeline-output/bsoj/job-1/out/translate-report-1-1.json"));
  assert.equal(report.llm.calls, src.batchCount + 1);
  assert.equal(report.llm.inputTokens, 5000 * (src.batchCount + 1), "every billed token is in the report");
});

test("one R2 hiccup while storing a billed draft cannot separate it from its price", async () => {
  // This test used to assert the opposite — "a draft resumed with no stored
  // call metadata still runs, and only under-reports", pinning `again.calls`
  // at 1 — because the price was a best-effort sidecar written beside the
  // draft. One refused put was enough to land the draft and lose the ledger,
  // and the resumed batch then billed the org for the repair pass alone.
  //
  // The draft and its ledger are now ONE object, so a refusal either loses
  // both (and there is nothing to resume from) or, as here, is absorbed by
  // persistBilled's in-step retry and loses neither.
  const prompts = [];
  let phase = 1;
  const s = await scenario({ transport: async (req) => {
    prompts.push(req.user);
    if (phase === 1) { phase = 2; return replayReply(req.user, { drop: 1 }); }
    if (phase === 2) { phase = 3; throw new TranslateProviderError("rate_limited", "claude", "slow down"); }
    return replayReply(req.user);
  } });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  // Exactly one refusal, aimed at whichever put carries the draft. Under the
  // sidecar shape it hit the metadata put, which had no retry.
  let refusals = 1;
  const flaky = {
    ...s.deps,
    blobs: {
      ...s.blobs,
      async put(key, value, opts) {
        if (/-draft\./.test(key) && refusals > 0) {
          refusals -= 1;
          throw new Error("R2 PutObject: 500 internal error");
        }
        return s.blobs.put(key, value, opts);
      },
    },
  };

  const f = await kindOf(() => batchStep(flaky, PARAMS, 0, src.batchCount));
  assert.equal(f.errorKind, "rate_limited");
  assert.equal(refusals, 0, "the injected R2 refusal really fired");

  const draftKeys = [...s.blobs.map.keys()].filter((k) => k.includes("-draft"));
  assert.deepEqual(draftKeys, [keys.draft], "one object holds the draft; there is no second key to lose");
  const stored = JSON.parse(s.blobs.map.get(keys.draft));
  assert.deepEqual(stored.calls?.map((c) => c.usage), [{ inputTokens: 5000, outputTokens: 3000 }],
    "the ledger survived the hiccup in the same object as the text it belongs to");

  const again = await batchStep(flaky, PARAMS, 0, src.batchCount);
  assert.equal(prompts.length, 3, "the resume still happens: one repair call, not a re-draft");
  // THE assertion this test used to invert: 2, not 1.
  assert.equal(again.calls, 2, "the resumed batch bills the draft the org paid for as well as the repair pass");
  assert.equal(again.inputTokens, 10000);
  assert.equal(again.outputTokens, 6000);
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`));
});

test("a draft put that never lands is non-fatal: the batch finishes through the repair call in one attempt (#462)", async () => {
  // Before #460 the batch output was written in the same paying step, so a
  // refused draft put had to fail the whole batch — a step retry would re-buy
  // the model call. #460 split the validated output into its own retryable
  // persist step, and the draft put now happens mid-loop with the repair call
  // about to run in this attempt regardless. So a refused draft put must NOT
  // throw away the already-paid draft and the batch with it: log and continue.
  const prompts = [];
  let phase = 1;
  const s = await scenario({ transport: async (req) => {
    prompts.push(req.user);
    // Draft drops a row (error-severity → fails checks → repair pass); the
    // repair call then returns the full, valid batch.
    if (phase === 1) { phase = 2; return replayReply(req.user, { drop: 1 }); }
    return replayReply(req.user);
  } });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");

  // The draft put is refused PERMANENTLY — every attempt, past persistBilled's
  // in-step retries — so the fatal path (if it still existed) would fire.
  let draftPuts = 0;
  const flaky = {
    ...s.deps,
    blobs: {
      ...s.blobs,
      async put(key, value, opts) {
        if (/-draft\./.test(key)) { draftPuts += 1; throw new Error("R2 PutObject: 500 internal error"); }
        return s.blobs.put(key, value, opts);
      },
    },
  };

  // No throw: the batch completes on this single attempt.
  const r = await batchStep(flaky, PARAMS, 0, src.batchCount);
  assert.equal(prompts.length, 2, "one draft, then the repair call — completed in this attempt, not re-run");
  assert.equal(r.attempts, 2, "pass 1 drafted, pass 2 repaired");
  assert.equal(r.reused, false);
  assert.equal(r.calls, 2, "both the draft and the repair call are billed");
  assert.ok(draftPuts >= 3, "persistBilled's in-step retries still ran before giving up (was " + draftPuts + ")");
  assert.equal(s.blobs.map.has(keys.draft), false, "the draft never landed — the resume shortcut is simply forfeited");
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`), "the validated output is still persisted");
});

test("a stored draft that validates is promoted to the batch output, never re-bought, and still billed", async () => {
  const s = await scenario({ transport: async () => { throw new Error("the provider must not be called"); } });
  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  await steps.contextStep(s.deps, PARAMS, src.batchCount);
  const keys = storage.batchKeys(WS, JOB, "01");
  s.blobs.map.set(keys.draft, JSON.stringify({
    output: fixture(`${DRY}work/batch-01-out.tsv`),
    calls: [{ usage: { inputTokens: 5000, outputTokens: 3000 }, costUsd: 0.06, model: "claude-sonnet-5" }],
  }));

  const r = await batchStep(s.deps, PARAMS, 0, src.batchCount);
  assert.equal(r.reused, true);
  assert.equal(s.blobs.map.get(keys.output), fixture(`${DRY}work/batch-01-out.tsv`));
  // Promotion re-uses the draft; it does not make the draft free.
  assert.equal(r.calls, 1);
  assert.equal(r.inputTokens, 5000);
  assert.equal(r.costUsd, 0.06);
});

test("guardAndSourceStep normalizes an empty Occurrence to 0 before the source snapshot is written (#472)", async () => {
  // Every chapter has an N:intro row and upstream leaves its Occurrence empty
  // (verified against unfoldingWord/en_tn tn_ZEC.tsv, row 6:intro / tfbm).
  // occurrence-int asserts /^-?\\d+$/ unconditionally, so before this
  // normalization no tN chapter could pass checks: gemini-3.6-flash and
  // gemini-3.1-pro-preview both failed byte-identically on that row.
  const source = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:intro\ttfbm\t\t\t\t\t# Obadiah 1 Introduction\n1:1\tab12\t\t\tword\t1\tA real note\n";
  const s = await scenario({ source });

  const src = await steps.guardAndSourceStep(s.deps, PARAMS);
  assert.equal(src.rowCount, 2);

  const written = s.blobs.map.get(`pipeline-output/bsoj/job-1/work/batch-${storage.batchNn(0)}.tsv`);
  const rows = written.split("\n").filter(Boolean).slice(1).map((line) => line.split("\t"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0][1], "tfbm");
  assert.equal(rows[0][5], "0", "the intro row's empty Occurrence is normalized BEFORE the snapshot the prompt and checks both read");
  assert.equal(rows[1][5], "1", "a genuine Occurrence is passed through untouched");
});
