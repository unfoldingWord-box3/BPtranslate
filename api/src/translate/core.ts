// core.ts — deterministic core of the translate runner.
//
// Ported from bp-assistant src/lib/translate-core.js (issue #445, design
// docs/translate-internal-runner.md §A). Everything here is pure logic; the
// LLM call is the caller's. Two families:
//   - TSV resources (tN, tQ): fetch + slice source rows, batch, render the
//     per-batch context pack, parse/validate model output, merge the chapter
//     into the whole-book target. Column schema is a parameter (default tN).
//   - Article resources (tW, tA): render the per-article pack, build the
//     source markdown + task, parse/validate the translated markdown.
//
// What changed from the bot (and why):
//   - `translateSessionSuffix` dropped (bot checkpoint/job-id scoping).
//   - The fs seam — writeBatchFiles / writeArticleFiles / readBatchOutput /
//     readArticleOutput — is replaced by in-memory equivalents:
//     buildBatchArtifacts / buildArticleArtifacts produce the exact file
//     CONTENTS the bot wrote (source TSV, pack markdown, task JSON) under
//     logical names (batch-01.tsv …) instead of absolute paths; the Workflow
//     step persists them to R2. validateBatchOutput / validateArticleOutput
//     take the model reply text instead of an output path. The pass-through
//     copy-back (translate-core.js:352-360) is kept verbatim.
//   - `tsvResource()` (the per-run resource descriptor with codec + check
//     options + batch weight) moved here from translate-pipeline.js:309-320.

import {
  parseTnTsv, serializeTnTsv, refChapter, refVerseRange, sliceChapterRows, makeTsvCodec,
  type TsvRow, type TsvCodec,
} from "./tsvCodec.ts";
import { runChecks, runArticleChecks, PASS_THROUGH_COLUMNS, type CheckOpts, type CheckResult } from "./checks.ts";
import { getTsvResourceType } from "./resourceTypes.ts";
import type { FetchLike, PackExample, PackTemplate } from "./contextPack.ts";

export { sliceChapterRows };

const DCS_BASE = "https://git.door43.org";

// Batch bounds: rows are cheap to pass through but free-text columns vary from
// one line to a 5 KB book intro. Cap by both row count and cumulative
// translate-column size so a batch stays well inside one focused model call.
export const BATCH_MAX_ROWS = 15;
export const BATCH_MAX_NOTE_CHARS = 7000;

// Few-shot budget per batch (CONTEXT-REPO-CONTRACT.md §3.4 — start at 15).
export const MAX_EXAMPLES_PER_BATCH = 15;

/** Minimal pack shape the renderers read; a full ContextPack satisfies it. */
export type RenderPack = {
  register?: string | null;
  brief?: string | null;
  instructions?: string | null;
  standards?: string | null;
  terms?: readonly PackTermLike[];
  templates: Map<string, Pick<PackTemplate, "template">>;
  examples?: readonly PackExampleLike[];
};
export type PackTermLike = {
  source: string;
  target: string;
  status: string;
  replacement?: string;
  comment?: string;
};
export type PackExampleLike = Pick<PackExample, "source" | "target"> & {
  supportReference?: string | null;
  validated_at: number;
  _seq?: number;
};

export type ScriptureVersion = {
  role: "source-literal" | "source-simplified" | "target-literal" | "target-simplified";
  label: string;
  byRef: Record<string, string>;
};
export type ScripturePack = {
  versions: ScriptureVersion[];
  targetLiteralFound: boolean;
  targetSimplifiedFound: boolean;
};

export function slugFromSupportReference(sr: unknown): string | null {
  if (!sr) return null;
  const m = /([a-z0-9-]+)\s*$/i.exec(String(sr).trim());
  return m ? m[1] : null;
}

/** Format terminology sections from the concept-oriented status vocab. */
export function renderTerminologySections(terms: readonly PackTermLike[]): string[] {
  const preferred = terms.filter((t) => t.status === "preferred");
  const admitted = terms.filter((t) => t.status === "admitted");
  const deprecated = terms.filter((t) => t.status === "deprecated");
  const forbidden = terms.filter((t) => t.status === "forbidden");
  const doNotTranslate = terms.filter((t) => t.status === "do_not_translate");
  const parts: string[] = [];

  if (preferred.length) {
    parts.push("## Terminology — HARD CONSTRAINTS (preferred renderings; always use these)\n\n"
      + preferred.map((t) => `- "${t.source}" → "${t.target}"${t.comment ? ` (${t.comment})` : ""}`).join("\n"));
  }
  if (admitted.length) {
    parts.push("## Terminology — admitted (valid; prefer a preferred sibling when drafting fresh)\n\n"
      + admitted.map((t) => `- "${t.source}" → "${t.target}"`).join("\n"));
  }
  if (forbidden.length) {
    parts.push("## Terminology — FORBIDDEN (never emit; use the replacement)\n\n"
      + forbidden.map((t) => `- never "${t.target || t.source}"; use "${t.replacement || "?"}" instead`
        + `${t.comment ? ` (${t.comment})` : ""}`).join("\n"));
  }
  if (deprecated.length) {
    parts.push("## Terminology — deprecated (do not emit in new drafts)\n\n"
      + deprecated.map((t) => `- do not use "${t.target}" for "${t.source}"`).join("\n"));
  }
  if (doNotTranslate.length) {
    parts.push("## Terminology — do not translate (leave the source term as-is)\n\n"
      + doNotTranslate.map((t) => `- leave "${t.source}" untranslated / untransliterated`).join("\n"));
  }
  return parts;
}

/** Select up to N live examples: SupportReference match first, then recency. */
export function selectExamples<E extends PackExampleLike>(
  examples: readonly E[] | undefined,
  slugs: readonly string[] | undefined,
  max = MAX_EXAMPLES_PER_BATCH,
): E[] {
  const live = (examples || []).slice().sort(
    (a, b) => (b.validated_at - a.validated_at) || ((b._seq || 0) - (a._seq || 0)));
  const slugSet = new Set(slugs || []);
  const bySlug = live.filter((e) => {
    const slug = slugFromSupportReference(e.supportReference);
    return slug !== null && slugSet.has(slug);
  });
  const picked = new Set(bySlug); // a Set: the examples file can hold ~20k rows
  const general = live.filter((e) => !picked.has(e));
  return [...bySlug, ...general].slice(0, max);
}

export type PackRenderContext = {
  pack: RenderPack;
  targetLang: string;
  targetLangName: string;
  direction: string;
};

export function renderPackPreamble({ pack, targetLang, targetLangName, direction }: PackRenderContext): string[] {
  const parts: string[] = [];
  parts.push(`# Translation context — ${targetLangName} (${targetLang}, ${direction === "rtl" ? "right-to-left" : "left-to-right"})`);
  if (pack.register) {
    parts.push(`## Formality register\n\nUse **${pack.register}** register throughout this draft.`);
  }
  if (pack.brief) parts.push(`## Translation brief\n\n${pack.brief.trim()}`);
  if (pack.instructions) parts.push(`## Standing instructions\n\n${pack.instructions.trim()}`);
  if (pack.standards) parts.push(`## Quality standards (self-check your drafts against these)\n\n${pack.standards.trim()}`);
  parts.push(...renderTerminologySections(pack.terms || []));
  return parts;
}

/**
 * Reject a short read against the declared Content-Length — the same guard
 * dcsSources.fetchText applies to the editor's own DCS reads, here for the
 * translate runner's. A truncated 200 treated as content is the twl_PSA
 * data-loss signature: the merge base looks small, so the merged book silently
 * drops every row the truncated tail carried. No declared length means
 * completeness is unverifiable at this layer (the HAB blind spot); the caller's
 * shrink guard is the backstop for that case.
 */
function assertCompleteBody(
  url: string,
  text: string,
  res: { headers?: { get(name: string): string | null } | null },
): void {
  const raw = typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
  const expected = raw == null ? null : Number(raw);
  if (expected == null || !Number.isFinite(expected) || expected < 0) return;
  const got = new TextEncoder().encode(text).length;
  if (got < expected) {
    throw new Error(`fetch ${url} → truncated body (${got} of ${expected} declared bytes)`);
  }
}

/** Fetch a file from DCS at a pinned ref ("org/repo@ref"); null on 404. */
export async function fetchResourceFile(
  sourceRef: string,
  filename: string,
  { fetchImpl }: { fetchImpl?: FetchLike } = {},
): Promise<string | null> {
  const m = /^([^/@\s]+)\/([^/@\s]+)@(.+)$/.exec(String(sourceRef || "").trim());
  if (!m) throw new Error(`sourceRef must be "org/repo@ref", got: ${sourceRef}`);
  const [, org, repo, ref] = m;
  const kind = /^[0-9a-f]{40}$/i.test(ref) ? "commit" : "branch";
  const url = `${DCS_BASE}/${org}/${repo}/raw/${kind}/${encodeURIComponent(ref)}/${filename}`;
  const res = await (fetchImpl || (fetch as unknown as FetchLike))(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const text = await res.text();
  assertCompleteBody(url, text, res);
  return text;
}

/** Fetch a whole tN book TSV from DCS at a pinned ref (back-compat wrapper). */
export async function fetchTnBook(sourceRef: string, book: string, opts: { fetchImpl?: FetchLike } = {}): Promise<string | null> {
  return fetchResourceFile(sourceRef, `tn_${book.toUpperCase()}.tsv`, opts);
}

/**
 * Split rows into batches bounded by count and cumulative translate-column
 * size. sizeOf(row) returns the char weight (default = the tN Note column).
 */
export function buildBatches<T extends TsvRow>(
  rows: readonly T[],
  { maxRows = BATCH_MAX_ROWS, maxNoteChars = BATCH_MAX_NOTE_CHARS, sizeOf }: { maxRows?: number; maxNoteChars?: number; sizeOf?: (r: T) => number } = {},
): T[][] {
  const weight = sizeOf || ((r: T) => (r.Note || "").length);
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const row of rows) {
    const len = weight(row);
    if (current.length > 0 && (current.length >= maxRows || chars + len > maxNoteChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(row);
    chars += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

export type RenderedPack = { markdown: string; templateFallbacks: string[]; slugs: string[] };

/**
 * Render the per-batch context markdown the model reads. Deterministic
 * selection happens HERE (in code), not in the prompt, so runs are reproducible
 * given (sourceRef, contextRef). `sourceLangName` (default English) makes the
 * wording source-language-agnostic (a future Russian→Georgian run says
 * "Russian source").
 */
export function renderBatchPack({
  batchRows, pack, targetLang, targetLangName, direction, sourceLangName = "English", scripture,
}: PackRenderContext & { batchRows: readonly TsvRow[]; sourceLangName?: string; scripture?: ScripturePack | null }): RenderedPack {
  const slugs = [...new Set(batchRows.map((r) => slugFromSupportReference(r.SupportReference)).filter((s): s is string => Boolean(s)))];

  const templateLines: string[] = [];
  const templateFallbacks: string[] = [];
  for (const slug of slugs) {
    const t = pack.templates.get(slug); // Map only holds status=active
    if (t) templateLines.push(`- \`${slug}\`: ${t.template}`);
    else templateFallbacks.push(slug);
  }

  const examples = selectExamples(pack.examples, slugs);

  const parts = renderPackPreamble({ pack, targetLang, targetLangName, direction });

  if (templateLines.length) {
    parts.push("## Note templates for this batch\n\nEach note type has a standard phrasing pattern in "
      + `${targetLangName}. Follow the matching template's structure:\n\n` + templateLines.join("\n"));
  }
  if (templateFallbacks.length) {
    parts.push("## Untranslated note types in this batch\n\nNo "
      + `${targetLangName} template exists yet for: ${templateFallbacks.map((s) => `\`${s}\``).join(", ")}. `
      + `Follow the ${sourceLangName} note's structure directly.`);
  }

  if (examples.length) {
    parts.push("## Validated examples (human-approved translations — imitate their style and register)\n\n"
      + examples.map((e, i) =>
        `### Example ${i + 1}${e.supportReference ? ` (${slugFromSupportReference(e.supportReference)})` : ""}\n`
        + `**${sourceLangName} source:**\n${e.source}\n\n**${targetLangName} translation:**\n${e.target}`).join("\n\n"));
  }

  if (scripture && Array.isArray(scripture.versions) && scripture.versions.length) {
    const refs: { chapter: number; verse: number; key: string }[] = [];
    const seen = new Set<string>();
    for (const row of batchRows) {
      const chapter = refChapter(row.Reference);
      if (chapter === "front" || typeof chapter !== "number") continue;
      const range = refVerseRange(row.Reference);
      if (!range) continue;
      const end = Math.min(range.end, range.start + 9);
      for (let verse = range.start; verse <= end; verse++) {
        const key = `${chapter}:${verse}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ chapter, verse, key });
      }
    }

    const scriptureParts = ['## Scripture for these verses (use for bold ULT-quoted words and "Alternate translation:" wording)'];
    if (scripture.targetLiteralFound === false && scripture.targetSimplifiedFound === false) {
      scriptureParts.push("_No target-language literal/simplified Bible is available for these verses yet — translate the bold and alternate-translation wording from the source text above._");
    }
    for (const { chapter, verse, key } of refs) {
      const lines = [`### ${chapter}:${verse}`];
      for (const version of scripture.versions) {
        const text = version.byRef && version.byRef[key];
        if (text) lines.push(`- ${version.label}: ${text}`);
      }
      scriptureParts.push(lines.join("\n"));
    }
    parts.push(scriptureParts.join("\n\n"));
  }

  return { markdown: parts.join("\n\n") + "\n", templateFallbacks, slugs };
}

/**
 * Render the per-article context markdown (tW/tA). Same pack, but there is no
 * SupportReference to match templates against — instead the article id itself
 * may match a template slug (e.g. tA "figs-aside"). Terminology + examples +
 * brief/instructions/standards are always injected.
 */
export function renderArticlePack({
  articleId, pack, targetLang, targetLangName, direction, sourceLangName = "English",
}: PackRenderContext & { articleId: string | null | undefined; sourceLangName?: string }): { markdown: string; templateFallbacks: string[]; slug: string } {
  const slug = slugFromSupportReference(articleId) || (String(articleId || "").split("/").pop() ?? "");
  const templateFallbacks: string[] = [];
  const templateLines: string[] = [];
  const t = slug ? pack.templates.get(slug) : undefined;
  if (t) templateLines.push(`- \`${slug}\`: ${t.template}`);
  else if (slug) templateFallbacks.push(slug);

  const examples = selectExamples(pack.examples, slug ? [slug] : []);
  const parts = renderPackPreamble({ pack, targetLang, targetLangName, direction });

  if (templateLines.length) {
    parts.push(`## Phrasing template for this article\n\nFollow this ${targetLangName} phrasing pattern:\n\n` + templateLines.join("\n"));
  }
  if (examples.length) {
    parts.push("## Validated examples (human-approved translations — imitate their style and register)\n\n"
      + examples.map((e, i) => `### Example ${i + 1}\n**${sourceLangName} source:**\n${e.source}\n\n**${targetLangName} translation:**\n${e.target}`).join("\n\n"));
  }
  return { markdown: parts.join("\n\n") + "\n", templateFallbacks, slug };
}

// ---------------------------------------------------------------------------
// Per-run TSV resource descriptor (translate-pipeline.js tsvResource()).
// ---------------------------------------------------------------------------

export type TsvResource = {
  resourceType: string;
  passThroughColumns: readonly string[];
  translateColumns: readonly string[];
  file: (book: string) => string;
  codec: TsvCodec;
  checkOpts: CheckOpts;
  sizeOf: (r: TsvRow) => number;
};

export function tsvResource(resourceType: string): TsvResource {
  const rt = getTsvResourceType(resourceType);
  const codec = makeTsvCodec(rt.columns);
  return {
    resourceType,
    passThroughColumns: rt.passThroughColumns,
    translateColumns: rt.translateColumns,
    file: rt.file,
    codec,
    checkOpts: { passThroughColumns: rt.passThroughColumns, translateColumns: rt.translateColumns },
    sizeOf: (r) => rt.translateColumns.reduce((s, c) => s + (r[c] || "").length, 0),
  };
}

// ---------------------------------------------------------------------------
// In-memory batch / article artifacts (the bot's write*Files without the fs).
// ---------------------------------------------------------------------------

export type BatchArtifactNames = { batchFile: string; packFile: string; taskFile: string; outputFile: string };
export type BatchArtifacts = {
  nn: string;
  names: BatchArtifactNames;
  /** Exact content of batch-NN.tsv: the source rows serialized by the resource codec. */
  sourceTsv: string;
  /** Exact content of batch-NN-pack.md. */
  packMarkdown: string;
  /** Exact content of batch-NN-task.json (2-space JSON, same keys as the bot). */
  taskJson: string;
};

/**
 * Build one TSV batch's working artifacts (bot: writeBatchFiles):
 *   batch-NN.tsv        the source rows
 *   batch-NN-pack.md    the rendered context
 *   batch-NN-task.json  machine-readable task descriptor the prompt reads first
 * Output contract: the model returns batch-NN-out.tsv (same columns, same rows
 * in order, only translate columns localized). `resource` supplies the codec +
 * column lists baked into the task JSON so the prompt knows what to touch.
 * File names are logical (no directory): the caller decides where they live.
 */
export function buildBatchArtifacts(
  index: number,
  { batchRows, packMarkdown, targetLang, targetLangName, direction, book, resource, sourceLangName = "English" }: {
    batchRows: readonly TsvRow[];
    packMarkdown: string;
    targetLang: string;
    targetLangName: string;
    direction: string;
    book: string;
    resource?: TsvResource;
    sourceLangName?: string;
  },
): BatchArtifacts {
  const nn = String(index + 1).padStart(2, "0");
  const serialize = resource ? resource.codec.serialize : serializeTnTsv;
  const names: BatchArtifactNames = {
    batchFile: `batch-${nn}.tsv`,
    packFile: `batch-${nn}-pack.md`,
    taskFile: `batch-${nn}-task.json`,
    outputFile: `batch-${nn}-out.tsv`,
  };
  const taskJson = JSON.stringify({
    task: "translate-tsv-batch",
    resourceType: resource ? resource.resourceType : "tn",
    passThroughColumns: resource ? resource.passThroughColumns : undefined,
    translateColumns: resource ? resource.translateColumns : ["Note"],
    book,
    targetLang,
    targetLangName,
    sourceLangName,
    direction,
    rowCount: batchRows.length,
    batchFile: names.batchFile,
    packFile: names.packFile,
    outputFile: names.outputFile,
  }, null, 2);
  return { nn, names, sourceTsv: serialize(batchRows), packMarkdown, taskJson };
}

export type ArticleArtifactNames = { srcFile: string; packFile: string; taskFile: string; outputFile: string };
export type ArticleArtifacts = {
  nn: string;
  names: ArticleArtifactNames;
  sourceMarkdown: string;
  packMarkdown: string;
  taskJson: string;
};

/**
 * Build one article file's working artifacts (bot: writeArticleFiles):
 *   article-NN.md        the source markdown
 *   article-NN-pack.md   the rendered context
 *   article-NN-task.json the task descriptor
 * Output contract: the model returns article-NN-out.md (translated body,
 * structure + links preserved).
 */
export function buildArticleArtifacts(
  index: number,
  { sourceMarkdown, packMarkdown, articleId, filePath, targetLang, targetLangName, direction, sourceLangName = "English" }: {
    sourceMarkdown: string;
    packMarkdown: string;
    articleId: string | null;
    filePath: string;
    targetLang: string;
    targetLangName: string;
    direction: string;
    sourceLangName?: string;
  },
): ArticleArtifacts {
  const nn = String(index + 1).padStart(2, "0");
  const names: ArticleArtifactNames = {
    srcFile: `article-${nn}.md`,
    packFile: `article-${nn}-pack.md`,
    taskFile: `article-${nn}-task.json`,
    outputFile: `article-${nn}-out.md`,
  };
  const taskJson = JSON.stringify({
    task: "translate-article",
    articleId,
    filePath,
    targetLang,
    targetLangName,
    sourceLangName,
    direction,
    sourceFile: names.srcFile,
    packFile: names.packFile,
    outputFile: names.outputFile,
  }, null, 2);
  return { nn, names, sourceMarkdown, packMarkdown, taskJson };
}

/**
 * Structurally validate a TSV batch's model output (bot: readBatchOutput,
 * minus the file read). Returns { rows, checks }. `parse` + `checkOpts`
 * (passThrough/translate columns) default to tN. Throws only on
 * missing/unparseable output.
 */
export function validateBatchOutput(
  outputText: string | null | undefined,
  batchRows: readonly TsvRow[],
  { parse = parseTnTsv, checkOpts = {} }: { parse?: (text: string) => TsvRow[]; checkOpts?: CheckOpts } = {},
): { rows: TsvRow[]; checks: CheckResult } {
  if (outputText == null) throw new Error("model produced no output");
  const rows = parse(outputText);
  // Byte-preserve pass-through columns by construction. The model round-trips
  // whole rows, so a pass-through cell — e.g. a Hebrew UHB Quote — can come back
  // in a different Unicode normalization (visually identical, byte-different) or
  // otherwise mangled. Copy each pass-through cell straight from the source row
  // so passthrough is exact, not merely re-emitted; the passthrough checks then
  // only guard rows the model failed to round-trip by ID at all.
  const passThroughColumns = checkOpts.passThroughColumns || PASS_THROUGH_COLUMNS;
  const srcById = new Map(batchRows.map((r) => [r.ID, r]));
  for (const row of rows) {
    const src = srcById.get(row.ID);
    if (!src) continue;
    for (const col of passThroughColumns) {
      if (Object.prototype.hasOwnProperty.call(src, col)) row[col] = src[col];
    }
  }
  const checks = runChecks(batchRows, rows, checkOpts);
  return { rows, checks };
}

/** Validate one translated article body (bot: readArticleOutput). Returns { markdown, checks }. */
export function validateArticleOutput(
  markdown: string | null | undefined,
  sourceMarkdown: string,
  { articleId, path: filePath }: { articleId?: string | null; path?: string | null } = {},
): { markdown: string; checks: CheckResult } {
  if (markdown == null) throw new Error("model produced no output");
  const checks = runArticleChecks(sourceMarkdown, markdown, { articleId, path: filePath });
  return { markdown, checks };
}

/**
 * Merge translated chapter-range rows into the whole-book target TSV. `parse`/
 * `serialize` default to tN's codec. existingBookText may be null (fresh file).
 */
export function mergeChapterIntoBook(
  existingBookText: string | null | undefined,
  newRows: readonly TsvRow[],
  { startChapter, endChapter, parse = parseTnTsv, serialize = serializeTnTsv }: {
    startChapter: number;
    endChapter: number;
    parse?: (text: string) => TsvRow[];
    serialize?: (rows: readonly TsvRow[]) => string;
  },
): string {
  const existing = existingBookText ? parse(existingBookText) : [];

  const inRange = (r: TsvRow) => {
    const ch = refChapter(r.Reference);
    if (ch === "front") return startChapter === 1;
    return typeof ch === "number" && ch >= startChapter && ch <= endChapter;
  };

  const before: TsvRow[] = [];
  const after: TsvRow[] = [];
  for (const r of existing) {
    if (inRange(r)) continue; // replaced
    const ch = refChapter(r.Reference);
    // `ch ?? 0`: the bot compares a null chapter with `<`, which coerces to 0.
    const sortKey = ch === "front" ? 0 : (ch ?? 0);
    if (sortKey < startChapter || ch === "front") before.push(r);
    else after.push(r);
  }
  return serialize([...before, ...newRows, ...after]);
}

/**
 * Narrow a chapter-sliced row set to a subset by explicit row IDs and/or a
 * verse range (individual-note / single-verse translation). No criteria →
 * input unchanged (same array instance).
 */
export function selectRows<T extends TsvRow>(
  rows: T[],
  { rowIds, verseStart, verseEnd }: { rowIds?: readonly string[] | null; verseStart?: number | null; verseEnd?: number | null } = {},
): T[] {
  let out = rows;
  if (Array.isArray(rowIds) && rowIds.length) {
    const want = new Set(rowIds);
    out = out.filter((r) => want.has(r.ID));
  }
  if (verseStart != null) {
    const vEnd = verseEnd != null ? verseEnd : verseStart;
    out = out.filter((r) => {
      const vr = refVerseRange(r.Reference);
      return vr !== null && vr.start <= vEnd && vr.end >= verseStart;
    });
  }
  return out;
}

/**
 * Update specific rows in an existing whole-book target TSV by ID, leaving
 * every other row — and all row positions — untouched. `parse`/`serialize`
 * default to tN's codec. Requires each updated row to already exist in target.
 */
export function updateRowsById(
  existingBookText: string | null | undefined,
  newRows: readonly TsvRow[],
  { parse = parseTnTsv, serialize = serializeTnTsv }: {
    parse?: (text: string) => TsvRow[];
    serialize?: (rows: readonly TsvRow[]) => string;
  } = {},
): string {
  if (!existingBookText) {
    throw new Error("by-id update requires an existing target book (none found). "
      + "Translate the whole chapter first, or run in whole-chapter mode.");
  }
  const existing = parse(existingBookText);
  const newById = new Map(newRows.map((r) => [r.ID, r]));
  const applied = new Set<string>();
  const merged = existing.map((r) => {
    const replacement = newById.get(r.ID);
    if (replacement) {
      applied.add(r.ID);
      return replacement;
    }
    return r;
  });
  const missing = newRows.filter((r) => !applied.has(r.ID));
  if (missing.length) {
    throw new Error(`by-id update: row id(s) not present in target book: ${missing.map((r) => r.ID).join(", ")}`);
  }
  return serialize(merged);
}

export type BatchMeta = {
  nn: string;
  rowCount: number;
  attempts: number;
  templateFallbacks: string[];
  slugs: string[];
  path?: string;
};

export type LlmUsageSummary = {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  calls: number;
};

export type TranslateReportSelection = {
  mergeMode: "range" | "by-id";
  verseStart: number | null;
  verseEnd: number | null;
  rowIds: readonly string[] | null;
};

/** Machine-readable per-run report (CONTEXT-REPO-CONTRACT.md §4.2). */
export function buildTranslateReport({
  resourceType = "tn", book, startChapter, endChapter, articleId, files,
  targetLang, sourceLang, sourceRef, contextRef, contextSha, batches, checks, selection,
  runId = null, jobId = null, generatedAt = null, targetOrg = null, targetRepo = null, branch = null,
  // Direct-provider LLM accounting. Omitted entirely when null.
  llm = null,
  // Who produced this report. The bot writes 'bp-assistant/translate'; the
  // in-Worker runner writes 'bible-editor/translate' (design §B step 4).
  generatedBy = "bible-editor/translate",
}: {
  resourceType?: string;
  book?: string | null;
  startChapter?: number | null;
  endChapter?: number | null;
  articleId?: string | null;
  files?: unknown[] | null;
  targetLang: string;
  sourceLang?: string | null;
  sourceRef: string;
  contextRef: string;
  contextSha?: string | null;
  batches?: readonly BatchMeta[] | null;
  checks: Pick<CheckResult, "ok" | "errors" | "warnings">;
  selection?: TranslateReportSelection | null;
  runId?: string | null;
  jobId?: string | null;
  generatedAt?: string | null;
  targetOrg?: string | null;
  targetRepo?: string | null;
  branch?: string | null;
  llm?: LlmUsageSummary | null;
  generatedBy?: string;
}) {
  return {
    version: 1,
    generatedBy,
    runId: runId || null,
    jobId: jobId || null,
    generatedAt: generatedAt || new Date().toISOString(),
    resourceType,
    book: book || null,
    startChapter: startChapter ?? null,
    endChapter: endChapter ?? null,
    articleId: articleId || null,
    files: files || null,
    targetLang,
    sourceLang: sourceLang || "en",
    sourceRef,
    contextRef,
    contextSha: contextSha || null,
    targetOrg: targetOrg || null,
    targetRepo: targetRepo || null,
    branch: branch || null,
    scope: {
      book: book || null,
      startChapter: startChapter ?? null,
      endChapter: endChapter ?? null,
      articleId: articleId || null,
    },
    selection: selection || { mergeMode: "range", verseStart: null, verseEnd: null, rowIds: null },
    rowCount: (batches || []).reduce((s, b) => s + (b.rowCount || 0), 0),
    batches: (batches || []).map((b) => ({
      batch: b.nn,
      rowCount: b.rowCount,
      attempts: b.attempts,
      templateFallbacks: b.templateFallbacks,
      slugs: b.slugs,
      path: b.path,
    })),
    checks: {
      ok: checks.ok,
      errorCount: checks.errors.length,
      warningCount: checks.warnings.length,
      errors: checks.errors,
      warnings: checks.warnings,
    },
    ...(llm ? { llm } : {}),
  };
}
