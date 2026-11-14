// Note kinds marked Not needed (issue #158 part A): on the suggestion inbox
// page, the tN note kinds (tn_rows.support_reference) editors keep marking
// Not needed, so an admin can see which kinds might not matter for this
// language. It only informs; nothing is switched off (that is #924).
//
// The routes live in suggestionInbox.ts, registered before GET /:book:
//   GET  /api/suggestion-inbox/not-needed-kinds          the list (admin only)
//   POST /api/suggestion-inbox/not-needed-kinds/dismiss  {kind} → never listed again
//
// The rules, exactly (the help and the page say them in plain words):
//
//   marked   "Not needed" is trash: setTnTrashed (api/src/rows.ts) sets
//            trashed_at and logs an edit_log 'trash' entry; Restore logs
//            'untrash'. A row counts when its latest trash/untrash entry in
//            the last NOT_NEEDED_WINDOW_DAYS days (by edit_log id, since
//            created_at is in whole seconds) is 'trash', and the row is
//            either still trashed (trashed_at set, not deleted) or was
//            finalized by the nightly export (deleted_at set, trashed_at
//            cleared, and a 'delete' entry with source 'nightly_finalize'
//            after that trash entry, api/src/index.ts). A row deleted any
//            other way does not count. Each row counts once.
//   kind     shortSupport(support_reference): the bare tA id, so a full
//            rc:// link and a bare id are one kind. Empty kinds are skipped.
//   chapters distinct (book, chapter) pairs, since the list spans all books.
//   shown    notes ≥ minNotes in ≥ minChapters chapters (the suggestion
//            inbox's MIN_HITS / MIN_CHAPTERS), and not dismissed (0089).
//   order    most notes first, then by kind.

import type { Env } from "./index";
import { BOOK_NUMBERS } from "./dcsSources.ts";
import { shortSupport } from "./packageRefs.ts";

export const NOT_NEEDED_WINDOW_DAYS = 30;

export interface NotNeededKind {
  /** The bare tA id, e.g. "figs-yousingular". */
  kind: string;
  notes: number;
  /** Distinct (book, chapter) pairs. */
  chapters: number;
  /** Book codes, in canon order. */
  books: string[];
}

export interface NotNeededKindsResponse {
  windowDays: number;
  minNotes: number;
  minChapters: number;
  kinds: NotNeededKind[];
  /** The server has not had migration 0089 yet: Dismiss is unavailable. */
  notMigrated: boolean;
}

type Db = Env["DB"];

export const MARKED_ROWS_SQL = `
  WITH marks AS (
    SELECT e.id, e.book, e.row_key, e.action,
           ROW_NUMBER() OVER (PARTITION BY e.book, e.row_key ORDER BY e.id DESC) AS rn
      FROM edit_log e
     -- "+e.kind": keeps SQLite off edit_log_row_by_book (every tN edit ever) so it reads edit_log_recent by created_at.
     WHERE +e.kind = 'tn' AND e.action IN ('trash', 'untrash') AND e.created_at >= ?1
  )
  SELECT t.book, t.chapter, t.support_reference
    FROM marks m
    JOIN tn_rows t ON t.book = m.book AND t.id = m.row_key
   WHERE m.rn = 1 AND m.action = 'trash'
     AND t.support_reference IS NOT NULL AND TRIM(t.support_reference) <> ''
     AND ((t.trashed_at IS NOT NULL AND t.deleted_at IS NULL)
          OR (t.deleted_at IS NOT NULL AND t.trashed_at IS NULL AND EXISTS (
                SELECT 1 FROM edit_log f
                 WHERE f.kind = 'tn' AND f.book = t.book AND f.row_key = t.id
                   AND f.action = 'delete' AND f.source = 'nightly_finalize' AND f.id > m.id)))`;

const tableMissing = (err: unknown) =>
  err instanceof Error && /no such table:\s*not_needed_kind_dismissals/i.test(err.message);

async function dismissedKinds(db: Db): Promise<{ kinds: Set<string>; missing: boolean }> {
  try {
    const rs = await db.prepare(`SELECT support_reference FROM not_needed_kind_dismissals`).all<{ support_reference: string }>();
    return { kinds: new Set((rs.results ?? []).map((r) => r.support_reference)), missing: false };
  } catch (err) {
    if (tableMissing(err)) return { kinds: new Set(), missing: true };
    throw err;
  }
}

export async function computeNotNeededKinds(
  db: Db,
  opts: { minNotes: number; minChapters: number; now?: number },
): Promise<NotNeededKindsResponse> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const since = now - NOT_NEEDED_WINDOW_DAYS * 86_400;
  const [rows, dismissed] = await Promise.all([
    db.prepare(MARKED_ROWS_SQL).bind(since).all<{ book: string; chapter: number; support_reference: string }>(),
    dismissedKinds(db),
  ]);
  const groups = new Map<string, { notes: number; chapters: Set<string>; books: Set<string> }>();
  for (const r of rows.results ?? []) {
    const kind = shortSupport(r.support_reference);
    if (!kind) continue;
    let g = groups.get(kind);
    if (!g) groups.set(kind, (g = { notes: 0, chapters: new Set(), books: new Set() }));
    g.notes += 1;
    g.chapters.add(`${r.book}:${r.chapter}`);
    g.books.add(r.book);
  }
  const canon = (b: string) => BOOK_NUMBERS[b] ?? "99";
  const kinds: NotNeededKind[] = [...groups]
    .filter(([kind, g]) => g.notes >= opts.minNotes && g.chapters.size >= opts.minChapters && !dismissed.kinds.has(kind))
    .map(([kind, g]) => ({
      kind,
      notes: g.notes,
      chapters: g.chapters.size,
      books: [...g.books].sort((a, b) => canon(a).localeCompare(canon(b)) || a.localeCompare(b)),
    }))
    .sort((a, b) => b.notes - a.notes || a.kind.localeCompare(b.kind));
  return {
    windowDays: NOT_NEEDED_WINDOW_DAYS,
    minNotes: opts.minNotes,
    minChapters: opts.minChapters,
    kinds,
    notMigrated: dismissed.missing,
  };
}

/** Store a dismissal. Throws "not_migrated" when migration 0089 is missing. */
export async function dismissNotNeededKind(db: Db, kind: string, userId: number | null): Promise<void> {
  try {
    await db
      .prepare(`INSERT OR IGNORE INTO not_needed_kind_dismissals (support_reference, dismissed_by) VALUES (?1, ?2)`)
      .bind(kind, userId)
      .run();
  } catch (err) {
    if (tableMissing(err)) throw new Error("not_migrated");
    throw err;
  }
}
