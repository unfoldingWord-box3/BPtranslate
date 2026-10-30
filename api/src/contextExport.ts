// Pure renderer for the {org}/translation-context pack (CONTEXT-REPO-CONTRACT.md).
// No DCS / Hono imports — EN source maps are injected by the caller so unit
// tests stay fixture-driven. Workflow orchestration lives in exportWorkflow.

import { exportOwnerFor, type ProjectConfig } from "./projectConfig.ts";
import { serializeTermsCsv, type TermImport } from "./translationMemoryLib.ts";
import {
  contentFileCount,
  hasMinimumContent,
  hasSemanticContent,
  nfc,
  totalBytes,
  type ContextFile,
  type ContextPackStats,
} from "./contextExportLib.ts";

export type { ContextFile, ContextPackStats };
export { contentFileCount, hasMinimumContent, hasSemanticContent, totalBytes };

export type TranslationPrefsForRender = {
  audience: string | null;
  purpose: string | null;
  register: string;
  script_notes: string | null;
  instructions_md: string | null;
  common_issues_md: string | null;
};

export type ValidatedTnRow = {
  id: string;
  book: string;
  ref_raw: string | null;
  support_reference: string | null;
  quote: string | null;
  note: string | null;
  updated_at: number;
};

export type ValidatedTqRow = {
  id: string;
  book: string;
  ref_raw: string | null;
  question: string | null;
  response: string | null;
  updated_at: number;
};

/**
 * The few-shot gold selectors: which rows become `examples/validated.jsonl` in
 * the nightly context-repo export. Named constants (rather than SQL inlined in
 * exportWorkflow.ts) so the exclusion rule below has one home and can be
 * asserted in contextExport.test.mjs.
 *
 * `translation_state = 'validated'` alone is NOT enough to call a row
 * human-approved gold. Two code paths write that state in BULK, about a body of
 * imported work rather than about any row someone actually read:
 *   * the admin bulk review-state sweep (reviewState.ts, issue #296), and
 *   * the Aquifer importer's heuristic approve (aquiferImport.ts, issue #393).
 * Both stamp `admin_bulk_state` (migration 0071), and `admin_bulk_state IS NULL`
 * here is what keeps them out of the training set. A row approved one-at-a-time
 * through POST /api/rows/{tn,tq}/:id/validate carries no stamp and is gold, as
 * before.
 *
 * If you add a THIRD bulk approver, stamp it too — or this comment becomes a
 * lie and unreviewed rows start teaching the model.
 */
export const VALIDATED_TN_EXAMPLES_SQL = `SELECT id, book, ref_raw, support_reference, quote, note, updated_at
     FROM tn_rows
    WHERE translation_state = 'validated'
      AND admin_bulk_state IS NULL
      AND deleted_at IS NULL AND trashed_at IS NULL`;

export const VALIDATED_TQ_EXAMPLES_SQL = `SELECT id, book, ref_raw, question, response, updated_at
     FROM tq_rows
    WHERE translation_state = 'validated'
      AND admin_bulk_state IS NULL
      AND deleted_at IS NULL`;

export type TemplateForRender = {
  support_ref: string;
  type: string | null;
  target_md: string | null;
  sheet_order: number | null;
  template_id: string;
};

// The D1 reads a context pack renders from. Kept in one loader so the export
// can re-read after fetching master's tip and compare (#712): a pack commits
// only if D1, read after the tip fetch, still matches what was rendered.
export type ContextPackInputs = {
  prefs: TranslationPrefsForRender;
  terms: TermImport[];
  tnRows: ValidatedTnRow[];
  tqRows: ValidatedTqRow[];
  templates: TemplateForRender[];
};

type InputsDb = {
  prepare(sql: string): {
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results?: T[] }>;
  };
};

export async function loadContextPackInputs(db: InputsDb): Promise<ContextPackInputs> {
  const prefsRow = await db.prepare(
    `SELECT audience, purpose, register, script_notes, instructions_md, common_issues_md
       FROM translation_prefs WHERE id = 1`,
  ).first<TranslationPrefsForRender>();
  const prefs: TranslationPrefsForRender = prefsRow ?? {
    audience: null,
    purpose: null,
    register: "default",
    script_notes: null,
    instructions_md: null,
    common_issues_md: null,
  };

  const termRs = await db.prepare(
    `SELECT concept_id, source_term, target_term, status, replacement, comment, tw_link
       FROM terminology WHERE deleted_at IS NULL
       ORDER BY concept_id, source_term, status`,
  ).all<TermImport>();

  // Selectors carry the `admin_bulk_state IS NULL` rule that keeps
  // bulk-approved rows out of the few-shot gold (see the SQL above).
  const tnRs = await db.prepare(VALIDATED_TN_EXAMPLES_SQL).all<ValidatedTnRow>();
  const tqRs = await db.prepare(VALIDATED_TQ_EXAMPLES_SQL).all<ValidatedTqRow>();

  const templateRs = await db.prepare(
    `SELECT template_id, support_ref, sheet_order, type, target_md
       FROM template_units
      WHERE translation_state = 'validated'
        AND deleted_at IS NULL
        AND origin = 'sheet'
        AND target_md IS NOT NULL AND TRIM(target_md) <> ''
      ORDER BY support_ref, sheet_order, template_id`,
  ).all<TemplateForRender>();

  return {
    prefs,
    terms: termRs.results ?? [],
    tnRows: tnRs.results ?? [],
    tqRows: tqRs.results ?? [],
    templates: templateRs.results ?? [],
  };
}

// Order-insensitive for the example rows, whose SQL has no ORDER BY.
function rowsKey(rows: readonly unknown[]): string[] {
  return rows.map((r) => JSON.stringify(r)).sort();
}

export function sameContextPackInputs(a: ContextPackInputs, b: ContextPackInputs): boolean {
  const key = (x: ContextPackInputs) =>
    JSON.stringify([x.prefs, x.terms, x.templates, rowsKey(x.tnRows), rowsKey(x.tqRows)]);
  return key(a) === key(b);
}

// True when the validated tN/tQ example rows differ, so the EN source maps
// fetched for them must be fetched again.
export function exampleRowsChanged(a: ContextPackInputs, b: ContextPackInputs): boolean {
  return (
    JSON.stringify([rowsKey(a.tnRows), rowsKey(a.tqRows)]) !==
    JSON.stringify([rowsKey(b.tnRows), rowsKey(b.tqRows)])
  );
}

/**
 * Composite key for EN source maps. tN/tQ row IDs are only unique per book
 * (migration 0015 composite PK), so keying by bare `id` would let identical
 * 4-char IDs from different books overwrite each other and pair the wrong
 * English source into validated.jsonl.
 */
export function sourceRowKey(book: string, id: string): string {
  return `${book.toUpperCase()}:${id}`;
}

/** EN source text already resolved by book:id (book-batched upstream). */
export type EnSourceMaps = {
  tn: Map<string, { note: string; quote: string | null }>;
  tq: Map<string, { question: string; response: string }>;
};

export type ContextPackRenderOk = {
  ok: true;
  files: ContextFile[];
  stats: ContextPackStats;
};

export type ContextPackRenderErr = {
  ok: false;
  reason: string;
};

export type ContextPackRender = ContextPackRenderOk | ContextPackRenderErr;

export function renderManifestYaml(opts: {
  languageCode: string;
  direction: "ltr" | "rtl";
  exportedAt: Date;
}): string {
  const exported_at = opts.exportedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    "format: 1",
    `language: ${opts.languageCode}`,
    `direction: ${opts.direction}`,
    `exported_at: ${exported_at}`,
    "exported_by: bible-editor",
    "",
  ].join("\n");
}

export function renderBriefMd(
  prefs: TranslationPrefsForRender,
  languageTitle: string,
  languageCode: string,
): string {
  const register = prefs.register || "default";
  return [
    `# Translation brief — ${languageTitle} (${languageCode})`,
    "",
    `**Audience:** ${prefs.audience?.trim() || "—"}`,
    `**Purpose:** ${prefs.purpose?.trim() || "—"}`,
    `**Register:** ${register}`,
    `**Script / direction notes:** ${prefs.script_notes?.trim() || "—"}`,
    "",
  ].join("\n");
}

/**
 * instructions.md is the one pack file the bot injects verbatim into every
 * drafting prompt, so "common issues" rides along inside it under its own
 * heading rather than as a new top-level file — per CONTEXT-REPO-CONTRACT §5
 * readers ignore files they don't know, so a `common-issues.md` would be
 * written and never read. Split it out when the bot grows a reader (§7).
 */
export function renderInstructionsMd(prefs: TranslationPrefsForRender): string | null {
  const instructions = prefs.instructions_md?.trim();
  const commonIssues = prefs.common_issues_md?.trim();
  if (!instructions && !commonIssues) return null;
  const parts: string[] = [];
  if (instructions) parts.push(instructions);
  if (commonIssues) parts.push(`## Common issues\n\n${commonIssues}`);
  const content = parts.join("\n\n");
  return content.endsWith("\n") ? content : `${content}\n`;
}

export type JsonlExample = {
  resource: "tn" | "tq";
  rowId: string;
  book: string;
  ref: string;
  supportReference: string | null;
  source: string;
  target: string;
  validated_at: number;
};

/**
 * Build validated.jsonl lines. Fail-closed: any validated row without a
 * matching EN source aborts the whole pack (never publish partial English).
 */
export function buildValidatedExamples(
  tnRows: readonly ValidatedTnRow[],
  tqRows: readonly ValidatedTqRow[],
  sources: EnSourceMaps,
  // Resources ("tn"/"tq") whose upstream source repo was left blank in Setup:
  // their rows have no EN source to pair against, so they are SKIPPED (no
  // examples, and NOT treated as missing_en_source). A resource is either fully
  // sourced or fully skipped — never a mix.
  skipped: readonly string[] = [],
): { ok: true; lines: JsonlExample[] } | { ok: false; reason: string } {
  const lines: JsonlExample[] = [];
  if (!skipped.includes("tn")) {
    for (const r of tnRows) {
      const key = sourceRowKey(r.book, r.id);
      const src = sources.tn.get(key);
      if (!src) return { ok: false, reason: `missing_en_source:tn:${key}` };
      if (!src.note.trim()) return { ok: false, reason: `empty_en_source:tn:${key}` };
      const target = (r.note ?? "").trim();
      if (!target) return { ok: false, reason: `empty_target:tn:${key}` };
      lines.push({
        resource: "tn",
        rowId: r.id,
        book: r.book,
        ref: r.ref_raw ?? "",
        supportReference: r.support_reference,
        source: nfc(src.note),
        target: nfc(target),
        validated_at: r.updated_at,
      });
    }
  }
  if (!skipped.includes("tq")) {
    for (const r of tqRows) {
      const key = sourceRowKey(r.book, r.id);
      const src = sources.tq.get(key);
      if (!src) return { ok: false, reason: `missing_en_source:tq:${key}` };
      const srcQ = src.question.trim();
      const srcR = src.response.trim();
      if (!srcQ && !srcR) return { ok: false, reason: `empty_en_source:tq:${key}` };
      const target = `${(r.question ?? "").trim()}\t${(r.response ?? "").trim()}`;
      if (!target.trim()) return { ok: false, reason: `empty_target:tq:${key}` };
      lines.push({
        resource: "tq",
        rowId: r.id,
        book: r.book,
        ref: r.ref_raw ?? "",
        supportReference: null,
        source: nfc(`${srcQ}\t${srcR}`),
        target: nfc(target),
        validated_at: r.updated_at,
      });
    }
  }
  // Append-ordered by validation time (most recent last) per contract §3.4.
  lines.sort((a, b) => a.validated_at - b.validated_at);
  return { ok: true, lines };
}

export function renderValidatedJsonl(lines: readonly JsonlExample[]): string {
  if (lines.length === 0) return "";
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/**
 * Flatten a TSV field: NFC-normalize, collapse any tab/CR/LF runs to a single
 * space (a raw tab or newline would corrupt the row layout), then trim.
 */
export function tsvField(s: string | null | undefined): string {
  return nfc(s).replace(/[\t\r\n]+/g, " ").trim();
}

/**
 * Build templates/templates.tsv — one row per support_ref (contract §3.5).
 * Input arrives pre-sorted (support_ref, sheet_order, template_id); the FIRST
 * unit per support_ref wins and later variants for the same slug are skipped.
 * Units with empty/whitespace-only target_md are skipped (not yet translated).
 */
export function renderTemplatesTsv(units: readonly TemplateForRender[]): string | null {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const u of units) {
    // Key the dedupe on the FLATTENED slug — that's what the row emits, and
    // the bot's parser is last-duplicate-wins, so two raw slugs differing only
    // by whitespace must not produce two rows. Claim the slug only once a
    // non-empty target is in hand: SQLite TRIM() strips spaces only, so a
    // tab/newline-only target_md survives the SQL filter, flattens to empty
    // here, and must not block a later valid variant of the same slug.
    const slug = tsvField(u.support_ref);
    if (!slug || seen.has(slug)) continue;
    const target = tsvField(u.target_md);
    if (!target) continue;
    seen.add(slug);
    rows.push(`${slug}\t${target}\tactive\t${tsvField(u.type ?? "")}`);
  }
  if (rows.length === 0) return null;
  return ["support_reference\ttarget_template\tstatus\tcomment", ...rows].join("\n") + "\n";
}

/**
 * Assemble the full pack from pre-fetched prefs/terms/rows + EN source maps.
 * Omits optional empty files (instructions, examples). Always writes manifest.
 */
export function renderContextPack(input: {
  cfg: ProjectConfig;
  prefs: TranslationPrefsForRender;
  terms: readonly TermImport[];
  tnRows: readonly ValidatedTnRow[];
  tqRows: readonly ValidatedTqRow[];
  sources: EnSourceMaps;
  templates: readonly TemplateForRender[];
  // Resources with no upstream source (blank in Setup) — their rows are skipped
  // rather than tripping missing_en_source. See fetchEnSourceMaps / buildValidatedExamples.
  skipped?: readonly string[];
  exportedAt?: Date;
}): ContextPackRender {
  const exportedAt = input.exportedAt ?? new Date();
  const examples = buildValidatedExamples(input.tnRows, input.tqRows, input.sources, input.skipped ?? []);
  if (!examples.ok) return { ok: false, reason: examples.reason };

  const files: ContextFile[] = [];
  files.push({
    path: "manifest.yaml",
    content: renderManifestYaml({
      languageCode: input.cfg.languageCode,
      direction: input.cfg.direction,
      exportedAt,
    }),
  });

  // brief.md always present when we have prefs fields or as scaffold — the
  // register line is machine-readable even with empty prose. Always emit.
  files.push({
    path: "brief.md",
    content: renderBriefMd(
      input.prefs,
      input.cfg.languageTitle || input.cfg.languageName,
      input.cfg.languageCode,
    ),
  });

  const instructionsContent = renderInstructionsMd(input.prefs);
  if (instructionsContent) {
    files.push({ path: "instructions.md", content: instructionsContent });
  }

  if (input.terms.length > 0) {
    files.push({ path: "terminology/terms.csv", content: serializeTermsCsv([...input.terms]) });
  }

  if (examples.lines.length > 0) {
    files.push({ path: "examples/validated.jsonl", content: renderValidatedJsonl(examples.lines) });
  }

  const templatesTsv = renderTemplatesTsv(input.templates);
  const templatesRowCount = templatesTsv ? templatesTsv.trim().split("\n").length - 1 : 0;
  if (templatesTsv) {
    files.push({ path: "templates/templates.tsv", content: templatesTsv });
  }

  const stats: ContextPackStats = {
    terms: input.terms.length,
    examplesTn: examples.lines.filter((l) => l.resource === "tn").length,
    examplesTq: examples.lines.filter((l) => l.resource === "tq").length,
    templates: templatesRowCount,
    contentFiles: contentFileCount(files),
    totalBytes: totalBytes(files),
  };

  return { ok: true, files, stats };
}

/** Owner for the context repo and contextRef — mirrors article export. */
export function contextRepoOwner(env: { DCS_EXPORT_OWNER?: string }, cfg: ProjectConfig): string {
  return exportOwnerFor(env, cfg);
}

export function contextRepoName(): string {
  return "translation-context";
}

export function buildContextRef(owner: string, sha: string): string {
  return `${owner}/${contextRepoName()}@${sha}`;
}
