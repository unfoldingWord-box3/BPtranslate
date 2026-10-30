import { useEffect, useState } from "react";
import { fallbackSourcePlan, mergeSourceNotes, parseSourceQuestionTsv, planRepos, repoKey, type RepoSource, type SourceQuestionMap } from "../lib/sourceNotePlan";
import { fetchSourcePlan } from "./sourcePlans";

export type { SourceQuestion, SourceQuestionMap } from "../lib/sourceNotePlan";

// The published source-language tQ (e.g. unfoldingWord/en_tq) for a book, keyed
// by row ID — the tQ analogue of useSourceNotes. In a gateway-language project
// the row's OWN question/response is the target being translated/reviewed; the
// English SOURCE it was drafted from lives in the published source repo, not D1.
// Row IDs pass through byte-identical, so we fetch the source TSV once per book
// and match by id. Door43 serves raw TSV with permissive CORS and the prod CSP
// already allows git.door43.org.
//
// Per chapter (#695, the tQ twin of #691): a book or chapter range can take its
// tQ from another Door43 source (book_source_overrides). The server sends which
// source each chapter resolves to (GET /api/books/:book/sources →
// tqQuestionSources), every source in it is fetched, and each question comes
// from the source its own chapter resolves to (lib/sourceNotePlan.ts).
//
// Degrades gracefully: a failed fetch or an id with no source row yields no
// entry, and the card simply omits the source block. If the source plan cannot
// be read (request failed, or the server could not resolve it), the
// project-wide file shows for every chapter, as before the per-chapter plan
// (#697); an authoring project (null plan) shows none.

const EMPTY: SourceQuestionMap = new Map();

function rawUrl(org: string, repo: string, book: string): string {
  return `https://git.door43.org/${org}/${repo}/raw/branch/master/tq_${book.toUpperCase()}.tsv`;
}

const cache = new Map<string, Promise<SourceQuestionMap>>();

function fetchSourceQuestions(org: string, repo: string, book: string): Promise<SourceQuestionMap> {
  const url = rawUrl(org, repo, book);
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseSourceQuestionTsv)
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}

async function loadSourceQuestions(book: string, projectWide: RepoSource | null): Promise<SourceQuestionMap> {
  // A plan that cannot be read falls back to the project-wide file (#697).
  const plan = await fetchSourcePlan(book, "tq").catch(() => fallbackSourcePlan(projectWide));
  if (!plan) return EMPTY;
  const repos = planRepos(plan);
  const settled = await Promise.allSettled(repos.map((r) => fetchSourceQuestions(r.org, r.repo, book)));
  const byRepo = new Map<string, SourceQuestionMap>();
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") byRepo.set(repoKey(repos[i]), s.value);
  });
  return mergeSourceNotes(plan, byRepo);
}

// `book` is null outside translation mode, which short-circuits to an empty map
// with no fetch. `source` is the project's translationSource projection
// {org, repo}: prefetched, and the fallback when the plan cannot be read; null (no project-wide tQ repo) still reads
// the plan, since a Door43 override applies without one. The server's plan
// decides which repos are read.
export function useSourceQuestions(
  book: string | null | undefined,
  source: { org: string; repo: string } | null,
): SourceQuestionMap {
  const [map, setMap] = useState<SourceQuestionMap>(EMPTY);
  // Depend on the two strings, not the object, so a caller that builds `source`
  // fresh each render does not refetch on every render.
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  useEffect(() => {
    if (!book) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the map when the book goes away. Deriving EMPTY in render instead would let the previous book's questions reappear when a book comes back, until its fetch lands.
      setMap(EMPTY);
      return;
    }
    let mounted = true;
    // Start the project-wide file while the plan loads; almost every chapter
    // reads it, and the shared cache hands it to loadSourceQuestions.
    if (org !== null && repo !== null) fetchSourceQuestions(org, repo, book).catch(() => {});
    loadSourceQuestions(book, org !== null && repo !== null ? { org, repo } : null)
      .then((m) => {
        if (mounted) setMap(m);
      })
      .catch(() => {
        if (mounted) setMap(EMPTY);
      });
    return () => {
      mounted = false;
    };
  }, [book, org, repo]);
  return map;
}
