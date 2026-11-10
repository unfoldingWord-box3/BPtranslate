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
  scrubSecrets,
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
/** A run that has not released its lease by then is presumed dead and can be taken over. */
// The lease is renewed before every note type's model call, so a live run
// never loses it: the longest gap between renewals is one note type's call
// (CALL_TIMEOUT_MS, 120 s; at thinking "low" callProvider makes no truncation
// retry) plus its writes. A run whose renewal fails stops starting calls. A run
// that died (tab closed, isolate gone) blocks new presses for at most this
// long after its last renewal.
export const RUN_LEASE_SECONDS = 5 * 60;
/** A drafted template longer than max(this, OUTPUT_SOURCE_FACTOR × its English source) is rejected. */
export const MAX_OUTPUT_FLOOR_CHARS = 4000;
export const OUTPUT_SOURCE_FACTOR = 4;
/** Provider failures that will fail every slug the same way: stop starting new calls. */
const FATAL_CODES = new Set(["invalid_key", "model_not_found"]);
const AI_SOURCE = "ai_pipeline";

// Human-approved notes only. Same rule as VALIDATED_TN_EXAMPLES_SQL
// (contextExport.ts): bulk approvals (admin_bulk_state set) were never read
// one at a time, so they must not teach the template either. A note with no
// text teaches nothing, so it does not count toward the threshold either
// (the same notes loadExamples can show).
const approvedTnWhere = (t: string) => `${t}translation_state = 'validated'
       AND ${t}admin_bulk_state IS NULL
       AND ${t}deleted_at IS NULL AND ${t}trashed_at IS NULL
       AND ${t}support_reference IS NOT NULL AND TRIM(${t}support_reference) <> ''
       AND TRIM(COALESCE(${t}note, '')) <> ''`;

// Matches a support reference (bare slug or rc:// path) to the slug bound at
// ?N, the same rule as shortSupport: the last path segment.
const slugMatch = (col: string, n: number) =>
  `(TRIM(${col}) = ?${n} OR substr(TRIM(${col}), -(length(?${n}) + 1)) = '/' || ?${n})`;

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
  | "not_translation_project"
  | "not_migrated";

export type Availability =
  | { available: true; provider: string; model: string }
  | { available: false; reason: UnavailableReason; provider: string | null };

/** One unit this run may write, with the state and version it was read at. */
export type OpenUnit = {
  template_id: string;
  /** support_ref as stored; the write is pinned to it. */
  support_ref: string;
  type: string | null;
  source_md: string;
  target_md: string | null;
  translation_state: null | "ai_draft";
  pre_draft_json: string | null;
  version: number;
};

/** A slug that qualifies, with the units this run may write. */
export type CandidateSlug = {
  slug: string;
  approvedNotes: number;
  units: OpenUnit[];
};

/** True when draft_meta_json says the draft was written by this feature. */
export function isApprovedNotesDraft(draftMetaJson: string | null): boolean {
  if (!draftMetaJson) return false;
  try {
    return (JSON.parse(draftMetaJson) as { source?: unknown } | null)?.source === DRAFT_SOURCE;
  } catch {
    return false;
  }
}

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
  /** Every template_id this run wrote, partial slugs included, so an open editor can reload. */
  written: string[];
};

type Db = Env["DB"];

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Slugs that qualify, busiest first: at least MIN_APPROVED_NOTES approved
 * notes, at least one live sheet template unit, no approved unit, and at least
 * one open unit. A unit is open when nobody has started it (state NULL) or it
 * holds an older AI draft (for example from the bot's "Draft all with AI"
 * before #551) that this feature did not write. Edited and validated units are
 * never written: an edited unit is a person's work in progress. A draft this
 * feature wrote is not redrafted either, or every press would charge the org
 * again without the list ever getting shorter.
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
      `SELECT template_id, support_ref, type, source_md, target_md, translation_state,
              draft_meta_json, pre_draft_json, version
         FROM template_units
        WHERE deleted_at IS NULL AND origin = 'sheet'
        ORDER BY support_ref, sheet_order, template_id`,
    )
    .all<{
      template_id: string;
      support_ref: string;
      type: string | null;
      source_md: string;
      target_md: string | null;
      translation_state: string | null;
      draft_meta_json: string | null;
      pre_draft_json: string | null;
      version: number;
    }>();
  const bySlug = new Map<string, { validated: boolean; open: CandidateSlug["units"] }>();
  for (const u of unitRs.results ?? []) {
    // Same normalization as the tN side: a path-form support_ref counts as its slug.
    const slug = shortSupport(u.support_ref);
    const entry = bySlug.get(slug) ?? { validated: false, open: [] };
    if (u.translation_state === "validated") entry.validated = true;
    const state = u.translation_state;
    if (state == null || (state === "ai_draft" && !isApprovedNotesDraft(u.draft_meta_json))) {
      entry.open.push({
        template_id: u.template_id,
        support_ref: u.support_ref,
        type: u.type,
        source_md: u.source_md ?? "",
        target_md: u.target_md,
        translation_state: state,
        pre_draft_json: u.pre_draft_json,
        version: u.version,
      });
    }
    bySlug.set(slug, entry);
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
          AND ${slugMatch("t.support_reference", 1)}
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

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

// What the prompt tells the model about the English template's special
// pieces, and what the output is checked for. One definition for both:
//   - ENFORCED, kept verbatim or the unit is not written: markdown link
//     targets, the (../01/01.md) after a ](, and [[rc://…]] links.
//   - WARNED, never a reason to reject: ALL-CAPS slot words of 2+ letters
//     (SPEAKER, PERSON). Missing ones are recorded on the draft.
//   - Text in square brackets is NOT a placeholder: in the real sheet it is
//     English example wording ("[passed away] or [died]") that must be
//     translated.
const RC_LINK = /\[\[rc:\/\/[^\]\s]+\]\]/g;
const LINK_TARGET = /\]\(([^()\s]+)\)/g;
const ALL_CAPS = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]+(?![A-Za-z0-9_])/g;

/** Link targets and rc links: every one must appear in the draft, repeats counted. */
export function enforcedTokens(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(RC_LINK)) out.push(m[0]);
  for (const m of md.matchAll(LINK_TARGET)) out.push(`(${m[1]})`);
  return out;
}

/**
 * ALL-CAPS slot words, distinct. Words inside rc links, link targets, square
 * brackets or link text are skipped: bracketed text and link text are wording
 * the model translates ([the LORD], [UST](…)), so they cannot also be "keep".
 */
export function slotWords(md: string): string[] {
  const bare = md
    .replace(RC_LINK, " ")
    .replace(/\]\([^()\s]+\)/g, "] ")
    .replace(/\[[^\[\]\n]*\]/g, " ");
  return [...new Set([...bare.matchAll(ALL_CAPS)].map((m) => m[0]))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type PlaceholderCheck = {
  /** Enforced tokens the draft dropped or altered: the unit is not written. */
  missing: string[];
  /** Slot words the draft dropped: recorded, not rejected. */
  warnings: string[];
};

export function checkPlaceholders(sourceMd: string, output: string): PlaceholderCheck {
  // Each distinct link must appear at least once. The prompt lists each link
  // once ("Keep exactly"), so a draft that follows it and mentions a repeated
  // link a single time is not rejected (and paid for again on every press).
  const have = new Set(enforcedTokens(output));
  const missing = [...new Set(enforcedTokens(sourceMd))].filter((tok) => !have.has(tok));
  // Any letter may sit directly before a slot word in the draft: Arabic
  // attaches و/ب/ل/ف/ك (and the tatweel) to the next word, as in وSPEAKER.
  // Only a Latin letter, digit or underscore on either side makes it another word.
  const warnings = slotWords(sourceMd).filter(
    (w) => !new RegExp(`(?<![A-Za-z0-9_])${escapeRe(w)}(?![A-Za-z0-9_])`).test(output),
  );
  return { missing, warnings };
}

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
    "Keep the structure of the English template. Keep link targets (the part in parentheses right after a link) and [[rc://…]] links exactly as written; a draft that drops or changes one is thrown away. Keep ALL-CAPS slot words such as SPEAKER exactly as they are. Translate the text inside square brackets: it is example wording, not a placeholder.",
    "Do not copy verse-specific content from the notes into a template.",
    `Reply with one JSON object that maps each template id to its template text, between the lines ${BEGIN_OUTPUT} and ${END_OUTPUT}. Nothing else is read.`,
  ].join("\n");

  const units = input.units
    .map((u) => {
      const exact = [...new Set(enforcedTokens(u.source_md))];
      const slots = slotWords(u.source_md);
      const keep =
        (exact.length ? `\n\nKeep exactly: ${exact.join(" ")}` : "") +
        (slots.length ? `\n\nSlot words to keep: ${slots.join(" ")}` : "");
      return `## Template ${u.template_id}${u.type ? ` (type: ${u.type})` : ""}\n\n${u.source_md.trim()}${keep}`;
    })
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
 * Store one unit's draft. The UPDATE is pinned to what the unit looked like
 * when it was read, so whatever a person did while the model was writing wins
 * and the draft is dropped:
 *   - version: an edit bumps it;
 *   - state: Approve flips it without a version bump;
 *   - support_ref: a sheet sync can move the unit to another note type;
 *   - no sibling of the note type approved meanwhile: the type then has an
 *     approved template and no longer qualifies.
 * The edit_log row is gated on the update having landed and carries target_md
 * so the history view can replay it.
 */
async function writeDraft(
  db: Db,
  slug: string,
  unit: OpenUnit,
  targetMd: string,
  meta: Record<string, unknown>,
  userId: number | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const preDraftJson = nextPreDraftJson(unit.translation_state, unit.pre_draft_json, { target_md: unit.target_md });
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
            AND translation_state IS ?8
            AND support_ref = ?9
            AND NOT EXISTS (
              SELECT 1 FROM template_units v
               WHERE v.deleted_at IS NULL AND v.origin = 'sheet' AND v.translation_state = 'validated'
                 AND ${slugMatch("v.support_ref", 10)})`,
      )
      .bind(
        targetMd, JSON.stringify(meta), preDraftJson, now, userId,
        unit.template_id, unit.version, unit.translation_state, unit.support_ref, slug,
      ),
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

export type RunOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; error: UnavailableReason | "run_in_progress"; provider: string | null };

// ---------------------------------------------------------------------------
// Lease: one run at a time (migration 0081)
// ---------------------------------------------------------------------------

/** Take the run lease, or report it held. A lease past lease_until is free. */
export async function acquireRunLease(db: Db, holder: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO template_draft_lock (id, holder, lease_until) VALUES (1, ?1, ?2)
       ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, lease_until = excluded.lease_until
        WHERE template_draft_lock.holder IS NULL OR template_draft_lock.lease_until IS NULL
           OR template_draft_lock.lease_until < ?3`,
    )
    .bind(holder, now + RUN_LEASE_SECONDS, now)
    .run();
  return !!res.meta.changes;
}

/**
 * Push this run's lease out again. False when the lease is no longer this
 * run's (it lapsed and another press took it): the caller must stop.
 */
export async function renewRunLease(db: Db, holder: string, now: number): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE template_draft_lock SET lease_until = ?2 WHERE id = 1 AND holder = ?1`)
    .bind(holder, now + RUN_LEASE_SECONDS)
    .run();
  return !!res.meta.changes;
}

export async function releaseRunLease(db: Db, holder: string): Promise<void> {
  await db
    .prepare(`UPDATE template_draft_lock SET holder = NULL, lease_until = NULL WHERE id = 1 AND holder = ?1`)
    .bind(holder)
    .run();
}

function tooLong(md: string, sourceMd: string): boolean {
  return md.length > Math.max(MAX_OUTPUT_FLOOR_CHARS, OUTPUT_SOURCE_FACTOR * sourceMd.length);
}

export async function draftMissingTemplates(
  env: Env,
  userId: number | null,
  { skipSlugs = [] }: { skipSlugs?: readonly string[] } = {},
  deps: RunDeps = {},
): Promise<RunOutcome> {
  const { availability, apiKey } = await resolveProvider(env, true);
  if (!availability.available || !apiKey) {
    const reason = availability.available ? "ai_provider_not_configured" : availability.reason;
    return { ok: false, error: reason, provider: availability.provider };
  }
  const { provider, model } = availability;

  const holder = crypto.randomUUID();
  try {
    if (!(await acquireRunLease(env.DB, holder, Math.floor(Date.now() / 1000)))) {
      return { ok: false, error: "run_in_progress", provider };
    }
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : String(e))) {
      return { ok: false, error: "not_migrated", provider };
    }
    throw e;
  }
  try {
    // True while this run still holds the lease. A renewal that throws counts
    // as lost: going on without knowing would risk a second run billing the
    // same note types.
    const renew = async (): Promise<boolean> => {
      try {
        const held = await renewRunLease(env.DB, holder, Math.floor(Date.now() / 1000));
        if (!held) console.error("draft-missing-templates: lease lost to another run; stopping");
        return held;
      } catch (e) {
        console.error(`draft-missing-templates: lease renewal failed, stopping: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    };
    return { ok: true, result: await runBatch(env, userId, provider, model, apiKey, skipSlugs, deps, renew) };
  } finally {
    try {
      await releaseRunLease(env.DB, holder);
    } catch (e) {
      // The lease runs out on its own after RUN_LEASE_SECONDS.
      console.error(`draft-missing-templates: lease release failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function runBatch(
  env: Env,
  userId: number | null,
  provider: string,
  model: string,
  apiKey: string,
  skipSlugs: readonly string[],
  deps: RunDeps,
  renewLease: () => Promise<boolean> = async () => true,
): Promise<RunResult> {
  const cfg = await getProjectConfig(env);
  const transport = deps.transport ?? transportFor(provider);

  // Slugs the previous press reported as failed wait one press, so a slug that
  // keeps failing cannot take a place in every batch. If skipping would leave
  // nothing to do they are retried instead: while the server says work
  // remains, a press always does some.
  const candidates = await findCandidateSlugs(env.DB);
  const skip = new Set(skipSlugs);
  const unskipped = candidates.filter((c) => !skip.has(c.slug));
  const batch = (unskipped.length > 0 ? unskipped : candidates).slice(0, MAX_SLUGS_PER_RUN);

  const drafted: RunResult["drafted"] = [];
  const writtenIds: string[] = [];
  const failed: RunResult["failed"] = [];
  let cost: number | null = null;
  let stop = false;

  const runOne = async (cand: CandidateSlug) => {
    if (stop) {
      failed.push({ slug: cand.slug, code: "not_started" });
      return;
    }
    // Renew before paying for a call; without the lease, start nothing more.
    if (!(await renewLease())) {
      stop = true;
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
    // This slug's own spend, kept on each unit it drafts.
    let slugCost: number | null = null;
    const addCost = (usage: { inputTokens: number; outputTokens: number }) => {
      const c = estimateCost(provider, model, usage);
      if (c == null) return;
      slugCost = (slugCost ?? 0) + c;
      cost = (cost ?? 0) + c;
    };
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
    const parsed = parseTemplateOutput(text, cand.units.map((u) => u.template_id));
    // Missing, empty, or far longer than its English source: not a template.
    // Readable but dropping or changing a link target or rc link: never
    // written. A dropped slot word is only recorded (placeholder_warnings).
    const sane = new Map<string, string>();
    const warningsById = new Map<string, string[]>();
    let readable = 0;
    let badPlaceholders = 0;
    for (const u of cand.units) {
      const md = parsed.get(u.template_id);
      if (!md || tooLong(md, u.source_md)) continue;
      readable++;
      const check = checkPlaceholders(u.source_md, md);
      if (check.missing.length > 0) {
        badPlaceholders++;
        continue;
      }
      if (check.warnings.length > 0) warningsById.set(u.template_id, check.warnings);
      sane.set(u.template_id, md);
    }
    if (readable === 0) {
      failed.push({ slug: cand.slug, code: "unreadable_output" });
      return;
    }
    if (sane.size === 0) {
      failed.push({ slug: cand.slug, code: "placeholder_missing" });
      return;
    }
    const meta = {
      source: DRAFT_SOURCE,
      approved_note_count: cand.approvedNotes,
      example_count: examples.length,
      draft_change_count: examples.filter((e) => e.aiNote).length,
      provider,
      model,
      // The estimated cost of the whole note type's call(s), NOT this unit's
      // share: every unit the call drafted carries the same value, so summing
      // it across units over-counts. slug_unit_count is how many units the
      // call was asked to draft.
      slug_cost_usd: slugCost,
      slug_unit_count: cand.units.length,
    };
    let written = 0;
    for (const unit of cand.units) {
      const md = sane.get(unit.template_id);
      const warnings = warningsById.get(unit.template_id);
      const unitMeta = warnings ? { ...meta, placeholder_warnings: warnings } : meta;
      if (md && (await writeDraft(env.DB, cand.slug, unit, md, unitMeta, userId))) {
        written++;
        writtenIds.push(unit.template_id);
      }
    }
    // Anything short of every unit written is reported, not counted as done:
    // the units written stay written, and the next press skips the slug once.
    // Nothing written: if some units were rejected for their links, that is
    // the cause to report, not a person's edit.
    if (written === 0) failed.push({ slug: cand.slug, code: badPlaceholders > 0 ? "placeholder_missing" : "not_written" });
    else if (badPlaceholders > 0) failed.push({ slug: cand.slug, code: "placeholder_missing" });
    // Unusable output for some units, or some writes lost their pin to a person.
    else if (written < cand.units.length) failed.push({ slug: cand.slug, code: "partial_output" });
    else drafted.push({ slug: cand.slug, approvedNotes: cand.approvedNotes, units: written });
  };

  // A small pool: RUN_CONCURRENCY calls in flight, each slug written as soon
  // as its own call returns. One slug's unexpected error (D1, bad data) is
  // reported for that slug and the others carry on.
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const cand = batch[next++];
      try {
        await runOne(cand);
      } catch (err) {
        failed.push({ slug: cand.slug, code: "internal_error" });
        const msg = scrubSecrets(err instanceof Error ? err.message : String(err), [apiKey]).slice(0, 300);
        console.error(`draft-missing-templates: ${cand.slug} internal error: ${msg}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, batch.length) }, worker));

  const remaining = (await findCandidateSlugs(env.DB)).length;
  return { drafted, failed, remaining, estimatedCostUsd: cost, written: writtenIds };
}

/** What the button shows before it is pressed. */
export async function draftMissingPreview(env: Env): Promise<Availability & {
  qualifying: { slug: string; approvedNotes: number; units: number }[];
  minApprovedNotes: number;
  batchSize: number;
}> {
  const { availability } = await resolveProvider(env, false);
  const cands = await findCandidateSlugs(env.DB);
  // A workspace DB without migration 0081 cannot take the run lease: say so
  // up front (the button then explains it) instead of letting a press 503.
  let effective: Availability = availability;
  try {
    await env.DB.prepare(`SELECT 1 FROM template_draft_lock LIMIT 1`).first();
  } catch (e) {
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) throw e;
    effective = { available: false, reason: "not_migrated", provider: availability.provider };
  }
  return {
    ...effective,
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

  // Body (optional): { skipSlugs: string[] } — the slugs the previous press
  // reported as failed; they wait this one press (see runBatch).
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
    // If the admin closes the tab, Workers keep the request running for only
    // about 30 seconds more. Slugs that finish in that window are still
    // written; the rest are simply not drafted. The lease is released in the
    // run's own finally, or runs out after RUN_LEASE_SECONDS if the run is cut
    // off first.
    try {
      c.executionCtx.waitUntil(work.catch(() => {}));
    } catch {
      // No ExecutionContext (unit tests).
    }
    const out = await work;
    if (!out.ok) return c.json({ error: out.error, provider: out.provider }, out.error === "not_migrated" ? 503 : 409);
    return c.json(out.result);
  });

  return app;
}
