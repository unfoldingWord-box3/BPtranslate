// Pure planning core of the Aquifer draft merge (aquiferImport.ts), split out so
// it can be unit-tested without D1 (issue #584).
//
// The merge has to decide, per incoming Aquifer note, whether an existing tn row
// already covers it (skip: never overwrite or duplicate approved/edited content)
// or is a replaceable draft (delete it, insert the fresh draft).
//
// Identifying "the same note" by (reference, NFC quote, occurrence) alone is not
// enough: en_tn can hold TWO distinct rows with identical ref/quote/occurrence
// (PHM 1:1 carries figs-metaphor and figs-exclusive on the same word). Sharing a
// key made Map.set overwrite one of the two replaceable ids (the other piled up
// as a duplicate draft on every re-import) and let one validated row suppress
// the draft for BOTH notes. So:
//  - A note that carries an en_tn id (`enId`) is matched to the live row with
//    that SAME id first. Drafts inherit the en_tn id on insert, so a re-import
//    finds its own previous draft by id. Only that row's state decides: a
//    validated/edited row protects just itself; a draft is replaced.
//  - Rows claimed by an id-match are removed from the key pool, so a key-matched
//    note cannot steal a row another note owns by id.
//  - Notes with no live row under their id (minted/unmatched notes, or an enId
//    whose row is gone) keep the old (ref, quote, occurrence) key. Replaceable
//    rows sharing a key are a queue, one consumed per note, never overwritten.
//    A protected row covers its key only when no note owns it by id: an approved
//    row that no note matches by id still suppresses a draft of the same
//    ref/quote/occurrence (no duplicate beside approved content), but a validated
//    twin does not suppress its sibling's draft.
//  - Soft-deleted rows are not passed in (they cover nothing); their ids stay in
//    the caller's used-id set, so the inserted draft mints a fresh id instead.

import { nfc } from "./aquiferConvert.ts";

export type ExistingTnRow = {
  id: string;
  ref_raw: string;
  quote: string | null;
  occurrence: number | null;
  translation_state: string | null;
};

export type MergeNote = {
  ref: string;
  enId: string | null;
  quote: string | null;
  occurrence: number | null;
};

export type MergeDecision =
  | { action: "skip" } // an approved/edited row already covers this note
  | { action: "insert"; replaceId: string | null }; // draft; delete replaceId first if set

export type MergePlan = {
  /** Existing target-language rows to bulk-approve (state NULL -> validated). */
  approveIds: string[];
  /** One decision per input note, same order. */
  decisions: MergeDecision[];
};

// Dedup/key fallback includes occurrence: a verse can carry the SAME quote at
// occurrence 1 and 2 (distinct notes).
export const mergeKey = (ref: string, quote: string | null, occ: number | null): string =>
  `${ref}\t${nfc(quote)}\t${occ ?? ""}`;

/**
 * @param existing   live (non-deleted) tn rows for the book
 * @param notes      the (already chapter-scoped) Aquifer notes to merge
 * @param isTranslated  true when a state-less row's note already looks like
 *                   target-language text (caller owns the script heuristic)
 * @param inScope    true when a row's reference is inside the requested chapter
 *                   scope; only in-scope rows are bulk-approved (issue #310)
 */
export function planAquiferMerge<R extends ExistingTnRow>(
  existing: R[],
  notes: MergeNote[],
  isTranslated: (row: R) => boolean,
  inScope: (ref: string) => boolean,
): MergePlan {
  const approveIds: string[] = [];
  const protectedIds = new Set<string>();
  const protectedRows: Array<{ id: string; key: string }> = [];
  const replaceableById = new Set<string>();
  const replaceableRows: Array<{ id: string; key: string }> = [];

  for (const row of existing) {
    const st = row.translation_state;
    const k = mergeKey(row.ref_raw, row.quote, row.occurrence);
    if (st === "validated" || st === "edited") {
      protectedIds.add(row.id);
      protectedRows.push({ id: row.id, key: k });
    } else if (st === "ai_draft") {
      replaceableById.add(row.id);
      replaceableRows.push({ id: row.id, key: k });
    } else if (isTranslated(row)) {
      // A bulk approve flips only in-scope rows, but every such row is protected.
      if (inScope(row.ref_raw)) approveIds.push(row.id);
      protectedIds.add(row.id);
      protectedRows.push({ id: row.id, key: k });
    } else {
      replaceableById.add(row.id);
      replaceableRows.push({ id: row.id, key: k });
    }
  }

  // Ids some incoming note owns by en_tn id. Their replaceable rows are taken by
  // id, never by key. (Only the first note with a given enId can take the row.)
  const claimed = new Set<string>();
  for (const n of notes) {
    if (n.enId && (protectedIds.has(n.enId) || replaceableById.has(n.enId))) claimed.add(n.enId);
  }

  // A protected row covers a key only if no note owns it by id: otherwise a
  // validated twin would suppress its sibling's draft (the #584 bug).
  const protectedKeys = new Set<string>();
  for (const r of protectedRows) if (!claimed.has(r.id)) protectedKeys.add(r.key);

  const byKey = new Map<string, string[]>();
  for (const r of replaceableRows) {
    if (claimed.has(r.id)) continue;
    const q = byKey.get(r.key);
    if (q) q.push(r.id);
    else byKey.set(r.key, [r.id]);
  }

  const takenById = new Set<string>();
  const decisions: MergeDecision[] = [];
  for (const n of notes) {
    if (n.enId && protectedIds.has(n.enId)) {
      decisions.push({ action: "skip" });
      continue;
    }
    const k = mergeKey(n.ref, n.quote, n.occurrence);
    if (protectedKeys.has(k)) {
      decisions.push({ action: "skip" });
      continue;
    }
    if (n.enId && replaceableById.has(n.enId) && !takenById.has(n.enId)) {
      takenById.add(n.enId);
      decisions.push({ action: "insert", replaceId: n.enId });
      continue;
    }
    decisions.push({ action: "insert", replaceId: byKey.get(k)?.shift() ?? null });
  }

  return { approveIds, decisions };
}
