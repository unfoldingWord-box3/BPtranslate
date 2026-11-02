// #679 option C: the "this book has Bible text Door43 hasn't received yet"
// signal behind the AI-run warning. Driven against the REAL migrations so it
// tracks the shipped edit_log / export_snapshots schema.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/unpublishedScripture.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { unpublishedScripture } from "./unpublishedScripture.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
    bind: (...a) => mk(sql, a),
    async first() {
      const r = sqlite.prepare(sql).all(...args);
      return r.length ? r[0] : null;
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
  const exported = (book, resource, at, sha = "abc123") =>
    sqlite
      .prepare(
        `INSERT INTO export_snapshots (book, resource, commit_sha, committed_at, rows_exported)
         VALUES (?, ?, ?, ?, 10)`,
      )
      .run(book, resource, sha, at);
  return { db: makeDb(sqlite), edit, exported };
}

test("no verse edits: nothing unpublished", async () => {
  const { db } = fresh();
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: false, ust: false });
});

test("a ULT edit in a book that never exported is unpublished; UST stays clean", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: true, ust: false });
});

test("an edit older than the last successful export is published", async () => {
  const { db, edit, exported } = fresh();
  edit("ZEC/1/1/UST", 1000);
  exported("ZEC", "ust", 2000);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: false, ust: false });
});

test("an edit newer than the last successful export is unpublished", async () => {
  const { db, edit, exported } = fresh();
  exported("ZEC", "ust", 2000);
  edit("ZEC/1/1/UST", 3000);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: false, ust: true });
});

test("a failed export (no commit) does not count as published", async () => {
  const { db, edit, exported } = fresh();
  exported("ZEC", "ult", 1000);
  edit("ZEC/2/3/ULT", 2000);
  exported("ZEC", "ult", 3000, null);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: true, ust: false });
});

test("the export watermark is per resource: a UST export does not publish a ULT edit", async () => {
  const { db, edit, exported } = fresh();
  edit("ZEC/1/1/ULT", 1000);
  exported("ZEC", "ust", 2000);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: true, ust: false });
});

test("text pulled from Door43 (dcs_reimport) is not unpublished", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000, "dcs_reimport");
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: false, ust: false });
});

test("AI and chat writes to a verse count as unpublished", async () => {
  const { db, edit } = fresh();
  edit("ZEC/1/1/ULT", 1000, "ai_pipeline");
  edit("ZEC/1/2/UST", 1000, "chat");
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: true, ust: true });
});

test("another book's edits and source-text versions do not count", async () => {
  const { db, edit } = fresh();
  edit("HAG/1/1/ULT", 1000);
  edit("ZEC/1/1/UHB", 1000);
  assert.deepEqual(await unpublishedScripture(db, "ZEC"), { ult: false, ust: false });
});
