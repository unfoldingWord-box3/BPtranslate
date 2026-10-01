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
 * unfoldingWord Strong's-Plus — classic × 10, written with five digits
 * INCLUDING leading zeros (πρεσβύτερος = G42450, ἀκούω = G01910, ἀδελφός =
 * G00800) — but lexicon_entries is keyed by classic Strong's (G4245, G191,
 * G80). So Strong's-Plus is detected on the RAW digit count, before any zero
 * is stripped, and maps to the classic key only: stripping G01910's zero
 * gives G1910, a real classic entry for a DIFFERENT word, so that form is
 * never offered. Classic Greek (≤4 digits) and every Hebrew key go through
 * normalizeStrong unchanged.
 */
export function lexiconKeys(raw: string): string[] {
  if (!raw) return [];
  const plus = raw.match(/G(\d{5,})/i);
  if (plus) {
    const classic = Math.floor(parseInt(plus[1], 10) / 10);
    return classic > 0 ? [`G${classic}`] : [];
  }
  return normalizeStrong(raw);
}
