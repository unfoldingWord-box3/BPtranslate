// Shared predicates + shrink guard for the translation-context pack export.
// Pure (no Hono/D1 imports) so unit tests stay under the strip-types runner.

export type ContextExportStatus =
  | "queued"
  | "success"
  | "failed"
  | "shrink_refused"
  | "no_content"
  | "dry_run";

export type ContextPackStats = {
  terms: number;
  examplesTn: number;
  examplesTq: number;
  templates: number;
  contentFiles: number;
  totalBytes: number;
  /**
   * Bytes the shrink guard compares: every pack file except
   * examples/validated.jsonl, a bounded selection whose size moves as recent
   * chapters change (#813). Null on exports recorded before guard_bytes existed.
   */
  guardBytes?: number | null;
};

export type SuccessfulContextExport = {
  sha: string;
  completedAt: number;
  terms: number;
  examplesTn: number;
  examplesTq: number;
  templates: number;
  contentFiles: number;
  totalBytes: number;
  guardBytes: number | null;
  owner: string;
};

export type ContextFile = { path: string; content: string };

/** Content files excluding manifest.yaml (bot empty-pack check). */
export function contentFileCount(files: readonly ContextFile[]): number {
  return files.filter((f) => f.path !== "manifest.yaml").length;
}

export function totalBytes(files: readonly ContextFile[]): number {
  let n = 0;
  for (const f of files) n += new TextEncoder().encode(f.content).byteLength;
  return n;
}

/** File-level gate: at least one content file besides manifest (bot empty-pack). */
export function hasMinimumContent(files: readonly ContextFile[]): boolean {
  return contentFileCount(files) > 0;
}

/**
 * Semantic gate: scaffold brief.md alone (— placeholders + Register: default)
 * is NOT enough to enable assisted mode. Require at least one real value:
 * non-empty audience/purpose/script_notes, non-default register, instructions,
 * common issues, a terminology row, or a validated example.
 */
export function briefHasSemanticValue(prefs: {
  audience: string | null;
  purpose: string | null;
  register: string;
  script_notes: string | null;
}): boolean {
  if (prefs.audience?.trim()) return true;
  if (prefs.purpose?.trim()) return true;
  if (prefs.script_notes?.trim()) return true;
  if (prefs.register && prefs.register !== "default") return true;
  return false;
}

export function hasSemanticContent(input: {
  prefs: {
    audience: string | null;
    purpose: string | null;
    register: string;
    script_notes: string | null;
    instructions_md: string | null;
    common_issues_md: string | null;
  };
  terms: number;
  examplesTn: number;
  examplesTq: number;
  templates: number;
}): boolean {
  if (briefHasSemanticValue(input.prefs)) return true;
  if (input.prefs.instructions_md?.trim()) return true;
  if (input.prefs.common_issues_md?.trim()) return true;
  if (input.terms > 0) return true;
  if (input.examplesTn + input.examplesTq > 0) return true;
  if (input.templates > 0) return true;
  return false;
}

export type ShrinkDetail = {
  metric: "terms" | "examples" | "templates" | "totalBytes";
  previous: number;
  next: number;
};

/**
 * Semantic shrink guard vs the prior successful pack.
 * Refuse a substantial reduction unless shrinkOverride is set.
 * Thresholds from the plan: terms >5% AND >5; examples >5% AND >3; templates
 * >5% AND >3 (mirrors examples); bytes >10%. Since #813 `examples` counts the
 * validated pool in D1, and the bytes metric compares `guardBytes` (every file
 * except examples/validated.jsonl, a bounded selection whose size moves as
 * recent chapters change). A previous export recorded before guard_bytes
 * existed has no comparable number, so the bytes check is skipped that once.
 * There is deliberately NO contentFiles metric: the renderer omits a pack file
 * iff its D1 source is empty, so a file-count drop is always an intentional
 * clear (e.g. instructions_md emptied) that must be allowed to land — the
 * stale file is then deleted from the repo. Bulk data loss is still covered
 * by the terms/examples/totalBytes metrics.
 */
export function contextShrinkRefused(
  next: ContextPackStats,
  previous: ContextPackStats | null,
): ShrinkDetail | null {
  if (!previous) return null;
  if (previous.terms > 0) {
    const lost = previous.terms - next.terms;
    if (lost > 5 && lost / previous.terms > 0.05) {
      return { metric: "terms", previous: previous.terms, next: next.terms };
    }
  }
  const prevEx = previous.examplesTn + previous.examplesTq;
  const nextEx = next.examplesTn + next.examplesTq;
  if (prevEx > 0) {
    const lost = prevEx - nextEx;
    if (lost > 3 && lost / prevEx > 0.05) {
      return { metric: "examples", previous: prevEx, next: nextEx };
    }
  }
  if (previous.templates > 0) {
    const lost = previous.templates - next.templates;
    if (lost > 3 && lost / previous.templates > 0.05) {
      return { metric: "templates", previous: previous.templates, next: next.templates };
    }
  }
  const prevBytes = previous.guardBytes;
  const nextBytes = next.guardBytes;
  if (prevBytes != null && prevBytes > 0 && nextBytes != null) {
    const lost = prevBytes - nextBytes;
    if (lost / prevBytes > 0.1) {
      return { metric: "totalBytes", previous: prevBytes, next: nextBytes };
    }
  }
  return null;
}

/**
 * Pack files the export owns on {owner}/translation-context@master. Only
 * these may ever be deleted by an export commit — bot-owned namespaces
 * (runs/, candidates/) and the auto_init README.md are untouchable.
 */
export const PACK_MANAGED_PATHS = [
  "manifest.yaml",
  "brief.md",
  "instructions.md",
  "terminology/terms.csv",
  "examples/validated.jsonl",
  "templates/templates.tsv",
] as const;

/**
 * Pack-managed paths absent from this render — i.e. their D1 source is now
 * empty, so any copy still on the branch is stale and must be deleted.
 */
export function stalePackPaths(files: readonly ContextFile[]): string[] {
  const rendered = new Set(files.map((f) => f.path));
  return PACK_MANAGED_PATHS.filter((p) => !rendered.has(p));
}

export function shrinkDetailCode(d: ShrinkDetail): string {
  return `shrink_guard:${d.metric}_${d.previous}->${d.next}`;
}

/** NFC for any string field that may carry Hebrew/Greek (contract §6.3). */
export function nfc(s: string | null | undefined): string {
  return s == null ? "" : String(s).normalize("NFC");
}
