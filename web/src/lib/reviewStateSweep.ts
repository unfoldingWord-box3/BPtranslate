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

// ── Live update for open chapter tabs (#395) ─────────────────────────────────
// After a sweep the server broadcasts one `chapter.review_state_swept` hint per
// changed chapter (api/src/reviewState.ts broadcastSweep; event type in
// api/src/wsEvents.ts). It names no rows, so an open chapter refetches and
// patches ONLY translation_state onto the rows it already holds: the sweep never
// changes content or version, so leaving content alone means the refetch cannot
// clobber what a translator has on screen mid-edit.

export interface ReviewStateSweptEvent {
  book: string;
  chapter: number;
  resource: ReviewSweepResource;
  state: ReviewSweepTarget;
}

export function parseReviewStateSwept(raw: unknown): ReviewStateSweptEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as Record<string, unknown>;
  if (ev.type !== "chapter.review_state_swept") return null;
  if (typeof ev.book !== "string" || typeof ev.chapter !== "number") return null;
  if (ev.resource !== "tn" && ev.resource !== "tq") return null;
  if (ev.state !== "approved" && ev.state !== "needs_review") return null;
  return { book: ev.book, chapter: ev.chapter, resource: ev.resource, state: ev.state };
}

type RowState = "ai_draft" | "edited" | "validated" | null;

/** State-only patches for rows held locally whose translation_state moved. */
export function reviewStatePatches(
  local: ReadonlyArray<{ id: string; translation_state?: RowState }>,
  fresh: ReadonlyArray<{ id: string; translation_state?: RowState }>,
): Array<{ id: string; translation_state: RowState }> {
  const byId = new Map(fresh.map((r) => [r.id, r.translation_state ?? null]));
  const out: Array<{ id: string; translation_state: RowState }> = [];
  for (const r of local) {
    if (!byId.has(r.id)) continue;
    const next = byId.get(r.id) ?? null;
    if ((r.translation_state ?? null) !== next) out.push({ id: r.id, translation_state: next });
  }
  return out;
}
