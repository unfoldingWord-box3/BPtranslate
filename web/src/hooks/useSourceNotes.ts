import { useEffect, useState } from "react";
import { api } from "../sync/api";
import {
  mergeSourceNotes,
  parseSourceTsv,
  planRepos,
  repoKey,
  type NoteSourcePlan,
  type SourceNoteMap,
} from "../lib/sourceNotePlan";

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
// to (lib/sourceNotePlan.ts). An Aquifer chapter has no English note here.
//
// Degrades gracefully: a failed fetch or an id with no source row yields no
// entry, and the card simply omits the source block. If the source plan cannot
// be read, no notes show rather than a guess that could be another source's.

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

// The three Source-panel components mount together, so share one plan
// request per book. Short-lived, so an admin's override change shows soon;
// failures are not kept.
const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { at: number; pending: Promise<NoteSourcePlan | null> }>();

function fetchPlan(book: string): Promise<NoteSourcePlan | null> {
  const key = book.toUpperCase();
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.pending;
  const pending = api
    .getBookSources(key)
    .then((r) => r.tnNoteSources ?? null)
    .catch((err) => {
      planCache.delete(key);
      throw err;
    });
  planCache.set(key, { at: Date.now(), pending });
  return pending;
}

async function loadSourceNotes(book: string): Promise<SourceNoteMap> {
  const plan = await fetchPlan(book);
  if (!plan) return EMPTY;
  const repos = planRepos(plan);
  const settled = await Promise.allSettled(repos.map((r) => fetchSourceTsv(r.org, r.repo, book)));
  const byRepo = new Map<string, SourceNoteMap>();
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") byRepo.set(repoKey(repos[i]), s.value);
  });
  return mergeSourceNotes(plan, byRepo);
}

// `source` is the project's translationSource projection {org, repo}; null (the
// English root project, or no tN source set up) short-circuits to an empty
// map, so no fetch fires. The server's plan decides which repos are read.
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
    if (!book || org === null || repo === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the map when the book or source goes away. Deriving EMPTY in render instead would let the previous book's notes reappear when a source comes back, until its fetch lands.
      setMap(EMPTY);
      return;
    }
    let mounted = true;
    // Start the project-wide file while the plan loads; almost every chapter
    // reads it, and the shared cache hands it to loadSourceNotes.
    fetchSourceTsv(org, repo, book).catch(() => {});
    loadSourceNotes(book)
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
