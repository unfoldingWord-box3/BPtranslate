// Local draft store for unsaved edits. Every editable field (ULT/UST verse,
// TN/TQ/TWL row, note quote/body/support-ref, tW/tA article part, note
// template) stashes its
// in-progress text here on every keystroke. The outbox is NOT touched until the
// user clicks Save — drafts are deliberately separate from the write-ahead
// queue so the only thing that produces a PATCH is an explicit user action.
//
// Persistence is IndexedDB so a tab close or crash doesn't lose typing.
// This is not autosave; nothing leaves the browser until the user saves.

import { openDB, type IDBPDatabase } from "idb";
import { isReadOnly, type RowKind } from "./api";
import { isLaneFrozen } from "./laneFreeze";
import { onOutboxDrop, onOutboxResult, outbox, type OutboxOp } from "./outbox";
import {
  generationForSuccessfulOp,
  liveRowOpHoldsDraft,
  rowDraftAfterConfirm,
  rowDraftAfterRelease,
  withCarriedConfirm,
  rowDraftHoldsSaved,
} from "./draftSaveState";
import {
  afterConfirmKeepingRefusal,
  keepsRefusedText,
  rowDraftAfterRefusal,
  rowDraftAfterRefusedDiscard,
  rowDraftOnNoDiff,
  withCarriedRefusal,
} from "./refusedRowDraft";
import { legacyDbNames, workspaceDbName } from "./workspace";
import { adoptFromLegacyDbs, type LegacySource } from "./legacyAdoption";

// Base name; the actual per-workspace DB name is derived via workspaceDbName()
// so drafts written in one Door43 org never surface in another (issue #228).
// Drafts older builds kept under a legacy name are moved in by
// adoptLegacyDrafts below — same rule as the outbox (#502).
const DB_NAME = "bible-editor-drafts";
const DB_VERSION = 1;
const STORE = "drafts";

export interface VerseDraftPayload {
  content: unknown;
  plain_text?: string | null;
}

export type DraftPayload = VerseDraftPayload | Record<string, unknown>;

export interface DraftRecord {
  key: string;
  payload: DraftPayload;
  expectedVersion: number;
  updatedAt: number;
  // Opaque identity for this exact draft write. A save carries the generation
  // it captured into the outbox so its eventual 200 only clears that draft,
  // never newer typing on the same verse that arrived while the request was in
  // flight. Optional for records persisted before this field was introduced;
  // those use a stable legacy identity derived from updatedAt.
  generation?: string;
  // Denormalized so subscribers (UnsavedToasts, SyncStatusBar) can render
  // "Save Num 20:1 ULT?" without parsing the key. Verse drafts carry
  // book/chapter/verse/bibleVersion; row drafts carry kind/id/book.
  meta: DraftMeta;
  // Set when a scripture lane freezes for replacement. Quarantined drafts are
  // kept for discard/export but must not restore into editors or count as
  // active unsaved typing — the generation is about to flip.
  quarantined?: string;
  // Row drafts only (#632 item 1): fields a confirmed save landed while a later
  // save for the row still held them (draftSaveState.rowDraftAfterConfirm). If
  // that later save never confirms, the draft is re-settled from these values
  // where they are still the server's. set() carries it across re-writes.
  confirmed?: Record<string, unknown>;
  // The row version `confirmed` landed at; only an op chained from it (its
  // expectedVersion) can vouch for the record.
  confirmedVersion?: number;
  // Row drafts only (#647): fields a refused save sent (fatal 4xx, or dropped
  // as "locked") that were written back here because nothing else held them
  // (refusedRowDraft.ts). While set, an editor's "no diff" clear keeps the
  // draft (drafts.clearUnlessRefused): its fields still equal the cached row,
  // which carries the refused text. The next set() drops it, as typing makes
  // the draft the editor's own again; a confirmed save or Discard clears it.
  refused?: Record<string, unknown>;
}

export type DraftMeta =
  | {
      kind: "verse";
      book: string;
      chapter: number;
      verse: number;
      bibleVersion: string;
    }
  | {
      kind: "row";
      rowKind: RowKind;
      id: string;
      book: string;
      chapter: number;
      verse: number;
    }
  // tW / tA article part (body, title, sub-title). Articles are book-agnostic,
  // so this variant carries no book/chapter/verse — consumers that navigate by
  // reference must special-case it (SyncStatusBar routes to the article hash).
  | {
      kind: "article";
      resource: "tw" | "ta";
      articleId: string;
      path: string;
      part: "body" | "title" | "sub-title";
    }
  // Note template (template_units). Templates are book-agnostic like articles,
  // so this variant carries no book/chapter/verse — consumers that navigate by
  // reference must special-case it (SyncStatusBar routes to the template hash).
  | {
      kind: "template";
      templateId: string;
      supportRef: string;
    };

type Subscriber = (drafts: DraftRecord[]) => void;

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(workspaceDbName(DB_NAME), DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: "key" });
        }
      },
    });
  }
  return dbp;
}

const subscribers = new Set<Subscriber>();

// Called with the key of each draft the user discarded (drafts.discard).
const discardListeners = new Set<(key: string) => void>();
export function onDraftDiscarded(fn: (key: string) => void): () => void {
  discardListeners.add(fn);
  return () => discardListeners.delete(fn);
}

// Synchronous mirror of "a draft was written this session and not yet cleared".
// The subscription-driven signal (useUnsavedGuard's hasDrafts) only updates
// after an async listAll()+notify round-trip, which lags the set() call — a
// reload in that window (before the IndexedDB write even commits) would slip
// past the unsaved-work guard. set()/clear() keep this Set in lockstep
// synchronously so beforeunload can read a live answer. It only covers drafts
// touched THIS session; prior-session persisted drafts are covered by the async
// subscription (and survive the reload regardless, so a missed prompt there is
// not data loss).
const pendingKeys = new Set<string>();
// Synchronous mirror of the latest generation written per key — covers a
// newer set() that has started synchronously but has not committed to
// IndexedDB yet (see clearGeneration).
const latestGenerationByKey = new Map<string, string>();
let generationSeq = 0;

function nextGeneration(): string {
  generationSeq += 1;
  return `${Date.now()}:${generationSeq}:${Math.random().toString(36).slice(2)}`;
}

export function hasUnsavedDrafts(): boolean {
  return pendingKeys.size > 0;
}

async function listAll(): Promise<DraftRecord[]> {
  const all = (await (await db()).getAll(STORE)) as DraftRecord[];
  all.sort((a, b) => a.updatedAt - b.updatedAt);
  return all;
}

async function notify() {
  if (subscribers.size === 0) return;
  const all = await listAll();
  for (const s of subscribers) s(all);
}

// Delete a row draft only if `settled` accepts it. Read + conditional delete
// share one transaction so an editor's re-write cannot slip between them.
async function clearRowIf(key: string, settled: (rec: DraftRecord) => boolean): Promise<boolean> {
  const idb = await db();
  const tx = idb.transaction(STORE, "readwrite");
  const rec = (await tx.store.get(key)) as DraftRecord | undefined;
  if (!rec || rec.quarantined || !settled(rec)) {
    await tx.done;
    return false;
  }
  await tx.store.delete(key);
  await tx.done;
  releasePendingMark(key, rec.generation);
  void notify();
  return true;
}

// Drop the dirty mark for a deleted draft unless a newer set() has started but
// not committed (set() always tracks its generation). A key marked pending
// with no tracked generation (legacy-key migration in get()) is released too.
function releasePendingMark(key: string, generation: string | undefined) {
  if (!latestGenerationByKey.has(key) || latestGenerationByKey.get(key) === generation) {
    latestGenerationByKey.delete(key);
    pendingKeys.delete(key);
  }
}

// Per-row-key chains that run drafts.settleRowAfterOp and
// drafts.clearRowIfSaved one at a time for a row, so one cannot run between
// another's outbox read and its draft write. A failed step leaves the draft as
// it was (kept, the safe side), resolves to `failed`, and does not stall the
// row's later steps.
const settleChains = new Map<string, Promise<unknown>>();
function onRowChain<T>(key: string, fn: () => Promise<T>, failed: T): Promise<T> {
  const run = () =>
    fn().catch((e) => {
      console.warn("row draft settle failed", key, e);
      return failed;
    });
  const next = (settleChains.get(key) ?? Promise.resolve()).then(run);
  settleChains.set(key, next);
  void next.then(() => {
    if (settleChains.get(key) === next) settleChains.delete(key);
  });
  return next;
}

// One row settle; see drafts.settleRowAfterOp. `decide` is rowDraftAfterConfirm
// for a confirmed op, or rowDraftAfterRelease when an op that held the draft
// left without confirming (resettleRow).
async function settleRowNow(
  key: string,
  decide: (rec: DraftRecord, queued: OutboxOp[] | null) => "clear" | DraftRecord | undefined,
): Promise<void> {
  let queued: OutboxOp[] | null;
  try {
    queued = await outbox.list();
  } catch {
    queued = null;
  }
  const idb = await db();
  const tx = idb.transaction(STORE, "readwrite");
  const rec = (await tx.store.get(key)) as DraftRecord | undefined;
  const next = rec && !rec.quarantined ? decide(rec, queued) : undefined;
  if (next === undefined) {
    await tx.done;
    return;
  }
  if (next !== "clear") {
    await tx.store.put(next);
    await tx.done;
    void notify();
    return;
  }
  await tx.store.delete(key);
  await tx.done;
  releasePendingMark(key, rec?.generation);
  void notify();
}

export function verseKey(
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): string {
  return `verse:${book}:${chapter}:${verse}:${bibleVersion}`;
}

// Row ids are only unique per (book, id) — the same 4-char id can exist in
// two books with unrelated content — so the key must carry the book or
// cross-book drafts collide (wrong text shown/saved). Pre-book records
// ("row:{kind}:{id}") are migrated lazily in get() below.
export function rowKey(rowKind: RowKind, book: string, id: string): string {
  return `row:${rowKind}:${book}:${id}`;
}

// Article part drafts. `path` is already unique within a resource, but the
// resource is kept in the key so a tw and ta path can never collide.
export function articleKey(resource: "tw" | "ta", path: string): string {
  return `article:${resource}:${path}`;
}

// Note template drafts. template_id is the table's primary key, so it is
// already globally unique; the prefix only keeps it out of the other keyspaces.
export function templateKey(templateId: string): string {
  return `template:${templateId}`;
}

export const drafts = {
  subscribe(fn: Subscriber): () => void {
    subscribers.add(fn);
    void listAll().then(fn);
    return () => subscribers.delete(fn);
  },

  async set(
    key: string,
    payload: DraftPayload,
    expectedVersion: number,
    meta: DraftMeta,
    opts?: { quarantined?: string },
  ): Promise<void> {
    if (isReadOnly()) return;
    // While a lane is frozen, refuse new keystroke drafts — quarantine already
    // scanned existing ones. Exception: an explicit `quarantined` write used
    // by the freeze handler to serialize dirty aligner state before close.
    if (
      meta.kind === "verse" &&
      isLaneFrozen(meta.bibleVersion) &&
      !opts?.quarantined
    ) {
      return;
    }
    // Mark dirty synchronously — before the async put — so the unload guard
    // sees it during the commit window (see pendingKeys). Quarantined writes
    // are recovery copies, not active typing.
    const generation = nextGeneration();
    if (!opts?.quarantined) {
      pendingKeys.add(key);
      latestGenerationByKey.set(key, generation);
    } else {
      pendingKeys.delete(key);
      latestGenerationByKey.delete(key);
    }
    const rec: DraftRecord = {
      key,
      payload,
      expectedVersion,
      updatedAt: Date.now(),
      generation,
      meta,
      ...(opts?.quarantined ? { quarantined: opts.quarantined } : {}),
    };
    if (meta.kind !== "row") {
      await (await db()).put(STORE, rec);
    } else {
      // Keep a row draft's `confirmed` record (withCarriedConfirm) and a
      // refused save's text (withCarriedRefusal, #647) across re-writes: read
      // and write in one transaction.
      const tx = (await db()).transaction(STORE, "readwrite");
      const prev = (await tx.store.get(key)) as DraftRecord | undefined;
      await tx.store.put(withCarriedRefusal(prev, withCarriedConfirm(prev, rec)));
      await tx.done;
    }
    void notify();
  },

  async get(key: string): Promise<DraftRecord | undefined> {
    const idb = await db();
    const rec = (await idb.get(STORE, key)) as DraftRecord | undefined;
    // Quarantined drafts stay in IDB for discard/export but must not hydrate
    // editors — restoring them would put superseded-generation text back in.
    if (rec) return rec.quarantined ? undefined : rec;
    // One-time tolerance for the pre-book row key format ("row:{kind}:{id}").
    // On a miss, check whether a legacy record exists whose meta says it
    // belongs to this book; if so, migrate it under the new key. A legacy
    // record for the *other* book in a collision stays put until that book's
    // card claims it.
    const m = /^row:([^:]+):([^:]+):(.+)$/.exec(key);
    if (!m) return undefined;
    const [, rowKind, book, id] = m;
    const legacyKey = `row:${rowKind}:${id}`;
    const legacy = (await idb.get(STORE, legacyKey)) as DraftRecord | undefined;
    if (!legacy || legacy.meta.kind !== "row" || legacy.meta.book !== book) {
      return undefined;
    }
    const migrated: DraftRecord = { ...legacy, key };
    pendingKeys.delete(legacyKey);
    pendingKeys.add(key);
    await idb.put(STORE, migrated);
    await idb.delete(STORE, legacyKey);
    void notify();
    return migrated;
  },

  async clear(key: string): Promise<void> {
    pendingKeys.delete(key);
    latestGenerationByKey.delete(key);
    await (await db()).delete(STORE, key);
    void notify();
  },

  // The user threw this draft away (the unsaved list's Discard). Clears it,
  // then tells this tab's onDraftDiscarded listeners, so an editor still
  // showing the text (a refused save it holds, #637 item 1) puts the row's
  // value back instead of writing the draft again.
  async discard(key: string): Promise<void> {
    await drafts.clear(key);
    for (const l of discardListeners) {
      try {
        l(key);
      } catch (e) {
        console.warn("draft discard listener failed", e);
      }
    }
  },

  // Delete only the exact draft generation that produced a successful save.
  // The read + conditional delete share one transaction so another committed
  // write cannot slip between them. latestGenerationByKey also covers a newer
  // set() that has started synchronously but has not committed to IndexedDB
  // yet. Quarantined records are never touched — they are the freeze handler's
  // recovery copies, not confirmations waiting to be cleaned up.
  async clearGeneration(key: string, generation: string): Promise<boolean> {
    const idb = await db();
    const tx = idb.transaction(STORE, "readwrite");
    const rec = (await tx.store.get(key)) as DraftRecord | undefined;
    const currentGeneration = rec?.generation ?? (rec ? `legacy:${rec.updatedAt}` : undefined);
    if (!rec || rec.quarantined || currentGeneration !== generation) {
      await tx.done;
      return false;
    }
    await tx.store.delete(key);
    await tx.done;
    if (latestGenerationByKey.get(key) === generation) {
      latestGenerationByKey.delete(key);
      pendingKeys.delete(key);
    }
    void notify();
    return true;
  },

  // Apply a successful row op to its draft (rowDraftAfterOp): clear it if the
  // op settled it, else rebase its baseline. The outbox is read first, then
  // the draft is read, decided on and written in one drafts transaction, so an
  // editor's re-write cannot slip between them. The outbox read cannot share
  // that transaction (separate database), so settles for one row run one at a
  // time (settleChains): a later op's settle cannot start between an earlier
  // one's outbox read and its write. Remaining race: an op enqueued in the gap
  // between the two reads is not seen. That only matters if the draft still
  // holds exactly what this op sent while the new op sends something else; an
  // editor's draft holds what it is about to save, so the new op would send
  // the draft's text too, and the clear loses nothing.
  // `landedVersion` is the row version the 200 returned.
  settleRowAfterOp(key: string, op: OutboxOp, landedVersion?: number): Promise<void> {
    return onRowChain(
      key,
      () =>
        settleRowNow(key, (rec, queued) =>
          // A refused field this op did not send stays refused (#647).
          afterConfirmKeepingRefusal(rec, rowDraftAfterConfirm(rec, op, queued, landedVersion), op),
        ),
      undefined,
    );
  },

  // Delete a row draft only if it holds nothing but the saved values
  // (rowDraftHoldsSaved), in one transaction. For editors whose baseline moves
  // after the save's 200 (#616 review). Like the outbox settle, it keeps the
  // draft while a live later op for the row holds it (liveRowOpHoldsDraft):
  // the screen saved N1, a later save of N2 is still queued and the draft was
  // typed back to N1, so clearing it here would lose N1 when N2 lands (#618
  // review). It runs on the same per-row chain as settleRowAfterOp.
  clearRowIfSaved(key: string, saved: Record<string, unknown>): Promise<boolean> {
    return onRowChain(
      key,
      async () => {
        let queued: OutboxOp[] | null;
        try {
          queued = await outbox.list();
        } catch {
          queued = null;
        }
        return clearRowIf(key, (rec) => rowDraftHoldsSaved(rec, saved) && !liveRowOpHoldsDraft(rec, key, queued));
      },
      false,
    );
  },

  // An editor's "no diff any more" clear for a row draft, except while a live
  // later op for the row holds it (liveRowOpHoldsDraft; an unreadable outbox
  // keeps it). Needed since a confirmed save's cached row carries later
  // pending saves (#620): an editor whose baseline follows the cached row can
  // reach "no diff" against text a later op has not landed yet, and clearing
  // then would leave that text nowhere if the op is dropped or discarded (#618
  // rule). Runs on the row's settle chain; it also skips when a newer set()
  // started after the request, so typing in the outbox-read window is kept.
  clearRowUnlessHeld(key: string): Promise<boolean> {
    const requested = latestGenerationByKey.get(key);
    return onRowChain(
      key,
      async () => {
        let queued: OutboxOp[] | null;
        try {
          queued = await outbox.list();
        } catch {
          queued = null;
        }
        return clearRowIf(
          key,
          (rec) =>
            latestGenerationByKey.get(key) === requested && !liveRowOpHoldsDraft(rec, key, queued),
        );
      },
      false,
    );
  },

  // An editor's "no diff any more" clear that keeps a refused save's text
  // (DraftRecord.refused, #647). The classic tQ / tW-link editors diff against
  // the cached row, which still carries that text after the refusal, so their
  // plain clear would drop it on the next render or remount. `current` is what
  // the editor shows, in the form its Save sends; with the outbox it tells a
  // refused field still pending from one the user has since saved over
  // (rowDraftOnNoDiff). Runs on the row's settle chain; the outbox is read
  // first, then the draft is read and written in one transaction. A set()
  // started after this request (the map moved off `requested`) is newer
  // typing: its draft and its dirty mark are left alone, checked both inside
  // the transaction and again after it commits (round-2 review B2).
  clearUnlessRefused(key: string, current: Record<string, unknown>): Promise<boolean> {
    const requested = latestGenerationByKey.get(key);
    return onRowChain(
      key,
      async () => {
        const idb = await db();
        // Common path first, as cheap as main's clear(): every non-dirty row
        // runs this on mount, and almost none has a refused record. With no
        // record or no `refused`, delete in one transaction without reading
        // the outbox, and notify only when a record was deleted (round-3 C1).
        const first = idb.transaction(STORE, "readwrite");
        const found = (await first.store.get(key)) as DraftRecord | undefined;
        if (latestGenerationByKey.get(key) !== requested) {
          await first.done;
          return false;
        }
        if (!found?.refused) {
          if (found) await first.store.delete(key);
          await first.done;
          if (latestGenerationByKey.get(key) === requested) {
            pendingKeys.delete(key);
            latestGenerationByKey.delete(key);
          }
          if (found) void notify();
          return true;
        }
        await first.done;
        // A refused record: read the outbox, then decide in a fresh
        // transaction (the record may have changed meanwhile).
        let queued: OutboxOp[] | null;
        try {
          queued = await outbox.listWithUncommitted();
        } catch {
          queued = null;
        }
        const tx = idb.transaction(STORE, "readwrite");
        const rec = (await tx.store.get(key)) as DraftRecord | undefined;
        if (latestGenerationByKey.get(key) !== requested) {
          await tx.done;
          return false;
        }
        const next = rec ? rowDraftOnNoDiff(rec, current, queued) : "clear";
        if (next !== "clear") {
          if (next) await tx.store.put(next);
          await tx.done;
          if (next) void notify();
          return false;
        }
        if (rec) await tx.store.delete(key);
        await tx.done;
        if (latestGenerationByKey.get(key) === requested) {
          pendingKeys.delete(key);
          latestGenerationByKey.delete(key);
        }
        if (rec) void notify();
        return true;
      },
      false,
    );
  },

  async list(): Promise<DraftRecord[]> {
    return listAll();
  },

  // Quarantine every unsaved verse draft for a bible_version whose lane just
  // froze for a replacement. Drafts are kept (exportable / discardable) but
  // stopped from restoring into editors. Row drafts (tn/tq/twl) are
  // lane-agnostic and left alone. Returns the count quarantined.
  async quarantineByVersion(bibleVersion: string, reason: string): Promise<number> {
    const idb = await db();
    const all = (await idb.getAll(STORE)) as DraftRecord[];
    let n = 0;
    for (const rec of all) {
      if (rec.meta.kind !== "verse" || rec.meta.bibleVersion !== bibleVersion) continue;
      if (rec.quarantined) continue;
      pendingKeys.delete(rec.key);
      await idb.put(STORE, { ...rec, quarantined: reason, updatedAt: Date.now() });
      n++;
    }
    if (n > 0) void notify();
    return n;
  },
};

// Where adoptLegacyDrafts looks, for adoptionGate.ts's lock-free emptiness check.
export function legacyDraftsSource(fallbackSlug: string): LegacySource {
  return {
    names: legacyDbNames(DB_NAME, fallbackSlug),
    store: STORE,
    targetName: workspaceDbName(DB_NAME),
    keyPath: "key",
    rule: "draft",
  };
}

// Move drafts an older build stashed for the confirmed fallback workspace into
// this build's store (#502; see legacyAdoption.ts's decide for which copy
// wins a key both stores hold).
export async function adoptLegacyDrafts(fallbackSlug: string, signal?: AbortSignal): Promise<void> {
  const moved = await adoptFromLegacyDbs({
    legacyNames: legacyDbNames(DB_NAME, fallbackSlug),
    store: STORE,
    target: await db(),
    keyPath: "key",
    rule: "draft",
    locks: ["be-legacy-adopt"],
    signal,
  });
  if (moved > 0) void notify();
}

// Emotion/sx fragment for the orange "you have unsaved typing here" border.
// Targets any descendant marked `data-dirty="true"` that isn't currently
// focused — quiet while typing, loud once you click away. The inset
// box-shadow draws inside the existing border so layout doesn't shift.
// Use the literal warning color (Kindle / #E59D33) so this object stays
// theme-agnostic and can spread into any sx block.
export function draftDirtyBorderSx() {
  return {
    "& [data-dirty='true']:not(:focus)": {
      boxShadow: "inset 0 0 0 2px #E59D33",
    },
  } as const;
}

// Auto-clear the draft when the outbox confirms its corresponding PATCH
// landed. Anything other than a 200 keeps the draft so the user can retry
// or hand-edit. 409 is special — the user resolves via SyncStatusBar; the
// draft survives so the next retry has the right payload.
//
// Quarantined drafts/ops must NOT clear on a late 200: an in-flight op can
// still succeed after quarantineLaneOps marked it failed — clearing would
// wipe the recovery copy the freeze handler just preserved. drainPass
// re-reads the op and forwards the quarantined flag on the listener op.
onOutboxResult((op, result) => {
  // A row op that ended fatally failed no longer holds its row draft
  // (#632 item 1). rowDraftAfterRelease leaves the draft as it is: a refusal
  // does not prove the row is still at the recorded version (#650). A "locked"
  // drop is not re-settled: an AI apply is about to overwrite the row, so the
  // record is no longer known to be the server's (rowDraftAfterRelease).
  // A refused row save's text is written back to its draft first (#647), so
  // it is not lost when the editor had already cleared the draft at Save.
  // Not on a fatal 404: the row is gone (keepsRefusedText).
  if (keepsRefusedText(result) && op.target.kind === "row" && !op.quarantined) {
    keepRefusedRow(op);
  }
  if (result.kind === "fatal" && op.target.kind === "row") {
    resettleRow(op, "fatal");
    return;
  }
  if (result.kind !== "ok") return;
  if (op.quarantined) return;
  if (op.target.kind === "verse") {
    // Generation-fenced: this 200 confirms ONE exact captured payload. If the
    // user typed again while the request was in flight, the draft under this
    // key is a newer generation and must survive (persistence, not
    // confirmation — see draftSaveState.ts). drafts.get also returns
    // undefined for quarantined records, so a late 200 can never wipe a
    // freeze-recovery copy.
    const key = verseKey(op.target.book, op.target.chapter, op.target.verse, op.target.bibleVersion);
    void drafts.get(key).then((draft) => {
      const generation = generationForSuccessfulOp(draft, op);
      if (generation) void drafts.clearGeneration(key, generation);
    });
  } else if (op.target.kind === "row") {
    // Content-fenced (#618): the draft is cleared only if it holds nothing but
    // what this save sent and no later save for the row is queued; typing done
    // after the Save survives, whether or not the editor is still mounted.
    const landed = (result.updated as { version?: unknown } | null | undefined)?.version;
    void drafts.settleRowAfterOp(
      rowKey(op.target.rowKind, op.target.book, op.target.id),
      op,
      typeof landed === "number" ? landed : undefined,
    );
  }
});

// A row op discarded from the outbox (a conflict or failed save the user threw
// away) no longer holds its row draft either (#632 item 1). The op is as it
// was stored, so a conflicted one carries the server row from its 409.
onOutboxDrop((op) => {
  if (op.target.kind !== "row") return;
  // Discarding a failed save also takes back the text its refusal wrote to the
  // draft (#647 review A5), so Discard drops the text as it did before.
  if (op.status === "failed") dropRefusedText(op);
  resettleRow(op, "drop");
});

function dropRefusedText(op: OutboxOp) {
  if (op.target.kind !== "row") return;
  const key = rowKey(op.target.rowKind, op.target.book, op.target.id);
  void onRowChain(key, () => settleRowNow(key, (rec) => rowDraftAfterRefusedDiscard(rec, op)), undefined);
}

// Re-settle a row draft from its `confirmed` record (rowDraftAfterRelease)
// after `op`, which may have held it, left without confirming. Runs on the
// row's settle chain after any settle already queued. Only this tab hears the
// event; a record another tab's discard left behind is dropped by the row's
// next confirmed save (it did not chain from the record).
function resettleRow(op: OutboxOp, reason: "fatal" | "drop") {
  if (op.target.kind !== "row") return;
  const key = rowKey(op.target.rowKind, op.target.book, op.target.id);
  void onRowChain(key, () => settleRowNow(key, (rec, queued) => rowDraftAfterRelease(rec, op, reason, queued)), undefined);
}

// Write a refused row save's text back to the row's draft (rowDraftAfterRefusal,
// #647). Runs on the row's settle chain; the outbox is read first (with this
// tab's uncommitted saves, as clearUnlessRefused reads it, so a save made in
// the same tick counts) so a later live save for the row keeps its newer text, then the draft is read, decided
// on and written in one drafts transaction, so an editor's re-write cannot slip
// between. Only this tab hears the result.
function keepRefusedRow(op: OutboxOp) {
  if (op.target.kind !== "row" || op.action === "delete") return;
  const key = rowKey(op.target.rowKind, op.target.book, op.target.id);
  void onRowChain(
    key,
    async () => {
      let queued: OutboxOp[] | null;
      try {
        queued = await outbox.listWithUncommitted();
      } catch {
        queued = null;
      }
      const idb = await db();
      const tx = idb.transaction(STORE, "readwrite");
      const rec = (await tx.store.get(key)) as DraftRecord | undefined;
      // Generation (review A3). A write-back is not new typing, so it never
      // takes the key from a set(): it uses the generation the map already
      // holds (a set() that started and is about to commit, or the record's
      // writer), else the record's own, else a fresh one. Read synchronously
      // right before the put, so the stored record and the map agree, and the
      // map is only filled when empty, never rewound. A set() still in flight
      // commits after this put with that same generation, carrying the
      // refused fields (withCarriedRefusal).
      const generation =
        latestGenerationByKey.get(key) ?? rec?.generation ?? nextGeneration();
      const next = rowDraftAfterRefusal(key, rec, op, queued, { now: Date.now(), generation });
      if (!next) {
        await tx.done;
        return;
      }
      // Marked dirty like set() so the unload guard sees it.
      pendingKeys.add(key);
      if (!latestGenerationByKey.has(key)) latestGenerationByKey.set(key, generation);
      await tx.store.put(next);
      await tx.done;
      void notify();
    },
    undefined,
  );
}
