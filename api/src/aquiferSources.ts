// Aquifer source coordinates: how a project's language maps to an Aquifer
// language edition, and how to build the raw GitHub URL for a book's notes.
//
// Aquifer is NOT a DCS repo — it's a GitHub repo of per-book JSON published in
// many languages. This module is the language/URL/number map; the join + apply
// live in aquiferConvert.ts and aquiferImport.ts.

// Project languageCode (BCP-ish, from ProjectConfig) -> Aquifer dir (ISO 639-3).
// Aquifer dirs that currently exist: arb, apd, fra, guj, hin, ind, por, spa, zht.
export const AQUIFER_LANG: Record<string, string> = {
  ar: "arb",
  hi: "hin",
  fr: "fra",
  gu: "guj",
  id: "ind",
  pt: "por",
  es: "spa",
  "es-419": "spa",
  zh: "zht",
};

// Aquifer files use the CANONICAL Protestant book number (40=MAT … 66=REV),
// which differs from unfoldingWord's USFM filename numbering (41=MAT … 67=REV).
export const AQUIFER_BOOK_NUM: Record<string, string> = {
  GEN: "01", EXO: "02", LEV: "03", NUM: "04", DEU: "05", JOS: "06", JDG: "07",
  RUT: "08", "1SA": "09", "2SA": "10", "1KI": "11", "2KI": "12", "1CH": "13",
  "2CH": "14", EZR: "15", NEH: "16", EST: "17", JOB: "18", PSA: "19", PRO: "20",
  ECC: "21", SNG: "22", ISA: "23", JER: "24", LAM: "25", EZK: "26", DAN: "27",
  HOS: "28", JOL: "29", AMO: "30", OBA: "31", JON: "32", MIC: "33", NAM: "34",
  HAB: "35", ZEP: "36", HAG: "37", ZEC: "38", MAL: "39", MAT: "40", MRK: "41",
  LUK: "42", JHN: "43", ACT: "44", ROM: "45", "1CO": "46", "2CO": "47",
  GAL: "48", EPH: "49", PHP: "50", COL: "51", "1TH": "52", "2TH": "53",
  "1TI": "54", "2TI": "55", TIT: "56", PHM: "57", HEB: "58", JAS: "59",
  "1PE": "60", "2PE": "61", "1JN": "62", "2JN": "63", "3JN": "64", JUD: "65",
  REV: "66",
};

export const AQUIFER_REPO = "BibleAquifer/UWTranslationNotes";

// Aquifer publishes a git tag per release. Both the per-book JSON and the
// language's metadata.json (the translated-note -> English-note links) must come
// from the SAME ref, or a content id in one can be missing from the other; and a
// pinned tag makes an import repeatable. Bump deliberately, after checking the
// new release joins cleanly. (v2026-10-14 is the release the link-first join was
// measured against.)
export const AQUIFER_REF = "v2026-10-14";

export function aquiferLangFor(languageCode: string): string | null {
  return AQUIFER_LANG[languageCode] ?? null;
}

// Allowlist of the Aquifer directory codes we know how to build a URL for. Used
// to validate a STORED aqLang (book_source_overrides.repo for an Aquifer range)
// on read — the aqLang is interpolated into aquiferJsonUrl's path, so an
// arbitrary stored value could otherwise be a path-traversal vector. Membership
// here is the security guard, analogous to normalizeSourceRef for DCS idents.
const AQUIFER_LANG_SET: ReadonlySet<string> = new Set(Object.values(AQUIFER_LANG));

export function isAquiferLang(v: string): boolean {
  return AQUIFER_LANG_SET.has(v);
}

// Raw GitHub URL for a book's Aquifer notes JSON. Returns null for a bad code.
export function aquiferJsonUrl(aqLang: string, book: string): string | null {
  const num = AQUIFER_BOOK_NUM[book];
  if (!num) return null;
  return `https://raw.githubusercontent.com/${AQUIFER_REPO}/${AQUIFER_REF}/${aqLang}/json/${num}.content.json`;
}

// Raw GitHub URL for a language's metadata.json (~36 MB: far too big to parse
// whole in a Worker — read it with fetchEnglishLinks, which streams it).
export function aquiferMetadataUrl(aqLang: string): string | null {
  if (!isAquiferLang(aqLang)) return null;
  return `https://raw.githubusercontent.com/${AQUIFER_REPO}/${AQUIFER_REF}/${aqLang}/metadata.json`;
}
