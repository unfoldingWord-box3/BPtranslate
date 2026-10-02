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
  // Selector-breaking characters stay percent-encoded in the hash; the
  // consumer (ResourceColumn) CSS-escapes the decoded id.
  ["#/words/ZEC/6/3?row=%22%5D", "#/ZEC/6/3?twl=%22%5D"],
  // A mangled percent sequence must not throw.
  ["#/words/ZEC/6/3?row=%E0", `#/ZEC/6/3?twl=${encodeURIComponent("�")}`],
  // The four desk More-tools screens moved under #/admin/* (#537).
  ["#/ai", "#/admin/ai"],
  ["#/style", "#/admin/style"],
  ["#/curate", "#/admin/curate"],
  ["#/observe", "#/admin/observe"],
  // #/curate/{templateId} was the only one with a tail; the id is carried
  // over exactly as encoded (template ids are free text, not [A-Za-z0-9]).
  ["#/curate/figs-metaphor-1", "#/admin/curate/figs-metaphor-1"],
  ["#/curate/a%20b%2Fc", "#/admin/curate/a%20b%2Fc"],
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
  ["#/ai/", "#/admin/ai"],
  ["#/AI", "#/admin/ai"],
  ["#/ai?x=1", "#/admin/ai"],
  ["#/Style/", "#/admin/style"],
  ["#/observe?tab=exports", "#/admin/observe"],
  ["#/Observe", "#/admin/observe"],
  ["#/curate/", "#/admin/curate"],
  ["#/Curate?x=1", "#/admin/curate"],
  ["#/curate/figs-metaphor-1/", "#/admin/curate/figs-metaphor-1"],
  ["#/Curate/figs-metaphor-1?x=1", "#/admin/curate/figs-metaphor-1"],
  // The #/admin/* hashes themselves (#544): parseHash matches them exactly, so
  // a near-miss is canonicalized here rather than read as book "ADMIN".
  ["#/admin/AI", "#/admin/ai"],
  ["#/admin/ai/", "#/admin/ai"],
  ["#/admin/observe?x=1", "#/admin/observe"],
  ["#/admin/Team", "#/admin/team"],
  ["#/admin/Setup/", "#/admin/setup"],
  ["#/admin/workflow?tab=x", "#/admin/workflow"],
  ["#/admin/PROGRESS", "#/admin/progress"],
  ["#/admin/review/", "#/admin/review"],
  ["#/admin/Style?x=1", "#/admin/style"],
  ["#/Admin/ai", "#/admin/ai"],
  ["#/admin/curate/", "#/admin/curate"],
  ["#/admin/Curate?x=1", "#/admin/curate"],
  // The template id keeps its case and percent-encoding exactly.
  ["#/admin/curate/some-id/", "#/admin/curate/some-id"],
  ["#/admin/curate/Some-ID?x=1", "#/admin/curate/Some-ID"],
  ["#/admin/Curate/a%20b%2Fc/", "#/admin/curate/a%20b%2Fc"],
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
  "#/admin/setup",
  "#/admin/ai",
  "#/admin/style",
  "#/admin/curate",
  "#/admin/curate/figs-metaphor-1",
  "#/admin/observe",
  "#/admin/team",
  "#/admin/workflow",
  "#/admin/progress",
  "#/admin/review",
  "#/admin/curate/Some-ID",
  "#/admin/curate/a%20b%2Fc",
  // Unknown admin sections are left as they behave today (#544).
  "#/admin/bogus",
  "#/admin/Bogus/",
  "#/admin/ai/extra",
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
