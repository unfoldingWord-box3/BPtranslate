// One-time adoption of records left in a legacy per-workspace database (#502).
//
// INVARIANT: adoption never runs while editors are mounted. Editors read their
// draft once, when they mount; one that mounted before adoption would never
// show the adopted draft and could clear or overwrite it. App.tsx therefore
// holds the editor surfaces on a named-fallback boot until adoption settles
// (adoptionGate.ts), for at most ADOPTION_WAIT_MS; past that, adoption is
// aborted for this boot and stops before the hold lifts (runBounded below).
//
// Current code writes each store into exactly one database, workspaceDbName()
// (see workspace.ts for the invariant). Older builds wrote a NAMED fallback
// workspace's outbox and drafts into the unsuffixed name (workspace.ts's
// legacyDbNames). Tabs of that workspace no longer write there (the one
// exception, a tab with cleared localStorage before its reconcile reload, is
// described at legacyDbNames), and every move below is copy-then-delete-if-
// unchanged, so a concurrent writer never loses a record. Adoption:
//   - runs only after this session's /api/auth/me confirms the current slug is
//     the fallback workspace (App.tsx), never from a persisted flag, and at
//     most once per page load, before any editor renders;
//   - first checks, with no lock, whether any legacy database holds records,
//     and stops there when none does (the normal case once adopted);
//   - moves the drafts stores first, so editors that read drafts when they
//     open find them as early as possible, then the outbox;
//   - runs in one tab at a time, under the "be-legacy-adopt" Web Lock, and the
//     outbox part also under the outbox's own "be-outbox-drain" lock, which
//     older builds drain under too, so no tab of any build sends an op while
//     it moves; the drafts part never waits on the drain lock;
//   - copies a record, then deletes the legacy copy only if it is unchanged.
//     A tab still running an older build can change it in between; then our
//     copy is undone and the record stays for the next confirmed boot.
//   - reruns on every confirmed boot (no "done" marker), because a tab of an
//     older build left open can keep writing the legacy name. The emptied
//     database is never deleted: deleteDatabase would block on those tabs'
//     connections.
// The legacy data stays durable where it is until a run moves it, so an
// offline boot (no /api/auth/me answer) or a skipped one delays adoption but
// loses nothing.

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

// What to do with one legacy record, given the live store's copy under the
// same key (undefined when absent):
//   "copy": put it into the live store, then delete the legacy copy.
//   "drop": the live copy supersedes it; delete only the legacy copy.
//   "keep": touch neither, so nothing is lost; the next run decides again.
export type Decision = "copy" | "drop" | "keep";
export type Rule = "outbox" | "draft";

// Outbox ops (uuid key; a shared key means an interrupted earlier run already
// copied the op): the newer `queuedAt` wins, since every coalesce re-stamps
// it, and a tie keeps the live copy (they differ only in drain bookkeeping).
// A live op that is in_flight is never overwritten: a newer legacy payload
// waits for the next run, an older one is dropped. If either side lacks a
// numeric queuedAt, neither copy is touched.
//
// Drafts (`updatedAt`): a strictly newer legacy draft wins. Otherwise the
// legacy copy is deleted only when its CONTENT (the text: `payload` for text
// drafts, `content` for alignment drafts) matches the live one; generation,
// expectedVersion and timestamps are ignored, so identical-text leftovers do
// not pile up. A legacy draft with different text is kept, because an editor
// that opened before adoption may have written the live copy without ever
// seeing it; a leftover legacy draft costs nothing, deleting it could lose
// unsaved text.
export function decide(legacy: unknown, current: unknown, rule: Rule): Decision {
  if (current === undefined) return "copy";
  const field = rule === "outbox" ? "queuedAt" : "updatedAt";
  const l = num(legacy, field);
  const c = num(current, field);
  const legacyNewer = l !== undefined && c !== undefined && l > c;
  if (rule === "outbox") {
    if (l === undefined || c === undefined) return "keep";
    if (!legacyNewer) return "drop";
    return (current as Record<string, unknown>).status === "in_flight" ? "keep" : "copy";
  }
  if (legacyNewer) return "copy";
  return same(draftContent(legacy), draftContent(current)) ? "drop" : "keep";
}

function num(record: unknown, field: string): number | undefined {
  const v = (record as Record<string, unknown> | null)?.[field];
  return typeof v === "number" ? v : undefined;
}

function draftContent(record: unknown): unknown {
  const r = record as Record<string, unknown> | null;
  return r?.payload ?? r?.content;
}

function same(a: unknown, b: unknown): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

// Move every record from `legacy` into `target`. Returns how many records the
// target received. The per-record order (copy, then delete the unchanged
// legacy copy) keeps every record in at least one database at all times, so a
// throw or a closed tab part-way through loses nothing; the next run resumes.
//
// Once `signal` aborts, no further record is copied: the check runs inside the
// target's transaction, so a copy either committed before the abort or never
// happens.
export async function moveRecords(
  legacy: StoreSide,
  target: StoreSide,
  keyOf: (record: unknown) => IDBValidKey,
  rule: Rule,
  signal?: AbortSignal,
): Promise<number> {
  let moved = 0;
  for (const rec of await legacy.getAll()) {
    if (signal?.aborted) break;
    const key = keyOf(rec);
    let copied = false;
    let keep = false;
    await target.update(key, (cur) => {
      if (signal?.aborted) {
        keep = true;
        return null;
      }
      const d = decide(rec, cur, rule);
      if (d === "keep") keep = true;
      if (d !== "copy") return null;
      copied = true;
      return { put: rec };
    });
    if (keep) continue;
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

// Whether any of `sources` (legacy database names plus the store each holds)
// has a record. No lock, creates nothing.
export async function anyLegacyRecords(sources: { names: string[]; store: string }[]): Promise<boolean> {
  for (const { names, store } of sources) {
    if ((await nonEmptyLegacyDbs(names, store)).length > 0) return true;
  }
  return false;
}

// Legacy databases that exist and hold at least one record in `store`.
// Takes no lock and creates nothing, so the common case (nothing left to
// adopt) costs a few opens and never touches the drain lock.
async function nonEmptyLegacyDbs(names: string[], store: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of names) {
    const db = await openExisting(name);
    if (!db) continue;
    try {
      if (db.objectStoreNames.contains(store) && (await db.count(store)) > 0) found.push(name);
    } catch {
      /* unreadable: leave it for a later run */
    } finally {
      db.close();
    }
  }
  return found;
}

// `navigator.locks.request`'s shape, injectable for the unit test.
export type LockRequest = <T>(
  name: string,
  options: { signal?: AbortSignal },
  cb: () => Promise<T>,
) => Promise<T>;

const webLock: LockRequest = <T,>(name: string, options: { signal?: AbortSignal }, cb: () => Promise<T>) =>
  navigator.locks.request(name, options, cb) as unknown as Promise<T>;

// Run `fn` holding every lock in `names`, taken in order. An abort while a
// lock is still being waited for rejects with an AbortError and `fn` never
// runs.
export async function withLocks<T>(
  names: string[],
  fn: () => Promise<T>,
  signal?: AbortSignal,
  request: LockRequest = webLock,
): Promise<T> {
  if (names.length === 0) return fn();
  const [first, ...rest] = names;
  return request(first, { signal }, async (): Promise<T> => withLocks(rest, fn, signal, request));
}

// How long a boot holds the editors for adoption before skipping it.
export const ADOPTION_WAIT_MS = 5_000;

// Run `run` with a deadline. On time, resolves { ok: true, value }. Past the
// deadline it aborts the signal handed to `run` and then WAITS for `run` to
// settle before resolving { ok: false }, so nothing `run` started can finish
// after the caller moves on (App.tsx renders editors right after). `run` must
// therefore stop promptly on abort, as adoptFromLegacyDbs does. A rejection
// also resolves { ok: false }.
export async function runBounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const value = await run(ctl.signal);
    return ctl.signal.aborted ? { ok: false } : { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// Whether this boot must hold the editors until adoption settles: /api/auth/me
// confirmed the current slug, the server says it is the fallback workspace,
// and the slug is a NAMED one ("default" writes the unsuffixed name itself, so
// there is nothing to adopt). Whether the legacy databases hold anything is
// checked separately (anyLegacyRecords), before any lock.
export function needsAdoptionGate(
  me: { workspace?: string; workspaceIsFallback?: boolean } | null | undefined,
  slug: string,
): boolean {
  return !!me && me.workspace === slug && me.workspaceIsFallback === true && slug !== "default";
}

// Move one store's records from each non-empty legacy database into `target`
// (the store module's own handle, so its schema is already in place), holding
// `locks` ("be-legacy-adopt" first, so only one tab adopts a store at a time).
// Returns the number of records moved. Without Web Locks (very old browsers)
// adoption is skipped and the legacy data stays where it is. Once `signal`
// aborts, a lock still being waited for is given up (AbortError) and no
// further record is copied.
export async function adoptFromLegacyDbs(opts: {
  legacyNames: string[];
  store: string;
  target: IDBPDatabase;
  keyPath: string;
  rule: Rule;
  locks: string[];
  signal?: AbortSignal;
}): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.locks) return 0;
  const names = await nonEmptyLegacyDbs(
    opts.legacyNames.filter((n) => n !== opts.target.name),
    opts.store,
  );
  if (names.length === 0 || opts.signal?.aborted) return 0;
  return withLocks(opts.locks, async () => {
    let moved = 0;
    for (const name of names) {
      if (opts.signal?.aborted) break;
      const legacy = await openExisting(name);
      if (!legacy) continue;
      try {
        if (!legacy.objectStoreNames.contains(opts.store)) continue;
        moved += await moveRecords(
          idbSide(legacy, opts.store),
          idbSide(opts.target, opts.store),
          (r) => (r as Record<string, IDBValidKey>)[opts.keyPath],
          opts.rule,
          opts.signal,
        );
      } finally {
        legacy.close();
      }
    }
    return moved;
  }, opts.signal);
}
