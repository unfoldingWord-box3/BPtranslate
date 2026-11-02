import { Hono } from "hono";
import type { Env } from "./index";
import { sharedDb } from "./workspaces.ts";

// Alignment suggestions over the precomputed alignment-memory frequency table
// (align_freq, populated offline by scripts/train-aligner.mjs from the gold
// `\zaln-s` alignments in the published ULT/UST). The engine ("wordMAP") never
// runs in the Worker — at request time we do a single indexed D1 lookup and
// rank by corpus frequency, with a lexicon gloss/definition fallback for
// source Strong's the canonical corpus never aligned.
//
// Stateless + verse-agnostic on purpose: the client sends the unaligned source
// Strong's, gets ranked candidate target surfaces back, and does the
// word-bank intersection itself. That keeps unsaved edits client-side and lets
// the response cache by (bible, strongs).

export const align = new Hono<{ Bindings: Env }>();

// Same normalization as lexicon.ts / web normalizeStrong: pull the first
// [HG]\d+[a-z]? token (drops clitic prefixes like "b:" / "l:"), strip leading
// zeros, and offer the alpha-stripped base as a fallback key ("H2148a" ->
// ["H2148a","H2148"]).
function strongLookupKeys(raw: string): string[] {
  if (!raw) return [];
  const m = raw.match(/[HG]\d+[a-z]?/i);
  if (!m) return [];
  const exact = m[0].toUpperCase().replace(/^([HG])0+/, "$1");
  const base = exact.replace(/[A-Z]$/, "");
  return exact === base ? [exact] : [exact, base];
}

// Map a raw source Strong's token to candidate lexicon_entries keys.
// lexicon_entries is keyed by classic Strong's. unfoldingWord Greek (UGNT) is
// Strong's-Plus: classic × 10, zero-padded to 5 digits (G01910 = ἀκούω =
// classic G191, G23160 = θεός = classic G2316). Decide that from the RAW digit
// count, before zero-stripping: stripping G01910 first leaves "G1910", which is
// a different classic word (issue #529). Strong's-Plus maps only to its /10
// classic key. Hebrew and classic (≤4-digit) Greek use strongLookupKeys as-is.
export function lexiconLookupKeys(raw: string): string[] {
  const plus = raw?.match(/[HG]\d+[a-z]?/i)?.[0].match(/^G(\d{5,})[a-z]?$/i);
  if (plus) {
    const classic = Math.floor(parseInt(plus[1], 10) / 10);
    return classic > 0 ? [`G${classic}`] : [];
  }
  return strongLookupKeys(raw);
}

interface Candidate {
  surface: string;
  confidence: number; // 0..1
  source: "memory" | "lexicon";
  count?: number; // corpus frequency (memory only)
}

interface Phrase {
  phrase: string; // e.g. "the earth"
  tokens: string[]; // ["the","earth"]
  confidence: number; // 0..1, share among this strong's phrases
  count: number;
}

// Per-strong response: single-word candidates plus the multi-word gold phrases
// that strong aligns to. The client prefers a phrase when its tokens appear as
// a contiguous unaligned run in the verse, else falls back to the top word.
interface Suggestion {
  words: Candidate[];
  phrases: Phrase[];
}

// Function words that pollute lexicon-definition tokenization. The frequency
// (memory) path doesn't need this — it learns that, say, the article maps to
// "the" with high confidence — but raw definition prose is full of glue words.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "in", "on", "at", "for", "with",
  "is", "are", "was", "were", "be", "been", "being", "that", "this", "these",
  "those", "it", "its", "as", "by", "from", "into", "out", "up", "down", "who",
  "whom", "which", "what", "when", "where", "while", "than", "then", "so", "such",
  "not", "no", "nor", "but", "if", "etc", "eg", "ie", "used", "use",
  // Structural labels that leak from the bundled Strong's definition prose
  // ("Meaning:", "Usage:", "Source:", part-of-speech words). They never match
  // real target text, but drop them so the fallback list stays clean.
  "meaning", "usage", "source", "speech", "aramaic", "hebrew", "greek",
  "transliteration", "corresponding", "compare", "figuratively", "literally",
  "properly", "primitive", "denominative",
]);

// Tokenize gloss (weighted higher) + definition into candidate surfaces. Words
// shorter than 3 chars and stopwords are dropped; first occurrence wins.
function lexiconCandidates(gloss: string | null, definition: string | null): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (text: string | null, conf: number) => {
    if (!text) return;
    for (const tokRaw of text.toLowerCase().split(/[^a-z']+/)) {
      const tok = tokRaw.replace(/^'+|'+$/g, "");
      if (tok.length < 3 || STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      out.push({ surface: tok, confidence: conf, source: "lexicon" });
    }
  };
  add(gloss, 0.3);
  add(definition, 0.18);
  return out.slice(0, 12);
}

const MAX_CANDIDATES = 8;
const MAX_PHRASES = 6;
const HAS_SPACE = /\s/; // phrase surfaces contain a space; single words don't
// Morph interpolation smoothing: conf = λ·P(s|strong,morph) + (1-λ)·P(s|strong),
// λ = n_sm/(n_sm+MORPH_K). Tuned on the held-out eval (insensitive over 2..5).
const MORPH_K = 5;
// D1 caps prepared statements at 100 bind variables. The memory query also
// binds `bible` at ?1, so keep strong chunks under that.
const STRONG_CHUNK = 90;
// Cap on the `keys`/`strongs` list. Unauthenticated route where each key fans
// out to D1 chunks (STRONG_CHUNK), so bound the per-request work. Alignment
// suggestions are requested per-verse (tens of keys), so 2000 never limits
// legitimate use; over it is a clean 400 rather than silent truncation.
export const MAX_ALIGN_KEYS = 2000;

// One requested suggestion target. The client sends `keys` = ";"-separated
// "rawStrong~morphClass" composites (morph class can contain commas for Greek,
// so ";" separates and the FIRST "~" splits). `strongs` (comma list) is still
// accepted as morph-less keys. Response is keyed back by the exact composite.
interface SuggestReq {
  key: string; // echoed back to the client
  mc: string; // morph class ("" = none)
  normKeys: string[]; // normalized Strong's lookup keys (align_freq)
  lexKeys: string[]; // lexicon_entries keys, from the raw token (Strong's-Plus aware)
}

align.get("/suggest", async (c) => {
  const bible = (c.req.query("bible") ?? "ult").toLowerCase();
  const keysParam = c.req.query("keys");
  const requestedRaw =
    keysParam !== undefined
      ? keysParam.split(";").map((s) => s.trim()).filter(Boolean)
      : (c.req.query("strongs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (requestedRaw.length === 0) return c.json({ bible, suggestions: {} });
  if (requestedRaw.length > MAX_ALIGN_KEYS) {
    return c.json({ error: "too_many_keys", max: MAX_ALIGN_KEYS, got: requestedRaw.length }, 400);
  }

  const reqs: SuggestReq[] = [];
  const allKeys = new Set<string>();
  for (const key of requestedRaw) {
    const t = key.indexOf("~");
    const rawStrong = t >= 0 ? key.slice(0, t) : key;
    const mc = t >= 0 ? key.slice(t + 1) : "";
    const normKeys = strongLookupKeys(rawStrong);
    if (normKeys.length === 0) continue;
    reqs.push({ key, mc, normKeys, lexKeys: lexiconLookupKeys(rawStrong) });
    for (const k of normKeys) allKeys.add(k);
  }
  const keys = [...allKeys];
  if (keys.length === 0) return c.json({ bible, suggestions: {} });

  // 1) Strong-only alignment memory: per strong, its target surfaces + counts.
  const memByKey = new Map<string, { surface: string; count: number }[]>();
  for (let i = 0; i < keys.length; i += STRONG_CHUNK) {
    const chunk = keys.slice(i, i + STRONG_CHUNK);
    const placeholders = chunk.map((_v, j) => `?${j + 2}`).join(",");
    const rs = await sharedDb(c.env).prepare(
      `SELECT strong, surface, count FROM align_freq WHERE bible = ?1 AND strong IN (${placeholders})`,
    )
      .bind(bible, ...chunk)
      .all<{ strong: string; surface: string; count: number }>();
    for (const row of rs.results ?? []) {
      const list = memByKey.get(row.strong) ?? [];
      list.push({ surface: row.surface, count: row.count });
      memByKey.set(row.strong, list);
    }
  }

  // 1b) Morph-conditioned memory (words only): strong -> morph_class ->
  // { total, per-surface }. Wrapped in try/catch so the endpoint degrades
  // cleanly to the strong-only blend if 0025 hasn't been applied yet.
  const morphByKey = new Map<string, Map<string, { total: number; bySurface: Map<string, number> }>>();
  try {
    for (let i = 0; i < keys.length; i += STRONG_CHUNK) {
      const chunk = keys.slice(i, i + STRONG_CHUNK);
      const placeholders = chunk.map((_v, j) => `?${j + 2}`).join(",");
      const rs = await sharedDb(c.env).prepare(
        `SELECT strong, morph_class, surface, count FROM align_freq_morph WHERE bible = ?1 AND strong IN (${placeholders})`,
      )
        .bind(bible, ...chunk)
        .all<{ strong: string; morph_class: string; surface: string; count: number }>();
      for (const row of rs.results ?? []) {
        let byMc = morphByKey.get(row.strong);
        if (!byMc) { byMc = new Map(); morphByKey.set(row.strong, byMc); }
        let cell = byMc.get(row.morph_class);
        if (!cell) { cell = { total: 0, bySurface: new Map() }; byMc.set(row.morph_class, cell); }
        cell.total += row.count;
        cell.bySurface.set(row.surface, (cell.bySurface.get(row.surface) ?? 0) + row.count);
      }
    }
  } catch {
    // align_freq_morph not present — fall back to strong-only ranking.
  }

  // 2) Lexicon fallback for requests the corpus never aligned, keyed by the
  // lexicon key itself (Greek Strong's-Plus -> classic, decided per raw token).
  const lexKeys = [
    ...new Set(reqs.filter((r) => !r.normKeys.some((k) => memByKey.has(k))).flatMap((r) => r.lexKeys)),
  ];
  const lexByKey = new Map<string, Candidate[]>();
  for (let i = 0; i < lexKeys.length; i += STRONG_CHUNK) {
    const chunk = lexKeys.slice(i, i + STRONG_CHUNK);
    if (chunk.length === 0) break;
    const placeholders = chunk.map((_v, j) => `?${j + 1}`).join(",");
    const rs = await sharedDb(c.env).prepare(
      `SELECT strong, gloss, definition FROM lexicon_entries WHERE strong IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<{ strong: string; gloss: string | null; definition: string | null }>();
    for (const row of rs.results ?? []) {
      if (lexByKey.has(row.strong)) continue;
      const cands = lexiconCandidates(row.gloss, row.definition);
      if (cands.length > 0) lexByKey.set(row.strong, cands);
    }
  }

  // 3) Build a Suggestion per requested composite. Words are morph-interpolated
  // (conf = λ·P(s|strong,morph) + (1-λ)·P(s|strong)); phrases stay strong-only.
  // First normalized key with memory wins, else lexicon.
  const suggestions: Record<string, Suggestion> = {};
  for (const req of reqs) {
    if (suggestions[req.key]) continue;
    const normKey = req.normKeys.find((k) => memByKey.has(k));
    if (normKey) {
      const mem = memByKey.get(normKey)!;
      const wordRows = mem.filter((m) => !HAS_SPACE.test(m.surface));
      const phraseRows = mem.filter((m) => HAS_SPACE.test(m.surface));
      const wordTotal = wordRows.reduce((a, b) => a + b.count, 0) || 1;
      const phraseTotal = phraseRows.reduce((a, b) => a + b.count, 0) || 1;
      const cell = morphByKey.get(normKey)?.get(req.mc);
      const nSM = cell?.total ?? 0;
      const lambda = nSM > 0 ? nSM / (nSM + MORPH_K) : 0;
      const words = wordRows
        .map((m): Candidate => {
          const pStrong = m.count / wordTotal;
          const confidence =
            lambda > 0
              ? lambda * ((cell!.bySurface.get(m.surface) ?? 0) / nSM) + (1 - lambda) * pStrong
              : pStrong;
          return { surface: m.surface, count: m.count, confidence, source: "memory" };
        })
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, MAX_CANDIDATES);
      const phrases = phraseRows
        .map((m): Phrase => ({
          phrase: m.surface,
          tokens: m.surface.split(/\s+/),
          confidence: m.count / phraseTotal,
          count: m.count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_PHRASES);
      if (words.length > 0 || phrases.length > 0) suggestions[req.key] = { words, phrases };
    } else {
      const lexKey = req.lexKeys.find((k) => lexByKey.has(k));
      if (lexKey) suggestions[req.key] = { words: lexByKey.get(lexKey)!.slice(0, MAX_CANDIDATES), phrases: [] };
    }
  }
  return c.json({ bible, suggestions });
});
