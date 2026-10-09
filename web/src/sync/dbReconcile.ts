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
// Fix: whenever a per-workspace store opens (and again when boot first confirms
// the fallback flag for this slug), adopt any records stranded in its SAFE
// sibling database into the one actually opened, then delete them from the
// sibling so they cannot be double-drained. Which sibling is "safe" lives in
// workspace.ts's reconcilableSiblingDbName — only the fallback workspace's own
// { base, base-{slug} } pair, never the unsuffixed `base` into a non-fallback
// store (that would mix two orgs' edits). The per-record algorithm (copy, then
// delete only an unchanged sibling copy, undo on a concurrent change) is the
// pure, unit-tested adoptRecords in dbReconcilePlan.ts.

import { openDB, type IDBPDatabase } from "idb";
import { reconcilableSiblingDbName } from "./workspace";
import { adoptRecords, type AdoptResult, type StoreSide } from "./dbReconcilePlan";

function side(db: IDBPDatabase, store: string): StoreSide {
  return {
    readAll: () => db.getAll(store),
    tx: () => {
      const t = db.transaction(store, "readwrite");
      return {
        get: (key) => t.store.get(key),
        put: (record) => t.store.put(record),
        delete: (key) => t.store.delete(key),
        done: t.done,
      };
    },
  };
}

// Wait for `p`, but never longer than `ms`. The drafts stores gate their DB
// handle on adoption; a stuck adoption (another tab holding the adopt lock, a
// blocked open) must not leave the editors without a drafts store. The
// adoption itself keeps running and finishes in the background.
export function boundedWait(p: Promise<unknown>, ms = 3000): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.finally(() => {
      clearTimeout(t);
      resolve();
    }).catch(() => {});
  });
}

// Best-effort: never throws, and a failure only means the records stay where
// they are until the next attempt. `holdUntil` leaves a record in the sibling
// until the returned time (the outbox holds a young in-flight op that may still
// be on the wire).
//
// Runs under a Web Lock named for the base, so two tabs never adopt the same
// pair at once. Without it, tab 2 could see a record "vanish" from the sibling
// (tab 1 just moved it) and undo its copy, which is tab 1's copy in the same DB.
export async function adoptSiblingRecords(opts: {
  base: string;
  opened: string;
  openedDb: IDBPDatabase;
  store: string;
  holdUntil?: (record: unknown) => number | undefined;
}): Promise<AdoptResult> {
  const none: AdoptResult = { adopted: 0 };
  const { base, opened, openedDb, store, holdUntil } = opts;
  const siblingName = reconcilableSiblingDbName(base, opened);
  if (!siblingName) return none;

  // Never CREATE the sibling — only reconcile one that already exists. Without
  // indexedDB.databases() (older browsers) we can't tell, so skip rather than
  // blind-open (which would create a spurious empty DB). Chromium — the app's
  // target — supports databases().
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    return none;
  }

  const run = async (): Promise<AdoptResult> => {
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === siblingName)) return none;
    } catch {
      return none;
    }
    let sibling: IDBPDatabase | undefined;
    try {
      // Open at the sibling's CURRENT version (no version arg → no upgrade) so
      // we never trigger a version-change that could block behind another tab.
      sibling = await openDB(siblingName);
      if (!sibling.objectStoreNames.contains(store)) return none;
      const keyPath = sibling.transaction(store, "readonly").store.keyPath;
      if (typeof keyPath !== "string") return none; // every store here has one in-line key
      return await adoptRecords({
        sibling: side(sibling, store),
        opened: side(openedDb, store),
        keyOf: (r) => (r as Record<string, IDBValidKey>)[keyPath],
        holdUntil,
      });
    } catch {
      return none;
    } finally {
      sibling?.close();
    }
  };

  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request(`be-adopt-${base}`, run);
    }
    return await run();
  } catch {
    return none;
  }
}
