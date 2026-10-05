// The 409 diagnostic insert (rowConflictLog.ts) run against real SQLite with
// the real migration, so a column/param drift between the two fails here
// rather than silently in prod (the insert is best-effort and swallows errors).

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ROW_CONFLICT_INSERT_SQL, rowConflictBindValues } from "./rowConflictLog.ts";

const migration = readFileSync(
  new URL("../migrations/0074_row_conflict_log.sql", import.meta.url),
  "utf8",
);

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  return db;
}

test("a patch 409 lands with every diagnostic column", () => {
  const db = freshDb();
  const values = rowConflictBindValues({
    kind: "tn",
    rowId: "fd2c",
    book: "LUK",
    action: "patch",
    userId: 7,
    expectedVersion: 1,
    fields: ["note"],
    current: { version: 2, updated_by: 7, updated_at: 1790000000, deleted_at: null },
    headers: { opQueuedAt: "1790000000123", clientRoute: "#/notes/LUK/7/36", tabId: "ab12cd34" },
  });
  db.prepare(ROW_CONFLICT_INSERT_SQL).run(...values);
  const row = db.prepare("SELECT * FROM row_conflict_log").get();
  assert.equal(row.kind, "tn");
  assert.equal(row.row_id, "fd2c");
  assert.equal(row.book, "LUK");
  assert.equal(row.action, "patch");
  assert.equal(row.user_id, 7);
  assert.equal(row.expected_version, 1);
  assert.equal(row.current_version, 2);
  assert.equal(row.current_updated_by, 7);
  assert.equal(row.current_updated_at, 1790000000);
  assert.equal(row.fields_json, '["note"]');
  assert.equal(row.op_queued_at, 1790000000123);
  assert.equal(row.client_route, "#/notes/LUK/7/36");
  assert.equal(row.tab_id, "ab12cd34");
  assert.ok(row.created_at > 0);
});

test("missing headers and a narrow delete-path SELECT store NULLs, not garbage", () => {
  const db = freshDb();
  const values = rowConflictBindValues({
    kind: "tq",
    rowId: "x1",
    book: "LUK",
    action: "delete",
    userId: null,
    expectedVersion: 4,
    fields: [],
    current: { version: 5, deleted_at: null },
    headers: { opQueuedAt: "not-a-number", clientRoute: "   ", tabId: undefined },
  });
  db.prepare(ROW_CONFLICT_INSERT_SQL).run(...values);
  const row = db.prepare("SELECT * FROM row_conflict_log").get();
  assert.equal(row.current_version, 5);
  assert.equal(row.current_updated_by, null);
  assert.equal(row.current_updated_at, null);
  assert.equal(row.op_queued_at, null);
  assert.equal(row.client_route, null);
  assert.equal(row.tab_id, null);
  assert.equal(row.user_id, null);
});

test("client-supplied header text is clamped", () => {
  const values = rowConflictBindValues({
    kind: "tn",
    rowId: "r",
    book: "LUK",
    action: "patch",
    userId: 1,
    expectedVersion: 1,
    fields: ["note"],
    current: null,
    headers: { clientRoute: "#/" + "x".repeat(500), tabId: "t".repeat(500) },
  });
  assert.equal(values[11].length, 120);
  assert.equal(values[12].length, 64);
});
