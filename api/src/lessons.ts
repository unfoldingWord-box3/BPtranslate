// Nightly lessons from editor corrections (issue #817, part 1).
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
//             when there is a hand approval newer than the watermark of the
//             last run that finished its mining ('ok' or 'no_changes'; a
//             failed or killed run's approvals are mined again), counting
//             edit_log 'validate' entries of validated tN rows with no
//             admin_bulk_state stamp (#833), and only once per UTC day
//             (lesson_runs.night is UNIQUE). A run left 'running' from an
//             earlier night is closed as failed ('interrupted').
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
//             and each lesson is flattened to one line.
//   failure   an unreadable reply or a failed call keeps the previous set; the
//             run row still records what was billed.
//
// Imports carry .ts suffixes so the node strip-types test runner resolves them.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireAdmin } from "./auth.ts";
import { queueContextExport } from "./contextExportQueue.ts";
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
import { lessonLine, lessonsEnabled as lessonsEnabledRead, loadCurrentLessons, type Lesson } from "./lessonsRender.ts";

export {
  LESSONS_HEADING,
  lessonLine,
  lessonsEnabled,
  loadCurrentLessons,
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
      /** True when the stored set differs from the one before: the context pack needs an export. */
      changed: boolean;
    };

type Db = Env["DB"];

const tableMissing = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e));

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

/** The chapters whose newest hand approval is newest. */
export async function recentApprovedChapters(db: Db, n = RECENT_CHAPTERS): Promise<ChapterRef[]> {
  const rs = await db
    .prepare(
      `SELECT t.book AS book, t.chapter AS chapter, MAX(e.id) AS last_id ${HAND_APPROVAL_JOIN}
        GROUP BY t.book, t.chapter ORDER BY last_id DESC LIMIT ?1`,
    )
    .bind(n)
    .all<{ book: string; chapter: number }>();
  return (rs.results ?? []).map((r) => ({ book: r.book, chapter: r.chapter }));
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

/** Group the corrections of the given chapters. */
export async function mineChanges(
  db: Db,
  chapters: readonly ChapterRef[],
): Promise<{ groups: ChangeGroup[]; compared: number; changed: number }> {
  const byKey = new Map<string, ChangeGroup>();
  let compared = 0;
  let changed = 0;
  for (const ch of chapters) {
    const rs = await db
      .prepare(`SELECT * FROM (${SCORECARD_ROWS_SQL}) WHERE chapter = ?2`)
      .bind(ch.book, ch.chapter)
      .all<{ id: string; final_note: string | null; draft_note: unknown }>();
    for (const r of rs.results ?? []) {
      if (typeof r.draft_note !== "string" || r.final_note == null) continue;
      // Each note gets its own budget, enough for the largest diff noteChanges
      // accepts (DIFF_SEGMENT_CAP tokens a side). A budget shared across the
      // window ran out on long rewrites and silently skipped every later note,
      // whose corrections the watermark then moved past. A note too long to
      // diff is not counted as compared.
      const changes = noteChanges(r.draft_note, r.final_note, { cells: DIFF_SEGMENT_CAP * DIFF_SEGMENT_CAP });
      if (!changes) continue;
      compared++;
      if (changes.length === 0) continue;
      const seen = new Set<string>();
      for (const c of changes) {
        if (seen.has(c.key) || isShaddaVowelOnly(c.before, c.after)) continue;
        seen.add(c.key);
        const g = byKey.get(c.key);
        if (g) g.count++;
        else
          byKey.set(c.key, {
            before: c.before,
            after: c.after,
            count: 1,
            draftExcerpt: c.draftExcerpt,
            finalExcerpt: c.finalExcerpt,
          });
      }
      if (seen.size > 0) changed++;
    }
  }
  const groups = [...byKey.values()].sort(
    (a, b) => b.count - a.count || (a.before < b.before ? -1 : a.before > b.before ? 1 : a.after < b.after ? -1 : 1),
  );
  return { groups, compared, changed };
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
    `You keep a short list of lessons for an AI that drafts Bible translation notes in ${input.languageName} (${input.languageCode}).`,
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

  const parts: string[] = [];
  parts.push("# Current lessons", "");
  if (input.current.length === 0) parts.push("(none yet)");
  else input.current.forEach((l, i) => parts.push(`L${i + 1}. ${lessonLine(l).slice(2)}`));

  parts.push("", "# Instructions the drafting AI already gets", "");
  parts.push(input.instructionsMd?.trim() ? cap(input.instructionsMd.trim(), PREFS_CHAR_CAP) : "(none)");
  parts.push("", "## Common issues", "");
  parts.push(input.commonIssuesMd?.trim() ? cap(input.commonIssuesMd.trim(), PREFS_CHAR_CAP) : "(none)");

  parts.push("", "# Terms (source → target)", "");
  const shown = input.terms.slice(0, MAX_PROMPT_TERMS);
  if (shown.length === 0) parts.push("(none)");
  for (const t of shown) {
    parts.push(
      t.status === "forbidden"
        ? `- ${t.source}: never «${t.target ?? ""}»${t.replacement ? `, use «${t.replacement}»` : ""}`
        : `- ${t.source} → «${t.target ?? ""}»${t.status && t.status !== "preferred" ? ` (${t.status})` : ""}`,
    );
  }
  if (input.terms.length > shown.length) parts.push(`(${input.terms.length - shown.length} more terms not shown)`);

  const where = input.chapters.map((c) => `${c.book} ${c.chapter}`).join(", ");
  parts.push(
    "",
    "# What editors changed",
    "",
    `Chapters: ${where}. Approved notes compared with their AI draft: ${input.compared}; notes the editor changed: ${input.changed}.`,
    "Each line: the number of notes with that change, the AI's words → the editor's words (∅ = deleted), then one example in context.",
    "",
  );
  const groups = input.groups.slice(0, MAX_PROMPT_CHANGES);
  for (const g of groups) {
    parts.push(`- ${g.count}× «${g.before}» → «${g.after || "∅"}»   e.g. «${g.draftExcerpt}» ⇒ «${g.finalExcerpt}»`);
  }
  if (input.groups.length > groups.length) {
    parts.push(`(${input.groups.length - groups.length} rarer changes not shown)`);
  }
  return { system, user: parts.join("\n") };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ParsedLesson = { id: string | null; lesson: string; before: string; after: string; evidence: number | null };
export type ParsedOutput = { lessons: ParsedLesson[]; reversed: string[] };

const oneLine = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

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
    const ev = Number(it.evidence);
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
};

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

/** The new set: the model's list checked against the rules above. */
export function mergeLessons(
  current: readonly Lesson[],
  parsed: ParsedOutput,
  ctx: CoverContext,
  now: number,
): Lesson[] {
  const byId = new Map<string, Lesson>(current.map((l, i) => [`L${i + 1}`, l]));
  const reversed = new Set(parsed.reversed.filter((id) => byId.has(id)));
  const used = new Set<string>();
  const seenText = new Set<string>();
  type Item = Lesson & { fresh: boolean };
  const out: Item[] = [];
  for (const p of parsed.lessons) {
    const prev = p.id && byId.has(p.id) ? byId.get(p.id)! : null;
    // A reversed lesson does not come back under its own id, and one id is used once.
    if (prev && (reversed.has(p.id!) || used.has(p.id!))) continue;
    const text = cleanLessonText(p.lesson);
    if (!text) continue;
    const before = cap(oneLine(p.before), EXAMPLE_CHAR_CAP);
    const after = cap(oneLine(p.after), EXAMPLE_CHAR_CAP);
    if (isShaddaVowelOnly(before, after)) continue;
    if (!prev && covered({ before, after }, ctx)) continue;
    const key = nfc(text).toLowerCase();
    if (seenText.has(key)) continue;
    seenText.add(key);
    if (prev) used.add(p.id!);
    out.push({
      lesson: text,
      before,
      after,
      evidence: clampEvidence(p.evidence ?? prev?.evidence ?? 0, ctx.maxEvidence),
      firstSeenAt: prev?.firstSeenAt ?? now,
      fresh: !prev,
    });
  }
  // Current lessons the model neither kept nor named as reversed stay as they are.
  current.forEach((l, i) => {
    const id = `L${i + 1}`;
    if (used.has(id) || reversed.has(id)) return;
    const key = nfc(l.lesson).toLowerCase();
    if (seenText.has(key)) return;
    seenText.add(key);
    out.push({ ...l, fresh: false });
  });
  // Over the cap: new lessons go first, last ones first.
  while (out.length > MAX_LESSONS) {
    let k = -1;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].fresh) { k = i; break; }
    out.splice(k === -1 ? out.length - 1 : k, 1);
  }
  return out.map(({ fresh: _fresh, ...l }) => l);
}

// ---------------------------------------------------------------------------
// The nightly job
// ---------------------------------------------------------------------------

export type LessonDeps = { transport?: Transport; now?: number };

/**
 * Run tonight's lessons for this workspace (env is already workspace-resolved).
 * Never throws for a provider or output failure: that is recorded on the run
 * row. Throws only for unexpected D1 errors; the caller isolates it.
 */
export async function runNightlyLessons(env: Env, deps: LessonDeps = {}): Promise<LessonJobOutcome> {
  const db = env.DB;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if (!(await lessonsEnabledRead(db))) return { ran: false, reason: "off" };
  const night = new Date(now * 1000).toISOString().slice(0, 10);

  let last: number | null;
  try {
    // A run from an earlier night still 'running' was killed (isolate evicted,
    // timeout): close it as failed so the page says so, every night the
    // switch is on, whether or not tonight runs.
    await db
      .prepare(
        `UPDATE lesson_runs SET status = 'failed', failure_reason = 'interrupted', finished_at = ?2
          WHERE status = 'running' AND night <> ?1`,
      )
      .bind(night, now)
      .run();
    // Only runs that finished their mining move the watermark: a failed or
    // killed run's corrections are mined again on a later night. Spend stays
    // at one call a night through the night claim below.
    last =
      (
        await db
          .prepare(`SELECT MAX(approvals_through) AS w FROM lesson_runs WHERE status IN ('ok', 'no_changes')`)
          .first<{ w: number | null }>()
      )?.w ?? null;
  } catch (e) {
    if (tableMissing(e)) return { ran: false, reason: "not_migrated" };
    throw e;
  }
  const watermark = await approvalWatermark(db);
  if (watermark == null) return { ran: false, reason: "no_new_approvals" };
  if (last != null && watermark <= last) return { ran: false, reason: "no_new_approvals" };

  const { availability, apiKey } = await resolveProvider(env, true);
  if (!availability.available || !apiKey) {
    return { ran: false, reason: availability.available ? "ai_provider_not_configured" : availability.reason };
  }
  const { provider, model } = availability;

  // One run per UTC day: the claim is the run row itself.
  const claim = await db
    .prepare(
      `INSERT INTO lesson_runs (night, started_at, approvals_through, provider, model)
       VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(night) DO NOTHING RETURNING id`,
    )
    .bind(night, now, watermark, provider, model)
    .first<{ id: number }>();
  if (!claim) return { ran: false, reason: "already_ran" };
  const runId = claim.id;

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
  let chapters: ChapterRef[] = [];
  let changes = 0;
  const finish = (status: Exclude<RunStatus, "running">, reason: string | null) =>
    db
      .prepare(
        `UPDATE lesson_runs SET finished_at = ?2, status = ?3, failure_reason = ?4, chapters_json = ?5, changes = ?6,
                calls = ?7, input_tokens = ?8, output_tokens = ?9, cost_usd = ?10
          WHERE id = ?1`,
      )
      .bind(runId, Math.floor(Date.now() / 1000), status, reason, JSON.stringify(chapters), changes, calls, inputTokens, outputTokens, cost);

  try {
    chapters = await recentApprovedChapters(db);
    const mined = await mineChanges(db, chapters);
    changes = mined.groups.length;
    if (mined.groups.length === 0) {
      await finish("no_changes", null).run();
      return { ran: true, runId, status: "no_changes", failureReason: null, lessons: 0, changed: false };
    }

    const cfg = await getProjectConfig(env);
    const [current, prefs, termRs, templateRs] = await Promise.all([
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
    ]);
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
      return { ran: true, runId, status: "failed", failureReason: code, lessons: current.lessons.length, changed: false };
    }

    const parsed = parseLessonsOutput(text);
    if (!parsed) {
      await finish("failed", "unreadable_output").run();
      return { ran: true, runId, status: "failed", failureReason: "unreadable_output", lessons: current.lessons.length, changed: false };
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
      },
      now,
    );
    const insert = db.prepare(
      `INSERT INTO lessons (run_id, position, lesson, example_before, example_after, evidence, first_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    await db.batch([
      ...next.map((l, i) => insert.bind(runId, i + 1, l.lesson, l.before, l.after, l.evidence, l.firstSeenAt)),
      finish("ok", null),
    ]);
    const key = (ls: readonly Lesson[]) => JSON.stringify(ls.map((l) => [l.lesson, l.before, l.after, l.evidence]));
    return { ran: true, runId, status: "ok", failureReason: null, lessons: next.length, changed: key(next) !== key(current.lessons) };
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

export type LessonsState = {
  enabled: boolean;
  notMigrated: boolean;
  /** Whether a run could call the AI tonight (provider with an in-Worker adapter, key decrypts). */
  availability: Availability;
  lessons: Lesson[];
  /** When the current set was written. */
  setAt: number | null;
  lastRun: LessonRun | null;
  maxLessons: number;
};

export async function readLessonsState(env: Env): Promise<LessonsState> {
  const db = env.DB;
  const { availability } = await resolveProvider(env, false);
  let notMigrated = false;
  let enabled = false;
  let lastRun: LessonRun | null = null;
  try {
    enabled = (await db.prepare(`SELECT enabled FROM lesson_settings WHERE id = 1`).first<{ enabled: number }>())?.enabled === 1;
    const r = await db.prepare(`SELECT * FROM lesson_runs ORDER BY id DESC LIMIT 1`).first<RunRow>();
    lastRun = r ? runFromRow(r) : null;
  } catch (e) {
    if (!tableMissing(e)) throw e;
    notMigrated = true;
  }
  const current = notMigrated ? { setAt: null, lessons: [] } : await loadCurrentLessons(db);
  return { enabled, notMigrated, availability, lessons: current.lessons, setAt: current.setAt, lastRun, maxLessons: MAX_LESSONS };
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

// ---------------------------------------------------------------------------
// Routes (mounted at /api/translation-memory/lessons). Admin-only both ways:
// switching on spends the workspace's own AI account every night that has new
// approvals. Either change queues a context export, so the lessons section
// appears in (or leaves) instructions.md without waiting for the night.
// ---------------------------------------------------------------------------

type RouteEnv = { Bindings: Env; Variables: { userId?: number } };

const PutBody = z.object({ enabled: z.boolean() }).strict();

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
    queueContextExport(c);
    return c.json(await readLessonsState(c.env));
  });

  return app;
}
