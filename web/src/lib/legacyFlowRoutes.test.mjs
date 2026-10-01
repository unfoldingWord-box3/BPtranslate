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
  // The old word-links editor → the classic editor at that verse, carrying
  // the row so its word-links tab opens with that link selected.
  ["#/words/ZEC/6", "#/ZEC/6/1"],
  ["#/words/zec/6/3", "#/ZEC/6/3"],
  ["#/words/ZEC/6/3?row=rqe5", "#/ZEC/6/3?twl=rqe5"],
  ["#/words/ZEC/6/3?row=abc%20d", "#/ZEC/6/3?twl=abc%20d"],
  // A mangled percent sequence must not throw.
  ["#/words/ZEC/6/3?row=%E0", `#/ZEC/6/3?twl=${encodeURIComponent("�")}`],
];

// Near-misses: trailing slash, case of the route word, any query tail.
const nearMisses = [
  ["#/home/", "#/books"],
  ["#/Home", "#/books"],
  ["#/HOME", "#/books"],
  ["#/home?x=1", "#/books"],
  ["#/Setup/", "#/admin/setup"],
  ["#/team?tab=roles", "#/admin/team"],
  ["#/Articles", "#/articles/tw"],
  ["#/Scripture/", "#/books"],
  ["#/align/ZEC/6/3/", "#/alignment/ZEC/6/3"],
  ["#/Align/ZEC/6/3?x=1", "#/alignment/ZEC/6/3"],
  ["#/words/ZEC/6/3/", "#/ZEC/6/3"],
  ["#/Words/ZEC/6/3", "#/ZEC/6/3"],
  ["#/words/ZEC/6/3?row=a&b=1", "#/ZEC/6/3?twl=a"],
  ["#/words/ZEC/6/3?b=1&row=a", "#/ZEC/6/3?twl=a"],
  ["#/words/ZEC/6/3?b=1", "#/ZEC/6/3"],
  // #/words/{book} is the kept Words & Articles screen; a near-miss of it is
  // normalized onto that screen rather than read as book "WORDS".
  ["#/words/ZEC?row=x", "#/words/ZEC"],
  ["#/words/zec/", "#/words/ZEC"],
  ["#/Words/ZEC", "#/words/ZEC"],
];

for (const [from, to] of [...redirects, ...nearMisses]) {
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
  "#/ZEC/6/3?twl=rqe5",
  "#/1SA/1",
  "",
];

for (const hash of kept) {
  test(`${hash || "(empty)"} is not a retired route`, () => {
    assert.equal(legacyFlowRedirect(hash), null);
  });
}
