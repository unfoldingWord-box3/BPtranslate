// One-time adoption of records left in a legacy per-workspace database (#502).
//
// Current code writes each store into exactly one database, workspaceDbName()
// (see workspace.ts for the invariant). Older builds wrote the fallback
// workspace's outbox and drafts into other names (workspace.ts's
// legacyDbNames). No current-code tab writes to those, so their records can be
// moved without racing a live writer of this build. Adoption:
//   - runs only after this session's /api/auth/me confirms the current slug is
//     the fallback workspace (App.tsx), never from a persisted flag;
//   - runs in one tab at a time, under the "be-legacy-adopt" Web Lock, and the
//     outbox part also under the outbox's own "be-outbox-drain" lock, which
//     older builds drain under too, so no tab of any build sends an op while
//     it moves;
//   - copies a record, then deletes the legacy copy only if it is unchanged.
//     A tab still running an older build can change it in between; then our
//     copy is undone and the record stays for the next confirmed boot.
//   - reruns on every confirmed boot (no "done" marker), because a tab of an
//     older build left open can keep writing the legacy name. With nothing
//     left it costs one open of an empty database. The emptied database is
//     never deleted: deleteDatabase would block on those tabs' connections.
// The legacy data stays durable where it is until a run moves it, so an
// offline boot (no /api/auth/me answer) delays adoption but loses nothing.

import { wrap, type IDBPDatabase } from "idb";

// The atomic read-then-write one store offers per key. The app backs it with
// one IndexedDB readwrite transaction (idbSide below); the unit test with a Map.
export interface StoreSide {
  getAll(): Promise<unknown[]>;
  // Read the record under `key` and, in the same transaction, apply what
  // `decide` returns: put a record, delete the key, or leave it alone.
  update(key: IDBValidKey, decide: (current: unknown) => Change): Promise<void>;
}
export type Change = { put: unknown } | { delete: true } | null;

// Whether a legacy record should replace the target's copy under the same key.
// With `newerField` (the drafts stores' `updatedAt`), the strictly newer copy
// wins and a tie keeps the target. Without it (outbox ops, keyed by a random
// uuid), a shared key means an earlier interrupted run already copied the op,
// so the target's copy is kept.
export function shouldReplace(legacy: unknown, current: unknown, newerField?: string): boolean {
  if (current === undefined) return true;
  if (!newerField) return false;
  const l = (legacy as Record<string, unknown> | null)?.[newerField];
  const c = (current as Record<string, unknown> | null)?.[newerField];
  return typeof l === "number" && typeof c === "number" && l > c;
}

function same(a: unknown, b: unknown): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

// Move every record from `legacy` into `target`. Returns how many records the
// target received. The per-record order (copy, then delete the unchanged
// legacy copy) keeps every record in at least one database at all times, so a
// throw or a closed tab part-way through loses nothing; the next run resumes.
export async function moveRecords(
  legacy: StoreSide,
  target: StoreSide,
  keyOf: (record: unknown) => IDBValidKey,
  newerField?: string,
): Promise<number> {
  let moved = 0;
  for (const rec of await legacy.getAll()) {
    const key = keyOf(rec);
    let copied = false;
    await target.update(key, (cur) => {
      if (!shouldReplace(rec, cur, newerField)) return null;
      copied = true;
      return { put: rec };
    });
    let removed = false;
    await legacy.update(key, (cur) => {
      if (!same(cur, rec)) return null;
      removed = true;
      return { delete: true };
    });
    if (removed) {
      if (copied) moved++;
    } else if (copied) {
      // An older-build tab changed or removed the legacy record after we read
      // it. Undo our now-stale copy (unless something already replaced it) and
      // leave the legacy record for the next run.
      await target.update(key, (cur) => (same(cur, rec) ? { delete: true } : null));
    }
  }
  return moved;
}

export function idbSide(db: IDBPDatabase, store: string): StoreSide {
  return {
    getAll: () => db.getAll(store),
    async update(key, decide) {
      const tx = db.transaction(store, "readwrite");
      const change = decide(await tx.store.get(key));
      if (change && "put" in change) await tx.store.put(change.put);
      else if (change) await tx.store.delete(key);
      await tx.done;
    },
  };
}

// Open `name` only if it already exists. A plain open would create an empty
// database; aborting the upgrade that creation triggers undoes it.
function openExisting(name: string): Promise<IDBPDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(wrap(req.result));
    req.onerror = () => resolve(null);
  });
}

// Move one store's records from each legacy database into `target` (the
// store module's own handle, so its schema is already in place). Returns the
// number of records moved.
export async function adoptFromLegacyDbs(opts: {
  legacyNames: string[];
  store: string;
  target: IDBPDatabase;
  keyPath: string;
  newerField?: string;
}): Promise<number> {
  let moved = 0;
  for (const name of opts.legacyNames) {
    if (name === opts.target.name) continue;
    const legacy = await openExisting(name);
    if (!legacy) continue;
    try {
      if (!legacy.objectStoreNames.contains(opts.store)) continue;
      moved += await moveRecords(
        idbSide(legacy, opts.store),
        idbSide(opts.target, opts.store),
        (r) => (r as Record<string, IDBValidKey>)[opts.keyPath],
        opts.newerField,
      );
    } finally {
      legacy.close();
    }
  }
  return moved;
}

// Single-tab gate for a whole adoption run. Without Web Locks (very old
// browsers) adoption is skipped: the legacy data stays where it is.
export async function withLegacyAdoptLock(fn: () => Promise<void>): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  await navigator.locks.request("be-legacy-adopt", fn);
}
