// Issue #815: house-style rules run when an AI translate draft is imported.
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/pipelineHouseStyle.test.mjs
//
// Drives the REAL importJobOutput against the REAL migration chain (node:sqlite
// behind a minimal D1 shim, as in pipelineApplySkipsTouched.test.mjs). The job
// is seeded already staged, so the import goes straight to the apply phase with
// the seeded pending_imports rows. Both runners (bot and in-Worker) import
// through this same function.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { importJobOutput } from "./pipelineImport.ts";

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
const JOB = "job-815";
const MUK = "(مُكيَّف)";
const ALT = "ترجمة بديلة:";
const LEFTOVER = "If it would be helpful in your language, قل [شيئا]";

// proposals: [{id, ...payload}] for kind "tn" (note) or "tq" (question/response).
function fresh({ kind = "tn", proposals, enable = true }) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  if (enable) sqlite.exec(`UPDATE house_style_rules SET enabled = 1`);
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (9, 909, 'translator')`).run();
  proposals.forEach((p, i) => {
    const verse = i + 1;
    if (kind === "tn") {
      sqlite
        .prepare(
          `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, quote, sort_order, version)
           VALUES (?, ?, 1, ?, ?, 'english note', ?, 10, 1)`,
        )
        .run(p.id, BOOK, verse, `1:${verse}`, `[q] ${MUK}`);
    } else {
      sqlite
        .prepare(
          `INSERT INTO tq_rows (id, book, chapter, verse, ref_raw, question, response, quote, sort_order, version)
           VALUES (?, ?, 1, ?, ?, 'english q', 'english r', ?, 10, 1)`,
        )
        .run(p.id, BOOK, verse, `1:${verse}`, `[q] ${MUK}`);
    }
  });
  const now = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state, created_at, staged_at, edit_log_watermark)
       VALUES (?, 9, 'translate', ?, 1, 1, 's', 'running', ?, ?, 0)`,
    )
    .run(JOB, BOOK, now - 100, now);
  proposals.forEach((p, i) => {
    sqlite
      .prepare(`INSERT INTO pending_imports (job_id, kind, book, chapter, verse, payload_json) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(JOB, kind, BOOK, i + 1, JSON.stringify(p));
  });
  const env = { DB: makeDb(sqlite) };
  const apply = () =>
    importJobOutput(env, { jobId: JOB, pipelineType: "translate", book: BOOK, startChapter: 1, endChapter: 1, cfg: {} }, []);
  const table = kind === "tn" ? "tn_rows" : "tq_rows";
  const row = (id) => sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  const log = (id) => {
    const r = sqlite
      .prepare(`SELECT payload_json FROM edit_log WHERE kind = ? AND row_key = ? AND source = 'ai_pipeline'`)
      .get(kind, id);
    return r ? r.payload_json : null;
  };
  return { apply, row, log };
}

test("tn: enabled rules fix the stored note; edit_log keeps raw_note + applied_rules", async () => {
  const p = { id: "aa01", note: `${ALT} [وكان معهم] ${MUK}`, quote: `[q] ${MUK}` };
  const h = fresh({ proposals: [p] });
  await h.apply();
  const r = h.row("aa01");
  assert.equal(r.note, `${ALT} [وكان معهم].`);
  assert.equal(r.quote, `[q] ${MUK}`, "Quote column untouched");
  assert.equal(r.translation_state, "ai_draft");
  assert.equal(r.draft_meta_json, null);
  const payload = JSON.parse(h.log("aa01"));
  assert.equal(payload.note, r.note, "edit_log note is what the editor sees");
  assert.equal(payload.raw_note, p.note, "the model's raw text is kept");
  assert.deepEqual(payload.applied_rules, ["ar-drop-mukayyaf-tag", "ar-final-bracket-period"]);
});

test("tn: a note no rule touches keeps today's exact edit_log payload", async () => {
  const p = { id: "aa02", note: `${ALT} [نص].`, quote: "q" };
  const h = fresh({ proposals: [p] });
  await h.apply();
  assert.equal(h.row("aa02").note, p.note);
  assert.equal(h.log("aa02"), JSON.stringify(p), "byte-identical payload: no raw_note / applied_rules");
});

test("tn: bold spans are never rewritten", async () => {
  const p = { id: "aa03", note: `**[مفيدا ${MUK}]**` };
  const h = fresh({ proposals: [p] });
  await h.apply();
  assert.equal(h.row("aa03").note, p.note);
  assert.equal(h.log("aa03"), JSON.stringify(p));
});

test("tn: disabled rules (the shipped default) change nothing", async () => {
  const p = { id: "aa04", note: `${ALT} [وكان معهم] ${MUK}` };
  const h = fresh({ proposals: [p], enable: false });
  await h.apply();
  assert.equal(h.row("aa04").note, p.note);
  assert.equal(h.log("aa04"), JSON.stringify(p));
});

test("tn: leftover English is flagged in draft_meta_json, not rewritten; existing draft_meta is kept", async () => {
  const plain = { id: "aa05", note: LEFTOVER };
  const withMeta = { id: "aa06", note: LEFTOVER, draft_meta: { model: "m1" } };
  const h = fresh({ proposals: [plain, withMeta], enable: false });
  await h.apply();
  assert.equal(h.row("aa05").note, LEFTOVER, "text is not rewritten");
  assert.deepEqual(JSON.parse(h.row("aa05").draft_meta_json), {
    leftover_english: ["If it would be helpful in your language"],
  });
  assert.deepEqual(JSON.parse(h.row("aa06").draft_meta_json), {
    model: "m1",
    leftover_english: ["If it would be helpful in your language"],
  });
});

test("tq: rules apply to question and response; raw_question / raw_response kept", async () => {
  const p = { id: "qq01", question: `ماذا كان ${MUK}؟`, response: "كان ذلك مفيدا.", quote: `[q] ${MUK}` };
  const h = fresh({ kind: "tq", proposals: [p] });
  await h.apply();
  const r = h.row("qq01");
  assert.equal(r.question, "ماذا كان؟");
  assert.equal(r.response, "كان ذلك مفيدًا.");
  assert.equal(r.quote, `[q] ${MUK}`, "Quote column untouched");
  const payload = JSON.parse(h.log("qq01"));
  assert.equal(payload.question, r.question);
  assert.equal(payload.response, r.response);
  assert.equal(payload.raw_question, p.question);
  assert.equal(payload.raw_response, p.response);
  assert.deepEqual(payload.applied_rules, ["ar-drop-mukayyaf-tag", "ar-mufidan-tanween"]);
  assert.equal("raw_note" in payload, false);
});

test("tq: untouched question/response keep today's exact edit_log payload", async () => {
  const p = { id: "qq02", question: "سؤال؟", response: "جواب." };
  const h = fresh({ kind: "tq", proposals: [p] });
  await h.apply();
  assert.equal(h.log("qq02"), JSON.stringify(p));
});
