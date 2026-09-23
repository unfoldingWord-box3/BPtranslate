// Adopt-on-open reconciliation for the per-workspace IndexedDB stores (#502).
//
// The per-workspace DB name (workspace.ts's workspaceDbName) is resolved from a
// fallback flag written during boot, so across a reload the same browser can
// pick a DIFFERENT name for the SAME workspace — the unsuffixed legacy `base`
// vs the suffixed `base-{slug}`. An edit queued into the outbox (or a draft
// stashed) under one name is then invisible to the next session that opened the
// other, and never flushes: silent loss on the save protocol's "durable across
// tab close" claim.
//
// Fix: whenever a per-workspace store opens, adopt any records stranded in its
// SAFE sibling database into the one we actually opened, then delete them from
// the sibling so they cannot be double-drained. Which sibling is "safe" is the
// crux and lives in workspace.ts's reconcilableSiblingDbName — it only ever
// reconciles the fallback workspace's own { base, base-{slug} } pair, never the
// unsuffixed `base` into a non-fallback store (that would mix two orgs' edits).

import { openDB, type IDBPDatabase } from "idb";
import { reconcilableSiblingDbName } from "./workspace";

// Move every record the safe sibling DB holds under a key the opened DB does
// NOT already have into the opened DB, then delete every processed key from the
// sibling. Returns the number of records adopted (0 when there was nothing safe
// or nothing to do).
//
// Design choices, all in service of "never lose an edit, never double-apply one
// destructively":
//   - Add-if-absent: the opened DB is the one the app is actively reading and
//     writing this session, so its copy of any shared key is authoritative; we
//     only rescue keys it is missing. (Outbox ops are uuid-keyed, so every
//     stranded op is a distinct key and all are rescued; deterministic-keyed
//     drafts let the current session's typing win over a stale sibling copy.)
//   - Copy THEN delete (at-least-once): a crash between the two leaves the record
//     in both DBs; the next reconcile finds the key already present in the opened
//     DB, skips the copy, and still deletes the sibling's now-redundant copy.
//     Deleting from the sibling is REQUIRED — a later session that opens the
//     sibling as its canonical DB would otherwise re-drain the op.
//   - We only ever delete a sibling key we have confirmed is present in the
//     opened DB (just copied, or already there), so a record is never removed
//     from the last place it lives. A rare cross-tab duplicate PATCH is a benign
//     no-op under the outbox's If-Match/version threading — never data loss.
export async function adoptSiblingRecords(opts: {
  base: string;
  opened: string;
  openedDb: IDBPDatabase;
  store: string;
}): Promise<number> {
  const { base, opened, openedDb, store } = opts;
  const siblingName = reconcilableSiblingDbName(base, opened);
  if (!siblingName) return 0;

  // Never CREATE the sibling — only reconcile one that already exists. Without
  // indexedDB.databases() (older browsers) we can't tell, so skip rather than
  // blind-open (which would create a spurious empty DB). Chromium — the app's
  // target — supports databases().
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    return 0;
  }
  try {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === siblingName)) return 0;
  } catch {
    return 0;
  }

  let sibling: IDBPDatabase | undefined;
  try {
    // Open at the sibling's CURRENT version (no version arg → no upgrade) so we
    // never trigger a version-change that could block behind another tab. We
    // only read and delete existing records.
    sibling = await openDB(siblingName);
    if (!sibling.objectStoreNames.contains(store)) return 0;

    // getAllKeys() and getAll() both iterate primary-key order, so the two
    // arrays line up index-for-index.
    const keys = await sibling.getAllKeys(store);
    const records = (await sibling.getAll(store)) as unknown[];
    if (keys.length === 0) return 0;

    const existing = new Set((await openedDb.getAllKeys(store)).map((k) => String(k)));
    let adopted = 0;
    const processed: IDBValidKey[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (!existing.has(String(key))) {
        // In-line keys (keyPath) — put the record without an explicit key.
        await openedDb.put(store, records[i]);
        existing.add(String(key));
        adopted++;
      }
      // Whether just-copied or already-present, this key now lives in openedDb,
      // so the sibling's copy is redundant and safe to remove.
      processed.push(key);
    }

    const tx = sibling.transaction(store, "readwrite");
    for (const key of processed) await tx.store.delete(key);
    await tx.done;
    return adopted;
  } catch {
    // Reconciliation is best-effort: any failure here must never break the
    // store's normal open path. Stranded records are simply retried next open.
    return 0;
  } finally {
    sibling?.close();
  }
}
