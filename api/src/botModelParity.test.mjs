// botModelParity.ts: the comparison behind `npm --workspace api run
// check:bot-models` (#677). The fixture is synthetic on purpose: the live bot
// config is checked nightly by the network script, not frozen here.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/botModelParity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { findModelsMissingFromBot } from "./botModelParity.ts";

const price = { label: "x", inputPer1M: 1, outputPer1M: 1 };

// Same shape as bp-assistant's model-provider-config.json.
const bot = {
  providers: {
    claude: {
      modelAliases: { opus: "claude-opus-5", "claude-haiku-4-5": "claude-haiku-4-5-20251001" },
      models: { "claude-opus-5": price, "claude-haiku-4-5-20251001": price },
    },
    gemini: {
      modelAliases: { opus: "gemini-3.1-pro-preview" },
      models: { "gemini-3.6-flash": price, "gemini-3.1-pro-preview": price },
    },
  },
};

test("every model present: nothing missing", () => {
  assert.deepEqual(
    findModelsMissingFromBot({ claude: ["claude-opus-5"], gemini: ["gemini-3.6-flash", "gemini-3.1-pro-preview"] }, bot),
    [],
  );
});

test("a model the bot lacks is reported, with its provider", () => {
  assert.deepEqual(
    findModelsMissingFromBot({ gemini: ["gemini-3.6-flash", "gemini-3.8-flash", "gemini-3.7-flash"] }, bot),
    [
      { provider: "gemini", model: "gemini-3.8-flash" },
      { provider: "gemini", model: "gemini-3.7-flash" },
    ],
  );
});

test("a model present only as an alias key counts as present", () => {
  assert.deepEqual(findModelsMissingFromBot({ claude: ["claude-haiku-4-5"] }, bot), []);
});

test("a provider the bot lacks entirely reports all its models", () => {
  assert.deepEqual(findModelsMissingFromBot({ xai: ["grok-4.5", "grok-4.3"] }, bot), [
    { provider: "xai", model: "grok-4.5" },
    { provider: "xai", model: "grok-4.3" },
  ]);
});

test("prototype keys never read as present", () => {
  assert.deepEqual(findModelsMissingFromBot({ claude: ["constructor", "toString"], hasOwnProperty: ["x"] }, bot), [
    { provider: "claude", model: "constructor" },
    { provider: "claude", model: "toString" },
    { provider: "hasOwnProperty", model: "x" },
  ]);
});

test("the same id under another provider does not count", () => {
  assert.deepEqual(findModelsMissingFromBot({ gemini: ["claude-opus-5"] }, bot), [
    { provider: "gemini", model: "claude-opus-5" },
  ]);
});
