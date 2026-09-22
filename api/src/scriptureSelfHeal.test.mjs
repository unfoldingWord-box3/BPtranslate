// Reimport self-heal for the scripture-lane English fallback — issue #441
// (the unlocked-lane path) plus the #440 locked-lane path, driven through the
// REAL selfHealScriptureHoldOuts against the REAL production schema (every file
// in api/migrations, applied in order). The probe is stubbed so the release
// DECISION and the column-clear SQL are exercised without a network.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/scriptureSelfHeal.test.mjs
//
// A failed assert increments `failed`; the file exits non-zero if any failed.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { selfHealScriptureHoldOuts } from "./bookReimport.ts";

let failed = 0;
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL: ${msg}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// ── Minimal D1 shim over node:sqlite (same slice as reimportJourney.test.mjs) ──
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

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(join(dir, f), "utf8"));
  }
  return { sqlite, env: { DB: makeDb(sqlite) } };
}

const BOOK = "LUK";
// A book_imports row whose scripture came from the English translationSource
// (the shape scriptureImportOverrides / sourceProvenance stamp): both columns
// non-null, so heldOutNoteResources() reports ult+ust held.
function seedHeld(sqlite, { ult = "source:unfoldingWord/en_ult", ust = "source:unfoldingWord/en_ust" } = {}) {
  sqlite
    .prepare(`INSERT INTO book_imports (book, ult_source, ust_source) VALUES (?, ?, ?)`)
    .run(BOOK, ult, ust);
}
const cols = (sqlite) =>
  sqlite.prepare(`SELECT ult_source, ust_source FROM book_imports WHERE book = ?`).all(BOOK)[0];

const never = async () => {
  throw new Error("probe must NOT be called for a locked lane");
};

console.log("\n[locked lane → released blind, columns cleared, probe never called (#440 path preserved)]");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: true, sim: true }, never);
  eq(res.locked.sort(), ["ult", "ust"], "both released via locked path");
  eq(res.probed, [], "no probe for locked lanes");
  eq([...held].sort(), [], "scriptureHeld emptied so the stage loop re-pulls the lane text");
  eq(cols(sqlite), { ult_source: null, ust_source: null }, "both provenance columns cleared");
}

console.log("\n[unlocked lane, lane repo now serves the book (probe 200) → released]");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  const probe = async () => ({ status: 200, text: "\\id LUK\n\\c 1\n" });
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: false, sim: false }, probe);
  eq(res.locked, [], "nothing released blind on unlocked lanes");
  eq(res.probed.sort(), ["ult", "ust"], "both released after a 200 probe");
  eq([...held].sort(), [], "scriptureHeld emptied → re-pull the lane's own pristine rows");
  eq(cols(sqlite), { ult_source: null, ust_source: null }, "both columns cleared");
}

console.log("\n[unlocked lane, lane repo still 404s the book → kept (legitimate English fallback)]");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  const probe = async () => ({ status: 404, text: null });
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: false, sim: false }, probe);
  eq(res.probed, [], "nothing released on a 404 probe");
  eq([...held].sort(), ["ult", "ust"], "scriptureHeld unchanged — English stays held out");
  eq(cols(sqlite), { ult_source: "source:unfoldingWord/en_ult", ust_source: "source:unfoldingWord/en_ust" },
    "columns intact — the fallback is preserved");
}

console.log("\n[unlocked lane, transient probe failure (5xx / network) → kept, not cleared on a flake]");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  const probe = async () => ({ status: 500, text: null });
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: false, sim: false }, probe);
  eq(res.probed, [], "nothing released on a transient failure");
  eq([...held].sort(), ["ult", "ust"], "still held after a 5xx probe");
  eq(cols(sqlite).ult_source, "source:unfoldingWord/en_ult", "column not cleared on a transient failure");
}

console.log("\n[mixed lane pair: locked lit released blind, unlocked sim released only after its 200 probe]");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  let probedFor = [];
  const probe = async (r) => {
    probedFor.push(r);
    return { status: 200, text: "\\id LUK\n" };
  };
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: true, sim: false }, probe);
  eq(res.locked, ["ult"], "locked lit → ult released blind");
  eq(res.probed, ["ust"], "unlocked sim → ust released after probe");
  eq(probedFor, ["ust"], "only the unlocked lane's resource was probed");
  eq([...held].sort(), [], "both released, held emptied");
  eq(cols(sqlite), { ult_source: null, ust_source: null }, "both columns cleared in one UPDATE");
}

console.log("\n[partial release: unlocked lane, only ust's lane repo has the book] ");
{
  const { sqlite, env } = freshEnv();
  seedHeld(sqlite);
  const held = new Set(["ult", "ust"]);
  const probe = async (r) => (r === "ust" ? { status: 200, text: "\\id LUK\n" } : { status: 404, text: null });
  const res = await selfHealScriptureHoldOuts(env, BOOK, held, { lit: false, sim: false }, probe);
  eq(res.probed, ["ust"], "only ust released");
  eq([...held].sort(), ["ult"], "ult stays held (its lane repo still 404s)");
  eq(cols(sqlite), { ult_source: "source:unfoldingWord/en_ult", ust_source: null },
    "only ust_source cleared; ult_source preserved");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll scriptureSelfHeal assertions passed.");
