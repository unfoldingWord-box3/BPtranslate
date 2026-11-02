// Issues #414 (option A) and #732.
//
// #414: a note an admin approved in BULK becomes a human-approved AI example
// again once a person approves it by hand, and translation-memory suggestions
// skip notes that were only ever bulk-approved. Approve-all in the review UI is
// itself a bulk approver: it sends `bulk: true` and keeps the stamp.
//
// #732: an approved row is never overwritten by the nightly reimport. Approval
// is a state flip (no version bump, updated_by untouched, edit_log action
// 'validate', which the reimport's latest-content-source query ignores), so
// before this an AI draft approved without edits still read as "AI-only" and a
// bulk-approved imported row read as "pristine" once its stamp was gone.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/bulkStateHandApprove.test.mjs
//
// The REAL Hono routers and the REAL reimport apply (applyTsvRows, which runs
// isReimportableRow on its own SELECT), against the REAL migration schema.

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
import { applyTsvRows } from "./bookReimport.ts";

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

// The rows as master carries them, with a different text: what the nightly
// reimport would write if it were allowed to.
const TN = {
  imp1: { refRaw: "1:1", chapter: 1, verse: 1, note: "imported note" },
  ai01: { refRaw: "1:2", chapter: 1, verse: 2, note: "ai note" },
  ai02: { refRaw: "2:1", chapter: 2, verse: 1, note: "ai note 2" },
  pri2: { refRaw: "2:2", chapter: 2, verse: 2, note: "pristine note" },
  ai03: { refRaw: "2:3", chapter: 2, verse: 3, note: "ai note 3" },
};
const masterTn = (id) => ({
  id,
  refRaw: TN[id].refRaw,
  chapter: TN[id].chapter,
  verse: TN[id].verse,
  occurrence: 1,
  tags: null,
  support_reference: null,
  quote: null,
  note: "MASTER DRIFT",
});
const masterTq = () => ({
  id: "tq01",
  refRaw: "1:1",
  chapter: 1,
  verse: 1,
  occurrence: null,
  tags: null,
  quote: null,
  question: "MASTER DRIFT?",
  response: "drift.",
});

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (?, 909, 'admin')`).run(ADMIN);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (5, 505, 'ai-bot')`).run();
  const tn = sqlite.prepare(
    `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, occurrence, sort_order, version, updated_by, translation_state)
     VALUES (?, ?, ?, ?, ?, ?, 1, 10, 1, ?, ?)`,
  );
  // Chapter 1 gets bulk-approved. imp1: imported, never drafted, nobody touched
  // it (updated_by NULL). ai01: an AI draft nobody has edited (updated_by set,
  // latest content edit_log source ai_pipeline).
  // Chapter 2 is never swept. ai02: an AI draft (the #732 case once approved).
  // pri2: an untouched imported row. ai03: an AI draft nobody approves.
  const seed = (id, updatedBy, state) => {
    const r = TN[id];
    tn.run(id, BOOK, r.chapter, r.verse, r.refRaw, r.note, updatedBy, state);
  };
  seed("imp1", null, null);
  seed("ai01", 5, "ai_draft");
  seed("ai02", 5, "ai_draft");
  seed("pri2", null, null);
  seed("ai03", 5, "ai_draft");
  const log = sqlite.prepare(
    `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
     VALUES ('tn', ?, ?, 5, 0, 1, 'create', 'ai_pipeline')`,
  );
  for (const id of ["ai01", "ai02", "ai03"]) log.run(id, BOOK);
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
  const validate = (kind, id, value, extra = {}) =>
    json("POST", `/api/rows/${kind}/${id}/validate?book=${BOOK}`, { value, ...extra });
  const sweep = (resource, chapter) =>
    json("POST", `/api/books/${BOOK}/review-state`, { resource, state: "approved", chapter });

  const table = (kind) => (kind === "tn" ? "tn_rows" : "tq_rows");
  const row = (kind, id) => sqlite.prepare(`SELECT * FROM ${table(kind)} WHERE id = ?`).get(id);
  // Run the real nightly-reimport apply with master's drifted text for `ids`.
  const reimport = (kind, ids) =>
    applyTsvRows(env, BOOK, kind, kind === "tn" ? ids.map(masterTn) : [masterTq()], null);
  const overwritten = (kind, id) =>
    kind === "tn" ? row("tn", id).note === "MASTER DRIFT" : row("tq", id).question === "MASTER DRIFT?";
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
  return { sqlite, validate, sweep, row, reimport, overwritten, fewShotIds, tmIds };
}

test("bulk-approved rows are excluded from few-shot examples and protected from the reimport (baseline)", async () => {
  const { sweep, row, reimport, overwritten, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal(row("tn", "imp1").translation_state, "validated");
  assert.notEqual(row("tn", "imp1").admin_bulk_state, null);
  assert.deepEqual(fewShotIds("tn"), []);
  await reimport("tn", ["imp1", "ai01"]);
  assert.equal(overwritten("tn", "imp1"), false);
  assert.equal(overwritten("tn", "ai01"), false);
});

test("hand-approving a bulk-approved imported tn row makes it a few-shot example and the reimport still skips it", async () => {
  const { sweep, validate, row, reimport, overwritten, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal((await validate("tn", "imp1", 1)).status, 200);
  const r = row("tn", "imp1");
  assert.equal(r.translation_state, "validated");
  assert.equal(r.admin_bulk_state, null, "the hand approval clears the bulk stamp");
  assert.equal(r.updated_by, null, "authorship is left alone");
  assert.equal(r.version, 1, "still a state flip: no version bump");
  assert.deepEqual(fewShotIds("tn"), ["imp1"], "it counts as a human-approved example again");
  const counts = await reimport("tn", ["imp1"]);
  assert.equal(overwritten("tn", "imp1"), false, "the nightly reimport may not overwrite it");
  assert.equal(counts.skipped_edited, 1);
  assert.equal(row("tn", "imp1").translation_state, "validated");
});

test("hand-approving a bulk-approved AI draft: the reimport does not overwrite it", async () => {
  const { sweep, validate, row, reimport, overwritten, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal((await validate("tn", "ai01", 1)).status, 200);
  assert.equal(row("tn", "ai01").admin_bulk_state, null);
  assert.equal(row("tn", "ai01").updated_by, 5, "an existing author is kept");
  assert.deepEqual(fewShotIds("tn"), ["ai01"]);
  const counts = await reimport("tn", ["ai01"]);
  assert.equal(overwritten("tn", "ai01"), false);
  assert.equal(counts.reimported_ai, 0);
  assert.equal(row("tn", "ai01").updated_by, 5, "not reclaimed to master-owned");
});

test("#732: an AI draft approved by hand without any sweep is not overwritten by the reimport", async () => {
  const { validate, row, reimport, overwritten } = fresh();
  assert.equal((await validate("tn", "ai02", 1)).status, 200);
  const counts = await reimport("tn", ["ai02"]);
  assert.equal(overwritten("tn", "ai02"), false);
  assert.equal(counts.reimported_ai, 0);
  assert.equal(row("tn", "ai02").translation_state, "validated");
});

test("rows nobody approved are reimported exactly as before", async () => {
  const { row, reimport, overwritten } = fresh();
  const counts = await reimport("tn", ["pri2", "ai03"]);
  assert.equal(overwritten("tn", "pri2"), true, "an untouched imported row takes master's text");
  assert.equal(overwritten("tn", "ai03"), true, "an unapproved AI draft is re-seeded from master");
  assert.equal(counts.reimported_ai, 1);
  assert.equal(row("tn", "ai03").updated_by, null, "and reclaimed to master-owned");
});

test("un-approving a bulk-approved row keeps the stamp", async () => {
  const { sweep, validate, row, reimport, overwritten } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  const stamp = row("tn", "imp1").admin_bulk_state;
  assert.equal((await validate("tn", "imp1", 0)).status, 200);
  const r = row("tn", "imp1");
  assert.equal(r.translation_state, "edited");
  assert.equal(r.admin_bulk_state, stamp);
  await reimport("tn", ["imp1"]);
  assert.equal(overwritten("tn", "imp1"), false);
});

test("Approve-all (bulk: true) keeps the bulk stamp; a one-at-a-time approval clears it", async () => {
  const { sweep, validate, row, fewShotIds } = fresh();
  assert.equal((await sweep("tn", 1)).status, 200);
  assert.equal((await sweep("tq", 1)).status, 200);
  assert.equal((await validate("tn", "imp1", 1, { bulk: true })).status, 200);
  assert.equal((await validate("tq", "tq01", 1, { bulk: true })).status, 200);
  assert.notEqual(row("tn", "imp1").admin_bulk_state, null, "tn: Approve-all keeps the stamp");
  assert.notEqual(row("tq", "tq01").admin_bulk_state, null, "tq: Approve-all keeps the stamp");
  assert.deepEqual(fewShotIds("tn"), []);
  assert.deepEqual(fewShotIds("tq"), []);
  assert.equal((await validate("tn", "imp1", 1, { bulk: false })).status, 200);
  assert.equal(row("tn", "imp1").admin_bulk_state, null, "bulk: false is a hand approval");
  assert.equal((await validate("tq", "tq01", 1)).status, 200);
  assert.equal(row("tq", "tq01").admin_bulk_state, null, "no flag is a hand approval");
});

test("a bad bulk flag is refused", async () => {
  const { validate } = fresh();
  assert.equal((await validate("tn", "ai02", 1, { bulk: "yes" })).status, 400);
});

test("tq: hand-approving a bulk-approved imported row clears the stamp and the reimport still skips it", async () => {
  const { sweep, validate, row, reimport, overwritten, fewShotIds } = fresh();
  assert.equal((await sweep("tq", 1)).status, 200);
  assert.deepEqual(fewShotIds("tq"), []);
  assert.equal((await validate("tq", "tq01", 1)).status, 200);
  const r = row("tq", "tq01");
  assert.equal(r.admin_bulk_state, null);
  assert.equal(r.updated_by, null);
  assert.deepEqual(fewShotIds("tq"), ["tq01"]);
  const counts = await reimport("tq", ["tq01"]);
  assert.equal(overwritten("tq", "tq01"), false);
  assert.equal(counts.skipped_edited, 1);
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
