import type { ChapterPayload, TnRow, TqRow, TwlRow, VerseDto } from "../sync/api";

// Pure pieces of useBook's per-chapter cache (#562), kept out of the hook so
// they can be unit-tested.

type RowKind = "tn" | "tq" | "twl";
type AnyRow = TnRow | TqRow | TwlRow;

/** One local change to a cached chapter. */
export type CacheOp =
  | { t: "verse"; verse: VerseDto }
  | { t: "patch"; kind: RowKind; id: string; patch: Partial<TnRow & TqRow & TwlRow> }
  | { t: "replace"; kind: RowKind; row: AnyRow }
  | { t: "insert"; kind: RowKind; row: AnyRow; afterId?: string }
  | { t: "delete"; kind: RowKind; id: string };

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
    if (!list.some((r) => r.id === op.id)) return data;
    next = list.map((r) => (r.id === op.id ? ({ ...r, ...op.patch } as AnyRow) : r));
  } else if (op.t === "replace") {
    const cur = list.find((r) => r.id === op.row.id);
    if (!cur || cur.version > op.row.version) return data;
    next = list.map((r) => (r.id === op.row.id ? op.row : r));
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
    if (!list.some((r) => r.id === op.id)) return data;
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
