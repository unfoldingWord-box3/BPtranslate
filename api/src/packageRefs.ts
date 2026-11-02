// What a book's notes point at, outside the book itself: the tW articles its
// TWL rows link (plus any its tN notes link inline), the tA articles its notes
// cite (SupportReference and inline rc:// links), and the note templates for the support references its notes
// use, each with its translation state. Feeds bpt_package_status (issue #671).
//
// DELIBERATE EXCEPTION to "MCP tools read through the route handlers"
// (STATE.md, mcpTools.ts header). The routes that list articles and templates
// (articles.ts, templates.ts) require an editor, and the chat session's
// in-process getJson carries no user, so the tool cannot reach them; their
// list routes also return whole tables, not one book's references. This
// module is the narrow, read-only D1 path instead: it only SELECTs, returns
// counts (never article or template text), and reuses collectReferenced from
// articlePopulate.ts so "referenced" means exactly what article population
// fetches. Viewers can link a chat account, so a viewer sees these counts
// through chat even though the web app shows the article and template rails
// only to editors.

import type { Env } from "./index";
import { collectReferenced } from "./articlePopulate.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";

// translation_state as article_units and template_units store it (migrations
// 0039, 0054): NULL until a translation exists, then ai_draft | edited |
// validated.
export type UnitState = "ai_draft" | "edited" | "validated" | null;

// The raw rows a summary is built from. Kept separate from the summary so the
// MCP tests can stub them without a database.
export interface PackageRefRows {
  // Translator mode (the admin's Editor/Translator toggle). In an authoring
  // project articles and templates are not translated, so nothing is read.
  translation: boolean;
  // Distinct articles the book's live rows reference.
  referenced: { resource: "tw" | "ta"; article_id: string }[];
  // Live article parts (a tA article has body, title and sub-title parts).
  articleUnits: { resource: string; article_id: string; translation_state: string | null }[];
  // Distinct support references on the book's live notes, as stored.
  supportRefs: string[];
  // Live template units.
  templateUnits: { support_ref: string; translation_state: string | null }[];
}

export interface StateCounts {
  not_started: number;
  ai_draft: number;
  edited: number;
  validated: number;
}

export interface ArticleRefStatus {
  // Articles the book references.
  referenced: number;
  // Of those, how many are loaded into this project (article population
  // fetches them from the translation source; the rest are not loaded yet).
  loaded: number;
  // States of the loaded ones.
  by_state: StateCounts;
}

export interface TemplateRefStatus {
  // Distinct support references (tA slugs) the book's notes use.
  support_references: number;
  // Of those, how many have at least one note template.
  with_templates: number;
  // Template units for those support references (one reference can have
  // several templates).
  templates: number;
  by_state: StateCounts;
}

export interface PackageRefSummary {
  tw: ArticleRefStatus;
  ta: ArticleRefStatus;
  templates: TemplateRefStatus;
}

// 'rc://*/ta/man/translate/figs-explicit' -> 'figs-explicit'. Server copy of
// web/src/lib/supportReference.ts shortSupport: template_units.support_ref is
// the bare slug (the web matches templates to a note the same way, NoteCard).
export function shortSupport(s: string): string {
  const m = s.trim().match(/\/([^/]+)$/);
  return m ? m[1] : s.trim();
}

const emptyCounts = (): StateCounts => ({ not_started: 0, ai_draft: 0, edited: 0, validated: 0 });

function bump(counts: StateCounts, state: UnitState) {
  counts[state ?? "not_started"] += 1;
}

function asState(s: string | null): UnitState {
  return s === "ai_draft" || s === "edited" || s === "validated" ? s : null;
}

// One article's state from its parts. Same rule as aggregateState in
// web/src/components/ArticleWorkspace.tsx, so chat and the article rail agree:
// any AI draft wins, then any edit; validated once every translated part is
// validated (an untranslated tA title does not block it).
export function articleState(parts: (string | null)[]): UnitState {
  const states = parts.map(asState);
  if (states.includes("ai_draft")) return "ai_draft";
  if (states.includes("edited")) return "edited";
  const translated = states.filter((s) => s != null);
  if (translated.length > 0 && translated.every((s) => s === "validated")) return "validated";
  return null;
}

export function summarizePackageRefs(rows: PackageRefRows): PackageRefSummary {
  const parts = new Map<string, (string | null)[]>();
  for (const u of rows.articleUnits) {
    const k = `${u.resource}\u0000${u.article_id}`;
    const list = parts.get(k);
    if (list) list.push(u.translation_state);
    else parts.set(k, [u.translation_state]);
  }
  const articles = (resource: "tw" | "ta"): ArticleRefStatus => {
    const ids = new Set(rows.referenced.filter((r) => r.resource === resource).map((r) => r.article_id));
    const out: ArticleRefStatus = { referenced: ids.size, loaded: 0, by_state: emptyCounts() };
    for (const id of ids) {
      const p = parts.get(`${resource}\u0000${id}`);
      if (!p) continue;
      out.loaded += 1;
      bump(out.by_state, articleState(p));
    }
    return out;
  };

  const slugs = new Set(rows.supportRefs.map(shortSupport).filter(Boolean));
  const templates: TemplateRefStatus = {
    support_references: slugs.size,
    with_templates: 0,
    templates: 0,
    by_state: emptyCounts(),
  };
  const covered = new Set<string>();
  for (const t of rows.templateUnits) {
    const slug = shortSupport(t.support_ref);
    if (!slugs.has(slug)) continue;
    covered.add(slug);
    templates.templates += 1;
    bump(templates.by_state, asState(t.translation_state));
  }
  templates.with_templates = covered.size;

  return { tw: articles("tw"), ta: articles("ta"), templates };
}

// Read-only. Whole-table reads of the light columns, joined in JS: the
// reference lists can run to hundreds of ids, past D1's 100 bound-parameter
// cap, and the web's list routes read these tables whole too.
export async function readPackageRefs(env: Env, book: string): Promise<PackageRefRows> {
  const translation = isTranslationConfig(await getProjectConfig(env));
  if (!translation) return { translation, referenced: [], articleUnits: [], supportRefs: [], templateUnits: [] };

  const [paths, units, sup, tpl] = await Promise.all([
    collectReferenced(env, book),
    env.DB.prepare(
      `SELECT resource, article_id, translation_state FROM article_units
        WHERE resource IN ('tw','ta') AND deleted_at IS NULL`,
    ).all<PackageRefRows["articleUnits"][number]>(),
    env.DB.prepare(
      `SELECT DISTINCT support_reference AS v FROM tn_rows
        WHERE book = ?1 AND support_reference IS NOT NULL AND support_reference <> ''
          AND deleted_at IS NULL AND trashed_at IS NULL`,
    )
      .bind(book)
      .all<{ v: string }>(),
    env.DB.prepare(
      `SELECT support_ref, translation_state FROM template_units WHERE deleted_at IS NULL`,
    ).all<PackageRefRows["templateUnits"][number]>(),
  ]);

  const seen = new Set<string>();
  const referenced: PackageRefRows["referenced"] = [];
  for (const p of paths) {
    const k = `${p.resource}\u0000${p.article_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    referenced.push({ resource: p.resource, article_id: p.article_id });
  }
  return {
    translation,
    referenced,
    articleUnits: units.results ?? [],
    supportRefs: (sup.results ?? []).map((r) => r.v),
    templateUnits: tpl.results ?? [],
  };
}
