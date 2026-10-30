// Pure converter: Aquifer translationNotes JSON -> resolved notes to merge onto
// the unfoldingWord/en_tn skeleton. Split out (like translateOptions.ts) so it
// runs under the node strip-types test runner without importing the Hono modules.
//
// LANGUAGE-AGNOSTIC. Every Aquifer language edition shares the same schema, the
// same per-verse ordinal (#N), and the same embedded original-language quote
// (Greek/Hebrew). Only the note prose differs. So one converter serves all.
//
// Join strategy: LINK-PRIMARY, quote second, ordinal last, and unmatched notes
// still returned (minted downstream) so nothing is silently dropped.
//  - Aquifer links every translated note to its English note (metadata.json,
//    see aquiferLinks.ts). The English title's (#N) numbers the en_tn rows at that
//    reference, so link -> N-th en_tn row is exact. The translated title's own
//    (#N) is NOT: Hindi (#3) can be English (#4).
//  - Quote-first alone picks the wrong row when a verse has two rows on the same
//    words (~16% of en_tn verse rows, e.g. PHM 1:1 figs-metaphor + figs-exclusive
//    on ὁ ἀδελφὸς): the note then inherits the wrong id and SupportReference with
//    no flag. Measured against the tA link inside each note, where the two joins
//    disagreed the link join was right 692 times and quote-first 10.
//  - A linked match whose quote differs from the en_tn row's is flagged.
//  - Notes with no English link (or whose link points past the en_tn rows) fall
//    back to the quote match, then the ordinal.
//  - Hebrew-OT quotes often quote a different/longer span than en_tn, so those
//    fall to the ordinal fallback and are flagged for human review.

import { parseEnglishTitle } from "./aquiferLinks.ts";

export type AquiferItem = {
  content_id?: string | number;
  title?: string;
  index_reference?: string;
  content?: string;
  associations?: { passage?: Array<{ start_ref_usfm?: string; end_ref_usfm?: string }> };
};

// One en_tn TSV row (canonical header: Reference/ID/Tags/SupportReference/Quote/Occurrence/Note).
export type EnRow = {
  Reference: string;
  ID: string;
  Tags: string;
  SupportReference: string;
  Quote: string;
  Occurrence: string;
  Note: string;
};

export type JoinMethod = "link" | "quote" | "ordinal" | "intro" | "unmatched" | null;

// One resolved Aquifer note. Matched notes carry the en_tn row's sticky id and
// structural columns (alignment works); unmatched notes have enId=null (the
// importer mints an id) and carry Aquifer's own extracted quote.
export type ResolvedNote = {
  ref: string;
  enId: string | null;
  quote: string | null;
  occurrence: number | null;
  supportReference: string | null;
  tags: string | null;
  note: string; // translated markdown
  joinMethod: JoinMethod;
  reviewReason: string | null; // non-null -> flag (review_kind/review_reason)
  aquiferContentId: string | null;
};

export type ConvertReport = {
  enRows: number;
  aqItems: number;
  matchedLink: number;
  matchedQuote: number;
  matchedOrdinal: number;
  matchedIntro: number;
  unmatched: number;
  flagged: number;
};

// ---------- small pure helpers (exported for unit tests) ----------

// A translated note's English counterpart, keyed by the translated note's
// content_id (aquiferLinks.ts reads these out of metadata.json).
export type EnglishLinkMap = ReadonlyMap<string, { engContentId: string; engTitle: string }>;

export const nfc = (s: string | null | undefined): string =>
  (s || "").normalize("NFC").trim();

const DIGIT_MAP: Record<string, string> = {};
for (let i = 0; i < 10; i++) {
  DIGIT_MAP[String.fromCharCode(0x0660 + i)] = String(i); // Arabic-indic ٠-٩
  DIGIT_MAP[String.fromCharCode(0x0966 + i)] = String(i); // Devanagari ०-९
}
const normDigits = (s: string): string =>
  s.replace(/[٠-٩०-९]/g, (d) => DIGIT_MAP[d] ?? d);

// The (#N) marker's `#` precedes the digits in most books but FOLLOWS them in
// some (an RTL rendering flip, e.g. arb Titus "(1#)"). Match either order.
export function ordinalOf(title: string | undefined): number | null {
  const m = /#\s*([0-9٠-٩०-९]+)|([0-9٠-٩०-९]+)\s*#/.exec(title || "");
  if (!m) return null;
  const n = parseInt(normDigits(m[1] ?? m[2] ?? ""), 10);
  return Number.isFinite(n) ? n : null;
}

// The embedded original-language quote: the first span forced to a text
// direction (ltr=Greek, rtl=Hebrew) inside the note HTML.
export function embeddedQuote(html: string | undefined): string {
  const m = /direction:\s*(?:ltr|rtl)[^>]*>([\s\S]*?)<\/span>/.exec(html || "");
  return m ? nfc(m[1].replace(/<[^>]+>/g, "")) : "";
}

// Reference of an Aquifer item, in en_tn Reference notation.
//  - book intro (index BB000000)      -> "front:intro"
//  - chapter intro (letters in index) -> "<ch>:intro"   (passage is "BOOK ch:1")
//  - verse / range                    -> "ch:v" or "ch:v-v2"
export function aquiferRef(it: AquiferItem): { ref: string; isIntro: boolean } | null {
  const idx = it.index_reference || "";
  const passage = it.associations?.passage?.[0];
  const startUsfm = passage?.start_ref_usfm || "";
  const endUsfm = passage?.end_ref_usfm || "";
  // The v2026-10-14 release carries stray items from other books under index
  // "00000000" (hin GEN has 1,224 First Corinthians notes). No book is 00, so
  // they belong to no import here; without this they would match the book-intro
  // test below and be minted into the book's front matter.
  if (idx === "00000000") return null;
  if (/^\d{2}000000$/.test(idx)) return { ref: "front:intro", isIntro: true };
  const start = startUsfm.includes(" ") ? startUsfm.split(" ", 2)[1] : "";
  // Chapter intros carry a NON-NUMERIC index (e.g. "08Ruth000"); a verse RANGE
  // index is digits + hyphen ("64001006-64001007") and is NOT an intro.
  if (/[A-Za-z]/.test(idx)) {
    const ch = start.split(":")[0];
    return ch ? { ref: `${ch}:intro`, isIntro: true } : null;
  }
  if (!start) return null;
  const end = endUsfm.includes(" ") ? endUsfm.split(" ", 2)[1] : "";
  if (end && end !== start) {
    const [sc, sv] = start.split(":");
    const [ec, ev] = end.split(":");
    return { ref: sc === ec ? `${sc}:${sv}-${ev}` : start, isIntro: false };
  }
  return { ref: start, isIntro: false };
}

// ---------- HTML -> markdown for the note body ----------

const decodeEntities = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// Convert one Aquifer note's HTML to uW-style markdown.
//  - Verse notes: drop the leading original-language quote paragraph (that lives
//    in the inherited Quote column) and the trailing "(See: <TA>)" paragraph(s)
//    (that lives in the inherited SupportReference column); keep the prose.
//  - Intros: keep the full structure (headings/lists); they have no quote column.
export function htmlToMarkdown(html: string, opts?: { isIntro?: boolean }): string {
  let s = html || "";
  const isIntro = opts?.isIntro ?? false;

  if (!isIntro) {
    s = s.replace(/^\s*<p>\s*(?:<strong>)?\s*<span[^>]*direction:\s*(?:ltr|rtl)[\s\S]*?<\/span>\s*(?:<\/strong>)?\s*<\/p>/i, "");
    // Strip trailing "(See: <TA>)" paragraph(s). Tempered `(?!</p>)` keeps each
    // match inside one <p>…</p>, so a See-line with several TA links (or other
    // inline tags) is still removed whole instead of leaking into the prose.
    let prev: string;
    do {
      prev = s;
      s = s.replace(/<p>(?:(?!<\/p>)[\s\S])*?data-bnType="resourceReference"(?:(?!<\/p>)[\s\S])*?<\/p>\s*$/i, "");
    } while (s !== prev);
  }

  // Aquifer's editor splits one emphasised phrase across several inline runs and
  // wraps them in decorative <span>s — e.g.
  //   <strong>&quot;</strong><span><strong>word</strong></span><strong>&quot;</strong>
  // and pads with emphasised whitespace (<strong> </strong>). Converting each run
  // on its own emitted `**"****word****"**` and dropped the padding space, gluing
  // the neighbouring words together (arb MRK 3:1, note 197002). Normalise first,
  // so one phrase becomes one pair of markers.
  s = unwrapSpans(s);
  s = normalizeEmphasis(s);

  s = s
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${strip(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${strip(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${strip(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${strip(t)}\n`)
    .replace(/<\/(?:ol|ul)>/gi, "\n")
    .replace(/<(?:ol|ul)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "");

  s = inline(s);
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Drop <span> wrappers (styling only — the direction spans are read off the raw
// HTML by embeddedQuote and by the quote-paragraph strip, both of which run
// earlier) so adjacent emphasis runs become literally adjacent and can merge.
function unwrapSpans(s: string): string {
  return s.replace(/<\/?span\b[^>]*>/gi, "");
}

// Collapse emphasis that wraps only whitespace back to that whitespace, then
// merge same-kind runs separated by nothing but whitespace.
//
// Every open-tag pattern here needs `\b` after the name: without it `b` also
// matches `<br>` (and `i` matches `<img>`), so a line break between two bold
// runs would be swallowed into the merge — the same word-gluing bug this file
// exists to fix, one tag over. An EMPTY tag collapses to nothing, not to a
// space: `foo<strong></strong>bar` is one word in the source and must stay one.
function normalizeEmphasis(s: string): string {
  let prev: string;
  do {
    prev = s;
    s = s
      .replace(/<(strong|b|em|i)\b[^>]*>((?:\s|&nbsp;)*)<\/\1>/gi, (_m, _tag, ws) =>
        String(ws).replace(/&nbsp;/gi, " "))
      .replace(/<\/(?:strong|b)>(\s*)<(?:strong|b)\b[^>]*>/gi, (_m, gap) => gap)
      .replace(/<\/(?:em|i)>(\s*)<(?:em|i)\b[^>]*>/gi, (_m, gap) => gap);
  } while (s !== prev);
  return s;
}

// Markers must hug the text — markdown ignores `** word **` — and the padding
// whitespace has to survive outside them or neighbouring words run together.
function emphasize(marker: string, inner: string): string {
  const text = strip(inner);
  if (!text) return /\s/.test(inner) ? " " : "";
  const lead = /^\s/.test(inner) ? " " : "";
  const trail = /\s$/.test(inner) ? " " : "";
  return `${lead}${marker}${text}${marker}${trail}`;
}

function inline(s: string): string {
  return s
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, t) => emphasize("**", t))
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, t) => emphasize("*", t));
}
function strip(s: string): string {
  return decodeEntities(inline(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// ---------- the join ----------

const FLAG_LINK_QUOTE = "Aquifer note matched to its English note, but its quote or reference differs from the en_tn row's — check against the English source";
const FLAG_ORDINAL = "Aquifer note matched by position (quote unverified) — check against the English source";
const FLAG_UNMATCHED = "Aquifer note has no matching English source note — quote/support unverified";

// Resolve every Aquifer note to its best en_tn target. Link-primary, then quote,
// then ordinal; unmatched notes are still returned (with their extracted quote)
// so the importer can mint rows for them. Emits one ResolvedNote per Aquifer
// item. `links` is optional: without it every note takes the quote/ordinal path.
export function convertAquiferBook(
  aqItems: AquiferItem[],
  enRows: EnRow[],
  links?: EnglishLinkMap,
): { notes: ResolvedNote[]; report: ConvertReport } {
  const enByRef = new Map<string, EnRow[]>();
  for (const r of enRows) {
    if (!enByRef.has(r.Reference)) enByRef.set(r.Reference, []);
    enByRef.get(r.Reference)!.push(r);
  }

  type AqNote = {
    ref: string; isIntro: boolean; ord: number | null; quote: string; html: string; contentId: string | null;
    // Where the English note says this one sits: its reference and (#N) slot.
    link: { ref: string; ordinal: number } | null;
  };
  const aqByRef = new Map<string, AqNote[]>();
  let aqCount = 0;
  for (const it of aqItems) {
    const rr = aquiferRef(it);
    if (!rr) continue;
    aqCount++;
    const note: AqNote = {
      ref: rr.ref,
      isIntro: rr.isIntro,
      ord: ordinalOf(it.title),
      quote: embeddedQuote(it.content),
      html: it.content || "",
      contentId: it.content_id != null ? String(it.content_id) : null,
      link: null,
    };
    if (note.contentId && !rr.isIntro) {
      const l = links?.get(note.contentId);
      if (l) note.link = parseEnglishTitle(l.engTitle);
    }
    if (!aqByRef.has(rr.ref)) aqByRef.set(rr.ref, []);
    aqByRef.get(rr.ref)!.push(note);
  }

  const report: ConvertReport = {
    enRows: enRows.length, aqItems: aqCount,
    matchedLink: 0, matchedQuote: 0, matchedOrdinal: 0, matchedIntro: 0, unmatched: 0, flagged: 0,
  };
  const notes: ResolvedNote[] = [];

  const fromEn = (aq: AqNote, en: EnRow, method: JoinMethod, reviewReason: string | null): ResolvedNote => ({
    ref: aq.ref,
    enId: en.ID,
    quote: en.Quote || null,
    occurrence: en.Occurrence === "" || en.Occurrence == null ? null : parseInt(en.Occurrence, 10) || 0,
    supportReference: en.SupportReference || null,
    tags: en.Tags || null,
    note: htmlToMarkdown(aq.html, { isIntro: aq.isIntro }),
    joinMethod: method,
    reviewReason,
    aquiferContentId: aq.contentId,
  });
  const minted = (aq: AqNote): ResolvedNote => ({
    ref: aq.ref,
    enId: null,
    quote: aq.quote || null,
    occurrence: aq.quote ? 1 : null,
    supportReference: null,
    tags: null,
    note: htmlToMarkdown(aq.html, { isIntro: aq.isIntro }),
    joinMethod: "unmatched",
    reviewReason: FLAG_UNMATCHED,
    aquiferContentId: aq.contentId,
  });

  // en_tn rows already taken, per reference. Shared across the link pass (which
  // can land on another reference than the note's own) and the per-reference
  // quote/ordinal passes below.
  const claimedByRef = new Map<string, boolean[]>();
  const claimedFor = (ref: string): boolean[] => {
    let c = claimedByRef.get(ref);
    if (!c) { c = new Array((enByRef.get(ref) || []).length).fill(false); claimedByRef.set(ref, c); }
    return c;
  };

  // Pass 0 — English link: the N-th en_tn row at the English note's reference.
  // Runs over the whole book first so a linked note claims its row before any
  // quote match could take it. A link that points past the en_tn rows, or at a
  // row another note already holds, leaves the note for the passes below.
  const linked = new Map<AqNote, ResolvedNote>();
  for (const aqList of aqByRef.values()) {
    for (const aq of aqList) {
      if (!aq.link) continue;
      const enList = enByRef.get(aq.link.ref) || [];
      const claimed = claimedFor(aq.link.ref);
      const j = aq.link.ordinal - 1;
      if (j < 0 || j >= enList.length || claimed[j]) continue;
      const quoteOk = nfc(enList[j].Quote) === aq.quote;
      // The pinned Aquifer release can lag the live en_tn (a note added or removed
      // since), so the N-th row may no longer be the one Aquifer meant. If this
      // row's quote disagrees but another free row at the reference has exactly
      // this note's quote, leave the note to the quote pass rather than flag it
      // onto the wrong row.
      if (!quoteOk && aq.quote && enList.some((r, k) => !claimed[k] && nfc(r.Quote) === aq.quote)) continue;
      claimed[j] = true;
      const clean = quoteOk && aq.link.ref === aq.ref;
      linked.set(aq, fromEn(aq, enList[j], "link", clean ? null : FLAG_LINK_QUOTE));
      report.matchedLink++;
      if (!clean) report.flagged++;
    }
  }

  for (const [ref, aqList] of aqByRef) {
    const enList = enByRef.get(ref) || [];
    const claimed = claimedFor(ref);
    const pending: AqNote[] = [];

    for (const aq of aqList) {
      const hit = linked.get(aq);
      if (hit) notes.push(hit);
    }

    // Pass 1 — quote match, for notes the link did not place.
    for (const aq of aqList) {
      if (linked.has(aq)) continue;
      if (aq.isIntro || !aq.quote) { pending.push(aq); continue; }
      let hit = -1;
      for (let j = 0; j < enList.length; j++) {
        if (!claimed[j] && nfc(enList[j].Quote) === aq.quote) { hit = j; break; }
      }
      if (hit >= 0) {
        claimed[hit] = true;
        notes.push(fromEn(aq, enList[hit], "quote", null));
        report.matchedQuote++;
      } else pending.push(aq);
    }

    // Pass 2 — fallback: the note's own ordinal slot, else the next unclaimed en
    // row. Intros are unflagged; positional verse matches are flagged. If no en
    // row remains, the note is unmatched (minted + flagged).
    for (const aq of pending) {
      let j = -1;
      if (aq.ord != null && aq.ord >= 1 && aq.ord <= enList.length && !claimed[aq.ord - 1]) j = aq.ord - 1;
      else j = claimed.indexOf(false);
      if (j < 0) {
        notes.push(minted(aq));
        report.unmatched++;
        report.flagged++;
        continue;
      }
      claimed[j] = true;
      if (aq.isIntro) {
        notes.push(fromEn(aq, enList[j], "intro", null));
        report.matchedIntro++;
      } else {
        notes.push(fromEn(aq, enList[j], "ordinal", FLAG_ORDINAL));
        report.matchedOrdinal++;
        report.flagged++;
      }
    }
  }

  return { notes, report };
}

// ---------- formatting repair of already-imported notes ----------

// Notes imported before the emphasis fix above carry stray `****` runs and words
// glued together by a swallowed space. Re-running the import repairs untouched
// drafts, but a row a translator has approved or edited is protected there and
// keeps the damage. This plans an in-place rewrite for exactly the rows whose
// text is still, word for word, the converter's own output.

export type StoredAquiferRow = {
  id: string;
  version: number;
  note: string | null;
  draftMetaJson: string | null;
  preDraftJson: string | null;
};

export type NoteRepair = {
  id: string;
  version: number;
  note: string; // corrected markdown
  before: string; // the damaged text, recorded in the audit row so this is reversible
  preDraftJson: string | null; // rewritten approval snapshot, or null to leave it
};

export type RepairReport = {
  aquiferRows: number;
  repaired: number;
  alreadyClean: number;
  // Text is neither the old nor the new machine render: a human changed it, or
  // Aquifer changed it upstream. Never rewritten — needs a person to look.
  humanEdited: number;
  noSource: number; // no Aquifer item for the stored content id
  otherLang: number; // imported from a different Aquifer language edition
};

// FROZEN. A byte-exact copy of htmlToMarkdown as it stood BEFORE the emphasis
// fix — the code that wrote the damaged text now sitting in D1. It exists for
// one purpose: proving that a stored note is still untouched machine output, by
// reproducing it exactly. Never "improve" it, and never call it from the import
// path. Delete it once no damaged rows remain.
//
// Exact equality is the proof, deliberately, rather than a looser
// same-words-ignoring-asterisks comparison: formatting is exactly what a
// translator may have changed on purpose (moving a bold, splitting a
// paragraph), and a loose comparison would silently revert that work. It also
// makes upstream drift safe — if Aquifer has since edited the note at all, the
// legacy render no longer matches and the row is left for a human.
export function legacyHtmlToMarkdown(html: string, opts?: { isIntro?: boolean }): string {
  let s = html || "";
  const isIntro = opts?.isIntro ?? false;
  const legacyInline = (x: string): string =>
    x
      .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, t) => `**${legacyStrip(t).trim()}**`)
      .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, t) => `*${legacyStrip(t).trim()}*`);
  function legacyStrip(x: string): string {
    return decodeEntities(legacyInline(x).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  }

  if (!isIntro) {
    s = s.replace(/^\s*<p>\s*(?:<strong>)?\s*<span[^>]*direction:\s*(?:ltr|rtl)[\s\S]*?<\/span>\s*(?:<\/strong>)?\s*<\/p>/i, "");
    let prev: string;
    do {
      prev = s;
      s = s.replace(/<p>(?:(?!<\/p>)[\s\S])*?data-bnType="resourceReference"(?:(?!<\/p>)[\s\S])*?<\/p>\s*$/i, "");
    } while (s !== prev);
  }

  s = s
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${legacyStrip(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${legacyStrip(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${legacyStrip(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${legacyStrip(t)}\n`)
    .replace(/<\/(?:ol|ul)>/gi, "\n")
    .replace(/<(?:ol|ul)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "");

  s = legacyInline(s);
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The approval snapshot holds its own copy of the damaged text for rows the
// import auto-approved, and a revert would restore it. Rewrite it under the same
// exact-match proof; leave anything else (including the empty snapshot the
// importer writes, and any non-string the column may hold) alone.
function repairPreDraft(preDraftJson: string | null, legacy: string, fresh: string): string | null {
  if (!preDraftJson) return null;
  let parsed: { note?: unknown } | null = null;
  try {
    parsed = JSON.parse(preDraftJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.note !== "string" || parsed.note !== legacy) return null;
  return JSON.stringify({ ...parsed, note: fresh });
}

export function planFormattingRepair(
  rows: StoredAquiferRow[],
  aqItems: AquiferItem[],
  aqLang?: string,
): { repairs: NoteRepair[]; report: RepairReport } {
  const byContentId = new Map<string, AquiferItem>();
  for (const it of aqItems) {
    const id = it.content_id == null ? "" : String(it.content_id);
    if (id) byContentId.set(id, it);
  }

  const repairs: NoteRepair[] = [];
  const report: RepairReport = {
    aquiferRows: 0, repaired: 0, alreadyClean: 0, humanEdited: 0, noSource: 0, otherLang: 0,
  };

  for (const row of rows) {
    let meta: { source?: string; aqLang?: string; aquiferContentId?: string | null } | null = null;
    try {
      meta = row.draftMetaJson ? JSON.parse(row.draftMetaJson) : null;
    } catch {
      meta = null;
    }
    if (!meta || meta.source !== "aquifer") continue;
    report.aquiferRows++;

    // A row imported from another Aquifer language edition would be compared
    // against the wrong text — it would fail the match and be miscounted as
    // human-edited. Count it honestly instead.
    if (aqLang && meta.aqLang && meta.aqLang !== aqLang) {
      report.otherLang++;
      continue;
    }

    const item = meta.aquiferContentId ? byContentId.get(String(meta.aquiferContentId)) : undefined;
    if (!item) {
      report.noSource++;
      continue;
    }

    const isIntro = aquiferRef(item)?.isIntro ?? false;
    const fresh = htmlToMarkdown(item.content || "", { isIntro });
    const stored = row.note ?? "";
    if (stored === fresh) {
      report.alreadyClean++;
      continue;
    }
    // The only rewritable case: the stored text is EXACTLY what the pre-fix
    // converter produced from this same source, so nothing human is in it.
    const legacy = legacyHtmlToMarkdown(item.content || "", { isIntro });
    if (stored !== legacy) {
      report.humanEdited++;
      continue;
    }

    repairs.push({
      id: row.id,
      version: row.version,
      note: fresh,
      before: stored,
      preDraftJson: repairPreDraft(row.preDraftJson, legacy, fresh),
    });
    report.repaired++;
  }

  return { repairs, report };
}
