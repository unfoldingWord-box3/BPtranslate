import { api } from "../sync/api";
import type { NoteSourcePlan } from "../lib/sourceNotePlan";

// Which Door43 source each chapter's English source note (tN, #691) or source
// question (tQ, #695) is read from: GET /api/books/:book/sources sends both
// plans. The Source-panel components mount together and each of
// useSourceNotes / useSourceQuestions asks for its plan, so share one request
// per book. Short-lived, so an admin's override change shows soon; failures
// are not kept.

type BookSources = Awaited<ReturnType<typeof api.getBookSources>>;

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { at: number; pending: Promise<BookSources> }>();

function fetchBookSources(book: string): Promise<BookSources> {
  const key = book.toUpperCase();
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.pending;
  const pending = api.getBookSources(key).catch((err) => {
    planCache.delete(key);
    throw err;
  });
  planCache.set(key, { at: Date.now(), pending });
  return pending;
}

export function fetchSourcePlan(book: string, resource: "tn" | "tq"): Promise<NoteSourcePlan | null> {
  return fetchBookSources(book).then((r) => (resource === "tn" ? r.tnNoteSources : r.tqQuestionSources) ?? null);
}
