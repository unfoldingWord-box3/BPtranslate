// tW / tA markdown-article translation routes (article_units, migration 0039).
// Articles are keyed by (resource, path) — NOT (book, id) — so they get their
// own route module rather than the generic /rows handler. The PATCH mirrors the
// rows.ts version-CAS/If-Match/409 mechanics; validate mirrors setTqTranslation-
// State. See docs/design/tw-ta-translation-modules.md.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { ArticleUnit } from "./types";
import { currentUserId, requireEditor } from "./auth.ts";
import {
  populateReferencedArticles,
  populateSingleArticle,
  refreshFromSource,
} from "./articlePopulate.ts";

export const articles = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

const RESOURCES = new Set(["tw", "ta"]);
const isResource = (r: string): r is "tw" | "ta" => RESOURCES.has(r);

// latest_source subquery (mirrors chapters.ts): the article's most recent
// edit_log source — 'ai_pipeline' drives the AI chip, NULL after a human edit.
const LATEST_SOURCE_SQL = `(
  SELECT source FROM edit_log
   WHERE kind = a.resource AND row_key = a.path
   ORDER BY id DESC LIMIT 1
) AS latest_source`;

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^"?(\d+)"?$/.exec(header.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// GET /api/articles/:resource — list unit metadata for the rail (source_md and
// target_md excluded for weight; grouped/sorted by article_id then part).
articles.get("/:resource", requireEditor, async (c) => {
  const resource = c.req.param("resource");
  if (!isResource(resource)) return c.json({ error: "unknown_resource" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT a.resource, a.path, a.article_id, a.part, a.source_sha,
            a.translation_state, a.version, a.updated_at,
            (a.target_md IS NOT NULL) AS has_target, ${LATEST_SOURCE_SQL}
       FROM article_units a
      WHERE a.resource = ?1 AND a.deleted_at IS NULL
      ORDER BY a.article_id, a.part`,
  )
    .bind(resource)
    .all();
  return c.json({ resource, units: rows.results ?? [] });
});

// GET /api/articles/:resource/unit?path=... — full unit (source_md + target_md).
articles.get("/:resource/unit", requireEditor, async (c) => {
  const resource = c.req.param("resource");
  const path = c.req.query("path");
  if (!isResource(resource)) return c.json({ error: "unknown_resource" }, 400);
  if (!path) return c.json({ error: "path_required" }, 400);
  const unit = await c.env.DB.prepare(
    `SELECT a.*, ${LATEST_SOURCE_SQL} FROM article_units a
      WHERE a.resource = ?1 AND a.path = ?2 AND a.deleted_at IS NULL`,
  )
    .bind(resource, path)
    .first<ArticleUnit>();
  if (!unit) return c.json({ error: "not_found" }, 404);
  return c.json(unit);
});

const PatchBody = z.object({ target_md: z.string() });

// PATCH /api/articles/:resource/unit?path=... — update the translation. Requires
// If-Match (bare int version); CAS inside the UPDATE; a human edit demotes an AI
// draft (or a validated unit) to 'edited'. 409 on version mismatch, 404 if gone.
articles.patch("/:resource/unit", requireEditor, async (c) => {
  const resource = c.req.param("resource");
  const path = c.req.query("path");
  if (!isResource(resource)) return c.json({ error: "unknown_resource" }, 400);
  if (!path) return c.json({ error: "path_required" }, 400);
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE article_units
            SET target_md = ?1,
                translation_state = CASE
                  -- A first human edit of a POPULATED-but-untranslated article
                  -- (source imported, translation_state still NULL) becomes
                  -- 'edited' so it can subsequently be approved (validate guards
                  -- on translation_state IS NOT NULL). Clearing the target back
                  -- to empty leaves NULL untouched (never translated).
                  WHEN translation_state IS NULL AND ?1 <> '' THEN 'edited'
                  WHEN translation_state IN ('ai_draft','validated') THEN 'edited'
                  ELSE translation_state END,
                version = version + 1,
                updated_at = ?2,
                updated_by = ?3
          WHERE resource = ?4 AND path = ?5 AND deleted_at IS NULL AND version = ?6`,
      )
      .bind(parsed.data.target_md, now, userId ?? null, resource, path, expected),
    c.env.DB
      .prepare(
        // Audit gated on the CAS having won (changes() in the same batch).
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         SELECT ?1, ?2, NULL, ?3, ?4, ?4 + 1, 'update', NULL
          WHERE (SELECT changes()) > 0`,
      )
      .bind(resource, path, userId ?? null, expected),
  ]);

  if (!updateRes.meta.changes) {
    // Distinguish 404 (gone) from 409 (version moved on).
    const cur = await c.env.DB.prepare(
      `SELECT version FROM article_units WHERE resource = ?1 AND path = ?2 AND deleted_at IS NULL`,
    )
      .bind(resource, path)
      .first<{ version: number }>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const fresh = await c.env.DB.prepare(
      `SELECT a.*, ${LATEST_SOURCE_SQL} FROM article_units a
        WHERE a.resource = ?1 AND a.path = ?2`,
    )
      .bind(resource, path)
      .first<ArticleUnit>();
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  const updated = await c.env.DB.prepare(
    `SELECT a.*, ${LATEST_SOURCE_SQL} FROM article_units a
      WHERE a.resource = ?1 AND a.path = ?2`,
  )
    .bind(resource, path)
    .first<ArticleUnit>();
  return c.json(updated);
});

const ValidateBody = z.object({ value: z.union([z.literal(0), z.literal(1), z.boolean()]) });

// POST /api/articles/:resource/unit/validate?path=... — the "Approve" action.
// value=1 → validated; value=0 → edited. Non-version-bumping; guarded on
// translation_state IS NOT NULL; audit source=NULL (human approval).
articles.post("/:resource/unit/validate", requireEditor, async (c) => {
  const resource = c.req.param("resource");
  const path = c.req.query("path");
  if (!isResource(resource)) return c.json({ error: "unknown_resource" }, 400);
  if (!path) return c.json({ error: "path_required" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = ValidateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const state = parsed.data.value === true || parsed.data.value === 1 ? "validated" : "edited";
  const action = state === "validated" ? "validate" : "unvalidate";
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  // Approval snapshots the now-published md into pre_draft_json (migration
  // 0049) — NOT NULL. A later human edit demotes 'validated' -> 'edited', and
  // the export gate then ships this snapshot until re-approval; clearing to
  // NULL would let the unvalidated edit reach DCS. Un-approve leaves it in
  // place (once-approved content keeps exporting — accepted).
  const snapshotClause = state === "validated"
    ? ", pre_draft_json = json_object('target_md', target_md)"
    : "";
  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE article_units SET translation_state = ?1, updated_at = ?2${snapshotClause}
          WHERE resource = ?3 AND path = ?4 AND deleted_at IS NULL AND translation_state IS NOT NULL`,
      )
      .bind(state, now, resource, path),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         SELECT ?1, ?2, NULL, ?3, version, version, ?4, NULL
           FROM article_units
          WHERE resource = ?1 AND path = ?2 AND deleted_at IS NULL AND translation_state IS NOT NULL`,
      )
      .bind(resource, path, userId ?? null, action),
  ]);
  if (!updateRes.meta.changes) return c.json({ error: "not_found" }, 404);
  const updated = await c.env.DB.prepare(
    `SELECT a.*, ${LATEST_SOURCE_SQL} FROM article_units a
      WHERE a.resource = ?1 AND a.path = ?2`,
  )
    .bind(resource, path)
    .first<ArticleUnit>();
  return c.json(updated);
});

// POST /api/articles/populate — populate tW/tA article sources from imported
// notes. Global by default (the workspace has no book context); `book` scopes
// it. `refresh: true` instead pulls upstream edits for current-identity rows,
// paging via `cursor` (a "resource:path" token the caller loops on).
const PopulateBody = z.object({
  book: z.string().optional(),
  retryFailed: z.boolean().optional(),
  refresh: z.boolean().optional(),
  cursor: z.string().optional(),
});

articles.post("/populate", requireEditor, async (c) => {
  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    /* empty body is fine — defaults apply */
  }
  const parsed = PopulateBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

  if (parsed.data.refresh) {
    let cursor: { resource: string; path: string } | null = null;
    if (parsed.data.cursor) {
      const idx = parsed.data.cursor.indexOf(":");
      if (idx > 0) {
        cursor = { resource: parsed.data.cursor.slice(0, idx), path: parsed.data.cursor.slice(idx + 1) };
      }
    }
    const res = await refreshFromSource(c.env, { cursor });
    return c.json({
      processed: res.processed,
      changed: res.changed,
      nextCursor: res.nextCursor ? `${res.nextCursor.resource}:${res.nextCursor.path}` : undefined,
      skipped: res.skipped,
      aborted: res.aborted,
    });
  }

  const res = await populateReferencedArticles(c.env, {
    book: parsed.data.book,
    retryFailed: parsed.data.retryFailed,
  });
  return c.json({
    processed: res.processed,
    remaining: res.remaining,
    warnings: res.warnings,
    skipped: res.skipped,
    aborted: res.aborted,
  });
});

// POST /api/articles/:resource/add — manually add a single article by id
// ("kt/grace" for tw, "translate/figs-aside" for ta). Restores a soft-deleted
// unit. 400 unparseable_id / not_translation_project; 404 source_not_found.
const AddBody = z.object({ id: z.string().min(1) });

articles.post("/:resource/add", requireEditor, async (c) => {
  const resource = c.req.param("resource");
  if (!isResource(resource)) return c.json({ error: "unknown_resource" }, 400);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = AddBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);

  const res = await populateSingleArticle(c.env, resource, parsed.data.id);
  if ("error" in res) {
    if (
      res.error === "not_translation_project" ||
      res.error === "no_source_configured" ||
      res.error === "unparseable_id"
    ) {
      return c.json({ error: res.error }, 400);
    }
    if (res.error === "source_not_found") return c.json({ error: res.error }, 404);
    return c.json({ error: res.error }, 409); // source_changed
  }
  return c.json(res);
});
