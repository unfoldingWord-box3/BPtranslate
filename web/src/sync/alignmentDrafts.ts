// Crash-safe persistence of in-progress ALIGNMENT work.
//
// Verse TEXT edits are stashed to `bible-editor-drafts` (drafts.ts) on every
// keystroke, so they survive a tab close or browser crash. Alignment DRAGS
// had no such tier — they lived only in AlignmentPanel's React state until an
// explicit Save enqueued them, so a crash/reload before saving lost them with
// no trace (see the JER 32 loss; memory `project_verse_edit_loss_unload_no_guard`).
//
// This is that missing tier: a dedicated IndexedDB store the AlignmentPanel
// writes to on each drag (debounced) and reads back when the aligner reopens.
// It is DELIBERATELY separate from the shared `drafts` store — that store's
// subscribers (UnsavedToasts, SyncStatusBar, ScriptureColumn/DocColumn/BookView
// hydration) expect `{ plainText }` verse drafts and an alignment payload there
// would collide with them. Writes come only from AlignmentPanel; reads only on
// aligner mount. Nothing here ever produces a PATCH — the outbox is untouched.

import { openDB, type IDBPDatabase } from "idb";
import { isReadOnly } from "./api";
import { onOutboxResult } from "./outbox";
import { workspaceDbName } from "./workspace";

// Base name; the actual per-workspace DB name is derived via workspaceDbName()
// so alignment drafts written in one Door43 org never surface in another
// (issue #228). The fallback workspace keeps this unsuffixed name — same rule
// as the outbox and the text-drafts store.
const DB_NAME = "bible-editor-alignment-drafts";
const DB_VERSION = 2;
const STORE = "drafts";

export interface AlignmentDraftRecord {
  key: string;
  // The serialized alignment tree, shaped exactly like a verse's stored
  // content (`{ verseObjects }`) so hydration re-parses it through the same
  // parseAlignment path a fresh load uses.
  content: unknown;
  // The verse version this draft branched from. On hydration we only restore
  // when this still matches the current base version — otherwise the base
  // changed under the draft (a save from another tab, a reimport) and the
  // draft is stale and must be discarded, not applied over newer content.
  expectedVersion: number;
  // Generation the draft was captured against. When set, restore only if it
  // still matches the verse's source_generation (replacement may reuse version=1).
  sourceGeneration?: number;
  // When set (lane freeze), never restore via the normal aligner path — recovery
  // lives in the shared drafts store as a quarantined record instead.
  quarantined?: string;
  updatedAt: number;
}

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

// Same key shape the outbox uses for a verse target, so the onOutboxResult
// listener below can clear the matching draft off a landed save.
export function alignmentDraftKey(
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): string {
  return `${book}:${chapter}:${verse}:${bibleVersion}`;
}

export type AlignmentDraftOpts = {
  sourceGeneration?: number;
  quarantined?: string;
};

export const alignmentDrafts = {
  async set(
    key: string,
    content: unknown,
    expectedVersion: number,
    opts?: AlignmentDraftOpts,
  ): Promise<void> {
    if (isReadOnly()) return;
    const rec: AlignmentDraftRecord = {
      key,
      content,
      expectedVersion,
      sourceGeneration: opts?.sourceGeneration,
      quarantined: opts?.quarantined,
      updatedAt: Date.now(),
    };
    await (await db()).put(STORE, rec);
  },

  async get(key: string): Promise<AlignmentDraftRecord | undefined> {
    return (await (await db()).get(STORE, key)) as AlignmentDraftRecord | undefined;
  },

  async clear(key: string): Promise<void> {
    await (await db()).delete(STORE, key);
  },

  // Mirrors drafts.ts's shape; `updatedAt` + `list` are the seam a future
  // "you have unsaved alignment from an earlier session" recovery surface would
  // hang on (the way UnsavedToasts/SyncStatusBar consume drafts.ts). No caller
  // yet — kept intentionally, not accidental cruft.
  async list(): Promise<AlignmentDraftRecord[]> {
    return (await (await db()).getAll(STORE)) as AlignmentDraftRecord[];
  },
};

// Belt-and-suspenders: when the verse's PATCH lands (200), the alignment the
// draft was protecting is now durable server-side, so drop it. AlignmentPanel
// also clears optimistically in its save-commit closure; both are idempotent.
// Skip clear when the op was quarantined — a late 200 after lane freeze must
// not wipe the crash-draft the freeze handler preserved.
onOutboxResult((op, result) => {
  if (result.kind !== "ok") return;
  if (op.quarantined) return;
  if (op.target.kind === "verse") {
    void alignmentDrafts.clear(
      alignmentDraftKey(op.target.book, op.target.chapter, op.target.verse, op.target.bibleVersion),
    );
  }
});
