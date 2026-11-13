// Nightly lessons from editor corrections (issue #817; admin changes #908).
//
// Once a night, for a workspace whose admin switched this on, read what editors
// changed in the AI translation-note drafts they approved, ask the workspace's
// own AI model ONCE for a short list of lessons, store the set (with its cost),
// and render it into the context pack's instructions.md as
// "## Lessons from recent editor corrections" (contextExport.ts). Both runners
// already inject instructions.md into every drafting prompt.
//
// The rules, exactly (the help and the admin page say them in plain words):
//
//   switch    lesson_settings (migration 0085). No row = OFF. Off means no
//             mining, no AI call, no run row, and no lessons in the pack.
//   when      the CONTEXT_CRON tick (index.ts), after every workspace's daily
//             export has been requested; a run that stores a changed set
//             queues one more context export so the set reaches the pack. Only
//             when the chapters it would mine hold a hand approval newer than
//             the watermark (or that chapter's own mark, see budget) of the
//             last run that finished its mining ('ok' or 'no_changes'; a
//             failed or killed run's approvals are mined again), counting
//             edit_log 'validate' entries of validated tN rows with no
//             admin_bulk_state stamp (#833), and only once per UTC day
//             (lesson_runs.night is UNIQUE). A run left 'running' from an
//             earlier night, or from tonight for longer than RUN_STALE_SECONDS,
//             is closed as failed ('interrupted'); tonight's interrupted run
//             is the one run a later invocation the same night may take over.
//   budget    mining stops once MINING_CELL_BUDGET diff cells are spent. New
//             approvals are diffed first, oldest first; a run that stops among
//             them records its watermark just below the first one left and is
//             marked truncated (migration 0086). The next run then mines that
//             run's chapters again, not the newest ones, so nothing it left is
//             skipped when editors moved to another chapter in between; if
//             the newest chapters differ, the resume's watermark stops just
//             below their first approval it did not mine (#912), and the
//             night after mines the newest chapters. Since one watermark
//             cannot also say how far each of those chapters got, a run
//             records per-chapter marks where they differ from it (#915,
//             migration 0088): a resumed chapter finished past the watermark
//             (its approvals are not new again), and a newest chapter a resume
//             left for later (its approvals stay new, and it is mined with the
//             newest chapters even once editors have moved past it). A
//             budget that runs out only on older notes of the window (every
//             new approval compared) is not a stop.
//   provider  the workspace's own key, only for providers with an in-Worker
//             adapter (Claude, Gemini: hasInternalAdapter). Anything else is
//             "not available": no call, no run row.
//   input     the current lessons; instructions_md and common_issues_md; the
//             live terms (capped); and the editors' changes in the
//             RECENT_CHAPTERS chapters whose newest hand approval is newest.
//             A change is what suggestionInbox.noteChanges finds between the
//             draft the editor saw (the latest ai_pipeline edit_log payload,
//             i.e. after house-style rules, #815) and the approved note,
//             grouped by before/after and counted once per note. A change that
//             only adds, removes or moves a short vowel on a shadda is left out
//             (the Arabic editor: both forms are correct, 2026-11-10).
//   output    at most MAX_LESSONS lessons, each one line with an example and an
//             evidence count. Code enforces: a current lesson stays unless the
//             model names it as reversed by editors (a working lesson makes its
//             correction disappear, which is not a reason to drop it); a NEW
//             lesson whose example is already a term, a template or a line of
//             the instructions / Common issues is dropped; lengths are capped
//             and each lesson is flattened to one line. An admin's changes
//             (#908) bind it too: a pinned lesson is kept exactly as it is and
//             never trimmed; a deleted lesson does not come back as a new one
//             (same wording or example) unless a note approved after the
//             delete shows its example change again.
//   edits     delete / pin / unpin / promote / restore each write a new set
//             (status 'edited'); see "Admin changes" below.
//   failure   an unreadable reply or a failed call keeps the previous set; the
//             run row still records what was billed.
//
// Imports carry .ts suffixes so the node strip-types test runner resolves them.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, editSource, requireAdmin } from "./auth.ts";
import { queueContextExport, requestDailyContextExport } from "./contextExportQueue.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { nfc } from "./contextExportLib.ts";
import { SCORECARD_ROWS_SQL } from "./draftScorecard.ts";
import {
  noteChanges,
  coveredByTerm,
  coveredByTemplate,
  coveredByCommonIssues,
  DIFF_SEGMENT_CAP,
  type InboxTerm,
} from "./suggestionInbox.ts";
import { resolveProvider, type Availability } from "./templateDraftMissing.ts";
import {
  BEGIN_OUTPUT,
  END_OUTPUT,
  TranslateProviderError,
  callProvider,
  extractOutput,
  transportFor,
  type Transport,
  type TransportUsage,
} from "./translate/llm.ts";
import { estimateCost } from "./translate/providerCatalog.ts";
import {
  SET_STATUSES_SQL,
  lessonLine,
  lessonsEnabled as lessonsEnabledRead,
  loadCurrentLessons,
  loadLessonSet,
  tableMissing,
  type Lesson,
} from "./lessonsRender.ts";
import { PREFS_HISTORY_SQL } from "./prefsHistorySql.ts";

export {
  LESSONS_HEADING,
  lessonLine,
  lessonsEnabled,
  loadCurrentLessons,
  loadLessonSet,
  loadLessonsForRender,
  renderLessonsSection,
  type Lesson,
} from "./lessonsRender.ts";

/** Lessons kept at most. */
export const MAX_LESSONS = 25;
/** Chapters (across books) whose corrections are read, most recently approved first. */
export const RECENT_CHAPTERS = 2;
/** Change groups shown to the model, most frequent first. */
export const MAX_PROMPT_CHANGES = 60;
/** Terms listed in the prompt. All terms are still used to drop duplicate lessons. */
export const MAX_PROMPT_TERMS = 300;
/** instructions_md and common_issues_md are each cut to this many characters in the prompt. */
export const PREFS_CHAR_CAP = 6000;
/** A lesson longer than this is cut. */
export const LESSON_CHAR_CAP = 300;
/** Each side of a lesson's example is cut to this. */
export const EXAMPLE_CHAR_CAP = 120;
/** One small call; a call that has not returned by now is hung. */
export const CALL_TIMEOUT_MS = 120_000;
/**
 * LCS cells one night's mining may fill, for the whole run (each note is also
 * capped at DIFF_SEGMENT_CAP tokens a side, 160,000 cells). The tick runs every
 * workspace in one scheduled invocation, so this is far below the inbox's
 * 300M-per-request budget: about 300 fully rewritten maximum-length notes, or
 * tens of thousands of ordinary ones.
 */
export const MINING_CELL_BUDGET = 50_000_000;
/**
 * A run still 'running' this long after it started was killed: a scheduled
 * invocation cannot run longer than 15 minutes.
 */
export const RUN_STALE_SECONDS = 30 * 60;
/** Each term field in the prompt is cut to this. */
export const TERM_CHAR_CAP = 100;
/** Each side of an example excerpt in the prompt is cut to this. */
export const EXCERPT_CHAR_CAP = 240;
/**
 * The whole user prompt stays under this many characters. Change lines are
 * admitted before term lines; whatever does not fit is counted as not shown.
 */
export const PROMPT_CHAR_CAP = 80_000;

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

/** One distinct correction in the window, counted once per note. */
export type ChangeGroup = {
  before: string;
  after: string;
  count: number;
  draftExcerpt: string;
  finalExcerpt: string;
  /** The newest hand approval (edit_log id) among the notes showing it; null when none had one. */
  lastApproval: number | null;
};

export type ChapterRef = { book: string; chapter: number };

export type RunStatus = "running" | "ok" | "no_changes" | "failed";

export type LessonRun = {
  id: number;
  night: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  failureReason: string | null;
  chapters: ChapterRef[];
  changes: number;
  provider: string | null;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null = no price known (or no call made), never a hidden $0. */
  costUsd: number | null;
};

export type LessonJobOutcome =
  | { ran: false; reason: "off" | "not_migrated" | "no_new_approvals" | "already_ran" | string }
  | {
      ran: true;
      runId: number;
      status: Exclude<RunStatus, "running">;
      failureReason: string | null;
      lessons: number;
      /**
       * True when the stored lessons' wording or examples differ from the set
       * before: the context pack needs an export. A new evidence count alone
       * does not count (the pack shows it from the next export on).
       */
      changed: boolean;
      /**
       * The mining budget ran out (MINING_CELL_BUDGET) before every note in
       * the window was diffed. The next night resumes only when it stopped
       * among NEW approvals (the run row's own truncated flag); a run that ran
       * out only on older notes of the window is complete.
       */
      truncated: boolean;
    };

type Db = Env["DB"];

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

// Hand approvals of validated tN rows: the same rows the scorecard compares.
const HAND_APPROVAL_JOIN = `FROM edit_log e
    JOIN tn_rows t ON t.id = e.row_key AND t.book = e.book
   WHERE e.kind = 'tn' AND e.action = 'validate'
     AND t.translation_state = 'validated' AND t.admin_bulk_state IS NULL
     AND t.deleted_at IS NULL AND t.trashed_at IS NULL`;

/** The newest hand approval's edit_log id, or null when there is none. */
export async function approvalWatermark(db: Db): Promise<number | null> {
  const r = await db.prepare(`SELECT MAX(e.id) AS w ${HAND_APPROVAL_JOIN}`).first<{ w: number | null }>();
  return r?.w ?? null;
}

/**
 * The chapters whose newest hand approval is newest, counting only approvals
 * up to `upTo` when given (the night's watermark: a later one must not push a
 * chapter out of tonight's window, #923).
 */
export async function recentApprovedChapters(db: Db, n = RECENT_CHAPTERS, upTo: number | null = null): Promise<ChapterRef[]> {
  const rs = await db
    .prepare(
      `SELECT t.book AS book, t.chapter AS chapter, MAX(e.id) AS last_id ${HAND_APPROVAL_JOIN}
          AND (?2 IS NULL OR e.id <= ?2)
        GROUP BY t.book, t.chapter ORDER BY last_id DESC LIMIT ?1`,
    )
    .bind(n, upTo)
    .all<{ book: string; chapter: number }>();
  return (rs.results ?? []).map((r) => ({ book: r.book, chapter: r.chapter }));
}

/** Where a chapter's hand approvals count as new: above this edit_log id (any, when null). */
type AfterIn = (ch: ChapterRef) => number | null;

/**
 * The chapters holding a hand approval newer than their own `afterIn` mark and
 * no newer than `upTo`, the night's watermark: one committed after it was read
 * is the next night's (#923).
 */
async function chaptersWithNew(db: Db, chapters: readonly ChapterRef[], afterIn: AfterIn, upTo: number): Promise<ChapterRef[]> {
  const out: ChapterRef[] = [];
  for (const ch of chapters) {
    const r = await db
      .prepare(
        `SELECT 1 AS x ${HAND_APPROVAL_JOIN} AND t.book = ?1 AND t.chapter = ?2 AND (?3 IS NULL OR e.id > ?3) AND e.id <= ?4 LIMIT 1`,
      )
      .bind(ch.book, ch.chapter, afterIn(ch), upTo)
      .first();
    if (r) out.push(ch);
  }
  return out;
}

/** The oldest hand approval in the chapters with after < id <= upTo, or null when there is none. */
async function firstApprovalIn(db: Db, chapters: readonly ChapterRef[], after: number | null, upTo: number): Promise<number | null> {
  let first: number | null = null;
  for (const ch of chapters) {
    const r = await db
      .prepare(`SELECT MIN(e.id) AS id ${HAND_APPROVAL_JOIN} AND t.book = ?1 AND t.chapter = ?2 AND (?3 IS NULL OR e.id > ?3) AND e.id <= ?4`)
      .bind(ch.book, ch.chapter, after, upTo)
      .first<{ id: number | null }>();
    if (r?.id != null && (first == null || r.id < first)) first = r.id;
  }
  return first;
}

const SHORT_VOWEL = /[ً-ِ]/u;
const SHADDA = "ّ";

// A base character with the combining marks that follow it (a leading mark
// stands alone). Marks on a letter, in either order, stay in its cluster.
const CLUSTERS = /\p{M}+|\P{M}\p{M}*/gu;
const clusters = (s: string) => s.match(CLUSTERS) ?? [];

/**
 * True when before and after differ ONLY in whether a letter with a shadda
 * carries a short vowel or tanween: present on one side, absent on the other
 * (أنَّ / أنّ). The Arabic editor writes it or leaves it out by preference
 * (2026-11-10), so it is not a correction to learn from. A vowel swapped for
 * another on a shadda (الربُّ → الربَّ) is a real grammar fix and is kept.
 */
export function isShaddaVowelOnly(before: string, after: string): boolean {
  const b = clusters(nfc(before));
  const a = clusters(nfc(after));
  if (b.length !== a.length) return false;
  let differs = false;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === a[i]) continue;
    if (!b[i].includes(SHADDA) || !a[i].includes(SHADDA)) return false;
    const vowels = (c: string) => [...c].filter((ch) => SHORT_VOWEL.test(ch));
    const rest = (c: string) => [...c].filter((ch) => !SHORT_VOWEL.test(ch)).join("");
    if (rest(b[i]) !== rest(a[i])) return false;
    // One side bare, the other with vowel(s): a preference. Both with vowels: a swap.
    if ((vowels(b[i]).length === 0) === (vowels(a[i]).length === 0)) return false;
    differs = true;
  }
  return differs;
}

export type MineResult = {
  groups: ChangeGroup[];
  compared: number;
  changed: number;
  /** The run's cell budget ran out before every note in the window was diffed. */
  truncated: boolean;
  /**
   * The approval (edit_log id) of the first NEW approval left undiffed when the
   * budget ran out, or null when every new approval was diffed. The run then
   * records its watermark just below it, so the next night starts there.
   */
  stoppedAt: number | null;
};

// One diff of the largest pair noteChanges accepts (DIFF_SEGMENT_CAP tokens a side).
const NOTE_CELLS = DIFF_SEGMENT_CAP * DIFF_SEGMENT_CAP;

/**
 * Group the corrections of the given chapters.
 *
 * Work is bounded twice. Each note gets its own budget, enough for the largest
 * diff noteChanges accepts, so one long rewrite never starves the notes after
 * it (a note too long to diff is skipped and not counted as compared). And the
 * whole run stops once `cells` are spent (MINING_CELL_BUDGET), so thousands of
 * long rewrites cannot exceed the scheduled Worker's CPU limit. The note that
 * crosses the line finishes, so every run diffs at least one note.
 *
 * The order makes a stopped run lose nothing: notes approved after `after`
 * (the last finished run's watermark; `afterIn` gives each chapter its own
 * mark, #915) come first, oldest approval first, then the rest of the window,
 * newest approval first. When the budget runs out among the new approvals,
 * `stoppedAt` names the first one left, and the next night resumes from it.
 */
export async function mineChanges(
  db: Db,
  chapters: readonly ChapterRef[],
  opts: { after?: number | null; afterIn?: AfterIn; upTo?: number | null; cells?: number } = {},
): Promise<MineResult> {
  const afterIn: AfterIn = opts.afterIn ?? (() => opts.after ?? null);
  const upTo = opts.upTo ?? null;
  const runCells = opts.cells ?? MINING_CELL_BUDGET;
  type Row = { id: string; final_note: string | null; draft_note: unknown; approval_id: number | null; after: number | null };
  const rows: Row[] = [];
  for (const ch of chapters) {
    const after = afterIn(ch);
    const rs = await db
      .prepare(
        `SELECT s.id AS id, s.final_note AS final_note, s.draft_note AS draft_note,
                (SELECT MAX(a.id) FROM edit_log a
                  WHERE a.kind = 'tn' AND a.action = 'validate' AND a.row_key = s.id AND a.book = ?1) AS approval_id
           FROM (${SCORECARD_ROWS_SQL}) s WHERE s.chapter = ?2`,
      )
      .bind(ch.book, ch.chapter)
      .all<Omit<Row, "after">>();
    rows.push(...(rs.results ?? []).map((r) => ({ ...r, after })));
  }
  // New: approved after the chapter's mark, and no later than the night's
  // watermark (`upTo`): a later one is the next night's (#923).
  const isNew = (r: Row) =>
    r.approval_id != null && (r.after == null || r.approval_id > r.after) && (upTo == null || r.approval_id <= upTo);
  const fresh = rows.filter(isNew).sort((a, b) => a.approval_id! - b.approval_id!);
  // Array.sort is stable: rows without a hand approval keep their window order, last.
  const rest = rows.filter((r) => !isNew(r)).sort((a, b) => (b.approval_id ?? -1) - (a.approval_id ?? -1));

  const byKey = new Map<string, ChangeGroup>();
  let compared = 0;
  let changed = 0;
  let spent = 0;
  let truncated = false;
  let stoppedAt: number | null = null;
  for (const r of [...fresh, ...rest]) {
    if (typeof r.draft_note !== "string" || r.final_note == null) continue;
    if (spent >= runCells) {
      truncated = true;
      if (isNew(r)) stoppedAt = r.approval_id;
      break;
    }
    const budget = { cells: NOTE_CELLS };
    const changes = noteChanges(r.draft_note, r.final_note, budget);
    spent += NOTE_CELLS - budget.cells;
    if (!changes) continue;
    compared++;
    if (changes.length === 0) continue;
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.key) || isShaddaVowelOnly(c.before, c.after)) continue;
      seen.add(c.key);
      const g = byKey.get(c.key);
      if (g) {
        g.count++;
        if (r.approval_id != null && (g.lastApproval == null || r.approval_id > g.lastApproval)) g.lastApproval = r.approval_id;
      } else
        byKey.set(c.key, {
          before: c.before,
          after: c.after,
          count: 1,
          draftExcerpt: c.draftExcerpt,
          finalExcerpt: c.finalExcerpt,
          lastApproval: r.approval_id,
        });
    }
    if (seen.size > 0) changed++;
  }
  const groups = [...byKey.values()].sort(
    (a, b) => b.count - a.count || (a.before < b.before ? -1 : a.before > b.before ? 1 : a.after < b.after ? -1 : 1),
  );
  return { groups, compared, changed, truncated, stoppedAt };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type PromptTerm = { source: string; target: string | null; status: string; replacement: string | null };

/**
 * At most n code points, cut only between clusters (a letter keeps its marks),
 * with "…" when anything was cut.
 */
export function capText(s: string, n: number): string {
  if ([...s].length <= n) return s;
  let out = "";
  let used = 0;
  for (const c of clusters(s)) {
    const len = [...c].length;
    if (used + len > n) break;
    out += c;
    used += len;
  }
  return `${out}…`;
}
const cap = capText;

export function buildLessonsPrompt(input: {
  languageName: string;
  languageCode: string;
  current: readonly Lesson[];
  instructionsMd: string | null;
  commonIssuesMd: string | null;
  terms: readonly PromptTerm[];
  chapters: readonly ChapterRef[];
  compared: number;
  changed: number;
  groups: readonly ChangeGroup[];
}): { system: string; user: string } {
  const system = [
    `You keep a short list of lessons for an AI that drafts Bible translation notes in ${field(input.languageName, 80)} (${field(input.languageCode, 20)}).`,
    "Editors correct each AI draft before approving it. You are shown what they changed in the most recently approved chapters, with how many notes each change was made in, and the lessons the AI is given today.",
    "",
    "Rules:",
    `- At most ${MAX_LESSONS} lessons in total, counting the ones you keep. Each lesson is one or two short lines in English that tell the drafting AI what to do, with one example (the AI's words and the editor's words) and an evidence count (how many notes show it).`,
    "- Write a lesson only for a correction editors make again and again. One-off rewrites are not lessons.",
    "- Do not write a lesson that repeats something the instructions, the Common issues or the terms below already say.",
    "- Keep every current lesson unless the changes show editors now reversing it (changing the lesson's 'after' words back). A lesson that works makes its correction disappear from the changes; that is NOT a reason to drop it. Update a kept lesson's wording or evidence when the changes support it.",
    "- Arabic shadda vowels are a preference, not an error. Writing or leaving out the short vowel on a shadda (أنَّ or أنّ) are both accepted. Never write a lesson that treats adding or removing a vowel on a shadda as a correction. If you mention it at all, say: vowel on the shadda by default, none before punctuation, both acceptable.",
    "",
    "Reply with one JSON object between the markers, and nothing else:",
    BEGIN_OUTPUT,
    '{"lessons": [{"id": "L1", "lesson": "…", "before": "…", "after": "…", "evidence": 12}, {"id": null, "lesson": "…", "before": "…", "after": "…", "evidence": 9}], "reversed": ["L2"]}',
    END_OUTPUT,
    '"id" is the current lesson\'s id (L1, L2, …) for a lesson you keep, or null for a new one. "reversed" lists the ids of current lessons that editors are now reversing. A current lesson you do not list in either place is kept as it is.',
  ].join("\n");

  // Every interpolated string is flattened to one line and capped: only item
  // counts were capped before, and one 10,000-character term or token would
  // carry straight into the provider's input.
  const head: string[] = [];
  head.push("# Current lessons", "");
  if (input.current.length === 0) head.push("(none yet)");
  else input.current.forEach((l, i) => head.push(`L${i + 1}. ${field(lessonLine(l).slice(2), LESSON_LINE_CAP)}`));

  head.push("", "# Instructions the drafting AI already gets", "");
  head.push(input.instructionsMd?.trim() ? cap(input.instructionsMd.trim(), PREFS_CHAR_CAP) : "(none)");
  head.push("", "## Common issues", "");
  head.push(input.commonIssuesMd?.trim() ? cap(input.commonIssuesMd.trim(), PREFS_CHAR_CAP) : "(none)");

  const termLines = input.terms.slice(0, MAX_PROMPT_TERMS).map((t) => {
    const source = field(t.source, TERM_CHAR_CAP);
    const target = field(t.target ?? "", TERM_CHAR_CAP);
    const replacement = field(t.replacement ?? "", TERM_CHAR_CAP);
    const status = field(t.status, 20);
    return t.status === "forbidden"
      ? `- ${source}: never «${target}»${replacement ? `, use «${replacement}»` : ""}`
      : `- ${source} → «${target}»${status && status !== "preferred" ? ` (${status})` : ""}`;
  });
  const changeLines = input.groups
    .slice(0, MAX_PROMPT_CHANGES)
    .map(
      (g) =>
        `- ${g.count}× «${field(g.before, EXAMPLE_CHAR_CAP)}» → «${field(g.after, EXAMPLE_CHAR_CAP) || "∅"}»   e.g. «${field(g.draftExcerpt, EXCERPT_CHAR_CAP)}» ⇒ «${field(g.finalExcerpt, EXCERPT_CHAR_CAP)}»`,
    );

  const where = input.chapters.map((c) => `${field(c.book, 10)} ${c.chapter}`).join(", ");
  const changesHead = [
    "",
    "# What editors changed",
    "",
    `Chapters: ${where}. Approved notes compared with their AI draft: ${input.compared}; notes the editor changed: ${input.changed}.`,
    "Each line: the number of notes with that change, the AI's words → the editor's words (∅ = deleted), then one example in context.",
    "",
  ];

  // Whole lines within PROMPT_CHAR_CAP: changes before terms, since the
  // changes are what tonight's run is about. The "not shown" lines (and the
  // terms heading) are reserved for up front, so their counts stay true.
  const RESERVED = 200;
  let room =
    PROMPT_CHAR_CAP - RESERVED - [...head, "", "# Terms (source → target)", "", ...changesHead].join("\n").length;
  const admit = (lines: string[]) => {
    const out: string[] = [];
    for (const line of lines) {
      if (line.length + 1 > room) break;
      room -= line.length + 1;
      out.push(line);
    }
    return out;
  };
  const changesShown = admit(changeLines);
  const termsShown = admit(termLines);

  const parts = [...head, "", "# Terms (source → target)", ""];
  if (input.terms.length === 0) parts.push("(none)");
  parts.push(...termsShown);
  if (input.terms.length > termsShown.length) parts.push(`(${input.terms.length - termsShown.length} more terms not shown)`);
  parts.push(...changesHead, ...changesShown);
  if (input.groups.length > changesShown.length) {
    parts.push(`(${input.groups.length - changesShown.length} rarer changes not shown)`);
  }
  return { system, user: parts.join("\n") };
}

// A stored lesson line: its lesson and both example sides are already capped
// when the set is written; this bounds it again for the prompt.
const LESSON_LINE_CAP = LESSON_CHAR_CAP + 2 * EXAMPLE_CHAR_CAP + 60;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ParsedLesson = { id: string | null; lesson: string; before: string; after: string; evidence: number | null };
export type ParsedOutput = { lessons: ParsedLesson[]; reversed: string[] };

const oneLine = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
/** One prompt field: flattened to one line, then capped. */
const field = (s: unknown, n: number) => cap(oneLine(s), n);

/** null when the reply holds no readable JSON object of the agreed shape. */
export function parseLessonsOutput(text: string): ParsedOutput | null {
  let body = extractOutput(text);
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a === -1 || b < a) return null;
  body = body.slice(a, b + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || !Array.isArray((obj as { lessons?: unknown }).lessons)) return null;
  const o = obj as { lessons: unknown[]; reversed?: unknown };
  const lessons: ParsedLesson[] = [];
  for (const item of o.lessons) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    // Only a real number counts: null, "" or a word is "no count given".
    const raw = it.evidence;
    const ev = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    lessons.push({
      id: typeof it.id === "string" && it.id.trim() ? it.id.trim() : null,
      lesson: oneLine(it.lesson),
      before: oneLine(it.before),
      after: oneLine(it.after),
      evidence: Number.isFinite(ev) ? Math.max(0, Math.floor(ev)) : null,
    });
  }
  const reversed = Array.isArray(o.reversed) ? o.reversed.filter((x): x is string => typeof x === "string").map((x) => x.trim()) : [];
  return { lessons, reversed };
}

// A lesson goes verbatim into every drafting prompt: one line, no heading or
// list marker of its own, bounded.
function cleanLessonText(s: string): string {
  return cap(oneLine(s).replace(/^(?:#+|[-*•]|\d+[.)])\s*/, "").trim(), LESSON_CHAR_CAP);
}

export type CoverContext = {
  terms: InboxTerm[];
  templates: string[];
  instructionsMd: string;
  commonIssuesMd: string;
  /** Notes compared in this run: no lesson can claim more evidence than that. */
  maxEvidence?: number;
  /** Lessons an admin deleted (#908): a new lesson that repeats one is dropped... */
  deleted?: readonly DeletedLesson[];
  /** ...unless one of tonight's changes shows its example in a note approved after the delete. */
  changes?: readonly ChangeGroup[];
};

/** A lesson_deletions row: what was deleted, and the newest approval at that moment. */
export type DeletedLesson = { lesson: string; before: string; after: string; approvalsThrough: number };

const normText = (s: string) => nfc(oneLine(s)).toLowerCase();

/**
 * True when a NEW lesson repeats a deleted one (same wording, or the same
 * example) and no change mined tonight supports it anew: the deleted lesson's
 * own example change, seen in a note approved after the delete. The window
 * re-reads older notes every night, so without the "approved after" test the
 * notes that produced the lesson would bring it straight back.
 *
 * `kept` is the current lesson `l` would replace: a match on wording or an
 * example that lesson already has does not count, so a lesson that shares its
 * example with a deleted one can still be reworded (#912).
 */
export function deletedStill(
  l: { lesson: string; before: string; after: string },
  deleted: readonly DeletedLesson[],
  changes: readonly ChangeGroup[],
  kept?: { lesson: string; before: string; after: string } | null,
): boolean {
  const text = normText(l.lesson);
  const b = normText(l.before);
  const a = normText(l.after);
  return deleted.some((d) => {
    const db = normText(d.before);
    const da = normText(d.after);
    const dl = normText(d.lesson);
    const hasExample = db !== "" || da !== "";
    const keptWording = kept != null && normText(kept.lesson) === dl;
    const keptExample = kept != null && normText(kept.before) === db && normText(kept.after) === da;
    const same = (dl === text && !keptWording) || (hasExample && db === b && da === a && !keptExample);
    if (!same) return false;
    const anew =
      hasExample &&
      changes.some(
        (g) => normText(g.before) === db && normText(g.after) === da && g.lastApproval != null && g.lastApproval > d.approvalsThrough,
      );
    return !anew;
  });
}

function covered(l: { before: string; after: string }, ctx: CoverContext): boolean {
  if (!l.after) return false;
  return (
    coveredByTerm(l, ctx.terms) ||
    coveredByTemplate(l, ctx.templates) ||
    coveredByCommonIssues(l, ctx.commonIssuesMd) ||
    coveredByCommonIssues(l, ctx.instructionsMd)
  );
}

function clampEvidence(n: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.floor(n), Math.max(0, Math.floor(max))));
}

/**
 * The new set: the model's list checked against the rules above. A pinned
 * lesson (#908) is carried exactly as the admin pinned it: the model cannot
 * reword, reverse or drop it, and the trim never removes it.
 */
export function mergeLessons(
  current: readonly Lesson[],
  parsed: ParsedOutput,
  ctx: CoverContext,
  now: number,
): Lesson[] {
  const byId = new Map<string, Lesson>(current.map((l, i) => [`L${i + 1}`, l]));
  const reversed = new Set(parsed.reversed.filter((id) => byId.has(id)));
  const used = new Set<string>();
  // Pinned wording is taken first, so no lesson of the model's can displace it.
  const seenText = new Set<string>(current.filter((l) => l.pinned).map((l) => nfc(l.lesson).toLowerCase()));
  type Item = Lesson & { fresh: boolean };
  const out: Item[] = [];
  for (const p of parsed.lessons) {
    const prev = p.id && byId.has(p.id) ? byId.get(p.id)! : null;
    // A reversed lesson does not come back under its own id, and one id is used
    // once. A pinned lesson is added below, as it is.
    if (prev && (prev.pinned || reversed.has(p.id!) || used.has(p.id!))) continue;
    let text = cleanLessonText(p.lesson);
    if (!text) continue;
    let before = cap(oneLine(p.before), EXAMPLE_CHAR_CAP);
    let after = cap(oneLine(p.after), EXAMPLE_CHAR_CAP);
    if (isShaddaVowelOnly(before, after)) continue;
    if (!prev && covered({ before, after }, ctx)) continue;
    if (deletedStill({ lesson: text, before, after }, ctx.deleted ?? [], ctx.changes ?? [], prev)) {
      // A deleted lesson does not come back as a new one, nor as the new
      // wording or example of a kept one (#908 gate G2): a kept lesson keeps
      // its own wording and example.
      if (!prev) continue;
      text = prev.lesson;
      before = prev.before;
      after = prev.after;
    }
    const key = nfc(text).toLowerCase();
    if (seenText.has(key)) continue;
    seenText.add(key);
    if (prev) used.add(p.id!);
    out.push({
      lesson: text,
      before,
      after,
      // A kept lesson without a count keeps its own. Tonight's compared notes
      // cap the count, but never below what a kept lesson already had: a
      // small night (or one that ran out of time) does not erase its evidence.
      evidence: clampEvidence(
        p.evidence ?? prev?.evidence ?? 0,
        prev ? Math.max(ctx.maxEvidence ?? Number.MAX_SAFE_INTEGER, prev.evidence) : ctx.maxEvidence,
      ),
      firstSeenAt: prev?.firstSeenAt ?? now,
      pinned: false,
      fresh: !prev,
    });
  }
  // Current lessons the model neither kept nor named as reversed stay as they
  // are, and so does every pinned lesson.
  current.forEach((l, i) => {
    const id = `L${i + 1}`;
    if (!l.pinned && (used.has(id) || reversed.has(id))) return;
    const key = nfc(l.lesson).toLowerCase();
    if (!l.pinned && seenText.has(key)) return;
    seenText.add(key);
    out.push({ ...l, fresh: false });
  });
  // Over the cap: new lessons go first, last ones first; pinned lessons never.
  while (out.length > MAX_LESSONS) {
    let k = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].fresh) { k = i; break; }
    if (k === -1) for (let i = out.length - 1; i >= 0; i--) if (!out[i].pinned) { k = i; break; }
    if (k === -1) break;
    out.splice(k, 1);
  }
  return out.map(({ fresh: _fresh, ...l }) => l);
}

// ---------------------------------------------------------------------------
// The nightly job
// ---------------------------------------------------------------------------

/** A run's stored chapters (chapters_json); unreadable reads as none. */
function parseChapters(json: string): ChapterRef[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) {
      return v.filter(
        (c): c is ChapterRef => !!c && typeof c.book === "string" && typeof c.chapter === "number",
      );
    }
  } catch {
    // Unreadable: no chapters.
  }
  return [];
}

/** A chapter's own progress: its hand approvals are mined through `through` (#915). */
type Mark = ChapterRef & { through: number };
const chapterKey = (c: ChapterRef) => `${c.book} ${c.chapter}`;

/** A run's per-chapter marks (marks_json, migration 0088); NULL or unreadable reads as none. */
function parseMarks(json: string | null): Map<string, Mark> {
  const out = new Map<string, Mark>();
  if (json == null) return out;
  try {
    const v = JSON.parse(json) as unknown;
    if (Array.isArray(v)) {
      for (const m of v) {
        if (m && typeof m.book === "string" && typeof m.chapter === "number" && typeof m.through === "number") {
          out.set(chapterKey(m), { book: m.book, chapter: m.chapter, through: m.through });
        }
      }
    }
  } catch {
    // Unreadable: no marks.
  }
  return out;
}

export type LessonDeps = { transport?: Transport; now?: number; /** Mining budget (tests). */ cells?: number };

/**
 * Run tonight's lessons for this workspace (env is already workspace-resolved).
 * Never throws for a provider or output failure: that is recorded on the run
 * row. Throws only for unexpected D1 errors; the caller isolates it.
 */
export async function runNightlyLessons(env: Env, deps: LessonDeps = {}): Promise<LessonJobOutcome> {
  const db = env.DB;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const night = new Date(now * 1000).toISOString().slice(0, 10);

  // A run still 'running' from an earlier night, or from tonight but started
  // longer ago than any invocation can last, was killed (isolate evicted,
  // timeout): close it as failed so the page says so, every night, whether
  // the switch is on or not and whether or not tonight runs. Tonight's killed
  // run can then be retried tonight (the claim below).
  try {
    await db
      .prepare(
        `UPDATE lesson_runs SET status = 'failed', failure_reason = 'interrupted', finished_at = ?2
          WHERE status = 'running' AND (night <> ?1 OR started_at <= ?3)`,
      )
      .bind(night, now, now - RUN_STALE_SECONDS)
      .run();
  } catch (e) {
    // No lesson tables: an unmigrated workspace, which reads as off.
    if (tableMissing(e)) return { ran: false, reason: "off" };
    throw e;
  }
  if (!(await lessonsEnabledRead(db))) return { ran: false, reason: "off" };

  let last: number | null;
  let prev: { chapters_json: string; truncated: number; marks_json: string | null } | null;
  let deleted: DeletedLesson[];
  try {
    // Only runs that finished their mining move the watermark: a failed or
    // killed run's corrections are mined again on a later night. Spend stays
    // at one call a night through the night claim below.
    last =
      (
        await db
          .prepare(`SELECT MAX(approvals_through) AS w FROM lesson_runs WHERE status IN ('ok', 'no_changes')`)
          .first<{ w: number | null }>()
      )?.w ?? null;
    prev = await db
      .prepare(
        `SELECT chapters_json, truncated, marks_json FROM lesson_runs WHERE status IN ('ok', 'no_changes') ORDER BY id DESC LIMIT 1`,
      )
      .first<{ chapters_json: string; truncated: number; marks_json: string | null }>();
    // Read here so a database without 0087 reads as not_migrated; read again
    // after the claim below, since an admin change can land before it.
    deleted = await loadDeletedLessons(db);
  } catch (e) {
    // A missing table or column (a migration behind): not_migrated, never a
    // generic failure every night (#908 leftover 6).
    if (tableMissing(e)) return { ran: false, reason: "not_migrated" };
    throw e;
  }
  let watermark: number | null = null;
  let newest: ChapterRef[];
  let resume: ChapterRef[];
  let tonight: ChapterRef[];
  // Which chapters tonight mines, and from where (#915). A chapter the last
  // run left a mark for is mined from that mark, any other from the watermark.
  // Resume: when the last finished run stopped among new approvals, this run
  // mines that run's chapters, not the newest ones, so the approvals it left
  // are compared even when editors moved to another chapter since. A stored
  // resume whose chapters no longer hold a new approval (its notes were
  // un-approved since) is stale, however old: mine the newest chapters instead
  // (#908 leftover 4). Otherwise: the newest chapters, plus any chapter a
  // resume left owed (marked below the watermark, still holding a new
  // approval) that is no longer among them. The newest-chapters window, the
  // new-approval checks below and the mining's "new" count only approvals up
  // to the watermark read first: one committed after it is the next night's
  // and cannot move tonight's window (#923).
  const marks = parseMarks(prev?.marks_json ?? null);
  const afterIn: AfterIn = (c) => marks.get(chapterKey(c))?.through ?? last;
  try {
    watermark = await approvalWatermark(db);
    if (watermark == null) return { ran: false, reason: "no_new_approvals" };
    const upTo = watermark;
    newest = await recentApprovedChapters(db, RECENT_CHAPTERS, upTo);
    const stored = prev?.truncated ? parseChapters(prev.chapters_json) : [];
    resume = stored.length > 0 && (await chaptersWithNew(db, stored, afterIn, upTo)).length > 0 ? stored : [];
    const owed =
      resume.length > 0 || last == null
        ? []
        : await chaptersWithNew(
            db,
            [...marks.values()]
              .filter((m) => m.through < last && !newest.some((c) => chapterKey(c) === chapterKey(m)))
              .map((m) => ({ book: m.book, chapter: m.chapter })),
            afterIn,
            upTo,
          );
    tonight = resume.length > 0 ? resume : [...newest, ...owed];
    // Only a night with a new approval in the chapters it mines runs: notes a
    // resume already compared past the watermark are not new again.
    if (resume.length === 0 && owed.length === 0 && (await chaptersWithNew(db, newest, afterIn, upTo)).length === 0) {
      return { ran: false, reason: "no_new_approvals" };
    }
  } catch (e) {
    // These reads come before the night claim, so leave the failed run the
    // claim would have: the admin page then shows the night (#923). Never over
    // a row tonight already has; the original error is the one rethrown.
    try {
      await db
        .prepare(
          `INSERT INTO lesson_runs (night, started_at, finished_at, status, failure_reason, approvals_through)
           VALUES (?1, ?2, ?2, 'failed', 'internal_error', ?3) ON CONFLICT(night) DO NOTHING`,
        )
        .bind(night, now, Math.max(watermark ?? 0, last ?? 0))
        .run();
    } catch {
      // Nothing more to record; the caller logs the original error.
    }
    throw e;
  }
  // The watermark this night stores: never below the last one (#923). After an
  // un-approval the newest approval can be older than it, and a lower value
  // would leave the next night's marks relative to a watermark it never reads.
  const cover = last == null ? watermark : Math.max(last, watermark);

  const { availability, apiKey } = await resolveProvider(env, true);
  if (!availability.available || !apiKey) {
    return { ran: false, reason: availability.available ? "ai_provider_not_configured" : availability.reason };
  }
  const { provider, model } = availability;

  // One run per UTC day: the claim is the run row itself. The one exception is
  // tonight's run that was killed (closed as 'interrupted' above): its row is
  // replaced, since a killed run never recorded a finish (nor any lessons). A
  // run that ended ('ok', 'no_changes', or 'failed' for any other reason) is
  // not retried tonight, so a failing provider is called at most once a night.
  // The replacement is a new row, not the old one updated: the newest set is
  // the current one, and an admin change made while the killed run sat stale
  // has a newer id than the killed row (#912).
  const [, claim] = await db.batch([
    db
      .prepare(`DELETE FROM lesson_runs WHERE night = ?1 AND status = 'failed' AND failure_reason = 'interrupted'`)
      .bind(night),
    db
      .prepare(
        `INSERT INTO lesson_runs (night, started_at, approvals_through, provider, model)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(night) DO NOTHING`,
      )
      .bind(night, now, cover, provider, model),
  ]);
  if (!claim?.meta?.changes) return { ran: false, reason: "already_ran" };
  // Tonight's row is ours now: night is UNIQUE, and only an interrupted row is ever replaced.
  const own = await db.prepare(`SELECT id FROM lesson_runs WHERE night = ?1`).bind(night).first<{ id: number }>();
  if (!own) return { ran: false, reason: "already_ran" };
  const runId = own.id;

  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost: number | null = null;
  const bill = (u: TransportUsage) => {
    calls++;
    inputTokens += u.inputTokens || 0;
    outputTokens += u.outputTokens || 0;
    const c = estimateCost(provider, model, u);
    if (c != null) cost = (cost ?? 0) + c;
  };
  // A call was started: it counts on the run row even when it throws before
  // any usage comes back (a timeout can still be billed).
  let attempted = false;
  let chapters: ChapterRef[] = [];
  let changes = 0;
  // The watermark this run covers: the claimed one, or, when the mining
  // budget ran out among new approvals, just below the first one left undiffed.
  let through = cover;
  let truncated = false;
  // Stopped among new approvals: the next run finishes these chapters first.
  let stopped = false;
  // The chapters mined through a different id than `through` (#915).
  let marksOut: Mark[] = [];
  const finish = (status: Exclude<RunStatus, "running">, reason: string | null) =>
    db
      .prepare(
        `UPDATE lesson_runs SET finished_at = ?2, status = ?3, failure_reason = ?4, chapters_json = ?5, changes = ?6,
                calls = ?7, input_tokens = ?8, output_tokens = ?9, cost_usd = ?10, approvals_through = ?11, truncated = ?12,
                marks_json = ?13
          WHERE id = ?1`,
      )
      .bind(
        runId, Math.floor(Date.now() / 1000), status, reason, JSON.stringify(chapters), changes,
        Math.max(calls, attempted ? 1 : 0), inputTokens, outputTokens, cost, through, stopped ? 1 : 0,
        marksOut.length > 0 ? JSON.stringify(marksOut) : null,
      );

  try {
    chapters = tonight;
    const mined = await mineChanges(db, chapters, { afterIn, upTo: watermark, cells: deps.cells });
    changes = mined.groups.length;
    truncated = mined.truncated;
    if (mined.stoppedAt != null) {
      // Never below the last watermark: a stop among a chapter's owed
      // approvals (below it) is that chapter's mark, set below.
      through = last == null ? mined.stoppedAt - 1 : Math.max(last, mined.stoppedAt - 1);
      stopped = true;
    } else if (resume.length > 0) {
      // A finished resume: the newest chapters it did not mine may hold
      // approvals newer than the watermark (editors moved on between nights).
      // The watermark stops just below the first of them, so the next night,
      // which mines the newest chapters, takes them as new, and the resumed
      // approvals below it are not new again (#912). (A resume that stops
      // again keeps stoppedAt - 1: holding it lower would resume from the
      // same note every night and never advance.)
      const others = newest.filter((c) => !resume.some((r) => r.book === c.book && r.chapter === c.chapter));
      const left = await firstApprovalIn(db, others, last, watermark);
      if (left != null) through = left - 1;
    }
    // One watermark cannot say both "the resumed chapters are done through
    // here" and "the newest chapters are unmined from there" (#915), so each
    // chapter whose progress differs from `through` keeps its own mark:
    //  - a mined chapter: through the note before the stop, or through the
    //    claimed watermark when the run diffed every new approval;
    //  - a resume keeps every mark it did not move, and gives each newest
    //    chapter it did not mine the mark it had, so their approvals stay new;
    //  - any other night drops the marks of chapters it did not mine (none of
    //    them held a new approval) unless ahead of the watermark, where they
    //    keep approvals already compared from being new again.
    const progress = new Map<string, Mark>();
    const mark = (c: ChapterRef, t: number) => progress.set(chapterKey(c), { book: c.book, chapter: c.chapter, through: t });
    for (const m of marks.values()) if (resume.length > 0 || m.through > through) mark(m, m.through);
    if (resume.length > 0) for (const c of newest) mark(c, afterIn(c) ?? 0);
    const done = mined.stoppedAt != null ? mined.stoppedAt - 1 : cover;
    for (const c of chapters) mark(c, Math.max(afterIn(c) ?? 0, done));
    marksOut = [...progress.values()].filter((m) => m.through !== through);
    if (mined.groups.length === 0) {
      await finish("no_changes", null).run();
      return { ran: true, runId, status: "no_changes", failureReason: null, lessons: 0, changed: false, truncated };
    }

    const cfg = await getProjectConfig(env);
    // Read after the claim: from here on no admin change can land (#908), so
    // the set and the deletions are the ones this run's merge must respect.
    const [current, prefs, termRs, templateRs, deletedNow] = await Promise.all([
      loadCurrentLessons(db),
      db
        .prepare(`SELECT instructions_md, common_issues_md FROM translation_prefs WHERE id = 1`)
        .first<{ instructions_md: string | null; common_issues_md: string | null }>(),
      db
        .prepare(
          `SELECT source_term, target_term, status, replacement FROM terminology
            WHERE deleted_at IS NULL AND status <> 'deprecated'
            ORDER BY concept_id, source_term, status`,
        )
        .all<{ source_term: string; target_term: string | null; status: string; replacement: string | null }>(),
      db
        .prepare(
          `SELECT target_md FROM template_units
            WHERE deleted_at IS NULL AND target_md IS NOT NULL AND TRIM(target_md) <> ''`,
        )
        .all<{ target_md: string }>(),
      loadDeletedLessons(db),
    ]);
    deleted = deletedNow;
    const terms = termRs.results ?? [];
    const { system, user } = buildLessonsPrompt({
      languageName: cfg.languageName,
      languageCode: cfg.languageCode,
      current: current.lessons,
      instructionsMd: prefs?.instructions_md ?? null,
      commonIssuesMd: prefs?.common_issues_md ?? null,
      terms: terms.map((t) => ({ source: t.source_term, target: t.target_term, status: t.status, replacement: t.replacement })),
      chapters,
      compared: mined.compared,
      changed: mined.changed,
      groups: mined.groups,
    });

    const transport = deps.transport ?? transportFor(provider);
    let text: string;
    attempted = true;
    try {
      const outcome = await callProvider(transport, {
        provider, model, system, user, thinking: "low", apiKey, timeoutMs: CALL_TIMEOUT_MS,
      });
      for (const d of outcome.discarded) bill(d.usage);
      bill(outcome.usage);
      text = outcome.text;
    } catch (err) {
      const code = err instanceof TranslateProviderError ? err.code : "provider_error";
      if (err instanceof TranslateProviderError) for (const r of err.transportResults ?? []) bill(r.usage);
      // The code only: provider error bodies can echo the prompt.
      console.error(`lessons: AI call failed (${provider}, ${code})`);
      await finish("failed", code).run();
      return { ran: true, runId, status: "failed", failureReason: code, lessons: current.lessons.length, changed: false, truncated };
    }

    const parsed = parseLessonsOutput(text);
    if (!parsed) {
      await finish("failed", "unreadable_output").run();
      return { ran: true, runId, status: "failed", failureReason: "unreadable_output", lessons: current.lessons.length, changed: false, truncated };
    }
    const next = mergeLessons(
      current.lessons,
      parsed,
      {
        terms: terms.map((t) => ({ target: t.target_term, replacement: t.replacement, status: t.status })),
        templates: (templateRs.results ?? []).map((t) => t.target_md),
        instructionsMd: prefs?.instructions_md ?? "",
        commonIssuesMd: prefs?.common_issues_md ?? "",
        maxEvidence: mined.compared,
        deleted,
        changes: mined.groups,
      },
      now,
    );
    const insert = db.prepare(
      `INSERT INTO lessons (run_id, position, lesson, example_before, example_after, evidence, first_seen_at, pinned)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    );
    await db.batch([
      ...next.map((l, i) => insert.bind(runId, i + 1, l.lesson, l.before, l.after, l.evidence, l.firstSeenAt, l.pinned ? 1 : 0)),
      finish("ok", null),
    ]);
    // Content only: a re-estimated evidence count is not worth a pack export.
    const key = (ls: readonly Lesson[]) => JSON.stringify(ls.map((l) => [l.lesson, l.before, l.after]));
    return { ran: true, runId, status: "ok", failureReason: null, lessons: next.length, changed: key(next) !== key(current.lessons), truncated };
  } catch (e) {
    // Leave a finished row behind (the cost so far included), then let the caller log it.
    try {
      await finish("failed", "internal_error").run();
    } catch {
      // The row stays 'running'; the next night is a new day anyway.
    }
    throw e;
  }
}

/**
 * The scheduled tick for one workspace (index.ts runs it for every workspace
 * after their daily exports were requested). A run that stores a changed set
 * then requests a context export through the same pending flag every save
 * uses (contextExportQueue.ts): the flag is set AFTER the set is committed, so
 * an export already running, which read its inputs before, sees it set when
 * it ends and starts one follow-up, which renders the new set. Isolated: a
 * lessons failure is logged and never reaches the export or another workspace.
 */
export async function nightlyLessonsTick(env: Env, deps: LessonDeps = {}): Promise<void> {
  try {
    const out = await runNightlyLessons(env, deps);
    console.log("nightly lessons", { workspace: env.WORKSPACE_SLUG ?? "default", ...out });
    if (out.ran && out.changed) await requestDailyContextExport(env);
  } catch (e) {
    console.error("nightly lessons failed", e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Admin state (GET /api/translation-memory/lessons)
// ---------------------------------------------------------------------------

type RunRow = {
  id: number;
  night: string;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  failure_reason: string | null;
  chapters_json: string;
  changes: number;
  provider: string | null;
  model: string | null;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
};

function runFromRow(r: RunRow): LessonRun {
  let chapters: ChapterRef[] = [];
  try {
    const v = JSON.parse(r.chapters_json) as unknown;
    if (Array.isArray(v)) chapters = v as ChapterRef[];
  } catch {
    // Unreadable: shown as no chapters.
  }
  return {
    id: r.id,
    night: r.night,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    failureReason: r.failure_reason,
    chapters,
    changes: r.changes,
    provider: r.provider,
    model: r.model,
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
  };
}

/** One stored set, for the restore list. */
export type LessonSetSummary = {
  id: number;
  /** When it was written (unix seconds). */
  at: number | null;
  /** 'night' = a nightly run wrote it; 'edit' = an admin change (#908). */
  kind: "night" | "edit";
  /** For an edit: delete | pin | unpin | promote | restore. */
  action: string | null;
  count: number;
};

/** Sets listed for restore, newest first. */
export const SET_HISTORY_LIMIT = 20;

export type LessonsState = {
  enabled: boolean;
  notMigrated: boolean;
  /** Whether a run could call the AI tonight (provider with an in-Worker adapter, key decrypts). */
  availability: Availability;
  lessons: Lesson[];
  /** The current set's id: an admin change names it, so a set changed meanwhile is refused (409). */
  setId: number | null;
  /** When the current set was written. */
  setAt: number | null;
  /** The last nightly run (an admin change is not a run). */
  lastRun: LessonRun | null;
  /** Recent sets, newest first (the first is the current one). */
  sets: LessonSetSummary[];
  maxLessons: number;
};

export async function readLessonsState(env: Env): Promise<LessonsState> {
  const db = env.DB;
  const { availability } = await resolveProvider(env, false);
  let notMigrated = false;
  let enabled = false;
  let lastRun: LessonRun | null = null;
  let sets: LessonSetSummary[] = [];
  try {
    enabled = (await db.prepare(`SELECT enabled FROM lesson_settings WHERE id = 1`).first<{ enabled: number }>())?.enabled === 1;
    // Probe 0088 (marks_json): the night reads it, so without it every night is not_migrated.
    await db.prepare(`SELECT marks_json FROM lesson_runs LIMIT 0`).first();
    const r = await db.prepare(`SELECT * FROM lesson_runs WHERE status <> 'edited' ORDER BY id DESC LIMIT 1`).first<RunRow>();
    lastRun = r ? runFromRow(r) : null;
    const rs = await db
      .prepare(
        `SELECT r.id AS id, r.finished_at AS at, r.status AS status, r.action AS action,
                (SELECT COUNT(*) FROM lessons l WHERE l.run_id = r.id) AS count
           FROM lesson_runs r WHERE r.status IN ${SET_STATUSES_SQL} ORDER BY r.id DESC LIMIT ?1`,
      )
      .bind(SET_HISTORY_LIMIT)
      .all<{ id: number; at: number | null; status: string; action: string | null; count: number }>();
    sets = (rs.results ?? []).map((s) => ({
      id: s.id,
      at: s.at,
      kind: s.status === "edited" ? "edit" : "night",
      action: s.action,
      count: s.count,
    }));
  } catch (e) {
    if (!tableMissing(e)) throw e;
    notMigrated = true;
  }
  const current = notMigrated ? { runId: null, setAt: null, lessons: [] } : await loadCurrentLessons(db);
  return {
    enabled,
    notMigrated,
    availability,
    lessons: current.lessons,
    setId: current.runId,
    setAt: current.setAt,
    lastRun,
    sets,
    maxLessons: MAX_LESSONS,
  };
}

export async function setLessonsEnabled(db: Db, enabled: boolean, userId: number | null): Promise<void> {
  await db
    .prepare(
      `INSERT INTO lesson_settings (id, enabled, updated_at, updated_by) VALUES (1, ?1, unixepoch(), ?2)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(enabled ? 1 : 0, userId)
    .run();
}

/** Every lesson an admin deleted (#908). */
export async function loadDeletedLessons(db: Db): Promise<DeletedLesson[]> {
  const rs = await db
    .prepare(`SELECT lesson, example_before, example_after, approvals_through FROM lesson_deletions`)
    .all<{ lesson: string; example_before: string; example_after: string; approvals_through: number }>();
  return (rs.results ?? []).map((d) => ({
    lesson: d.lesson,
    before: d.example_before,
    after: d.example_after,
    approvalsThrough: d.approvals_through,
  }));
}

// ---------------------------------------------------------------------------
// Admin changes (#908): delete, pin, unpin, promote to Common issues, restore.
//
// Each one writes a NEW set (a lesson_runs row with status 'edited' and its
// lessons), never edits or deletes a stored one, so every earlier set stays
// restorable. The write is one batch, guarded in SQL on three things, so it
// lands whole or not at all:
//   - the set the admin was looking at is still the current one (a night or
//     another admin changed it meanwhile: 409 stale_set);
//   - no nightly run is in progress (it read the current set and would write
//     its own on top: 409 run_in_progress; a 'running' row older than
//     RUN_STALE_SECONDS was killed and does not block);
//   - for promote, Common issues is still at the version read (409 prefs_changed).
// The set row and its lessons go in together, so no export can render a set
// without its lessons.
// ---------------------------------------------------------------------------

export type LessonEditAction = "delete" | "pin" | "unpin" | "promote";

/** Server cap on common_issues_md (translationMemory.ts PutPrefsBody). */
export const COMMON_ISSUES_MAX_CHARS = 50000;

/** The Common issues line a promoted lesson becomes: its lesson and example, no evidence count. */
export function promotedLine(l: Lesson): string {
  return lessonLine({ ...l, evidence: 0 });
}

/** Common issues with the line added at the end (unchanged when that exact line is already there). */
export function appendCommonIssue(text: string | null, line: string): string {
  const cur = text ?? "";
  if (cur.split(/\r?\n/).some((l) => l.trim() === line.trim())) return cur;
  const body = cur.replace(/\s+$/, "");
  return body ? `${body}\n${line}` : line;
}

export type LessonEditResult =
  | { ok: true; prefs?: Record<string, unknown> | null; /** Nothing changed: no new set, no export. */ noop?: boolean }
  | { ok: false; status: 400 | 404 | 409 | 413; error: string };

type PrefsRow = Record<string, unknown> & { version: number; common_issues_md: string | null };

type Stmt = ReturnType<Db["prepare"]>;

async function writeSet(
  env: Env,
  args: {
    baseSetId: number;
    lessons: readonly Lesson[];
    action: LessonEditAction | "restore";
    basedOn: number;
    userId: number | null;
    now: number;
    /** Statements that run only when the set is written (each checks the token row). */
    extra?: (token: string) => Stmt[];
    /** Promote: Common issues must still be at this version (null = no prefs row). */
    prefsVersion?: number | null;
  },
): Promise<boolean> {
  const db = env.DB;
  const token = `edit:${crypto.randomUUID()}`;
  const checkPrefs = args.prefsVersion !== undefined;
  const head = db
    .prepare(
      `INSERT INTO lesson_runs (night, started_at, finished_at, status, approvals_through, action, edited_by, based_on)
       SELECT ?1, ?2, ?2, 'edited', 0, ?3, ?4, ?5
        WHERE (SELECT id FROM lesson_runs WHERE status IN ${SET_STATUSES_SQL} ORDER BY id DESC LIMIT 1) = ?6
          AND NOT EXISTS (SELECT 1 FROM lesson_runs WHERE status = 'running' AND started_at > ?7)
          AND (?8 = 0 OR (SELECT version FROM translation_prefs WHERE id = 1) IS ?9)`,
    )
    .bind(
      token, args.now, args.action, args.userId, args.basedOn, args.baseSetId,
      args.now - RUN_STALE_SECONDS, checkPrefs ? 1 : 0, checkPrefs ? args.prefsVersion : null,
    );
  const insert = db.prepare(
    `INSERT INTO lessons (run_id, position, lesson, example_before, example_after, evidence, first_seen_at, pinned)
     SELECT id, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM lesson_runs WHERE night = ?1`,
  );
  const [res] = await db.batch([
    head,
    ...args.lessons.map((l, i) =>
      insert.bind(token, i + 1, l.lesson, l.before, l.after, l.evidence, l.firstSeenAt, l.pinned ? 1 : 0),
    ),
    ...(args.extra?.(token) ?? []),
  ]);
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * Why a guarded write did not land, read after the fact. `prefsVersion` is the
 * Common issues version the write was guarded on (undefined: not guarded).
 * When no guard fails any more, the cause was a nightly run that has ended
 * since: run_in_progress, so the page asks to try again (#912).
 */
async function refusal(env: Env, baseSetId: number, now: number, prefsVersion?: number | null): Promise<LessonEditResult> {
  const current = await loadCurrentLessons(env.DB);
  if (current.runId !== baseSetId) return { ok: false, status: 409, error: "stale_set" };
  const running = await env.DB
    .prepare(`SELECT 1 AS x FROM lesson_runs WHERE status = 'running' AND started_at > ?1 LIMIT 1`)
    .bind(now - RUN_STALE_SECONDS)
    .first();
  if (running) return { ok: false, status: 409, error: "run_in_progress" };
  if (prefsVersion !== undefined) {
    const prefs = await env.DB.prepare(`SELECT version FROM translation_prefs WHERE id = 1`).first<{ version: number }>();
    if ((prefs?.version ?? null) !== prefsVersion) return { ok: false, status: 409, error: "prefs_changed" };
  }
  return { ok: false, status: 409, error: "run_in_progress" };
}

/**
 * Delete, pin, unpin or promote the lesson at `position` (1-based) of set
 * `setId`, which must be the current set.
 *   delete   the lesson leaves the set and is remembered in lesson_deletions,
 *            so a night does not bring it back unless newer approvals show its
 *            example change again (deletedStill).
 *   pin      every nightly merge keeps it exactly as it is; it is never trimmed.
 *   promote  "- lesson Example: «before» → «after»" is added to the end of
 *            Common issues (a prefs save with its own version and history
 *            entry), and the lesson leaves the set, remembered like a delete.
 */
export async function editLesson(
  env: Env,
  args: { setId: number; position: number; action: LessonEditAction; userId: number | null; source?: string | null; now?: number },
): Promise<LessonEditResult> {
  const db = env.DB;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const current = await loadCurrentLessons(db);
  if (current.runId !== args.setId) return { ok: false, status: 409, error: "stale_set" };
  const i = args.position - 1;
  const target = current.lessons[i];
  if (!target) return { ok: false, status: 404, error: "lesson_not_found" };

  if (args.action === "pin" || args.action === "unpin") {
    const pinned = args.action === "pin";
    if (target.pinned === pinned) return { ok: true, noop: true };
    const lessons = current.lessons.map((l, k) => (k === i ? { ...l, pinned } : l));
    const ok = await writeSet(env, { baseSetId: args.setId, lessons, action: args.action, basedOn: args.setId, userId: args.userId, now });
    return ok ? { ok: true } : refusal(env, args.setId, now);
  }

  const rest = current.lessons.filter((_, k) => k !== i);
  // Delete and promote both take the lesson out of the set, and both remember
  // it, so a night does not write it back from the same old notes. (Common
  // issues alone would not stop that: its cover needs a word on both sides of
  // the example, and deletions and punctuation fixes have none.)
  // The newest approval is read inside the same batch, so an approval that
  // commits while the change is in flight never counts as "after the delete".
  const tombstone = (token: string) =>
    db
      .prepare(
        `INSERT INTO lesson_deletions (lesson, example_before, example_after, deleted_at, deleted_by, approvals_through)
         SELECT ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(e.id) ${HAND_APPROVAL_JOIN}), 0)
          WHERE EXISTS (SELECT 1 FROM lesson_runs WHERE night = ?1)`,
      )
      .bind(token, target.lesson, target.before, target.after, now, args.userId);

  if (args.action === "delete") {
    const ok = await writeSet(env, {
      baseSetId: args.setId,
      lessons: rest,
      action: "delete",
      basedOn: args.setId,
      userId: args.userId,
      now,
      extra: (token) => [tombstone(token)],
    });
    return ok ? { ok: true } : refusal(env, args.setId, now);
  }

  // promote
  const prefs = await db.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>();
  const prevText = prefs?.common_issues_md ?? null;
  const nextText = appendCommonIssue(prevText, promotedLine(target));
  if (nextText.length > COMMON_ISSUES_MAX_CHARS) return { ok: false, status: 413, error: "common_issues_full" };
  const changed = nextText !== (prevText ?? "");
  const prevVersion = prefs ? prefs.version : 0;
  const payload = JSON.stringify({ changed: { common_issues_md: { prev: prevText, new: nextText } } });
  // Only a promote that changes Common issues depends on its version.
  const prefsVersion = changed ? (prefs ? prefs.version : null) : undefined;
  const ok = await writeSet(env, {
    baseSetId: args.setId,
    lessons: rest,
    action: "promote",
    basedOn: args.setId,
    userId: args.userId,
    now,
    prefsVersion,
    extra: (token) =>
      !changed
        ? [tombstone(token)]
        : [
            tombstone(token),
            prefs
              ? db
                  .prepare(
                    `UPDATE translation_prefs SET common_issues_md = ?2, version = version + 1, updated_at = ?3, updated_by = ?4
                      WHERE id = 1 AND EXISTS (SELECT 1 FROM lesson_runs WHERE night = ?1)`,
                  )
                  .bind(token, nextText, now, args.userId)
              : db
                  .prepare(
                    `INSERT INTO translation_prefs (id, common_issues_md, version, updated_at, updated_by)
                     SELECT 1, ?2, 1, ?3, ?4 WHERE EXISTS (SELECT 1 FROM lesson_runs WHERE night = ?1)`,
                  )
                  .bind(token, nextText, now, args.userId),
            // The same entry PUT /prefs writes (so prefs history can restore
            // around it), gated on the write just above landing.
            db.prepare(PREFS_HISTORY_SQL).bind(args.userId, prevVersion, prefs ? "update" : "create", args.source ?? null, payload),
          ],
  });
  if (!ok) return refusal(env, args.setId, now, prefsVersion);
  // Prefs only when Common issues changed: the page then remounts its editors.
  if (!changed) return { ok: true };
  return { ok: true, prefs: await db.prepare(`SELECT * FROM translation_prefs WHERE id = 1`).first<PrefsRow>() };
}

/** Make an earlier set current again, as a new set (history is never rewritten). */
export async function restoreLessonSet(
  env: Env,
  args: { setId: number; currentSetId: number; userId: number | null; now?: number },
): Promise<LessonEditResult> {
  const db = env.DB;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const current = await loadCurrentLessons(db);
  if (current.runId !== args.currentSetId) return { ok: false, status: 409, error: "stale_set" };
  if (args.setId === args.currentSetId) return { ok: false, status: 400, error: "already_current" };
  const exists = await db
    .prepare(`SELECT id FROM lesson_runs WHERE id = ?1 AND status IN ${SET_STATUSES_SQL}`)
    .bind(args.setId)
    .first<{ id: number }>();
  if (!exists) return { ok: false, status: 404, error: "set_not_found" };
  const lessons = await loadLessonSet(db, args.setId);
  // The restored lessons are live again: their deletion records go, so a
  // night treats them like any current lesson (#908 gate G4). A record goes
  // when a restored lesson has its wording, compared as the night compares
  // (normText). An example alone is not enough: another deleted lesson can
  // share it, and that one is not restored (#912). A promoted lesson's line
  // stays in Common issues. A record added after this read comes with a new
  // set, so the guarded write below is refused.
  const restored = new Set(lessons.map((l) => normText(l.lesson)));
  const tombs = await db.prepare(`SELECT id, lesson FROM lesson_deletions`).all<{ id: number; lesson: string }>();
  const gone = (tombs.results ?? []).filter((d) => restored.has(normText(d.lesson))).map((d) => d.id);
  const untomb = (token: string) =>
    gone.map((id) =>
      db
        .prepare(`DELETE FROM lesson_deletions WHERE id = ?2 AND EXISTS (SELECT 1 FROM lesson_runs WHERE night = ?1)`)
        .bind(token, id),
    );
  const ok = await writeSet(env, {
    baseSetId: args.currentSetId,
    lessons,
    action: "restore",
    basedOn: args.setId,
    userId: args.userId,
    now,
    extra: untomb,
  });
  return ok ? { ok: true } : refusal(env, args.currentSetId, now);
}

// ---------------------------------------------------------------------------
// Routes (mounted at /api/translation-memory/lessons), all admin-only:
// switching on spends the workspace's own AI account every night that has new
// approvals, and a change to the set changes what every draft is told. Every
// change queues a context export (awaited), so instructions.md follows
// without waiting for the night.
// ---------------------------------------------------------------------------

type RouteEnv = { Bindings: Env; Variables: { userId?: number } };

const PutBody = z.object({ enabled: z.boolean() }).strict();
const EditBody = z
  .object({
    setId: z.number().int().positive(),
    position: z.number().int().positive(),
    action: z.enum(["delete", "pin", "unpin", "promote"]),
  })
  .strict();
const RestoreBody = z.object({ setId: z.number().int().positive(), currentSetId: z.number().int().positive() }).strict();

export function lessonsRoutes() {
  const app = new Hono<RouteEnv>();

  app.get("/", requireAdmin, async (c) => c.json(await readLessonsState(c.env)));

  app.put("/", requireAdmin, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const parsed = PutBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
    // Same check the night job makes (resolveProvider decrypts the key in
    // both modes), so "On" is only possible when a run could call the AI.
    // Switching off is always allowed.
    if (parsed.data.enabled) {
      const { availability } = await resolveProvider(c.env, false);
      if (!availability.available) return c.json({ error: "lessons_unavailable", reason: availability.reason }, 409);
    }
    try {
      await setLessonsEnabled(c.env.DB, parsed.data.enabled, currentUserId(c));
    } catch (e) {
      if (tableMissing(e)) return c.json({ error: "not_migrated" }, 503);
      throw e;
    }
    // Awaited, not left to waitUntil alone: the answer goes back only after the
    // export is marked pending (or started), so the page never reports a
    // switch whose pack update was not yet requested.
    await queueContextExport(c);
    return c.json(await readLessonsState(c.env));
  });

  // The two set-changing routes end the same way: a refusal carries the fresh
  // state so the page can redraw; a change queues the export, then answers.
  const answer = async (c: Context<RouteEnv>, run: () => Promise<LessonEditResult>) => {
    let out: LessonEditResult;
    try {
      out = await run();
    } catch (e) {
      if (tableMissing(e)) return c.json({ error: "not_migrated" }, 503);
      throw e;
    }
    if (!out.ok) return c.json({ error: out.error, state: await readLessonsState(c.env) }, out.status);
    if (!out.noop) await queueContextExport(c);
    return c.json({ ...(await readLessonsState(c.env)), ...(out.prefs !== undefined ? { prefs: out.prefs } : {}) });
  };

  const readBody = async (c: Context<RouteEnv>): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  app.post("/edit", requireAdmin, async (c) => {
    const body = await readBody(c);
    if (body === undefined) return c.json({ error: "invalid_json" }, 400);
    const parsed = EditBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
    return answer(c, () => editLesson(c.env, { ...parsed.data, userId: currentUserId(c), source: editSource(c) }));
  });

  app.post("/restore", requireAdmin, async (c) => {
    const body = await readBody(c);
    if (body === undefined) return c.json({ error: "invalid_json" }, 400);
    const parsed = RestoreBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
    return answer(c, () => restoreLessonSet(c.env, { ...parsed.data, userId: currentUserId(c) }));
  });

  return app;
}
