// Offline search over the in-app guide. Pure and dependency-free: the guide is
// a few dozen short articles, so a scan per keystroke is cheap.
import type { HelpArticle } from "./guideMap";

export interface HelpHit {
  article: HelpArticle;
  score: number;
  snippet: string;
}

/**
 * Lowercase, drop combining marks (Latin accents, Arabic harakat/tashkeel via
 * NFKD + \p{M}) and fold the Arabic letter variants people type
 * interchangeably, so "اُدْخِل" and "ادخل" compare equal.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

const ARABIC_LETTER = /[\u0600-\u06FF]/;
const MULTI_PROCLITICS = ["وال", "بال", "كال", "فال", "لل", "ال"];
const SINGLE_PROCLITICS = ["و", "ب", "ل", "ف", "ك"];

/**
 * Strip an Arabic definite article / attached one-letter particle so "حفظ"
 * matches "الحفظ", "والحفظ", "بالحفظ", "للحفظ". Conservative: the remainder must
 * stay at least 2 letters after a multi-letter proclitic, and a one-letter
 * proclitic (often a real root letter: كتاب is not ك + تاب) is stripped only
 * from words of 5+ letters.
 */
function stripProclitic(token: string): string {
  if (!ARABIC_LETTER.test(token)) return token;
  for (const p of MULTI_PROCLITICS) {
    if (token.startsWith(p) && token.length - p.length >= 2) return token.slice(p.length);
  }
  if (token.length >= 5) {
    for (const p of SINGLE_PROCLITICS) {
      if (token.startsWith(p)) return token.slice(p.length);
    }
  }
  return token;
}

// A bare definite article is not a search term; it would prefix-match every
// word that kept its ال (too short to strip).
const BARE_ARTICLE = "ال";

export function tokenize(s: string): string[] {
  return (normalizeText(s).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && t !== BARE_ARTICLE)
    .map(stripProclitic);
}

/** Article body as prose: link/image targets and #help: references removed. */
function proseOf(body: string): string {
  return body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/#help:[\w-]+/g, "");
}

const TITLE_WEIGHT = 10;
const KEYWORD_WEIGHT = 6;
const HEADING_WEIGHT = 4;
const BODY_CAP = 5;

function hasPrefixMatch(words: string[], token: string): boolean {
  return words.some((w) => w.startsWith(token));
}

function stripMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSnippet(body: string, tokens: string[]): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = stripMarkdown(raw);
    if (!line || /^[|:\-\s]+$/.test(line)) continue;
    // A line can hold several sentences; prefer the first one with a hit.
    const sentences = line.split(/(?<=[.!?؟۔])\s+/);
    for (const sentence of sentences) {
      const words = tokenize(sentence);
      if (tokens.some((t) => hasPrefixMatch(words, t))) {
        return sentence.length > 160 ? sentence.slice(0, 159).trimEnd() + "…" : sentence;
      }
    }
  }
  return "";
}

export function searchHelp(articles: HelpArticle[], query: string, limit = 8): HelpHit[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  const hits: (HelpHit & { order: number })[] = [];
  articles.forEach((article, order) => {
    const titleWords = tokenize(article.title);
    const keywordWords = article.keywords.flatMap(tokenize);
    const headingWords = article.headings.flatMap(tokenize);
    const bodyWords = tokenize(proseOf(article.body));
    let score = 0;
    for (const t of tokens) {
      if (hasPrefixMatch(titleWords, t)) score += TITLE_WEIGHT;
      if (hasPrefixMatch(keywordWords, t)) score += KEYWORD_WEIGHT;
      if (hasPrefixMatch(headingWords, t)) score += HEADING_WEIGHT;
      let n = 0;
      for (const w of bodyWords) if (w.startsWith(t)) n++;
      score += Math.min(n, BODY_CAP);
    }
    if (score > 0) hits.push({ article, score, snippet: makeSnippet(article.body, tokens), order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ order: _o, ...h }) => h);
}
