// Suggestion inbox (issue #819): corrections editors keep making to AI
// translation-note drafts, grouped so an admin can turn each into guidance.
//
// GET  /api/suggestion-inbox/:book          the cards for one book (admin only)
// POST /api/suggestion-inbox/:book/approve  {key} → an enabled house-style rule
// POST /api/suggestion-inbox/:book/reject   {key} → never suggested again
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
//             run on the FULL draft of one of the card's examples, the rule
//             makes exactly this change and nothing else (ruleReproduces);
//             covered by a term: after (with a word) equals the target of a
//             live term that is not deprecated or forbidden; covered by a
//             template: some note template's text contains after (two words
//             or more); already a Common issues line: one line of that text is
//             exactly the line the page copies ("- «before» → «after»", either
//             arrow, ∅ for a deletion), or holds before and after (both with a
//             word) as whole words; already a lesson: stubbed until lessons
//             exist (#817), see coveredByLesson.
//   home      house_style ONLY for the three shapes candidateRule allows (the
//             closing period after a final "]"; deleting a tag fully enclosed
//             in () or []; one whole word whose only change is its combining
//             marks), when the rule's measured precision passes: run over
//             every compared draft of the book, it changes at least
//             MIN_RULE_FIRES (10) drafts, and on at least 80% of them (90% for
//             marks) it makes exactly the editor's change (ruleReproduces;
//             a draft whose check cannot finish counts as wrong). It must also
//             reproduce the change on every example. Approve re-checks the
//             gate (409 rule_imprecise). Else template when before (two words or
//             more) appears in a note template. Else term when both sides are
//             one to three words with no punctuation. Else common_issues.
//
// Approve exists only for house_style cards and takes just the key: the server
// recomputes the book's inbox and builds the rule from its own card, so no
// text an admin sends becomes a pattern (the #815 stance). It re-checks that
// the rule reproduces the change exactly on every example's full draft (else
// 409 rule_mismatch) and stores real pairs (the draft line holding the change,
// and what the rule makes of it) as the rule's examples. The closing period
// uses the existing final_bracket_period kind: a literal "]" → "]." is refused
// by compileRule's idempotency guard, as is any pure insertion.
//
// Reject also takes the book: only a card currently shown for that book can be
// rejected (else 404), so no arbitrary key is stored.
//
// Cost, measured in node on this box (single run each):
//   - 3,000 rows with a small change each, the closing period among them, so
//     one rule card whose precision check runs over all 3,000 drafts: about
//     1.1-1.3 s (0.6 s before the precision gate);
//   - 3,000 fully rewritten 200-token notes, no rule card: about 1.9 s;
//   - worst case seen: 3,000 notes that each delete the tag AND rewrite 200
//     tokens, so every row needs three full precision diffs: about 5.7 s.
// The precision checks spend their own PRECISION_CELL_BUDGET (300M cells),
// so even past these figures a request is bounded; rows past it count as wrong.

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
/** Longest differing middle the precision check (ruleReproduces) diffs; Uint16-safe. */
export const PRECISION_SEGMENT_CAP = 2_000;
/** LCS cells the precision checks of one request may fill, apart from DIFF_CELL_BUDGET. */
export const PRECISION_CELL_BUDGET = 300_000_000;
/** A rule card needs at least this many drafts the rule would change. */
export const MIN_RULE_FIRES = 10;

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
  /** Where the change's before text sits in the (NFC) draft. */
  draftStart: number;
  draftEnd: number;
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
  /** For a change one of the rule shapes covers: how the rule did on this book's drafts (null otherwise). */
  precision: RulePrecision | null;
  /** Why a rule-shaped card is not a house-style card: its precision, or its examples (the rule does not make the editor's change on each). */
  ruleBlocked: RuleBlocked;
}

export type RuleBlocked = "precision" | "examples" | null;

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

// Word characters: letters, combining marks, digits, and ZWNJ / ZWJ
// (U+200C, U+200D), which sit inside Persian and Arabic words.
const WORD = /^[\p{L}\p{M}\p{N}\p{Join_Control}]$/u;
// Separators: whitespace and bidi controls (U+200E, U+200F, U+061C, embeddings and isolates).
const SPACE = /^[\s\p{Bidi_Control}]$/u;
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
function diffTokens(a: string[], b: string[], budget: CellBudget, cap = DIFF_SEGMENT_CAP): Hunk[] | null {
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
  if (n > cap || m > cap || n * m > budget.cells) return null;
  budget.cells -= n * m;
  const W = m + 1;
  // Uint16 is safe: an LCS length is at most the cap (400, or 2,000 for the
  // precision check) < 65,535.
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
// Bidi controls dropped (so "]" + RLM + "." groups with "]."), runs of spaces, tabs and
// no-break spaces made one space.
const collapse = (s: string) => s.replace(/\p{Bidi_Control}/gu, "").replace(/[\p{Zs}\t]+/gu, " ");

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
  filter: boolean,
): NoteChange | null {
  let { d0, d1, f0, f1 } = h;
  const insertion = d0 === d1;
  let leftAnchored = false;
  if (insertion) {
    if (d0 > 0) {
      d0--;
      f0--;
      leftAnchored = true;
    } else if (d1 < dt.length && f1 < ft.length) {
      d1++;
      f1++;
    } else return null;
  }
  if (filter && (d1 - d0 > MAX_CHANGE_TOKENS || f1 - f0 > MAX_CHANGE_TOKENS)) return null;
  const rawBefore = slice(draft, dt, d0, d1);
  const rawAfter = slice(final, ft, f0, f1);
  if (filter && (LINE_BREAK.test(rawBefore) || LINE_BREAK.test(rawAfter))) return null;
  if (filter && d1 > d0 && bold.some(([a, b]) => dt[d0].start < b && dt[d1 - 1].end > a)) return null;
  const before = collapse(rawBefore);
  const after = collapse(rawAfter);
  // "insert-end" only when the inserted text itself ends the note: an insertion
  // anchored on the token AFTER it (at the very start) never does.
  const change: ChangeKind = insertion ? (leftAnchored && f1 === ft.length ? "insert-end" : "insert") : "change";
  return {
    key: changeKey(change, before, after),
    change,
    before,
    after,
    beforeTokens: dt.slice(d0, d1).map((t) => t.text),
    draftStart: dt[d0].start,
    draftEnd: dt[d1 - 1].end,
    draftExcerpt: excerpt(draft, dt, d0, d1),
    finalExcerpt: excerpt(final, ft, f0, f1),
  };
}

/**
 * The word-level changes between one draft and its final note (both NFC'd
 * here), or null when the pair is too long to diff within the budget. With
 * `filter` false nothing is dropped (long, line-crossing, bold), and a change
 * that cannot be anchored gets the key "?": the exactness check
 * (ruleReproduces) must see every difference.
 */
export function noteChanges(
  draftIn: string,
  finalIn: string,
  budget: CellBudget = { cells: Infinity },
  filter = true,
  cap = DIFF_SEGMENT_CAP,
): NoteChange[] | null {
  const draft = nfc(draftIn);
  const final = nfc(finalIn);
  if (draft === final) return [];
  const dt = tokenize(draft);
  const ft = tokenize(final);
  const hunks = diffTokens(
    dt.map((t) => t.text),
    ft.map((t) => t.text),
    budget,
    cap,
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
      const c = buildChange(draft, final, dt, ft, p, bold, filter);
      if (c) out.push(c);
      else if (!filter) out.push({ key: "?", change: "change", before: "", after: "", beforeTokens: [], draftStart: 0, draftEnd: 0, draftExcerpt: "", finalExcerpt: "" });
    }
  }
  return out;
}

// ── Grouping, exclusions and homes ──────────────────────────────────────────

/** A card's example note in full (NFC), with its change: what approve checks the rule on. */
export interface ExampleNote {
  draft: string;
  final: string;
  change: NoteChange;
}

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

const CLOSER: Record<string, string> = { "(": ")", "[": "]" };

/** A tag fully enclosed in one pair of parentheses or brackets, with a letter inside: "(مُكيَّف)". */
export function isEnclosedTag(s: string): boolean {
  const close = CLOSER[s[0]];
  if (!close || s.length < 3 || s[s.length - 1] !== close) return false;
  const inner = s.slice(1, -1);
  return /\p{L}/u.test(inner) && !/[()[\]]/.test(inner);
}

/** One word whose only change is its combining marks (tanween, vowels): "مفيدا" → "مفيدًا". */
export function isMarksOnly(before: string, after: string): boolean {
  const b = tokenize(before);
  const a = tokenize(after);
  return (
    b.length === 1 && a.length === 1 && b[0].word && a[0].word && before !== after && stripMarks(before) === stripMarks(after)
  );
}

/**
 * The house-style rule for a change, offered ONLY for the three shapes that are
 * safe to run on every future draft (every book, notes and questions), with the
 * precision the rule must reach on this book (rulePrecision: of the drafts it
 * would change, the share where it makes exactly the editor's change):
 *   - the closing period after the note's final "]" (final_bracket_period), 80%;
 *   - deleting a tag fully enclosed in () or [] with a letter inside (literal;
 *     the brackets bound the match), 80%;
 *   - one whole word whose only change is its combining marks (whole_word),
 *     90%, because a mark change can be grammar and right only in context.
 * Everything else (punctuation swaps, word+punctuation literals with no letter
 * boundary, respellings, bare word deletions) is never an automatic rule.
 */
export function candidateRule(s: { change: ChangeKind; before: string; after: string }): { rule: SuggestedRule; minPrecision: number } | null {
  if (s.change === "insert-end" && s.before === "]" && s.after === "].") {
    return { rule: { kind: "final_bracket_period", find: "]", replace: "].", scope: "end-of-note" }, minPrecision: 0.8 };
  }
  if (s.change !== "change") return null;
  if (s.after === "" && isEnclosedTag(s.before)) {
    return { rule: { kind: "literal", find: s.before, replace: "", scope: "note" }, minPrecision: 0.8 };
  }
  if (isMarksOnly(s.before, s.after)) {
    return { rule: { kind: "whole_word", find: s.before, replace: s.after, scope: "note" }, minPrecision: 0.9 };
  }
  return null;
}

export const asRule = (r: SuggestedRule, id = "suggested"): HouseStyleRule => ({
  id,
  ...r,
  examples: [],
  counterExamples: [],
  enabled: true,
  sortOrder: 0,
});

const sameKeys = (a: NoteChange[], b: string[]) => {
  const x = a.map((c) => c.key).sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
};

/**
 * The rule makes exactly the editor's change in this note. Run on the FULL
 * draft: everything the rule changed is this change (nothing else rewritten),
 * and against the final, this change is gone while every other difference is
 * untouched. Unfiltered diffs, so a long or bold-adjacent edit cannot hide.
 */
export function ruleReproduces(
  fn: (t: string) => string,
  key: string,
  draftIn: string,
  finalIn: string,
  budget: CellBudget = { cells: Infinity },
): boolean {
  return reproduceCheck(fn, key, draftIn, finalIn, budget) === true;
}

/**
 * ruleReproduces with the third answer kept: null when a diff did not fit the
 * per-pair cap or the budget, so the question could not be answered. Every
 * caller treats null as a failure (fail closed); approve reports it as
 * rule_imprecise rather than rule_mismatch.
 */
export function reproduceCheck(
  fn: (t: string) => string,
  key: string,
  draftIn: string,
  finalIn: string,
  budget: CellBudget,
): boolean | null {
  const draft = nfc(draftIn);
  const final = nfc(finalIn);
  const ruled = fn(draft);
  if (ruled === draft) return false;
  // A larger per-pair cap than the grouping diff, so a long note the grouping
  // skipped can still be checked; past it (or past the budget) the answer is
  // unknown, never a guess.
  const edits = noteChanges(draft, ruled, budget, false, PRECISION_SEGMENT_CAP);
  if (!edits) return null;
  if (edits.length === 0 || edits.some((c) => c.key !== key)) return false;
  const had = noteChanges(draft, final, budget, false, PRECISION_SEGMENT_CAP);
  const left = had && noteChanges(ruled, final, budget, false, PRECISION_SEGMENT_CAP);
  if (!had || !left) return null;
  return sameKeys(left, had.filter((c) => c.key !== key).map((c) => c.key));
}

/** The rule's stored examples: each example's draft line and what the rule makes of it, only where it changes something. */
export function realExamples(
  fn: (t: string) => string,
  notes: { draft: string; change: { draftStart: number; draftEnd: number } }[],
): { before: string; after: string }[] {
  return notes
    .map((n) => draftLine(n.draft, n.change.draftStart, n.change.draftEnd))
    .map((before) => ({ before, after: fn(before) }))
    .filter((e) => e.after !== e.before)
    .slice(0, EXAMPLE_COUNT);
}

/**
 * Approve's check on a card's example notes, in full: "ok" when the rule makes
 * exactly the editor's change on every one, "mismatch" when it does not on
 * one, "unknown" when a check ran out of cap or budget.
 */
export function checkExamples(
  fn: (t: string) => string,
  key: string,
  notes: { draft: string; final: string }[],
  budget: CellBudget,
): "ok" | "mismatch" | "unknown" {
  if (notes.length === 0) return "mismatch";
  let unknown = false;
  for (const n of notes) {
    const r = reproduceCheck(fn, key, n.draft, n.final, budget);
    if (r === false) return "mismatch";
    if (r === null) unknown = true;
  }
  return unknown ? "unknown" : "ok";
}

export interface RulePrecision {
  /** Compared drafts of the book the rule would change. */
  fires: number;
  /** Of those, the drafts where it makes exactly the editor's change (ruleReproduces). */
  correct: number;
  /** The share it must reach to be offered as a rule (0.8 or 0.9). */
  minPrecision: number;
}

/**
 * Run the rule over every compared draft of the book. A draft it changes is a
 * fire; a fire is correct only when ruleReproduces holds against that row's
 * final within the budget. Rows the grouping diff skipped are run too: when
 * their check cannot finish, they count as fired and not correct, so unknown
 * rows never raise precision.
 */
function measurePrecision(
  fn: (t: string) => string,
  key: string,
  rows: Prepared[],
  minPrecision: number,
  budget: CellBudget,
): RulePrecision {
  let fires = 0;
  let correct = 0;
  for (const p of rows) {
    if (fn(p.draft) === p.draft) continue;
    fires++;
    if (ruleReproduces(fn, key, p.draft, p.final, budget)) correct++;
  }
  return { fires, correct, minPrecision };
}

/** At least MIN_RULE_FIRES fires, and correct / fires at least the shape's bar. */
export function precisionPasses(p: RulePrecision): boolean {
  return p.fires >= MIN_RULE_FIRES && p.correct >= p.minPrecision * p.fires;
}

// Budgeted like every check: an exhausted budget answers "no" (fail closed),
// so a card stays visible and no rule home is offered.
function ruleReproducesOn(rule: HouseStyleRule, key: string, rows: Prepared[], every: boolean, budget: CellBudget): boolean {
  const fn = compileRule(rule);
  if (!fn || rows.length === 0) return false;
  const ok = (p: Prepared) => ruleReproduces(fn, key, p.draft, p.final, budget);
  return every ? rows.every(ok) : rows.some(ok);
}

/** The line of the draft (between stored line breaks) that holds a change: a real, uncut pair for a rule's examples. */
export function draftLine(draft: string, start: number, end: number): string {
  const esc = start >= 2 ? draft.lastIndexOf("\\n", start - 2) : -1;
  const from = Math.max(esc >= 0 ? esc + 2 : 0, draft.lastIndexOf("\n", start - 1) + 1);
  const ends = [draft.indexOf("\\n", end), draft.indexOf("\n", end)].filter((i) => i >= 0);
  const to = ends.length ? Math.min(...ends) : draft.length;
  return draft.slice(from, to).trim();
}

// TODO(#817): lessons do not exist yet. When they do, return true when a
// lesson already teaches this change (e.g. its before/after or an example of
// it), and load the lessons into InboxContext.
function coveredByLesson(_s: { before: string; after: string }): boolean {
  return false;
}

// A live term that is not deprecated or forbidden already gives the approved words.
function coveredByTerm(s: { after: string }, terms: InboxTerm[]): boolean {
  if (wordsOf(s.after).length === 0) return false;
  const after = norm(s.after);
  return terms.some((t) => t.status !== "deprecated" && t.status !== "forbidden" && norm(t.target) === after);
}

function coveredByTemplate(s: { after: string }, templates: string[]): boolean {
  if (wordsOf(s.after).length < 2) return false;
  const after = norm(s.after);
  return templates.some((t) => t.includes(after));
}

const escapeRe = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const hasWholeWord = (line: string, w: string) =>
  new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{M}\\p{N}])`, "u").test(line);

// One line of the Common issues text is either exactly the line the page copies
// ("- «before» → «after»", either arrow, ∅ for a deletion), or holds before and
// after (both with a word) as whole words. No bare substring matching.
function coveredByCommonIssues(s: { before: string; after: string }, commonIssues: string): boolean {
  const before = norm(s.before);
  const after = norm(s.after);
  const target = after === "" ? "∅" : `«${after}»`;
  const wordy = wordsOf(s.before).length > 0 && wordsOf(s.after).length > 0;
  return commonIssues.split(/\r?\n/).some((raw) => {
    const line = norm(raw);
    if (line === `- «${before}» → ${target}` || line === `- «${before}» ← ${target}`) return true;
    return wordy && hasWholeWord(line, before) && hasWholeWord(line, after);
  });
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
  /** When given, receives each card's example notes in full (for approve). */
  exampleNotes?: Map<string, ExampleNote[]>,
  /** One request-scoped budget for every rule check (precision, covered-by-rule, examples). */
  checkBudget: CellBudget = { cells: PRECISION_CELL_BUDGET },
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
  const precisionBudget = checkBudget;
  const commonIssues = ctx.commonIssues;
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
    // Covered only when the rule makes exactly this change on an example.
    if (ctx.rules.some((r) => ruleReproducesOn(r, key, examples, false, checkBudget))) {
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
    let precision: RulePrecision | null = null;
    const cand = candidateRule(s);
    const candFn = cand ? compileRule(asRule(cand.rule)) : null;
    // Gate on measured precision over every compared draft of the book, not on
    // diff hits: drafts the rule would change but the editor left alone, or
    // where it would change more, count against it.
    if (cand && candFn) precision = measurePrecision(candFn, key, prepared, cand.minPrecision, precisionBudget);
    // Why a rule-shaped card is not offered as a rule (null when it is, or has no rule shape).
    let ruleBlocked: RuleBlocked = null;
    if (cand && precision) {
      if (!precisionPasses(precision)) ruleBlocked = "precision";
      else if (!ruleReproducesOn(asRule(cand.rule), key, examples, true, checkBudget)) ruleBlocked = "examples";
    }
    if (cand && precision && ruleBlocked === null) {
      home = "house_style";
      rule = cand.rule;
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
      precision,
      ruleBlocked,
    });
    exampleNotes?.set(
      key,
      examples.map((p) => ({ draft: p.draft, final: p.final, change: p.changes.find((x) => x.key === key) as NoteChange })),
    );
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

export async function computeInbox(
  db: Db,
  book: string,
  exampleNotes?: Map<string, ExampleNote[]>,
): Promise<SuggestionInboxResponse> {
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
      `SELECT target_term, replacement, status FROM terminology
        WHERE deleted_at IS NULL AND status NOT IN ('deprecated', 'forbidden')`,
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
  return { book, ...buildInbox(rows, ctx, undefined, exampleNotes), notMigrated: rejected.missing };
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
  const exampleNotes = new Map<string, ExampleNote[]>();
  const inbox = await computeInbox(c.env.DB, book, exampleNotes);
  const card = inbox.suggestions.find((s) => s.key === body.key);
  if (!card) return c.json({ error: "suggestion_not_found" }, 404);
  // The same precision gate the card was built with, recomputed on today's data.
  if (card.precision && !precisionPasses(card.precision)) {
    return c.json({ error: "rule_imprecise", precision: card.precision }, 409);
  }
  if (card.home !== "house_style" || !card.rule) return c.json({ error: "not_a_rule", home: card.home }, 409);
  const id = await ruleId(card.key);
  const fn = compileRule(asRule(card.rule, id));
  if (!fn) return c.json({ error: "rule_unsupported" }, 409);
  // The rule must make exactly the editor's change on every example's FULL
  // draft, and nothing else.
  const notes = exampleNotes.get(card.key) ?? [];
  // Budgeted like the card's own checks; a check that cannot finish fails closed.
  const verdict = checkExamples(fn, card.key, notes, { cells: PRECISION_CELL_BUDGET });
  if (verdict === "unknown") return c.json({ error: "rule_imprecise", precision: card.precision }, 409);
  if (verdict === "mismatch") return c.json({ error: "rule_mismatch" }, 409);
  // Stored examples are real pairs: the whole line of the draft that holds the
  // change (no "…"), and what the rule makes of that line.
  const examples = realExamples(fn, notes);
  // Never store a rule without at least one real pair.
  if (examples.length === 0) return c.json({ error: "rule_mismatch" }, 409);
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

suggestionInbox.post("/:book/reject", requireAdmin, async (c) => {
  const book = bookParam(c.req.param("book"));
  if (!book) return c.json({ error: "unknown_book" }, 400);
  const body = await readKey(c);
  if (!body) return c.json({ error: "bad_key" }, 400);
  // Only a card the admin can see now in this book can be rejected.
  const inbox = await computeInbox(c.env.DB, book);
  if (inbox.notMigrated) return c.json({ error: "not_migrated" }, 503);
  if (!inbox.suggestions.some((s) => s.key === body.key)) return c.json({ error: "suggestion_not_found" }, 404);
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
