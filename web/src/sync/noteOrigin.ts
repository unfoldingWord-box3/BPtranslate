// When NoteCard moves the copy its unsaved text was typed against (#754,
// NoteCard's originRef). That copy is the If-Match and conflict baseline of a
// Save; it may move only with the card's own saves, never with another write
// that lands on the row (a reorder, a verse move, a quote build, find/replace,
// a batch save), or the next Save goes out at a version that already carries
// another person's note and replaces it with a 200 (review A1).
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (noteOrigin.test.mjs).

/** What a NoteCard Save sent: the patch (TSV form) and the version it went out at. */
export interface NoteSaveSent {
  patch: Record<string, unknown>;
  from: number;
}

interface ResultOp {
  action?: string;
  target: { kind: string; rowKind?: string; id?: string; book?: string };
  draftRef?: unknown;
}

// An outbox result for a NoteCard's own save of this row: a tN patch that
// carries a draftRef. Only NoteCard's saves (Save, and picking a version in the
// history) pass one for tN; Shell adds it for tQ / tW-link rows only, and the
// other tN writes listed above pass none.
export function isNoteCardSaveOf(op: ResultOp, row: { id: string; book: string }): boolean {
  return (
    op.action === "patch" &&
    op.target.kind === "row" &&
    op.target.rowKind === "tn" &&
    op.target.id === row.id &&
    op.target.book === row.book &&
    op.draftRef !== undefined
  );
}

// NoteCard keeps display text (real newlines) and D1 may hold a literal
// backslash-n; an absent value and null are the same (as rowConflict.ts).
function key(v: unknown): unknown {
  if (v === undefined) return null;
  return typeof v === "string" ? v.replace(/\\n/g, "\n") : v;
}

// The row moved to a version that is the card's last save landing, seen
// without that save's outbox result: another tab held the drain lock and sent
// it, or the live update reached the card before the result did (review A2).
// It is that save when the row is exactly one version past the one the save
// went out at and every field it sent shows the sent value. Another person's
// save at that version with other text fails the field check; one with the
// same text leaves nothing of theirs to overwrite.
export function isOwnSaveLanded(
  sent: NoteSaveSent | null,
  row: { version: number } & Record<string, unknown>,
): boolean {
  if (!sent || row.version !== sent.from + 1) return false;
  const fields = Object.keys(sent.patch);
  if (fields.length === 0) return false;
  return fields.every((f) => key(row[f]) === key(sent.patch[f]));
}
