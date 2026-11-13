// Pure builder for the bp-assistant `translate` pipeline options, extracted from
// pipelines.ts so it can be unit-tested without importing the Hono route module
// (whose extensionless imports don't resolve under the node strip-types runner —
// same reason pipelineImportClaim.ts is split out from pipelineImport.ts).
//
// Contract of record: bp-bot/translate-pipeline/{PLAN.md,BIBLE-EDITOR-INTEGRATION.md}.

import type { ProjectConfig } from "./projectConfig.ts";
import { resolveSourceRef } from "./dcsSources.ts";

// Canonicalize a row-scope selection to a stable, order-independent set so two
// requests for the same rows (in any order, with duplicates) compare equal.
// Returns undefined for a chapter-wide job (no rows) — callers omit the field
// entirely in that case, and the dedupe query treats "no $.rowIds" as the
// chapter-wide scope. Persisting the sorted+deduped form is what lets the start
// route's dedupe compare row scope as plain `json_extract` text (SQLite and
// JSON.stringify serialize an array of these short ids identically), so a
// row-scoped translate for a DIFFERENT row no longer collides with another
// row's in-flight job. See issue #316.
export function normalizeRowIds(rowIds: string[] | undefined): string[] | undefined {
  if (!rowIds || rowIds.length === 0) return undefined;
  return [...new Set(rowIds)].sort();
}

// Client-supplied overrides (a top-level `translate:{…}` field on the start body).
export type TranslateClientOptions = {
  // Which resource to translate. Row-keyed TSV: tn (default) | tq. Markdown
  // article: tw | ta (scoped by articleId/articleUrl instead of book/chapter).
  resourceType?: "tn" | "tq" | "tw" | "ta";
  // Article selector (tw|ta only) — exactly one. articleId is a name
  // ('kt/god', 'translate/figs-aside'); articleUrl is a git.door43.org URL.
  articleId?: string;
  articleUrl?: string;
  model?: "sonnet" | "opus";
  delivery?: "path" | "branch" | "editor";
  branchOnly?: boolean;
  direction?: "ltr" | "rtl";
  rowIds?: string[];
  verseStart?: number;
  verseEnd?: number;
  targetLang?: string;
  targetOrg?: string;
  sourceRef?: string;
  contextRef?: string;
  // Target-language literal / simplified Bible refs (org/repo@ref) the bot uses
  // to make bold-quote and alternate-translation wording match the target Bible.
  literalRef?: string;
  simplifiedRef?: string;
};

// Build the bp-assistant `translate` options from the active project config,
// folding in any client overrides. Contract: PLAN.md §1 — the bot fetches the
// source rows BY REFERENCE (sourceRef), so nothing is gathered from D1 here
// (unlike the notes-hints path). Returns null if the project has no
// translationSource (the English root project can't be a translate TARGET) —
// the caller turns that into a 400.
export function buildTranslateOptions(
  cfg: ProjectConfig,
  overrides: TranslateClientOptions | undefined,
): Record<string, unknown> | null {
  const src = cfg.translationSource;
  if (!src) return null; // not a gateway-language project → can't translate INTO it
  const o = overrides ?? {};
  const resourceType = o.resourceType ?? "tn";
  const targetLang = o.targetLang ?? cfg.languageCode;
  const targetOrg = o.targetOrg ?? cfg.exportOrg;
  // Source is the published source repo for the chosen resource, pinned to master
  // by default; a caller can pin an exact SHA for reproducibility (the bot echoes
  // the resolved SHA). resourceType selects which source repo (tn|tq|tw|ta).
  // translationSource.repos is PARTIAL and per-resource: a role whose upstream
  // was left blank in Setup is omitted (NO source to translate FROM), and a role
  // may point at a DIFFERENT org than src.org. Resolve org+repo through the
  // shared accessor; emit no options (return null → caller 400) when there's no
  // ref rather than a `${org}/undefined@master`. An explicit client sourceRef
  // override still wins.
  const resolved = resolveSourceRef(src, resourceType);
  if (!o.sourceRef && !resolved) return null;
  const sourceRef = o.sourceRef ?? `${resolved!.org}/${resolved!.repo}@master`;
  const literalRef = o.literalRef ?? (cfg.repos.lit ? `${cfg.org}/${cfg.repos.lit}@master` : undefined);
  const simplifiedRef = o.simplifiedRef ?? (cfg.repos.sim ? `${cfg.org}/${cfg.repos.sim}@master` : undefined);
  return {
    resourceType,
    targetLang,
    targetOrg,
    sourceRef,
    // contextRef is OPT-IN, not auto-derived. Per the live bot's
    // BIBLE-EDITOR-INTEGRATION.md §4: any caller-supplied contextRef is treated
    // as an explicit demand, and the bot FAILS the run with "context pack has no
    // content files" if that repo isn't populated yet. Auto-sending
    // `${cfg.org}/translation-context@master` therefore breaks every live run
    // until the context repo exists. Omitting it lets the bot default internally,
    // detect the repo's absence, and proceed as a raw baseline (warn, don't fail).
    // Once {org}/translation-context is created + populated (CONTEXT-REPO-CONTRACT.md),
    // a caller enables assisted output by passing translate.contextRef explicitly.
    ...(o.contextRef ? { contextRef: o.contextRef } : {}),
    ...(literalRef ? { literalRef } : {}),
    ...(simplifiedRef ? { simplifiedRef } : {}),
    // Editor delivery — the bot never pushes to Door43; it records an output
    // manifest and the editor pulls the files over the authenticated output
    // endpoint, applying them as ai_draft rows (docs/plan Design 1). 'branch'
    // remains accepted as an explicit expert override for one release.
    delivery: o.delivery ?? "editor",
    branchOnly: o.branchOnly ?? true,
    model: o.model ?? "opus",
    direction: o.direction ?? cfg.direction,
    // Persist the normalized (sorted + deduped) set so the start route's dedupe
    // can key on row scope; sending a sorted set to the bot is harmless (it's a
    // set — order/duplicates are irrelevant to update-by-ID merge). #316.
    ...(normalizeRowIds(o.rowIds) ? { rowIds: normalizeRowIds(o.rowIds) } : {}),
    ...(o.verseStart != null ? { verseStart: o.verseStart } : {}),
    ...(o.verseEnd != null ? { verseEnd: o.verseEnd } : {}),
    // Article selector (tw|ta) — passed through to the bot's articles envelope.
    ...(o.articleId ? { articleId: o.articleId } : {}),
    ...(o.articleUrl ? { articleUrl: o.articleUrl } : {}),
  };
}
