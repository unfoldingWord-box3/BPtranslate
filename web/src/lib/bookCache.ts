import type { ChapterPayload, TnRow, TqRow, TwlRow, VerseDto } from "../sync/api";
import { rowRebuildAction } from "../sync/outboxTargeting.ts";

// Pure pieces of useBook's per-chapter cache (#562), kept out of the hook so
// they can be unit-tested.

type RowKind = "tn" | "tq" | "twl";
type AnyRow = TnRow | TqRow | TwlRow;

/** One local change to a cached chapter. */
export type CacheOp =
  | { t: "verse"; verse: VerseDto }
  | { t: "patch"; kind: RowKind; id: string; patch: Partial<TnRow & TqRow & TwlRow>; onlyAtVersion?: number }
  | { t: "replace"; kind: RowKind; row: AnyRow }
  | { t: "insert"; kind: RowKind; row: AnyRow; afterId?: string }
  | { t: "delete"; kind: RowKind; id: string; onlyAtVersion?: number }
  // A row re-read after an op that never landed (#637 item 1): rowRebuildAction
  // decides, and a row put back goes to its place in the server's order.
  | { t: "rebuild"; kind: RowKind; row: AnyRow; mayInsert: boolean };

// The index at which `row` goes in a list kept in the chapter endpoint's order
// (verse, sort_order with NULL last, id). The rows around it are assumed to be
// in that order; where they are not, it goes before the first row after it.
export function serverOrderIndex(list: AnyRow[], row: AnyRow): number {
  const key = (r: AnyRow) => [r.verse, r.sort_order ?? Number.POSITIVE_INFINITY] as const;
  const [v, s] = key(row);
  const i = list.findIndex((r) => {
    const [rv, rs] = key(r);
    if (rv !== v) return rv > v;
    if (rs !== s) return rs > s;
    return r.id > row.id;
  });
  return i < 0 ? list.length : i;
}

/**
 * Whether a patch or delete given `onlyAtVersion` may touch `row`: always when
 * no version is given; otherwise only when the row is cached at exactly that
 * version. Checked inside the state updater, so it sees the cache as it is
 * after every earlier queued update (#637: a live update's follow-up must not
 * write over a row that changed while the outbox was being read).
 */
export function rowAtVersion(row: { version: number } | undefined, onlyAtVersion: number | undefined): boolean {
  if (onlyAtVersion === undefined) return true;
  return !!row && row.version === onlyAtVersion;
}

/** Apply one op; returns the same object when nothing changed. */
export function applyCacheOp(data: ChapterPayload, op: CacheOp): ChapterPayload {
  if (op.t === "verse") {
    const v = op.verse;
    const byVersion = data.verses[v.bible_version] ?? {};
    const cur = byVersion[v.verse];
    // Never roll a verse back to an older server version.
    if (cur && cur.version > v.version) return data;
    return { ...data, verses: { ...data.verses, [v.bible_version]: { ...byVersion, [v.verse]: v } } };
  }
  const list = data[op.kind] as AnyRow[];
  let next: AnyRow[];
  if (op.t === "patch") {
    const cur = list.find((r) => r.id === op.id);
    if (!cur || !rowAtVersion(cur, op.onlyAtVersion)) return data;
    next = list.map((r) => (r.id === op.id ? ({ ...r, ...op.patch } as AnyRow) : r));
  } else if (op.t === "replace") {
    const cur = list.find((r) => r.id === op.row.id);
    if (!cur || cur.version > op.row.version) return data;
    next = list.map((r) => (r.id === op.row.id ? op.row : r));
  } else if (op.t === "rebuild") {
    const action = rowRebuildAction(
      list.find((r) => r.id === op.row.id),
      op.row,
      op.mayInsert,
    );
    if (!action) return data;
    if (action.t === "replace") {
      next = list.map((r) => (r.id === op.row.id ? action.row : r));
    } else {
      const i = serverOrderIndex(list, action.row);
      next = [...list.slice(0, i), action.row, ...list.slice(i)];
    }
  } else if (op.t === "insert") {
    const cur = list.find((r) => r.id === op.row.id);
    if (cur) {
      // Already there (e.g. a broadcast recorded as an insert while the
      // chapter was loading, replayed onto a fetch that has the row): keep the
      // newer copy, by the same rule as a live broadcast.
      if (broadcastUpsertAction(op.kind, cur, op.row) !== "replace") return data;
      next = list.map((r) => (r.id === op.row.id ? op.row : r));
      return { ...data, [op.kind]: next } as ChapterPayload;
    }
    const idx = op.afterId ? list.findIndex((r) => r.id === op.afterId) : -1;
    next = idx >= 0 ? [...list.slice(0, idx + 1), op.row, ...list.slice(idx + 1)] : [...list, op.row];
  } else {
    const cur = list.find((r) => r.id === op.id);
    if (!cur || !rowAtVersion(cur, op.onlyAtVersion)) return data;
    next = list.filter((r) => r.id !== op.id);
  }
  return { ...data, [op.kind]: next } as ChapterPayload;
}

/**
 * Tracks which chapters are loaded and which have a fetch in flight. Local
 * edits made while a fetch is in flight are recorded and replayed onto the
 * response, so a reload never clobbers an optimistic patch that is newer than
 * the server read.
 */
export class ChapterFetchTracker {
  private ready = new Set<number>();
  private pending = new Map<number, { token: number; ops: CacheOp[] }>();
  private seq = 0;

  /** Start a first load. Null when the chapter is ready or already loading. */
  beginLoad(ch: number): number | null {
    if (this.ready.has(ch) || this.pending.has(ch)) return null;
    return this.start(ch);
  }

  /** Start a refetch; supersedes any fetch already running for the chapter. */
  beginReload(ch: number): number {
    return this.start(ch);
  }

  private start(ch: number): number {
    const token = ++this.seq;
    // A superseded fetch's recorded edits still post-date the server read the
    // new fetch may return, so carry them over.
    this.pending.set(ch, { token, ops: [...(this.pending.get(ch)?.ops ?? [])] });
    return token;
  }

  isCurrent(ch: number, token: number): boolean {
    return this.pending.get(ch)?.token === token;
  }

  /** Note a local edit; kept only while a fetch for that chapter is in flight. */
  record(ch: number, op: CacheOp): void {
    this.pending.get(ch)?.ops.push(op);
  }

  /** The payload to store, with in-flight local edits replayed; null if superseded. */
  land(ch: number, token: number, data: ChapterPayload): ChapterPayload | null {
    const p = this.pending.get(ch);
    if (!p || p.token !== token) return null;
    this.pending.delete(ch);
    this.ready.add(ch);
    return p.ops.reduce(applyCacheOp, data);
  }

  /** A fetch failed. True when it was the current one for the chapter. */
  fail(ch: number, token: number): boolean {
    if (!this.isCurrent(ch, token)) return false;
    this.pending.delete(ch);
    return true;
  }

  reset(): void {
    this.ready.clear();
    this.pending.clear();
  }
}

/**
 * How a `row.upserted` broadcast applies to a cached row: insert when absent,
 * replace when newer. Preserve / hint / trash toggles on tN rows don't bump
 * version (api/src/rows.ts setTnBit / setTnTrashed), so a same-version tN row
 * whose state differs also replaces.
 */
export function broadcastUpsertAction(
  kind: RowKind,
  existing: AnyRow | undefined,
  row: AnyRow,
): "insert" | "replace" | "skip" {
  if (!existing) return "insert";
  if (row.version > existing.version) return "replace";
  if (
    kind === "tn" &&
    row.version === existing.version &&
    ((row as TnRow).preserve !== (existing as TnRow).preserve ||
      (row as TnRow).hint !== (existing as TnRow).hint ||
      (row as TnRow).trashed_at !== (existing as TnRow).trashed_at)
  ) {
    return "replace";
  }
  return "skip";
}
