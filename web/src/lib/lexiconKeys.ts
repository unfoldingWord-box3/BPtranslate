// Strong's keys for the lexicon (`lexicon_entries`, GET /api/lexicon).
// No React, so the node test runner can pin it (lexiconKeys.test.mjs).

// Reduce 'b:H2320', 'H2148a', etc. to the keys the API can resolve. Returns
// the exact form and an alpha-stripped fallback ('H2148a' → ['H2148a','H2148']).
export function normalizeStrong(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

/**
 * The keys to try, in order, for one word's raw Strong's (#527). UGNT carries
 * unfoldingWord Strong's-Plus — classic × 10, five digits (πρεσβύτερος =
 * G42450) — but lexicon_entries is keyed by classic Strong's (G4245), so a
 * Greek word also offers the /10 form. Same rule as api/src/align.ts
 * `lexiconKeysFor`. Hebrew keys are unchanged.
 */
export function lexiconKeys(raw: string): string[] {
  const keys = normalizeStrong(raw);
  const plus = keys[keys.length - 1]?.match(/^G(\d{5,})$/);
  if (plus) {
    const classic = Math.floor(parseInt(plus[1], 10) / 10);
    if (classic > 0) keys.push(`G${classic}`);
  }
  return keys;
}
