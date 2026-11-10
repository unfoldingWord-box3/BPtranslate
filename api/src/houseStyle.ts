// House-style rules (issue #815): mechanical fixes applied to an AI translate
// draft when it is imported, so editors stop making the same correction on
// almost every note. Rules live in the house_style_rules table (migration 0082),
// one list per workspace database, and are switched on one by one by an admin.
//
// A rule is data, but its matching is not: `kind` picks one of a fixed set of
// matchers below, and `find` / `replace` are always literal text (escaped before
// any regex is built). There is deliberately no admin-typed regex, because a
// pattern typed into a form would rewrite every imported draft.
//
//   literal              Replace `find` anywhere outside **bold** spans. The
//                        order of combining marks inside one run in `find` is
//                        ignored (Arabic text arrives with the vowel before or
//                        after the shadda), and a match never ends with a base
//                        letter whose own marks follow it. An empty `replace`
//                        deletes the match plus one adjacent run of spaces:
//                        the spaces after it when it starts the text or a line
//                        or follows an opening "[" or "(", else the spaces
//                        before it.
//   whole_word           The same, but the match must not touch a letter, a
//                        combining mark or a digit on either side.
//   final_bracket_period Append "." after the note's final "]", unless the
//                        bracket's content is blank or already ends in
//                        punctuation (… ؟ . ! ? ؛, so "..." too; closing quotes
//                        and brackets are looked through), the note ends in "]]" (an
//                        rc link), the "]" has no opening "[", or it sits in a
//                        bold span.
//
// Scope "note" matches anywhere; "end-of-note" only where nothing ignorable
// follows the match. Ignorable at the end: whitespace, bidi marks (U+200E,
// U+200F, U+061C) and line breaks, which tN stores as the two characters
// backslash-n (importParsers.ts normalizeNoteWhitespace), not a real newline.
// Note-scope rules run before end-of-note ones, so deleting a trailing tag can
// expose the final "]" for the period rule.
//
// Bold spans: text between a pair of `**` is a Scripture quote and is never
// changed. An unpaired `**` protects everything after it.
//
// Idempotency: the shipped kinds and the seed rules are tested idempotent
// (houseStyle.test.mjs). The compile-time guard is narrower: it only refuses a
// literal/whole_word rule whose `replace` contains a match of its own `find`.
// It does not catch every case (e.g. find "ab" → replace "a" applied to "aab"),
// which is one reason rules arrive by migration with tests, not by a form.

import type { Env } from "./index";

export const HOUSE_STYLE_KINDS = ["literal", "whole_word", "final_bracket_period"] as const;
export type HouseStyleKind = (typeof HOUSE_STYLE_KINDS)[number];
export const HOUSE_STYLE_SCOPES = ["note", "end-of-note"] as const;
export type HouseStyleScope = (typeof HOUSE_STYLE_SCOPES)[number];

export interface HouseStyleExample {
  before: string;
  after: string;
}

export interface HouseStyleRule {
  id: string;
  kind: HouseStyleKind;
  find: string;
  replace: string;
  scope: HouseStyleScope;
  examples: HouseStyleExample[];
  counterExamples: string[];
  enabled: boolean;
  sortOrder: number;
}

export interface HouseStyleRuleRow {
  id: string;
  kind: string;
  find: string;
  replace: string | null;
  scope: string;
  examples_json: string | null;
  counter_examples_json: string | null;
  enabled: number;
  sort_order: number;
}

// Bracket content endings that get no closing period: the issue's "…" and "؟",
// plus punctuation that would otherwise double up ("." covers "...").
const PERIOD_EXEMPT_ENDINGS = new Set(["…", "؟", ".", "!", "?", "؛"]); // … ؟ . ! ? ؛
// Closing quotes and brackets looked through before that check: » " ' ) ” ’
const CLOSERS = new Set(["»", '"', "'", ")", "”", "’"]);

// Leftover English the model sometimes forgets to translate. Flagged in
// draft_meta_json (leftover_english), never rewritten.
const LEFTOVER_ENGLISH = ["If it would be helpful in your language"];

function parseJsonArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// DB row → rule, or null when the kind/scope is not one this code knows (an
// unknown row is skipped rather than guessed at).
export function ruleFromRow(row: HouseStyleRuleRow): HouseStyleRule | null {
  if (!(HOUSE_STYLE_KINDS as readonly string[]).includes(row.kind)) return null;
  if (!(HOUSE_STYLE_SCOPES as readonly string[]).includes(row.scope)) return null;
  if (typeof row.find !== "string" || row.find === "") return null;
  const examples = parseJsonArray(row.examples_json).filter(
    (e): e is HouseStyleExample =>
      !!e && typeof (e as HouseStyleExample).before === "string" && typeof (e as HouseStyleExample).after === "string",
  );
  const counterExamples = parseJsonArray(row.counter_examples_json).filter((e): e is string => typeof e === "string");
  return {
    id: row.id,
    kind: row.kind as HouseStyleKind,
    find: row.find,
    replace: row.replace ?? "",
    scope: row.scope as HouseStyleScope,
    examples,
    counterExamples,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
  };
}

// ── Matching helpers ────────────────────────────────────────────────────────

const MARK = /^\p{M}$/u;
const WORDISH = "[\\p{L}\\p{M}\\p{N}]";

// Escape for a `u`-flag regex: only syntax characters may be escaped there.
function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  arr.forEach((x, i) => {
    for (const rest of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

// Regex source for `find`, with each run of 2-4 combining marks matching any
// order of the same marks.
function findSource(find: string): string {
  const cps = Array.from(find);
  let out = "";
  let i = 0;
  while (i < cps.length) {
    if (!MARK.test(cps[i])) {
      out += escapeRe(cps[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < cps.length && MARK.test(cps[j])) j++;
    const run = cps.slice(i, j);
    if (run.length === 1 || run.length > 4) {
      out += run.map(escapeRe).join("");
    } else {
      const alts = [...new Set(permutations(run).map((p) => p.map(escapeRe).join("")))];
      out += `(?:${alts.join("|")})`;
    }
    i = j;
  }
  return out;
}

// [start, end) ranges inside `**…**` pairs (markers included). An unpaired
// `**` protects from there to the end of the text.
export function boldRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const open = text.indexOf("**", from);
    if (open === -1) break;
    const close = text.indexOf("**", open + 2);
    if (close === -1) {
      out.push([open, text.length]);
      break;
    }
    out.push([open, close + 2]);
    from = close + 2;
  }
  return out;
}

function overlaps(ranges: Array<[number, number]>, s: number, e: number): boolean {
  return ranges.some(([a, b]) => s < b && e > a);
}

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === " ";
const BIDI_MARKS = new Set(["‎", "‏", "؜"]);

// True when a line break ends at index i: a real newline, or tN's stored
// two-character escape backslash-n.
function lineBreakEndsAt(text: string, i: number): boolean {
  return text[i - 1] === "\n" || (i >= 2 && text[i - 2] === "\\" && text[i - 1] === "n");
}

// Index where the ignorable tail of the text begins: whitespace, bidi marks
// and line breaks (real or backslash-n) at the very end.
function ignorableTailStart(text: string): number {
  let end = text.length;
  for (;;) {
    if (end > 0 && (/\s/.test(text[end - 1]) || BIDI_MARKS.has(text[end - 1]))) end--;
    else if (end >= 2 && text[end - 2] === "\\" && text[end - 1] === "n") end -= 2;
    else return end;
  }
}

function trimIgnorableEnd(s: string): string {
  return s.slice(0, ignorableTailStart(s));
}

type Compiled = (text: string) => string;

function compileLiteral(rule: HouseStyleRule): Compiled | null {
  const src = findSource(rule.find);
  const pattern =
    // whole_word: a stored backslash-n line break before the word is a
    // boundary too, although its "n" is a letter.
    rule.kind === "whole_word"
      ? `(?:(?<=\\\\n)|(?<!${WORDISH}))${src}(?!${WORDISH})`
      : `${src}(?!\\p{M})`;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gu");
  } catch {
    return null;
  }
  // Idempotency guard: the replacement must not be matched again.
  if (rule.replace !== "" && new RegExp(pattern, "u").test(rule.replace)) return null;
  const endOnly = rule.scope === "end-of-note";
  return (text) => {
    const prot = boldRanges(text);
    const tail = endOnly ? ignorableTailStart(text) : text.length;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      let s = m.index ?? 0;
      let e = s + m[0].length;
      if (s < last || overlaps(prot, s, e)) continue;
      if (endOnly && e < tail) continue;
      if (rule.replace === "") {
        // Deleting: so no double space (or "[ word") is left, take the spaces
        // after the match when it follows an opening bracket or starts the
        // text or a line; otherwise the spaces before it.
        const takeAfter = text[s - 1] === "[" || text[s - 1] === "(";
        let s2 = s;
        if (!takeAfter) while (s2 > last && isSpace(text[s2 - 1])) s2--;
        // Line start, looking past any bidi marks right after the break.
        let ls = s;
        while (ls > 0 && BIDI_MARKS.has(text[ls - 1])) ls--;
        if (s2 < s) s = s2;
        else if (takeAfter || ls === 0 || lineBreakEndsAt(text, ls)) {
          while (e < text.length && isSpace(text[e])) e++;
        }
      }
      out += text.slice(last, s) + rule.replace;
      last = e;
    }
    return last === 0 ? text : out + text.slice(last);
  };
}

function finalBracketPeriod(text: string): string {
  const end = ignorableTailStart(text);
  if (end === 0 || text[end - 1] !== "]") return text;
  const close = end - 1;
  if (text[close - 1] === "]") return text; // "]]" ends an rc link
  if (overlaps(boldRanges(text), close, close + 1)) return text;
  const open = text.lastIndexOf("[", close - 1);
  if (open === -1) return text;
  const raw = text.slice(open + 1, close);
  if (raw.includes("]")) return text;
  // Look through closing quotes and brackets: [قال: «اذهب.»] already ends in
  // a period. Content that is empty or only spaces gets none.
  let content = trimIgnorableEnd(raw);
  while (content !== "" && CLOSERS.has(content[content.length - 1])) {
    content = trimIgnorableEnd(content.slice(0, -1));
  }
  if (content === "") return text;
  if (PERIOD_EXEMPT_ENDINGS.has(content[content.length - 1])) return text;
  return text.slice(0, end) + "." + text.slice(end);
}

export function compileRule(rule: HouseStyleRule): Compiled | null {
  switch (rule.kind) {
    case "literal":
    case "whole_word":
      return compileLiteral(rule);
    case "final_bracket_period":
      return rule.scope === "end-of-note" ? finalBracketPeriod : null;
    default:
      return null;
  }
}

// Note-scope rules first, then end-of-note, each in sort order.
function ordered(rules: HouseStyleRule[]): HouseStyleRule[] {
  const rank = (r: HouseStyleRule) => (r.scope === "note" ? 0 : 1);
  return [...rules].sort((a, b) => rank(a) - rank(b) || a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1));
}

// Apply every ENABLED rule to one text. `applied` lists the ids that changed it.
export function applyHouseStyle(text: string, rules: HouseStyleRule[]): { text: string; applied: string[] } {
  const applied: string[] = [];
  let cur = text;
  for (const rule of ordered(rules.filter((r) => r.enabled))) {
    const fn = compileRule(rule);
    if (!fn) continue;
    const next = fn(cur);
    if (next !== cur) {
      applied.push(rule.id);
      cur = next;
    }
  }
  return { text: cur, applied };
}

export function findLeftoverEnglish(texts: Array<string | null>): string[] {
  const hay = texts.filter((t): t is string => typeof t === "string").join("\n").toLowerCase();
  return LEFTOVER_ENGLISH.filter((p) => hay.includes(p.toLowerCase()));
}

// What the translate apply writes for one proposal: the post-rule field values,
// the extra edit_log payload keys (null when no rule changed anything, so the
// payload stays exactly as before), and draft_meta_json.
export function houseStyleForProposal(
  payload: Record<string, unknown>,
  fields: string[],
  rules: HouseStyleRule[],
): { values: Record<string, string | null>; logPayload: Record<string, unknown>; draftMetaJson: string | null } {
  const values: Record<string, string | null> = {};
  const changed: Record<string, string> = {};
  const appliedSet = new Set<string>();
  for (const f of fields) {
    const raw = payload[f];
    if (typeof raw !== "string") {
      values[f] = (raw as string | null | undefined) ?? null;
      continue;
    }
    const r = applyHouseStyle(raw, rules);
    values[f] = r.text;
    if (r.text !== raw) changed[f] = r.text;
    for (const id of r.applied) appliedSet.add(id);
  }
  let logPayload: Record<string, unknown> = payload;
  if (appliedSet.size > 0) {
    // Ids in the order the rules ran. Only fields a rule actually changed get
    // a new value and a raw_<field>; keys absent before stay absent.
    const appliedRules = ordered(rules).map((r) => r.id).filter((id) => appliedSet.has(id));
    logPayload = { ...payload, ...changed, applied_rules: appliedRules };
    for (const f of Object.keys(changed)) logPayload[`raw_${f}`] = payload[f];
  }
  const leftover = findLeftoverEnglish(fields.map((f) => values[f]));
  const meta = payload.draft_meta;
  let draftMetaJson: string | null = meta != null ? JSON.stringify(meta) : null;
  // A draft_meta that is not a plain object is kept as is, without the flag.
  const metaIsObject = meta == null || (typeof meta === "object" && !Array.isArray(meta));
  if (leftover.length > 0 && metaIsObject) {
    draftMetaJson = JSON.stringify({ ...((meta ?? {}) as Record<string, unknown>), leftover_english: leftover });
  }
  return { values, logPayload, draftMetaJson };
}

// The enabled rules for this workspace's database, read once per import job.
// Fail-soft: a missing table or a bad row must never stop a draft import.
export async function loadEnabledHouseStyleRules(db: Env["DB"]): Promise<HouseStyleRule[]> {
  try {
    const rs = await db
      .prepare(
        `SELECT id, kind, find, replace, scope, examples_json, counter_examples_json, enabled, sort_order
           FROM house_style_rules WHERE enabled = 1 ORDER BY sort_order, id`,
      )
      .all<HouseStyleRuleRow>();
    const out: HouseStyleRule[] = [];
    for (const row of rs.results ?? []) {
      const rule = ruleFromRow(row);
      if (rule && compileRule(rule)) out.push(rule);
      else console.warn(`house style: skipping rule ${row.id} (unknown kind/scope or not idempotent)`);
    }
    return out;
  } catch (e) {
    console.error("house style: could not load rules; importing drafts unchanged", e);
    return [];
  }
}
