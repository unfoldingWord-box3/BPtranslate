// House-style rules engine (issue #815). Run from api/:
//   node --experimental-strip-types --no-warnings --test src/houseStyle.test.mjs
//
// The seed-rule tests read the rows migration 0082 actually inserts (real
// migration chain in node:sqlite), so they prove the shipped seeds, not a copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { applyHouseStyle, ruleFromRow, compileRule, houseStyleForProposal, findLeftoverEnglish } from "./houseStyle.ts";

function migratedRows() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return sqlite.prepare(`SELECT * FROM house_style_rules ORDER BY sort_order`).all();
}

const rows = migratedRows();
const seeds = rows.map((r) => ruleFromRow(r));
const on = (rule) => ({ ...rule, enabled: true });

const MUK_NFC = "(مُكيَّف)";
const MUK_SHADDA_FIRST = "(مُكيَّف)";
const ALT = "ترجمة بديلة:";

test("migration 0082 ships exactly three seed rules, all switched off", () => {
  assert.deepEqual(
    rows.map((r) => r.id),
    ["ar-drop-mukayyaf-tag", "ar-mufidan-tanween", "ar-final-bracket-period"],
  );
  for (const r of rows) assert.equal(r.enabled, 0, `${r.id} ships disabled`);
  for (const s of seeds) {
    assert.ok(s, "every seed row parses");
    assert.ok(compileRule(s), `${s.id} compiles (known kind, idempotent)`);
    assert.ok(s.examples.length >= 2, `${s.id} has examples`);
    assert.ok(s.counterExamples.length >= 2, `${s.id} has counter-examples`);
  }
});

for (const seed of seeds) {
  test(`seed ${seed.id}: fixes its examples, idempotently`, () => {
    for (const ex of seed.examples) {
      const once = applyHouseStyle(ex.before, [on(seed)]);
      assert.equal(once.text, ex.after, `example: ${ex.before}`);
      assert.deepEqual(once.applied, [seed.id]);
      const twice = applyHouseStyle(once.text, [on(seed)]);
      assert.equal(twice.text, once.text, "second pass changes nothing");
      assert.deepEqual(twice.applied, []);
    }
  });
  test(`seed ${seed.id}: leaves its counter-examples alone`, () => {
    for (const ce of seed.counterExamples) {
      const r = applyHouseStyle(ce, [on(seed)]);
      assert.equal(r.text, ce, `counter-example: ${ce}`);
      assert.deepEqual(r.applied, []);
    }
  });
  test(`seed ${seed.id}: does nothing while disabled`, () => {
    for (const ex of seed.examples) assert.equal(applyHouseStyle(ex.before, [seed]).text, ex.before);
  });
}

test("all seeds together: every example and counter-example stays idempotent", () => {
  const all = seeds.map(on);
  for (const s of seeds) {
    for (const text of [...s.examples.map((e) => e.before), ...s.counterExamples]) {
      const once = applyHouseStyle(text, all).text;
      assert.equal(applyHouseStyle(once, all).text, once, `idempotent: ${text}`);
    }
  }
});

test("note-scope rules run before end-of-note: deleting a trailing tag exposes the final ]", () => {
  const all = seeds.map(on);
  const r = applyHouseStyle(`${ALT} [وكان معهم] ${MUK_NFC}`, all);
  assert.equal(r.text, `${ALT} [وكان معهم].`);
  assert.deepEqual(r.applied, ["ar-drop-mukayyaf-tag", "ar-final-bracket-period"]);
});

test("mark order inside the find text is ignored (shadda before or after the vowel)", () => {
  const tag = on(seeds[0]);
  assert.equal(applyHouseStyle(`كلمة ${MUK_SHADDA_FIRST} هنا`, [tag]).text, "كلمة هنا");
  assert.equal(applyHouseStyle(`كلمة ${MUK_NFC} هنا`, [tag]).text, "كلمة هنا");
});

test("bold spans are never touched; an unpaired ** protects the rest", () => {
  const all = seeds.map(on);
  const bold = `**مفيدا ${MUK_NFC}** ثم مفيدا`;
  assert.equal(applyHouseStyle(bold, all).text, `**مفيدا ${MUK_NFC}** ثم مفيدًا`);
  const unpaired = `مفيدا **مفيدا`;
  assert.equal(applyHouseStyle(unpaired, all).text, `مفيدًا **مفيدا`);
  // A tag right after a bold span: the space before it goes, the quote stays.
  assert.equal(applyHouseStyle(`**النص** ${MUK_NFC} هنا`, all).text, `**النص** هنا`);
  // The final ] inside an unpaired bold run gets no period.
  assert.equal(applyHouseStyle(`نص **[وكان معهم]`, all).text, `نص **[وكان معهم]`);
});

test("final-bracket period: stated edge cases", () => {
  const period = on(seeds[2]);
  const ap = (t) => applyHouseStyle(t, [period]).text;
  assert.equal(ap(`${ALT} [نص]  `), `${ALT} [نص].  `, "trailing whitespace ignored, kept after the period");
  assert.equal(ap(`${ALT} [نص …  ]`), `${ALT} [نص …  ]`, "… before trailing space inside the bracket");
  assert.equal(ap("no bracket here ]"), "no bracket here ]", "a ] without an opening [ is left");
  assert.equal(ap("[]"), "[]", "empty bracket is left");
  // Not exempt, as the issue states only … and ؟ (reported as an open question):
  assert.equal(ap("[what?]"), "[what?].");
  assert.equal(ap("[and so...]"), "[and so...].");
});

test("whole_word: a letter, mark or digit on either side blocks the match", () => {
  const w = on(seeds[1]);
  const ap = (t) => applyHouseStyle(t, [w]).text;
  assert.equal(ap("ومفيدا"), "ومفيدا", "prefixed clitic is not a whole word");
  assert.equal(ap("مفيدا2"), "مفيدا2");
  assert.equal(ap("(مفيدا)"), "(مفيدًا)", "punctuation is a boundary");
  assert.equal(ap("مفيدا\nمفيدا"), "مفيدًا\nمفيدًا");
});

test("literal matching escapes regex syntax and refuses non-idempotent rules", () => {
  const base = { kind: "literal", scope: "note", examples: [], counterExamples: [], enabled: true, sortOrder: 0 };
  const dot = { ...base, id: "dot", find: "a.b", replace: "X" };
  assert.equal(applyHouseStyle("axb a.b", [dot]).text, "axb X");
  const grow = { ...base, id: "grow", find: "a", replace: "aa" };
  assert.equal(compileRule(grow), null, "replace contains find → refused");
  assert.equal(applyHouseStyle("a", [grow]).text, "a");
  const unknown = ruleFromRow({ id: "x", kind: "regex", find: ".*", replace: "", scope: "note", examples_json: "[]", counter_examples_json: "[]", enabled: 1, sort_order: 0 });
  assert.equal(unknown, null, "unknown kind is not loaded");
  const endOnly = { ...base, id: "end", find: "foo", replace: "bar", scope: "end-of-note" };
  assert.equal(applyHouseStyle("foo foo", [endOnly]).text, "foo bar", "end-of-note scope only rewrites a trailing match");
});

test("leftover English is detected case-insensitively", () => {
  assert.deepEqual(findLeftoverEnglish(["If it would be helpful in your language, قل"]), [
    "If it would be helpful in your language",
  ]);
  assert.deepEqual(findLeftoverEnglish(["if IT would be helpful in your language"]).length, 1);
  assert.deepEqual(findLeftoverEnglish(["ترجمة", null]), []);
});

test("houseStyleForProposal: payload unchanged and draft meta untouched when nothing applies", () => {
  const payload = { id: "ab12", note: "نص عادي", quote: "x" };
  const r = houseStyleForProposal(payload, ["note"], seeds.map(on));
  assert.equal(r.logPayload, payload, "same object: edit_log payload byte-identical");
  assert.equal(r.draftMetaJson, null);
  const withMeta = houseStyleForProposal({ ...payload, draft_meta: { model: "m" } }, ["note"], []);
  assert.equal(withMeta.draftMetaJson, JSON.stringify({ model: "m" }));
});

test("houseStyleForProposal: raw text and applied rule ids only when something changed", () => {
  const payload = { id: "ab12", note: `${ALT} [نص] ${MUK_NFC}`, quote: "[q] (مُكيَّف)", draft_meta: { model: "m" } };
  const r = houseStyleForProposal(payload, ["note"], seeds.map(on));
  assert.equal(r.values.note, `${ALT} [نص].`);
  assert.equal(r.logPayload.note, `${ALT} [نص].`);
  assert.equal(r.logPayload.raw_note, payload.note);
  assert.deepEqual(r.logPayload.applied_rules, ["ar-drop-mukayyaf-tag", "ar-final-bracket-period"]);
  assert.equal(r.logPayload.quote, payload.quote, "quote column is copied through untouched");
  assert.equal(r.draftMetaJson, JSON.stringify({ model: "m" }));
});
