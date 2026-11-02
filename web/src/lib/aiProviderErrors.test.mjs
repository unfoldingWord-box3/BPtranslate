import test from "node:test";
import assert from "node:assert/strict";
import { isAiProviderNotConfigured } from "./aiProviderErrors.ts";

// Shape of web/src/sync/api.ts ApiError: { status, message, body }.
const apiError = (status, body) => Object.assign(new Error("x"), { status, body });

test("isAiProviderNotConfigured: true only for the #551 start refusal", () => {
  assert.equal(isAiProviderNotConfigured(apiError(409, { error: "ai_provider_not_configured" })), true);
  // A 409 conflict (another translator's run) is a different thing.
  assert.equal(isAiProviderNotConfigured(apiError(409, { error: "conflict", jobId: "j" })), false);
  assert.equal(isAiProviderNotConfigured(apiError(503, { error: "pipeline_api_disabled" })), false);
  assert.equal(isAiProviderNotConfigured(apiError(500, "ai_provider_not_configured")), false);
  assert.equal(isAiProviderNotConfigured(new Error("ai_provider_not_configured")), false);
  assert.equal(isAiProviderNotConfigured(null), false);
  assert.equal(isAiProviderNotConfigured(undefined), false);
});
