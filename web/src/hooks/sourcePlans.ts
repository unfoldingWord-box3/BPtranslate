import { useEffect, useState } from "react";
import { api } from "../sync/api";
import { fallbackSourcePlan, planFromBookSources, type NoteSourcePlan, type RepoSource } from "../lib/sourceNotePlan";

// Which Door43 source each chapter's English source note (tN, #691) or source
// question (tQ, #695) is read from: GET /api/books/:book/sources sends both
// plans. The Source-panel components mount together and each of
// useSourceNotes / useSourceQuestions asks for its plan, so share one request
// per book. Short-lived, so an admin's override change shows soon; failures
// are not kept, and neither is a response the server left a plan out of
// because it could not resolve it (#697).

type BookSources = Awaited<ReturnType<typeof api.getBookSources>>;

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { at: number; pending: Promise<BookSources> }>();

function fetchBookSources(book: string): Promise<BookSources> {
  const key = book.toUpperCase();
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.pending;
  const evict = () => {
    if (planCache.get(key)?.pending === pending) planCache.delete(key);
  };
  const pending: Promise<BookSources> = api.getBookSources(key).then(
    (r) => {
      // Still hand it on: the other resource's plan may be fine.
      if (r.tnNoteSources === undefined || r.tqQuestionSources === undefined) evict();
      return r;
    },
    (err) => {
      evict();
      throw err;
    },
  );
  planCache.set(key, { at: Date.now(), pending });
  return pending;
}

// Rejects when the plan could not be read (request failed, or the server left
// it out); resolves null for an authoring project.
export function fetchSourcePlan(book: string, resource: "tn" | "tq"): Promise<NoteSourcePlan | null> {
  return fetchBookSources(book).then((r) => planFromBookSources(r, resource));
}

// The plan the Source panel reads by, with the failure fallback applied: the
// fetched plan, or the project-wide file for every chapter while it loads or
// when it cannot be read (#697). For the flows screens' empty-state wording
// (lib/sourceNotePlan.ts chapterHasSource). `book` null (not translation mode)
// gives null with no fetch.
export function useSourcePlan(
  book: string | null | undefined,
  resource: "tn" | "tq",
  source: RepoSource | null,
): NoteSourcePlan | null {
  const org = source?.org ?? null;
  const repo = source?.repo ?? null;
  const [fetched, setFetched] = useState<{ book: string; plan: NoteSourcePlan | null } | null>(null);
  useEffect(() => {
    if (!book) return;
    let mounted = true;
    fetchSourcePlan(book, resource)
      .then((plan) => {
        if (mounted) setFetched({ book, plan });
      })
      .catch(() => {
        if (mounted) setFetched(null);
      });
    return () => {
      mounted = false;
    };
  }, [book, resource]);
  if (!book) return null;
  if (fetched && fetched.book === book) return fetched.plan;
  return fallbackSourcePlan(org !== null && repo !== null ? { org, repo } : null);
}
