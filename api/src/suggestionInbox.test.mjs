// Tests for the suggestion inbox (issue #819, api/src/suggestionInbox.ts):
// repeated word-level corrections editors made to AI translation-note drafts,
// grouped into cards an admin can approve (into a house-style rule) or reject.
//
//  1. Pure pieces: tokenizing (backslash-n line breaks, NFC), word-level changes
//     between a draft and its final note, including the closing period and a
//     trailing tag deleted in the same note.
//  2. The routes against the REAL schema (every file in api/migrations applied
//     in order to node:sqlite) with a fixture of validated Arabic notes and
//     their ai_pipeline drafts: what is listed, the counts, what is excluded,
//     approve → a working rule, reject → gone for good, admin only.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/suggestionInbox.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

import { tokenize, noteChanges, changeKey, MIN_HITS, MIN_CHAPTERS, suggestionInbox } from "./suggestionInbox.ts";
import { houseStyleForProposal, loadEnabledHouseStyleRules } from "./houseStyle.ts";

// (مُكيَّف) with its marks in both orders: NFC puts the fatha before the shadda.
const MUK_NFC = "(مُكيَّف)";
const MUK_RAW = "(مُكيَّف)";
const WORDS = ["وكان معهم", "ذهب إلى البيت", "قال لهم", "في ذلك اليوم", "ثم رجع", "أعطاهم الخبز", "صعد إلى الجبل", "نزل من السفينة"];

// ── 1. Pure pieces ──────────────────────────────────────────────────────────

test("tokenize: words and single punctuation marks; spaces and stored backslash-n line breaks separate", () => {
  const toks = tokenize("ترجمة بديلة: [وكان معهم]\\nسطر");
  assert.deepEqual(
    toks.map((t) => t.text),
    ["ترجمة", "بديلة", ":", "[", "وكان", "معهم", "]", "سطر"],
  );
  assert.deepEqual(
    toks.filter((t) => t.word).map((t) => t.text),
    ["ترجمة", "بديلة", "وكان", "معهم", "سطر"],
  );
  // Offsets point into the original string.
  const t = toks[3];
  assert.equal("ترجمة بديلة: [وكان معهم]".slice(t.start, t.end), "[");
});

test("noteChanges: a closing period after the final ] is an insertion anchored on the ] at the end", () => {
  const ch = noteChanges("ترجمة بديلة: [وكان معهم]", "ترجمة بديلة: [وكان معهم].");
  assert.equal(ch.length, 1);
  assert.equal(ch[0].change, "insert-end");
  assert.equal(ch[0].before, "]");
  assert.equal(ch[0].after, "].");
  assert.equal(ch[0].key, changeKey("insert-end", "]", "]."));
});

test("noteChanges: a deleted tag keeps its own text; NFC makes both mark orders the same change", () => {
  const a = noteChanges(`هنا ${MUK_RAW} تعني`.normalize("NFC"), "هنا تعني");
  const b = noteChanges(`هنا ${MUK_NFC} تعني`, "هنا تعني");
  assert.equal(a.length, 1);
  assert.equal(a[0].change, "change");
  assert.equal(a[0].before, MUK_NFC);
  assert.equal(a[0].after, "");
  assert.equal(a[0].key, b[0].key);
});

test("noteChanges: tag deleted and period added in one note count as both changes", () => {
  const ch = noteChanges(`ترجمة بديلة: [وكان معهم] ${MUK_NFC}`, "ترجمة بديلة: [وكان معهم].");
  assert.deepEqual(
    ch.map((c) => c.key).sort(),
    [changeKey("change", MUK_NFC, ""), changeKey("insert-end", "]", "].")].sort(),
  );
});

test("noteChanges: a long rewrite is not a repeatable change; unchanged notes have none", () => {
  assert.deepEqual(noteChanges("هذا نص قديم كتبه النموذج الآلي بطريقة غير مناسبة أبدا", "عبارة جديدة تماما كتبها المحرر بنفسه بعد مراجعة دقيقة للنص"), []);
  assert.deepEqual(noteChanges("نفس النص", "نفس النص"), []);
});

test("noteChanges: a change across a stored line break is dropped", () => {
  assert.deepEqual(noteChanges("أولا\\nثانيا", "أولا ثالثا\\nرابعا"), []);
});

test("noteChanges: changes inside a **bold** Scripture quote are ignored", () => {
  assert.deepEqual(noteChanges(`يقول **هنا ${MUK_NFC} تعني** هنا`, "يقول **هنا تعني** هنا"), []);
});

// ── 2. Routes against the real schema ─────────────────────────────────────────

const BOOK = "LUK";

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
  return { prepare: (sql) => mk(sql, []), async batch(stmts) { return stmts.map((s) => s.run()); } };
}

let rowSeq = 0;
function addNote(sqlite, { chapter, draft, final }) {
  const id = `r${String(++rowSeq).padStart(3, "0")}`;
  sqlite
    .prepare(
      `INSERT INTO tn_rows (id, book, chapter, verse, ref_raw, note, version, translation_state)
       VALUES (?, ?, ?, 1, ?, ?, 3, 'validated')`,
    )
    .run(id, BOOK, chapter, `${chapter}:1`, final);
  if (draft != null) {
    sqlite
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, action, payload_json, source, created_at)
         VALUES ('tn', ?, ?, 1, 'update', ?, 'ai_pipeline', 100)`,
      )
      .run(id, BOOK, JSON.stringify({ id, note: draft }));
  }
  return id;
}

// The fixture: the period change 30x across 4 chapters (plus 5 drafts ending
// in ] that editors left alone), the (مُكيَّف) deletion 12x across 3 chapters
// (plus 2 left alone), 2 notes with both changes, a one-off rewrite, a
// substitution repeated 12x but only in 2 chapters, and a word substitution
// 10x across 3 chapters (a term, not a mechanical rule).
function fixture({ keepSeedRules = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'boss')`).run();
  // The 0082 seed rules already cover the period and (مُكيَّف); this fixture
  // is the inbox before any rule exists.
  if (!keepSeedRules) sqlite.exec(`DELETE FROM house_style_rules`);

  for (let i = 0; i < 30; i++) {
    const d = `ترجمة بديلة: [${WORDS[i % WORDS.length]} ${i}]`;
    addNote(sqlite, { chapter: 1 + (i % 4), draft: d, final: `${d}.` });
  }
  for (let i = 0; i < 5; i++) {
    const d = `ترجمة بديلة: [[rc://*/ta/man/translate/figs-metaphor${i}]]`;
    addNote(sqlite, { chapter: 5, draft: d, final: d });
  }
  for (let i = 0; i < 12; i++) {
    const tag = i % 2 ? MUK_RAW : MUK_NFC;
    addNote(sqlite, { chapter: 1 + (i % 3), draft: `هنا ${tag} تعني ${WORDS[i % WORDS.length]}`, final: `هنا تعني ${WORDS[i % WORDS.length]}` });
  }
  for (let i = 0; i < 2; i++) {
    const d = `كلمة ${MUK_NFC} باقية ${i}`;
    addNote(sqlite, { chapter: 6, draft: d, final: d });
  }
  for (let i = 0; i < 2; i++) {
    addNote(sqlite, { chapter: 4, draft: `ترجمة بديلة: [ثم رجع ${i}] ${MUK_NFC}`, final: `ترجمة بديلة: [ثم رجع ${i}].` });
  }
  addNote(sqlite, { chapter: 2, draft: "هذا نص قديم", final: "هذه عبارة جديدة تماما" });
  for (let i = 0; i < 12; i++) {
    addNote(sqlite, { chapter: 7 + (i % 2), draft: `قال يسوع كلمة ${i}`, final: `قال المسيح كلمة ${i}` });
  }
  for (let i = 0; i < 10; i++) {
    addNote(sqlite, { chapter: 9 + (i % 3), draft: `الرب يتكلم ${i}`, final: `السيد يتكلم ${i}` });
  }
  addNote(sqlite, { chapter: 1, draft: null, final: "بلا مسودة" });

  const app = new Hono();
  let role = "admin";
  app.use("*", async (c, next) => {
    c.set("userId", 1);
    c.set("role", role);
    await next();
  });
  app.route("/api/suggestion-inbox", suggestionInbox);
  const env = { DB: makeDb(sqlite) };
  const call = async (method, path, body) => {
    const res = await app.request(
      `/api/suggestion-inbox${path}`,
      { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
      env,
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { sqlite, env, call, setRole: (r) => (role = r) };
}

const PERIOD_KEY = changeKey("insert-end", "]", "].");
const MUK_KEY = changeKey("change", MUK_NFC, "");
const TERM_KEY = changeKey("change", "الرب", "السيد");

test("thresholds are the issue's: 10 hits across 3 chapters", () => {
  assert.equal(MIN_HITS, 10);
  assert.equal(MIN_CHAPTERS, 3);
});

test("GET lists the period and (مُكيَّف) cards with hit/opportunity counts; one-offs and 2-chapter changes are left out", async () => {
  const h = fixture();
  const r = await h.call("GET", `/${BOOK}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.book, BOOK);
  const keys = r.body.suggestions.map((s) => s.key);
  assert.deepEqual(keys, [PERIOD_KEY, MUK_KEY, TERM_KEY]);

  const period = r.body.suggestions[0];
  assert.equal(period.before, "]");
  assert.equal(period.after, "].");
  // 30 + the 2 combined notes; opportunities add the 5 rc-link drafts ending in ].
  assert.equal(period.hits, 32);
  assert.equal(period.opportunities, 37);
  assert.deepEqual(period.chapters, [1, 2, 3, 4]);
  assert.equal(period.home, "house_style");
  assert.deepEqual(period.rule, { kind: "final_bracket_period", find: "]", replace: "].", scope: "end-of-note" });
  assert.equal(period.examples.length, 3);
  // Examples come from different chapters and show the draft and the final.
  assert.equal(new Set(period.examples.map((e) => e.chapter)).size, 3);
  for (const e of period.examples) assert.equal(`${e.draft}.`, e.final);

  const muk = r.body.suggestions[1];
  assert.equal(muk.before, MUK_NFC);
  assert.equal(muk.after, "");
  // 12 + 2 combined; opportunities add the 2 drafts that kept it.
  assert.equal(muk.hits, 14);
  assert.equal(muk.opportunities, 16);
  assert.deepEqual(muk.chapters, [1, 2, 3, 4]);
  assert.equal(muk.home, "house_style");
  assert.deepEqual(muk.rule, { kind: "literal", find: MUK_NFC, replace: "", scope: "note" });

  const term = r.body.suggestions[2];
  assert.equal(term.hits, 10);
  assert.equal(term.opportunities, 10);
  assert.equal(term.home, "term");
  assert.equal(term.rule, null);

  assert.equal(r.body.scanned.noDraft, 1);
});

test("a change an existing house-style rule makes is not suggested, even while the rule is off", async () => {
  const h = fixture();
  h.sqlite
    .prepare(
      `INSERT INTO house_style_rules (id, kind, find, replace, scope, enabled) VALUES ('mine', 'literal', ?, '', 'note', 0)`,
    )
    .run(MUK_RAW);
  const r = await h.call("GET", `/${BOOK}`);
  assert.deepEqual(r.body.suggestions.map((s) => s.key), [PERIOD_KEY, TERM_KEY]);
  assert.equal(r.body.excluded.rule, 1);
});

test("the 0082 seed rules (switched off) already cover the period and (مُكيَّف) cards", async () => {
  const h = fixture({ keepSeedRules: true });
  const r = await h.call("GET", `/${BOOK}`);
  assert.deepEqual(r.body.suggestions.map((s) => s.key), [TERM_KEY]);
  assert.equal(r.body.excluded.rule, 2);
});

test("a change a term already gives is not suggested", async () => {
  const h = fixture();
  h.sqlite
    .prepare(`INSERT INTO terminology (concept_id, source_term, target_term, status) VALUES ('lord', 'Lord', 'السيد', 'preferred')`)
    .run();
  const r = await h.call("GET", `/${BOOK}`);
  assert.deepEqual(r.body.suggestions.map((s) => s.key), [PERIOD_KEY, MUK_KEY]);
  assert.equal(r.body.excluded.term, 1);
});

test("approving the period card creates an enabled rule that fixes the next imported draft", async () => {
  const h = fixture();
  const ok = await h.call("POST", `/${BOOK}/approve`, { key: PERIOD_KEY });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rule.kind, "final_bracket_period");
  assert.equal(ok.body.rule.enabled, true);
  const row = h.sqlite.prepare(`SELECT * FROM house_style_rules WHERE id = ?`).get(ok.body.rule.id);
  assert.equal(row.enabled, 1);
  assert.equal(row.scope, "end-of-note");
  assert.equal(row.updated_by, 1);
  const examples = JSON.parse(row.examples_json);
  assert.ok(examples.length >= 1 && examples.length <= 3);
  for (const e of examples) assert.equal(`${e.before}.`, e.after);

  // The #815 import engine now applies it.
  const rules = await loadEnabledHouseStyleRules(h.env.DB);
  const out = houseStyleForProposal({ note: "ترجمة بديلة: [ذهب معهم]" }, ["note"], rules);
  assert.equal(out.values.note, "ترجمة بديلة: [ذهب معهم].");

  // The card is now covered, so it is gone; approving it again finds nothing.
  const after = await h.call("GET", `/${BOOK}`);
  assert.deepEqual(after.body.suggestions.map((s) => s.key), [MUK_KEY, TERM_KEY]);
  const again = await h.call("POST", `/${BOOK}/approve`, { key: PERIOD_KEY });
  assert.equal(again.status, 404);
});

test("approving the (مُكيَّف) card creates an enabled literal rule that deletes the tag", async () => {
  const h = fixture();
  const ok = await h.call("POST", `/${BOOK}/approve`, { key: MUK_KEY });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.rule.kind, "literal");
  const rules = await loadEnabledHouseStyleRules(h.env.DB);
  const out = houseStyleForProposal({ note: `ترجمة بديلة: [وكان معهم] ${MUK_RAW}` }, ["note"], rules);
  assert.equal(out.values.note, "ترجمة بديلة: [وكان معهم]");
});

test("a card whose home is not a house-style rule cannot be approved as one", async () => {
  const h = fixture();
  const r = await h.call("POST", `/${BOOK}/approve`, { key: TERM_KEY });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "not_a_rule");
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM house_style_rules`).get().n, 0);
});

test("a rejected card never comes back", async () => {
  const h = fixture();
  const r = await h.call("POST", "/reject", { key: MUK_KEY });
  assert.equal(r.status, 200);
  const row = h.sqlite.prepare(`SELECT * FROM suggestion_rejections WHERE key = ?`).get(MUK_KEY);
  assert.equal(row.before_text, MUK_NFC);
  assert.equal(row.after_text, "");
  assert.equal(row.rejected_by, 1);
  const again = await h.call("POST", "/reject", { key: MUK_KEY });
  assert.equal(again.status, 200);
  const list = await h.call("GET", `/${BOOK}`);
  assert.deepEqual(list.body.suggestions.map((s) => s.key), [PERIOD_KEY, TERM_KEY]);
  assert.equal(list.body.excluded.rejected, 1);
  // A rejected card cannot be approved either.
  const approve = await h.call("POST", `/${BOOK}/approve`, { key: MUK_KEY });
  assert.equal(approve.status, 404);
});

test("reject refuses a key that is not a suggestion key", async () => {
  const h = fixture();
  for (const key of ["", "nope", JSON.stringify(["other", "a", "b"]), JSON.stringify(["change", "", ""])]) {
    const r = await h.call("POST", "/reject", { key });
    assert.equal(r.status, 400, key);
  }
});

test("an editor gets 403 on every inbox route", async () => {
  const h = fixture();
  h.setRole("editor");
  assert.equal((await h.call("GET", `/${BOOK}`)).status, 403);
  assert.equal((await h.call("POST", `/${BOOK}/approve`, { key: PERIOD_KEY })).status, 403);
  assert.equal((await h.call("POST", "/reject", { key: PERIOD_KEY })).status, 403);
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM house_style_rules`).get().n, 0);
});

test("an unknown book is refused", async () => {
  const h = fixture();
  assert.equal((await h.call("GET", "/XYZ")).status, 400);
});
