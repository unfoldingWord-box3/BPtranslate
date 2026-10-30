// Which published tN each chapter's English source note is read from, for the
// Source panel (hooks/useSourceNotes.ts). A book or chapter range can take its
// tN from another source (book_source_overrides, api/src/bookSource.ts), and
// the rows are matched by id, so reading the project-wide source for an
// overridden chapter shows no note, or an unrelated one (issue #691).
//
// The server resolves the overrides (GET /api/books/:book/sources →
// tnNoteSources, built by api/src/sourceNotes.ts noteSourcePlanForClient), so
// the validation and the own-repo no-op stay in one place. This file only
// looks a chapter up in that plan and merges the fetched files. Same rule as
// the chat tools' readSourceNotes: a source's notes count only for the
// chapters that resolve to it. Only Door43 (dcs) overrides change the source;
// an Aquifer range reads the base, because import builds Aquifer rows on top
// of the project's en_tn and matched rows keep en_tn's ids (the server leaves
// Aquifer ranges out of the plan). Pure, so it runs under the strip-types
// test runner.
//
// The English source question beside a tQ row (hooks/useSourceQuestions.ts)
// uses the same plan shape and merge, from tqQuestionSources (#695). Aquifer
// is tN-only, so a tQ plan only ever carries Door43 ranges.

export interface SourceNote {
  note: string;
  quote: string;
  supportReference: string;
  reference: string;
}

export type SourceNoteMap = Map<string, SourceNote>;

export interface RepoSource {
  org: string;
  repo: string;
}

// A Door43 override for a chapter range.
export interface NoteSourceRange extends RepoSource {
  chapter_start: number;
  chapter_end: number;
}

// base: the source for chapters no range covers (a whole-book override, else
// the project-wide translationSource).
export interface NoteSourcePlan {
  base: RepoSource | null;
  ranges: NoteSourceRange[];
}

export function repoKey(r: RepoSource): string {
  return `${r.org}/${r.repo}`.toLowerCase();
}

// A tN Reference's chapter, as import reads it (api/src/importParsers.ts
// refParts): "front:intro" → 0, "3:intro" → 3, "3:5-7" → 3.
export function refChapter(reference: string): number {
  const ch = (reference ?? "").split(":")[0];
  return ch === "front" ? 0 : parseInt(ch, 10) || 0;
}

export function noteSourceForChapter(plan: NoteSourcePlan, chapter: number): RepoSource | null {
  for (const r of plan.ranges) {
    if (chapter >= r.chapter_start && chapter <= r.chapter_end) return { org: r.org, repo: r.repo };
  }
  return plan.base ? { org: plan.base.org, repo: plan.base.repo } : null;
}

// Whether a chapter's rows have an English source at all (#697): the flows
// screens say "no source for this note" for a chapter that has one but lacks
// the row, and "no source repo configured" only for a chapter that has none.
// null plan (authoring project): no source.
export function chapterHasSource(plan: NoteSourcePlan | null, chapter: number): boolean {
  return plan !== null && noteSourceForChapter(plan, chapter) !== null;
}

// One resource's plan from a GET /api/books/:book/sources response. null is
// the server's answer for an authoring project; an omitted field means the
// server could not resolve the plan (#697), so this throws and the caller
// treats it as a failed request.
export function planFromBookSources(
  res: { tnNoteSources?: NoteSourcePlan | null; tqQuestionSources?: NoteSourcePlan | null },
  resource: "tn" | "tq",
): NoteSourcePlan | null {
  const plan = resource === "tn" ? res.tnNoteSources : res.tqQuestionSources;
  if (plan === undefined) throw new Error(`no ${resource} source plan in the response`);
  return plan;
}

// The plan to read by when the plan request failed (#697): the project-wide
// file for every chapter, as before #691. Without a project-wide source there
// is nothing to show.
export function fallbackSourcePlan(projectWide: RepoSource | null): NoteSourcePlan | null {
  return projectWide ? { base: { org: projectWide.org, repo: projectWide.repo }, ranges: [] } : null;
}

// Each Door43 repo the plan reads, once.
export function planRepos(plan: NoteSourcePlan): RepoSource[] {
  const out = new Map<string, RepoSource>();
  const add = (r: RepoSource) => {
    if (!out.has(repoKey(r))) out.set(repoKey(r), { org: r.org, repo: r.repo });
  };
  if (plan.base) add(plan.base);
  for (const r of plan.ranges) add(r);
  return [...out.values()];
}

// tN TSV columns: Reference \t ID \t Tags \t SupportReference \t Quote \t Occurrence \t Note
export function parseSourceTsv(text: string): SourceNoteMap {
  const map: SourceNoteMap = new Map();
  // Strip a leading UTF-8 BOM (Door43 raw files sometimes carry one) — without
  // this the first column of the header row would be "﻿Reference" and,
  // worse, the header's id would be "﻿Reference"'s neighbour, so the
  // content-based header skip below would miss it. Split on \r?\n so CRLF-served
  // files don't leave a trailing "\r" on the Note column.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const [reference, id, , supportReference, quote, , note] = cols;
    // Skip the header by CONTENT, not position (a leading blank line would push
    // it past index 0). Real row IDs are 4-char slugs, never the literal "ID".
    if (id === "ID") continue;
    if (!id) continue;
    map.set(id, {
      note: (note ?? "").replace(/\\n/g, "\n"),
      quote: quote ?? "",
      supportReference: supportReference ?? "",
      reference: reference ?? "",
    });
  }
  return map;
}

export interface SourceQuestion {
  question: string;
  response: string;
  quote: string;
  reference: string;
}

export type SourceQuestionMap = Map<string, SourceQuestion>;

// tQ TSV columns: Reference \t ID \t Tags \t Quote \t Occurrence \t Question \t Response
// Same rules as parseSourceTsv above (BOM, CRLF, header skipped by content).
export function parseSourceQuestionTsv(text: string): SourceQuestionMap {
  const map: SourceQuestionMap = new Map();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cols = line.split("\t");
    if (cols.length < 7) continue;
    const [reference, id, , quote, , question, response] = cols;
    if (id === "ID") continue;
    if (!id) continue;
    map.set(id, {
      question: (question ?? "").replace(/\\n/g, "\n"),
      response: (response ?? "").replace(/\\n/g, "\n"),
      quote: quote ?? "",
      reference: reference ?? "",
    });
  }
  return map;
}

// One id → row map for the whole book: each row (a tN note or a tQ question)
// from the source its own chapter resolves to. `byRepo` is keyed by repoKey; a
// repo that failed to load is simply absent, and its chapters show nothing
// (never another source's row).
export function mergeSourceNotes<T extends { reference: string }>(
  plan: NoteSourcePlan,
  byRepo: Map<string, Map<string, T>>,
): Map<string, T> {
  const merged = new Map<string, T>();
  for (const repo of planRepos(plan)) {
    const key = repoKey(repo);
    const notes = byRepo.get(key);
    if (!notes) continue;
    for (const [id, sn] of notes) {
      const s = noteSourceForChapter(plan, refChapter(sn.reference));
      if (s && repoKey(s) === key && !merged.has(id)) merged.set(id, sn);
    }
  }
  return merged;
}
