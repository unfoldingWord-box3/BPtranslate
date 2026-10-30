// The published English translation notes a project's notes were drafted
// from, keyed by row id, for bpt_chunk_work's en_note (issue #671). Server
// twin of web/src/hooks/useSourceNotes.ts: the English source is not stored on
// the row, so read the book's tN TSV from the project's translationSource on
// Door43 and match by id (ids pass through import byte-identical).
//
// Per chapter (#691): a book or chapter range can take its tN from another
// source (book_source_overrides, bookSource.ts). The chapter's source is
// resolved the way import resolves it (planBookNoteSources): a dcs override
// is read from its own org/repo, and a whole-book override replaces the
// project-wide source. An Aquifer range keeps the base source: import builds
// Aquifer rows on top of the project's en_tn (fetchAquiferRangeNotes in
// bookImport.ts) and a matched row keeps en_tn's id, so the en_tn note with
// that id is the English note it was matched to; an unmatched row has a
// minted id and gets no note, as any id the source lacks. A source's notes
// count only for the chapters that resolve to it, so an id shared by two
// sources never shows one source's note on the other's chapter. Same rule as
// web/src/lib/sourceNotePlan.ts.
//
// Never throws: a project in authoring mode, no tN source configured, a 404 or
// a failed fetch all come back as { ok: false, reason } so the tool can still
// return the rows. Notes keep the TSV's literal "\n" escapes, the same form the
// imported row's own note is stored in, so the two compare like for like.

import type { Env } from "./index";
import { getProjectConfig } from "./projectConfig.ts";
import { isTranslationConfig } from "./workflowLayouts.ts";
import { dcsRawUrl } from "./dcsSources.ts";
import { parseTsv, refParts } from "./importParsers.ts";
import {
  planBookNoteSources,
  sourceRefForChapter,
  type BookSourceResource,
  type ResolvedSourceRange,
} from "./bookSource.ts";
import type { RepoRef } from "./repoUrl.ts";

export type SourceNotes =
  | { ok: true; source: string; notes: Map<string, string> }
  | { ok: false; reason: string };

// A hanging Door43 must not stall the tool: past this, en_note is null.
export const SOURCE_FETCH_TIMEOUT_MS = 8_000;

// Anonymous on purpose. The web app reads this TSV from the browser with no
// credentials, so a private source repo shows the reviewer nothing there; chat
// (viewers included) must not see more than that, so the DCS service token
// that fetchTextWithStatus sends is never attached here. Otherwise the same
// rules as that helper: a non-2xx is not content, and a body shorter than its
// Content-Length is a truncated read, not content.
async function fetchAnonymous(
  url: string,
): Promise<{ status: number; text: string | null; truncated?: boolean; timedOut?: boolean }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(SOURCE_FETCH_TIMEOUT_MS) });
    if (!r.ok) return { status: r.status, text: null };
    const buf = await r.arrayBuffer();
    const cl = r.headers.get("content-length");
    const expected = cl == null ? null : Number(cl);
    if (expected != null && Number.isFinite(expected) && buf.byteLength < expected) {
      return { status: 200, text: null, truncated: true };
    }
    return { status: 200, text: new TextDecoder("utf-8").decode(buf) };
  } catch (e) {
    // DOMException (the abort reason) is not an Error in every runtime.
    const name = (e as { name?: unknown } | null)?.name;
    return { status: 0, text: null, timedOut: name === "TimeoutError" || name === "AbortError" };
  }
}

// Per isolate, keyed by the raw URL, which names the resolved org/repo and
// file, so two overrides never share an entry. English tN changes rarely and a
// reviewer pages through a chapter in a few calls, so a short TTL saves a
// Door43 fetch per page without serving a stale source for long. Failures are
// never cached. The override lookup is not cached: it is one D1 read, and an
// admin's change shows on the next call.
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 16;
type SourceRow = { chapter: number; note: string };
const cache = new Map<string, { at: number; rows: Map<string, SourceRow> }>();

// The repo a chapter's English source notes are read from: its dcs override
// range, else the base (a whole-book override, else the project-wide
// translationSource). An Aquifer range reads the base (see the header).
function sourceForChapter(
  plan: { base: RepoRef | null; ranges: ResolvedSourceRange[] },
  chapter: number,
): RepoRef | null {
  const range = sourceRefForChapter(plan, chapter);
  return range?.kind === "dcs" ? range.ref : plan.base;
}

const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

export function clearSourceNotesCache(): void {
  cache.clear();
}

// The same per-chapter plan, for the web app's Source panel (useSourceNotes),
// sent by GET /api/books/:book/sources so the browser does not re-implement
// the override rules (validation, the own-repo no-op). Read it with
// web/src/lib/sourceNotePlan.ts. Only dcs ranges are sent: an Aquifer range
// reads the base, like any chapter no range covers. base is null when the
// project has no project-wide English tN repo; a dcs override still applies
// then, as it does on import. null for an authoring project. A D1 failure
// throws; bookSourcePlansForClient below catches it.
//
// `resource` "tq" gives the same plan for the English source question
// (useSourceQuestions, #695). Aquifer is tN-only: resolveRangeSource drops a
// tQ Aquifer range, so a tQ plan only ever carries Door43 ranges.
export type ClientNoteSourceRange = { chapter_start: number; chapter_end: number; org: string; repo: string };
export interface ClientNoteSourcePlan {
  base: { org: string; repo: string } | null;
  ranges: ClientNoteSourceRange[];
}

export async function noteSourcePlanForClient(
  env: Env,
  book: string,
  resource: BookSourceResource = "tn",
): Promise<ClientNoteSourcePlan | null> {
  const cfg = await getProjectConfig(env);
  if (!isTranslationConfig(cfg)) return null;
  const plan = await planBookNoteSources(env, cfg, book, resource, true);
  return {
    base: plan.base ? { org: plan.base.owner, repo: plan.base.repo } : null,
    ranges: plan.ranges.flatMap((r): ClientNoteSourceRange[] =>
      r.source.kind === "dcs"
        ? [{ chapter_start: r.chapter_start, chapter_end: r.chapter_end, org: r.source.ref.owner, repo: r.source.ref.repo }]
        : [],
    ),
  };
}

// Both plans for GET /api/books/:book/sources. A plan that could not be
// resolved (a transient D1 error) is left undefined, so JSON drops the field;
// null stays null (authoring project). The web app reads a missing field as a
// failed request: it shows the project-wide file and does not cache it (#697).
export async function bookSourcePlansForClient(
  env: Env,
  book: string,
): Promise<{ tnNoteSources?: ClientNoteSourcePlan | null; tqQuestionSources?: ClientNoteSourcePlan | null }> {
  const plan = (resource: "tn" | "tq") =>
    noteSourcePlanForClient(env, book, resource).catch((e): undefined => {
      console.error("noteSourcePlanForClient failed", resource, e instanceof Error ? e.message : String(e));
      return undefined;
    });
  const [tnNoteSources, tqQuestionSources] = await Promise.all([plan("tn"), plan("tq")]);
  return { tnNoteSources, tqQuestionSources };
}

// `chapter` is the chapter of the rows being compared (0 = front matter): an
// override can give each chapter range of a book a different source.
export async function readSourceNotes(env: Env, book: string, chapter: number): Promise<SourceNotes> {
  try {
    const cfg = await getProjectConfig(env);
    if (!isTranslationConfig(cfg)) {
      return { ok: false, reason: "This project writes its notes in English, so they have no separate English source." };
    }
    // translateFromSource=true: with no override, the base is the
    // project-wide translationSource, as before #691. With no project-wide tN
    // repo the base is null, but a dcs override still applies (import reads
    // it regardless), so only a chapter that resolves to nothing has no source.
    const plan = await planBookNoteSources(env, cfg, book, "tn", true);
    const ref = sourceForChapter(plan, chapter);
    if (!ref) return { ok: false, reason: "This project has no English tN source repository set up." };
    const source = `${ref.owner}/${ref.repo}`;
    const file = `tn_${book}.tsv`;
    const url = dcsRawUrl(env, ref.owner, ref.repo, file);
    const forChapters = (rows: Map<string, SourceRow>): SourceNotes => {
      const notes = new Map<string, string>();
      for (const [id, r] of rows) {
        const s = sourceForChapter(plan, r.chapter);
        if (s && sameRepo(s, ref)) notes.set(id, r.note);
      }
      return { ok: true, source, notes };
    };

    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL_MS) return forChapters(hit.rows);

    const res = await fetchAnonymous(url);
    if (res.text === null) {
      const why = res.timedOut
        ? "Door43 did not answer in time"
        : res.status === 404
          ? "it has no such file, or the repository is not public"
          : res.truncated
            ? "the download was cut short"
            : res.status
              ? `HTTP ${res.status}`
              : "network error";
      return { ok: false, reason: `Could not read the English notes ${file} from ${source} (${why}).` };
    }
    const rows = new Map<string, SourceRow>();
    for (const row of parseTsv(res.text).rows) {
      const id = row["ID"];
      if (id) rows.set(id, { chapter: refParts(row["Reference"])[0], note: row["Note"] ?? "" });
    }
    if (rows.size === 0) return { ok: false, reason: `${source} ${file} has no notes with an ID column.` };

    cache.delete(url);
    cache.set(url, { at: Date.now(), rows });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    return forChapters(rows);
  } catch (e) {
    console.error("readSourceNotes failed", e instanceof Error ? e.message : String(e));
    return { ok: false, reason: "Could not read the English source notes." };
  }
}
