// Guard for the in-app user guide (help/, guideMap.ts).
//
//  1. Coverage — every screen (a `view` in App.tsx's `Location`, plus each admin
//     desk section) must be listed in `routes:` of some English article.
//  2. Truth — every route key an article lists must still be a real screen.
//  3. The guide validates (build-help's validateGuide: matching ids/routes across
//     languages, images exist, links resolve).
//  4/5. Unit tests of guideMap.ts and build-help's parseArticle.
//
// If a "Parser rot" assertion fails, App.tsx changed shape: update the regex.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { routeKey, articlesFor, articleForRoute } from "./guideMap.ts";
import { parseArticle, loadGuide, validateGuide } from "../../../scripts/build-help.mjs";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(webRoot, "..");
const readStripped = (rel) => readFileSync(path.join(webRoot, rel), "utf8").replace(/\/\/[^\n]*/g, "");

function parseRouteKeys() {
  const src = readStripped("src/App.tsx");
  const m = src.match(/type Location =([\s\S]*?)\n\n/);
  assert.ok(m, "Parser rot: `type Location =` not found in App.tsx — update guideMap.test.mjs to match the new shape");
  const keys = [];
  for (const member of m[1].split(/\n\s*\|/)) {
    const vm = member.match(/view:\s*"([^"]+)"/);
    if (!vm) continue;
    if (vm[1] === "admin") {
      const sm = member.match(/section:\s*([^;}]*)/);
      const sections = sm ? [...sm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
      assert.ok(sections.length >= 1, "Parser rot: admin `section:` union parse found no sections");
      for (const s of sections) keys.push(`admin/${s}`);
    } else {
      keys.push(vm[1]);
    }
  }
  assert.ok(keys.length >= 10, `Parser rot: Location parse found only ${keys.length} route keys`);
  return keys;
}

test("every screen has a guide article", () => {
  const listed = new Set(loadGuide(repoRoot).en.flatMap((a) => a.routes));
  for (const key of parseRouteKeys()) {
    assert.ok(
      listed.has(key),
      `Screen "${key}" has no guide article. Add it to the routes: front-matter of an article in help/en/ and help/ar/ (or write a new one); see help/README.md.`,
    );
  }
});

test("every route key listed by an article is a real screen", () => {
  const real = new Set(parseRouteKeys());
  for (const lang of Object.values(loadGuide(repoRoot))) {
    for (const a of lang) {
      for (const r of a.routes) {
        assert.ok(real.has(r), `${a.file}: routes: lists "${r}", which is not a screen in App.tsx's Location type. Fix or remove it.`);
      }
    }
  }
});

test("the guide validates", () => {
  const errors = validateGuide(loadGuide(repoRoot), repoRoot);
  assert.deepEqual(errors, []);
});

const art = (id, routes) => ({ id, title: id, routes, roles: [], keywords: [], headings: [], body: "" });
const index = {
  version: 1,
  langs: {
    en: { articles: [art("notes", ["notes"]), art("team", ["admin/team"])] },
    ar: { articles: [art("notes", ["notes"])] },
  },
};

test("routeKey", () => {
  assert.equal(routeKey({ view: "admin", section: "team" }), "admin/team");
  assert.equal(routeKey({ view: "preferences", section: "workspace" }), "preferences");
  assert.equal(routeKey({ view: "notes" }), "notes");
});

test("articleForRoute and articlesFor", () => {
  assert.equal(articleForRoute(index, "ar", "notes")?.id, "notes");
  assert.equal(articleForRoute(index, "xx", "admin/team")?.id, "team"); // unknown lang -> en
  assert.equal(articleForRoute(index, "en", "nope"), null);
  assert.equal(articlesFor(index, "fr").length, 2);
});

test("parseArticle front-matter subset", () => {
  const a = parseArticle(
    [
      "---",
      "id: notes",
      "title: Translating notes",
      "routes: [notes, questions]",
      "roles: []",
      "keywords:",
      "  - tn",
      "  - save",
      "screenshots:",
      "  - notes-1 #/notes/ZEC/1/1",
      "  - notes-phone #/notes/ZEC/1/1 phone",
      "---",
      "",
      "Intro.",
      "## Open a note",
      "### Sub",
    ].join("\n"),
    "x.md",
  );
  assert.equal(a.id, "notes");
  assert.deepEqual(a.routes, ["notes", "questions"]);
  assert.deepEqual(a.roles, []);
  assert.deepEqual(a.keywords, ["tn", "save"]);
  assert.deepEqual(a.screenshots, [
    { name: "notes-1", hash: "#/notes/ZEC/1/1", phone: false },
    { name: "notes-phone", hash: "#/notes/ZEC/1/1", phone: true },
  ]);
  assert.deepEqual(a.headings, ["Open a note", "Sub"]);
  assert.equal(a.body, "Intro.\n## Open a note\n### Sub");
});

test("parseArticle errors name the file", () => {
  assert.throws(() => parseArticle("---\nid: a\ntitle: T\nbogus: 1\n---\n", "help/en/x.md"), /help\/en\/x\.md.*bogus/);
  assert.throws(() => parseArticle("---\ntitle: T\n---\n", "y.md"), /y\.md.*missing id/);
  assert.throws(() => parseArticle("---\nid: a\ntitle: T\nthis is not yaml\n---\n", "z.md"), /z\.md.*malformed/);
});
