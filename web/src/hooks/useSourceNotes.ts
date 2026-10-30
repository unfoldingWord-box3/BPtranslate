import { useEffect, useState } from "react";
import { fallbackSourcePlan, mergeSourceNotes, parseSourceTsv, planRepos, repoKey, type NoteSourcePlan, type SourceNoteMap } from "../lib/sourceNotePlan";
import { watchSourcePlan } from "./sourcePlans";

export type { SourceNote, SourceNoteMap } from "../lib/sourceNotePlan";

// The published source-language tN (e.g. unfoldingWord/en_tn) for a book, keyed
// by row ID. In a gateway-language project the row's OWN note is the target
// being translated/reviewed; the English SOURCE it was drafted from lives in the
// published source repo, not D1 (the translate pipeline fetches by reference and
// the draft_meta sidecar isn't wired yet — INTEGRATION.md §0). Row IDs pass
// through byte-identical, so we fetch the source TSV once per book and match by
// id. Door43 serves raw TSV with permissive CORS (same as the TW article
// viewer), and the prod CSP already allows git.door43.org.
//
// Per chapter (#691): a book or chapter range can take its tN from another
// source (book_source_overrides). The server sends which source each chapter
// resolves to (GET /api/books/:book/sources → tnNoteSources), every source in
// it is fetched, and each note comes from the source its own chapter resolves
// to (lib/sourceNotePlan.ts). An Aquifer range keeps the project-wide source.
//
// Degrades gracefully: a failed fetch or an id with no source row yields no
// entry, and the card simply omits the source block. If the source plan cannot
// be read (request failed, or the server could not resolve it), the
// project-wide file shows for every chapter, as before the per-chapter plan
// (#697) until a background retry reads the plan; an authoring project (null
// plan) shows none.

const EMPTY: SourceNoteMap = new Map();

function rawUrl(org: string, repo: string, book: string): string {
  return `https://git.door43.org/${org}/${repo}/raw/branch/master/tn_${book.toUpperCase()}.tsv`;
}

const cache = new Map<string, Promise<SourceNoteMap>>();

function fetchSourceTsv(org: string, repo: string, book: string): Promise<SourceNoteMap> {
  const url = rawUrl(org, repo, book);
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseSourceTsv)
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}

async function loadSourceNotes(book: string, plan: NoteSourcePlan | null): Promise<SourceNoteMap> {
  if (!plan) return EMPTY;
  const repos = planRepos(plan);
  const settled = await Promise.allSettled(repos.map((r) => fetchSourceTsv(r.org, r.repo, book)));
  const byRepo = new Map<string, SourceNoteMap>();
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") byRepo.set(repoKey(repos[i]), s.value);
  });
  return mergeSourceNotes(plan, byRepo);
}

// `book` is null outside translation mode, which short-circuits to an empty map
// with no fetch. `source` is the project's translationSource projection
// {org, repo}: prefetched, and the fallback when the plan cannot be read; null (no project-wide tN repo) still reads
// the plan, since a Door43 override applies without one. The server's plan
// decides which repos are read.
export function useSourceNotes(
  book: string | null | undefined,
  source: { org: string; repo: string } | null,
): SourceNoteMap {
  const [map, setMap] = useState<SourceNoteMap>(EMPTY);
  // Depend on the two strings, not the object, so a caller that builds `source`
  // fresh each render does not refetch on every render.
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  useEffect(() => {
    if (!book) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the map when the book goes away. Deriving EMPTY in render instead would let the previous book's notes reappear when a book comes back, until its fetch lands.
      setMap(EMPTY);
      return;
    }
    let mounted = true;
    // Start the project-wide file while the plan loads; almost every chapter
    // reads it, and the shared cache hands it to loadSourceNotes.
    if (org !== null && repo !== null) fetchSourceTsv(org, repo, book).catch(() => {});
    // A plan that cannot be read falls back to the project-wide file now and
    // is retried in the background; a later success replaces the fallback
    // (#697). `seq` keeps a slow earlier load from overwriting a newer one.
    const projectWide = org !== null && repo !== null ? { org, repo } : null;
    let seq = 0;
    const stop = watchSourcePlan(book, "tn", (plan) => {
      const mine = ++seq;
      loadSourceNotes(book, plan === undefined ? fallbackSourcePlan(projectWide) : plan)
        .then((m) => {
          if (mounted && mine === seq) setMap(m);
        })
        .catch(() => {
          if (mounted && mine === seq) setMap(EMPTY);
        });
    });
    return () => {
      mounted = false;
      stop();
    };
  }, [book, org, repo]);
  return map;
}
