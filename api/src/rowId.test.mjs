// Unit tests for rowId.ts — the row-id grammar + the deterministic coerceRowId
// guard (Guard 1 of the DCS→D1 reimport hardening). Run from api/:
//   node --experimental-strip-types --no-warnings src/rowId.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { ROW_ID_RE, isValidRowId, coerceRowId, newRowId } from "./rowId.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// --- isValidRowId / ROW_ID_RE ---
for (const good of ["abcd", "a1b2", "z9z9", "abc1", "k84q"]) {
  assert(isValidRowId(good), `valid id accepted: ${good}`);
}
for (const bad of ["1abc", "0xy9", "abc", "abcde", "ABCD", "", "a-bc", "12", "99999", "a bc"]) {
  assert(!isValidRowId(bad), `invalid id rejected: ${JSON.stringify(bad)}`);
}

// --- coerceRowId: no-op for valid ids ---
for (const good of ["abcd", "a1b2", "z9z9", "k84q"]) {
  assert(coerceRowId(good) === good, `coerce is a no-op for valid id: ${good}`);
}

// --- coerceRowId: malformed → valid, deterministic, idempotent ---
const BAD = ["1abc", "0xy9", "12", "99999", "ABCD", "a-bc", "2222", "x", "zzzzz"];
for (const bad of BAD) {
  const c = coerceRowId(bad);
  assert(isValidRowId(c), `coerce(${JSON.stringify(bad)}) = ${c} is a valid id`);
  assert(coerceRowId(bad) === c, `coerce(${JSON.stringify(bad)}) is deterministic`);
  // Idempotent: the output is already valid, so a second pass leaves it alone —
  // this is what makes the reimport stable across nights (a re-run of the same
  // dirty master maps the bad id to the same good id, so no second copy).
  assert(coerceRowId(c) === c, `coerce is idempotent for ${JSON.stringify(bad)} → ${c}`);
}

// Anchor one mapping so an accidental change to the hash is caught.
assert(coerceRowId("1abc") === "w6w6", `coerce("1abc") is stable === w6w6 (got ${coerceRowId("1abc")})`);

// Distinct bad ids generally map to distinct good ids (collision is possible but
// must be rare — assert no collisions across this sample).
{
  const seen = new Map();
  for (const bad of BAD) {
    const c = coerceRowId(bad);
    assert(!seen.has(c), `no coerce collision: ${JSON.stringify(bad)} and ${seen.get(c)} both → ${c}`);
    seen.set(c, bad);
  }
}

// --- newRowId always satisfies the grammar (sampled) ---
{
  let allValid = true;
  let bad = "";
  for (let i = 0; i < 2000; i++) {
    const id = newRowId();
    if (!isValidRowId(id)) { allValid = false; bad = id; break; }
  }
  assert(allValid, `newRowId() matches the grammar across 2000 samples${bad ? ` (offender: ${bad})` : ""}`);
}

console.log("rowId.test.mjs: all assertions passed");
