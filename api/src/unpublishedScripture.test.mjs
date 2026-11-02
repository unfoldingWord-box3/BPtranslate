// #679 option C: will an AI translate run see the book's newest Bible text?
// The signal behind the run-dialog warning. Driven against the REAL
// migrations so it tracks the shipped edit_log / export_snapshots schema.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/unpublishedScripture.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { scriptureStatus } from "./unpublishedScripture.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    async run() {
      return sqlite.prepare(sql).run(...args);
    },
  });
  return { prepare: (sql) => mk(sql, []) };
}

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 9, 'translator')`).run();
  // Returns the edit_log id (what an export's watermark is compared against).
  const edit = (rowKey, at, source = null) =>
    Number(
      sqlite
        .prepare(
          `INSERT INTO edit_log (kind, row_key, book, action, created_at, source)
           VALUES ('verse', ?, ?, 'update', ?, ?)`,
        )
        .run(rowKey, rowKey.split("/")[0], at, source).lastInsertRowid,
    );
  // A verse row as the writers leave it: updated_by set by a person or the AI
  // pipeline, NULL after an import or a reimport from Door43.
  const verse = (bibleVersion, at, updatedBy, { book = "ZEC", chapter = 1, v = 1 } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO verses (book, chapter, verse, bible_version, content_json, plain_text, updated_by, updated_at)
         VALUES (?, ?, ?, ?, '{}', 'text', ?, ?)`,
      )
      .run(book, chapter, v, bibleVersion, updatedBy, at);
  // The edit_log retention sweep (index.ts: 180 days).
  const sweepEditLog = () => sqlite.exec(`DELETE FROM edit_log`);
  // An export snapshot: committed to its branch (sha) with a PR, or a skip
  // (sha null) with a reason such as 'unchanged' (render equalled master).
  // `wm`: MAX(edit_log.id) read before the render (NULL on older rows).
  const snapshot = (resource, at, { sha = "abc123", pr = 7, error = null, book = "ZEC", wm = null } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO export_snapshots (book, resource, commit_sha, committed_at, rows_exported, pr_number, error, edit_log_watermark)
         VALUES (?, ?, ?, ?, 10, ?, ?, ?)`,
      )
      .run(book, resource, sha, at, pr, error, wm);
  const mergedAtOf = (resource) =>
    sqlite
      .prepare(`SELECT committed_at, merged_at FROM export_snapshots WHERE resource = ? ORDER BY id`)
      .all(resource)
      .map((r) => ({ ...r }));
  return { db: makeDb(sqlite), edit, verse, sweepEditLog, snapshot, mergedAtOf };
}

// Export on, nothing merged on Door43, unless a test says otherwise.
function deps({ enabled = true, merged = {} } = {}) {
  const asked = [];
  return {
    asked,
    exportEnabled: async (resource) => (typeof enabled === "boolean" ? enabled : enabled[resource]),
    prMergedAt: async (resource, pr) => {
      asked.push(`${resource}#${pr}`);
      return merged[`${resource}#${pr}`] ?? null;
    },
  };
}

test("no verse edits: both lanes current, and Door43 is never asked", async () => {
  const { db } = fresh();
  const d = deps();
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "current" });
  assert.deepEqual(d.asked, []);
});

test("a ULT edit in a book that never exported is pending; UST stays current", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "pending", ust: "current" });
});

test("committed to the export branch but the PR is not merged: still pending (the AI reads master)", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/1/1/UST", 1000);
  snapshot("ust", 2000, { pr: 7 });
  const d = deps();
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "pending" });
  assert.deepEqual(d.asked, ["ust#7"]);
});

test("once Door43 reports the PR merged, the edit is current and the merge is recorded", async () => {
  const { db, edit, snapshot, mergedAtOf } = fresh();
  edit("ZEC/1/1/UST", 1000);
  snapshot("ust", 2000, { pr: 7 });
  const d = deps({ merged: { "ust#7": 2500 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "current" });
  assert.deepEqual(mergedAtOf("ust"), [{ committed_at: 2000, merged_at: 2500 }]);
  // Recorded, so the next check needs no Door43 call.
  const again = deps();
  assert.deepEqual(await scriptureStatus(db, "ZEC", again), { ult: "current", ust: "current" });
  assert.deepEqual(again.asked, []);
});

test("a merge only covers commits made before it; an edit after the merged export is pending", async () => {
  const { db, edit, snapshot, mergedAtOf } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  snapshot("ult", 2000, { pr: 7 });
  edit("ZEC/1/2/ULT", 3000);
  snapshot("ult", 4000, { pr: 7 }); // the same PR, re-used the next night, after the merge
  const d = deps({ merged: { "ult#7": 2500 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "pending", ust: "current" });
  assert.deepEqual(mergedAtOf("ult"), [
    { committed_at: 2000, merged_at: 2500 },
    { committed_at: 4000, merged_at: null },
  ]);
});

test("an export whose render equalled master ('unchanged') counts as current", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  snapshot("ult", 2000, { sha: null, pr: null, error: "unchanged" });
  const d = deps();
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "current" });
  assert.deepEqual(d.asked, []);
});

test("a failed export (no commit) does not count", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/2/3/ULT", 1000);
  snapshot("ult", 2000, { sha: null, pr: null, error: "error:boom" });
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "pending", ust: "current" });
});

test("the watermark is per resource: a merged UST export does not publish a ULT edit", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  snapshot("ust", 2000, { pr: 8 });
  const d = deps({ merged: { "ust#8": 2100 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "pending", ust: "current" });
});

test("lane export switched off: newer edits are unpublishable, never 'the nightly will fix it'", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  edit("ZEC/1/1/UST", 1000);
  const d = deps({ enabled: { ult: false, ust: true } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "unpublishable", ust: "pending" });
});

test("text pulled from Door43 (dcs_reimport) is not unpublished", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000, "dcs_reimport");
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "current", ust: "current" });
});

test("AI and chat writes to a verse count", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000, "ai_pipeline");
  edit("ZEC/1/2/UST", 1000, "chat");
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "pending", ust: "pending" });
});

test("another book's edits and source-text versions do not count", async () => {
  const { db, edit } = fresh();
  edit("HAG/1/1/ULT", 1000);
  edit("ZEC/1/1/UHB", 1000);
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "current", ust: "current" });
});

test("an edit made after the export read D1 but before its snapshot was stamped stays pending after the merge", async () => {
  const { db, edit, snapshot } = fresh();
  const before = edit("ZEC/1/1/ULT", 1000);
  // The export reads the watermark (= `before`) and renders; meanwhile a
  // translator saves; then the Door43 round trips finish and the snapshot is
  // stamped at 2000, after the edit's created_at of 1500.
  edit("ZEC/1/2/ULT", 1500);
  snapshot("ult", 2000, { pr: 7, wm: before });
  const d = deps({ merged: { "ult#7": 2500 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "pending", ust: "current" });
});

test("the same race with an 'unchanged' export also stays pending", async () => {
  const { db, edit, snapshot } = fresh();
  const before = edit("ZEC/1/1/UST", 1000);
  edit("ZEC/1/2/UST", 1500);
  snapshot("ust", 2000, { sha: null, pr: null, error: "unchanged", wm: before });
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "current", ust: "pending" });
});

test("with a watermark, every edit at or below it is covered by the merged export", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  const last = edit("ZEC/1/2/ULT", 1500);
  snapshot("ult", 2000, { pr: 7, wm: last });
  const d = deps({ merged: { "ult#7": 2500 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "current" });
});

test("export off: a verse a person or the AI wrote stays unpublishable after edit_log is swept", async () => {
  const { db, edit, verse, sweepEditLog } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  verse("ULT", 1000, 9);
  sweepEditLog();
  const d = deps({ enabled: false });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "unpublishable", ust: "current" });
});

test("export off: verses straight from Door43 (updated_by NULL) are not flagged", async () => {
  const { db, verse } = fresh();
  verse("ULT", 1000, null);
  verse("UST", 1000, null);
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps({ enabled: false })), { ult: "current", ust: "current" });
});

test("export on: an old unmerged verse write still counts after edit_log is swept", async () => {
  const { db, verse, sweepEditLog, snapshot } = fresh();
  snapshot("ust", 500, { sha: null, pr: null, error: "unchanged" });
  verse("UST", 1000, 9);
  sweepEditLog();
  assert.deepEqual(await scriptureStatus(db, "ZEC", deps()), { ult: "current", ust: "pending" });
});

test("export on: a verse written before the last merged export is current, with or without edit_log", async () => {
  const { db, verse, sweepEditLog, snapshot } = fresh();
  verse("ULT", 1000, 9);
  sweepEditLog();
  snapshot("ult", 2000, { pr: 7 });
  const d = deps({ merged: { "ult#7": 2500 } });
  assert.deepEqual(await scriptureStatus(db, "ZEC", d), { ult: "current", ust: "current" });
});

// ── the route: GET /api/pipelines/unpublished-scripture/:book ──────────────
import { Hono } from "hono";
import { pipelines } from "./pipelines.ts";

function routeApp(db) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/pipelines", pipelines);
  const env = { DB: db, DCS_BASE_URL: "https://dcs.test" };
  return (path) => app.request(path, {}, env, { waitUntil() {}, passThroughOnException() {} });
}

test("route: an unknown book code is a 400, not a query", async () => {
  const { db } = fresh();
  const get = routeApp(db);
  for (const bad of ["XYZ", "ZECH", "1", "zec%2F..%2Fx"]) {
    const res = await get(`/api/pipelines/unpublished-scripture/${bad}`);
    assert.equal(res.status, 400, bad);
    assert.deepEqual(await res.json(), { error: "unknown_book" });
  }
});

test("route: asks Door43 about the export PR and reports current once it merged", async () => {
  const { db, edit, snapshot } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  snapshot("ult", 2000, { pr: 41 });
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ merged: true, merged_at: "1970-01-01T00:41:40Z" }), { status: 200 });
  };
  try {
    const res = await routeApp(db)("/api/pipelines/unpublished-scripture/zec");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { book: "ZEC", ult: "current", ust: "current" });
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/dcs\.test\/api\/v1\/repos\/[^/]+\/[^/]+\/pulls\/41$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
