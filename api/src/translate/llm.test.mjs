// llm.ts: the direct LLM path with an injected transport — no network. Ports
// the deferred bp-assistant test/translate-llm.test.js cases (prompt, output
// extraction, error classification, truncation, secret hygiene, key presence,
// claude adapter shape) reshaped from the bot's file-based runTsvBatch to the
// in-memory runOne / runBatch, plus: the retryable-flag contract for every
// error class, a provider_not_supported_internal stub, and a replay of the 11
// recorded OBA batches through runBatch.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/llm.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import * as llm from "./llm.ts";
import * as core from "./core.ts";
import { parseTnTsv, sliceChapterRows } from "./tsvCodec.ts";
import { API_MODE_OVERRIDE, SKILL_BODIES } from "./prompts/index.ts";
import { fixture } from "./fixtures.mjs";

const HEADER = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
const ROW = "1:1\tab12\t\trc://*/ta/man/translate/figs-metaphor\tדְּבַר\t1\tترجمة";
const SRC_ROW = { Reference: "1:1", ID: "ab12", Tags: "", SupportReference: "rc://*/ta/man/translate/figs-metaphor", Quote: "דְּבַר", Occurrence: "1", Note: "the word" };
const KEY = "sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEY0001";

const resource = core.tsvResource("tn");

function wrapped(body) {
  return `Here you go.\n\n${llm.BEGIN_OUTPUT}\n${body}\n${llm.END_OUTPUT}\n`;
}

/** One batch's in-memory artifacts (what the Workflow would have built). */
function makeBatch(rows = [SRC_ROW], index = 0) {
  const art = core.buildBatchArtifacts(index, {
    batchRows: rows, packMarkdown: "# Context pack fixture\n\nPreferred: عهد\n",
    targetLang: "ar", targetLangName: "Arabic", direction: "rtl", book: "OBA", resource,
  });
  return { ...art, batchRows: rows };
}

function stubTransport(impl) {
  const calls = [];
  const transport = async (args) => {
    calls.push(args);
    return impl(args, calls.length);
  };
  return { calls, transport };
}

const deps = (over = {}) => ({ provider: "claude", model: "claude-sonnet-5", apiKey: KEY, thinking: "medium", ...over });
const ok = (body) => ({ text: wrapped(body), usage: { inputTokens: 10, outputTokens: 5 }, stopReason: "end_turn" });

/**
 * Every string reachable from a thrown value: own properties enumerable or not
 * (so `message` and `stack` count), array entries, and the whole `cause` chain.
 * A secret-hygiene assertion that reads only `err.message` cannot see a key
 * parked on `err.cause.stack` or on a custom property of a provider error.
 */
function reachableStrings(value, seen = new Set(), out = []) {
  if (value === null || value === undefined) return out;
  const t = typeof value;
  if (t === "string") { out.push(value); return out; }
  if (t === "function" || t === "symbol") return out;
  if (t !== "object") { out.push(String(value)); return out; }
  if (seen.has(value)) return out;
  seen.add(value);
  for (const k of ["name", "message", "stack", "cause"]) reachableStrings(value[k], seen, out);
  for (const k of Object.getOwnPropertyNames(value)) {
    let v;
    try { v = value[k]; } catch { continue; }
    reachableStrings(v, seen, out);
  }
  return out;
}
const leakedStrings = (value, secret) => reachableStrings(value).filter((str) => str.includes(secret));

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

test("buildTranslatePrompt uses the frontmatter-stripped skill body and appends the API mode override", () => {
  const { system } = llm.buildTranslatePrompt({ skill: "translate-tn", taskJson: "{}", packMarkdown: "pack", sourceText: "src" });
  assert.ok(!system.includes("description: Translate a batch"), "YAML frontmatter must not reach the model");
  assert.ok(!/^---/.test(system), "system must not start with a frontmatter fence");
  assert.ok(system.startsWith("# translate-tn — gateway-language translation of tN rows"), system.slice(0, 80));
  assert.ok(system.includes("## The iron rules"), "skill body must be preserved");
  assert.ok(system.includes("## API mode override (supersedes the Input/Output mechanics above)"));
  assert.ok(system.includes("There are no tools"));
  assert.ok(system.includes(llm.BEGIN_OUTPUT) && system.includes(llm.END_OUTPUT));
  assert.equal(system, `${SKILL_BODIES["translate-tn"]}\n\n${API_MODE_OVERRIDE}\n`);
});

test("buildTranslatePrompt inlines the task JSON, the pack and the source rows", () => {
  const { user } = llm.buildTranslatePrompt({
    skill: "translate-tn",
    taskJson: '{"task":"translate-tsv-batch","rowCount":1}',
    packMarkdown: "# Pack\n\nPreferred: عهد",
    sourceText: `${HEADER}\n${ROW}`,
  });
  assert.ok(user.includes('"task":"translate-tsv-batch"'));
  assert.ok(user.includes("Preferred: عهد"));
  assert.ok(user.includes(ROW), "the TSV rows must be inlined verbatim");
  assert.ok(user.includes("# Task JSON") && user.includes("# Context pack") && user.includes("# Source content"));
  assert.ok(user.includes("-----BEGIN TASK JSON-----") && user.includes("-----END SOURCE CONTENT-----"));
  assert.ok(!user.includes("# Previous output"));
  assert.ok(!user.includes("# Repair note"));
  assert.ok(user.endsWith(`Now emit the complete output file between ${llm.BEGIN_OUTPUT} and ${llm.END_OUTPUT}.`));
  // An object task is stringified like the bot's task file.
  const { user: fromObj } = llm.buildTranslatePrompt({ skill: "translate-tn", taskJson: { a: 1 }, packMarkdown: "", sourceText: "" });
  assert.ok(fromObj.includes('{\n  "a": 1\n}'));
});

test("buildTranslatePrompt repair mode inlines the previous output and the violations", () => {
  const { user } = llm.buildTranslatePrompt({
    skill: "translate-tn", taskJson: "{}", packMarkdown: "pack", sourceText: "src",
    previousOutput: `${HEADER}\nBROKEN ROW`,
    repairNote: "- [passthrough] row ab12: Quote column was translated",
  });
  assert.ok(user.includes("# Previous output"));
  assert.ok(user.includes("BROKEN ROW"));
  assert.ok(user.includes("# Repair note"));
  assert.ok(user.includes("Quote column was translated"));
});

test("an unknown skill throws an error naming it (bot: missing SKILL.md path)", () => {
  assert.throws(
    () => llm.buildTranslatePrompt({ skill: "no-such-skill", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    /unknown skill "no-such-skill"/,
  );
});

test("the user message carries logical artifact names, never absolute paths", () => {
  const batch = makeBatch();
  const { user } = llm.buildTranslatePrompt({ skill: "translate-tn", taskJson: batch.taskJson, packMarkdown: batch.packMarkdown, sourceText: batch.sourceTsv });
  assert.ok(user.includes('"batchFile": "batch-01.tsv"'));
  assert.ok(user.includes('"outputFile": "batch-01-out.tsv"'));
  assert.ok(!/[A-Za-z]:\\|\/Users\/|\/home\//.test(user), "no filesystem paths in the prompt");
});

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

test("extractOutput returns the text between the sentinels", () => {
  const body = `${HEADER}\n${ROW}`;
  assert.equal(llm.extractOutput(wrapped(body)), body);
});

test("extractOutput takes the LAST sentinel pair", () => {
  const text = `${llm.BEGIN_OUTPUT}\nfirst draft\n${llm.END_OUTPUT}\n`
    + `oops, corrected:\n${llm.BEGIN_OUTPUT}\nsecond draft\n${llm.END_OUTPUT}\n`;
  assert.equal(llm.extractOutput(text), "second draft");
});

test("extractOutput preserves fenced code blocks inside the sentinels (tA articles)", () => {
  const article = '# Title\n\nSee this:\n\n```json\n{"a": 1}\n```\n\nAnd more prose.';
  assert.equal(llm.extractOutput(wrapped(article)), article);
});

test("extractOutput falls back to stripping a single outer fence", () => {
  assert.equal(llm.extractOutput("```tsv\nA\tB\n1\t2\n```"), "A\tB\n1\t2");
  assert.equal(llm.extractOutput("```\nplain\n```"), "plain");
});

test("extractOutput falls back to the raw trimmed text", () => {
  assert.equal(llm.extractOutput("\n  A\tB\n1\t2\n  "), "A\tB\n1\t2");
});

test("extractOutput returns empty string for empty sentinel bodies", () => {
  assert.equal(llm.extractOutput(`${llm.BEGIN_OUTPUT}\n\n${llm.END_OUTPUT}`), "");
  assert.equal(llm.extractOutput(""), "");
  assert.equal(llm.extractOutput(null), "");
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const CASES = [
  ["anthropic 401 authentication_error", { status: 401, error: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }, "invalid_key"],
  ["openai 401 invalid_api_key", { status: 401, error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, "invalid_key"],
  ["gemini PERMISSION_DENIED", { status: 403, message: '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"API key not valid"}}' }, "invalid_key"],
  ["anthropic 404 model", { status: 404, error: { error: { type: "not_found_error", message: "model: bogus" } } }, "model_not_found"],
  ["openai 404 model_not_found", { status: 404, error: { message: "The model `bogus` does not exist", code: "model_not_found" } }, "model_not_found"],
  ["gemini NOT_FOUND", { message: '{"error":{"status":"NOT_FOUND","message":"models/bogus is not found"}}' }, "model_not_found"],
  ["anthropic 429", { status: 429, error: { error: { type: "rate_limit_error", message: "rate limit" } } }, "rate_limited"],
  ["gemini RESOURCE_EXHAUSTED", { status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }, "rate_limited"],
  ["anthropic 529 overloaded", { status: 529, error: { error: { type: "overloaded_error", message: "Overloaded" } } }, "provider_overloaded"],
  ["anthropic 500 api_error", { status: 500, error: { error: { type: "api_error", message: "Internal server error" } } }, "provider_overloaded"],
  ["xai 503", { status: 503, error: { message: "service unavailable" } }, "provider_overloaded"],
  ["gemini UNAVAILABLE", { status: 503, message: '{"error":{"status":"UNAVAILABLE","message":"The model is overloaded"}}' }, "provider_overloaded"],
  ["openai 400 context length", { status: 400, error: { message: "This model's maximum context length is 200000 tokens" } }, "context_too_long"],
  ["anthropic 400 prompt too long", { status: 400, error: { error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } } }, "context_too_long"],
  ["abort", { name: "AbortError", message: "The operation was aborted" }, "timeout"],
  ["socket timeout", { message: "Request timed out." }, "timeout"],
  ["unclassified 400", { status: 400, error: { message: "messages: unexpected role" } }, "provider_error"],
];

for (const [label, err, expected] of CASES) {
  test(`classifyProviderError maps ${label} → ${expected}`, () => {
    assert.equal(llm.classifyProviderError(err).code, expected);
  });
}

test("classifyProviderError reads Retry-After from a header object and a Headers-like", () => {
  assert.equal(llm.classifyProviderError({ status: 429, headers: { "Retry-After": "42" } }).retryAfterSeconds, 42);
  const headers = new Map([["retry-after", "7"]]);
  assert.equal(llm.classifyProviderError({ status: 429, headers }).retryAfterSeconds, 7);
  assert.equal(llm.classifyProviderError({ status: 529, headers: new Headers({ "retry-after": "3" }) }).retryAfterSeconds, 3);
});

test("classifyProviderError reads a Gemini retryDelay out of the body", () => {
  const err = { status: 429, message: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"17s"}]}}' };
  assert.equal(llm.classifyProviderError(err).retryAfterSeconds, 17);
});

const NETWORK_CASES = [
  ["ECONNRESET via err.cause.code", { message: "Connection error.", cause: { code: "ECONNRESET" } }],
  ["ECONNREFUSED via err.cause.code", { message: "fetch failed", cause: { code: "ECONNREFUSED" } }],
  ["EAI_AGAIN via err.code", { message: "getaddrinfo failed", code: "EAI_AGAIN" }],
  ["EPIPE via err.code", { message: "write EPIPE", code: "EPIPE" }],
  ["UND_ERR_SOCKET via err.cause.code", { message: "fetch failed", cause: { code: "UND_ERR_SOCKET" } }],
];

for (const [label, err] of NETWORK_CASES) {
  test(`classifyProviderError maps ${label} → network_error`, () => {
    assert.equal(llm.classifyProviderError(err).code, "network_error");
  });
}

test("the two retry buckets are disjoint and cover every code", () => {
  const all = [...llm.RETRYABLE_CODES, ...llm.NON_RETRYABLE_CODES];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...llm.RETRYABLE_CODES].sort(), ["network_error", "provider_overloaded", "rate_limited", "timeout"]);
  assert.deepEqual([...llm.NON_RETRYABLE_CODES].sort(),
    ["checks_failed", "context_too_long", "empty_output", "invalid_key", "model_not_found", "output_too_long", "provider_error", "provider_not_supported_internal"]);
  for (const c of llm.RETRYABLE_CODES) assert.equal(llm.isRetryableCode(c), true);
  for (const c of llm.NON_RETRYABLE_CODES) assert.equal(llm.isRetryableCode(c), false);
  assert.equal(llm.isRetryableCode("constructor"), false);
});

// ---------------------------------------------------------------------------
// Transport errors → TranslateProviderError with the right retryable flag
// ---------------------------------------------------------------------------

const THROWN = [
  ["invalid_key", false, { status: 401, error: { error: { type: "authentication_error", message: "invalid x-api-key" } } }],
  ["model_not_found", false, { status: 404, error: { error: { type: "not_found_error", message: "model: bogus" } } }],
  ["context_too_long", false, { status: 400, error: { error: { type: "invalid_request_error", message: "prompt is too long" } } }],
  ["provider_error", false, { status: 400, error: { error: { type: "invalid_request_error", message: "messages: unexpected role" } } }],
  ["rate_limited", true, { status: 429, headers: { "retry-after": "9" }, error: { error: { type: "rate_limit_error", message: "rate limit" } } }],
  ["provider_overloaded", true, { status: 529, error: { error: { type: "overloaded_error", message: "Overloaded" } } }],
  ["timeout", true, { name: "TimeoutError", message: "Request timed out." }],
  ["network_error", true, { message: "fetch failed", cause: { code: "ECONNRESET" } }],
];

for (const [code, retryable, shape] of THROWN) {
  test(`a transport error classified ${code} surfaces retryable=${retryable} and never carries the key`, async () => {
    let thrown = null;
    const { calls, transport } = stubTransport(() => {
      const e = new Error(`${shape.message || shape.error?.error?.message} for key ${KEY}`);
      Object.assign(e, shape, { message: e.message });
      thrown = e;
      throw e;
    });
    await assert.rejects(
      llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "p", sourceText: "s" }),
      (err) => {
        assert.ok(err instanceof llm.TranslateProviderError);
        assert.equal(err.code, code);
        assert.equal(err.errorKind, code);
        assert.equal(err.retryable, retryable);
        assert.equal(err.provider, "claude");
        assert.ok(err.message.startsWith(`claude ${code}: `), err.message);
        assert.ok(!err.message.includes(KEY), `key leaked: ${err.message}`);
        assert.ok(err.message.includes("[redacted]"), `scrubbed marker present: ${err.message}`);
        assert.ok(err.cause instanceof Error, "a cause is still attached for debugging");
        assert.notEqual(err.cause, thrown, "but never the raw provider error object");
        assert.deepEqual(leakedStrings(err, KEY), [], "the key is reachable somewhere on the thrown error");
        assert.equal(err.status, shape.status ?? undefined);
        assert.equal(err.llmCalls, undefined, "no billed call to account for when the transport itself failed");
        if (code === "rate_limited") assert.equal(err.retryAfterSeconds, 9);
        return true;
      },
    );
    assert.equal(calls.length, 1, "no in-process retry: the Workflow step owns retries");
  });
}

test("a transport that hangs past the budget is a retryable timeout (AbortSignal fired)", async () => {
  const { calls, transport } = stubTransport(({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  }));
  await assert.rejects(
    llm.runOne(deps({ transport, timeoutMs: 20 }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "p", sourceText: "s" }),
    (err) => err.code === "timeout" && err.retryable === true && /no response within 0s/.test(err.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 20, "budget is passed to the transport");
});

// ---------------------------------------------------------------------------
// runOne: model / key / truncation / empty output
// ---------------------------------------------------------------------------

test("an unknown model fails as model_not_found without calling the transport", async () => {
  const { calls, transport } = stubTransport(() => { throw new Error("must not be reached"); });
  await assert.rejects(
    llm.runOne(deps({ transport, model: "claude-sonnet-4-6" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "model_not_found" && err.provider === "claude" && err.retryable === false,
  );
  assert.equal(calls.length, 0);
});

test("a call with no apiKey throws invalid_key without touching the transport", async () => {
  const { calls, transport } = stubTransport(() => { throw new Error("must not be reached — no key means no client"); });
  await assert.rejects(
    llm.runOne(deps({ transport, apiKey: null }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "invalid_key" && err.provider === "claude",
  );
  assert.equal(calls.length, 0);
});

test("an alias resolves to the concrete catalog id before the call", async () => {
  const { calls, transport } = stubTransport(() => ok("OUT"));
  const { output, call } = await llm.runOne(deps({ transport, model: "claude-haiku-4-5" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.equal(output, "OUT\n");
  assert.equal(calls[0].model, "claude-haiku-4-5-20251001");
  assert.equal(call.model, "claude-haiku-4-5-20251001");
  assert.equal(calls[0].apiKey, KEY, "the key reaches the transport and nothing else");
});

test("a truncating stop reason becomes output_too_long, per provider table", () => {
  assert.deepEqual(llm.TRUNCATED_STOP_REASONS, { claude: ["max_tokens"], openai: ["max_output_tokens"], xai: ["length"], gemini: ["MAX_TOKENS"] });
});

test("output_too_long with reasoning enabled retries once at LOW effort, not with thinking omitted (F1)", async () => {
  // Deviation from translate-llm.js: omitting `thinking` on Opus 5 / Sonnet 5
  // runs adaptive at default effort high, so the bot's "retry without
  // reasoning" retried with MORE thinking. The retry keeps adaptive and lowers
  // effort to low; the discarded draft's usage is still accounted for.
  const { calls, transport } = stubTransport((args, n) => {
    if (n === 1) {
      assert.equal(args.thinking, "medium");
      return { text: wrapped("partial"), usage: { inputTokens: 1000, outputTokens: 32000 }, stopReason: "max_tokens" };
    }
    return ok(`${HEADER}\n${ROW}`);
  });
  const { output, call, discardedCalls } = await llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].thinking, llm.TRUNCATION_RETRY_THINKING);
  assert.equal(llm.TRUNCATION_RETRY_THINKING, "low");
  assert.equal(output, `${HEADER}\n${ROW}\n`);
  assert.equal(call.model, "claude-sonnet-5");
  assert.equal(discardedCalls.length, 1);
  assert.deepEqual(discardedCalls[0].usage, { inputTokens: 1000, outputTokens: 32000 });
  assert.equal(discardedCalls[0].costUsd, 1000 / 1e6 * 2 + 32000 / 1e6 * 10);
});

test("output_too_long: no low-effort retry when the draft already ran at low or without thinking (F1)", async () => {
  for (const thinking of ["low", "none", null]) {
    const { calls, transport } = stubTransport(() => ({ text: wrapped("partial"), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "max_tokens" }));
    await assert.rejects(
      llm.runOne(deps({ transport, thinking }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
      (err) => err.code === "output_too_long" && err.retryable === false && /32000 tokens/.test(err.message) && err.llmCalls.length === 1,
      String(thinking),
    );
    assert.equal(calls.length, 1, `thinking=${thinking}: same request would only truncate again`);
  }
});

test("output_too_long: no retry for Haiku 4.5 (no adaptive thinking to lower)", async () => {
  const { calls, transport } = stubTransport(() => ({ text: wrapped("partial"), usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "max_tokens" }));
  await assert.rejects(
    llm.runOne(deps({ transport, model: "claude-haiku-4-5" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "output_too_long",
  );
  assert.equal(calls.length, 1);
});

test("output_too_long after the low-effort retry reports BOTH billed calls (F3)", async () => {
  const { calls, transport } = stubTransport(() => ({ text: wrapped("partial"), usage: { inputTokens: 100, outputTokens: 32000 }, stopReason: "max_tokens" }));
  await assert.rejects(
    llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => {
      assert.equal(err.code, "output_too_long");
      assert.equal(err.llmCalls.length, 2);
      assert.equal(err.llmCalls[0].usage.outputTokens + err.llmCalls[1].usage.outputTokens, 64000);
      assert.equal(err.llmCalls[1].model, "claude-sonnet-5");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("a reply with no extractable output becomes empty_output (non-retryable)", async () => {
  const { transport } = stubTransport(() => ({ text: `${llm.BEGIN_OUTPUT}\n   \n${llm.END_OUTPUT}`, usage: {}, stopReason: "end_turn" }));
  await assert.rejects(
    llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "empty_output" && err.retryable === false,
  );
});

test("runOne prices the call off the catalog and reports the resolved model", async () => {
  const { transport } = stubTransport(() => ({ text: wrapped("OUT"), usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, stopReason: "end_turn" }));
  const { call } = await llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.deepEqual(call.usage, { inputTokens: 1_000_000, outputTokens: 100_000 });
  assert.equal(call.costUsd, 3.0); // Sonnet 5: $2 + $1
  const acc = llm.newLlmUsage("claude", null);
  llm.addLlmCall(acc, call);
  llm.addLlmCall(acc, { usage: { inputTokens: 1, outputTokens: 1 }, costUsd: null, model: "claude-sonnet-5" });
  assert.deepEqual(acc, { provider: "claude", model: "claude-sonnet-5", inputTokens: 1_000_001, outputTokens: 100_001, estimatedCostUsd: 3.0, calls: 2 });
  assert.equal(llm.newLlmUsage("claude", "x").estimatedCostUsd, null, "missing price stays visible as null, not $0");
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

test("the API key never reaches a thrown message, even unpatterned", async () => {
  const key = "zzz-unpatterned-key-0123456789abcdef";
  const { transport } = stubTransport(() => { const e = new Error(`Bad request for key ${key} on tenant`); e.status = 400; throw e; });
  await assert.rejects(
    llm.runOne(deps({ transport, apiKey: key }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => {
      assert.ok(!err.message.includes(key), `key leaked: ${err.message}`);
      assert.deepEqual(leakedStrings(err, key), [], "the key is reachable somewhere on the thrown error");
      assert.ok(err.message.startsWith("claude provider_error: "), err.message);
      assert.ok(err.message.includes("[redacted]"));
      return true;
    },
  );
});

// Removable ONLY by literal scrubbing: no sk-ant/sk- prefix, and no
// credential-named `KEY=` separator in the surrounding text, so a passing
// assertion proves the literal pass ran rather than a pattern happening to fire.
const RAW_KEY = "zzz-unpatterned-key-0123456789abcdef";
const hygieneInput = { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" };

test("secret hygiene: a provider that echoes the key in its message leaks it nowhere on the thrown error", async () => {
  class ProviderTransportError extends Error {}
  let thrown = null;
  const { transport } = stubTransport(() => {
    thrown = Object.assign(new ProviderTransportError(`401 authentication_error: invalid x-api-key ${RAW_KEY}`), { status: 401 });
    throw thrown;
  });
  await assert.rejects(
    llm.runOne(deps({ transport, apiKey: RAW_KEY }), hygieneInput),
    (err) => {
      assert.ok(leakedStrings(thrown, RAW_KEY).length > 0, "fixture sanity: the raw error really does carry the key");
      assert.deepEqual(leakedStrings(err, RAW_KEY), [], "the key is reachable somewhere on the thrown error");
      assert.equal(err.code, "invalid_key");
      assert.equal(err.errorKind, "invalid_key");
      assert.equal(err.retryable, false);
      assert.equal(err.status, 401);
      assert.notEqual(err.cause, thrown, "the raw provider error is never attached");
      assert.equal(err.cause.name, "ProviderTransportError", "the class name survives for debugging");
      assert.ok(err.cause.message.includes("[redacted]"), err.cause.message);
      return true;
    },
  );
});

test("secret hygiene: a key buried in a nested cause never travels with the error", async () => {
  let thrown = null;
  const { transport } = stubTransport(() => {
    const socket = Object.assign(new Error(`socket hang up while authenticating with ${RAW_KEY}`),
      { code: "ECONNRESET", requestHeaders: { "x-api-key": RAW_KEY } });
    thrown = new Error("fetch failed", { cause: socket });
    throw thrown;
  });
  await assert.rejects(
    llm.runOne(deps({ transport, apiKey: RAW_KEY }), hygieneInput),
    (err) => {
      assert.ok(leakedStrings(thrown, RAW_KEY).length > 0, "fixture sanity: the raw error really does carry the key");
      assert.deepEqual(leakedStrings(err, RAW_KEY), [], "the key is reachable somewhere on the thrown error");
      assert.equal(err.code, "network_error");
      assert.equal(err.retryable, true);
      assert.ok(err.cause instanceof Error);
      assert.equal(err.cause.cause, undefined, "the foreign cause chain is dropped, not re-attached");
      return true;
    },
  );
});

test("secret hygiene: a key on a custom property of the provider error never travels", async () => {
  let thrown = null;
  const { transport } = stubTransport(() => {
    thrown = Object.assign(new Error("Overloaded"), {
      status: 529,
      headers: { "retry-after": "7" },
      request: { headers: { authorization: `Bearer ${RAW_KEY}` }, url: `https://api.example/v1?k=${RAW_KEY}` },
    });
    throw thrown;
  });
  await assert.rejects(
    llm.runOne(deps({ transport, apiKey: RAW_KEY }), hygieneInput),
    (err) => {
      assert.ok(leakedStrings(thrown, RAW_KEY).length > 0, "fixture sanity: the raw error really does carry the key");
      assert.deepEqual(leakedStrings(err, RAW_KEY), [], "the key is reachable somewhere on the thrown error");
      assert.equal(err.code, "provider_overloaded");
      assert.equal(err.retryable, true);
      assert.equal(err.status, 529);
      assert.equal(err.retryAfterSeconds, 7);
      assert.equal(err.cause.request, undefined, "no foreign property is copied onto the cause");
      return true;
    },
  );
});

test("scrubSecrets redacts known key patterns", () => {
  const out = llm.scrubSecrets("key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA and xai-BBBBBBBBBBBBBBBBBB");
  assert.ok(!out.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA"));
  assert.ok(!out.includes("xai-BBBBBBBBBBBBBBBBBB"));
});

test("scrubSecrets redacts hyphenated modern key shapes (sk-proj-…, xai- hyphenated)", () => {
  const out = llm.scrubSecrets("key=sk-proj-AbC-123_456789012345678901 and xai-AbC-1234567890123456");
  assert.ok(!out.includes("sk-proj-AbC-123_456789012345678901"));
  assert.ok(!out.includes("xai-AbC-1234567890123456"));
});

test("redactSecretPatterns covers the run-logs.js shapes: github, google, jwt, auth header, KEY=value", () => {
  const out = llm.redactSecretPatterns([
    "ghp_ABCDEFGHIJKLMNOPQRSTUV", "github_pat_ABCDEFGHIJKLMNOPQRSTUVWX",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ", "eyJabcdefghijk.eyJabcdefghijk.abcdefghijklmn",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz", 'x "api_key": "supersecretvalue1"', "DCS_TOKEN=abcdefgh12345678",
  ].join("\n"));
  assert.ok(!/ghp_ABCDEFGHIJKLMNOPQRSTUV|github_pat_ABCDEFGHIJKLMNOPQRSTUVWX|AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(out), out);
  assert.ok(!/eyJabcdefghijk\.eyJabcdefghijk|Bearer abcdefghijklmnopqrstuvwxyz|supersecretvalue1|abcdefgh12345678/.test(out), out);
  assert.ok(out.includes('"api_key": "[redacted]') && out.includes("DCS_TOKEN=[redacted]"), out);
  assert.equal(llm.scrubSecrets("", ["x"]), "");
  assert.equal(llm.scrubSecrets("short key 1234567 stays", ["1234567"]), "short key 1234567 stays", "literal removal needs >= 8 chars");
});

// ---------------------------------------------------------------------------
// Adapter map
// ---------------------------------------------------------------------------

test("claude and gemini have in-Worker adapters; other providers fail closed, non-retryable, before any call", async () => {
  assert.equal(llm.hasInternalAdapter("claude"), true);
  assert.equal(llm.hasInternalAdapter("gemini"), true);
  for (const p of ["openai", "xai", "default", "constructor"]) {
    assert.equal(llm.hasInternalAdapter(p), false, p);
    assert.throws(() => llm.transportFor(p), (err) => err.code === "provider_not_supported_internal" && err.retryable === false && err.provider === p);
  }
  await assert.rejects(
    llm.runOne({ provider: "openai", model: "gpt-5.5", apiKey: KEY }, { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "provider_not_supported_internal",
  );
});

test("claude adapter streams, maps effort, passes the key per call with maxRetries 0, and reads usage", async () => {
  let seen = null;
  let seenOpts = null;
  let ctor = null;
  const client = {
    messages: {
      stream(params, opts) {
        seen = params;
        seenOpts = opts;
        return {
          finalMessage: async () => ({
            content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: wrapped("OUT") }],
            usage: { input_tokens: 11, output_tokens: 22 },
            stop_reason: "end_turn",
          }),
        };
      },
    },
  };
  const transport = llm.makeClaudeTransport((opts) => { ctor = opts; return client; });
  const { output, call } = await llm.runOne(deps({ transport, thinking: "high", timeoutMs: 5000 }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "p", sourceText: "s" });
  assert.equal(output, "OUT\n");
  assert.deepEqual(call.usage, { inputTokens: 11, outputTokens: 22 });
  assert.deepEqual(ctor, { apiKey: KEY, timeout: 5000, maxRetries: 0 });
  assert.equal(seen.model, "claude-sonnet-5");
  assert.equal(seen.max_tokens, 32000);
  assert.ok(seen.system.includes("API mode override"));
  assert.deepEqual(seen.thinking, { type: "adaptive" });
  assert.deepEqual(seen.output_config, { effort: "high" });
  assert.equal(seen.messages.length, 1);
  assert.deepEqual(seen.messages[0], { role: "user", content: seen.messages[0].content });
  assert.ok(seen.messages[0].content.includes("# Task JSON"));
  assert.ok(seenOpts.signal instanceof AbortSignal, "the per-call abort signal is handed to the SDK");
  assert.ok(!("temperature" in seen) && !("stream" in seen), "no sampling params; streaming is the method, not a flag");
});

test("claude adapter omits thinking/effort for Haiku 4.5 and with thinking 'none'; maps xhigh/max to high", async () => {
  const seen = [];
  const client = { messages: { stream(params) { seen.push(params); return { finalMessage: async () => ({ content: [{ type: "text", text: wrapped("OUT") }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }) }; } } };
  const transport = llm.makeClaudeTransport(() => client);
  await llm.runOne(deps({ transport, model: "claude-haiku-4-5", thinking: "medium" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.ok(!("thinking" in seen[0]) && !("output_config" in seen[0]), "Haiku 4.5 rejects adaptive thinking/effort");
  await llm.runOne(deps({ transport, thinking: "none" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.ok(!("thinking" in seen[1]) && !("output_config" in seen[1]));
  await llm.runOne(deps({ transport, thinking: "max" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.deepEqual(seen[2].output_config, { effort: "high" });
  await llm.runOne(deps({ transport, thinking: "bogus-level" }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });
  assert.deepEqual(seen[3].output_config, { effort: "medium" }, "unknown level falls back to medium like the bot");
});

test("claude adapter: a stop_reason of max_tokens surfaces as output_too_long after a retry at adaptive + effort low (F1)", async () => {
  const seen = [];
  const client = { messages: { stream(params) { seen.push(params); return { finalMessage: async () => ({ content: [{ type: "text", text: wrapped("partial") }], usage: { input_tokens: 1, output_tokens: 32000 }, stop_reason: "max_tokens" }) }; } } };
  const transport = llm.makeClaudeTransport(() => client);
  await assert.rejects(
    llm.runOne(deps({ transport }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" }),
    (err) => err.code === "output_too_long",
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].thinking, { type: "adaptive" });
  assert.deepEqual(seen[0].output_config, { effort: "medium" });
  assert.deepEqual(seen[1].thinking, { type: "adaptive" }, "retry keeps adaptive thinking (omitting it would mean default effort high)");
  assert.deepEqual(seen[1].output_config, { effort: "low" }, "retry lowers effort instead of disabling thinking");
});

// ---------------------------------------------------------------------------
// Real SDK error objects through the adapter's classification path (F2/F8)
// ---------------------------------------------------------------------------

function failingClient(err) {
  return { messages: { stream() { throw err; } } };
}
function streamRejectingClient(err) {
  return { messages: { stream() { return { finalMessage: async () => { throw err; } }; } } };
}
const runViaClient = (client, over = {}) => llm.runOne(deps({ transport: llm.makeClaudeTransport(() => client), ...over }), { skill: "translate-tn", taskJson: "{}", packMarkdown: "", sourceText: "" });

test("SDK RateLimitError (429 + Retry-After) → rate_limited, retryable, retryAfterSeconds read from Headers", async () => {
  const body = { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your rate limit" } };
  const err = new Anthropic.RateLimitError(429, body, "429 rate limit", new Headers({ "retry-after": "12" }));
  assert.ok(err instanceof Anthropic.APIError);
  await assert.rejects(runViaClient(failingClient(err)), (e) => {
    assert.equal(e.code, "rate_limited");
    assert.equal(e.retryable, true);
    assert.equal(e.status, 429);
    assert.equal(e.retryAfterSeconds, 12);
    assert.notEqual(e.cause, err, "the SDK error object itself is never attached");
    assert.equal(e.cause.name, "RateLimitError", "its class name survives on the rebuilt cause");
    return true;
  });
});

test("SDK APIUserAbortError → timeout, retryable", async () => {
  await assert.rejects(runViaClient(streamRejectingClient(new Anthropic.APIUserAbortError())), (e) => e.code === "timeout" && e.retryable === true);
});

test("SDK AuthenticationError / NotFoundError / InternalServerError → invalid_key / model_not_found / provider_overloaded", async () => {
  const mk = (Cls, status, type, message) => new Cls(status, { type: "error", error: { type, message } }, message, new Headers());
  await assert.rejects(runViaClient(failingClient(mk(Anthropic.AuthenticationError, 401, "authentication_error", "invalid x-api-key"))), (e) => e.code === "invalid_key" && !e.retryable);
  await assert.rejects(runViaClient(failingClient(mk(Anthropic.NotFoundError, 404, "not_found_error", "model: claude-sonnet-5"))), (e) => e.code === "model_not_found" && !e.retryable);
  await assert.rejects(runViaClient(failingClient(mk(Anthropic.InternalServerError, 529, "overloaded_error", "Overloaded"))), (e) => e.code === "provider_overloaded" && e.retryable);
  await assert.rejects(runViaClient(failingClient(mk(Anthropic.InternalServerError, 500, "api_error", "Internal server error"))), (e) => e.code === "provider_overloaded" && e.retryable && e.status === 500);
});

test("HTTP 413 request_too_large → context_too_long (F2)", async () => {
  const err = Anthropic.APIError.generate(413, { type: "error", error: { type: "request_too_large", message: "Request exceeds the maximum size" } }, "413", new Headers());
  assert.equal(err.status, 413);
  await assert.rejects(runViaClient(failingClient(err)), (e) => e.code === "context_too_long" && e.retryable === false && e.status === 413);
  assert.equal(llm.classifyProviderError({ status: 413, message: "request too large" }).code, "context_too_long");
});

test("mid-stream drop: MessageStream-wrapped AnthropicError with the undici code two causes deep → network_error, retryable (F2)", async () => {
  // MessageStream.js:53-55 wraps a foreign error as AnthropicError(message) with cause = the raw TypeError,
  // and undici parks its code on THAT error's cause: err.cause.cause.code.
  const raw = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
  const wrapped = new Anthropic.AnthropicError(raw.message);
  wrapped.cause = raw;
  await assert.rejects(runViaClient(streamRejectingClient(wrapped)), (e) => {
    assert.equal(e.code, "network_error");
    assert.equal(e.retryable, true);
    assert.equal(e.status, undefined);
    assert.ok(e.message.includes("fetch failed") && e.message.includes("other side closed"), e.message);
    return true;
  });
  assert.equal(llm.classifyProviderError({ message: "x", cause: { cause: { cause: { code: "ECONNRESET" } } } }).code, "network_error");
});

test("mid-stream drop: code-less workerd / SDK-reader messages → network_error, retryable (F2)", async () => {
  for (const msg of [
    "Network connection lost.",
    "terminated",
    "stream ended without producing a Message with role=assistant",
    "request ended without sending any chunks",
  ]) {
    const err = new Anthropic.AnthropicError(msg);
    await assert.rejects(runViaClient(streamRejectingClient(err)), (e) => e.code === "network_error" && e.retryable === true, msg);
    assert.equal(llm.classifyProviderError(err).code, "network_error", msg);
  }
  // With a status the same words are NOT reinterpreted as a network drop.
  assert.equal(llm.classifyProviderError({ status: 400, message: "terminated" }).code, "provider_error");
  // An SDK APIConnectionError carries its cause; still network.
  const conn = new Anthropic.APIConnectionError({ message: "Connection error.", cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  assert.equal(llm.classifyProviderError(conn).code, "network_error");
  assert.equal(llm.classifyProviderError(new Anthropic.APIConnectionTimeoutError()).code, "timeout");
});

// ---------------------------------------------------------------------------
// Discarded-call accounting (F3)
// ---------------------------------------------------------------------------

test("runBatch counts the discarded truncated draft in llmCalls and calls, separately from attempts (F3)", async () => {
  const batch = makeBatch();
  const { calls, transport } = stubTransport((args, n) => (n === 1
    ? { text: wrapped("partial"), usage: { inputTokens: 700, outputTokens: 32000 }, stopReason: "max_tokens" }
    : { text: wrapped(`${HEADER}\n${ROW}`), usage: { inputTokens: 700, outputTokens: 300 }, stopReason: "end_turn" }));
  const res = await llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" });
  assert.equal(res.attempts, 1, "one validated draft/repair pass");
  assert.equal(res.calls, 2, "two billed provider calls");
  assert.equal(calls.length, 2);
  assert.equal(res.llmCalls.length, 2);
  assert.deepEqual(res.llmCalls.map((c) => c.usage.outputTokens), [32000, 300]);
  const usage = llm.newLlmUsage("claude", "claude-sonnet-5");
  for (const c of res.llmCalls) llm.addLlmCall(usage, c);
  assert.equal(usage.calls, 2);
  assert.equal(usage.outputTokens, 32300);
  assert.ok(Math.abs(usage.estimatedCostUsd - ((1400 / 1e6) * 2 + (32300 / 1e6) * 10)) < 1e-9, String(usage.estimatedCostUsd));
});

test("checks_failed and empty_output carry every billed call on the error (F3)", async () => {
  const batch = makeBatch();
  const { transport } = stubTransport(() => ok(`${HEADER}\n1:1\tzz99\t\t\tx\t1\tترجمة`));
  await assert.rejects(llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" }), (err) => err.code === "checks_failed" && err.llmCalls.length === 2);
  const empty = stubTransport(() => ({ text: `${llm.BEGIN_OUTPUT}\n\n${llm.END_OUTPUT}`, usage: { inputTokens: 5, outputTokens: 1 }, stopReason: "end_turn" }));
  await assert.rejects(llm.runBatch(deps({ transport: empty.transport }), batch, { resource, skill: "translate-tn" }), (err) => err.code === "empty_output" && err.llmCalls.length === 1 && err.llmCalls[0].usage.inputTokens === 5);
  // A transport failure on the repair pass still reports the first (billed) draft.
  const flaky = stubTransport((args, n) => { if (n === 1) return ok(`${HEADER}\n1:1\tzz99\t\t\tx\t1\tترجمة`); const e = new Error("Overloaded"); e.status = 529; throw e; });
  await assert.rejects(llm.runBatch(deps({ transport: flaky.transport }), batch, { resource, skill: "translate-tn" }), (err) => err.code === "provider_overloaded" && err.retryable && err.llmCalls.length === 1);
});

// ---------------------------------------------------------------------------
// runBatch: draft + repair loop
// ---------------------------------------------------------------------------

test("runBatch returns validated rows on a clean first draft (attempts=1)", async () => {
  const batch = makeBatch();
  const { calls, transport } = stubTransport(() => ok(`${HEADER}\n${ROW}`));
  const res = await llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" });
  assert.equal(res.attempts, 1);
  assert.equal(res.calls, 1);
  assert.ok(res.checks.ok);
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].Note, "ترجمة");
  assert.equal(res.outputText, `${HEADER}\n${ROW}\n`);
  assert.equal(res.llmCalls.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].user.includes(batch.sourceTsv.trimEnd()), "the batch TSV is the source content");
  assert.ok(calls[0].user.includes('"batchFile": "batch-01.tsv"'));
});

test("runBatch repairs once with the violations + previous output inlined (attempts=2)", async () => {
  const batch = makeBatch();
  // First draft mangles the row ID (a missing-row + extra-row pair). Note: an
  // EMPTY final column cannot be used here — its trailing tab is whitespace,
  // extractOutput strips it, and the row fails to parse (bot parity).
  const broken = `${HEADER}\n1:1\tzz99\t\trc://*/ta/man/translate/figs-metaphor\tדְּבַר\t1\tترجمة`;
  const { calls, transport } = stubTransport((args, n) => (n === 1 ? ok(broken) : ok(`${HEADER}\n${ROW}`)));
  const res = await llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" });
  assert.equal(res.attempts, 2);
  assert.equal(res.llmCalls.length, 2);
  assert.ok(res.checks.ok);
  const repair = calls[1].user;
  assert.ok(repair.includes("# Previous output"));
  assert.ok(repair.includes("# Repair note"));
  assert.ok(repair.includes("Your previous output FAILED deterministic validation. Violations:"));
  assert.ok(repair.includes("- [missing-row] row ab12: source row has no target row"));
  assert.ok(repair.includes("- [extra-row] row zz99: target row has no source row"));
  assert.ok(repair.includes(`-----BEGIN PREVIOUS OUTPUT-----\n${broken}\n-----END PREVIOUS OUTPUT-----`), "previous output inlined verbatim");
  assert.ok(repair.includes("Rewrite batch-01-out.tsv fixing every violation. Translate ONLY these columns: Note. Every other column must be byte-identical to the source."));
  assert.ok(!calls[0].user.includes("# Repair note"));
});

test("runBatch fails checks_failed (non-retryable) after the repair pass, with the violation summary", async () => {
  const batch = makeBatch();
  const { calls, transport } = stubTransport(() => ok(`${HEADER}\n1:1\tzz99\t\t\tx\t1\tترجمة`)); // wrong ID every time
  await assert.rejects(
    llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" }),
    (err) => {
      assert.ok(err instanceof llm.TranslateProviderError);
      assert.equal(err.code, "checks_failed");
      assert.equal(err.retryable, false);
      assert.match(err.message, /^batch 01 still failing deterministic checks after repair pass: \[missing-row\] ab12: source row has no target row; \[extra-row\] zz99/);
      assert.ok(!err.message.includes(KEY));
      return true;
    },
  );
  assert.equal(calls.length, llm.MAX_BATCH_ATTEMPTS);
});

test("runBatch heals a re-normalized pass-through cell instead of failing it", async () => {
  const batch = makeBatch();
  const drifted = `${HEADER}\n1:1\tab12\t\trc://*/ta/man/translate/figs-metaphor\tדְּבַרּ\t1\tترجمة`; // Quote + dagesh
  const { transport } = stubTransport(() => ok(drifted));
  const res = await llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" });
  assert.equal(res.attempts, 1);
  assert.equal(res.rows[0].Quote, SRC_ROW.Quote, "copy-back restores the source bytes");
});

test("runBatch hands onFailedDraft the draft's own billed calls, and a resume bills them again", async () => {
  const batch = makeBatch();
  const broken = `${HEADER}
1:1	zz99		rc://*/ta/man/translate/figs-metaphor	דְּבַר	1	ترجمة`;

  // Pass 1: the draft fails checks, so the loop hands it to onFailedDraft
  // BEFORE the repair call. What it hands over is what the caller can store.
  const drafts = [];
  const first = stubTransport(() => ok(broken));
  await assert.rejects(llm.runBatch(deps({ transport: first.transport }), batch, {
    resource, skill: "translate-tn",
    onFailedDraft: async (output, checks, calls) => { drafts.push({ output, checks, calls }); },
  }), (err) => err.code === "checks_failed");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].output, `${broken}
`);
  assert.equal(drafts[0].calls.length, 1, "the draft's price travels with the draft");
  assert.equal(drafts[0].calls[0].usage.inputTokens, 10);

  // Pass 2, on a fresh step: resuming enters at the repair pass and buys ONE
  // call — but the ledger it reports is two, because the org paid for two.
  const second = stubTransport(() => ok(`${HEADER}
${ROW}`));
  const res = await llm.runBatch(deps({ transport: second.transport }), batch, {
    resource, skill: "translate-tn",
    resume: { output: drafts[0].output, checks: drafts[0].checks, calls: drafts[0].calls },
  });
  assert.equal(second.calls.length, 1, "the resumed run buys the repair pass only");
  assert.equal(res.attempts, 2);
  assert.equal(res.calls, 2, "…and reports the inherited draft as billed, because it was");
  assert.equal(res.llmCalls.length, 2);
  assert.equal(res.llmCalls.reduce((n, c) => n + c.usage.inputTokens, 0), 20);

  // `resume.calls` is optional at this boundary, and an omitted ledger counts
  // only what this call bought. That is a defensive default, NOT an accepted
  // under-count: the Workflow caller stores a draft and its ledger in one R2
  // object (storage.batchKeys `draft`), so it cannot hand runBatch a resumed
  // draft whose price it has lost.
  const third = stubTransport(() => ok(`${HEADER}
${ROW}`));
  const bare = await llm.runBatch(deps({ transport: third.transport }), batch, {
    resource, skill: "translate-tn",
    resume: { output: drafts[0].output, checks: drafts[0].checks },
  });
  assert.equal(bare.calls, 1);
});

test("runBatch propagates a transport failure unchanged (no repair pass on provider errors)", async () => {
  const batch = makeBatch();
  const { calls, transport } = stubTransport(() => { const e = new Error("Overloaded"); e.status = 529; throw e; });
  await assert.rejects(llm.runBatch(deps({ transport }), batch, { resource, skill: "translate-tn" }), (err) => err.code === "provider_overloaded" && err.retryable === true);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Replay: the 11 recorded OBA batches through runBatch
// ---------------------------------------------------------------------------

test("runBatch replays all 11 recorded OBA batches: attempts=1, pass-through byte-identical, one priced call each", async () => {
  const DRY = "dry-run-ar-OBA/";
  const sourceRows = sliceChapterRows(parseTnTsv(fixture("tn_OBA.tsv")), 1, 1);
  const batches = core.buildBatches(sourceRows, { sizeOf: resource.sizeOf });
  assert.equal(batches.length, 11);
  const passThrough = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence"];
  const usage = llm.newLlmUsage("claude", "claude-sonnet-5");
  const merged = [];

  for (let i = 0; i < batches.length; i++) {
    const nn = String(i + 1).padStart(2, "0");
    const recordedOut = fixture(`${DRY}work/batch-${nn}-out.tsv`);
    const art = core.buildBatchArtifacts(i, {
      batchRows: batches[i], packMarkdown: fixture(`${DRY}work/batch-${nn}-pack.md`),
      targetLang: "ar", targetLangName: "Arabic", direction: "rtl", book: "OBA", resource,
    });
    assert.equal(art.sourceTsv, fixture(`${DRY}work/batch-${nn}.tsv`), `batch ${nn} source bytes`);

    const { calls, transport } = stubTransport(({ user }) => {
      // The model saw exactly the recorded batch as its source content.
      assert.ok(user.includes(art.sourceTsv.trimEnd()), `batch ${nn} prompt carries the source TSV`);
      return { text: wrapped(recordedOut.trimEnd()), usage: { inputTokens: 5000, outputTokens: 3000 }, stopReason: "end_turn" };
    });
    const res = await llm.runBatch(deps({ transport }), { ...art, batchRows: batches[i] }, { resource, skill: "translate-tn" });

    assert.equal(res.attempts, 1, `batch ${nn} needed no repair`);
    assert.equal(calls.length, 1, `batch ${nn} one LLM call`);
    assert.ok(res.checks.ok, `batch ${nn}: ${JSON.stringify(res.checks.errors.slice(0, 2))}`);
    assert.equal(res.outputText, recordedOut, `batch ${nn} output text is the recorded file`);
    assert.equal(res.rows.length, batches[i].length);
    for (let r = 0; r < res.rows.length; r++) {
      for (const col of passThrough) assert.equal(res.rows[r][col], batches[i][r][col], `batch ${nn} row ${batches[i][r].ID} ${col}`);
    }
    for (const call of res.llmCalls) llm.addLlmCall(usage, call);
    merged.push(...res.rows);
  }

  assert.equal(usage.calls, 11);
  assert.equal(usage.inputTokens, 55000);
  assert.ok(Math.abs(usage.estimatedCostUsd - (11 * (5000 / 1e6 * 2 + 3000 / 1e6 * 10))) < 1e-9, String(usage.estimatedCostUsd));
  const book = core.mergeChapterIntoBook(null, merged, { startChapter: 1, endChapter: 1, parse: resource.codec.parse, serialize: resource.codec.serialize });
  assert.equal(book, fixture(`${DRY}tn_OBA.tsv`), "merged book byte-identical to the recorded run");
});

// ---------------------------------------------------------------------------
// Gemini adapter (plain fetch)
// ---------------------------------------------------------------------------

const GKEY = "AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY01";
const GURL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

const geminiReply = (over = {}) => JSON.stringify({
  candidates: [{ content: { parts: over.parts ?? [{ text: "OUT" }] }, finishReason: over.finishReason ?? "STOP" }],
  usageMetadata: over.usage ?? { promptTokenCount: 7, candidatesTokenCount: 3 },
});

/** Records the one fetch and replies with the given body (default: a clean 200). */
function geminiSpy(reply = {}) {
  const seen = { url: null, init: null };
  const transport = llm.makeGeminiTransport(async (url, init) => {
    seen.url = url;
    seen.init = init;
    return new Response(reply.body ?? geminiReply(reply), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers || {}) },
    });
  });
  return { seen, transport };
}

const greq = (over = {}) => ({
  provider: "gemini", model: "gemini-3.6-flash", system: "SYS", user: "USER",
  thinking: "high", apiKey: GKEY, timeoutMs: 5000, ...over,
});

test("gemini adapter: POSTs to :generateContent with the key in the header, never the URL", async () => {
  const { seen, transport } = geminiSpy();
  const out = await transport(greq());

  assert.equal(seen.url, GURL);
  assert.ok(!seen.url.includes(GKEY), "the key must never ride the URL — request lines get logged");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["x-goog-api-key"], GKEY);
  assert.equal(seen.init.headers["content-type"], "application/json");
  assert.ok(seen.init.signal instanceof AbortSignal, "every call is abortable");

  assert.deepEqual(out, { text: "OUT", usage: { inputTokens: 7, outputTokens: 3 }, stopReason: "STOP" });
});

test("gemini request body: thinkingConfig is nested INSIDE generationConfig, not beside it", () => {
  // The whole point of this assertion: the SDK takes a flat config, the wire
  // format does not. At the top level Gemini ignores the thinking setting
  // silently — a wrong answer we still pay for, with nothing to notice.
  assert.deepEqual(llm.buildGeminiRequest({ model: "gemini-3.6-flash", system: "SYS", user: "USER", thinking: "high" }), {
    systemInstruction: { parts: [{ text: "SYS" }] },
    contents: [{ role: "user", parts: [{ text: "USER" }] }],
    generationConfig: { maxOutputTokens: 32000, thinkingConfig: { thinkingLevel: "high" } },
  });
});

test("gemini request body: 3.x takes thinkingLevel, 2.5 takes a token budget, 'none' takes neither", () => {
  const gen = (over) => llm.buildGeminiRequest({ model: "gemini-3.6-flash", system: "S", user: "U", thinking: "high", ...over }).generationConfig;

  assert.deepEqual(gen({ thinking: "high" }).thinkingConfig, { thinkingLevel: "high" });
  assert.deepEqual(gen({ thinking: "max" }).thinkingConfig, { thinkingLevel: "high" },
    "xhigh/max collapse to high like every other provider");
  assert.deepEqual(gen({ thinking: "bogus" }).thinkingConfig, { thinkingLevel: "medium" },
    "unknown level falls back to medium like the bot");

  // 2.5 is budget-shaped and indexed by the RAW level, so xhigh keeps its own
  // budget rather than collapsing onto high's.
  assert.deepEqual(gen({ model: "gemini-2.5-pro", thinking: "medium" }).thinkingConfig, { thinkingBudget: 4096 });
  assert.deepEqual(gen({ model: "gemini-2.5-pro", thinking: "xhigh" }).thinkingConfig, { thinkingBudget: 32768 });
  assert.deepEqual(gen({ model: "gemini-2.5-pro", thinking: "bogus" }).thinkingConfig, { thinkingBudget: 4096 });

  assert.ok(!("thinkingConfig" in gen({ thinking: "none" })), "'none' sends no thinking config at all");
  assert.ok(!("thinkingConfig" in gen({ thinking: null })));
  assert.equal(gen({ thinking: "none" }).maxOutputTokens, 32000, "the output cap is unconditional");
});

test("gemini adapter: joins multi-part text, drops empty parts, and survives a reply with nothing in it", async () => {
  const many = geminiSpy({ parts: [{ text: "A" }, { thought: true }, { text: "" }, { text: "B" }] });
  assert.equal((await many.transport(greq())).text, "AB");

  const bare = geminiSpy({ body: "{}" });
  assert.deepEqual(await bare.transport(greq()), { text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "unknown" });
});

test("gemini adapter: a MAX_TOKENS finish reason is the one the truncation guard looks for", async () => {
  const { transport } = geminiSpy({ finishReason: "MAX_TOKENS" });
  const out = await transport(greq());
  assert.ok(llm.TRUNCATED_STOP_REASONS.gemini.includes(out.stopReason),
    "stopReason must match TRUNCATED_STOP_REASONS.gemini or output_too_long never fires");
});

test("gemini adapter: a non-2xx reply throws the shape classifyProviderError already reads", async () => {
  const denied = geminiSpy({ status: 403, body: '{"error":{"code":403,"status":"PERMISSION_DENIED","message":"API key not valid"}}' });
  const err = await denied.transport(greq()).then(() => null, (e) => e);
  assert.equal(err.status, 403);
  assert.ok(err.message.includes("PERMISSION_DENIED"), "the raw body is the message");
  assert.equal(llm.classifyProviderError(err).code, "invalid_key");

  const limited = geminiSpy({ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"17s"}]}}' });
  const rate = await limited.transport(greq()).then(() => null, (e) => e);
  assert.deepEqual(llm.classifyProviderError(rate), { code: "rate_limited", status: 429, retryAfterSeconds: 17 });

  const busy = geminiSpy({ status: 503, body: '{"error":{"status":"UNAVAILABLE"}}' });
  assert.equal(llm.classifyProviderError(await busy.transport(greq()).then(() => null, (e) => e)).code, "provider_overloaded");

});

test("gemini adapter: a 2xx carrying a non-JSON body is retryable, not a permanently failed batch", async () => {
  // An intermediary returning an HTML error page under a 200, or a truncated
  // body that still read as complete, is transport corruption — not a decision
  // the provider made. Classifying it provider_error would burn a paid batch on
  // a gateway blip, so the throw carries NO status and lands in network_error.
  const junk = geminiSpy({ body: "<html>502 Bad Gateway</html>" });
  const bad = await junk.transport(greq()).then(() => null, (e) => e);
  assert.ok(bad.message.includes("unparseable reply"), bad.message);
  assert.equal(bad.status, undefined, "attaching the 2xx would misclassify it as a provider decision");

  const { code } = llm.classifyProviderError(bad);
  assert.equal(code, "network_error");
  assert.equal(llm.isRetryableCode(code), true, "the Workflow step must get to retry this");
});

test("gemini adapter: a rate limit reports Retry-After from the header, not just the body", async () => {
  // The adapter attaches the live Headers to the thrown error precisely so
  // parseRetryAfter can read this branch; the body-regex branch was already
  // covered by the Anthropic-era rows.
  const limited = geminiSpy({ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}', headers: { "retry-after": "30" } });
  const err = await limited.transport(greq()).then(() => null, (e) => e);
  assert.deepEqual(llm.classifyProviderError(err), { code: "rate_limited", status: 429, retryAfterSeconds: 30 });
});

test("gemini adapter: a hung request aborts on timeoutMs and classifies as a retryable timeout", async () => {
  const transport = llm.makeGeminiTransport((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const err = await transport(greq({ timeoutMs: 20 })).then(() => null, (e) => e);
  assert.equal(err.name, "TimeoutError");
  assert.equal(llm.classifyProviderError(err).code, "timeout");
});

test("gemini adapter: the caller's own abort signal cancels the request, before and during the call", async () => {
  const seen = [];
  // A fake that behaves like real fetch on an already-aborted signal: reject
  // now rather than wait for an "abort" event that has already fired.
  const transport = llm.makeGeminiTransport((_url, init) => {
    seen.push(init.signal);
    return new Promise((_resolve, reject) => {
      if (init.signal.aborted) return reject(init.signal.reason);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });

  const mid = new AbortController();
  const inflight = transport(greq({ signal: mid.signal, timeoutMs: 60_000 }));
  mid.abort(new DOMException("caller went away", "AbortError"));
  const err = await inflight.then(() => null, (e) => e);
  assert.equal(err.name, "AbortError");
  assert.equal(llm.classifyProviderError(err).code, "timeout");

  assert.equal(seen.length, 1);
  const already = AbortSignal.abort(new DOMException("gone", "AbortError"));
  await transport(greq({ signal: already })).then(() => null, () => {});
  assert.equal(seen[1].aborted, true, "a signal already aborted is honoured before the fetch is awaited");
});

test("gemini adapter runs end to end through runOne", async () => {
  const { seen, transport } = geminiSpy({ parts: [{ text: wrapped("ROW") }], usage: { promptTokenCount: 11, candidatesTokenCount: 22 } });
  const { output, call } = await llm.runOne(
    deps({ provider: "gemini", model: "gemini-3.6-flash", apiKey: GKEY, transport, thinking: "medium" }),
    { skill: "translate-tn", taskJson: "{}", packMarkdown: "p", sourceText: "s" },
  );
  assert.equal(output, "ROW\n");
  assert.deepEqual(call.usage, { inputTokens: 11, outputTokens: 22 });

  const sent = JSON.parse(seen.init.body);
  assert.ok(sent.systemInstruction.parts[0].text.includes("API mode override"));
  assert.ok(sent.contents[0].parts[0].text.includes("# Task JSON"));
  assert.ok(!JSON.stringify(sent).includes(GKEY), "the key is never in the request body");
});

test("gemini adapter: thinking tokens are counted as output, not silently dropped", async () => {
  // Gemini reports thinking separately from the visible answer, but bills both
  // as output. Reading candidatesTokenCount alone under-reports the org's cost
  // on every thinking run — the bot's bug, deliberately not reproduced here.
  const { transport } = geminiSpy({
    usage: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 20000, totalTokenCount: 20015 },
  });
  assert.deepEqual((await transport(greq())).usage, { inputTokens: 10, outputTokens: 20005 });

  const noThinking = geminiSpy({ usage: { promptTokenCount: 10, candidatesTokenCount: 5 } });
  assert.deepEqual((await noThinking.transport(greq())).usage, { inputTokens: 10, outputTokens: 5 },
    "a reply with no thinking block is unaffected");
});

test("gemini adapter: a content-filter block says so, instead of surfacing as empty_output", async () => {
  // Both shapes: blocked before generation (promptFeedback, no candidate) and
  // blocked during it (a candidate carrying only a finishReason). Either way
  // the old behaviour was "no output between the sentinel markers", which reads
  // as a prompt bug and sends the operator to the wrong place.
  const upfront = geminiSpy({ body: JSON.stringify({
    promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "violence" },
    usageMetadata: { promptTokenCount: 900 },
  }) });
  const a = await upfront.transport(greq()).then(() => null, (e) => e);
  assert.match(a.message, /blocked by Gemini content filters: SAFETY \(violence\)/);

  const midway = geminiSpy({ parts: [], finishReason: "PROHIBITED_CONTENT" });
  const b = await midway.transport(greq()).then(() => null, (e) => e);
  assert.match(b.message, /blocked by Gemini content filters: PROHIBITED_CONTENT/);

  // A plain empty reply is NOT a block and must keep flowing to empty_output.
  const bare = geminiSpy({ body: "{}" });
  assert.deepEqual(await bare.transport(greq()), { text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "unknown" });

  // Nor is a truncated reply: MAX_TOKENS has its own retry path.
  const cut = geminiSpy({ parts: [], finishReason: "MAX_TOKENS" });
  assert.equal((await cut.transport(greq())).stopReason, "MAX_TOKENS");
});

test("gemini adapter: an API key echoed back in an error body never survives callProvider", async () => {
  // makeGeminiTransport throws the RAW body as the message by design, so the
  // scrubbing that protects it lives one layer up. This asserts the seam: a
  // provider that echoes the key back must not leave it anywhere reachable on
  // the error that escapes.
  const echoed = geminiSpy({ status: 400, body: JSON.stringify({ error: { message: `bad key ${GKEY}` } }) });
  const err = await llm.callProvider(echoed.transport, {
    provider: "gemini", model: "gemini-3.6-flash", system: "S", user: "U", thinking: "medium", apiKey: GKEY,
  }).then(() => null, (e) => e);

  assert.ok(err instanceof llm.TranslateProviderError);
  assert.deepEqual(leakedStrings(err, GKEY), [], "the key is reachable somewhere on the thrown error");
});
