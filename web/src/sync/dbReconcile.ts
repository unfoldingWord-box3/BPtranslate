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
import { decideAdoption } from "./dbReconcilePlan";

// Move every record the safe sibling DB holds into the opened DB (or drop the
// sibling's copy when the opened DB already holds an equal-or-newer one), then
// delete every processed key from the sibling. Returns the number of records
// copied into the opened DB (0 when there was nothing safe or nothing to do).
//
// Design choices, all in service of "never lose an edit, never double-apply one
// destructively":
//   - Per-key rule (dbReconcilePlan.ts decideAdoption): copy when the opened DB
//     lacks the key or holds an older copy (by updatedAt); otherwise only drop
//     the sibling's redundant copy. The read-compare-put runs inside ONE
//     readwrite transaction on the opened DB, so a write this session makes to
//     the same key cannot slip between the compare and the put.
//   - Keys come from each record itself (the store's in-line keyPath), from a
//     single getAll. Separate getAllKeys/getAll reads could interleave with
//     another tab's write to the sibling and misalign, deleting a record that
//     was never copied.
//   - Copy THEN delete (at-least-once): a crash between the two leaves the record
//     in both DBs; the next reconcile finds the key already present in the opened
//     DB and still deletes the sibling's now-redundant copy. Deleting from the
//     sibling is REQUIRED: a later session that opens the sibling as its
//     canonical DB would otherwise re-drain the op.
//   - The sibling delete re-reads each key inside its own readwrite transaction
//     and deletes only when the record is still exactly what was processed. A
//     tab still open on the sibling (it opened before the flag landed) may have
//     rewritten that key meanwhile; its newer copy is left for the next open
//     instead of being deleted unseen.
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

    const readTx = sibling.transaction(store, "readonly");
    const keyPath = readTx.store.keyPath;
    const records = (await readTx.store.getAll()) as unknown[];
    await readTx.done;
    if (records.length === 0) return 0;
    if (typeof keyPath !== "string") return 0; // every store here uses one in-line key
    const keyOf = (r: unknown) => (r as Record<string, IDBValidKey>)[keyPath];

    let adopted = 0;
    const processed: { key: IDBValidKey; snapshot: string }[] = [];
    const writeTx = openedDb.transaction(store, "readwrite");
    for (const record of records) {
      const key = keyOf(record);
      const decision = decideAdoption(record, await writeTx.store.get(key));
      if (decision === "put") {
        await writeTx.store.put(record);
        adopted++;
      }
      processed.push({ key, snapshot: JSON.stringify(record) });
    }
    await writeTx.done; // committed: every processed key now lives in openedDb

    if (processed.length > 0) {
      const delTx = sibling.transaction(store, "readwrite");
      for (const { key, snapshot } of processed) {
        const current = await delTx.store.get(key);
        if (current !== undefined && JSON.stringify(current) === snapshot) {
          await delTx.store.delete(key);
        }
      }
      await delTx.done;
    }
    return adopted;
  } catch {
    // Reconciliation is best-effort: any failure here must never break the
    // store's normal open path. Stranded records are simply retried next open.
    return 0;
  } finally {
    sibling?.close();
  }
}
