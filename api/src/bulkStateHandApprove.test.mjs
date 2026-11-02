// Issue #414, option A: a note an admin approved in BULK becomes a human-approved
// AI example again once a person approves it by hand, and translation-memory
// suggestions skip notes that were only ever bulk-approved.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/bulkStateHandApprove.test.mjs
//
// THE TRAP. The bulk stamp (admin_bulk_state, migration 0071) does two jobs:
// it keeps the row out of the few-shot selectors, and it makes the row
// non-pristine so the nightly reimport cannot overwrite it (#394,
// isReimportableRow). Per-row validate leaves updated_by alone and its edit_log
// action ('validate') is not a content action, so clearing the stamp alone would
// turn an imported (updated_by NULL) row back into "pristine" and let the
// reimport rewrite approved work. The fix records the approver in updated_by
// when it clears the stamp; these tests pin both halves.
//
// Same harness as chapterLockApproveTrash.test.mjs: the REAL Hono routers
// against the REAL migration schema.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { rows } from "./rows.ts";
import { bulkReviewState } from "./reviewState.ts";
import { translationMemory } from "./translationMemory.ts";
import { VALIDATED_TN_EXAMPLES_SQL, VALIDATED_TQ_EXAMPLES_SQL } from "./contextExport.ts";
import { isReimportableRow } from "./reimportClassify.ts";

function makeDb(sqlite) {
  const mk = (sql, args) => ({
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

const BOOK = "ZEC";
const ADMIN = 9;

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (?, 909, 'admin')`).run(ADMIN);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (5, 505, 'ai-bot')`).run();
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, sort_order, version, updated_by, translation_state)
     VALUES (?, ?, ?, ?, ?, ?, 10, 1, ?, ?)`,
  );
  // Chapter 1 gets bulk-approved. imp1: imported, never drafted, nobody touched
  // it (updated_by NULL). ai01: an AI draft nobody has edited (updated_by set,
  // latest content edit_log source ai_pipeline).
  tn.run("imp1", BOOK, 1, 1, "1:1", "imported note", null, null);
  tn.run("ai01", BOOK, 1, 2, "1:2", "ai note", 5, "ai_draft");
  // Chapter 2 is never swept: ai02 is the control for "an AI draft approved by
  // hand without any bulk sweep".
  tn.run("ai02", BOOK, 2, 1, "2:1", "ai note 2", 5, "ai_draft");
  const log = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
     VALUES ('tn', ?, ?, 5, 0, 1, 'create', 'ai_pipeline')`,
  );
  log.run("ai01", BOOK);
  log.run("ai02", BOOK);
  sqlite
    .prepare(
      `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, sort_order, version, updated_by, translation_state)
       VALUES ('tq01', ?, 1, 1, '1:1', 'q?', 'a.', 10, 1, NULL, NULL)`,
    )
    .run(BOOK);

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", ADMIN);
    c.set("role", "admin");
    await next();
  });
  app.route("/api/rows", rows);
  app.post("/api/books/:book/review-state", bulkReviewState);
  app.route("/api/translation-memory", translationMemory);
  const env = { DB: makeDb(sqlite) };
  const ctx = {
    waitUntil(p) {
      if (p && typeof p.catch === "function") p.catch(() => {});
    },
    passThroughOnException() {},
  };
  const req = (path, init) => app.request(path, init, env, ctx);
  const json = (method, path, body) =>
    req(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const validate = (kind, id, value) => json("POST", `/api/rows/${kind}/${id}/validate?book=${BOOK}`, { value });
  const sweep = (resource, chapter) =>
    json("POST", `/api/books/${BOOK}/review-state`, { resource, state: "approved", chapter });

  const table = (kind) => (kind === "tn" ? "tn_rows" : "tq_rows");
  const row = (kind, id) => sqlite.prepare(`SELECT * FROM ${table(kind)} WHERE id = ?`).get(id);
  // The reimport's view of the row: the same latest-content-source subquery as
  // bookReimport.ts, fed to the real pristine predicate.
  const reimportable = (kind, id) => {
    const r = row(kind, id);
    const src = sqlite
      .prepare(
        `SELECT source FROM edit_log WHERE kind = ? AND row_key = ? AND action IN ('create', 'update')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(kind, id);
    return isReimportableRow({ ...r, latestSource: src?.source ?? null, kind });
  };
  const fewShotIds = (kind) =>
    sqlite
      .prepare(kind === "tn" ? VALIDATED_TN_EXAMPLES_SQL : VALIDATED_TQ_EXAMPLES_SQL)
      .all()
      .map((r) => r.id)
      .sort();
  const tmIds = async (resource) => {
    const res = await req(`/api/translation-memory/examples?resource=${resource}`, { method: "GET" });
    assert.equal(res.status, 200);
    return (await res.json()).examples.map((r) => r.id).sort();
  };
  return { sqlite, validate, sweep, row, reimportable, fewShotIds, tmIds };
}

test("bulk-approved rows are excluded from few-shot examples and protected from the reimport (baseline)", async () => {
  const { sweep, row, reimportable, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal(row("tn", "imp1").translation_state, "validated");
  assert.notEqual(row("tn", "imp1").admin_bulk_state, null);
  assert.deepEqual(fewShotIds("tn"), []);
  assert.equal(reimportable("tn", "imp1"), false);
  assert.equal(reimportable("tn", "ai01"), false);
});

test("hand-approving a bulk-approved imported tn row makes it a few-shot example and keeps it out of the reimport", async () => {
  const { sweep, validate, row, reimportable, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  const res = await validate("tn", "imp1", 1);
  assert.equal(res.status, 200);
  const r = row("tn", "imp1");
  assert.equal(r.translation_state, "validated");
  assert.equal(r.admin_bulk_state, null, "the hand approval clears the bulk stamp");
  assert.equal(r.updated_by, ADMIN, "the approver is recorded so the row is no longer pristine");
  assert.equal(r.version, 1, "still a state flip: no version bump");
  assert.deepEqual(fewShotIds("tn"), ["imp1"], "it counts as a human-approved example again");
  assert.equal(reimportable("tn", "imp1"), false, "the nightly reimport still may not overwrite it");
});

test("hand-approving a bulk-approved AI draft lands where a hand-approved AI draft without a sweep does", async () => {
  const { sweep, validate, row, reimportable, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal((await validate("tn", "ai01", 1)).status, 200);
  assert.equal((await validate("tn", "ai02", 1)).status, 200);
  assert.equal(row("tn", "ai01").admin_bulk_state, null);
  assert.equal(row("tn", "ai01").updated_by, 5, "an existing author is kept");
  assert.deepEqual(fewShotIds("tn"), ["ai01", "ai02"]);
  assert.equal(reimportable("tn", "ai01"), reimportable("tn", "ai02"), "same reimport treatment as the no-sweep control");
});

test("un-approving a bulk-approved row keeps the stamp and authorship", async () => {
  const { sweep, validate, row, reimportable } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  const stamp = row("tn", "imp1").admin_bulk_state;
  assert.equal((await validate("tn", "imp1", 0)).status, 200);
  const r = row("tn", "imp1");
  assert.equal(r.translation_state, "edited");
  assert.equal(r.admin_bulk_state, stamp);
  assert.equal(r.updated_by, null);
  assert.equal(reimportable("tn", "imp1"), false);
});

test("hand-approving a never-swept row leaves updated_by alone", async () => {
  const { validate, row } = fresh();
  assert.equal((await validate("tn", "ai02", 1)).status, 200);
  assert.equal(row("tn", "ai02").updated_by, 5);
  assert.equal(row("tn", "ai02").admin_bulk_state, null);
});

test("tq: hand-approving a bulk-approved imported row clears the stamp and keeps it out of the reimport", async () => {
  const { sweep, validate, row, reimportable, fewShotIds } = fresh();
  assert.equal((await sweep("tq", 1)).status, 200);
  assert.deepEqual(fewShotIds("tq"), []);
  assert.equal((await validate("tq", "tq01", 1)).status, 200);
  const r = row("tq", "tq01");
  assert.equal(r.admin_bulk_state, null);
  assert.equal(r.updated_by, ADMIN);
  assert.deepEqual(fewShotIds("tq"), ["tq01"]);
  assert.equal(reimportable("tq", "tq01"), false);
});

test("translation-memory examples skip bulk-only rows and include them once approved by hand", async () => {
  const { sweep, validate, tmIds } = fresh();
  assert.equal((await validate("tn", "ai02", 1)).status, 200);
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal((await sweep("tq", 1)).status, 200);
  assert.deepEqual(await tmIds("tn"), ["ai02"], "bulk-only tn rows are not suggested");
  assert.deepEqual(await tmIds("tq"), [], "bulk-only tq rows are not suggested");
  assert.equal((await validate("tn", "imp1", 1)).status, 200);
  assert.equal((await validate("tq", "tq01", 1)).status, 200);
  assert.deepEqual(await tmIds("tn"), ["ai02", "imp1"]);
  assert.deepEqual(await tmIds("tq"), ["tq01"]);
});
