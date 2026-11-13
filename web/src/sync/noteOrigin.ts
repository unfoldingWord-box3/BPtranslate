// When NoteCard moves the copy its unsaved text was typed against (#754,
// NoteCard's originRef). That copy is the If-Match and conflict baseline of a
// Save. It moves only with a write the server took at that copy's version
// (nothing landed in between, so the landed row is that copy plus the write):
// the card's own saves, and any other write of the row this tab sent at that
// version (a quote build, find/replace). A write sent at a newer version (a
// reorder after another person's save) leaves it, or the next Save goes out at
// a version that already carries another person's note and replaces it with a
// 200 (review A1).
//
// Kept free of IndexedDB / api.ts imports so it can be unit-tested from a plain
// Node script (noteOrigin.test.mjs).

/** The fields a NoteCard edits, in the row's (TSV) form. */
export interface NoteFields {
  quote: string | null;
  note: string | null;
  support_reference: string | null;
}

const CARD_FIELDS = ["quote", "note", "support_reference"] as const;

/**
 * What a NoteCard Save sent: the patch (TSV form), the version it went out at,
 * and the copy it went out against (that version's card fields).
 */
export interface NoteSaveSent {
  patch: Record<string, unknown>;
  from: number;
  base: NoteFields;
}

interface ResultOp {
  action?: string;
  target: { kind: string; rowKind?: string; id?: string; book?: string };
  draftRef?: unknown;
  expectedVersion?: number;
}

function isPatchOfRow(op: ResultOp, row: { id: string; book: string }): boolean {
  return (
    op.action === "patch" &&
    op.target.kind === "row" &&
    op.target.rowKind === "tn" &&
    op.target.id === row.id &&
    op.target.book === row.book
  );
}

// An outbox result for a NoteCard's own save of this row: a tN patch that
// carries a draftRef. Only NoteCard's saves (Save, and picking a version in the
// history) pass one for tN; Shell adds it for tQ / tW-link rows only, and the
// other tN writes listed above pass none.
export function isNoteCardSaveOf(op: ResultOp, row: { id: string; book: string }): boolean {
  return isPatchOfRow(op, row) && op.draftRef !== undefined;
}

// An outbox result for a write of this row sent at the version of the card's
// copy (round 4, item 1). A 200 for it means the server was still at that copy,
// so the landed row is the copy plus this write and the card's text sits on
// top of it: a quote build the translator made from the card must not leave
// the copy behind, or the next Save conflicts with the translator's own build.
// The op's expectedVersion is the If-Match it last went out with (a healed or
// resolved op is re-armed at the server's version first), and the landed row
// must be the next version: an edit settled as saved from its 409 is announced
// as a 200 with the server's current row (#886 item 1), which can carry a
// later write by someone else while the op still shows its first version.
export function isWriteFromOrigin(
  op: ResultOp,
  row: { id: string; book: string },
  originVersion: number,
  landedVersion: number | undefined,
): boolean {
  return isPatchOfRow(op, row) && op.expectedVersion === originVersion && landedVersion === originVersion + 1;
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
// went out at and every card field shows what the save left there: the sent
// value, or the copy's value for a field it did not send (round 4, item 3: a
// row showing the sent note but another quote is someone else's write).
// Another person's save at that version with the same three fields leaves
// nothing of theirs in them to overwrite.
export function isOwnSaveLanded(
  sent: NoteSaveSent | null,
  row: { version: number } & Record<string, unknown>,
): boolean {
  if (!sent || row.version !== sent.from + 1) return false;
  if (Object.keys(sent.patch).length === 0) return false;
  return CARD_FIELDS.every((f) => key(row[f]) === key(f in sent.patch ? sent.patch[f] : sent.base[f]));
}
