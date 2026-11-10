// Suggestion inbox (issue #819): corrections editors keep making to AI
// translation-note drafts, grouped so an admin can turn each into guidance.
//
// GET  /api/suggestion-inbox/:book          the cards for one book (admin only)
// POST /api/suggestion-inbox/:book/approve  {key} → an enabled house-style rule
// POST /api/suggestion-inbox/reject         {key} → never suggested again
//
// The issue says "nightly". There is no cron: the inbox is computed when an
// admin opens it, for ONE book per request (the bound), with no AI call. The
// same D1 read as the draft scorecard (#816, SCORECARD_ROWS_SQL) gives each
// approved note with its draft; then a few small reads (rules, terms,
// templates, the Common issues text, rejected keys). Nothing is stored except
// rejections (migration 0083) and approved rules (house_style_rules, 0082).
//
// The rules, exactly (the help and the page say them in plain words):
//
//   rows      validated tN rows of the book. draft = the note in the row's
//             latest ai_pipeline edit_log payload (the scorecard's lookup, with
//             its book-matched COALESCE). Since #815 that is the text after
//             house-style rules ran, i.e. what the editor saw. final = the
//             row's note now. No draft logged → not compared.
//   tokens    both texts are NFC-normalized (Arabic marks arrive in either
//             order), then split into word tokens (runs of letters, combining
//             marks and digits) and single punctuation marks. Spaces, bidi
//             marks and line breaks separate tokens and are never compared;
//             tN stores a line break as the two characters backslash-n.
//   changes   a token-level diff (longest common subsequence) of draft and
//             final. Each run of differing tokens is one change; its before /
//             after text is cut from the texts themselves, inner spaces
//             collapsed to one. Then:
//             - an insertion (nothing deleted) is anchored on the token before
//               it (or after it, at the very start), so adding "." after "]"
//               reads "]" → "].". An insertion that ends the final note is a
//               separate change ("insert-end") from the same insertion
//               elsewhere ("insert").
//             - a change whose before has a word and whose after is only
//               punctuation is split into a deletion plus an insertion, so a
//               note where the editor deleted "(مُكيَّف)" AND added the closing
//               period counts for both (not at the very start of the note,
//               where the insertion has no token before it to anchor on).
//             - dropped: either side longer than MAX_CHANGE_TOKENS tokens (a
//               rewrite, not a repeatable correction), a change that crosses a
//               line break, and a change inside a **bold** Scripture quote.
//             - a pair whose differing middle exceeds DIFF_SEGMENT_CAP tokens,
//               or that would overrun the request's DIFF_CELL_BUDGET, is
//               skipped and counted (scanned.skippedLong).
//   group     identical changes (same kind, before and after) across rows.
//   hits      rows that made the change (once per row).
//   kept      hits ≥ MIN_HITS in ≥ MIN_CHAPTERS distinct chapters.
//   opportunities  compared rows whose draft contained the before tokens in a
//             row (for "insert-end", ended with them), plus every hit row (a
//             note where a deletion came first, like "[x] (مُكيَّف)" → "[x].",
//             only ends in "]" once the tag is gone). So hits ≤ opportunities.
//   excluded  rejected (0083); covered by a house-style rule, ENABLED OR NOT:
//             running the rule on one of the card's example drafts makes the
//             change disappear; covered by a term: after equals a live term's
//             target or replacement, or before equals a deprecated/forbidden
//             term's target (only when that side has a word); covered by a
//             template: some note template's text contains after (two words
//             or more); already a Common issues line: the Common issues text
//             contains before (with a word) and after, or the line the page
//             copies («before» → «after»); already a lesson:
//             stubbed until lessons exist (#817), see coveredByLesson.
//   home      (suggestedHome) house_style when the change is mechanical (at
//             most one word on each side; when both have one, the same word
//             respelled: equal without combining marks, or one letter
//             different; a word deleted alone, with no punctuation around
//             it, is wording, not mechanics), a rule can express it (candidateRule, compileRule
//             accepts it, and it reproduces the change on an example), and
//             editors made it in at least half its opportunities (a rule fires
//             on every one). Else template when before (two words or more)
//             appears in a note template. Else term when both sides are one to
//             three words with no punctuation. Else common_issues.
//
// Approve exists only for house_style cards and takes just the key: the server
// recomputes the book's inbox and builds the rule from its own card, so no
// text an admin sends becomes a pattern (the #815 stance). The rule is a
// literal / whole_word rule, or for the closing period the existing
// final_bracket_period kind: a literal "]" → "]." is refused by compileRule's
// idempotency guard, as is any pure insertion.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireAdmin } from "./auth.ts";
import { BOOK_NUMBERS } from "./dcsSources.ts";
import { SCORECARD_ROWS_SQL } from "./draftScorecard.ts";
import {
  boldRanges,
  compileRule,
  ruleFromRow,
  type HouseStyleKind,
  type HouseStyleRule,
  type HouseStyleRuleRow,
  type HouseStyleScope,
} from "./houseStyle.ts";

// ── Tunables ────────────────────────────────────────────────────────────────

export const MIN_HITS = 10;
export const MIN_CHAPTERS = 3;
/** Longest before/after (in tokens, an insertion's anchor included) that still counts as a correction. */
export const MAX_CHANGE_TOKENS = 6;
export const EXAMPLE_COUNT = 3;
/** Tokens of context on each side of a change in an example excerpt. */
export const EXCERPT_TOKENS = 5;
/** Longest differing middle (tokens, after the shared prefix/suffix) that is diffed. */
export const DIFF_SEGMENT_CAP = 400;
/**
 * LCS table cells one request may fill. A normal note pair costs a few
 * hundred cells; a 3,000-row book of fully rewritten 400-token notes would be
 * 480M, so this valve only trips on books far past real sizes.
 */
export const DIFF_CELL_BUDGET = 300_000_000;

// ── Data shapes ─────────────────────────────────────────────────────────────

export type ChangeKind = "change" | "insert" | "insert-end";
export type SuggestedHome = "house_style" | "template" | "term" | "common_issues";

export interface Token {
  text: string;
  start: number;
  end: number;
  word: boolean;
}

/** One change in one note. */
export interface NoteChange {
  key: string;
  change: ChangeKind;
  before: string;
  after: string;
  beforeTokens: string[];
  draftExcerpt: string;
  finalExcerpt: string;
}

export interface SuggestionExample {
  rowId: string;
  chapter: number;
  draft: string;
  final: string;
}

export interface SuggestedRule {
  kind: HouseStyleKind;
  find: string;
  replace: string;
  scope: HouseStyleScope;
}

export interface Suggestion {
  key: string;
  change: ChangeKind;
  before: string;
  after: string;
  hits: number;
  opportunities: number;
  chapters: number[];
  examples: SuggestionExample[];
  home: SuggestedHome;
  /** The rule Approve would create; set only when home is house_style. */
  rule: SuggestedRule | null;
}

export interface InboxRow {
  id: string;
  chapter: number;
  finalNote: string | null;
  draftNote: string | null;
}

export interface InboxTerm {
  target: string | null;
  replacement: string | null;
  status: string;
}

export interface InboxContext {
  /** Every house-style rule this build can run, enabled or not. */
  rules: HouseStyleRule[];
  terms: InboxTerm[];
  /** Note template texts (target_md). */
  templates: string[];
  commonIssues: string;
  rejected: Set<string>;
}

export interface InboxExcluded {
  rejected: number;
  rule: number;
  term: number;
  template: number;
  commonIssues: number;
  lesson: number;
}

export interface SuggestionInboxResponse {
  book: string;
  minHits: number;
  minChapters: number;
  scanned: { validated: number; noDraft: number; compared: number; skippedLong: number };
  excluded: InboxExcluded;
  suggestions: Suggestion[];
  /** Migration 0083 has not run here: nothing can be rejected yet. */
  notMigrated: boolean;
}

// ── Tokens and changes ──────────────────────────────────────────────────────

const WORD = /^[\p{L}\p{M}\p{N}]$/u;
const SPACE = /^[\s‎‏؜]$/u;
const nfc = (s: string) => s.normalize("NFC");

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const cpAt = (k: number) => String.fromCodePoint(text.codePointAt(k) as number);
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "n") {
      i += 2;
      continue;
    }
    const cp = cpAt(i);
    if (SPACE.test(cp)) {
      i += cp.length;
      continue;
    }
    if (WORD.test(cp)) {
      let j = i + cp.length;
      while (j < text.length) {
        const c2 = cpAt(j);
        if (!WORD.test(c2)) break;
        j += c2.length;
      }
      out.push({ text: text.slice(i, j), start: i, end: j, word: true });
      i = j;
    } else {
      out.push({ text: cp, start: i, end: i + cp.length, word: false });
      i += cp.length;
    }
  }
  return out;
}

/** The stable identity of a change: JSON [change, before, after]. */
export function changeKey(change: ChangeKind, before: string, after: string): string {
  return JSON.stringify([change, before, after]);
}

/** A key from the client, checked: [change, before, after] with a known change and some text. */
export function parseChangeKey(key: unknown): { change: ChangeKind; before: string; after: string } | null {
  if (typeof key !== "string" || key.length === 0 || key.length > 2000) return null;
  let v: unknown;
  try {
    v = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === "string")) return null;
  const [change, before, after] = v as string[];
  if (change !== "change" && change !== "insert" && change !== "insert-end") return null;
  if (before === "" && after === "") return null;
  if (changeKey(change, before, after) !== key) return null;
  return { change, before, after };
}

interface Hunk {
  d0: number;
  d1: number;
  f0: number;
  f1: number;
}

export interface CellBudget {
  cells: number;
}

// Runs of differing tokens, by longest common subsequence. null = too long.
function diffTokens(a: string[], b: string[], budget: CellBudget): Hunk[] | null {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ d0: s, d1: ea, f0: s, f1: eb }];
  if (n > DIFF_SEGMENT_CAP || m > DIFF_SEGMENT_CAP || n * m > budget.cells) return null;
  budget.cells -= n * m;
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a[s + i] === b[s + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[s + i] === b[s + j]) {
      if (open) hunks.push(open);
      open = null;
      i++;
      j++;
      continue;
    }
    if (!open) open = { d0: s + i, d1: s + i, f0: s + j, f1: s + j };
    if (j >= m || (i < n && L[(i + 1) * W + j] >= L[i * W + j + 1])) {
      i++;
      open.d1 = s + i;
    } else {
      j++;
      open.f1 = s + j;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

const LINE_BREAK = /\\n|\n/;
const collapse = (s: string) => s.replace(/[ \t ]+/g, " ");

function slice(text: string, toks: Token[], a: number, b: number): string {
  return a < b ? text.slice(toks[a].start, toks[b - 1].end) : "";
}

function excerpt(text: string, toks: Token[], a: number, b: number): string {
  const from = Math.max(0, a - EXCERPT_TOKENS);
  const to = Math.min(toks.length, b + EXCERPT_TOKENS);
  if (from >= to) return "";
  const body = collapse(text.slice(toks[from].start, toks[to - 1].end).replace(/\\n|\n/g, " "));
  return `${from > 0 ? "…" : ""}${body}${to < toks.length ? "…" : ""}`;
}

function buildChange(
  draft: string,
  final: string,
  dt: Token[],
  ft: Token[],
  h: Hunk,
  bold: Array<[number, number]>,
): NoteChange | null {
  let { d0, d1, f0, f1 } = h;
  const insertion = d0 === d1;
  if (insertion) {
    if (d0 > 0) {
      d0--;
      f0--;
    } else if (d1 < dt.length && f1 < ft.length) {
      d1++;
      f1++;
    } else return null;
  }
  if (d1 - d0 > MAX_CHANGE_TOKENS || f1 - f0 > MAX_CHANGE_TOKENS) return null;
  const rawBefore = slice(draft, dt, d0, d1);
  const rawAfter = slice(final, ft, f0, f1);
  if (LINE_BREAK.test(rawBefore) || LINE_BREAK.test(rawAfter)) return null;
  if (d1 > d0 && bold.some(([a, b]) => dt[d0].start < b && dt[d1 - 1].end > a)) return null;
  const before = collapse(rawBefore);
  const after = collapse(rawAfter);
  const change: ChangeKind = insertion ? (f1 === ft.length ? "insert-end" : "insert") : "change";
  return {
    key: changeKey(change, before, after),
    change,
    before,
    after,
    beforeTokens: dt.slice(d0, d1).map((t) => t.text),
    draftExcerpt: excerpt(draft, dt, d0, d1),
    finalExcerpt: excerpt(final, ft, f0, f1),
  };
}

/**
 * The word-level changes between one draft and its final note (both NFC'd
 * here), or null when the pair is too long to diff within the budget.
 */
export function noteChanges(draftIn: string, finalIn: string, budget: CellBudget = { cells: Infinity }): NoteChange[] | null {
  const draft = nfc(draftIn);
  const final = nfc(finalIn);
  if (draft === final) return [];
  const dt = tokenize(draft);
  const ft = tokenize(final);
  const hunks = diffTokens(
    dt.map((t) => t.text),
    ft.map((t) => t.text),
    budget,
  );
  if (!hunks) return null;
  const bold = boldRanges(draft);
  const out: NoteChange[] = [];
  for (const h of hunks) {
    const parts: Hunk[] = [h];
    // Word(s) out, punctuation in: a deletion plus an insertion. Only with a
    // token before the change to anchor the insertion on (at the very start
    // there is none, and the change stays one change).
    if (h.d0 > 0 && h.d1 > h.d0 && h.f1 > h.f0) {
      const beforeHasWord = dt.slice(h.d0, h.d1).some((t) => t.word);
      const afterAllPunct = ft.slice(h.f0, h.f1).every((t) => !t.word);
      if (beforeHasWord && afterAllPunct) {
        parts.splice(0, 1, { d0: h.d0, d1: h.d1, f0: h.f0, f1: h.f0 }, { d0: h.d0, d1: h.d0, f0: h.f0, f1: h.f1 });
      }
    }
    for (const p of parts) {
      const c = buildChange(draft, final, dt, ft, p, bold);
      if (c) out.push(c);
    }
  }
  return out;
}

// ── Grouping, exclusions and homes ──────────────────────────────────────────

interface Prepared {
  row: InboxRow;
  draft: string;
  final: string;
  tokens: string[];
  changes: NoteChange[];
}

function containsRun(hay: string[], needle: string[], atEnd: boolean): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  if (atEnd) return needle.every((t, k) => hay[hay.length - needle.length + k] === t);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

const wordsOf = (s: string) => tokenize(s).filter((t) => t.word).map((t) => t.text);
const allWords = (s: string) => tokenize(s).every((t) => t.word);
const norm = (s: string | null | undefined) => (s == null ? "" : collapse(nfc(s)).trim().toLowerCase());
const stripMarks = (s: string) => s.replace(/\p{M}/gu, "");

function editDistance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The same word respelled: equal without combining marks, or one letter different. */
export function isRespelling(a: string, b: string): boolean {
  const x = Array.from(stripMarks(a));
  const y = Array.from(stripMarks(b));
  if (x.join("") === y.join("")) return true;
  return Math.min(x.length, y.length) >= 3 && editDistance(x, y) <= 1;
}

function isMechanical(s: { change: ChangeKind; before: string; after: string }): boolean {
  if (s.change !== "change") return s.change === "insert-end" && s.before === "]" && s.after === "].";
  const bw = wordsOf(s.before);
  const aw = wordsOf(s.after);
  if (bw.length > 1 || aw.length > 1) return false;
  // A bare word deleted or inserted is wording, not mechanics; a word with
  // punctuation around it (a tag like "(مُكيَّف)") is.
  if (bw.length !== aw.length) return (bw.length ? !allWords(s.before) : !allWords(s.after));
  return bw.length === 0 || isRespelling(bw[0], aw[0]);
}

/** The house-style rule that would make this change, before checking it runs. */
export function candidateRule(s: { change: ChangeKind; before: string; after: string }): SuggestedRule | null {
  if (s.change === "insert-end" && s.before === "]" && s.after === "].") {
    return { kind: "final_bracket_period", find: "]", replace: "].", scope: "end-of-note" };
  }
  if (s.change !== "change") return null;
  const toks = tokenize(s.before);
  const kind: HouseStyleKind = toks.length === 1 && toks[0].word ? "whole_word" : "literal";
  return { kind, find: s.before, replace: s.after, scope: "note" };
}

const asRule = (r: SuggestedRule, id = "suggested"): HouseStyleRule => ({
  id,
  ...r,
  examples: [],
  counterExamples: [],
  enabled: true,
  sortOrder: 0,
});

// Running the rule on one of these drafts makes the change go away.
function ruleMakesChange(rule: HouseStyleRule, key: string, rows: Prepared[]): boolean {
  const fn = compileRule(rule);
  if (!fn) return false;
  for (const p of rows) {
    const ruled = fn(p.draft);
    if (ruled === p.draft) continue;
    const after = noteChanges(ruled, p.final);
    if (after && !after.some((c) => c.key === key)) return true;
  }
  return false;
}

// TODO(#817): lessons do not exist yet. When they do, return true when a
// lesson already teaches this change (e.g. its before/after or an example of
// it), and load the lessons into InboxContext.
function coveredByLesson(_s: { before: string; after: string }): boolean {
  return false;
}

function coveredByTerm(s: { before: string; after: string }, terms: InboxTerm[]): boolean {
  const before = norm(s.before);
  const after = norm(s.after);
  const afterHasWord = wordsOf(s.after).length > 0;
  const beforeHasWord = wordsOf(s.before).length > 0;
  return terms.some(
    (t) =>
      (afterHasWord && (norm(t.target) === after || norm(t.replacement) === after)) ||
      (beforeHasWord && (t.status === "deprecated" || t.status === "forbidden") && norm(t.target) === before),
  );
}

function coveredByTemplate(s: { after: string }, templates: string[]): boolean {
  if (wordsOf(s.after).length < 2) return false;
  const after = norm(s.after);
  return templates.some((t) => t.includes(after));
}

// Either both texts appear (when before has a word, so punctuation alone never
// matches), or the line the page copies for a Common issues card does:
// «before» and «after» (or nothing, for a deletion) in guillemets.
function coveredByCommonIssues(s: { before: string; after: string }, commonIssues: string): boolean {
  const has = (x: string) => commonIssues.includes(norm(x));
  if (wordsOf(s.before).length > 0 && has(s.before) && (s.after === "" || has(s.after))) return true;
  return has(`«${s.before}»`) && (s.after === "" || has(`«${s.after}»`));
}

/** Pick examples: notes with the fewest other changes first, one per chapter first. */
function pickExamples(hits: Prepared[]): Prepared[] {
  const sorted = [...hits].sort(
    (p, q) => p.changes.length - q.changes.length || p.row.chapter - q.row.chapter || (p.row.id < q.row.id ? -1 : 1),
  );
  const out: Prepared[] = [];
  const seen = new Set<number>();
  for (const p of sorted) {
    if (out.length === EXAMPLE_COUNT) break;
    if (!seen.has(p.row.chapter)) {
      out.push(p);
      seen.add(p.row.chapter);
    }
  }
  for (const p of sorted) {
    if (out.length === EXAMPLE_COUNT) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export function buildInbox(
  rows: InboxRow[],
  ctx: InboxContext,
  budget: CellBudget = { cells: DIFF_CELL_BUDGET },
): Omit<SuggestionInboxResponse, "book" | "notMigrated"> {
  const scanned = { validated: rows.length, noDraft: 0, compared: 0, skippedLong: 0 };
  const prepared: Prepared[] = [];
  const groups = new Map<string, { first: NoteChange; hits: Prepared[] }>();
  for (const row of rows) {
    if (row.draftNote == null) {
      scanned.noDraft++;
      continue;
    }
    scanned.compared++;
    const draft = nfc(row.draftNote);
    const final = nfc(row.finalNote ?? "");
    const changes = noteChanges(draft, final, budget);
    const p: Prepared = { row, draft, final, tokens: tokenize(draft).map((t) => t.text), changes: changes ?? [] };
    prepared.push(p);
    if (!changes) {
      scanned.skippedLong++;
      continue;
    }
    const seen = new Set<string>();
    for (const c of changes) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const g = groups.get(c.key);
      if (g) g.hits.push(p);
      else groups.set(c.key, { first: c, hits: [p] });
    }
  }

  const excluded: InboxExcluded = { rejected: 0, rule: 0, term: 0, template: 0, commonIssues: 0, lesson: 0 };
  const commonIssues = norm(ctx.commonIssues);
  const templates = ctx.templates.map(norm);
  const suggestions: Suggestion[] = [];
  for (const [key, g] of groups) {
    const chapters = [...new Set(g.hits.map((p) => p.row.chapter))].sort((a, b) => a - b);
    if (g.hits.length < MIN_HITS || chapters.length < MIN_CHAPTERS) continue;
    const s = g.first;
    if (ctx.rejected.has(key)) {
      excluded.rejected++;
      continue;
    }
    const examples = pickExamples(g.hits);
    if (ctx.rules.some((r) => ruleMakesChange(r, key, examples))) {
      excluded.rule++;
      continue;
    }
    if (coveredByTerm(s, ctx.terms)) {
      excluded.term++;
      continue;
    }
    if (coveredByTemplate(s, templates)) {
      excluded.template++;
      continue;
    }
    if (coveredByCommonIssues(s, commonIssues)) {
      excluded.commonIssues++;
      continue;
    }
    if (coveredByLesson(s)) {
      excluded.lesson++;
      continue;
    }
    const hitSet = new Set(g.hits);
    const atEnd = s.change === "insert-end";
    let opportunities = 0;
    for (const p of prepared) if (hitSet.has(p) || containsRun(p.tokens, s.beforeTokens, atEnd)) opportunities++;

    let home: SuggestedHome;
    let rule: SuggestedRule | null = null;
    const cand = candidateRule(s);
    if (
      cand &&
      isMechanical(s) &&
      g.hits.length * 2 >= opportunities &&
      compileRule(asRule(cand)) &&
      ruleMakesChange(asRule(cand), key, examples)
    ) {
      home = "house_style";
      rule = cand;
    } else if (wordsOf(s.before).length >= 2 && templates.some((t) => t.includes(norm(s.before)))) {
      home = "template";
    } else if (
      s.change === "change" &&
      [s.before, s.after].every((x) => {
        const n = wordsOf(x).length;
        return n >= 1 && n <= 3 && allWords(x);
      })
    ) {
      home = "term";
    } else {
      home = "common_issues";
    }

    suggestions.push({
      key,
      change: s.change,
      before: s.before,
      after: s.after,
      hits: g.hits.length,
      opportunities,
      chapters,
      examples: examples.map((p) => {
        const c = p.changes.find((x) => x.key === key) as NoteChange;
        return { rowId: p.row.id, chapter: p.row.chapter, draft: c.draftExcerpt, final: c.finalExcerpt };
      }),
      home,
      rule,
    });
  }
  suggestions.sort((a, b) => b.hits - a.hits || (a.key < b.key ? -1 : 1));
  return { minHits: MIN_HITS, minChapters: MIN_CHAPTERS, scanned, excluded, suggestions };
}

// ── D1 loader ───────────────────────────────────────────────────────────────

type Db = Env["DB"];

const tableMissing = (err: unknown, table: string) =>
  err instanceof Error && new RegExp(`no such table:\\s*${table}`, "i").test(err.message);

async function allOrEmpty<T>(db: Db, sql: string, table: string): Promise<{ rows: T[]; missing: boolean }> {
  try {
    const rs = await db.prepare(sql).all<T>();
    return { rows: rs.results ?? [], missing: false };
  } catch (err) {
    if (tableMissing(err, table)) return { rows: [], missing: true };
    throw err;
  }
}

export async function computeInbox(db: Db, book: string): Promise<SuggestionInboxResponse> {
  const [rowRes, rules, terms, templates, prefs, rejected] = await Promise.all([
    db.prepare(SCORECARD_ROWS_SQL).bind(book).all<{
      id: string;
      chapter: number;
      final_note: string | null;
      draft_note: unknown;
    }>(),
    allOrEmpty<HouseStyleRuleRow>(
      db,
      `SELECT id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order
         FROM house_style_rules ORDER BY sort_order, id`,
      "house_style_rules",
    ),
    allOrEmpty<{ target_term: string | null; replacement: string | null; status: string }>(
      db,
      `SELECT target_term, replacement, status FROM terminology WHERE deleted_at IS NULL`,
      "terminology",
    ),
    allOrEmpty<{ target_md: string }>(
      db,
      `SELECT target_md FROM template_units
        WHERE deleted_at IS NULL AND target_md IS NOT NULL AND TRIM(target_md) <> ''`,
      "template_units",
    ),
    allOrEmpty<{ common_issues_md: string | null }>(
      db,
      `SELECT common_issues_md FROM translation_prefs WHERE id = 1`,
      "translation_prefs",
    ),
    allOrEmpty<{ key: string }>(db, `SELECT key FROM suggestion_rejections`, "suggestion_rejections"),
  ]);
  const rows: InboxRow[] = (rowRes.results ?? []).map((r) => ({
    id: r.id,
    chapter: r.chapter,
    finalNote: r.final_note,
    draftNote: typeof r.draft_note === "string" ? r.draft_note : null,
  }));
  const ctx: InboxContext = {
    rules: rules.rows
      .map(ruleFromRow)
      .filter((r): r is HouseStyleRule => !!r && !!compileRule(r)),
    terms: terms.rows.map((t) => ({ target: t.target_term, replacement: t.replacement, status: t.status })),
    templates: templates.rows.map((t) => t.target_md),
    commonIssues: prefs.rows[0]?.common_issues_md ?? "",
    rejected: new Set(rejected.rows.map((r) => r.key)),
  };
  return { book, ...buildInbox(rows, ctx), notMigrated: rejected.missing };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const suggestionInbox = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

const bookParam = (raw: string | undefined) => {
  const book = (raw ?? "").toUpperCase();
  return BOOK_NUMBERS[book] ? book : null;
};

suggestionInbox.get("/:book", requireAdmin, async (c) => {
  const book = bookParam(c.req.param("book"));
  if (!book) return c.json({ error: "unknown_book" }, 400);
  return c.json(await computeInbox(c.env.DB, book));
});

const KeyBody = z.object({ key: z.string() }).strict();

async function readKey(c: { req: { json: () => Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }
  const parsed = KeyBody.safeParse(body);
  if (!parsed.success) return null;
  const change = parseChangeKey(parsed.data.key);
  return change ? { key: parsed.data.key, ...change } : null;
}

async function ruleId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `suggested-${hex.slice(0, 12)}`;
}

suggestionInbox.post("/:book/approve", requireAdmin, async (c) => {
  const book = bookParam(c.req.param("book"));
  if (!book) return c.json({ error: "unknown_book" }, 400);
  const body = await readKey(c);
  if (!body) return c.json({ error: "bad_key" }, 400);
  // Rebuild the card from the data; never from text in the request.
  const inbox = await computeInbox(c.env.DB, book);
  const card = inbox.suggestions.find((s) => s.key === body.key);
  if (!card) return c.json({ error: "suggestion_not_found" }, 404);
  if (card.home !== "house_style" || !card.rule) return c.json({ error: "not_a_rule", home: card.home }, 409);
  const id = await ruleId(card.key);
  const fn = compileRule(asRule(card.rule, id));
  if (!fn) return c.json({ error: "rule_unsupported" }, 409);
  // Examples hold by construction: before is a real draft excerpt, after is
  // what the rule makes of it.
  const examples = card.examples
    .map((e) => ({ before: e.draft, after: fn(e.draft) }))
    .filter((e) => e.after !== e.before)
    .slice(0, EXAMPLE_COUNT);
  try {
    await c.env.DB.prepare(
      `INSERT INTO house_style_rules
         (id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', 1,
               (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM house_style_rules), unixepoch(), ?7)`,
    )
      .bind(id, card.rule.kind, card.rule.find, card.rule.replace, card.rule.scope, JSON.stringify(examples), currentUserId(c))
      .run();
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return c.json({ error: "rule_exists", id }, 409);
    }
    if (tableMissing(err, "house_style_rules")) return c.json({ error: "not_migrated" }, 503);
    throw err;
  }
  return c.json({ rule: { id, ...card.rule, examples, enabled: true } }, 201);
});

suggestionInbox.post("/reject", requireAdmin, async (c) => {
  const body = await readKey(c);
  if (!body) return c.json({ error: "bad_key" }, 400);
  try {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO suggestion_rejections (key, before_text, after_text, rejected_by) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(body.key, body.before, body.after, currentUserId(c))
      .run();
  } catch (err) {
    if (tableMissing(err, "suggestion_rejections")) return c.json({ error: "not_migrated" }, 503);
    throw err;
  }
  return c.json({ ok: true });
});
