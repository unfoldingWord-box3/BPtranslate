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
//   "keep" — touch neither copy. Used when both copies carry the SAME
//            updatedAt but different content: neither is provably newer, so
//            discarding either could lose a distinct edit.
//
// "Newer" is decided by `updatedAt` when both copies carry one (the drafts
// stores), so a stranded draft that is newer than the opened DB's copy wins
// instead of being deleted. Adoption runs right at open, before this session
// has typed anything, so the opened copy is NOT automatically the current one.
// Outbox ops carry no updatedAt and are uuid-keyed: a shared key means the
// same op was already adopted, and the opened copy is kept.
export type AdoptDecision = "put" | "drop" | "keep";

//
// Outbox ops: same uuid key, compared by `queuedAt`. Every payload change
// (an enqueue coalescing into a pending op) re-stamps queuedAt, so a sibling
// copy with a NEWER queuedAt carries newer user content and replaces ours.
// Equal queuedAt means the same payload generation; any difference is drain
// bookkeeping (attempts, status, threaded version) and ours is kept.
export function decideAdoption(sibling: unknown, existing: unknown): AdoptDecision {
  if (existing === undefined) return "put";
  const s = numberField(sibling, "updatedAt");
  const e = numberField(existing, "updatedAt");
  if (s !== undefined && e !== undefined) {
    if (s > e) return "put";
    if (s === e && JSON.stringify(sibling) !== JSON.stringify(existing)) return "keep";
    return "drop";
  }
  const sq = numberField(sibling, "queuedAt");
  const eq = numberField(existing, "queuedAt");
  if (sq !== undefined && eq !== undefined && sq > eq) return "put";
  return "drop";
}

function numberField(record: unknown, field: string): number | undefined {
  const v = (record as Record<string, unknown> | null)?.[field];
  return typeof v === "number" ? v : undefined;
}

// Minimal async shape of one readwrite transaction on one object store, so the
// adoption algorithm below can run against idb in the app and an in-memory fake
// in dbReconcilePlan.test.mjs.
export interface StoreTx {
  get(key: IDBValidKey): Promise<unknown>;
  put(record: unknown): Promise<unknown>;
  delete(key: IDBValidKey): Promise<unknown>;
  done: Promise<void>;
}
export interface StoreSide {
  readAll(): Promise<unknown[]>;
  tx(): StoreTx; // readwrite
}

export interface AdoptResult {
  // Records copied into the opened DB and still there when this returns.
  adopted: number;
  // Earliest time at which a held record (see holdUntil) may be adopted;
  // undefined when nothing was held.
  heldUntil?: number;
  // The attempt did not finish (an IndexedDB error, a timeout). Whatever it
  // copied is reported in `adopted`; the caller should try again later.
  failed?: boolean;
}

// Move the sibling's records into the opened store. Steps:
//   1. Snapshot the sibling (one read).
//   2. In ONE opened-store transaction, decide per record (decideAdoption) and
//      put. A record for which holdUntil() returns a time is left alone.
//   3. Once that commits, in ONE sibling transaction, delete each processed key
//      only if the sibling still holds exactly the snapshot. A failure here does
//      not change the count: the copies are already committed (at-least-once;
//      the next open drops the sibling's redundant copies).
//   4. A key whose sibling copy changed or vanished between 1 and 3 belongs to a
//      live writer on the sibling (it re-coalesced, sent, or discarded the
//      record). Its version wins: our copy is removed again, if it is still
//      exactly what we put, so an old value can never be sent over a new one.
export async function adoptRecords(opts: {
  sibling: StoreSide;
  opened: StoreSide;
  keyOf: (record: unknown) => IDBValidKey;
  holdUntil?: (record: unknown) => number | undefined;
}): Promise<AdoptResult> {
  const { sibling, opened, keyOf, holdUntil } = opts;
  const records = await sibling.readAll();
  if (records.length === 0) return { adopted: 0 };

  let heldUntil: number | undefined;
  const processed: { key: IDBValidKey; snapshot: string; put: boolean }[] = [];
  const writeTx = opened.tx();
  for (const record of records) {
    const until = holdUntil?.(record);
    if (until !== undefined) {
      heldUntil = heldUntil === undefined ? until : Math.min(heldUntil, until);
      continue;
    }
    const key = keyOf(record);
    const decision = decideAdoption(record, await writeTx.get(key));
    if (decision === "keep") continue;
    if (decision === "put") await writeTx.put(record);
    processed.push({ key, snapshot: JSON.stringify(record), put: decision === "put" });
  }
  await writeTx.done;
  let adopted = processed.filter((p) => p.put).length;
  if (processed.length === 0) return { adopted, heldUntil };

  const changed: { key: IDBValidKey; snapshot: string }[] = [];
  try {
    const delTx = sibling.tx();
    for (const p of processed) {
      const current = await delTx.get(p.key);
      if (current !== undefined && JSON.stringify(current) === p.snapshot) {
        await delTx.delete(p.key);
      } else if (p.put) {
        changed.push(p);
      }
    }
    await delTx.done;
  } catch {
    // Copies committed but the sibling still holds them: report failed so the
    // caller retries later (the retry drops the redundant sibling copies).
    return { adopted, heldUntil, failed: true };
  }

  if (changed.length > 0) {
    try {
      const undoTx = opened.tx();
      for (const c of changed) {
        const ours = await undoTx.get(c.key);
        if (ours !== undefined && JSON.stringify(ours) === c.snapshot) {
          await undoTx.delete(c.key);
          adopted--;
        }
      }
      await undoTx.done;
    } catch {
      /* worst case both copies stay: a duplicate send, never a lost edit */
    }
  }
  return { adopted, heldUntil };
}
