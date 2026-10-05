import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const localesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "locales");
const readLocale = (lang) => JSON.parse(readFileSync(path.join(localesDir, `${lang}.json`), "utf8"));

// #549: clearing the BYO key is DELETE /api/ai-provider, which the server
// treats as PUT provider:'default' (api/src/aiProvider.ts) — jobs keep running
// on the shared unfoldingWord subscription. The English confirmation used to
// say only "you'll need to enter a new key", implying jobs stop.
test("en clear-key confirmation says the org falls back to the shared unfoldingWord subscription", () => {
  const body = readLocale("en").preferences.aiService.clearConfirmBody;
  assert.match(body, /default provider/i);
  assert.match(body, /shared unfoldingWord subscription/);
});
