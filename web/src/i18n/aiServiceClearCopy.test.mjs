import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const readLocale = (lang) => JSON.parse(readFileSync(path.join(localesDir, `${lang}.json`), "utf8"));

// #551: clearing the BYO key is DELETE /api/ai-provider, which leaves the org
// with no key. There is no shared unfoldingWord subscription to fall back to
// any more: translate jobs are refused until an admin enters a new key. The
// confirmation must say that, and must not promise the old fallback (#549's
// copy did, correctly at the time).
test("en clear-key confirmation says translation won't run until a new key is entered", () => {
  const body = readLocale("en").preferences.aiService.clearConfirmBody;
  assert.doesNotMatch(body, /shared|subscription|default provider|unfoldingWord/i);
  assert.match(body, /won't run/);
  assert.match(body, /until an admin enters a new key/);
});

test("ar clear-key confirmation says translation won't run until a new key is entered", () => {
  const body = readLocale("ar").preferences.aiService.clearConfirmBody;
  assert.doesNotMatch(body, /uW|اشتراك|الافتراضي/, "no mention of the uW subscription or default provider");
  assert.match(body, /لن تعمل/);
  assert.match(body, /مفتاحًا جديدًا/);
});

test("no locale still promises a fallback to the uW subscription", () => {
  // The ungated locales had the old fallback copy removed so they fall back to
  // English rather than show a false promise; any locale that carries the key
  // again must carry the new meaning.
  for (const file of readdirSync(localesDir).filter((f) => f.endsWith(".json"))) {
    const body = JSON.parse(readFileSync(path.join(localesDir, file), "utf8")).preferences?.aiService?.clearConfirmBody;
    if (body === undefined) continue;
    assert.doesNotMatch(body, /uW|unfoldingWord/, `${file}: clearConfirmBody still mentions the uW subscription`);
  }
});

// #551 part F: the shared account is gone, so no copy may point at it. An org
// admin can't set the server's BT_API_TOKEN, and the "Default (uW subscription)"
// provider no longer exists. Outdated translations were deleted (they fall back
// to English) rather than rewritten in languages nobody here can check.
const allStrings = (obj, out = []) => {
  for (const v of Object.values(obj)) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") allStrings(v, out);
  }
  return out;
};

test("no locale tells anyone to set BT_API_TOKEN", () => {
  for (const file of readdirSync(localesDir).filter((f) => f.endsWith(".json"))) {
    const hits = allStrings(readLocale(file.replace(/\.json$/, ""))).filter((s) => s.includes("BT_API_TOKEN"));
    assert.deepEqual(hits, [], `${file}: copy still mentions BT_API_TOKEN`);
  }
});

test("no locale keeps the shared-subscription provider label or intro", () => {
  for (const file of readdirSync(localesDir).filter((f) => f.endsWith(".json"))) {
    const svc = readLocale(file.replace(/\.json$/, "")).preferences?.aiService;
    assert.equal(svc?.provider?.default, undefined, `${file}: "Default (uW subscription)" label is still there`);
    if (svc?.intro !== undefined) {
      assert.doesNotMatch(svc.intro, /uW|unfoldingWord/, `${file}: AI service intro still mentions the shared subscription`);
    }
  }
});
