// Translated Aquifer note -> its English Aquifer note, from a language's
// metadata.json (`article_metadata[<content_id>].localizations.eng`).
//
// This is the join's primary key (see convertAquiferBook): the English note's
// title carries the verse and the (#N) ordinal that matches en_tn row order,
// which the translated title's own number does not (Hindi (#3) can be English
// (#4)), and the quote alone is ambiguous when a verse has two rows on the same
// words (~16% of en_tn verse rows).
//
// metadata.json is ~36 MB. Parsing it whole peaks above 130 MB of heap, over the
// 128 MB a Worker gets, so it is scanned as a stream and only the entries for the
// requested content ids are ever parsed.

import { aquiferMetadataUrl } from "./aquiferSources.ts";

export type EnglishLink = { engContentId: string; engTitle: string };

// "Titus 1:1 (#1)" / "Ruth 1:2-8 (#2)" -> en_tn Reference notation + ordinal.
// Chapter/book intro titles ("Titus - Introduction") have no ordinal -> null.
export function parseEnglishTitle(title: string | undefined): { ref: string; ordinal: number } | null {
  const m = /(\d+):(\d+)(?:\s*[-–]\s*(\d+))?\s*\(#\s*(\d+)\s*\)/.exec(title || "");
  if (!m) return null;
  const ref = m[3] ? `${m[1]}:${m[2]}-${m[3]}` : `${m[1]}:${m[2]}`;
  return { ref, ordinal: parseInt(m[4], 10) };
}

const ENTRY_ID = /"content_id"\s*:\s*"?(\d+)/;

// Incremental scanner for { ..., "article_metadata": { "<id>": {entry}, ... } }.
// Tracks only string/escape state and brace depth; an entry is the object at
// depth 3 while the top-level key is "article_metadata". Chunk boundaries may
// fall anywhere, including inside a string or an escape.
export class EnglishLinkScanner {
  readonly links = new Map<string, EnglishLink>();
  private depth = 0;
  private inStr = false;
  private esc = false;
  private keyBuf = "";
  private lastKey1 = "";
  private entry: string | null = null; // text of the entry being read
  private sawArticle = false;

  private readonly wanted: ReadonlySet<string>;

  constructor(wanted: ReadonlySet<string>) {
    this.wanted = wanted;
  }

  /** True once every wanted id has been found — the rest of the file can be skipped. */
  get done(): boolean {
    return this.links.size >= this.wanted.size;
  }

  /** True when the whole document was read and closed (guards a truncated fetch). */
  get complete(): boolean {
    return this.sawArticle && this.depth === 0 && !this.inStr;
  }

  push(chunk: string): void {
    let entryFrom = this.entry !== null ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) { this.esc = false; if (this.depth === 1) this.keyBuf += chunk[i]; continue; }
        if (c === 92) { this.esc = true; if (this.depth === 1) this.keyBuf += "\\"; continue; }
        if (c === 34) {
          this.inStr = false;
          if (this.depth === 1) this.lastKey1 = this.keyBuf;
          continue;
        }
        if (this.depth === 1) this.keyBuf += chunk[i];
        continue;
      }
      if (c === 34) { this.inStr = true; this.keyBuf = ""; continue; }
      if (c === 123) { // {
        this.depth++;
        if (this.depth === 2 && this.lastKey1 === "article_metadata") this.sawArticle = true;
        else if (this.depth === 3 && this.sawArticle && this.lastKey1 === "article_metadata") {
          this.entry = "";
          entryFrom = i;
        }
      } else if (c === 125) { // }
        if (this.depth === 3 && this.entry !== null) {
          this.finishEntry(this.entry + chunk.slice(entryFrom, i + 1));
          this.entry = null;
          entryFrom = -1;
        }
        this.depth--;
      }
    }
    if (this.entry !== null && entryFrom >= 0) this.entry += chunk.slice(entryFrom);
  }

  private finishEntry(text: string): void {
    const id = ENTRY_ID.exec(text)?.[1];
    if (!id || !this.wanted.has(id)) return;
    let parsed: { localizations?: { eng?: { content_id?: unknown; title?: unknown } } };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const eng = parsed.localizations?.eng;
    if (eng?.content_id == null || typeof eng.title !== "string") return;
    this.links.set(id, { engContentId: String(eng.content_id), engTitle: eng.title });
  }
}

export function scanEnglishLinks(chunks: Iterable<string>, wanted: ReadonlySet<string>): EnglishLinkScanner {
  const s = new EnglishLinkScanner(wanted);
  for (const chunk of chunks) s.push(chunk);
  return s;
}

/**
 * Stream metadata.json and return the English link for each wanted content id
 * that has one. Throws if the document does not arrive whole: a truncated read
 * would otherwise just look like "no links" and quietly fall back to the
 * quote-first join this exists to replace.
 */
export async function fetchEnglishLinks(
  url: string,
  wanted: ReadonlySet<string>,
): Promise<Map<string, EnglishLink>> {
  if (wanted.size === 0) return new Map();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder("utf-8");
      const scan = new EnglishLinkScanner(wanted);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        scan.push(dec.decode(value, { stream: true }));
        if (scan.done) { await reader.cancel(); return scan.links; }
      }
      scan.push(dec.decode());
      if (!scan.complete) throw new Error("metadata.json ended early (truncated fetch)");
      return scan.links;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`aquifer metadata fetch failed: ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/**
 * English links for every item of a book's Aquifer JSON, ready to pass to
 * convertAquiferBook. Throws when metadata.json cannot be read whole (callers
 * report that rather than importing with the weaker quote-first join).
 */
export async function loadEnglishLinks(
  aqLang: string,
  aqItems: ReadonlyArray<{ content_id?: string | number }>,
): Promise<Map<string, EnglishLink>> {
  const url = aquiferMetadataUrl(aqLang);
  if (!url) throw new Error(`no Aquifer metadata URL for language ${aqLang}`);
  const wanted = new Set<string>();
  for (const it of aqItems) if (it.content_id != null) wanted.add(String(it.content_id));
  return fetchEnglishLinks(url, wanted);
}
