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
export async function boundedWait(p: Promise<unknown>, ms = 3000): Promise<void> {
  await withTimeout(p, ms);
}

// Resolve with `p`'s value, or with undefined once `ms` passes first (or when
// `p` rejects). `p` keeps running either way.
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

// Adoption is not one-shot (#502): a tab still open on the sibling (it opened
// before the fallback flag landed) can keep writing there after we adopted. The
// drafts stores re-run `adopt` when the window regains focus or becomes
// visible, at most once per `ms`. With no sibling present each run costs one
// indexedDB.databases() call. Also retries an attempt that failed.
export function readoptOnFocus(adopt: () => void, ms = 30_000): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // 0, not load time: the first focus after a skipped or timed-out open-time
  // adoption must retry, even within the first 30s.
  let last = 0;
  const maybe = () => {
    if (Date.now() - last < ms) return;
    last = Date.now();
    adopt();
  };
  window.addEventListener("focus", maybe);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") maybe();
  });
}

// Best-effort: never throws. An attempt that errors returns `failed: true` and
// leaves the records where they are; the caller retries on its next attempt
// (the outbox on a later drain pass, the drafts stores on focus). `holdUntil` leaves a record in the sibling
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
  // Aborted when the caller gives up on this attempt. It cancels a wait for
  // the adopt lock, and once aborted the attempt writes nothing (see
  // adoptRecords' isAborted) and returns failed.
  signal?: AbortSignal;
}): Promise<AdoptResult> {
  const none: AdoptResult = { adopted: 0 };
  const failed: AdoptResult = { adopted: 0, failed: true };
  const { base, opened, openedDb, store, holdUntil, signal } = opts;
  const isAborted = () => signal?.aborted === true;
  const siblingName = reconcilableSiblingDbName(base, opened);
  if (!siblingName) return none;

  // Never CREATE the sibling — only reconcile one that already exists. Without
  // indexedDB.databases() (older browsers) we can't tell, so skip rather than
  // blind-open (which would create a spurious empty DB). Chromium — the app's
  // target — supports databases(). Checked before taking the lock, so the
  // common case (no sibling) costs this one call.
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    return none;
  }
  try {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === siblingName)) return none;
  } catch {
    return failed;
  }

  const run = async (): Promise<AdoptResult> => {
    if (isAborted()) return failed;
    let sibling: IDBPDatabase | undefined;
    try {
      // Open at the sibling's CURRENT version (no version arg → no upgrade) so
      // we never trigger a version-change that could block behind another tab.
      sibling = await openDB(siblingName);
      if (isAborted()) return failed;
      if (!sibling.objectStoreNames.contains(store)) return none;
      const keyPath = sibling.transaction(store, "readonly").store.keyPath;
      if (typeof keyPath !== "string") return none; // every store here has one in-line key
      return await adoptRecords({
        sibling: side(sibling, store),
        opened: side(openedDb, store),
        keyOf: (r) => (r as Record<string, IDBValidKey>)[keyPath],
        holdUntil,
        isAborted,
      });
    } catch {
      return failed;
    } finally {
      sibling?.close();
    }
  };

  try {
    if (typeof navigator !== "undefined" && navigator.locks) {
      // `signal` cancels the wait (the request rejects → failed), so abandoned
      // attempts do not pile up behind the lock.
      return await navigator.locks.request(`be-adopt-${base}`, signal ? { signal } : {}, run);
    }
    return await run();
  } catch {
    return failed;
  }
}
