// Network check: every model in PROVIDER_MODELS (aiProvider.ts) must exist in the
// translate bot's model-provider-config.json (unfoldingWord/bp-assistant), as a
// model or an alias. The bot rejects an unknown id with model_not_found, so a
// model an admin can pick here but the bot lacks fails every translate job for
// that org — exactly how gemini-3.7-flash and gemini-3.8-flash broke (#677).
// providerCatalog.test.mjs checks PROVIDER_MODELS against our own catalog, but
// nothing offline can see the bot's list.
//
// What this checks is the repo file on bp-assistant's `main`, not the running
// bot's merged config. The bot actually accepts its built-in
// DEFAULT_PROVIDER_CONFIGS (src/api-runner/provider-config.js) merged with a
// runtime override copy of this file. Two gaps follow: (1) models only in the
// built-in defaults are not seen here, so this can flag a model the bot would
// accept; (2) the deployed bot can lag `main`, so a model just added to `main`
// passes here before the running bot knows it.
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
  for (const { provider, model, aliasOf } of missing) {
    console.error(
      aliasOf === undefined
        ? `  - ${provider}/${model}`
        : `  - ${provider}/${model} (a bot alias for ${aliasOf}, which is not a model in the bot's config)`,
    );
  }
  console.error(
    "\nTranslate jobs for an org that picks one fail with model_not_found. Either\n" +
      "remove it from PROVIDER_MODELS in api/src/aiProvider.ts, or add it (or, for a\n" +
      "dangling alias, its target) to model-provider-config.json in\n" +
      "unfoldingWord/bp-assistant. Do not swap in a\n" +
      "near-miss id: check the exact id the provider's API accepts.\n",
  );
  process.exit(1);
}

const total = Object.values(PROVIDER_MODELS).reduce((n, models) => n + models.length, 0);
console.log(
  `  ok - all ${total} offered models exist in bp-assistant main's model-provider-config.json`,
);
