// providerCatalog.ts: the BYO-provider model slice, alias resolution with the
// prototype-key guard, and catalog pricing (bp-assistant translate-llm.test.js
// estimateCost cases + provider-config guards, re-targeted at the models
// aiProvider.ts lets an admin store).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/translate/providerCatalog.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER_CATALOG, getProviderConfig, getProviderNames, resolveProviderModel, isConfiguredModel,
  assertProviderModel, estimateCost,
} from "./providerCatalog.ts";
import { AI_PROVIDERS, PROVIDER_MODELS } from "../aiProvider.ts";

test("every model an admin can store resolves to a priced catalog entry", () => {
  for (const provider of AI_PROVIDERS) {
    if (provider === "default") continue;
    assert.ok(getProviderNames().includes(provider), `catalog has ${provider}`);
    for (const model of PROVIDER_MODELS[provider]) {
      const resolved = assertProviderModel(provider, model);
      assert.ok(isConfiguredModel(provider, resolved), `${provider}/${model} → ${resolved} is priced`);
      const price = getProviderConfig(provider).models[resolved];
      assert.ok(price.inputPer1M > 0 && price.outputPer1M > 0, `${provider}/${resolved} has positive prices`);
    }
    assert.equal(getProviderConfig(provider).defaultModel, PROVIDER_MODELS[provider][0], `${provider} default = UI suggestion`);
  }
});

test("catalog aliases only point at models inside the slice", () => {
  for (const [provider, cfg] of Object.entries(PROVIDER_CATALOG)) {
    for (const [alias, target] of Object.entries(cfg.modelAliases)) {
      assert.ok(Object.prototype.hasOwnProperty.call(cfg.models, target), `${provider} alias ${alias} → ${target} is priced`);
    }
  }
});

test("resolveProviderModel resolves aliases, passes concrete ids through, defaults when null", () => {
  assert.equal(resolveProviderModel("claude", "claude-haiku-4-5"), "claude-haiku-4-5-20251001");
  assert.equal(resolveProviderModel("claude", "opus"), "claude-opus-5");
  assert.equal(resolveProviderModel("claude", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(resolveProviderModel("claude", null), "claude-sonnet-5");
  assert.equal(resolveProviderModel("xai", undefined), "grok-4.5");
  assert.throws(() => resolveProviderModel("groq", "x"), /Unknown provider: groq/);
});

test("prototype keys never resolve or validate (hasOwnProperty guards)", () => {
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.equal(resolveProviderModel("claude", key), key, `${key} is not alias-resolved`);
    assert.equal(isConfiguredModel("claude", key), false, `${key} is not a configured model`);
    assert.throws(() => assertProviderModel("claude", key), /Unknown claude model/);
  }
  assert.throws(() => getProviderConfig("__proto__"), /Unknown provider/);
});

test("assertProviderModel names the valid aliases and models on failure", () => {
  assert.throws(() => assertProviderModel("claude", "claude-sonnet-4-6"),
    /Unknown claude model "claude-sonnet-4-6"\. Valid aliases: opus, haiku, claude-haiku-4-5; valid models: claude-opus-5, claude-sonnet-5, claude-haiku-4-5-20251001/);
  assert.throws(() => assertProviderModel("openai", "gpt-5.4"), /Valid aliases: \(none\); valid models: gpt-5\.5, gpt-5\.6-sol/);
  assert.equal(isConfiguredModel("claude", null), false);
  assert.equal(isConfiguredModel("claude", 42), false);
});

test("estimateCost prices a call off the catalog", () => {
  // Claude Sonnet 5: $2 / $10 per 1M → 1M in + 100k out = 2 + 1.0
  assert.equal(estimateCost("claude", "claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 100_000 }), 3.0);
  // Claude Haiku 4.5: $1 / $5 per 1M → 1M in + 1M out = 1 + 5 (issue #548)
  assert.equal(estimateCost("claude", "claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 6.0);
  // Alias-resolved model is priced under its concrete id.
  const haiku = estimateCost("claude", "claude-haiku-4-5", { inputTokens: 500_000, outputTokens: 250_000 });
  assert.ok(Math.abs(haiku - (0.5 + 1.25)) < 1e-9, String(haiku));
  assert.equal(estimateCost("xai", "grok-4.3", { inputTokens: 0, outputTokens: 0 }), 0);
  assert.equal(estimateCost("openai", "gpt-5.6-luna", null), 0);
});

test("estimateCost returns null for an unpriced model or unknown provider", () => {
  assert.equal(estimateCost("claude", "claude-sonnet-4-6", { inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(estimateCost("nope", "x", { inputTokens: 1, outputTokens: 1 }), null);
  assert.equal(estimateCost("claude", "__proto__", { inputTokens: 1, outputTokens: 1 }), null);
});
