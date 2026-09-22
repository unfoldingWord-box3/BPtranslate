// Testament classification by USFM book code. Dependency-free on purpose so
// pure helpers (tnRedo.ts) and their node unit tests can import it without
// dragging in i18n.

// 39 OT book codes. Anything else (including front/back/uncoded) is
// treated as NT.
const OT_BOOKS = new Set([
  "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA",
  "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO",
  "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO",
  "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
]);

export function isHebrewBook(bookCode: string | null | undefined): boolean {
  if (!bookCode) return true; // default to OT if unknown — the dev default is ZEC anyway
  return OT_BOOKS.has(bookCode.toUpperCase());
}
