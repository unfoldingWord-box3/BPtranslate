// Will an AI translate run see this book's newest Bible text (#679)?
//
// AI translate runs read the workspace's literal/simplified Bible from Door43
// master (translateOptions.ts: `${cfg.org}/${cfg.repos.lit}@master`), but edits
// live in D1. The nightly export commits them to a per-book `-be-` branch and
// opens a PR; Door43's own validate-and-merge workflow merges that PR into
// master later, outside this app. "Publish this book" only opens or updates
// the PR. So an edit reaches the AI only once a PR carrying it has MERGED.
// Option C on #679 is to warn when that has not happened yet; this is the
// signal.
//
// Per resource (ult, ust), the baseline is the newest export snapshot that
// master is known to hold:
//   - merged_at set (its PR merged; recorded here, asked of Door43 once), or
//   - error = 'unchanged' (the render equalled master, so master already held
//     everything that export read).
// Something newer than the baseline is unpublished. Two signals, either one
// is enough:
//   1. edit_log: a verse entry with an id above the baseline's
//      edit_log_watermark (MAX(edit_log.id) read before that export rendered).
//      An id, not a time: committed_at is stamped after the render and the
//      Door43 round trips, so an edit saved in between predates committed_at
//      yet is missing from the export. Snapshots from before the watermark
//      column fall back to created_at > committed_at. Every writer counts (AI
//      and chat too); 'dcs_reimport' entries are skipped, since they came FROM
//      Door43.
//   2. verses: a row whose last content write was a person or the AI pipeline
//      (updated_by NOT NULL; an import or a reimport from Door43 clears it)
//      written after the baseline's committed_at. This one survives the
//      edit_log retention sweep (index.ts deletes entries older than 180
//      days), so an old edit in a lane whose export is off stays flagged for
//      good. On its own it would miss the race above, which is what 1 is for.
// With no baseline at all, any such entry or verse counts.
//
// Result per resource:
//   "current"       nothing newer than master
//   "pending"       newer edits; the nightly publish will merge them
//   "unpublishable" newer edits, but this lane's export is switched off, so no
//                   publish will ever bring them to Door43

type Stmt = {
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};
type D1Like = { prepare(sql: string): { bind(...args: unknown[]): Stmt } };

export type ScriptureResource = "ult" | "ust";
export type ScriptureStatus = "current" | "pending" | "unpublishable";

export type ScriptureStatusDeps = {
  /** Whether this resource's export is switched on (a lane with export: null is off). */
  exportEnabled(resource: ScriptureResource): Promise<boolean>;
  /**
   * Unix seconds at which this export PR merged on Door43, or null when it has
   * not merged or the lookup failed (best effort: a failure keeps the warning).
   */
  prMergedAt(resource: ScriptureResource, prNumber: number): Promise<number | null>;
};

// The newest snapshot master holds (see above); none → nothing published yet.
const BASELINE = `SELECT committed_at, edit_log_watermark FROM export_snapshots
    WHERE book = ?1 AND resource = ?2
      AND (merged_at IS NOT NULL OR error = 'unchanged')
    ORDER BY committed_at DESC, id DESC LIMIT 1`;

// ?1 book, ?2 row_key pattern, ?3 BIBLE VERSION, ?4 baseline watermark (NULL
// on an old snapshot or with no baseline), ?5 baseline committed_at (0 when
// there is none).
const HAS_NEWER = `SELECT
    EXISTS (
      SELECT 1 FROM edit_log e
       WHERE e.kind = 'verse' AND e.book = ?1 AND e.row_key LIKE ?2
         AND (e.source IS NULL OR e.source <> 'dcs_reimport')
         AND (CASE WHEN ?4 IS NOT NULL THEN e.id > ?4 ELSE e.created_at > ?5 END)
    )
    OR EXISTS (
      SELECT 1 FROM verses v
       WHERE v.book = ?1 AND v.bible_version = ?3
         AND v.updated_by IS NOT NULL AND v.updated_at > ?5
    ) AS pending`;

// PRs of committed exports newer than the baseline whose merge isn't known
// yet, newest first. A few is plenty: they are usually one PR, reused nightly.
const OPEN_PRS = `SELECT pr_number, MAX(committed_at) AS last_at FROM export_snapshots
    WHERE book = ?1 AND resource = ?2 AND commit_sha IS NOT NULL AND pr_number IS NOT NULL
      AND merged_at IS NULL AND committed_at > ?3
    GROUP BY pr_number ORDER BY last_at DESC LIMIT 3`;

// Every committed snapshot on that PR from before the merge is now in master.
const MARK_MERGED = `UPDATE export_snapshots SET merged_at = ?4
    WHERE book = ?1 AND resource = ?3 AND pr_number = ?2
      AND commit_sha IS NOT NULL AND merged_at IS NULL AND committed_at <= ?4`;

type Baseline = { committedAt: number; watermark: number | null };

async function baseline(db: D1Like, book: string, resource: ScriptureResource): Promise<Baseline> {
  const row = await db
    .prepare(BASELINE)
    .bind(book, resource)
    .first<{ committed_at: number; edit_log_watermark: number | null }>();
  return row
    ? { committedAt: Number(row.committed_at), watermark: row.edit_log_watermark == null ? null : Number(row.edit_log_watermark) }
    : { committedAt: 0, watermark: null };
}

async function hasNewer(db: D1Like, book: string, resource: ScriptureResource, b: Baseline): Promise<boolean> {
  const bv = resource.toUpperCase();
  const row = await db
    .prepare(HAS_NEWER)
    .bind(book, `${book}/%/${bv}`, bv, b.watermark, b.committedAt)
    .first<{ pending: number }>();
  return Boolean(row?.pending);
}

async function statusFor(
  db: D1Like,
  book: string,
  resource: ScriptureResource,
  deps: ScriptureStatusDeps,
): Promise<ScriptureStatus> {
  let b = await baseline(db, book, resource);
  if (!(await hasNewer(db, book, resource, b))) return "current";
  if (!(await deps.exportEnabled(resource))) return "unpublishable";
  const prs = await db.prepare(OPEN_PRS).bind(book, resource, b.committedAt).all<{ pr_number: number }>();
  let marked = false;
  for (const { pr_number } of prs.results ?? []) {
    const mergedAt = await deps.prMergedAt(resource, pr_number);
    if (mergedAt == null) continue;
    await db.prepare(MARK_MERGED).bind(book, pr_number, resource, mergedAt).run();
    marked = true;
  }
  if (marked) {
    b = await baseline(db, book, resource);
    if (!(await hasNewer(db, book, resource, b))) return "current";
  }
  return "pending";
}

export async function scriptureStatus(
  db: D1Like,
  book: string,
  deps: ScriptureStatusDeps,
): Promise<Record<ScriptureResource, ScriptureStatus>> {
  const [ult, ust] = await Promise.all([
    statusFor(db, book, "ult", deps),
    statusFor(db, book, "ust", deps),
  ]);
  return { ult, ust };
}
