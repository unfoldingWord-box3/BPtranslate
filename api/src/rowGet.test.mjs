// GET /api/rows/:kind/:id returns the same shape as a PATCH response (#637
// item 1 review A4). The web client re-reads a row with this route after a
// save that never landed and puts it in its cache; without latest_source the
// tn/tq AI-pipeline chip disappeared from a rebuilt row.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/rowGet.test.mjs
//
// Driven through the real Hono router against the real migration schema, with
// the same node:sqlite D1 shim as rowRestoreNoop.test.mjs.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    sql,
    args,
    bind: (...a) => mk(sql, a),
    all() {
      return { results: sqlite.prepare(sql).all(...args), success: true };
    },
    first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
    },
    run() {
      const r = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => mk(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(s.run());
      return out;
    },
  };
}

const BOOK = "JER";

function freshApp() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", 9);
    c.set("role", "editor");
    await next();
  });
  app.route("/api/rows", rows);
  const env = { DB: makeDb(sqlite) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const get = (kind, id) => app.request(`/api/rows/${kind}/${id}?book=${BOOK}`, { method: "GET" }, env, ctx);
  return { sqlite, get };
}

console.log("\n[a tn row carries latest_source from its newest edit_log entry]");
{
  const { sqlite, get } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by)
       VALUES ('ab12', ?, 36, 21, '36:21', 'n', 10, 3, 9)`,
    )
    .run(BOOK);
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, action, source) VALUES ('tn', 'ab12', ?, 9, 'update', 'manual')`)
    .run(BOOK);
  sqlite
    .prepare(`INSERT INTO edit_log (kind, row_key, book, user_id, action, source) VALUES ('tn', 'ab12', ?, 9, 'update', 'ai_pipeline')`)
    .run(BOOK);
  const res = await get("tn", "ab12");
  eq(res.status, 200, "the row is found");
  const body = await res.json();
  eq(body.latest_source, "ai_pipeline", "latest_source is the newest edit's source, as in a PATCH response");
  eq(body.version, 3, "the rest of the row is there");
}

console.log("\n[a tq row with no edit_log entry has latest_source null]");
{
  const { sqlite, get } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version)
       VALUES ('cd34', ?, 36, 21, '36:21', 'q', 'r', 10, 1)`,
    )
    .run(BOOK);
  const res = await get("tq", "cd34");
  eq(res.status, 200, "the row is found");
  const body = await res.json();
  eq("latest_source" in body, true, "the field is present");
  eq(body.latest_source, null, "and null with no edit_log entry");
}

console.log("\n[a deleted row is a 404]");
{
  const { sqlite, get } = freshApp();
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, deleted_at)
       VALUES ('ef56', ?, 36, 21, '36:21', 'q', 'r', 10, 1, 1785800000)`,
    )
    .run(BOOK);
  eq((await get("tq", "ef56")).status, 404, "deleted rows are not served");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll row GET assertions passed.");
