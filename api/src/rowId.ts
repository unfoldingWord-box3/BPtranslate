// Canonical bible-editor row-id helpers — generation, validation, repair.
//
// Pure + dependency-free (no relative imports, no I/O) so they can be unit-tested
// in isolation (rowId.test.mjs) and imported anywhere without pulling the Hono
// router. The TN TSV id grammar is ^[a-z][a-z0-9]{3}$ — 4 chars, the first a
// LETTER. A digit-first id can't legally exist in a TN TSV (it breaks
// round-tripping) and bp-assistant rejects it when echoing hint rowIds, so the
// first position draws from letters only; the remaining three are alphanumeric.

// `l` and `o` are omitted to avoid l/1 and o/0 confusion (matches the legacy
// minting alphabet). 23 letters, then digits 2-9 for the alphanumeric positions.
const ID_LETTERS = "abcdefghijkmnpqrstuvwxyz";
const ID_CHARS = ID_LETTERS + "23456789";

export const ROW_ID_RE = /^[a-z][a-z0-9]{3}$/;
export const isValidRowId = (s: string): boolean => ROW_ID_RE.test(s);

// Mint a brand-new random id. Used by the create path (rows.ts) and the AI
// auto-apply path (pipelineImport.ts) when bp-assistant didn't supply a usable id.
export function newRowId(): string {
  let out = ID_LETTERS[Math.floor(Math.random() * ID_LETTERS.length)];
  for (let i = 0; i < 3; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return out;
}

// Deterministically rewrite a malformed row id into a valid one. A NO-OP for any
// well-formed id, so it's transparent for the overwhelming majority of rows — it
// only ever changes an id that violates the grammar (e.g. the digit-first ids an
// old newRowId bug minted before PR #225). Used by the DCS→D1 reimport as
// defense-in-depth so a still-dirty master can't re-introduce an illegal id.
//
// Unlike newRowId(), this mapping MUST be pure + stable (no randomness): the
// reimport's apply, diff-gate, and prune paths each coerce independently and have
// to land on the same id, and a given bad id must map to the same good id every
// night — a random mint would make a retried/re-run import insert a *second*
// copy. Derived from an FNV-1a hash of the original id over the id alphabet. A
// collision with an existing id just means the insert's ON CONFLICT DO NOTHING
// fires (the row isn't inserted this cycle) — never corruption or a duplicate.
//
// NOTE: this has a low-bit-collapse defect (the FNV recurrence's low 5 bits
// form a closed cycle) — it reaches only 96 distinct ids. Not fixed here on purpose:
// coerceRowId's mapping must stay stable NIGHT TO NIGHT, so changing it would
// remap every already-coerced id and make the reimport insert second copies.
// Fixing it needs its own change with a migration story.
export function coerceRowId(id: string): string {
  if (isValidRowId(id)) return id;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  let out = ID_LETTERS[h % ID_LETTERS.length];
  for (let i = 0; i < 3; i++) {
    h = Math.imul(h, 16777619) >>> 0;
    out += ID_CHARS[h % ID_CHARS.length];
  }
  return out;
}
