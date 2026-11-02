// Translation preferences & memory routes (migration 0040; design in
// docs/preferences-panel-design.md). Three surfaces:
//   /prefs     — singleton brief + instructions + register + assisted flag
//   /terms     — concept-oriented termbase CRUD + CSV import/export
//   /examples  — read-only browse over validated rows (the few-shot memory)
// PATCH/PUT mirror the articles.ts version-CAS/If-Match/409 mechanics. Pure
// logic (CSV, picklists) lives in translationMemoryLib.ts so it stays testable.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireEditor, requireAdmin } from "./auth";
import {
  REGISTERS,
  TERM_STATUSES,
  isTermStatus,
  parseTermsCsv,
  serializeTermsCsv,
  dedupeTerms,
  termKey,
  termGroupKey,
  termInvariantError,
  parseIfMatch,
  escapeLikeParam,
  type TermImport,
  type ParsedTerm,
} from "./translationMemoryLib.ts";
import { getLatestSuccessfulContextExport } from "./contextExportResults.ts";
import { queueContextExport } from "./contextExportQueue.ts";

export const translationMemory = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

// The duplicate-identity pre-checks below (SELECT-then-write) narrow the race
// window but don't close it — two requests can both pass the pre-check before
// either writes. This backstop catches the unique index (0040) rejecting the
// loser and turns it into the same 409 shape, instead of an uncaught 500.
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

// ---------------------------------------------------------------------------
// Preferences singleton (brief + instructions + register + assisted flag).
// ---------------------------------------------------------------------------

type PrefsRow = {
  id: number;
  audience: string | null;
  purpose: string | null;
  register: string;
  script_notes: string | null;
  instructions_md: string | null;
  common_issues_md: string | null;
  notes: string | null;
  assisted_mode: number;
  version: number;
  updated_at: number;
  updated_by: number | null;
};

const DEFAULT_PREFS: PrefsRow = {
  id: 1,
  audience: null,
  purpose: null,
  register: "default",
  script_notes: null,
  instructions_md: null,
  common_issues_md: null,
  notes: null,
  assisted_mode: 0,
  version: 0, // 0 = never written; the first PUT must send If-Match: 0
  updated_at: 0,
  updated_by: null,
};

// GET /prefs — editor-readable (drives the panel + the assisted-mode toggle).
// Returns the default (version 0) shape when the row has never been written, so
// the client always has a stable object and the first PUT sends If-Match: 0.
translationMemory.get("/prefs", requireEditor, async (c) => {
  const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
  return c.json({ prefs: row ?? DEFAULT_PREFS });
});

const PutPrefsBody = z.object({
  audience: z.string().max(4000).nullable().optional(),
  purpose: z.string().max(4000).nullable().optional(),
  register: z.enum(REGISTERS).optional(),
  script_notes: z.string().max(8000).nullable().optional(),
  instructions_md: z.string().max(20000).nullable().optional(),
  common_issues_md: z.string().max(50000).nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  // assisted_mode is no longer accepted: the contextRef is injected whenever a
  // successful context export exists (the gate was removed). Column stays in
  // D1 for compatibility but is never read.
});

// PUT /prefs — admin-only. If-Match version CAS. Upserts the singleton: on the
// first write (row absent) the INSERT fires with version 1; thereafter the
// UPDATE bumps version guarded on the expected value.
translationMemory.put("/prefs", requireAdmin, async (c) => {
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = PutPrefsBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  const existing = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();

  if (!existing) {
    // First write: only valid against If-Match: 0. Coalesce omitted fields to defaults.
    if (expected !== 0) return c.json({ error: "version_mismatch", current: DEFAULT_PREFS }, 409);
    const d = parsed.data;
    const insertRes = await c.env.DB.prepare(
      `INSERT INTO translation_prefs
         (id, audience, purpose, register, script_notes, instructions_md, common_issues_md, notes, assisted_mode, version, updated_at, updated_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        d.audience ?? null,
        d.purpose ?? null,
        d.register ?? "default",
        d.script_notes ?? null,
        d.instructions_md ?? null,
        d.common_issues_md ?? null,
        d.notes ?? null,
        0,
        now,
        userId ?? null,
      )
      .run();
    if (!insertRes.meta.changes) {
      // Lost a concurrent first-write race — report the winner's row as a 409,
      // same shape as the ordinary version-mismatch path below.
      const current = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
      return c.json({ error: "version_mismatch", current }, 409);
    }
    const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
    queueContextExport(c);
    return c.json({ prefs: row });
  }

  // Merge omitted fields from the existing row (partial update semantics).
  const merged = {
    audience: parsed.data.audience !== undefined ? parsed.data.audience : existing.audience,
    purpose: parsed.data.purpose !== undefined ? parsed.data.purpose : existing.purpose,
    register: parsed.data.register ?? existing.register,
    script_notes: parsed.data.script_notes !== undefined ? parsed.data.script_notes : existing.script_notes,
    instructions_md:
      parsed.data.instructions_md !== undefined ? parsed.data.instructions_md : existing.instructions_md,
    common_issues_md:
      parsed.data.common_issues_md !== undefined ? parsed.data.common_issues_md : existing.common_issues_md,
    notes: parsed.data.notes !== undefined ? parsed.data.notes : existing.notes,
  };
  const res = await c.env.DB.prepare(
    `UPDATE translation_prefs
        SET audience = ?1, purpose = ?2, register = ?3, script_notes = ?4,
            instructions_md = ?5, common_issues_md = ?6, notes = ?7,
            version = version + 1, updated_at = ?8, updated_by = ?9
      WHERE id = 1 AND version = ?10`,
  )
    .bind(
      merged.audience,
      merged.purpose,
      merged.register,
      merged.script_notes,
      merged.instructions_md,
      merged.common_issues_md,
      merged.notes,
      now,
      userId ?? null,
      expected,
    )
    .run();
  if (!res.meta.changes) return c.json({ error: "version_mismatch", current: existing }, 409);
  const row = await c.env.DB.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
  queueContextExport(c);
  return c.json({ prefs: row });
});

// ---------------------------------------------------------------------------
// Terminology CRUD + CSV.
// ---------------------------------------------------------------------------

type TermRow = TermImport & {
  id: number;
  source_status: string;
  version: number;
  created_at: number;
  updated_at: number;
  updated_by: number | null;
};

const TERM_COLS = `id, concept_id, source_term, target_term, status, replacement, comment, tw_link,
                   source_status, version, created_at, updated_at, updated_by`;

// GET /terms — list (optional status / q filters). Excludes soft-deleted.
translationMemory.get("/terms", requireEditor, async (c) => {
  const status = c.req.query("status");
  const q = c.req.query("q");
  const conds = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (status && isTermStatus(status)) {
    binds.push(status);
    conds.push(`status = ?${binds.length}`);
  }
  if (q) {
    const like = `%${escapeLikeParam(q)}%`;
    binds.push(like, like, like);
    conds.push(
      `(source_term LIKE ?${binds.length - 2} ESCAPE '\\' OR target_term LIKE ?${binds.length - 1} ESCAPE '\\' OR concept_id LIKE ?${binds.length} ESCAPE '\\')`,
    );
  }
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "500", 10) || 500, 1), 2000);
  binds.push(limit);
  const rows = await c.env.DB.prepare(
    `SELECT ${TERM_COLS} FROM terminology WHERE ${conds.join(" AND ")}
      ORDER BY concept_id, source_term, status, id LIMIT ?${binds.length}`,
  )
    .bind(...binds)
    .all<TermRow>();
  return c.json({ terms: rows.results ?? [] });
});

const TermBody = z.object({
  concept_id: z.string().min(1).max(200),
  source_term: z.string().min(1).max(500),
  target_term: z.string().max(1000).nullable().optional(),
  status: z.enum(TERM_STATUSES).optional(),
  replacement: z.string().max(1000).nullable().optional(),
  comment: z.string().max(4000).nullable().optional(),
  tw_link: z.string().max(500).nullable().optional(),
});

// POST /terms — create one term row.
translationMemory.post("/terms", requireEditor, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TermBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const d = parsed.data;
  const status = d.status ?? "preferred";
  const replacement = d.replacement ?? null;
  const invariantError = termInvariantError({ status, replacement });
  if (invariantError) return c.json({ error: "validation_failed", issues: [{ message: invariantError }] }, 400);

  // Pre-check the same normalized identity the unique index (0063) enforces,
  // so a duplicate manual add gets a clean 409 instead of an uncaught D1
  // constraint violation. target_term is part of that identity: a second
  // rendering of the same concept is legitimate (CONTEXT-REPO-CONTRACT.md
  // §3.3), and COALESCE mirrors the index (SQLite NULLs never collide).
  const dup = await c.env.DB.prepare(
    `SELECT ${TERM_COLS} FROM terminology
      WHERE deleted_at IS NULL
        AND LOWER(TRIM(concept_id)) = LOWER(TRIM(?1))
        AND LOWER(TRIM(source_term)) = LOWER(TRIM(?2))
        AND LOWER(TRIM(COALESCE(target_term, ''))) = LOWER(TRIM(COALESCE(?3, '')))
        AND status = ?4`,
  )
    .bind(d.concept_id, d.source_term, d.target_term ?? null, status)
    .first<TermRow>();
  if (dup) return c.json({ error: "duplicate_term", current: dup }, 409);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  let id: number | bigint;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO terminology
         (concept_id, source_term, target_term, status, replacement, comment, tw_link, source_status, version, created_at, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual', 1, ?8, ?8, ?9)`,
    )
      .bind(
        d.concept_id,
        d.source_term,
        d.target_term ?? null,
        status,
        replacement,
        d.comment ?? null,
        d.tw_link ?? null,
        now,
        userId ?? null,
      )
      .run();
    id = res.meta.last_row_id;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const current = await c.env.DB.prepare(
      `SELECT ${TERM_COLS} FROM terminology
        WHERE deleted_at IS NULL
          AND LOWER(TRIM(concept_id)) = LOWER(TRIM(?1))
          AND LOWER(TRIM(source_term)) = LOWER(TRIM(?2))
          AND LOWER(TRIM(COALESCE(target_term, ''))) = LOWER(TRIM(COALESCE(?3, '')))
          AND status = ?4`,
    )
      .bind(d.concept_id, d.source_term, d.target_term ?? null, status)
      .first<TermRow>();
    return c.json({ error: "duplicate_term", current }, 409);
  }
  const row = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1`)
    .bind(id)
    .first<TermRow>();
  queueContextExport(c);
  return c.json(row, 201);
});

// PATCH /terms/:id — If-Match version CAS.
translationMemory.patch("/terms/:id", requireEditor, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const expected = parseIfMatch(c.req.header("If-Match"));
  if (expected == null) return c.json({ error: "if_match_required" }, 428);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = TermBody.partial().safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  const existing = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1 AND deleted_at IS NULL`)
    .bind(id)
    .first<TermRow>();
  if (!existing) return c.json({ error: "not_found" }, 404);
  const d = parsed.data;
  const merged = {
    concept_id: d.concept_id ?? existing.concept_id,
    source_term: d.source_term ?? existing.source_term,
    target_term: d.target_term !== undefined ? d.target_term : existing.target_term,
    status: d.status ?? existing.status,
    replacement: d.replacement !== undefined ? d.replacement : existing.replacement,
    comment: d.comment !== undefined ? d.comment : existing.comment,
    tw_link: d.tw_link !== undefined ? d.tw_link : existing.tw_link,
  };
  const invariantError = termInvariantError(merged);
  if (invariantError) return c.json({ error: "validation_failed", issues: [{ message: invariantError }] }, 400);

  // Same duplicate pre-check as POST /terms — a rename that collides with a
  // different existing row should be a clean 409, not an uncaught constraint
  // violation from the unique index (0063, which now includes target_term).
  const dup = await c.env.DB.prepare(
    `SELECT ${TERM_COLS} FROM terminology
      WHERE deleted_at IS NULL AND id != ?1
        AND LOWER(TRIM(concept_id)) = LOWER(TRIM(?2))
        AND LOWER(TRIM(source_term)) = LOWER(TRIM(?3))
        AND LOWER(TRIM(COALESCE(target_term, ''))) = LOWER(TRIM(COALESCE(?4, '')))
        AND status = ?5`,
  )
    .bind(id, merged.concept_id, merged.source_term, merged.target_term, merged.status)
    .first<TermRow>();
  if (dup) return c.json({ error: "duplicate_term", current: dup }, 409);

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  let changed: number;
  try {
    const res = await c.env.DB.prepare(
      `UPDATE terminology
          SET concept_id = ?1, source_term = ?2, target_term = ?3, status = ?4,
              replacement = ?5, comment = ?6, tw_link = ?7,
              version = version + 1, updated_at = ?8, updated_by = ?9
        WHERE id = ?10 AND deleted_at IS NULL AND version = ?11`,
    )
      .bind(
        merged.concept_id,
        merged.source_term,
        merged.target_term,
        merged.status,
        merged.replacement,
        merged.comment,
        merged.tw_link,
        now,
        userId ?? null,
        id,
        expected,
      )
      .run();
    changed = res.meta.changes;
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const current = await c.env.DB.prepare(
      `SELECT ${TERM_COLS} FROM terminology
        WHERE deleted_at IS NULL AND id != ?1
          AND LOWER(TRIM(concept_id)) = LOWER(TRIM(?2))
          AND LOWER(TRIM(source_term)) = LOWER(TRIM(?3))
          AND LOWER(TRIM(COALESCE(target_term, ''))) = LOWER(TRIM(COALESCE(?4, '')))
          AND status = ?5`,
    )
      .bind(id, merged.concept_id, merged.source_term, merged.target_term, merged.status)
      .first<TermRow>();
    return c.json({ error: "duplicate_term", current }, 409);
  }
  if (!changed) {
    const cur = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1 AND deleted_at IS NULL`)
      .bind(id)
      .first<TermRow>();
    if (!cur) return c.json({ error: "not_found" }, 404);
    return c.json({ error: "version_mismatch", current: cur }, 409);
  }
  const row = await c.env.DB.prepare(`SELECT ${TERM_COLS} FROM terminology WHERE id = ?1`).bind(id).first<TermRow>();
  queueContextExport(c);
  return c.json(row);
});

// DELETE /terms/:id — soft delete.
translationMemory.delete("/terms/:id", requireEditor, async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.json({ error: "bad_id" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const res = await c.env.DB.prepare(
    `UPDATE terminology SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL`,
  )
    .bind(now, id)
    .run();
  if (!res.meta.changes) return c.json({ error: "not_found" }, 404);
  queueContextExport(c);
  return c.json({ ok: true });
});

// GET /terms/export — CSV download of the whole live termbase.
translationMemory.get("/terms/export", requireEditor, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT concept_id, source_term, target_term, status, replacement, comment, tw_link
       FROM terminology WHERE deleted_at IS NULL ORDER BY concept_id, source_term, status, id`,
  ).all<TermImport>();
  // excelSafe: this CSV's whole purpose is to be opened in a spreadsheet, so
  // formula-leading cells get the quote guard (stripped again on re-import).
  const csv = serializeTermsCsv(rows.results ?? [], { excelSafe: true });
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="terminology.csv"',
  });
});

// POST /terms/import — CSV upsert. Body is raw CSV text. ?dryRun=1 returns the
// parsed diff (added/updated counts + parse errors) without writing.
translationMemory.post("/terms/import", requireEditor, async (c) => {
  const dryRun = c.req.query("dryRun") === "1" || c.req.query("dryRun") === "true";
  const text = await c.req.text();
  if (!text.trim()) return c.json({ error: "empty_body" }, 400);
  const { terms, errors, warnings } = parseTermsCsv(text);
  const deduped = dedupeTerms(terms);

  // Which of these already exist (by termKey) → update vs add. target_term is
  // selected because it is part of the identity termKey() computes (0063).
  const existingRows = await c.env.DB.prepare(
    `SELECT concept_id, source_term, target_term, status FROM terminology WHERE deleted_at IS NULL`,
  ).all<{ concept_id: string; source_term: string; target_term: string | null; status: string }>();
  const existingKeys = new Set((existingRows.results ?? []).map((r) => termKey(r)));
  // Same rows keyed by the *narrower* pre-0063 identity (concept + source +
  // status) → the renderings already on file. Since 0063, an incoming row whose
  // target_term differs from what is stored no longer updates that row: it is a
  // new sibling rendering and gets inserted (which is correct per
  // CONTEXT-REPO-CONTRACT.md §3.3). But the everyday workflow "export, fix a
  // typo in target_term, re-import" *means* replace, and would otherwise leave
  // both the typo and the fix live and equally preferred — the nightly context
  // export would ship both to the bot, and the shrink guard can never notice
  // because the row count only grows. So warn: the operator sees, per line,
  // that this appends rather than replaces.
  const existingByGroup = new Map<string, string[]>();
  for (const r of existingRows.results ?? []) {
    const gk = `${termGroupKey(r)}\u0000${r.status}`;
    const list = existingByGroup.get(gk);
    if (list) list.push(r.target_term ?? "");
    else existingByGroup.set(gk, [r.target_term ?? ""]);
  }
  let added = 0;
  let updated = 0;
  const appendWarnings: { line: number; message: string }[] = [];
  for (const t of deduped) {
    if (existingKeys.has(termKey(t))) {
      updated++;
      continue;
    }
    added++;
    const siblings = existingByGroup.get(`${termGroupKey(t)}\u0000${t.status}`);
    if (siblings?.length) {
      const have = siblings.map((s) => `"${s}"`).join(", ");
      appendWarnings.push({
        line: t.line,
        message:
          `adds a new rendering "${t.target_term ?? ""}" to a concept that already has ${have} ` +
          `with the same status — if you meant to replace it, edit or delete the old rendering ` +
          `(import never removes rows)`,
      });
    }
  }
  // One list for the client, ordered by line: the existing UI renders
  // parseWarnings as a per-line list, so a mixed-up order reads as noise.
  const parseWarnings = [...warnings, ...appendWarnings].sort((a, b) => a.line - b.line);

  if (dryRun)
    return c.json({
      dryRun: true,
      added,
      updated,
      parseErrors: errors,
      parseWarnings,
      total: deduped.length,
    });

  const userId = currentUserId(c);
  const now = Math.floor(Date.now() / 1000);
  // Upsert each row: UPDATE by the same LOWER(TRIM(...)) identity termKey()
  // mirrors (so applied writes agree with the dry-run counts above, and case/
  // whitespace-variant CSV rows update in place instead of creating a
  // duplicate); INSERT the misses. Batched via DB.batch() in chunks so a large
  // import stays well under the Workers ~1000-subrequest cap (CLAUDE.md
  // documents this exact failure class from the nightly export/reimport path).
  //
  // `SET target_term = ?1` is nearly a no-op since 0063 made target_term part of
  // the identity — the matched row already holds this rendering modulo case and
  // outer spaces, which the SET normalizes to exactly what the CSV said. The
  // substantive changes on the update path are replacement / comment / tw_link /
  // source_status.
  const CHUNK = 100;
  const misses: ParsedTerm[] = [];
  for (let i = 0; i < deduped.length; i += CHUNK) {
    const chunk = deduped.slice(i, i + CHUNK);
    const results = await c.env.DB.batch(
      chunk.map((t) =>
        c.env.DB.prepare(
          `UPDATE terminology
              SET target_term = ?1, replacement = ?2, comment = ?3, tw_link = ?4,
                  source_status = 'imported', version = version + 1, updated_at = ?5, updated_by = ?6
            WHERE deleted_at IS NULL
              AND LOWER(TRIM(concept_id)) = LOWER(TRIM(?7))
              AND LOWER(TRIM(source_term)) = LOWER(TRIM(?8))
              AND LOWER(TRIM(COALESCE(target_term, ''))) = LOWER(TRIM(COALESCE(?10, '')))
              AND status = ?9`,
        ).bind(
          t.target_term,
          t.replacement,
          t.comment,
          t.tw_link,
          now,
          userId ?? null,
          t.concept_id,
          t.source_term,
          t.status,
          t.target_term,
        ),
      ),
    );
    results.forEach((r, idx) => {
      if (!r.meta.changes) misses.push(chunk[idx]);
    });
  }
  const insertStmt = (t: TermImport) =>
    c.env.DB.prepare(
      `INSERT INTO terminology
         (concept_id, source_term, target_term, status, replacement, comment, tw_link, source_status, version, created_at, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'imported', 1, ?8, ?8, ?9)`,
    ).bind(t.concept_id, t.source_term, t.target_term, t.status, t.replacement, t.comment, t.tw_link, now, userId ?? null);
  for (let i = 0; i < misses.length; i += CHUNK) {
    const chunk = misses.slice(i, i + CHUNK);
    try {
      await c.env.DB.batch(chunk.map(insertStmt));
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      // D1's batch() is all-or-nothing — one row racing a concurrent write
      // (another create/import landed the same identity first) would
      // otherwise roll back this whole chunk's inserts. Fall back to
      // per-row inserts for just this chunk so the rest still land; a row
      // that lost the race is simply skipped (it already exists).
      for (const t of chunk) {
        try {
          await insertStmt(t).run();
        } catch (rowErr) {
          if (!isUniqueConstraintError(rowErr)) throw rowErr;
        }
      }
    }
  }
  queueContextExport(c);
  return c.json({
    dryRun: false,
    added,
    updated,
    parseErrors: errors,
    parseWarnings,
    total: deduped.length,
  });
});

// GET /terms/count — cheap count for the language-memory chip.
translationMemory.get("/terms/count", requireEditor, async (c) => {
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM terminology WHERE deleted_at IS NULL`).first<{
    n: number;
  }>();
  return c.json({ count: row?.n ?? 0 });
});

// ---------------------------------------------------------------------------
// Validated examples (read-only browse). No table — validated rows ARE the
// examples. Returns the target-language row only (no English source text) —
// the design doc's "source + target" pairing is NOT yet built: tn_rows/tq_rows
// don't store a source snapshot, and the row's own English source lives in a
// different book's published TSV, not this row. Known gap; see PR review notes.
// ---------------------------------------------------------------------------

translationMemory.get("/examples", requireEditor, async (c) => {
  const resource = c.req.query("resource") ?? "tn";
  const supportRef = c.req.query("supportReference");
  const q = c.req.query("q");
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "100", 10) || 100, 1), 500);

  if (resource === "tn") {
    const conds = ["translation_state = 'validated'", "deleted_at IS NULL", "trashed_at IS NULL"];
    const binds: unknown[] = [];
    if (supportRef) {
      binds.push(supportRef);
      conds.push(`support_reference = ?${binds.length}`);
    }
    if (q) {
      const like = `%${escapeLikeParam(q)}%`;
      binds.push(like, like);
      conds.push(`(note LIKE ?${binds.length - 1} ESCAPE '\\' OR quote LIKE ?${binds.length} ESCAPE '\\')`);
    }
    binds.push(limit);
    const rows = await c.env.DB.prepare(
      `SELECT id, book, ref_raw, support_reference, quote, occurrence, note, translation_state, updated_at
         FROM tn_rows WHERE ${conds.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ?${binds.length}`,
    )
      .bind(...binds)
      .all();
    return c.json({ resource: "tn", examples: rows.results ?? [] });
  }
  if (resource === "tq") {
    const conds = ["translation_state = 'validated'", "deleted_at IS NULL"];
    const binds: unknown[] = [];
    if (q) {
      const like = `%${escapeLikeParam(q)}%`;
      binds.push(like, like);
      conds.push(`(question LIKE ?${binds.length - 1} ESCAPE '\\' OR response LIKE ?${binds.length} ESCAPE '\\')`);
    }
    binds.push(limit);
    const rows = await c.env.DB.prepare(
      `SELECT id, book, ref_raw, quote, occurrence, question, response, translation_state, updated_at
         FROM tq_rows WHERE ${conds.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ?${binds.length}`,
    )
      .bind(...binds)
      .all();
    return c.json({ resource: "tq", examples: rows.results ?? [] });
  }
  return c.json({ error: "unknown_resource" }, 400);
});

// GET /export-status — latest context-pack export result for the assisted-mode
// toggle. Uses the same "latest successful completion" predicate as translate
// start (status=success + commit_sha + completed_at).
translationMemory.get("/export-status", requireEditor, async (c) => {
  const latest = await getLatestSuccessfulContextExport(c.env);
  if (!latest) {
    // Also surface the most recent non-success row so the UI can show why the
    // toggle is disabled (shrink_refused / failed / never run).
    const last = await c.env.DB.prepare(
      `SELECT status, completed_at, failure_reason, terms_count, examples_tn, examples_tq,
              content_files, total_bytes, owner
         FROM context_export_results
        ORDER BY id DESC LIMIT 1`,
    ).first<{
      status: string;
      completed_at: number | null;
      failure_reason: string | null;
      terms_count: number | null;
      examples_tn: number | null;
      examples_tq: number | null;
      content_files: number | null;
      total_bytes: number | null;
      owner: string;
    }>();
    if (!last) {
      return c.json({
        status: "never",
        sha: null,
        completedAt: null,
        terms: 0,
        examplesTn: 0,
        examplesTq: 0,
        contentFiles: 0,
        totalBytes: 0,
        owner: null,
        failureReason: null,
      });
    }
    return c.json({
      status: last.status,
      sha: null,
      completedAt: last.completed_at,
      terms: last.terms_count ?? 0,
      examplesTn: last.examples_tn ?? 0,
      examplesTq: last.examples_tq ?? 0,
      contentFiles: last.content_files ?? 0,
      totalBytes: last.total_bytes ?? 0,
      owner: last.owner,
      failureReason: last.failure_reason,
    });
  }
  return c.json({
    status: "success",
    sha: latest.sha,
    completedAt: latest.completedAt,
    terms: latest.terms,
    examplesTn: latest.examplesTn,
    examplesTq: latest.examplesTq,
    contentFiles: latest.contentFiles,
    totalBytes: latest.totalBytes,
    owner: latest.owner,
    failureReason: null,
  });
});
