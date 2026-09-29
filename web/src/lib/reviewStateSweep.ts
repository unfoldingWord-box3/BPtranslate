// Request body for the admin bulk review-state sweep (#296):
// POST /api/books/:book/review-state, parsed server-side by parseSweepRequest
// in api/src/reviewState.ts. That parser needs EXACTLY ONE scope — a chapter,
// a chapter range, or allChapters — and rejects an empty one rather than
// sweeping the whole book, so this helper maps the page's form onto one of the
// three and reports an error instead of guessing.

export type ReviewSweepResource = "tn" | "tq";
export type ReviewSweepTarget = "approved" | "needs_review";

export interface ReviewSweepForm {
  resource: ReviewSweepResource;
  target: ReviewSweepTarget;
  /** When true, the chapter pickers are ignored and the whole book is swept. */
  wholeBook: boolean;
  from: number | null;
  to: number | null;
}

type Common = { resource: ReviewSweepResource; state: ReviewSweepTarget };
export type ReviewSweepBody =
  | (Common & { chapter: number })
  | (Common & { chapterStart: number; chapterEnd: number })
  | (Common & { allChapters: true });

export type ReviewSweepBuild =
  | { ok: true; body: ReviewSweepBody }
  | { ok: false; error: "no_chapter" | "range_reversed" };

export function buildReviewSweepBody(form: ReviewSweepForm): ReviewSweepBuild {
  const common: Common = { resource: form.resource, state: form.target };
  if (form.wholeBook) return { ok: true, body: { ...common, allChapters: true } };
  if (form.from == null || form.to == null) return { ok: false, error: "no_chapter" };
  if (form.to < form.from) return { ok: false, error: "range_reversed" };
  if (form.from === form.to) return { ok: true, body: { ...common, chapter: form.from } };
  return { ok: true, body: { ...common, chapterStart: form.from, chapterEnd: form.to } };
}
