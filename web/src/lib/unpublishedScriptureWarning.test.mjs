// Tests for unpublishedScriptureWarning.ts — which warning the AI run dialog
// shows about Bible text the AI can't see yet (#679). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/unpublishedScriptureWarning.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { unpublishedWarning } from "./unpublishedScriptureWarning.ts";

const check = (openId, ult, ust, book = "ZEC") => ({ openId, book, ult, ust });

test("no check yet (loading, or the request failed): no warning", () => {
  assert.equal(unpublishedWarning(null, 1, "ZEC"), null);
});

test("a check for this opening of the dialog shows its warning", () => {
  assert.equal(unpublishedWarning(check(1, "pending", "current"), 1, "ZEC"), "pending");
  assert.equal(unpublishedWarning(check(1, "current", "current"), 1, "ZEC"), null);
});

test("a check from an earlier opening never shows on a reopen", () => {
  assert.equal(unpublishedWarning(check(1, "pending", "pending"), 2, "ZEC"), null);
});

test("a check for another book never shows", () => {
  assert.equal(unpublishedWarning(check(1, "pending", "current", "HAG"), 1, "ZEC"), null);
});

test("a lane whose export is off wins over one waiting for the nightly publish", () => {
  assert.equal(unpublishedWarning(check(1, "pending", "unpublishable"), 1, "ZEC"), "unpublishable");
  assert.equal(unpublishedWarning(check(1, "unpublishable", "current"), 1, "ZEC"), "unpublishable");
});
