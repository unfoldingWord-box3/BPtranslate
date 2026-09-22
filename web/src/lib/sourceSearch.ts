// Source-language search for the find overlay. Classifies the user's query
// (Strong's number / Hebrew lemma or consonants / Greek lemma or accent-
// insensitive / plain English) and matches \w tokens in UHB/UGNT verses.
// Plain-text offsets are computed by mirroring scripts/import-book.mjs:
// extractPlainText, so a token's [start, end) slice on a verse's plain_text
// matches the token's raw surface text.

import i18n from "../i18n";
import { normalizeStrong } from "../hooks/useLexicon";
import { nfc } from "./hebrew";
import { GREEK, HEBREW } from "./scriptDetect.ts";

// ---------- query classification ----------

export type SourceQueryKind =
  | { kind: "english" }
  | { kind: "strong"; keys: string[] }
  | { kind: "hebrew-lemma"; nfc: string }
  | { kind: "hebrew-consonants"; stripped: string }
  | { kind: "greek-lemma"; nfc: string }
  | { kind: "greek-accent-insensitive"; stripped: string };

const HEBREW_MARK = /[֑-ׇֽֿׁׂׅׄ]/;
const STRONG_RE = /^\s*([HhGg])?0*(\d{1,5})([a-z])?\s*$/;

// OT/NT classification lives in testament.ts (dependency-free so pure
// helpers can unit-test against it); re-exported here for existing importers.
import { isHebrewBook } from "./testament.ts";
export { isHebrewBook };

// True for bare-digit / zero-padded queries — the only case where the user
// needs to disambiguate "search as text" vs "search as Strong's". Anything
// with an H/G prefix is unambiguously Strong's already.
export function isBareNumberQuery(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  return /^\d{1,5}[a-z]?$/i.test(trimmed);
}

function stripHebrewMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

function stripGreekMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
}

// A string "has combining marks" if NFD is longer than NFC. Cheap, robust,
// and works for both Hebrew niqqud and Greek polytonic accents.
function hasCombiningMarks(s: string): boolean {
  return s.normalize("NFD").length !== s.normalize("NFC").length;
}

// Bare numbers are ambiguous — they could be Strong's or verse text ("the
// eighth month", "1:1"). Default is English; the overlay surfaces a toggle
// the user flips to interpret bare digits as Strong's. Explicit H/G prefix
// always wins, toggle or not.
export function classifySourceQuery(
  query: string,
  bookCode: string | null | undefined,
  bareDigitsAsStrong: boolean,
): SourceQueryKind {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "english" };

  // 1. Strong's (with or without H/G prefix, with or without zero-padding,
  //    with or without sense suffix like "a"/"b"). Bare digits opt in via
  //    the toggle so "5", "8", "1:1" don't hijack normal text search.
  const m = trimmed.match(STRONG_RE);
  if (m) {
    const prefix = m[1]?.toUpperCase();
    const num = m[2].replace(/^0+/, "") || "0";
    const suffix = (m[3] ?? "").toLowerCase();
    const base = `${num}${suffix}`;
    const withoutSuffix = num;
    if (prefix === "H" || prefix === "G") {
      const exact = `${prefix}${base}`;
      const stripped = `${prefix}${withoutSuffix}`;
      const keys = exact === stripped ? [exact] : [exact, stripped];
      return { kind: "strong", keys };
    }
    // Bare number: only interpret as Strong's when the user opted in.
    if (!bareDigitsAsStrong) return { kind: "english" };
    const p = isHebrewBook(bookCode) ? "H" : "G";
    const exact = `${p}${base}`;
    const stripped = `${p}${withoutSuffix}`;
    const keys = exact === stripped ? [exact] : [exact, stripped];
    return { kind: "strong", keys };
  }

  // 2. Hebrew text.
  if (HEBREW.test(trimmed)) {
    return HEBREW_MARK.test(trimmed) || hasCombiningMarks(trimmed)
      ? { kind: "hebrew-lemma", nfc: nfc(trimmed) }
      : { kind: "hebrew-consonants", stripped: stripHebrewMarks(trimmed) };
  }

  // 3. Greek text (basic + extended polytonic ranges).
  if (GREEK.test(trimmed)) {
    return hasCombiningMarks(trimmed)
      ? { kind: "greek-lemma", nfc: nfc(trimmed) }
      : { kind: "greek-accent-insensitive", stripped: stripGreekMarks(trimmed) };
  }

  return { kind: "english" };
}

// DISPLAY ONLY — rendered as the find overlay's helperText (FindReplaceOverlay).
// Nothing branches on the returned text; `q.kind` is the stable logic value.
// Translated per call (never cached at module load) so a UI-language switch
// repaints it. The Strong's number itself is interpolated, never translated.
export function describeSourceMode(q: SourceQueryKind): string {
  switch (q.kind) {
    case "english":
      return i18n.t("messages.sourceMode.text");
    case "strong":
      return i18n.t("messages.sourceMode.strong", { strong: q.keys[0] });
    case "hebrew-lemma":
      return i18n.t("messages.sourceMode.hebrewVowels");
    case "hebrew-consonants":
      return i18n.t("messages.sourceMode.hebrewConsonants");
    case "greek-lemma":
      return i18n.t("messages.sourceMode.greekAccents");
    case "greek-accent-insensitive":
      return i18n.t("messages.sourceMode.greekAccentInsensitive");
  }
}

// ---------- tokenization with plain_text offsets ----------

export interface TokenizedToken {
  text: string;
  occurrence: number;
  strong: string;
  lemma: string;
  start: number; // index into plain_text
  end: number;
}

interface RawLeaf {
  kind: "text" | "word";
  text: string;
  rawStart: number;
  rawEnd: number;
  strong: string;
  lemma: string;
}

// Walk verseObjects, emit every text/word leaf with its raw offset. Then
// build a raw→normalized index map applying the same `\s+ → ' '` + trim
// that scripts/import-book.mjs:extractPlainText uses, so token offsets map
// onto the same plain_text we stored in the DB.
export function tokenizeWithOffsets(verseObjects: unknown[]): TokenizedToken[] {
  const rawLeaves: RawLeaf[] = [];
  let rawPos = 0;
  const walk = (nodes: unknown[]) => {
    for (const n of nodes ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      const text = typeof o["text"] === "string" ? (o["text"] as string) : "";
      if (text) {
        rawLeaves.push({
          kind: o["type"] === "word" && o["tag"] === "w" ? "word" : "text",
          text,
          rawStart: rawPos,
          rawEnd: rawPos + text.length,
          strong: String(o["strong"] ?? ""),
          lemma: String(o["lemma"] ?? ""),
        });
        rawPos += text.length;
      }
      const children = o["children"];
      if (Array.isArray(children)) walk(children);
    }
  };
  walk(verseObjects);

  const raw = rawLeaves.map((l) => l.text).join("");
  // rawToNorm[i] = normalized index of raw character i (after \s+→' ' collapse).
  // The trim is applied afterwards by clamping to finalNorm.
  const rawToNorm = new Int32Array(raw.length + 1);
  let normLen = 0;
  let prevWasSpace = true; // collapse leading whitespace
  for (let i = 0; i < raw.length; i++) {
    rawToNorm[i] = normLen;
    const isSpace = /\s/.test(raw[i]);
    if (isSpace) {
      if (!prevWasSpace) {
        normLen++;
        prevWasSpace = true;
      }
    } else {
      normLen++;
      prevWasSpace = false;
    }
  }
  rawToNorm[raw.length] = normLen;
  const finalNorm = raw.replace(/\s+/g, " ").trim().length;

  const occByText = new Map<string, number>();
  const out: TokenizedToken[] = [];
  for (const l of rawLeaves) {
    if (l.kind !== "word") continue;
    const occ = (occByText.get(l.text) ?? 0) + 1;
    occByText.set(l.text, occ);
    const start = Math.min(rawToNorm[l.rawStart], finalNorm);
    const end = Math.min(rawToNorm[l.rawEnd], finalNorm);
    out.push({
      text: l.text,
      occurrence: occ,
      strong: l.strong,
      lemma: l.lemma,
      start,
      end,
    });
  }
  return out;
}

// ---------- per-verse matcher ----------

export interface SourceTokenMatch {
  text: string;
  occurrence: number;
  start: number;
  end: number;
}

export function matchSourceVerse(
  verseObjects: unknown[],
  q: Exclude<SourceQueryKind, { kind: "english" }>,
): SourceTokenMatch[] {
  const tokens = tokenizeWithOffsets(verseObjects);
  const out: SourceTokenMatch[] = [];
  for (const t of tokens) {
    let hit = false;
    if (q.kind === "strong") {
      const keys = normalizeStrong(t.strong);
      for (const k of keys) {
        if (q.keys.includes(k)) {
          hit = true;
          break;
        }
      }
    } else if (q.kind === "hebrew-lemma" || q.kind === "greek-lemma") {
      const needle = q.nfc;
      hit = nfc(t.lemma).includes(needle) || nfc(t.text).includes(needle);
    } else if (q.kind === "hebrew-consonants") {
      const needle = q.stripped;
      hit =
        stripHebrewMarks(t.lemma).includes(needle) ||
        stripHebrewMarks(t.text).includes(needle);
    } else if (q.kind === "greek-accent-insensitive") {
      const needle = q.stripped;
      hit =
        stripGreekMarks(t.lemma).includes(needle) ||
        stripGreekMarks(t.text).includes(needle);
    }
    if (hit) {
      out.push({ text: t.text, occurrence: t.occurrence, start: t.start, end: t.end });
    }
  }
  return out;
}

// ---------- offset-based renderer (for UGNT contentEditable cells) ----------

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

export function renderFindMatchesByOffsets(
  plainText: string,
  ranges: Array<{ start: number; end: number }>,
  activeRange?: { start: number; end: number } | null,
): string {
  if (ranges.length === 0) return escapeHtml(plainText);
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const r of sorted) {
    if (r.start < pos) continue; // overlap — skip
    if (r.end <= r.start) continue;
    const isActive = !!activeRange && r.start === activeRange.start && r.end === activeRange.end;
    const cls = isActive ? "be-find be-find-active" : "be-find";
    html += escapeHtml(plainText.slice(pos, r.start));
    html += `<mark class="${cls}">${escapeHtml(plainText.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  html += escapeHtml(plainText.slice(pos));
  return html;
}
