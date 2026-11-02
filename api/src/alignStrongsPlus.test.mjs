// Issue #529: unfoldingWord Greek (UGNT) carries Strong's-Plus numbers —
// classic × 10, zero-padded to 5 digits (G01910 = ἀκούω = classic G191,
// G00800 = ἀδελφός = classic G80). lexicon_entries is keyed by classic
// Strong's, so the aligner's lexicon fallback must divide by 10. It used to
// zero-strip first (G01910 -> G1910) and then see only 4 digits, so it looked
// up classic G1910 — a different word — or nothing at all.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/alignStrongsPlus.test.mjs

import { align, lexiconLookupKeys } from "./align.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("[align] lexiconLookupKeys");
for (const [raw, want] of [
  ["G01910", ["G191"]], // ἀκούω, zero-padded Strong's-Plus
  ["G00800", ["G80"]], // ἀδελφός
  ["G00010", ["G1"]], // α
  ["G42450", ["G4245"]], // πρεσβύτερος, unpadded Strong's-Plus
  ["G4245", ["G4245"]], // classic Greek stays as-is
  ["G0846", ["G846"]], // 4-digit padded classic: zero-strip only
  // Hebrew unchanged: exact (uppercased, as strongLookupKeys always has) + the
  // sense-stripped base, which is the form lexicon_entries actually holds.
  ["H2148a", ["H2148A", "H2148"]],
  ["b:H0776", ["H776"]], // Hebrew prefix + zero-strip unchanged
  ["", []],
  ["x", []],
]) {
  const got = lexiconLookupKeys(raw);
  assert(same(got, want), `${JSON.stringify(raw)} -> ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
}

// Route-level: a stub D1 with no alignment memory and two lexicon rows —
// classic G191 (hear) and classic G1910 (a different word). A request for the
// UGNT token G01910 must fall back to G191's gloss.
console.log("[align] /suggest lexicon fallback for Strong's-Plus");
{
  const lexicon = {
    G191: { gloss: "hear", definition: null },
    G1910: { gloss: "embark", definition: null },
    G80: { gloss: "brother", definition: null },
  };
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              if (!/FROM lexicon_entries/.test(sql)) return { results: [] };
              return {
                results: args
                  .filter((k) => lexicon[k])
                  .map((k) => ({ strong: k, ...lexicon[k] })),
              };
            },
          };
        },
      };
    },
  };
  const res = await align.request(`/suggest?bible=ult&keys=${encodeURIComponent("G01910~V;G00800~N")}`, {}, { DB: db });
  assert(res.status === 200, "200");
  const body = await res.json();
  const top = (k) => body.suggestions[k]?.words?.[0]?.surface;
  assert(top("G01910~V") === "hear", `G01910 -> ${top("G01910~V")} (want hear, not embark)`);
  assert(top("G00800~N") === "brother", `G00800 -> ${top("G00800~N")} (want brother)`);
}
