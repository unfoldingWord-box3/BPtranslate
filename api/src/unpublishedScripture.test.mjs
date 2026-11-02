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
  const edit = (rowKey, at, source = null) =>
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, action, created_at, source)
         VALUES ('verse', ?, ?, 'update', ?, ?)`,
      )
      .run(rowKey, rowKey.split("/")[0], at, source);
  // An export snapshot: committed to its branch (sha) with a PR, or a skip
  // (sha null) with a reason such as 'unchanged' (render equalled master).
  const snapshot = (resource, at, { sha = "abc123", pr = 7, error = null, book = "ZEC" } = {}) =>
    sqlite
      .prepare(
        `INSERT INTO export_snapshots (book, resource, commit_sha, committed_at, rows_exported, pr_number, error)
         VALUES (?, ?, ?, ?, 10, ?, ?)`,
      )
      .run(book, resource, sha, at, pr, error);
  const mergedAtOf = (resource) =>
    sqlite
      .prepare(`SELECT committed_at, merged_at FROM export_snapshots WHERE resource = ? ORDER BY id`)
      .all(resource)
      .map((r) => ({ ...r }));
  return { db: makeDb(sqlite), edit, snapshot, mergedAtOf };
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
