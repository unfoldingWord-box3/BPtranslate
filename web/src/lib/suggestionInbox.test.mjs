// Tests for the suggestion inbox page helpers (web/src/lib/suggestionInbox.ts,
// issue #856): integer percentages, and plain en/ar text for every approve
// error the server sends.
//
// Run from web/:
//   node --experimental-strip-types --no-warnings --test src/lib/suggestionInbox.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { floorPercent, approveErrorKey } from "./suggestionInbox.ts";

const here = dirname(fileURLToPath(import.meta.url));
const locale = (lang) => JSON.parse(readFileSync(join(here, "..", "i18n", "locales", `${lang}.json`), "utf8"));
const lookup = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

test("floorPercent: 29 of 50 is 58% (the float ratio gives 57)", () => {
  assert.equal(Math.floor((29 / 50) * 100), 57); // the bug this replaces
  assert.equal(floorPercent(29, 50), 58);
  assert.equal(floorPercent(796, 1000), 79); // rounded down, never up to a bar
  assert.equal(floorPercent(10, 10), 100);
  assert.equal(floorPercent(0, 0), 0);
});

test("approveErrorKey: rule_exists, not_migrated, rule_unsupported and rule_unchecked have plain en and ar text", () => {
  const en = locale("en");
  const ar = locale("ar");
  const codes = ["suggestion_not_found", "rule_mismatch", "rule_imprecise", "rule_unchecked", "rule_unsupported", "not_migrated"];
  for (const code of codes) {
    const key = approveErrorKey(code);
    assert.ok(key, code);
    assert.equal(typeof lookup(en, key), "string", `${code} en`);
    assert.equal(typeof lookup(ar, key), "string", `${code} ar`);
    assert.notEqual(lookup(en, key), lookup(ar, key), `${code} ar is translated`);
  }
  // rule_exists is a success (the page reloads), with its own notice.
  assert.equal(approveErrorKey("rule_exists"), null);
  assert.equal(typeof lookup(en, "adminPages.suggestions.ruleExists"), "string");
  assert.equal(typeof lookup(ar, "adminPages.suggestions.ruleExists"), "string");
  assert.equal(approveErrorKey("something_else"), null);
  assert.equal(approveErrorKey(null), null);
});
