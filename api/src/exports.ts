// Admin endpoints for the nightly export.
//   POST /api/exports/run         — kick off an export instance now (auth required)
//   GET  /api/exports             — list recent snapshot rows
//   GET  /api/exports/instance/:id — read a Workflow instance's status by id

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAdmin } from "./auth";
import { ALL_RESOURCES, resourceTargetsFor, type Resource } from "./export";
import { getProjectConfig, exportOwnerFor } from "./projectConfig.ts";
import { getLaneState, activeLaneConfig, type LaneKey } from "./scriptureLane";
import { snapshotPrUrl, type PrDestinationMap } from "./exportPrUrl.ts";
import type { ChapterRange } from "./exportChapterMerge.ts";
import { workflowRunId } from "./contextExportQueue.ts";

export const exports = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const RunBody = z.object({
  book: z.string().min(1).max(8).optional(),
  resource: z.enum(["tn", "tq", "twl", "ult", "ust"]).optional(),
  dryDcs: z.boolean().optional(),
  // Opt-in to the post-export validate-and-merge orchestrator. Defaults
  // unset (= false) so a manual single-book test export doesn't trigger
  // the real auto-merge workflow on DCS. The 06:00 UTC cron passes true.
  validateAndMerge: z.boolean().optional(),
  // First-class ExportWorkflow mode: skip verse+article phases; export only
  // the translation-context pack (same durable bindings / retries / admin auth).
  contextOnly: z.boolean().optional(),
  // Admin override for the context-pack semantic shrink guard.
  shrinkOverride: z.boolean().optional(),
  // Chapter-scoped export ("MRK 13-14 tn", "JAS 1 tq"): restrict the render to
  // this inclusive chapter range and MERGE it into master's whole-book file
  // instead of replacing the whole file. tn/tq/twl only — see validation
  // below. chapterEnd defaults to chapterStart (a single-chapter run).
  chapterStart: z.number().int().min(1).max(200).optional(),
  chapterEnd: z.number().int().min(1).max(200).optional(),
  // Door43 write mode for a chapter-scoped run. "merge" (default): today's
  // behaviour — the pre-export DCS→D1 sync runs first, then the range render
  // is merged into the base file. "overwrite": skip the pre-export sync for
  // this run AND bypass the freshness gate for this (book, resource), so the
  // editor's rows for the range replace whatever Door43 holds for those
  // chapters — including hand edits made on Door43 since the last sync. Rows
  // outside the range still come from the base file via the merge, unchanged.
  // Requires a chapter scope — see the cross-field check below.
  mode: z.enum(["merge", "overwrite"]).optional(),
});

exports.post("/run", requireAdmin, async (c) => {
  // Read the body unconditionally — gating on content-length silently dropped
  // chunked bodies, turning an intended single-book dry run into a full
  // export. Empty body still means "run everything"; non-empty garbage 400s.
  let body: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
  }
  const parsed = RunBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.format() }, 400);
  }

  // Chapter-scoped export validation. Kept out of the zod schema (cross-field
  // rules) — see the module doc comment on RunBody.chapterStart/chapterEnd.
  let chapters: ChapterRange | undefined;
  if (parsed.data.chapterStart != null) {
    if (!parsed.data.book || !parsed.data.resource) {
      return c.json({ error: "chapter_scope_requires_book_and_resource" }, 400);
    }
    if (parsed.data.resource === "ult" || parsed.data.resource === "ust") {
      return c.json({ error: "chapter_scope_unsupported_resource" }, 400);
    }
    const chapterEnd = parsed.data.chapterEnd ?? parsed.data.chapterStart;
    if (chapterEnd < parsed.data.chapterStart) {
      return c.json({ error: "invalid_chapter_range" }, 400);
    }
    chapters = { start: parsed.data.chapterStart, end: chapterEnd };
  } else if (parsed.data.chapterEnd != null) {
    return c.json({ error: "invalid_chapter_range" }, 400);
  }
  if (parsed.data.mode === "overwrite" && !chapters) {
    return c.json({ error: "overwrite_requires_chapter_scope" }, 400);
  }

  const params = {
    book: parsed.data.book?.toUpperCase(),
    resource: parsed.data.resource as Resource | undefined,
    dryDcs: parsed.data.dryDcs,
    validateAndMerge: parsed.data.validateAndMerge,
    contextOnly: parsed.data.contextOnly,
    shrinkOverride: parsed.data.shrinkOverride,
    chapters,
    // Only ever true alongside `chapters` — enforced above.
    overwrite: parsed.data.mode === "overwrite",
    workspace: c.env.WORKSPACE_SLUG,
  };
  // Deterministic id (second precision) so a double-submitted manual run
  // rejects on the duplicate instead of racing the first. The nightly cron
  // uses `nightly-${slug}-${day}` ids — see scheduled() in index.ts. Context-
  // only runs use a distinct prefix so they don't collide with a full manual
  // run in the same second; a chapter-scoped run uses its own prefix so it
  // can't collide with a whole-book manual run started the same second; the
  // workspace slug in the prefix keeps a manual run in one org from colliding
  // with one in another in the same second.
  const id = workflowRunId(
    `${chapters ? "manual-ch-" : parsed.data.contextOnly ? "context-" : "manual-"}${c.env.WORKSPACE_SLUG ?? "default"}-`,
  );
  try {
    const instance = await c.env.EXPORT_WORKFLOW.create({ id, params });
    return c.json({ id: instance.id, status: "queued" }, 202);
  } catch (e) {
    return c.json(
      { error: "workflow_create_failed", details: e instanceof Error ? e.message : String(e) },
      409,
    );
  }
});

// Plain listing of the last N snapshot rows. Useful for an /admin/exports
// view and for verification after a manual run.
exports.get("/", requireAdmin, async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const bookFilter = c.req.query("book")?.toUpperCase();
  const stmt = bookFilter
    ? c.env.DB.prepare(
        `SELECT id, book, resource, branch, commit_sha, committed_at, rows_exported, error, pr_number, pr_error, chapters
           FROM export_snapshots WHERE book = ?1
           ORDER BY id DESC LIMIT ?2`,
      ).bind(bookFilter, limit)
    : c.env.DB.prepare(
        `SELECT id, book, resource, branch, commit_sha, committed_at, rows_exported, error, pr_number, pr_error, chapters
           FROM export_snapshots
           ORDER BY id DESC LIMIT ?1`,
      ).bind(limit);
  const rs = await stmt.all<{
    id: number;
    book: string;
    resource: string;
    branch: string | null;
    commit_sha: string | null;
    committed_at: number;
    rows_exported: number;
    error: string | null;
    pr_number: number | null;
    pr_error: string | null;
    // Chapter label ("13" or "13-14") for a chapter-scoped export snapshot;
    // null for a whole-book export.
    chapters: string | null;
  }>();
  // Enrich rows that carry a pr_number with a Door43 web URL (`prUrl`), by
  // resolving the destination repo through the SAME functions exportOne uses:
  // scripture lanes (ult/ust) → live lane config's export destination;
  // tn/tq/twl → project-config repo under exportOwnerFor. Best-effort: any
  // resolution failure just leaves prUrl off (client falls back to plain
  // "PR #n" text). See exportPrUrl.ts for the current-config caveat.
  let snapshots: Array<(typeof rs.results)[number] & { prUrl?: string | null }> = rs.results;
  if (rs.results.some((r) => r.pr_number != null)) {
    try {
      const cfg = await getProjectConfig(c.env);
      const targets = resourceTargetsFor(cfg);
      const owner = exportOwnerFor(c.env, cfg);
      const dest: PrDestinationMap = {
        tn: { owner, repo: targets.tn.repo },
        tq: { owner, repo: targets.tq.repo },
        twl: { owner, repo: targets.twl.repo },
      };
      const lanePairs: Array<[Resource, LaneKey]> = [["ult", "lit"], ["ust", "sim"]];
      for (const [resource, lane] of lanePairs) {
        if (!rs.results.some((r) => r.resource === resource && r.pr_number != null)) continue;
        const row = await getLaneState(c.env, lane);
        const exp = row ? activeLaneConfig(row).export : null;
        dest[resource] = exp ? { owner: exp.owner, repo: exp.repo } : null;
      }
      snapshots = rs.results.map((r) => ({
        ...r,
        prUrl: snapshotPrUrl(c.env.DCS_BASE_URL, dest[r.resource], r.pr_number),
      }));
    } catch (e) {
      console.error("exports list prUrl enrichment failed", e instanceof Error ? e.message : String(e));
    }
  }
  return c.json({ snapshots });
});

// Workflow instance status. The Workflow's own `status()` returns a structured
// payload that includes step-level state — useful for the admin UI later.
exports.get("/instance/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  try {
    const instance = await c.env.EXPORT_WORKFLOW.get(id);
    const status = await instance.status();
    return c.json({ id, status });
  } catch (e) {
    return c.json({ error: "not_found", details: e instanceof Error ? e.message : String(e) }, 404);
  }
});

// Convenience: list the available resources (for an admin UI dropdown).
exports.get("/resources", requireAdmin, async (c) => {
  return c.json({ resources: ALL_RESOURCES });
});
