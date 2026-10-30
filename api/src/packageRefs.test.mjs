// packageRefs.test.mjs: readPackageRefs (the chat MCP's one read-only D1
// query, issue #671) against the REAL article_units and template_units
// migrations on in-memory SQLite, then summarized the way bpt_package_status
// does. Checks that only the book's live references count, that trashed and
// deleted rows are left out, and that an authoring project reads nothing.
//
// Run: node --experimental-strip-types --no-warnings --test src/packageRefs.test.mjs

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readPackageRefs, summarizePackageRefs } from "./packageRefs.ts";
import { clearProjectConfigCache } from "./projectConfig.ts";

const migDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const readMig = (name) => readFileSync(join(migDir, name), "utf-8");

// The read-only subset of D1 this module uses.
function makeEnv(db) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  return { DB: { prepare: (sql) => stmt(sql) }, WORKSPACE_SLUG: `t${Math.random()}` };
}

function freshDb(preset) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE tn_rows (
      id TEXT, book TEXT, chapter INTEGER, verse INTEGER,
      support_reference TEXT, note TEXT, trashed_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE twl_rows (id TEXT, book TEXT, tw_link TEXT, deleted_at INTEGER);
    CREATE TABLE project_config (id INTEGER PRIMARY KEY, preset TEXT NOT NULL, overrides_json TEXT, updated_at INTEGER);
  `);
  db.exec(readMig("0039_article_units.sql"));
  db.exec(readMig("0054_template_units.sql"));
  db.prepare(`INSERT INTO project_config (id, preset, overrides_json, updated_at) VALUES (1, ?1, NULL, 0)`).run(preset);
  clearProjectConfigCache();

  const tn = db.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, support_reference, note, trashed_at, deleted_at) VALUES (?, ?, 1, 1, ?, ?, ?, ?)`,
  );
  tn.run("a1", "TIT", "rc://*/ta/man/translate/figs-metaphor", "See [x](rc://*/ta/man/translate/figs-aside)", null, null);
  tn.run("a2", "TIT", "figs-explicit", "plain", null, null);
  tn.run("a3", "TIT", "rc://*/ta/man/translate/figs-hyperbole", "trashed", 1, null);
  tn.run("a4", "TIT", "rc://*/ta/man/translate/figs-simile", "deleted", null, 1);
  tn.run("b1", "OBA", "rc://*/ta/man/translate/figs-irony", "other book", null, null);
  const twl = db.prepare(`INSERT INTO twl_rows (id, book, tw_link, deleted_at) VALUES (?, ?, ?, ?)`);
  twl.run("w1", "TIT", "rc://*/tw/dict/bible/kt/god", null);
  twl.run("w2", "TIT", "rc://*/tw/dict/bible/kt/god", null);
  twl.run("w3", "TIT", "rc://*/tw/dict/bible/names/paul", null);
  twl.run("w4", "TIT", "rc://*/tw/dict/bible/kt/faith", 1);
  twl.run("w5", "OBA", "rc://*/tw/dict/bible/names/edom", null);

  const art = db.prepare(
    `INSERT INTO article_units (resource, path, article_id, part, source_md, translation_state, deleted_at) VALUES (?, ?, ?, ?, 'x', ?, ?)`,
  );
  art.run("tw", "bible/kt/god.md", "kt/god", "body", "validated", null);
  art.run("tw", "bible/names/edom.md", "names/edom", "body", "ai_draft", null);
  art.run("ta", "translate/figs-metaphor/01.md", "translate/figs-metaphor", "body", "ai_draft", null);
  art.run("ta", "translate/figs-metaphor/title.md", "translate/figs-metaphor", "title", "validated", null);
  art.run("ta", "translate/figs-explicit/01.md", "translate/figs-explicit", "body", null, null);
  art.run("ta", "translate/figs-aside/01.md", "translate/figs-aside", "body", "validated", 1); // soft-deleted

  const tpl = db.prepare(
    `INSERT INTO template_units (template_id, support_ref, source_md, source_hash, translation_state, deleted_at) VALUES (?, ?, 'x', 'h', ?, ?)`,
  );
  tpl.run("figs-metaphor-01", "figs-metaphor", "edited", null);
  tpl.run("figs-metaphor-02", "figs-metaphor", null, null);
  tpl.run("figs-explicit-01", "figs-explicit", "validated", null);
  tpl.run("figs-explicit-02", "figs-explicit", "validated", 1); // deleted
  tpl.run("figs-irony-01", "figs-irony", "validated", null); // OBA only
  return db;
}

test("a translation project counts only the book's live references", async () => {
  const env = makeEnv(freshDb("en-bible-editor-ml-test"));
  const rows = await readPackageRefs(env, "TIT");
  assert.equal(rows.translation, true);
  const s = summarizePackageRefs(rows);
  // kt/god (twice in TWL) and names/paul; kt/faith's link is deleted.
  assert.deepEqual(s.tw, { referenced: 2, loaded: 1, by_state: { not_started: 0, ai_draft: 0, edited: 0, validated: 1 } });
  // figs-metaphor (support ref), figs-explicit (bare support ref), figs-aside
  // (inline link; its only unit is soft-deleted, so not loaded).
  assert.deepEqual(s.ta, { referenced: 3, loaded: 2, by_state: { not_started: 1, ai_draft: 1, edited: 0, validated: 0 } });
  // figs-metaphor and figs-explicit; the trashed note's figs-hyperbole and the
  // deleted note's figs-simile are not used.
  assert.deepEqual(s.templates, {
    support_references: 2,
    with_templates: 2,
    templates: 3,
    by_state: { not_started: 1, ai_draft: 0, edited: 1, validated: 1 },
  });
});

test("an authoring project reads nothing", async () => {
  const env = makeEnv(freshDb("en-unfoldingword"));
  const rows = await readPackageRefs(env, "TIT");
  assert.equal(rows.translation, false);
  assert.equal(rows.referenced.length + rows.articleUnits.length + rows.templateUnits.length, 0);
});
