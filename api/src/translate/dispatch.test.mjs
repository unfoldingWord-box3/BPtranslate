// dispatch.ts: the runner decision, the Workflow params, and the synthesized
// status (design §D, step 5). All three are pure, so this file needs no D1 and
// no Workflows runtime — the wiring into dispatchNext/pollPipelineJob is proven
// separately against real SQLite in ../pipelineInternalRunner.test.mjs.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/dispatch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTranslateWorkflowParams,
  internalProviders,
  readInternalStatus,
  translateInstanceId,
  translateRunner,
} from "./dispatch.ts";

const CONFIGURED = { kind: "configured", provider: "claude", model: "claude-opus-5", ciphertext: "ct", iv: "iv" };
const TRANSLATE = { pipeline_type: "translate" };
const INTERNAL = { PIPELINE_MODE: "internal" };

// ---------------------------------------------------------------------------
// Gate table
// ---------------------------------------------------------------------------

test("translateRunner: the decision table, one row per gate", () => {
  // All four gates on — the ONLY internal row in this table.
  assert.equal(translateRunner(INTERNAL, TRANSLATE, CONFIGURED), "internal");

  // Gate 1 — PIPELINE_MODE.
  assert.equal(translateRunner({}, TRANSLATE, CONFIGURED), "proxy", "unset PIPELINE_MODE → proxy");
  assert.equal(translateRunner({ PIPELINE_MODE: "proxy" }, TRANSLATE, CONFIGURED), "proxy");
  assert.equal(translateRunner({ PIPELINE_MODE: "" }, TRANSLATE, CONFIGURED), "proxy");
  assert.equal(translateRunner({ PIPELINE_MODE: "Internal" }, TRANSLATE, CONFIGURED), "internal", "case-insensitive");
  assert.equal(translateRunner({ PIPELINE_MODE: " internal " }, TRANSLATE, CONFIGURED), "internal", "trimmed");
  assert.equal(
    translateRunner({ PIPELINE_MODE: "internal-ish" }, TRANSLATE, CONFIGURED),
    "proxy",
    "only the exact word opts in — no prefix/substring match",
  );

  // Gate 2 — pipeline_type. generate/notes/tqs have no in-Worker port at all.
  for (const t of ["generate", "notes", "tqs"]) {
    assert.equal(translateRunner(INTERNAL, { pipeline_type: t }, CONFIGURED), "proxy", `${t} → proxy`);
  }

  // Gate 3 — BYO key. There is no shared-subscription kind any more (#551):
  // anything but 'configured' is an 'error', which never reaches this point in
  // dispatchNext (the job fails first) and must read as proxy regardless.
  assert.equal(
    translateRunner(INTERNAL, TRANSLATE, { kind: "error", reason: "ai_provider_not_configured" }),
    "proxy",
    "no org key → proxy (dispatchNext fails the job before this matters)",
  );
  assert.equal(
    translateRunner(INTERNAL, TRANSLATE, { kind: "error", reason: "api_key_missing" }),
    "proxy",
    "unresolvable provider config → proxy",
  );

  // Gate 4 — provider allow-list.
  assert.equal(translateRunner(INTERNAL, TRANSLATE, { ...CONFIGURED, provider: "openai" }), "proxy");
  assert.equal(translateRunner(INTERNAL, TRANSLATE, { ...CONFIGURED, provider: "gemini" }), "proxy");
  assert.equal(translateRunner(INTERNAL, TRANSLATE, { ...CONFIGURED, provider: "xai" }), "proxy");
  assert.equal(
    translateRunner({ ...INTERNAL, PIPELINE_INTERNAL_PROVIDERS: "claude,openai" }, TRANSLATE, { ...CONFIGURED, provider: "openai" }),
    "internal",
    "an explicitly allow-listed provider opts in",
  );
  assert.equal(
    translateRunner({ ...INTERNAL, PIPELINE_INTERNAL_PROVIDERS: "" }, TRANSLATE, CONFIGURED),
    "proxy",
    "blanking the allow-list disables the internal runner on its own",
  );

  // Gate 5 - resource family. The internal runner has TSV steps only; the bot
  // translates tw/ta today, so an article job must keep going there or flipping
  // the flag would turn a working capability into a failed run. REMOVE WITH THE
  // GATE in phase 2, when article steps land.
  assert.equal(translateRunner(INTERNAL, TRANSLATE, CONFIGURED, { resourceType: "tn" }), "internal");
  assert.equal(translateRunner(INTERNAL, TRANSLATE, CONFIGURED, { resourceType: "tq" }), "internal", "tq is TSV too");
  assert.equal(translateRunner(INTERNAL, TRANSLATE, CONFIGURED, { resourceType: "tw" }), "proxy", "tw is an article family");
  assert.equal(translateRunner(INTERNAL, TRANSLATE, CONFIGURED, { resourceType: "ta" }), "proxy", "ta is an article family");
  assert.equal(
    translateRunner(INTERNAL, TRANSLATE, CONFIGURED, { resourceType: "bogus" }),
    "proxy",
    "an unrecognized resourceType is not a TSV resource either - fail closed to the bot",
  );
  assert.equal(
    translateRunner(INTERNAL, TRANSLATE, CONFIGURED, {}),
    "internal",
    "an absent resourceType is the tn pilot default, exactly as resolveParams reads it",
  );
});

test("internalProviders: unset means the default, set means exactly what is set", () => {
  assert.deepEqual([...internalProviders({})], ["claude"]);
  assert.deepEqual([...internalProviders({ PIPELINE_INTERNAL_PROVIDERS: " Claude , OpenAI " })], ["claude", "openai"]);
  assert.deepEqual([...internalProviders({ PIPELINE_INTERNAL_PROVIDERS: "" })], []);
  assert.deepEqual([...internalProviders({ PIPELINE_INTERNAL_PROVIDERS: " , ," })], []);
});

test("translateInstanceId is workspace-scoped", () => {
  assert.equal(translateInstanceId("bsoj", "job-1"), "translate-bsoj-job-1");
  assert.notEqual(translateInstanceId("bsoj", "job-1"), translateInstanceId("mltest", "job-1"));
});

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const JOB = { job_id: "job-1", user_id: 7, book: "OBA", start_chapter: 1, end_chapter: 1 };
const OPTIONS = {
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

function params(options = OPTIONS, job = JOB) {
  return buildTranslateWorkflowParams({
    job,
    options,
    workspace: "bsoj",
    provider: "claude",
    model: "claude-opus-5",
  });
}

test("buildTranslateWorkflowParams carries the whole job and nothing secret", () => {
  const p = params();
  assert.equal(p.jobId, "job-1");
  assert.equal(p.workspace, "bsoj", "workspace is REQUIRED — the Workflow re-points its env from it");
  assert.equal(p.userId, 7);
  assert.equal(p.resourceType, "tn");
  assert.equal(p.book, "OBA");
  assert.equal(p.startChapter, 1);
  assert.equal(p.endChapter, 1);
  assert.equal(p.targetLang, "ar");
  assert.equal(p.direction, "rtl");
  assert.equal(p.targetOrg, "BSOJ");
  assert.equal(p.sourceRef, "unfoldingWord/en_tn@master");
  assert.equal(p.literalRef, "BSOJ/ar_glt@master");
  assert.equal(p.simplifiedRef, "BSOJ/ar_gst@master");
  assert.equal(p.thinking, "medium");
  // provider + model are the ONLY provider fields; the key is re-read and
  // decrypted inside each batch step (design §B).
  assert.equal(p.provider, "claude");
  assert.equal(p.model, "claude-opus-5", "the provider's model id, not the bot's 'opus' alias");
});

test("buildTranslateWorkflowParams: NO plaintext key can reach Workflow params", () => {
  const SECRET = "sk-ant-api03-THIS-MUST-NEVER-BE-PERSISTED";
  // Even when the stored options are polluted with key-shaped fields — a bad
  // client, a future option, a copy-paste — nothing key-shaped survives, because
  // params are built field-by-field from resolveParams, never spread from input.
  const p = params({
    ...OPTIONS,
    apiKey: SECRET,
    key: SECRET,
    api_key: SECRET,
    authorization: `Bearer ${SECRET}`,
  });
  const serialized = JSON.stringify(p);
  assert.equal(serialized.includes(SECRET), false, "the secret's value does not appear anywhere in params");
  assert.equal(/sk-ant|Bearer /i.test(serialized), false, "no credential-shaped substring survives");
  for (const k of Object.keys(p)) {
    assert.equal(/key|secret|token|auth/i.test(k), false, `params carry no credential-shaped field (found "${k}")`);
  }
  // And the positive half of the claim: what DOES identify the provider.
  assert.deepEqual(
    Object.keys(p).filter((k) => k === "provider" || k === "model").sort(),
    ["model", "provider"],
  );
});

test("buildTranslateWorkflowParams resolves the fields the editor never stores", () => {
  const p = params();
  // Not in options_json (translateOptions.ts emits neither) — these must come
  // out as the bot's own fallbacks or the Workflow fetches the wrong repos.
  assert.equal(p.repoName, "ar_tn");
  assert.equal(p.sourceLiteralRef, "unfoldingWord/en_ult@master");
  assert.equal(p.sourceSimplifiedRef, "unfoldingWord/en_ust@master");
  // An explicit override still wins.
  const q = params({ ...OPTIONS, repoName: "ar_tn_pilot", sourceLiteralRef: "uW/en_ult@abc123" });
  assert.equal(q.repoName, "ar_tn_pilot");
  assert.equal(q.sourceLiteralRef, "uW/en_ult@abc123");
});

test("buildTranslateWorkflowParams does NOT promote the default contextRef to an explicit one", () => {
  // The regression this guards: resolveParams fills contextRef with
  // `${targetOrg}/translation-context@master` and records contextRefExplicit
  // false. Echoing that default back as a param would make the Workflow treat a
  // missing context repo as a hard failure instead of a warn-and-continue.
  assert.equal(params().contextRef, null, "an unset contextRef stays unset");
  assert.equal(
    params({ ...OPTIONS, contextRef: "BSOJ/translation-context@master" }).contextRef,
    "BSOJ/translation-context@master",
    "a caller-supplied contextRef is passed through",
  );
});

test("buildTranslateWorkflowParams carries the row/verse subset scope", () => {
  const p = params({ ...OPTIONS, rowIds: ["abc1", "def2"], verseStart: 3, verseEnd: 5 });
  assert.deepEqual(p.rowIds, ["abc1", "def2"]);
  assert.equal(p.verseStart, 3);
  assert.equal(p.verseEnd, 5);
  const whole = params();
  assert.equal(whole.rowIds, null);
  assert.equal(whole.verseStart, null);
  assert.equal(whole.verseEnd, null);
});

test("buildTranslateWorkflowParams throws on an unusable job rather than creating a doomed instance", () => {
  assert.throws(() => params({ ...OPTIONS, targetLang: "" }), /targetLang/);
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_JOB = {
  job_id: "job-1",
  pipeline_type: "translate",
  book: "OBA",
  start_chapter: 1,
  end_chapter: 1,
  wf_status_json: null,
};

const NOW = new Date("2026-09-15T12:00:00.000Z");

test("readInternalStatus: no status written yet reads as a freshly-started run", () => {
  const s = readInternalStatus(STATUS_JOB, NOW);
  assert.equal(s.state, "running", "pollPipelineJob must hold the row at running and poll again");
  assert.equal(s.jobId, "job-1");
  assert.equal(s.pipelineType, "translate");
  assert.deepEqual(s.scope, { book: "OBA", startChapter: 1, endChapter: 1 });
  assert.equal(s.updatedAt, NOW.toISOString());
  assert.equal(s.current, undefined);
  assert.equal(s.output, undefined, "no output → shouldImport stays false");
  assert.equal(s.interrupted, false);
});

test("readInternalStatus: a malformed or foreign column degrades to running, never to failed", () => {
  for (const bad of ["{not json", JSON.stringify({ state: "done" }), JSON.stringify({ runner: "bot", state: "done" })]) {
    const s = readInternalStatus({ ...STATUS_JOB, wf_status_json: bad }, NOW);
    assert.equal(s.state, "running", `"${bad.slice(0, 20)}" → running`);
    assert.equal(s.output, undefined);
  }
});

test("readInternalStatus: a running status surfaces skill/status for the progress chip", () => {
  const wf = {
    version: 1,
    runner: "internal",
    state: "running",
    current: { chapter: 1, skill: "translate-tn", status: "batch 3/11", startedAt: "2026-09-15T11:00:00.000Z" },
    updatedAt: "2026-09-15T11:30:00.000Z",
  };
  const s = readInternalStatus({ ...STATUS_JOB, wf_status_json: JSON.stringify(wf) }, NOW);
  assert.equal(s.state, "running");
  assert.equal(s.current.skill, "translate-tn");
  assert.equal(s.current.status, "batch 3/11");
  assert.equal(s.current.startedAt, "2026-09-15T11:00:00.000Z");
  assert.equal(s.updatedAt, "2026-09-15T11:30:00.000Z");
  assert.equal(s.createdAt, "2026-09-15T11:00:00.000Z", "the run's own start stands in for created_at");
});

test("readInternalStatus: a done status carries the editor-delivery manifest", () => {
  const wf = {
    version: 1,
    runner: "internal",
    state: "done",
    current: { chapter: 1, skill: "translate-tn", status: "done", startedAt: "2026-09-15T11:00:00.000Z" },
    updatedAt: "2026-09-15T11:45:00.000Z",
    output: [
      { delivery: "editor", type: "tn", repo: "BSOJ/ar_tn", path: "tn_OBA.tsv", file: "tn_OBA.tsv" },
      { delivery: "editor", type: "report", file: "translate-report-1-1.json" },
    ],
  };
  const s = readInternalStatus({ ...STATUS_JOB, wf_status_json: JSON.stringify(wf) }, NOW);
  assert.equal(s.state, "done");
  assert.equal(s.output.length, 2);
  assert.equal(s.output[0].delivery, "editor", "classify()/parseOutputEntry key on delivery + repo + file");
  assert.equal(s.output[0].repo, "BSOJ/ar_tn");
  assert.equal(s.output[0].file, "tn_OBA.tsv");
  assert.equal(s.output[1].type, "report", "the report sidecar keeps its type so import skips it");
  assert.equal(s.output[1].repo, "", "an entry with no repo is not dropped, just blank");
});

test("readInternalStatus: a failed status carries errorKind/error, and never sets interrupted", () => {
  const wf = {
    version: 1,
    runner: "internal",
    state: "failed",
    current: {
      chapter: 1,
      skill: "translate-tn",
      status: "failed",
      startedAt: "2026-09-15T11:00:00.000Z",
      errorKind: "invalid_key",
      error: "provider rejected the key",
    },
    updatedAt: "2026-09-15T11:10:00.000Z",
  };
  const s = readInternalStatus({ ...STATUS_JOB, wf_status_json: JSON.stringify(wf) }, NOW);
  assert.equal(s.state, "failed");
  assert.equal(s.current.errorKind, "invalid_key");
  assert.equal(s.current.error, "provider rejected the key");
  // The bot's interrupted sweep exists for a frozen checkpoint; the Workflow
  // engine owns liveness, so it must never fire here.
  assert.equal(s.interrupted, false);
});
