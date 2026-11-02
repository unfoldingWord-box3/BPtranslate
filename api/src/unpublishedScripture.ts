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
// Per resource (ult, ust), the watermark is the newest export snapshot that
// master is known to hold:
//   - merged_at set (its PR merged; recorded here, asked of Door43 once), or
//   - error = 'unchanged' (the render equalled master, so master already held
//     everything up to that export).
// A verse edit_log entry newer than the watermark is unpublished. Every writer
// counts (AI and chat too); only 'dcs_reimport' entries are skipped, because
// those came FROM Door43. With no watermark at all, any entry counts.
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

const WATERMARK = `COALESCE(
    (SELECT MAX(committed_at) FROM export_snapshots
      WHERE book = ?1 AND resource = ?3
        AND (merged_at IS NOT NULL OR error = 'unchanged')),
    0)`;

const HAS_NEWER_EDITS = `SELECT EXISTS (
    SELECT 1 FROM edit_log e
     WHERE e.kind = 'verse' AND e.book = ?1 AND e.row_key LIKE ?2
       AND (e.source IS NULL OR e.source <> 'dcs_reimport')
       AND e.created_at > ${WATERMARK}
  ) AS pending`;

// PRs of committed exports newer than the watermark whose merge isn't known
// yet, newest first. A few is plenty: they are usually one PR, reused nightly.
const OPEN_PRS = `SELECT pr_number, MAX(committed_at) AS last_at FROM export_snapshots
    WHERE book = ?1 AND resource = ?3 AND commit_sha IS NOT NULL AND pr_number IS NOT NULL
      AND merged_at IS NULL AND committed_at > ${WATERMARK}
    GROUP BY pr_number ORDER BY last_at DESC LIMIT 3`;

// Every committed snapshot on that PR from before the merge is now in master.
const MARK_MERGED = `UPDATE export_snapshots SET merged_at = ?4
    WHERE book = ?1 AND resource = ?3 AND pr_number = ?2
      AND commit_sha IS NOT NULL AND merged_at IS NULL AND committed_at <= ?4`;

async function hasNewerEdits(db: D1Like, book: string, resource: ScriptureResource): Promise<boolean> {
  const row = await db
    .prepare(HAS_NEWER_EDITS)
    .bind(book, `${book}/%/${resource.toUpperCase()}`, resource)
    .first<{ pending: number }>();
  return Boolean(row?.pending);
}

async function statusFor(
  db: D1Like,
  book: string,
  resource: ScriptureResource,
  deps: ScriptureStatusDeps,
): Promise<ScriptureStatus> {
  if (!(await hasNewerEdits(db, book, resource))) return "current";
  if (!(await deps.exportEnabled(resource))) return "unpublishable";
  // ?2 is unused by OPEN_PRS but kept so the placeholders line up with WATERMARK.
  const prs = await db.prepare(OPEN_PRS).bind(book, null, resource).all<{ pr_number: number }>();
  let marked = false;
  for (const { pr_number } of prs.results ?? []) {
    const mergedAt = await deps.prMergedAt(resource, pr_number);
    if (mergedAt == null) continue;
    await db.prepare(MARK_MERGED).bind(book, pr_number, resource, mergedAt).run();
    marked = true;
  }
  if (marked && !(await hasNewerEdits(db, book, resource))) return "current";
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
