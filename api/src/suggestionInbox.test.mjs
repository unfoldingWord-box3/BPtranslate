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

import {
  tokenize,
  noteChanges,
  changeKey,
  buildInbox,
  ruleReproduces,
  checkExamples,
  realExamples,
  draftLine,
  MIN_HITS,
  MIN_CHAPTERS,
  suggestionInbox,
} from "./suggestionInbox.ts";
import { compileRule, houseStyleForProposal, loadEnabledHouseStyleRules } from "./houseStyle.ts";

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
function fixture({ keepSeedRules = false, notes = null } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  sqlite.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 1, 'boss')`).run();
  // The 0082 seed rules already cover the period and (مُكيَّف); this fixture
  // is the inbox before any rule exists.
  if (!keepSeedRules) sqlite.exec(`DELETE FROM house_style_rules`);

  if (notes) for (const n of notes) addNote(sqlite, n);
  else seedDefault(sqlite);
  return route(sqlite);
}

function seedDefault(sqlite) {
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
}

function route(sqlite) {
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
  // Precision: the rule fires on the 30 drafts ending in a plain "]" and is
  // right on all of them. It skips the rc-link "]]" drafts and the two drafts
  // that end with the tag, so neither counts for or against it.
  assert.deepEqual(period.precision, { fires: 30, correct: 30, minPrecision: 0.8 });
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
  // It would also delete the tag in the 2 drafts the editor left alone: 14 of 16.
  assert.deepEqual(muk.precision, { fires: 16, correct: 14, minPrecision: 0.8 });

  const term = r.body.suggestions[2];
  assert.equal(term.hits, 10);
  assert.equal(term.opportunities, 10);
  assert.equal(term.home, "term");
  assert.equal(term.rule, null);

  assert.equal(r.body.scanned.noDraft, 1);
});

test("precision: a marks-only rule that would also fire inside ZWNJ compounds the editor left alone is not offered", async () => {
  const zwnj = String.fromCharCode(0x200c);
  const notes = [];
  for (let i = 0; i < 10; i++) notes.push({ chapter: 1 + (i % 3), draft: `قد يكون مفيدا هنا ${i}`, final: `قد يكون مفيدًا هنا ${i}` });
  // "مفيدا" + ZWNJ + "ها": one word to the editor; whole_word still matches its start.
  for (let i = 0; i < 3; i++) notes.push({ chapter: 4, draft: `هذه مفيدا${zwnj}ها ${i}`, final: `هذه مفيدا${zwnj}ها ${i}` });
  const h = fixture({ notes });
  const key = changeKey("change", "مفيدا", "مفيدًا");
  const card = (await h.call("GET", `/${BOOK}`)).body.suggestions.find((s) => s.key === key);
  assert.equal(card.hits, 10);
  assert.equal(card.opportunities, 10); // the diff alone sees no other chance
  assert.deepEqual(card.precision, { fires: 13, correct: 10, minPrecision: 0.9 });
  assert.equal(card.ruleBlocked, "precision");
  assert.notEqual(card.home, "house_style");
  const approve = await h.call("POST", `/${BOOK}/approve`, { key });
  assert.equal(approve.status, 409);
  assert.equal(approve.body.error, "rule_imprecise");
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM house_style_rules`).get().n, 0);
});

test("precision: drafts the diff cap skipped still count as correct when the rule matches them", async () => {
  const notes = [];
  for (let i = 0; i < 10; i++) notes.push({ chapter: 1 + (i % 3), draft: `قد يكون مفيدا هنا ${i}`, final: `قد يكون مفيدًا هنا ${i}` });
  // Long notes whose rest was rewritten (a middle over 400 tokens): the
  // grouping diff skips them, but the editor made the same mark change.
  const many = (p, i) => Array.from({ length: 450 }, (_, k) => `${p}${i}x${k}`).join(" ");
  for (let i = 0; i < 3; i++) {
    notes.push({ chapter: 5, draft: `هنا مفيدا تعني ${many("أ", i)}`, final: `هنا مفيدًا تعني ${many("ب", i)}` });
  }
  const h = fixture({ notes });
  const r = (await h.call("GET", `/${BOOK}`)).body;
  assert.equal(r.scanned.skippedLong, 3);
  const card = r.suggestions.find((s) => s.key === changeKey("change", "مفيدا", "مفيدًا"));
  // 10 hits of 13 opportunities (77%) would have failed a 90% share; the rule
  // is right on all 13 drafts it changes.
  assert.equal(card.hits, 10);
  assert.equal(card.opportunities, 13);
  assert.deepEqual(card.precision, { fires: 13, correct: 13, minPrecision: 0.9 });
  assert.equal(card.home, "house_style");
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
  // Stored examples are real pairs: whole draft lines, no "…".
  const examples = JSON.parse(row.examples_json);
  assert.equal(examples.length, 3);
  for (const e of examples) {
    assert.match(e.before, /^ترجمة بديلة: \[.*\]$/);
    assert.ok(!e.before.includes("…"));
    assert.equal(`${e.before}.`, e.after);
  }

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
  const row = h.sqlite.prepare(`SELECT examples_json FROM house_style_rules WHERE id = ?`).get(ok.body.rule.id);
  const examples = JSON.parse(row.examples_json);
  assert.equal(examples.length, 3);
  for (const e of examples) {
    assert.match(e.before, /^هنا \(.+\) تعني /);
    assert.equal(e.after, e.before.replace(/ \(.+\)/, ""));
  }
  // It fires on a non-NFC draft too (marks in the other order): the #815
  // engine matches combining marks in any order.
  const rules = await loadEnabledHouseStyleRules(h.env.DB);
  const out = houseStyleForProposal({ note: `ترجمة بديلة: [وكان معهم] ${MUK_RAW}` }, ["note"], rules);
  assert.equal(out.values.note, "ترجمة بديلة: [وكان معهم]");
});

test("only safe shapes become rules: punctuation swaps, word+punctuation, respellings and bare word deletions do not", async () => {
  const notes = [];
  const add = (draft, final) => {
    for (let i = 0; i < 10; i++) notes.push({ chapter: 1 + (i % 3), draft: draft(i), final: final(i) });
  };
  add((i) => `قال "نعم ${i}`, (i) => `قال «نعم ${i}`); // " → «
  add((i) => `أولا، ثم ${i}`, (i) => `أولا ثم ${i}`); // delete ،
  add((i) => `هنا أي: كلمة ${i}`, (i) => `هنا كلمة ${i}`); // word+punctuation literal
  add((i) => `قد يكون ذلك ${i}`, (i) => `قد تكون ذلك ${i}`); // one-letter respelling
  add((i) => `مهم جدا ${i}`, (i) => `مهم ${i}`); // bare word deletion
  const h = fixture({ notes });
  const r = await h.call("GET", `/${BOOK}`);
  const keys = [
    changeKey("change", '"', "«"),
    changeKey("change", "،", ""),
    changeKey("change", "أي:", ""),
    changeKey("change", "يكون", "تكون"),
    changeKey("change", "جدا", ""),
  ];
  for (const key of keys) {
    const card = r.body.suggestions.find((s) => s.key === key);
    assert.ok(card, key);
    assert.notEqual(card.home, "house_style", key);
    assert.equal(card.rule, null, key);
    const approve = await h.call("POST", `/${BOOK}/approve`, { key });
    assert.equal(approve.status, 409, key);
    assert.equal(approve.body.error, "not_a_rule", key);
  }
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM house_style_rules`).get().n, 0);
});

test("a marks-only respelling becomes a whole_word rule only at 90% of opportunities", async () => {
  const notes = (kept) => {
    const out = [];
    for (let i = 0; i < 10; i++) out.push({ chapter: 1 + (i % 3), draft: `قد يكون مفيدا هنا ${i}`, final: `قد يكون مفيدًا هنا ${i}` });
    for (let i = 0; i < kept; i++) out.push({ chapter: 4, draft: `كان مفيدا ${i}`, final: `كان مفيدا ${i}` });
    return out;
  };
  const key = changeKey("change", "مفيدا", "مفيدًا");
  const high = await fixture({ notes: notes(1) }).call("GET", `/${BOOK}`); // 10 of 11
  const card = high.body.suggestions.find((s) => s.key === key);
  assert.equal(card.home, "house_style");
  assert.deepEqual(card.rule, { kind: "whole_word", find: "مفيدا", replace: "مفيدًا", scope: "note" });
  const low = await fixture({ notes: notes(2) }).call("GET", `/${BOOK}`); // 10 of 12
  assert.notEqual(low.body.suggestions.find((s) => s.key === key).home, "house_style");
});

test("an existing rule that removes the text but writes something else does not cover the card", async () => {
  const h = fixture();
  h.sqlite
    .prepare(`INSERT INTO house_style_rules (id, kind, find, replace, scope, enabled) VALUES ('other', 'literal', ?, 'مكيف', 'note', 0)`)
    .run(MUK_NFC);
  const r = await h.call("GET", `/${BOOK}`);
  assert.ok(r.body.suggestions.some((s) => s.key === MUK_KEY));
  assert.equal(r.body.excluded.rule, 0);
});

test("ruleReproduces: exactly the editor's change, nothing more", () => {
  const fn = compileRule({ id: "t", kind: "literal", find: MUK_NFC, replace: "", scope: "note", examples: [], counterExamples: [], enabled: true, sortOrder: 0 });
  assert.equal(ruleReproduces(fn, MUK_KEY, `أ ${MUK_NFC} ب`, "أ ب"), true);
  // The editor removed only one of two tags: the rule would remove both.
  assert.equal(ruleReproduces(fn, MUK_KEY, `أ ${MUK_NFC} ب ${MUK_NFC} ج`, `أ ب ${MUK_NFC} ج`), false);
  // Nothing to do.
  assert.equal(ruleReproduces(fn, MUK_KEY, "أ ب", "أ ب"), false);
});

test("draftLine: the stored line break bounds an example", () => {
  const d = `أول سطر\\nهنا ${MUK_NFC} تعني\\nآخر`;
  const s = d.indexOf("(");
  assert.equal(draftLine(d, s, s + MUK_NFC.length), `هنا ${MUK_NFC} تعني`);
  assert.equal(draftLine("كلمة وحيدة", 0, 4), "كلمة وحيدة");
});

test("tokens: bidi marks drop out of change text; ZWNJ stays inside a word; an insertion before a one-token draft is not insert-end", () => {
  const rlm = String.fromCharCode(0x200f);
  assert.deepEqual(noteChanges("[x]", `[x]${rlm}.`).map((c) => c.key), [changeKey("insert-end", "]", "].")]);
  const zwnj = String.fromCharCode(0x200c);
  assert.deepEqual(tokenize(`می${zwnj}خواهم`).map((t) => t.text), [`می${zwnj}خواهم`]);
  const ch = noteChanges("كلمة", "«كلمة");
  assert.equal(ch.length, 1);
  assert.equal(ch[0].change, "insert");
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
  const r = await h.call("POST", `/${BOOK}/reject`, { key: MUK_KEY });
  assert.equal(r.status, 200);
  const row = h.sqlite.prepare(`SELECT * FROM suggestion_rejections WHERE key = ?`).get(MUK_KEY);
  assert.equal(row.before_text, MUK_NFC);
  assert.equal(row.after_text, "");
  assert.equal(row.rejected_by, 1);
  // Gone from the inbox, so a second reject finds no card.
  const again = await h.call("POST", `/${BOOK}/reject`, { key: MUK_KEY });
  assert.equal(again.status, 404);
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
    const r = await h.call("POST", `/${BOOK}/reject`, { key });
    assert.equal(r.status, 400, key);
  }
  // Well-formed, but not a card shown for this book: refused, nothing stored.
  const stray = await h.call("POST", `/${BOOK}/reject`, { key: changeKey("change", "ليس", "بطاقة") });
  assert.equal(stray.status, 404);
  const other = await h.call("POST", "/MRK/reject", { key: MUK_KEY });
  assert.equal(other.status, 404);
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM suggestion_rejections`).get().n, 0);
});

test("an editor gets 403 on every inbox route", async () => {
  const h = fixture();
  h.setRole("editor");
  assert.equal((await h.call("GET", `/${BOOK}`)).status, 403);
  assert.equal((await h.call("POST", `/${BOOK}/approve`, { key: PERIOD_KEY })).status, 403);
  assert.equal((await h.call("POST", `/${BOOK}/reject`, { key: PERIOD_KEY })).status, 403);
  assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM house_style_rules`).get().n, 0);
});

test("an unknown book is refused", async () => {
  const h = fixture();
  assert.equal((await h.call("GET", "/XYZ")).status, 400);
});

// ── 3. Homes and coverage, on the pure builder ──────────────────────────────

test("noteChanges: a change at the very start of a note never throws and stays one change", () => {
  assert.deepEqual(noteChanges("كلمة أخرى", "…").map((c) => c.key), [changeKey("change", "كلمة أخرى", "…")]);
  assert.deepEqual(noteChanges("كلمة", ".").map((c) => c.key), [changeKey("change", "كلمة", ".")]);
});

const emptyCtx = () => ({ rules: [], terms: [], templates: [], commonIssues: "", rejected: new Set() });
const repeated = (draft, final) =>
  Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, chapter: 1 + (i % 3), draftNote: draft(i), finalNote: final(i) }));

test("home: words that come from a note template → template", () => {
  const rows = repeated((i) => `انظر الملاحظة السابقة هنا ${i}`, (i) => `انظر الشرح هنا ${i}`);
  const ctx = { ...emptyCtx(), templates: ["قد تحتاج أن انظر الملاحظة السابقة في هذا الموضع."] };
  const r = buildInbox(rows, ctx);
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].home, "template");
  assert.equal(r.suggestions[0].rule, null);
  // Without the template it is a term-sized change.
  assert.equal(buildInbox(rows, emptyCtx()).suggestions[0].home, "term");
});

test("home: a bare word deleted is wording → Common issues; the copied line then hides the card", () => {
  const rows = repeated((i) => `مهم جدا ${i}`, (i) => `مهم ${i}`);
  const r = buildInbox(rows, emptyCtx());
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].home, "common_issues");
  assert.equal(r.suggestions[0].rule, null);
  // The line the page copies for this card (AdminSuggestionInboxScreen copyText).
  const covered = buildInbox(rows, { ...emptyCtx(), commonIssues: "## مشكلات\n- «جدا» ← ∅\n" });
  assert.equal(covered.suggestions.length, 0);
  assert.equal(covered.excluded.commonIssues, 1);
});

test("home: a punctuation-only Common issues card is hidden by its copied line", () => {
  // Editors swap a semicolon for a comma in only 10 of 30 drafts that had
  // one: under half, so not a rule.
  const rows = [
    ...repeated((i) => `قال؛ ثم ذهب ${i}`, (i) => `قال، ثم ذهب ${i}`),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, chapter: 5, draftNote: `قال؛ ثم ${i}`, finalNote: `قال؛ ثم ${i}` })),
  ];
  const r = buildInbox(rows, emptyCtx());
  assert.equal(r.suggestions.length, 1);
  assert.equal(r.suggestions[0].opportunities, 30);
  assert.equal(r.suggestions[0].home, "common_issues");
  const covered = buildInbox(rows, { ...emptyCtx(), commonIssues: "- «؛» ← «،»" });
  assert.equal(covered.suggestions.length, 0);
});

test("bound: a 3,000-row book is worked out well inside a Worker request", () => {
  const rows = Array.from({ length: 3000 }, (_, i) => {
    const words = Array.from({ length: 40 }, (_, k) => `كلمة${(i * 7 + k) % 97}`).join(" ");
    return { id: `b${i}`, chapter: 1 + (i % 24), draftNote: `${words} ترجمة بديلة: [نص ${i}]`, finalNote: `${words} تعديل ترجمة بديلة: [نص ${i}].` };
  });
  const t0 = performance.now();
  const r = buildInbox(rows, emptyCtx());
  const ms = performance.now() - t0;
  console.log(`buildInbox: 3,000 rows in ${ms.toFixed(0)} ms`);
  assert.equal(r.scanned.compared, 3000);
  assert.ok(ms < 10_000, `${ms} ms`);
});

// ── 4. Budgets fail closed ──────────────────────────────────────────────────

const mufidRule = (enabled) => ({
  id: "m",
  kind: "whole_word",
  find: "مفيدا",
  replace: "مفيدًا",
  scope: "note",
  examples: [],
  counterExamples: [],
  enabled,
  sortOrder: 0,
});

test("budget: with the check budget spent, a card is not hidden as covered and is not offered as a rule", () => {
  const rows = repeated((i) => `قد يكون مفيدا هنا ${i}`, (i) => `قد يكون مفيدًا هنا ${i}`);
  const ctx = { ...emptyCtx(), rules: [mufidRule(false)] };
  // Normal budget: the existing (switched-off) rule covers it.
  const normal = buildInbox(rows, ctx);
  assert.equal(normal.suggestions.length, 0);
  assert.equal(normal.excluded.rule, 1);
  // No budget left: nothing can be checked, so the card stays and is no rule.
  const starved = buildInbox(rows, ctx, undefined, undefined, { cells: 0 });
  assert.equal(starved.excluded.rule, 0);
  assert.equal(starved.suggestions.length, 1);
  const card = starved.suggestions[0];
  assert.notEqual(card.home, "house_style");
  assert.equal(card.rule, null);
  assert.deepEqual(card.precision, { fires: 10, correct: 0, minPrecision: 0.9 });
  assert.equal(card.ruleBlocked, "precision");
  // With a normal budget and no covering rule, it is a rule card.
  assert.equal(buildInbox(rows, emptyCtx()).suggestions[0].home, "house_style");
});

test("approve's example check: unknown when the budget runs out, mismatch when the rule differs", () => {
  const fn = compileRule(mufidRule(true));
  const key = changeKey("change", "مفيدا", "مفيدًا");
  const notes = [{ draft: "قد يكون مفيدا هنا", final: "قد يكون مفيدًا هنا" }];
  assert.equal(checkExamples(fn, key, notes, { cells: Infinity }), "ok");
  assert.equal(checkExamples(fn, key, notes, { cells: 0 }), "unknown");
  assert.equal(checkExamples(fn, key, [{ draft: "قد يكون مفيدا هنا", final: "قد يكون مفيد هنا" }], { cells: Infinity }), "mismatch");
  assert.equal(checkExamples(fn, key, [], { cells: Infinity }), "mismatch");
});

test("realExamples: no pair when the rule changes nothing on the example line, so approve refuses", () => {
  const fn = compileRule(mufidRule(true));
  const draft = "سطر أول مفيدا\\nسطر ثان";
  const s = draft.indexOf("مفيدا");
  assert.deepEqual(realExamples(fn, [{ draft, change: { draftStart: s, draftEnd: s + 5 } }]), [
    { before: "سطر أول مفيدا", after: "سطر أول مفيدًا" },
  ]);
  // A change span on a line the rule does not touch yields nothing.
  const t = draft.indexOf("ثان");
  assert.deepEqual(realExamples(fn, [{ draft, change: { draftStart: t, draftEnd: t + 3 } }]), []);
});
