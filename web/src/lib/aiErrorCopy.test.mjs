// Guard for AI-studio error copy (issue #471, follow-up to #475).
//
// The translate runner writes a machine-readable `errorKind` on failure
// (api/src/translate/workflowSteps.ts, llm.ts, pipelines.ts). It reaches the
// client as a plain string, and AiScreen.tsx turns it into a human sentence via
// ERROR_COPY_KEY. When a kind has no entry the UI falls back to
// "Unrecognized error: {kind}" — a raw enum in an English debug sentence, shown
// even to Arabic users. #471 was exactly that: the internal-runner kinds were
// unmapped.
//
// TypeScript already keeps ERROR_COPY_KEY exhaustive over the PipelineErrorKind
// union (it is a Record<PipelineErrorKind, string>). What TypeScript CANNOT see
// is that `errorKind` is typed `string` on the server, so a new
// `new TranslateStepError("brand_new_kind", …)` compiles fine yet regresses the
// UI back to the raw-enum fallback. This test ties the two sides together:
//
//  1. every errorKind literal the server can emit is a member of the
//     PipelineErrorKind union (so it has an ERROR_COPY_KEY entry), and
//  2. every ERROR_COPY_KEY value resolves to real copy in BOTH en and ar —
//     check-i18n's orphan scan only matches literal t("…") call sites, so it
//     does not catch a typo'd or missing key referenced indirectly here.
//
// If a "parser rot" assertion fails, a source file it reads changed shape:
// update the regex AND re-check the mapping still reflects reality.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(webRoot, "..");
const readWeb = (rel) => readFileSync(path.join(webRoot, rel), "utf8");
const readApi = (rel) => readFileSync(path.join(repoRoot, "api", rel), "utf8");
// Strip line comments so a `// note` mentioning a kind can't be parsed as one.
const strip = (src) => src.replace(/\/\/[^\n]*/g, "");

const FIX_HINT =
  'Add the kind to the PipelineErrorKind union (web/src/sync/api.ts) and to ERROR_COPY_KEY ' +
  "(web/src/components/flows/AiScreen.tsx), then write translator-facing copy under " +
  '"aiStudio.errors.<kind>" in BOTH web/src/i18n/locales/en.json and ar.json (#471).';

function parsePipelineErrorKinds() {
  const src = strip(readWeb("src/sync/api.ts"));
  const m = src.match(/export type PipelineErrorKind =([\s\S]*?);/);
  assert.ok(m, "Parser rot: `export type PipelineErrorKind =` not found in web/src/sync/api.ts");
  const kinds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(kinds.length >= 24, `Parser rot: PipelineErrorKind union parse found only ${kinds.length} members`);
  return new Set(kinds);
}

function parseErrorCopyKey() {
  const src = strip(readWeb("src/components/flows/AiScreen.tsx"));
  const m = src.match(/const ERROR_COPY_KEY: Record<PipelineErrorKind, string> = \{([\s\S]*?)\};/);
  assert.ok(m, "Parser rot: `const ERROR_COPY_KEY` object not found in AiScreen.tsx");
  const entries = [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*):\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]);
  assert.ok(entries.length >= 24, `Parser rot: ERROR_COPY_KEY parse found only ${entries.length} entries`);
  return new Map(entries);
}

// Every errorKind literal the server can write on failure. Three sources:
//  - api/src/translate/workflowSteps.ts: `new TranslateStepError("<kind>", …)`
//    (multiline calls included) plus the `errorKind: "internal_error"` catch-all.
//  - api/src/translate/llm.ts: RETRYABLE_CODES / NON_RETRYABLE_CODES (re-thrown
//    as `errorKind: err.code`).
//  - api/src/pipelines.ts: the Fly-proxy `errorKind: "<kind>"` assignments.
function parseServerEmittedKinds() {
  const kinds = new Set();

  const steps = strip(readApi("src/translate/workflowSteps.ts"));
  for (const m of steps.matchAll(/new TranslateStepError\(\s*"([a-z][a-z0-9_]*)"/g)) kinds.add(m[1]);
  for (const m of steps.matchAll(/errorKind:\s*"([a-z][a-z0-9_]*)"/g)) kinds.add(m[1]);
  assert.ok(
    [...kinds].some((k) => k === "workspace_unknown"),
    "Parser rot: no TranslateStepError kinds parsed from workflowSteps.ts",
  );

  const llm = strip(readApi("src/translate/llm.ts"));
  for (const setName of ["RETRYABLE_CODES", "NON_RETRYABLE_CODES"]) {
    const m = llm.match(new RegExp(`${setName} = new Set\\(\\[([\\s\\S]*?)\\]`));
    assert.ok(m, `Parser rot: ${setName} not found in api/src/translate/llm.ts`);
    for (const q of m[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) kinds.add(q[1]);
  }

  const pipelines = strip(readApi("src/pipelines.ts"));
  for (const m of pipelines.matchAll(/errorKind:\s*"([a-z][a-z0-9_]*)"/g)) kinds.add(m[1]);

  return kinds;
}

function localeErrorKeys(rel) {
  const json = JSON.parse(readWeb(rel));
  const errors = json?.aiStudio?.errors;
  assert.ok(errors && typeof errors === "object", `${rel}: aiStudio.errors object missing`);
  return errors;
}

test("every server-emitted translate errorKind is a PipelineErrorKind (so it has AI-studio copy)", () => {
  const union = parsePipelineErrorKinds();
  const serverKinds = parseServerEmittedKinds();
  const unmapped = [...serverKinds].filter((k) => !union.has(k)).sort();
  assert.deepEqual(
    unmapped,
    [],
    `Server can emit errorKind(s) with no PipelineErrorKind member, so AI studio shows the raw ` +
      `"Unrecognized error: {kind}" fallback for them: ${unmapped.join(", ")}. ${FIX_HINT}`,
  );
});

test("every ERROR_COPY_KEY entry resolves to copy in both en and ar", () => {
  const copyKey = parseErrorCopyKey();
  const en = localeErrorKeys("src/i18n/locales/en.json");
  const ar = localeErrorKeys("src/i18n/locales/ar.json");
  for (const [kind, i18nKey] of copyKey) {
    const leaf = i18nKey.replace(/^aiStudio\.errors\./, "");
    assert.equal(i18nKey, `aiStudio.errors.${leaf}`, `ERROR_COPY_KEY["${kind}"] should point under aiStudio.errors`);
    assert.ok(typeof en[leaf] === "string" && en[leaf].length > 0, `en.json missing aiStudio.errors.${leaf} (for kind "${kind}")`);
    assert.ok(typeof ar[leaf] === "string" && ar[leaf].length > 0, `ar.json missing aiStudio.errors.${leaf} (for kind "${kind}")`);
  }
});

test("ERROR_COPY_KEY covers the full PipelineErrorKind union", () => {
  const union = parsePipelineErrorKinds();
  const copyKey = parseErrorCopyKey();
  const missing = [...union].filter((k) => !copyKey.has(k)).sort();
  assert.deepEqual(missing, [], `PipelineErrorKind member(s) with no ERROR_COPY_KEY entry: ${missing.join(", ")}. ${FIX_HINT}`);
});
