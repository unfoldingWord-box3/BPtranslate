// Tests for the streaming metadata.json link scanner (aquiferLinks.ts).
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/aquiferLinks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { EnglishLinkScanner, scanEnglishLinks, parseEnglishTitle } from "./aquiferLinks.ts";

// Same layout as the real file: small header objects, then article_metadata last.
// Braces, escaped quotes and a "content_id" lookalike are placed inside strings on
// purpose: a naive scan would miscount depth or read the wrong id.
const entry = (id, eng, extra = "") =>
  `"${id}": {"content_id": "${id}", "reference_id": 1, "localizations": {` +
  (eng ? `"eng": {"content_id": ${eng.id}, "language": "eng", "title": ${JSON.stringify(eng.title)}}, ` : "") +
  `"arb": {"content_id": 9, "language": "arb", "title": "x"}}${extra}}`;

const doc = JSON.stringify({ resource_metadata: { title: "has } and { and \"quote\"", n: { deep: { deeper: 1 } } }, scripture_burrito: {} }).slice(0, -1) +
  ', "article_metadata": {' +
  [
    entry("100", { id: 500, title: "Titus 1:1 (#1)" }),
    entry("101", { id: 501, title: 'Odd } "title" { 2:3-5 (#2)' }),
    entry("102", null),
    entry("103", { id: 503, title: "Titus 1:2 (#3)" }, ', "note": "{\\\"content_id\\\": \\"999\\""'),
  ].join(", ") +
  "}}";

test("finds the English link for each wanted id and ignores the rest", () => {
  const s = scanEnglishLinks([doc], new Set(["100", "101", "102", "103", "999"]));
  assert.equal(s.complete, true);
  assert.deepEqual(s.links.get("100"), { engContentId: "500", engTitle: "Titus 1:1 (#1)" });
  assert.equal(s.links.get("101").engTitle, 'Odd } "title" { 2:3-5 (#2)');
  assert.equal(s.links.has("102"), false, "no eng localization -> no link");
  assert.equal(s.links.get("103").engContentId, "503");
  assert.equal(s.links.has("999"), false);
});

test("an entry is keyed by its object key, not by a content_id inside it", () => {
  // The entry's own "content_id" field comes AFTER a nested one that would win a
  // first-match search.
  const odd = '{"article_metadata": {"700": {"localizations": {"eng": {"content_id": 701, "language": "eng", "title": "Titus 1:1 (#1)"}}, "content_id": "700"}}}';
  const s = scanEnglishLinks([odd], new Set(["700", "701"]));
  assert.deepEqual([...s.links.keys()], ["700"]);
  assert.equal(s.links.get("700").engContentId, "701");
});

test("only wanted entries are retained", () => {
  const s = scanEnglishLinks([doc], new Set(["103"]));
  assert.deepEqual([...s.links.keys()], ["103"]);
  assert.equal(s.done, true);
});

test("result is the same however the stream is chunked", () => {
  const want = new Set(["100", "101", "103"]);
  const whole = scanEnglishLinks([doc], want);
  for (const size of [1, 2, 3, 7, 13, 50]) {
    const chunks = [];
    for (let i = 0; i < doc.length; i += size) chunks.push(doc.slice(i, i + size));
    const s = scanEnglishLinks(chunks, want);
    assert.deepEqual([...s.links], [...whole.links], `chunk size ${size}`);
    assert.equal(s.complete, true, `chunk size ${size} complete`);
  }
});

test("a truncated document is reported incomplete", () => {
  const s = scanEnglishLinks([doc.slice(0, doc.length - 40)], new Set(["999"]));
  assert.equal(s.complete, false);
});

test("scanner and title parser agree on what a verse link looks like", () => {
  const s = new EnglishLinkScanner(new Set(["101"]));
  s.push(doc);
  assert.deepEqual(parseEnglishTitle(s.links.get("101").engTitle), { ref: "2:3-5", ordinal: 2 });
});
