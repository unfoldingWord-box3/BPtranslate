// Tests for pipelineTrigger.ts — a source project's pipeline trigger is an
// import action, not an AI one (#731). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/pipelineTrigger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { aiStudioSubtitleKey, pipelineTrigger } from "./pipelineTrigger.ts";

test("translation project keeps the AI trigger", () => {
  assert.deepEqual(pipelineTrigger(true), {
    kind: "ai",
    buttonKey: "pipeline.aiButton",
    actionKey: "pipeline.startAiRun",
  });
});

test("source project (English root) gets an import trigger with no AI framing", () => {
  assert.deepEqual(pipelineTrigger(false), {
    kind: "import",
    buttonKey: "pipeline.importButton",
    actionKey: "pipeline.importFromDoor43",
  });
});

test("AI studio subtitle: translation keeps the AI copy, source project gets its own", () => {
  assert.equal(aiStudioSubtitleKey(true), "aiStudio.subtitle");
  assert.equal(aiStudioSubtitleKey(false), "aiStudio.subtitleSourceProject");
});
