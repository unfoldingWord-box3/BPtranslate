// D1 helpers for context_export_results — the single "latest successful
// completion" predicate shared by assisted contextRef injection and the UI.

import type { Env } from "./index";
import type {
  ContextExportStatus,
  ContextPackStats,
  SuccessfulContextExport,
} from "./contextExportLib.ts";

export type ContextExportRow = {
  id: number;
  instance_id: string;
  status: ContextExportStatus;
  completed_at: number | null;
  commit_sha: string | null;
  parent_sha: string | null;
  owner: string;
  terms_count: number | null;
  examples_tn: number | null;
  examples_tq: number | null;
  templates_count: number | null;
  content_files: number | null;
  total_bytes: number | null;
  failure_reason: string | null;
  r2_key: string | null;
  created_at: number;
};

/** Latest successful completion — commit_sha + completed_at required. */
export async function getLatestSuccessfulContextExport(
  env: Env,
): Promise<SuccessfulContextExport | null> {
  const row = await env.DB.prepare(
    `SELECT commit_sha, completed_at, owner, terms_count, examples_tn, examples_tq,
            templates_count, content_files, total_bytes, guard_bytes
       FROM context_export_results
      WHERE status = 'success' AND commit_sha IS NOT NULL AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
  ).first<{
    commit_sha: string;
    completed_at: number;
    owner: string;
    terms_count: number | null;
    examples_tn: number | null;
    examples_tq: number | null;
    templates_count: number | null;
    content_files: number | null;
    total_bytes: number | null;
    guard_bytes: number | null;
  }>();
  if (!row?.commit_sha || row.completed_at == null) return null;
  return {
    sha: row.commit_sha,
    completedAt: row.completed_at,
    owner: row.owner,
    terms: row.terms_count ?? 0,
    examplesTn: row.examples_tn ?? 0,
    examplesTq: row.examples_tq ?? 0,
    templates: row.templates_count ?? 0,
    contentFiles: row.content_files ?? 0,
    totalBytes: row.total_bytes ?? 0,
    guardBytes: row.guard_bytes,
  };
}

export async function getLatestContextExportStats(env: Env): Promise<ContextPackStats | null> {
  const latest = await getLatestSuccessfulContextExport(env);
  if (!latest) return null;
  return {
    terms: latest.terms,
    examplesTn: latest.examplesTn,
    examplesTq: latest.examplesTq,
    templates: latest.templates,
    contentFiles: latest.contentFiles,
    totalBytes: latest.totalBytes,
    guardBytes: latest.guardBytes,
  };
}

export async function insertContextExportQueued(
  env: Env,
  opts: { instanceId: string; owner: string },
): Promise<number> {
  const rs = await env.DB.prepare(
    `INSERT INTO context_export_results (instance_id, status, owner)
     VALUES (?1, 'queued', ?2)
     RETURNING id`,
  )
    .bind(opts.instanceId, opts.owner)
    .first<{ id: number }>();
  if (!rs?.id) throw new Error("context_export_insert_failed");
  return rs.id;
}

export async function finalizeContextExport(
  env: Env,
  id: number,
  patch: {
    status: ContextExportStatus;
    commitSha?: string | null;
    parentSha?: string | null;
    stats?: ContextPackStats | null;
    failureReason?: string | null;
    r2Key?: string | null;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE context_export_results
        SET status = ?1,
            completed_at = ?2,
            commit_sha = ?3,
            parent_sha = ?4,
            terms_count = ?5,
            examples_tn = ?6,
            examples_tq = ?7,
            content_files = ?8,
            total_bytes = ?9,
            failure_reason = ?10,
            r2_key = COALESCE(?11, r2_key),
            templates_count = ?12,
            guard_bytes = ?14
      WHERE id = ?13`,
  )
    .bind(
      patch.status,
      now,
      patch.commitSha ?? null,
      patch.parentSha ?? null,
      patch.stats?.terms ?? null,
      patch.stats?.examplesTn ?? null,
      patch.stats?.examplesTq ?? null,
      patch.stats?.contentFiles ?? null,
      patch.stats?.totalBytes ?? null,
      patch.failureReason ?? null,
      patch.r2Key ?? null,
      patch.stats?.templates ?? null,
      id,
      patch.stats?.guardBytes ?? null,
    )
    .run();
}
