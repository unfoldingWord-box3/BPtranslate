import test from "node:test";
import assert from "node:assert/strict";
import { legacyFlowRedirect } from "./legacyFlowRoutes.ts";

// Every hash a retired flows screen (#173) used to own, and where it lands now.
const redirects = [
  ["#/home", "#/books"],
  ["#/setup", "#/admin/setup"],
  ["#/team", "#/admin/team"],
  ["#/articles", "#/articles/tw"],
  ["#/scripture", "#/books"],
  ["#/align", "#/books"],
  ["#/words", "#/books"],
  ["#/align/ZEC", "#/alignment/ZEC/1"],
  ["#/align/zec/6", "#/alignment/ZEC/6"],
  ["#/align/ZEC/6/3", "#/alignment/ZEC/6/3"],
  ["#/words/ZEC/6", "#/verse/ZEC/6/1"],
  ["#/words/zec/6/3", "#/verse/ZEC/6/3"],
  ["#/words/ZEC/6/3?row=abc%20d", "#/verse/ZEC/6/3"],
];

for (const [from, to] of redirects) {
  test(`${from} redirects to ${to}`, () => {
    assert.equal(legacyFlowRedirect(from), to);
  });
}

// Hashes a kept screen still owns must not be rewritten.
const kept = [
  "#/books",
  "#/books/ZEC",
  "#/words/ZEC",
  "#/scripture/ZEC",
  "#/scripture/ZEC/6",
  "#/scripture/ZEC/6/3",
  "#/alignment/ZEC/6",
  "#/alignment/ZEC/6/3/dual",
  "#/verse",
  "#/verse/ZEC/1/1",
  "#/articles/tw",
  "#/articles/ta/figs-metaphor",
  "#/ai",
  "#/style",
  "#/curate",
  "#/observe",
  "#/admin/setup",
  "#/review/ZEC/1",
  "#/ZEC/6/3",
  "",
];

for (const hash of kept) {
  test(`${hash || "(empty)"} is not a retired route`, () => {
    assert.equal(legacyFlowRedirect(hash), null);
  });
}
