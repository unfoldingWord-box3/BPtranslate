// "Draft missing templates from approved notes" (issue #818).
//
// For every SupportReference slug with at least MIN_APPROVED_NOTES approved tN
// notes and no approved template, ask the org's own model to write the
// template from those notes, and store the result as an AI draft
// (translation_state='ai_draft') that an editor must approve. Nothing reaches
// the context pack until then: loadQueuedContextInputs only reads validated
// templates.
//
// Why not POST /api/templates/unit/draft: that route goes through the bot,
// which cannot carry the org's key, so it is switched off (#551,
// TEMPLATE_DRAFT_NEEDS_ORG_KEY). This path calls the provider from the Worker
// with the org's key, the way the in-Worker translate runner does, and only for
// providers the Worker has an adapter for (hasInternalAdapter).
//
// Imports carry .ts suffixes so the node strip-types test runner resolves them.

import { Hono } from "hono";
import type { Env } from "./index";
import { currentUserId, requireAdmin } from "./auth.ts";
import { getAiProviderConfig, resolveDispatchAi } from "./aiProvider.ts";
import { decryptApiKey } from "./aiKeyCrypto.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";
import { nextPreDraftJson } from "./preDraftSnapshot.ts";
import { shortSupport } from "./packageRefs.ts";
import {
  BEGIN_OUTPUT,
  END_OUTPUT,
  TranslateProviderError,
  callProvider,
  extractOutput,
  hasInternalAdapter,
  transportFor,
  type Transport,
} from "./translate/llm.ts";
import { assertProviderModel, estimateCost } from "./translate/providerCatalog.ts";

/** A slug needs this many approved notes before a template is drafted from them. */
export const MIN_APPROVED_NOTES = 20;
/** The most recent approved notes shown to the model per slug. */
export const MAX_EXAMPLES_PER_SLUG = 30;
/** Each example note (and its AI draft) is cut to this many characters. */
export const NOTE_CHAR_CAP = 1200;
/** Slugs drafted per button press; the rest wait for the next press. */
export const MAX_SLUGS_PER_RUN = 6;
/** Provider calls in flight at once. */
export const RUN_CONCURRENCY = 3;
/** One template call is small; a call that has not returned by now is hung. */
export const CALL_TIMEOUT_MS = 120_000;
/** draft_meta_json.source for drafts written here. */
export const DRAFT_SOURCE = "approved_notes";
/** Provider failures that will fail every slug the same way: stop starting new calls. */
const FATAL_CODES = new Set(["invalid_key", "model_not_found"]);
const AI_SOURCE = "ai_pipeline";

// Human-approved notes only. Same rule as VALIDATED_TN_EXAMPLES_SQL
// (contextExport.ts): bulk approvals (admin_bulk_state set) were never read
// one at a time, so they must not teach the template either.
const approvedTnWhere = (t: string) => `${t}translation_state = 'validated'
       AND ${t}admin_bulk_state IS NULL
       AND ${t}deleted_at IS NULL AND ${t}trashed_at IS NULL
       AND ${t}support_reference IS NOT NULL AND TRIM(${t}support_reference) <> ''`;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export type UnavailableReason =
  | "ai_provider_not_configured"
  | "api_key_missing"
  | "model_missing"
  | "ai_key_encryption_unavailable"
  | "ai_provider_key_decrypt_failed"
  | "provider_not_supported"
  | "not_translation_project";

export type Availability =
  | { available: true; provider: string; model: string }
  | { available: false; reason: UnavailableReason; provider: string | null };

/** A slug that qualifies, with the units this run may write (state NULL only). */
export type CandidateSlug = {
  slug: string;
  approvedNotes: number;
  units: { template_id: string; type: string | null; source_md: string; target_md: string | null; version: number }[];
};

export type ExampleNote = {
  ref: string;
  quote: string | null;
  note: string;
  /** The AI draft the note started from, when the edit log has one and it differs. */
  aiNote: string | null;
};

export type RunResult = {
  drafted: { slug: string; approvedNotes: number; units: number }[];
  failed: { slug: string; code: string }[];
  /** Qualifying slugs still without a draft after this run (failed ones included). */
  remaining: number;
  estimatedCostUsd: number | null;
};

type Db = Env["DB"];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Slugs that qualify, busiest first: at least MIN_APPROVED_NOTES approved
 * notes, at least one live sheet template unit, no approved unit, and at least
 * one unit nobody has started (translation_state NULL). Units already
 * 'ai_draft', 'edited' or 'validated' are never written here: an edited unit is
 * a person's work in progress, and redrafting an existing AI draft would charge
 * the org again for every press without the list ever getting shorter.
 */
export async function findCandidateSlugs(db: Db): Promise<CandidateSlug[]> {
  const counts = await db
    .prepare(
      `SELECT TRIM(support_reference) AS ref, COUNT(*) AS n
         FROM tn_rows
        WHERE ${approvedTnWhere("")}
        GROUP BY TRIM(support_reference)`,
    )
    .all<{ ref: string; n: number }>();
  const approved = new Map<string, number>();
  for (const r of counts.results ?? []) {
    const slug = shortSupport(r.ref);
    approved.set(slug, (approved.get(slug) ?? 0) + Number(r.n));
  }

  const unitRs = await db
    .prepare(
      `SELECT template_id, TRIM(support_ref) AS slug, type, source_md, target_md, translation_state, version
         FROM template_units
        WHERE deleted_at IS NULL AND origin = 'sheet'
        ORDER BY support_ref, sheet_order, template_id`,
    )
    .all<{
      template_id: string;
      slug: string;
      type: string | null;
      source_md: string;
      target_md: string | null;
      translation_state: string | null;
      version: number;
    }>();
  const bySlug = new Map<string, { validated: boolean; open: CandidateSlug["units"] }>();
  for (const u of unitRs.results ?? []) {
    const entry = bySlug.get(u.slug) ?? { validated: false, open: [] };
    if (u.translation_state === "validated") entry.validated = true;
    if (u.translation_state == null) {
      entry.open.push({ template_id: u.template_id, type: u.type, source_md: u.source_md, target_md: u.target_md, version: u.version });
    }
    bySlug.set(u.slug, entry);
  }

  const out: CandidateSlug[] = [];
  for (const [slug, entry] of bySlug) {
    const n = approved.get(slug) ?? 0;
    if (n < MIN_APPROVED_NOTES || entry.validated || entry.open.length === 0) continue;
    out.push({ slug, approvedNotes: n, units: entry.open });
  }
  out.sort((a, b) => b.approvedNotes - a.approvedNotes || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return out;
}

function cap(s: string): string {
  const t = s.trim();
  return t.length > NOTE_CHAR_CAP ? `${t.slice(0, NOTE_CHAR_CAP)}…` : t;
}

/**
 * The most recent approved notes for one slug, each with the AI draft it
 * started from when the edit log holds one. tN ids are unique per book only, so
 * the edit_log lookup matches on book as well as row_key.
 */
export async function loadExamples(db: Db, slug: string): Promise<ExampleNote[]> {
  const rs = await db
    .prepare(
      `SELECT t.book, t.ref_raw, t.quote, t.note,
              (SELECT json_extract(el.payload_json, '$.note')
                 FROM edit_log el
                WHERE el.kind = 'tn' AND el.row_key = t.id AND el.book = t.book
                  AND el.source = 'ai_pipeline'
                  AND (CASE WHEN json_valid(el.payload_json)
                            THEN json_type(el.payload_json, '$.note') END) = 'text'
                ORDER BY el.id DESC LIMIT 1) AS ai_note
         FROM tn_rows t
        WHERE ${approvedTnWhere("t.")}
          AND (TRIM(t.support_reference) = ?1
               OR substr(TRIM(t.support_reference), -(length(?1) + 1)) = '/' || ?1)
          AND t.note IS NOT NULL AND TRIM(t.note) <> ''
        ORDER BY t.updated_at DESC, t.book, t.id
        LIMIT ?2`,
    )
    .bind(slug, MAX_EXAMPLES_PER_SLUG)
    .all<{ book: string; ref_raw: string; quote: string | null; note: string; ai_note: string | null }>();
  return (rs.results ?? []).map((r) => {
    const note = cap(r.note);
    const ai = typeof r.ai_note === "string" && r.ai_note.trim() ? cap(r.ai_note) : null;
    return {
      ref: `${r.book} ${r.ref_raw}`,
      quote: r.quote && r.quote.trim() ? cap(r.quote) : null,
      note,
      aiNote: ai && ai !== note ? ai : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type TemplatePromptInput = {
  languageName: string;
  languageCode: string;
  direction: "ltr" | "rtl";
  slug: string;
  approvedNotes: number;
  units: { template_id: string; type: string | null; source_md: string }[];
  examples: ExampleNote[];
};

export function buildTemplatePrompt(input: TemplatePromptInput): { system: string; user: string } {
  const lang = `${input.languageName} (${input.languageCode}, written ${input.direction})`;
  const system = [
    `You write note templates for Bible translation notes (translationNotes) in ${lang}.`,
    "A note template is the standard wording translators reuse for one kind of note. Each kind is named by a SupportReference slug such as figs-metaphor.",
    "You are given the English template(s) for one slug and notes in the target language that editors have already approved for that slug. Where a note began as an AI draft, the draft is shown next to the approved wording: the editor's changes show the phrasing they prefer.",
    "Write each template in the target language so that it reads like the approved notes: use their recurring wording, connectives and terms, and avoid wording the editors kept changing.",
    "Keep the structure of the English template. Keep every placeholder exactly as the English template writes it (text in square brackets, ALL-CAPS slot words, link targets) and in the matching place.",
    "Do not copy verse-specific content from the notes into a template.",
    `Reply with one JSON object that maps each template id to its template text, between the lines ${BEGIN_OUTPUT} and ${END_OUTPUT}. Nothing else is read.`,
  ].join("\n");

  const units = input.units
    .map((u) => `## Template ${u.template_id}${u.type ? ` (type: ${u.type})` : ""}\n\n${u.source_md.trim()}`)
    .join("\n\n");
  const examples = input.examples
    .map((e, i) => {
      const lines = [`### Note ${i + 1} (${e.ref})`];
      if (e.quote) lines.push(`Quote: ${e.quote}`);
      if (e.aiNote) lines.push(`AI draft: ${e.aiNote}`);
      lines.push(`Approved: ${e.note}`);
      return lines.join("\n");
    })
    .join("\n\n");
  const ids = JSON.stringify(Object.fromEntries(input.units.map((u) => [u.template_id, "…"])));
  const user = [
    `# SupportReference: ${input.slug}`,
    `Approved notes for this slug: ${input.approvedNotes} (the ${input.examples.length} most recent are shown).`,
    `# English templates\n\n${units}`,
    `# Approved ${input.languageName} notes\n\n${examples}`,
    `Now write the ${input.languageName} template for every template id above. Output shape: ${ids}`,
    `${BEGIN_OUTPUT}\n…\n${END_OUTPUT}`,
  ].join("\n\n");
  return { system, user };
}

/** Template text per requested id. Ids the model left out, or left empty, are missing from the map. */
export function parseTemplateOutput(text: string, unitIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let body = extractOutput(text);
  const fenced = /^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body.trim());
  if (fenced) body = fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const obj = parsed as Record<string, unknown>;
  for (const id of unitIds) {
    const v = obj[id];
    if (typeof v === "string" && v.trim()) out.set(id, v.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key + provider
// ---------------------------------------------------------------------------

type Resolved = { availability: Availability; apiKey: string | null };

async function resolveProvider(env: Env, decrypt: boolean): Promise<Resolved> {
  const cfg = await getProjectConfig(env);
  if (!isTranslationConfig(cfg)) {
    return { availability: { available: false, reason: "not_translation_project", provider: null }, apiKey: null };
  }
  const row = await getAiProviderConfig(env.DB);
  const ai = resolveDispatchAi(row, env.AI_KEY_WRAPPING_KEY);
  const provider = row && row.provider !== "default" ? row.provider : null;
  if (ai.kind === "error") return { availability: { available: false, reason: ai.reason, provider }, apiKey: null };
  if (!hasInternalAdapter(ai.provider)) {
    return { availability: { available: false, reason: "provider_not_supported", provider: ai.provider }, apiKey: null };
  }
  let model: string;
  try {
    model = assertProviderModel(ai.provider, ai.model);
  } catch {
    return { availability: { available: false, reason: "model_missing", provider: ai.provider }, apiKey: null };
  }
  // Decrypt even for the preview: a key that no longer decrypts (after a
  // wrapping-key rotation) looks configured but would fail every call.
  let apiKey: string;
  try {
    apiKey = await decryptApiKey(env.AI_KEY_WRAPPING_KEY!, ai.ciphertext, ai.iv);
  } catch {
    return { availability: { available: false, reason: "ai_provider_key_decrypt_failed", provider: ai.provider }, apiKey: null };
  }
  return { availability: { available: true, provider: ai.provider, model }, apiKey: decrypt ? apiKey : null };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Store one unit's draft. The CAS on version plus the `translation_state IS
 * NULL` guard mean a person who started the unit while the model was writing
 * wins: the draft is dropped, not written over their text. The edit_log row is
 * gated on the update having landed and carries target_md so the history view
 * can replay it.
 */
async function writeDraft(
  db: Db,
  unit: CandidateSlug["units"][number],
  targetMd: string,
  meta: Record<string, unknown>,
  userId: number | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const preDraftJson = nextPreDraftJson(null, null, { target_md: unit.target_md });
  const [res] = await db.batch([
    db
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
            AND translation_state IS NULL`,
      )
      .bind(targetMd, JSON.stringify(meta), preDraftJson, now, userId, unit.template_id, unit.version),
    db
      .prepare(
        `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source, payload_json)
         SELECT 'template', ?1, NULL, ?2, ?3, ?3 + 1, 'update', ?4, ?5
          WHERE (SELECT changes()) > 0`,
      )
      .bind(
        unit.template_id,
        userId,
        unit.version,
        AI_SOURCE,
        JSON.stringify({ target_md: targetMd, approved_note_count: meta.approved_note_count }),
      ),
  ]);
  return !!res.meta.changes;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunDeps = {
  /** Test seam; defaults to the provider's in-Worker adapter. */
  transport?: Transport;
};

export type RunOutcome = { ok: true; result: RunResult } | { ok: false; availability: Availability & { available: false } };

export async function draftMissingTemplates(
  env: Env,
  userId: number | null,
  { skipSlugs = [] }: { skipSlugs?: readonly string[] } = {},
  deps: RunDeps = {},
): Promise<RunOutcome> {
  const { availability, apiKey } = await resolveProvider(env, true);
  if (!availability.available || !apiKey) {
    return { ok: false, availability: availability as Availability & { available: false } };
  }
  const { provider, model } = availability;
  const cfg = await getProjectConfig(env);
  const transport = deps.transport ?? transportFor(provider);

  const skip = new Set(skipSlugs);
  const batch = (await findCandidateSlugs(env.DB)).filter((c) => !skip.has(c.slug)).slice(0, MAX_SLUGS_PER_RUN);

  const drafted: RunResult["drafted"] = [];
  const failed: RunResult["failed"] = [];
  let cost: number | null = null;
  let stop = false;
  const addCost = (usage: { inputTokens: number; outputTokens: number }) => {
    const c = estimateCost(provider, model, usage);
    if (c != null) cost = (cost ?? 0) + c;
  };

  const runOne = async (cand: CandidateSlug) => {
    if (stop) {
      failed.push({ slug: cand.slug, code: "not_started" });
      return;
    }
    const examples = await loadExamples(env.DB, cand.slug);
    const { system, user } = buildTemplatePrompt({
      languageName: cfg.languageName,
      languageCode: cfg.languageCode,
      direction: cfg.direction,
      slug: cand.slug,
      approvedNotes: cand.approvedNotes,
      units: cand.units,
      examples,
    });
    let text: string;
    try {
      const outcome = await callProvider(transport, {
        provider, model, system, user, thinking: "low", apiKey, timeoutMs: CALL_TIMEOUT_MS,
      });
      for (const d of outcome.discarded) addCost(d.usage);
      addCost(outcome.usage);
      text = outcome.text;
    } catch (err) {
      const code = err instanceof TranslateProviderError ? err.code : "provider_error";
      if (err instanceof TranslateProviderError) for (const r of err.transportResults ?? []) addCost(r.usage);
      if (FATAL_CODES.has(code)) stop = true;
      failed.push({ slug: cand.slug, code });
      // Log the code only: provider error bodies can echo the prompt.
      console.error(`draft-missing-templates: ${cand.slug} failed (${provider}, ${code})`);
      return;
    }
    const byId = parseTemplateOutput(text, cand.units.map((u) => u.template_id));
    if (byId.size === 0) {
      failed.push({ slug: cand.slug, code: "unreadable_output" });
      return;
    }
    const meta = {
      source: DRAFT_SOURCE,
      approved_note_count: cand.approvedNotes,
      example_count: examples.length,
      draft_change_count: examples.filter((e) => e.aiNote).length,
      provider,
      model,
    };
    let written = 0;
    for (const unit of cand.units) {
      const md = byId.get(unit.template_id);
      if (md && (await writeDraft(env.DB, unit, md, meta, userId))) written++;
    }
    if (written > 0) drafted.push({ slug: cand.slug, approvedNotes: cand.approvedNotes, units: written });
    else failed.push({ slug: cand.slug, code: "not_written" });
  };

  // A small pool: RUN_CONCURRENCY calls in flight, each slug written as soon
  // as its own call returns.
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const cand = batch[next++];
      await runOne(cand);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, batch.length) }, worker));

  const remaining = (await findCandidateSlugs(env.DB)).length;
  return { ok: true, result: { drafted, failed, remaining, estimatedCostUsd: cost } };
}

/** What the button shows before it is pressed. */
export async function draftMissingPreview(env: Env): Promise<Availability & {
  qualifying: { slug: string; approvedNotes: number; units: number }[];
  minApprovedNotes: number;
  batchSize: number;
}> {
  const { availability } = await resolveProvider(env, false);
  const cands = await findCandidateSlugs(env.DB);
  return {
    ...availability,
    qualifying: cands.map((c) => ({ slug: c.slug, approvedNotes: c.approvedNotes, units: c.units.length })),
    minApprovedNotes: MIN_APPROVED_NOTES,
    batchSize: MAX_SLUGS_PER_RUN,
  };
}

// ---------------------------------------------------------------------------
// Routes (mounted at /api/templates/draft-missing)
// ---------------------------------------------------------------------------

type RouteEnv = { Bindings: Env; Variables: { userId?: number } };

export function draftMissingRoutes(deps: RunDeps = {}) {
  const app = new Hono<RouteEnv>();

  app.get("/", requireAdmin, async (c) => c.json(await draftMissingPreview(c.env)));

  // Body (optional): { skipSlugs: string[] } — slugs that failed earlier in
  // this session, so one slug that always fails cannot hold every later press.
  app.post("/", requireAdmin, async (c) => {
    let skipSlugs: string[] = [];
    try {
      const body = (await c.req.json()) as { skipSlugs?: unknown } | null;
      if (body && Array.isArray(body.skipSlugs)) {
        skipSlugs = body.skipSlugs.filter((s): s is string => typeof s === "string").slice(0, 500);
      }
    } catch {
      // No body: skip nothing.
    }
    const work = draftMissingTemplates(c.env, currentUserId(c), { skipSlugs }, deps);
    // Keep the run going if the admin closes the tab mid-run: each slug that
    // finishes is still written.
    try {
      c.executionCtx.waitUntil(work.catch(() => {}));
    } catch {
      // No ExecutionContext (unit tests).
    }
    const out = await work;
    if (!out.ok) return c.json({ error: out.availability.reason, provider: out.availability.provider }, 409);
    return c.json(out.result);
  });

  return app;
}
