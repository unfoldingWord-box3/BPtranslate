// Guard for AI-studio error copy (issue #471, follow-up to #475).
//
// A failed pipeline job carries a machine-readable errorKind. The server writes
// it as a plain string (api/src/translate/workflowSteps.ts, llm.ts, and
// api/src/pipelines.ts), and the AI studio turns it into a sentence through
// ERROR_COPY_KEY (web/src/lib/aiErrorCopy.ts). A kind with no entry falls back
// to "Unrecognized error: {kind}", a raw enum in front of a translator. #471
// was exactly that for the internal translate runner.
//
// TypeScript keeps ERROR_COPY_KEY exhaustive over the PipelineErrorKind union,
// but the union is hand-maintained and the server types errorKind as string, so
// a new server kind compiles and still falls through. This test ties the sides
// together by reading the server source, the one place the kinds are defined:
//
//  1. every errorKind literal the server can write has an ERROR_COPY_KEY entry;
//  2. every ERROR_COPY_KEY entry has copy in BOTH en.json and ar.json
//     (check-i18n's orphan scan only sees literal t("…") calls, not these);
//  3. errorCopy() falls back safely for an unknown kind, including names that
//     exist on Object.prototype ("constructor", "toString").
//
// If a "parser rot" assertion fails, a server file changed shape: update the
// regex here AND re-check that it still finds every kind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ERROR_COPY_KEY, adminKeyWarningCopyKey, errorCopy, orgKeyStatusCopyKey } from "./aiErrorCopy.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiSrc = path.resolve(webRoot, "..", "api", "src");
const readWeb = (rel) => readFileSync(path.join(webRoot, rel), "utf8");
// Strip comments so a note that mentions a kind can't be parsed as one. Uses
// TypeScript's own parser and printer (removeComments), so strings, template
// literals and regex literals are all understood and no real code is dropped.
// The printer keeps string/template text as written and normalizes spacing,
// which the \s* in the patterns below already allows for.
const printer = ts.createPrinter({ removeComments: true });
function strip(src, file = "x.ts") {
  return printer.printFile(ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
}

const FIX_HINT =
  "Add the kind to the PipelineErrorKind union (web/src/sync/api.ts) and to ERROR_COPY_KEY " +
  "(web/src/lib/aiErrorCopy.ts), then write translator-facing copy under " +
  '"aiStudio.errors.<kind>" in BOTH web/src/i18n/locales/en.json and ar.json (#471).';

function apiSourceFiles(dir = apiSrc) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...apiSourceFiles(p));
    else if (ent.name.endsWith(".ts") && !ent.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const KIND = "([a-z][a-z0-9_]*)";
// Every way the server writes a literal errorKind onto a job row or status.
const KIND_PATTERNS = [
  new RegExp(`new TranslateStepError\\(\\s*"${KIND}"`, "g"), // workflowSteps.ts step failures
  new RegExp(`errorKind:\\s*"${KIND}"`, "g"), // object literals (catch-all, poll sweeps)
  new RegExp(`\\bfail\\(\\s*"${KIND}"`, "g"), // pipelines.ts dispatchNext's fail(kind, msg)
  new RegExp(`error_kind\\s*=\\s*'${KIND}'`, "g"), // SQL sweeps in pipelines.ts
  new RegExp(`_ERROR_KIND\\s*=\\s*"${KIND}"`, "g"), // named kind constants
];

function parseServerEmittedKinds() {
  const kinds = new Map(); // kind -> first file that writes it
  const hits = KIND_PATTERNS.map(() => 0);
  for (const file of apiSourceFiles()) {
    const src = strip(readFileSync(file, "utf8"));
    KIND_PATTERNS.forEach((re, i) => {
      for (const m of src.matchAll(re)) {
        hits[i]++;
        if (!kinds.has(m[1])) kinds.set(m[1], path.relative(apiSrc, file));
      }
    });
  }
  // Every pattern family must still match something, so a regex that stops
  // matching (the server code changed shape) fails here instead of silently
  // dropping that family's kinds.
  KIND_PATTERNS.forEach((re, i) => {
    assert.ok(hits[i] > 0, `Parser rot: pattern ${re} matched nothing in api/src`);
  });
  // llm.ts provider codes reach the row as `errorKind: err.code`.
  const llm = strip(readFileSync(path.join(apiSrc, "translate", "llm.ts"), "utf8"));
  for (const setName of ["RETRYABLE_CODES", "NON_RETRYABLE_CODES"]) {
    const m = llm.match(new RegExp(`${setName} = new Set\\(\\[([\\s\\S]*?)\\]`));
    assert.ok(m, `Parser rot: ${setName} not found in api/src/translate/llm.ts`);
    for (const q of m[1].matchAll(new RegExp(`"${KIND}"`, "g"))) if (!kinds.has(q[1])) kinds.set(q[1], "translate/llm.ts");
  }
  // One known kind per pattern family, so a silent regex miss can't pass.
  for (const known of ["workspace_unknown", "merge_shrink_refused", "internal_error", "lane_fenced", "pipeline_api_disabled", "interrupted", "rate_limited"]) {
    assert.ok(kinds.has(known), `Parser rot: expected server kind "${known}" was not found in api/src`);
  }
  return kinds;
}

function localeErrors(rel) {
  const errors = JSON.parse(readWeb(rel))?.aiStudio?.errors;
  assert.ok(errors && typeof errors === "object", `${rel}: aiStudio.errors object missing`);
  return errors;
}

test("comment stripping keeps code after regex and string literals", () => {
  const src = [
    'const r = /https?:\\/\\//; fail("kind_a", x);',
    'const q = /[^"]*/; const h = "*/*"; fail("kind_b", x);',
    '// fail("kind_c", x);',
    '/* fail("kind_d", x); */',
  ].join("\n");
  const kinds = [...strip(src).matchAll(/\bfail\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ["kind_a", "kind_b"]);
});

test("every errorKind the server can write has AI-studio copy", () => {
  const serverKinds = parseServerEmittedKinds();
  const unmapped = [...serverKinds]
    .filter(([k]) => !Object.hasOwn(ERROR_COPY_KEY, k))
    .map(([k, file]) => `${k} (${file})`)
    .sort();
  assert.deepEqual(
    unmapped,
    [],
    `The server can write errorKind(s) with no ERROR_COPY_KEY entry, so the AI studio shows ` +
      `"Unrecognized error: {kind}" for them: ${unmapped.join(", ")}. ${FIX_HINT}`,
  );
});

test("every ERROR_COPY_KEY entry has copy in both en and ar", () => {
  const en = localeErrors("src/i18n/locales/en.json");
  const ar = localeErrors("src/i18n/locales/ar.json");
  for (const [kind, i18nKey] of Object.entries(ERROR_COPY_KEY)) {
    assert.equal(i18nKey, `aiStudio.errors.${kind}`, `ERROR_COPY_KEY["${kind}"] should be aiStudio.errors.${kind}`);
    assert.ok(typeof en[kind] === "string" && en[kind].length > 0, `en.json missing aiStudio.errors.${kind}`);
    assert.ok(typeof ar[kind] === "string" && ar[kind].length > 0, `ar.json missing aiStudio.errors.${kind}`);
  }
});

test("errorCopy falls back to the unrecognized-error copy for an unknown kind", () => {
  const t = (key, opts) => (opts ? `${key}|${opts.kind}` : key);
  assert.equal(errorCopy("merge_failed_typo", t), "aiStudio.unrecognizedError|merge_failed_typo");
  assert.equal(errorCopy(null, t), "aiStudio.unrecognizedError|null");
  // Object.prototype names must not resolve to a function and reach t().
  for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(errorCopy(k, t), `aiStudio.unrecognizedError|${k}`, k);
  }
  assert.equal(errorCopy("rate_limited", t), "aiStudio.errors.rate_limited");
});

// #678: sdk_error's copy says "retrying usually fixes this", which is wrong when
// the dispatch POST was refused with a 4xx (pipelines.ts writes
// "upstream <status>: …" / "upstream <status> (body unreadable)"): the same
// request gets the same refusal. Those get provider_error's "check the AI
// settings; retrying won't help" copy. 408 and 429 are 4xx but do clear on a
// retry, so they keep the generic copy.
test("errorCopy: sdk_error refused upstream with a 4xx says retrying won't help", () => {
  const t = (key, opts) => (opts ? `${key}|${opts.kind}` : key);
  const refused = "aiStudio.errors.provider_error";
  const generic = "aiStudio.errors.sdk_error";
  assert.equal(errorCopy("sdk_error", t, 'upstream 400: {"error":"model_not_found"}'), refused);
  assert.equal(errorCopy("sdk_error", t, "upstream 404 (body unreadable)"), refused);
  assert.equal(errorCopy("sdk_error", t, "upstream 401: unauthorized"), refused);
  // Retryable or not a 4xx: unchanged.
  assert.equal(errorCopy("sdk_error", t, "upstream 429: slow down"), generic);
  assert.equal(errorCopy("sdk_error", t, "upstream 408 (body unreadable)"), generic);
  assert.equal(errorCopy("sdk_error", t, "upstream 503: unavailable"), generic);
  assert.equal(errorCopy("sdk_error", t, "translate_workflow_create_failed: boom"), generic);
  assert.equal(errorCopy("sdk_error", t, "upstream 4000: not a status"), generic);
  assert.equal(errorCopy("sdk_error", t, null), generic);
  assert.equal(errorCopy("sdk_error", t), generic);
  // Only sdk_error is reworded; another kind with a 4xx-looking message is not.
  assert.equal(errorCopy("auth_error", t, "upstream 401: nope"), "aiStudio.errors.auth_error");
});

// #551 part E: the AI-studio banner says "No AI key" only when the org has no
// key. A stored-but-unusable key gets the job-failure copy instead.
test("orgKeyStatusCopyKey: no-key reasons vs. unusable-key reasons", () => {
  assert.equal(orgKeyStatusCopyKey(null), null, "available → no banner");
  assert.equal(orgKeyStatusCopyKey("ai_provider_not_configured"), "preferences.aiService.noKey");
  assert.equal(orgKeyStatusCopyKey("api_key_missing"), "preferences.aiService.noKey");
  assert.equal(orgKeyStatusCopyKey("ai_provider_key_decrypt_failed"), ERROR_COPY_KEY.ai_provider_key_decrypt_failed);
  assert.equal(orgKeyStatusCopyKey("ai_key_encryption_unavailable"), ERROR_COPY_KEY.ai_provider_unavailable);
  assert.equal(orgKeyStatusCopyKey("model_missing"), ERROR_COPY_KEY.ai_provider_unavailable);
  assert.equal(orgKeyStatusCopyKey("something_new"), null, "unknown reason → no banner, not a wrong one");
});

// #551 part F: the admin AI service section showed "Configured" for a stored
// key that no longer decrypts (wrapping secret rotated). It now reads the same
// status probe and warns, but only about what it doesn't already show.
test("adminKeyWarningCopyKey: warn only for a stored key the probe says can't be used", () => {
  const down = (reason) => ({ available: false, reason });
  assert.equal(
    adminKeyWarningCopyKey(true, down("ai_provider_key_decrypt_failed")),
    ERROR_COPY_KEY.ai_provider_key_decrypt_failed,
    "the rotated-secret case",
  );
  assert.equal(adminKeyWarningCopyKey(true, down("model_missing")), ERROR_COPY_KEY.ai_provider_unavailable);
  assert.equal(adminKeyWarningCopyKey(true, { available: true, reason: null }), null, "usable key → no warning");
  assert.equal(adminKeyWarningCopyKey(true, null), null, "probe not back yet, or failed → no warning");
  assert.equal(adminKeyWarningCopyKey(false, down("ai_provider_not_configured")), null, "no key → the section's own noKey line");
  // publicShape's `configured` only needs key_ciphertext; resolveDispatchAi
  // also needs key_iv and says api_key_missing without it. The settings then
  // read "Configured" while every run fails, so it gets the re-enter warning.
  assert.equal(
    adminKeyWarningCopyKey(true, down("api_key_missing")),
    ERROR_COPY_KEY.ai_provider_key_decrypt_failed,
    "ciphertext without IV → re-enter warning, not 'Configured'",
  );
  // Same row can't be both configured and not_configured; only a race with
  // another admin's Clear produces it, so no warning rather than a wrong one.
  assert.equal(adminKeyWarningCopyKey(true, down("ai_provider_not_configured")), null, "stale disagreement → no warning");
  assert.equal(
    adminKeyWarningCopyKey(true, down("ai_key_encryption_unavailable")),
    null,
    "encryption off → the section's own encryptionUnavailable warning",
  );
  assert.equal(adminKeyWarningCopyKey(true, down("something_new")), null);
});
