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
//   - first checks, with no lock and read-only, whether any legacy record is
//     one decide() would copy or drop, and stops there when none is (the
//     normal case once adopted; records decide() keeps forever, such as a
//     differing older draft, do not count, #579);
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
// drafts, `content` for alignment drafts) matches the live one, compared
// regardless of object key order; generation,
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
  return sameContent(draftContent(legacy), draftContent(current)) ? "drop" : "keep";
}

// Draft text equality that ignores object key order (two builds can serialize
// the same payload with keys in a different order); array order still counts.
function sameContent(a: unknown, b: unknown): boolean {
  return a !== undefined && JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

// Only plain objects are rebuilt with sorted keys; any other object (a Date, a
// Map, a typed array) is returned as is, so JSON.stringify serializes it as it
// always did (a Date as its ISO string) instead of as {}.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
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

// Whether moving `legacy` into `target` would change anything: true when
// decide() says "copy" or "drop" for at least one legacy record. A store whose
// records would all be kept (a differing older draft, an op without a numeric
// queuedAt) moves nothing, so it must not hold the boot (#579). Uses the same
// decide() as moveRecords, so the check and the move cannot disagree.
export async function anyMovable(
  legacy: { getAll(): Promise<unknown[]> },
  target: { get(key: IDBValidKey): Promise<unknown> },
  keyOf: (record: unknown) => IDBValidKey,
  rule: Rule,
): Promise<boolean> {
  for (const rec of await legacy.getAll()) {
    const key = keyOf(rec);
    // A record without its key cannot be looked up (IndexedDB throws a
    // DataError); moveRecords hits the same throw. Count it as movable so the
    // bounded adoption run, not this check, deals with it.
    if (key === undefined) return true;
    if (decide(rec, await target.get(key), rule) !== "keep") return true;
  }
  return false;
}

// Run each check in turn; true as soon as one is true. A check that throws
// counts as true, so an unreadable database holds the boot and leaves it to
// the bounded adoption run instead of hiding the stores checked after it.
export async function anyCheck(checks: (() => Promise<boolean>)[]): Promise<boolean> {
  for (const check of checks) {
    try {
      if (await check()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// One store adoption would move: its legacy databases, the live database it
// moves into, and how decide() matches records.
export interface LegacySource {
  names: string[];
  store: string;
  targetName: string;
  keyPath: string;
  rule: Rule;
}

// Whether any of `sources` holds a legacy record adoption would move (see
// anyMovable). No lock, read-only, creates nothing; a missing live database
// or store means every legacy record would be copied. Each source is checked
// on its own (anyCheck), so an error in one counts as movable rather than
// skipping the rest.
export function anyMovableLegacyRecords(sources: LegacySource[]): Promise<boolean> {
  return anyCheck(sources.map((src) => () => sourceMovable(src)));
}

async function sourceMovable(src: LegacySource): Promise<boolean> {
  const names = await nonEmptyLegacyDbs(
    src.names.filter((n) => n !== src.targetName),
    src.store,
  );
  if (names.length === 0) return false;
  const target = await openExisting(src.targetName);
  try {
    if (!target || !target.objectStoreNames.contains(src.store)) return true;
    for (const name of names) {
      const legacy = await openExisting(name);
      if (!legacy) continue;
      try {
        const movable = await anyMovable(
          { getAll: () => legacy.getAll(src.store) },
          { get: (key) => target.get(src.store, key) },
          (r) => (r as Record<string, IDBValidKey>)[src.keyPath],
          src.rule,
        );
        if (movable) return true;
      } finally {
        legacy.close();
      }
    }
  } finally {
    target?.close();
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

// How long a boot holds the editors for adoption before skipping it, and how
// much longer it waits, after aborting, for the run to stop.
export const ADOPTION_WAIT_MS = 5_000;
export const ADOPTION_GRACE_MS = 1_000;

// Run `run` with a deadline. On time, resolves { ok: true, value }. Past
// `timeoutMs` it aborts the signal handed to `run` and waits up to `graceMs`
// more for `run` to settle before resolving { ok: false }, so work `run` has
// in progress (an IndexedDB transaction) completes before the caller moves on
// (App.tsx renders editors right after). The grace cap keeps a hung step (an
// IndexedDB open that never resolves) from holding the caller forever; `run`
// must check the signal after every await that could hang, so a step that
// resumes later does nothing, as adoptFromLegacyDbs and moveRecords do. A
// rejection also resolves { ok: false }.
export function runBounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  graceMs: number = ADOPTION_GRACE_MS,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = run(ctl.signal).then(
    (value) => (ctl.signal.aborted ? { ok: false as const } : { ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  const expired = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      timer = setTimeout(() => resolve({ ok: false }), graceMs);
    }, timeoutMs);
  });
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
}

// Whether this boot must hold the editors until adoption settles: /api/auth/me
// confirmed the current slug, the server says it is the fallback workspace,
// and the slug is a NAMED one ("default" writes the unsuffixed name itself, so
// there is nothing to adopt). Whether the legacy databases hold anything to
// move is checked separately (anyMovableLegacyRecords), before any lock.
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
