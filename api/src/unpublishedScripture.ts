// Does this book have Bible text in D1 that Door43 has not received yet (#679)?
//
// AI translate runs read the workspace's literal/simplified Bible from Door43
// master (translateOptions.ts: `${cfg.org}/${cfg.repos.lit}@master`), but edits
// live in D1 until the nightly export publishes them. So a run started after
// an edit translates against the older published text. Option C on #679 is to
// warn when that is the case; this is the signal.
//
// "Unpublished" = an edit_log entry for one of the book's ULT/UST verses newer
// than that resource's last successful export (commit_sha IS NOT NULL), or any
// such entry when the resource has never exported. That is the same watermark
// the export uses to name an export's contributors
// (ExportWorkflow.contributorsFor). Unlike that query it counts every writer,
// AI and chat included, since an AI-written verse is just as unpublished; only
// 'dcs_reimport' entries are skipped, because those came FROM Door43.

type D1Like = {
  prepare(sql: string): {
    bind(...args: unknown[]): { first<T = unknown>(): Promise<T | null> };
  };
};

export type UnpublishedScripture = { ult: boolean; ust: boolean };

const SQL = `SELECT EXISTS (
    SELECT 1 FROM edit_log e
     WHERE e.kind = 'verse' AND e.book = ?1 AND e.row_key LIKE ?2
       AND (e.source IS NULL OR e.source <> 'dcs_reimport')
       AND e.created_at > COALESCE(
         (SELECT MAX(committed_at) FROM export_snapshots
           WHERE book = ?1 AND resource = ?3 AND commit_sha IS NOT NULL),
         0)
  ) AS pending`;

export async function unpublishedScripture(db: D1Like, book: string): Promise<UnpublishedScripture> {
  const check = async (resource: "ult" | "ust") => {
    const row = await db
      .prepare(SQL)
      .bind(book, `${book}/%/${resource.toUpperCase()}`, resource)
      .first<{ pending: number }>();
    return Boolean(row?.pending);
  };
  const [ult, ust] = await Promise.all([check("ult"), check("ust")]);
  return { ult, ust };
}
