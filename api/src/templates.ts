// Note-template translation routes (template_units, migration 0053). Mirrors
// articles.ts's If-Match CAS / 428 / 409 / validate mechanics, applied to
// note templates instead of tW/tA markdown. GET /api/note-templates (the
// existing read-only English sheet proxy) is untouched — this is additive.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import type { TemplateUnit } from "./types";
import { currentUserId, editSource, requireEditor, requireAdmin } from "./auth.ts";
import { syncTemplates, ensureTemplatesPopulated } from "./templateSync.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { nextPreDraftJson } from "./preDraftSnapshot.ts";
import { getLatestSuccessfulContextExport } from "./contextExportResults.ts";
import { applyContextRef, derivedTargetLang } from "./assistedContextRef.ts";
import { queueContextExport } from "./contextExportQueue.ts";

export const templates = new Hono<{ Bindings: Env; Variables: { userId?: number } }>();

// Same audit-source label pipelineImport.ts uses for translate-pipeline
// applies (kept as a local literal — pipelineImport.ts doesn't export its
// copy, and the two producers are otherwise independent).
const AI_SOURCE = "ai_pipeline";

const DEFAULT_TEMPLATE_QUICK_URL = "https://uw-bt-bot.fly.dev/api/template-quick";
const TEMPLATE_DRAFT_MAX_BODY_BYTES = 64 * 1024;

function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^"?(\d+)"?$/.exec(header.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// GET /api/templates — list unit metadata for the rail (source_md/target_md
// excluded for weight). Ordered by support_ref then sheet_order.
templates.get("/", requireEditor, async (c) => {
  // First-run backstop (see ensureTemplatesPopulated) — dev workers register
  // no crons, so without this a fresh template_units table would sit empty
  // forever. A sync failure (Google Sheet down, etc.) must not turn this list
  // route into a 500 — log and fall through to the SELECT below as today.
  try {
    await ensureTemplatesPopulated(c.env);
  } catch (e) {
    console.error("ensureTemplatesPopulated failed", e instanceof Error ? e.message : String(e));
  }
  const includeDeleted = c.req.query("includeDeleted") === "1";
  const rows = await c.env.DB.prepare(
    `SELECT template_id, support_ref, type, sheet_order, origin,
            (target_md IS NOT NULL) AS has_target,
            translation_state, version,
            COALESCE(json_extract(draft_meta_json, '$.stale_source'), 0) AS stale_source
       FROM template_units
      WHERE (?1 = 1 OR deleted_at IS NULL)
      ORDER BY support_ref, sheet_order`,
  )
    .bind(includeDeleted ? 1 : 0)
    .all();
  return c.json({ units: rows.results ?? [] });
});

// GET /api/templates/unit?id=... — full unit (source_md + target_md).
templates.get("/unit", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const unit = await c.env.DB.prepare(
    `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<TemplateUnit>();
  if (!unit) return c.json({ error: "not_found" }, 404);
  return c.json(unit);
});

const PatchBody = z.object({ target_md: z.string() });

// PATCH /api/templates/unit?id=... — update the translation. Requires If-Match
// (bare int version); CAS inside the UPDATE; a human edit demotes an AI draft
// (or a validated unit) to 'edited' and clears the stale_source flag left by a
// source-change demotion. 409 on version mismatch, 404 if gone.
templates.patch("/unit", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
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
        `UPDATE template_units
            SET target_md = ?1,
                translation_state = CASE
                  WHEN translation_state IS NULL AND ?1 <> '' THEN 'edited'
                  WHEN translation_state IN ('ai_draft','validated') THEN 'edited'
                  ELSE translation_state END,
                draft_meta_json = CASE
                  WHEN draft_meta_json IS NOT NULL THEN json_remove(draft_meta_json, '$.stale_source')
                  ELSE draft_meta_json END,
                version = version + 1,
                updated_at = ?2,
                updated_by = ?3
          WHERE template_id = ?4 AND deleted_at IS NULL AND version = ?5`,
      )
      .bind(parsed.data.target_md, now, userId ?? null, id, expected),
    c.env.DB
      .prepare(
        // Audit gated on the CAS having won (changes() in the same batch).
        // payload_json carries the full patch so /unit/history can replay it.
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
         SELECT 'template', ?1, NULL, ?2, ?3, ?3 + 1, 'update', ?5, ?4
          WHERE (SELECT changes()) > 0`,
      )
      .bind(id, userId ?? null, expected, JSON.stringify({ target_md: parsed.data.target_md }), editSource(c)),
  ]);

  if (!updateRes.meta.changes) {
    // Distinguish 404 (gone) from 409 (version moved on).
    const cur = await c.env.DB.prepare(
      `SELECT version FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
    )
      .bind(id)
      .first<{ version: number }>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    const fresh = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
      .bind(id)
      .first<TemplateUnit>();
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  const updated = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
    .bind(id)
    .first<TemplateUnit>();
  return c.json(updated);
});

// POST /api/templates/unit/draft?id=... — "Draft with AI". Mirrors tnQuick.ts's
// dumb-proxy shape (auth gate, env check, forward, return) for the request/
// response leg, but — unlike tn-quick, which just hands its result back to the
// browser for the translator to review before any save — this endpoint also
// persists the result itself: templates have no separate "apply this AI draft"
// step, so the write happens here, in the same request, exactly like the
// translate-pipeline's applyTranslateArticle (api/src/pipelineImport.ts)
// stamps target_md + translation_state='ai_draft' + pre_draft_json for
// article_units. Reuses nextPreDraftJson so the last-published snapshot
// (export gate) is computed identically to every other AI-draft producer.
// If-Match CAS guards against clobbering a concurrent human edit — same
// mechanics as PATCH /unit above.
// #551: every AI call for an org must run on that org's own key. The bot's
// template-quick schema can't take one, so "Draft with AI" for templates is
// switched off until it can. The code below is kept for then; flip this to
// false once the call carries the org key.
const TEMPLATE_DRAFT_NEEDS_ORG_KEY: boolean = true;

templates.post("/unit/draft", requireEditor, async (c) => {
  if (TEMPLATE_DRAFT_NEEDS_ORG_KEY) {
    return c.json({ error: "ai_needs_org_key" }, 409);
  }
  if (!c.env.BT_API_TOKEN) {
    return c.json({ error: "template_draft_disabled" }, 503);
  }
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);

  const unit = await c.env.DB.prepare(
    `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<TemplateUnit>();
  if (!unit) return c.json({ error: "not_found" }, 404);
  if (unit.version !== expected) {
    return c.json({ error: "version_mismatch", current: unit }, 409);
  }
  // A validated (human-approved) translation must never be silently
  // overwritten by an AI draft — the frontend button already disables for
  // this case, but a stale tab or a direct API call could still reach here
  // with a correct If-Match version for the now-validated row.
  if (unit.translation_state === "validated") {
    return c.json({ error: "already_validated", current: unit }, 409);
  }

  const cfg = await getProjectConfig(c.env);
  // Fold in the pinned contextRef so the bot applies the org's curated
  // preferences (brief, terminology, instructions) — same mechanism as
  // tn-quick and the translate pipeline. No successful export → omit the key
  // entirely and the bot drafts unsteered, exactly like today.
  // A throw here (e.g. an unmigrated workspace DB missing
  // context_export_results / templates_count) must not 500 the whole draft —
  // degrade to unsteered drafting, matching the tn-quick proxy.
  let latest = null;
  try {
    latest = await getLatestSuccessfulContextExport(c.env);
  } catch (err) {
    console.warn("template-draft: context export lookup failed, drafting unsteered:", err);
  }
  const templateBody: Record<string, unknown> = {
    templateId: unit.template_id,
    supportRef: unit.support_ref,
    type: unit.type,
    sourceMd: unit.source_md,
    targetMd: unit.target_md,
    targetOrg: cfg.exportOrg,
    direction: cfg.direction,
  };
  // cfg.languageCode is unvalidated at the persist boundary (see
  // assistedContextRef.ts), so re-validate against the bot's targetLang
  // shape here too — omit + warn rather than send a value guaranteed to 400.
  const targetLang = derivedTargetLang(cfg.languageCode);
  if (targetLang) templateBody.targetLang = targetLang;
  const requestBody = JSON.stringify(applyContextRef(templateBody, latest));
  // .length is UTF-16 code units, not bytes — undercounts for non-ASCII
  // target languages (Arabic, etc.), so measure the actual UTF-8 byte size.
  if (new TextEncoder().encode(requestBody).length > TEMPLATE_DRAFT_MAX_BODY_BYTES) {
    return c.json({ error: "body_too_large", maxBytes: TEMPLATE_DRAFT_MAX_BODY_BYTES }, 413);
  }

  const url = c.env.TEMPLATE_QUICK_URL || DEFAULT_TEMPLATE_QUICK_URL;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.env.BT_API_TOKEN}`,
      },
      body: requestBody,
    });
  } catch {
    return c.json({ error: "model_call_failed" }, 502);
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    return c.json(
      { error: "model_call_failed", detail: text.slice(0, 300) },
      upstream.status === 429 ? 429 : 502,
    );
  }
  let upstreamJson: { target_md?: unknown; warnings?: unknown };
  try {
    upstreamJson = await upstream.json();
  } catch {
    return c.json({ error: "model_call_failed", detail: "invalid_upstream_json" }, 502);
  }
  if (typeof upstreamJson.target_md !== "string") {
    return c.json({ error: "model_call_failed", detail: "missing_target_md" }, 502);
  }
  const targetMd = upstreamJson.target_md;
  const warnings = Array.isArray(upstreamJson.warnings)
    ? upstreamJson.warnings.filter((w): w is string => typeof w === "string")
    : [];

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const newVersion = unit.version + 1;
  const draftMeta = warnings.length > 0 ? JSON.stringify({ warnings }) : null;
  const preDraftJson = nextPreDraftJson(unit.translation_state, unit.pre_draft_json ?? null, {
    target_md: unit.target_md,
  });

  const [updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE template_units
            SET target_md = ?1,
                translation_state = 'ai_draft',
                draft_meta_json = ?2,
                pre_draft_json = ?3,
                version = version + 1,
                updated_at = ?4,
                updated_by = ?5
          WHERE template_id = ?6 AND deleted_at IS NULL AND version = ?7
            AND (translation_state IS NULL OR translation_state != 'validated')`,
      )
      .bind(targetMd, draftMeta, preDraftJson, now, userId ?? null, id, expected),
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
         SELECT 'template', ?1, NULL, ?2, ?3, ?4, 'update', ?5, ?6
          WHERE (SELECT changes()) > 0`,
      )
      .bind(id, userId ?? null, expected, newVersion, AI_SOURCE, JSON.stringify({ target_md: targetMd, warnings })),
  ]);

  if (!updateRes.meta.changes) {
    const fresh = await c.env.DB.prepare(
      `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
    )
      .bind(id)
      .first<TemplateUnit>();
    if (!fresh) return c.json({ error: "not_found" }, 404);
    if (fresh.translation_state === "validated") {
      return c.json({ error: "already_validated", current: fresh }, 409);
    }
    return c.json({ error: "version_mismatch", current: fresh }, 409);
  }
  const updated = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
    .bind(id)
    .first<TemplateUnit>();
  return c.json(updated);
});

const ValidateBody = z.object({
  value: z.union([z.literal(0), z.literal(1), z.boolean()]),
  expected_state: z.enum(["ai_draft", "edited", "validated"]).optional(),
});

// POST /api/templates/unit/validate?id=... — the "Approve" action. value=1 ->
// validated; value=0 -> edited. Non-version-bumping; guarded on
// translation_state IS NOT NULL; audit source=NULL (human approval), 'chat' when
// a chat reviewer approved. Optional If-Match pins the version the caller saw;
// optional body expected_state pins the translation_state they saw. State flips
// never bump `version`, so the version alone misses an un-approve that landed
// after the reviewer saw the template (#708, the #701 gap for templates). The
// chat's bpt_approve_template sends both; the web app sends neither. A pinned
// miss is a 409 version_mismatch with current.
templates.post("/unit/validate", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);
  const ifMatch = c.req.header("if-match");
  const expected = parseIfMatch(ifMatch);
  if (ifMatch !== undefined && expected === null) return c.json({ error: "invalid_if_match" }, 400);
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
  // Approval snapshots the now-published md into pre_draft_json (mirrors
  // article_units / tn_rows) — a later human edit demotes 'validated' ->
  // 'edited', and export can ship this snapshot until re-approval.
  const snapshotClause = state === "validated"
    ? ", pre_draft_json = json_object('target_md', target_md)"
    : "";
  const source = editSource(c);
  const expectedState = parsed.data.expected_state ?? null;
  // The pin clauses numbered from ?first, with their values in the same order.
  // Each statement binds exactly the parameters it references (D1 rejects an
  // unreferenced ?N), so a clause and its value come and go together.
  const pins = (first: number) => {
    let n = first;
    let sql = "";
    const values: unknown[] = [];
    if (expected !== null) {
      sql += ` AND version = ?${n++}`;
      values.push(expected);
    }
    if (expectedState !== null) {
      sql += ` AND translation_state = ?${n++}`;
      values.push(expectedState);
    }
    return { sql, values };
  };
  const auditPins = pins(5);
  const updatePins = pins(4);
  // The audit INSERT runs FIRST: its WHERE must see the row before the UPDATE,
  // or a state pin (which the UPDATE itself changes) would never match and the
  // approval would land with no audit entry. A batch is one transaction.
  const [, updateRes] = await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
         SELECT 'template', ?1, NULL, ?2, version, version, ?3, ?4
           FROM template_units
          WHERE template_id = ?1 AND deleted_at IS NULL AND translation_state IS NOT NULL${auditPins.sql}`,
      )
      .bind(id, userId ?? null, action, source, ...auditPins.values),
    c.env.DB
      .prepare(
        `UPDATE template_units SET translation_state = ?1, updated_at = ?2${snapshotClause}
          WHERE template_id = ?3 AND deleted_at IS NULL AND translation_state IS NOT NULL${updatePins.sql}`,
      )
      .bind(state, now, id, ...updatePins.values),
  ]);
  if (!updateRes.meta.changes) {
    if (expected !== null || expectedState !== null) {
      const cur = await c.env.DB.prepare(
        `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
      )
        .bind(id)
        .first<TemplateUnit>();
      const moved =
        !!cur &&
        cur.translation_state !== null &&
        ((expected !== null && cur.version !== expected) ||
          (expectedState !== null && cur.translation_state !== expectedState));
      if (moved) return c.json({ error: "version_mismatch", current: cur }, 409);
    }
    return c.json({ error: "not_found" }, 404);
  }
  // Approving adds the template to the context pack AI drafts read; un-approving
  // takes it out. Queue the context export now rather than waiting for the
  // nightly run (#707). Never fails the approve: the helper swallows errors.
  queueContextExport(c);
  const updated = await c.env.DB.prepare(`SELECT * FROM template_units WHERE template_id = ?1`)
    .bind(id)
    .first<TemplateUnit>();
  return c.json(updated);
});

// GET /api/templates/unit/history?id=... — English source revisions
// (template_source_history, newest first) plus the target-side edit history
// replayed from edit_log, in the same response-shape family rows.ts:356
// already produces (so the existing word-diff history UI can render it).
templates.get("/unit/history", requireEditor, async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ error: "id_required" }, 400);

  const currentRow = await c.env.DB.prepare(
    `SELECT * FROM template_units WHERE template_id = ?1 AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<TemplateUnit>();
  if (!currentRow) return c.json({ error: "not_found" }, 404);

  const sourceRs = await c.env.DB.prepare(
    `SELECT source_hash, source_md, seen_at FROM template_source_history
      WHERE template_id = ?1 ORDER BY id DESC`,
  )
    .bind(id)
    .all<{ source_hash: string; source_md: string; seen_at: number }>();

  const logRs = await c.env.DB.prepare(
    `SELECT el.new_version AS version,
            el.action,
            el.created_at,
            el.payload_json,
            el.restored_from_version,
            u.id AS user_id,
            u.dcs_username AS username,
            u.dcs_full_name AS full_name
       FROM edit_log el
       LEFT JOIN users u ON u.id = el.user_id
      WHERE el.kind = 'template' AND el.row_key = ?1
        AND el.new_version IS NOT NULL
        AND el.action IN ('update', 'validate', 'unvalidate', 'restore')
      ORDER BY el.new_version ASC`,
  )
    .bind(id)
    .all<{
      version: number;
      action: string;
      created_at: number;
      payload_json: string | null;
      restored_from_version: number | null;
      user_id: number | null;
      username: string | null;
      full_name: string | null;
    }>();

  const logEntries = logRs.results ?? [];
  const hasBaselineAtV1 = logEntries.some((e) => e.version === 1);
  type Entry = (typeof logEntries)[number] & { synthetic?: boolean };
  // A template_units row is always born from the sheet sync with target_md
  // NULL and no edit_log 'create' entry, so the v1 baseline is ALWAYS
  // synthesized — and it must be the empty translation, not currentRow's
  // target_md. Seeding from the current row (as rows.ts does for imported tN
  // rows, which genuinely do have content at v1) would replay the newest text
  // as the oldest snapshot and make every diff wrong.
  const entries: Entry[] = hasBaselineAtV1
    ? logEntries
    : [
        {
          version: 1,
          action: "imported",
          created_at: 0,
          payload_json: JSON.stringify({ target_md: null }),
          restored_from_version: null,
          user_id: null,
          username: null,
          full_name: null,
          synthetic: true,
        },
        ...logEntries.filter((e) => e.version > 1),
      ];

  const snapshot: Record<string, unknown> = {};
  const target = entries.map((e) => {
    let payload: Record<string, unknown> = {};
    if (e.payload_json) {
      try {
        payload = JSON.parse(e.payload_json) as Record<string, unknown>;
      } catch {
        payload = {};
      }
    }
    for (const k of Object.keys(payload)) snapshot[k] = payload[k];
    return {
      version: e.version,
      action: e.action,
      created_at: e.created_at,
      user: e.user_id ? { id: e.user_id, username: e.username, full_name: e.full_name } : null,
      patch: { target_md: "target_md" in payload ? payload.target_md : undefined },
      snapshot: { target_md: snapshot.target_md ?? null },
      synthetic: e.synthetic ?? false,
      restored_from_version: e.restored_from_version ?? null,
    };
  });

  return c.json({ source: sourceRs.results ?? [], target });
});

// POST /api/templates/sync — manual sync trigger (admin only, mirrors the
// existing requireAdmin guard used elsewhere).
templates.post("/sync", requireAdmin, async (c) => {
  const result = await syncTemplates(c.env);
  return c.json(result);
});
