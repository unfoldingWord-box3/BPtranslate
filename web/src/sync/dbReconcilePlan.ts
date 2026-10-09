// Pure decision rule for adopt-on-open reconciliation (#502). Kept free of
// imports so the node strip-types test runner can load it directly
// (dbReconcilePlan.test.mjs); dbReconcile.ts does the IndexedDB plumbing.
//
// For one record found in the sibling database, given the opened database's
// copy under the same key (undefined when absent), decide:
//   "put"  — copy the sibling record into the opened DB, then remove it from
//            the sibling (the opened DB lacks it, or holds an older copy).
//   "drop" — the opened DB already holds an equal-or-newer copy, so only the
//            sibling's redundant copy is removed.
//
// "Newer" is decided by `updatedAt` when both copies carry one (the drafts
// stores), so a stranded draft that is newer than the opened DB's copy wins
// instead of being deleted. Adoption runs right at open, before this session
// has typed anything, so the opened copy is NOT automatically the current one.
// Outbox ops are uuid-keyed: a shared key means the same op already adopted,
// and the opened copy is kept.
export type AdoptDecision = "put" | "drop";

export function decideAdoption(sibling: unknown, existing: unknown): AdoptDecision {
  if (existing === undefined) return "put";
  const s = updatedAtOf(sibling);
  const e = updatedAtOf(existing);
  if (s !== undefined && e !== undefined && s > e) return "put";
  return "drop";
}

function updatedAtOf(record: unknown): number | undefined {
  const v = (record as { updatedAt?: unknown } | null)?.updatedAt;
  return typeof v === "number" ? v : undefined;
}
