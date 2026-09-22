// Pure logic behind PackageHubScreen's lifecycle card (docs/ux-simplification.md
// A4): the book-level review-progress rollup and the classification of export
// snapshot rows into presentable outcomes. No React, no fetch — testable via
// packageLifecycle.test.mjs (npm --workspace web run test).

import type { BookSummary, ExportSnapshot } from "../sync/api";

type SummaryChapter = BookSummary["chapters"][number];

export interface ProgressPair {
  done: number;
  total: number;
}

export interface ReviewProgress {
  notes: ProgressPair;
  questions: ProgressPair;
  verses: ProgressPair;
}

/**
 * Aggregate the per-chapter review rollup (tnValidated / tqValidated /
 * versesDone, additive fields from GET /api/chapters/:book) into book totals.
 *
 * Returns null when NO chapter carries any rollup field — that means the API
 * build predates A2, and the card must hide the progress section rather than
 * render a fake 0% ("a count with no backend is absent, not faked" —
 * PackageHubScreen's standing rule). Callers pass the realChapters() output so
 * the chapter-0 front-matter entry follows the hub's existing filtering.
 */
export function reviewProgress(chapters: SummaryChapter[]): ReviewProgress | null {
  const hasRollup = chapters.some(
    (c) => c.tnValidated !== undefined || c.tqValidated !== undefined || c.versesDone !== undefined,
  );
  if (!hasRollup) return null;
  const p: ReviewProgress = {
    notes: { done: 0, total: 0 },
    questions: { done: 0, total: 0 },
    verses: { done: 0, total: 0 },
  };
  for (const c of chapters) {
    p.notes.total += c.tn;
    p.notes.done += c.tnValidated ?? 0;
    p.questions.total += c.tq;
    p.questions.done += c.tqValidated ?? 0;
    p.verses.total += c.verses;
    p.verses.done += c.versesDone ?? 0;
  }
  return p;
}

export interface AwaitingReview {
  notes: number;
  questions: number;
}

/**
 * Rows a human still has to look at: tn / tq in translation_state 'ai_draft'
 * or 'edited' (the rollup extension from issue #104). Deliberately NOT
 * "everything not validated" — rows with no translation_state were never
 * touched by the translate pipeline, so counting them would report
 * untranslated source as a review backlog.
 *
 * Returns null when no chapter carries either draft-state field, i.e. the API
 * build predates the widened rollup: the caller must show absence, not 0.
 */
export function draftsAwaitingReview(chapters: SummaryChapter[]): AwaitingReview | null {
  const hasRollup = chapters.some(
    (c) =>
      c.tnAiDraft !== undefined ||
      c.tnEdited !== undefined ||
      c.tqAiDraft !== undefined ||
      c.tqEdited !== undefined,
  );
  if (!hasRollup) return null;
  const out: AwaitingReview = { notes: 0, questions: 0 };
  for (const c of chapters) {
    out.notes += (c.tnAiDraft ?? 0) + (c.tnEdited ?? 0);
    out.questions += (c.tqAiDraft ?? 0) + (c.tqEdited ?? 0);
  }
  return out;
}

/** 0..100, clamped; 0 when the total is 0 (the bar simply stays empty). */
export function progressPercent(pair: ProgressPair): number {
  if (pair.total <= 0) return 0;
  return Math.max(0, Math.min(100, (pair.done / pair.total) * 100));
}

// ── Export snapshot outcomes ────────────────────────────────────────────────
//
// The `error` column of export_snapshots is really a reason column
// (exportWorkflow.recordSnapshot): NULL = committed; "held_for_review:<n>" =
// every row omitted by the provenance-aware publish gate; "unchanged" =
// rendered content already matches master; "error:<msg>" = the step threw;
// anything else is a named skip (dry_run, no_rows, stale_master:*,
// shrink_guard:*, lane_blocked:*, held_out:*, …). pr_error is orthogonal: the
// commit landed but the PR step had trouble.

export type SnapshotOutcome =
  | { kind: "committed"; rows: number; prProblem: string | null }
  | { kind: "held"; count: number }
  | { kind: "unchanged" }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; detail: string };

type SnapshotLike = Pick<ExportSnapshot, "rows_exported" | "error" | "pr_error">;

export function classifySnapshot(s: SnapshotLike): SnapshotOutcome {
  const reason = s.error;
  if (reason == null) {
    return { kind: "committed", rows: s.rows_exported, prProblem: s.pr_error ?? null };
  }
  const held = /^held_for_review:(\d+)$/.exec(reason);
  if (held) return { kind: "held", count: parseInt(held[1], 10) };
  if (reason === "unchanged") return { kind: "unchanged" };
  if (reason.startsWith("error:")) return { kind: "error", detail: reason.slice("error:".length) };
  return { kind: "skipped", reason };
}

// Canonical presentation order for the per-resource outcome list.
export const RESOURCE_ORDER = ["ult", "ust", "tn", "tq", "twl"] as const;

/**
 * The most recent snapshot per resource, in RESOURCE_ORDER. Resources with no
 * snapshot at all are omitted (never attempted ≠ skipped). Defensive about
 * ordering: picks max id per resource rather than trusting input order, and
 * ignores resources outside RESOURCE_ORDER (e.g. the context pack's "ctx").
 */
export function latestPerResource(snapshots: ExportSnapshot[]): ExportSnapshot[] {
  const byResource = new Map<string, ExportSnapshot>();
  for (const s of snapshots) {
    const cur = byResource.get(s.resource);
    if (!cur || s.id > cur.id) byResource.set(s.resource, s);
  }
  const out: ExportSnapshot[] = [];
  for (const r of RESOURCE_ORDER) {
    const s = byResource.get(r);
    if (s) out.push(s);
  }
  return out;
}

// Workflow instance statuses that mean the run is over (Cloudflare Workflows
// status vocabulary — same values AdminWorkflowScreen surfaces raw).
const TERMINAL_STATUSES = new Set(["complete", "errored", "terminated"]);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status != null && TERMINAL_STATUSES.has(status);
}
