// Network check: every model in PROVIDER_MODELS (aiProvider.ts) must exist in the
// translate bot's model-provider-config.json (unfoldingWord/bp-assistant), as a
// model or an alias. The bot rejects an unknown id with model_not_found, so a
// model an admin can pick here but the bot lacks fails every translate job for
// that org — exactly how gemini-3.7-flash and gemini-3.8-flash broke (#677).
// providerCatalog.test.mjs checks PROVIDER_MODELS against our own catalog, but
// nothing offline can see the bot's list.
//
// This hits raw.githubusercontent.com, so it is deliberately NOT in `npm test` —
// the unit suites in this repo are all offline and deterministic (the pure
// comparison is unit-tested in botModelParity.test.mjs). It runs nightly via
// .github/workflows/bot-models.yml, and on demand:
//
//   npm --workspace api run check:bot-models
//
// Exit codes, same contract as taSupportReferences.check.mjs: 0 pass, 1 a model
// genuinely missing from the bot, 2 "could not get a trustworthy answer"
// (network failure, bad response, a bot config shape we don't recognize). An
// outage or a bot-side schema change must never read as "your models are
// missing".

import { PROVIDER_MODELS } from "./aiProvider.ts";
import { findModelsMissingFromBot } from "./botModelParity.ts";

const CONFIG_URL =
  "https://raw.githubusercontent.com/unfoldingWord/bp-assistant/main/model-provider-config.json";
const TIMEOUT_MS = 30_000;

/** Exit 2 rather than let a transport problem masquerade as a model verdict. */
function bail(message) {
  console.error(message);
  process.exit(2);
}

let res;
try {
  res = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
} catch (err) {
  bail(`FETCH FAILED: ${CONFIG_URL} -> ${err?.message ?? err}`);
}
if (!res.ok) bail(`FETCH FAILED: ${CONFIG_URL} -> HTTP ${res.status}`);

let config;
try {
  config = await res.json();
} catch (err) {
  bail(`BAD RESPONSE: not JSON (${err?.message ?? err})`);
}

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

if (!isObject(config?.providers)) bail("BAD RESPONSE: bot config has no `providers` object");
// A provider block present but without a `models` object means the bot changed
// its schema; comparing against it would condemn every model we offer.
for (const provider of Object.keys(PROVIDER_MODELS)) {
  const block = config.providers[provider];
  if (block !== undefined && !isObject(block?.models)) {
    bail(`BAD RESPONSE: bot provider \`${provider}\` has no \`models\` object — refusing to validate against it`);
  }
}

const missing = findModelsMissingFromBot(PROVIDER_MODELS, config);

if (missing.length > 0) {
  console.error(
    `\n${missing.length} model(s) offered in BPtranslate's AI settings are unknown to the translate bot:\n`,
  );
  for (const { provider, model } of missing) console.error(`  - ${provider}/${model}`);
  console.error(
    "\nTranslate jobs for an org that picks one fail with model_not_found. Either\n" +
      "remove it from PROVIDER_MODELS in api/src/aiProvider.ts, or add it to\n" +
      "model-provider-config.json in unfoldingWord/bp-assistant. Do not swap in a\n" +
      "near-miss id: check the exact id the provider's API accepts.\n",
  );
  process.exit(1);
}

const total = Object.values(PROVIDER_MODELS).reduce((n, models) => n + models.length, 0);
console.log(`  ok - all ${total} offered models exist in the bot's model-provider-config.json`);
