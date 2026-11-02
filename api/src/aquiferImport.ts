// Pull a book's translationNotes from Aquifer and MERGE them into the existing
// ar_tn as unapproved drafts, on the current unfoldingWord/en_tn skeleton.
//
//   POST /api/books/:book/aquifer-drafts        (admin only)
//
// Merge-and-preserve (NOT wipe-and-rebuild):
//  - Existing ar_tn notes already in the TARGET language are APPROVED content:
//    they are marked translation_state='validated' and NEVER overwritten.
//  - English-placeholder rows and prior Aquifer/AI drafts are replaceable: an
//    Aquifer note for the same (reference, quote) replaces them.
//  - Aquifer notes that join to an en_tn row inherit its sticky id / quote /
//    occurrence / SupportReference (alignment works). Notes with NO en_tn match
//    are still imported (minted id, Aquifer's own extracted quote, flagged).
//  - Dedup matches by en_tn id, else by (reference, NFC quote, occurrence)
//    (aquiferMerge.ts): Aquifer never lands a duplicate where an approved note
//    already covers that note.
//
// Provenance is distinct (edit_log source='aquifer', draft_meta_json.source=
// 'aquifer') so drafts read as "Aquifer draft", never AI. The book is stamped
// tn_source='aquifer:<lang>' so the nightly DCS reimport skips tn for it.

import type { Context } from "hono";
import type { Env } from "./index";
import { currentUserId } from "./auth";
import { BOOK_NUMBERS, dcsRawUrl, fetchText, resolveSourceRef } from "./dcsSources";
import { getProjectConfig } from "./projectConfig.ts";
import { makeVerseSortOrder, parseTsv, refParts } from "./importParsers";
import { aquiferJsonUrl, aquiferLangFor } from "./aquiferSources.ts";
import { convertAquiferBook, nfc, type EnRow } from "./aquiferConvert.ts";
import { loadEnglishLinks } from "./aquiferLinks.ts";
import { parseChapterScope, chapterInScope } from "./aquiferScope.ts";
import { planAquiferMerge } from "./aquiferMerge.ts";

export const AQUIFER_SOURCE = "aquifer"; // edit_log.source tag (keeps the AI chip off)
const CHUNK = 40;

// Target-language script detector. A non-Latin target lets us tell a genuine
// translation from an English placeholder by script alone (the Arabic pilot).
// Latin-script GLs return null → caller falls back to "differs from en note".
function targetScriptRegex(languageCode: string): RegExp | null {
  const base = languageCode.split("-")[0];
  const byBase: Record<string, RegExp> = {
    ar: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/,
    fa: /[؀-ۿ]/,
    ur: /[؀-ۿ]/,
    hi: /[ऀ-ॿ]/,
    ne: /[ऀ-ॿ]/,
    mr: /[ऀ-ॿ]/,
    bn: /[ঀ-৿]/,
    ta: /[஀-௿]/,
    zh: /[一-鿿]/,
    ru: /[Ѐ-ӿ]/,
    th: /[฀-๿]/,
  };
  return byBase[base] ?? null;
}

function isTranslatedNote(note: string | null, languageCode: string, enNote: string | undefined): boolean {
  const n = (note ?? "").trim();
  if (!n) return false;
  const re = targetScriptRegex(languageCode);
  if (re) return re.test(n);
  return nfc(n) !== nfc(enNote ?? "");
}

const ALPHA = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = ALPHA + "0123456789";
// Exported for reuse by the per-chapter-range Aquifer import path (bookImport.ts):
// mint a 4-char sticky id (letter + 3 alnum) not already in `live`, mutating the
// set. pickId keeps a preferred (inherited en_tn) id when free, else mints.
export function mintId(live: Set<string>): string {
  for (let tries = 0; tries < 100; tries++) {
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    let id = ALPHA[buf[0] % 26];
    for (let i = 1; i < 4; i++) id += ALNUM[buf[i] % 36];
    if (!live.has(id)) { live.add(id); return id; }
  }
  throw new Error("could not mint a free tn id");
}
export function pickId(preferred: string | null, live: Set<string>): string {
  if (preferred && !live.has(preferred)) { live.add(preferred); return preferred; }
  return mintId(live);
}

export async function aquiferDrafts(c: Context<{ Bindings: Env; Variables: { userId?: number } }>) {
  const env = c.env;
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const book = (c.req.param("book") ?? "").toUpperCase();
  if (!BOOK_NUMBERS[book]) return c.json({ error: "unknown_book", book }, 400);

  // Optional chapter scope (issue #310): `?chapters=9,12` (or `9-12`, or a mix)
  // pulls only those chapters and leaves the rest of the book — its rows AND its
  // whole-book provenance stamp — untouched. `null` = no scope given = whole
  // book, i.e. every existing caller is unaffected.
  const scope = parseChapterScope(c.req.query("chapters"));

  const cfg = await getProjectConfig(env);
  if (!cfg.translationSource) {
    return c.json({ error: "not_a_translation_project", detail: "the English root project cannot pull drafts" }, 400);
  }
  const aqLang = aquiferLangFor(cfg.languageCode);
  if (!aqLang) return c.json({ error: "aquifer_language_unavailable", languageCode: cfg.languageCode }, 400);

  const imported = await env.DB.prepare(`SELECT 1 FROM book_imports WHERE book = ?1`).bind(book).first();
  if (!imported) return c.json({ error: "book_not_imported", book, detail: "run POST /api/books/:book/import first" }, 409);

  const lock = await env.DB.prepare(
    `INSERT OR IGNORE INTO book_import_locks (book, started_at, started_by) VALUES (?1, ?2, ?3)`,
  ).bind(book, Math.floor(Date.now() / 1000), userId).run();
  if (!lock.meta.changes) return c.json({ error: "import_in_progress", book }, 409);

  try {
    const aqUrl = aquiferJsonUrl(aqLang, book);
    if (!aqUrl) return c.json({ error: "aquifer_book_unnumbered", book }, 400);
    const aqRaw = await fetchText(aqUrl);
    if (!aqRaw) return c.json({ error: "aquifer_book_not_available", book, aqLang }, 404);
    let aqItems: unknown;
    try {
      aqItems = JSON.parse(aqRaw);
    } catch {
      return c.json({ error: "aquifer_json_parse", book, aqLang }, 502);
    }
    if (!Array.isArray(aqItems)) return c.json({ error: "aquifer_json_shape", book }, 502);

    const src = cfg.translationSource;
    // translationSource.repos is PARTIAL and per-resource — a tN role left blank
    // in Setup has no upstream source, and it may point at a DIFFERENT org than
    // src.org. Resolve org+repo through the shared accessor. Report a missing
    // source DISTINCTLY rather than fetching `${org}/undefined/...` and
    // mislabeling it en_tn_fetch_failed (502): the Aquifer converter needs the
    // English tN to pair against, so a missing source is a configuration gap
    // (400), not a transient fetch failure.
    const tnSrc = resolveSourceRef(src, "tn");
    if (!tnSrc) {
      return c.json({ error: "no_source_configured", resource: "tn", book, org: src.org }, 400);
    }
    const enRaw = await fetchText(dcsRawUrl(env, tnSrc.org, tnSrc.repo, `tn_${book}.tsv`));
    if (!enRaw) return c.json({ error: "en_tn_fetch_failed", book, org: tnSrc.org, repo: tnSrc.repo }, 502);
    const enRows: EnRow[] = parseTsv(enRaw).rows.map((r) => ({
      Reference: r["Reference"] ?? "",
      ID: r["ID"] ?? "",
      Tags: r["Tags"] ?? "",
      SupportReference: r["SupportReference"] ?? "",
      Quote: r["Quote"] ?? "",
      Occurrence: r["Occurrence"] ?? "",
      Note: r["Note"] ?? "",
    })).filter((r) => r.ID);
    const enNoteById = new Map(enRows.map((r) => [r.ID, r.Note]));

    // Link-first join: each translated note's English counterpart (metadata.json).
    // Failing to read it is reported, not papered over with the quote-first join
    // it replaces, which picks the wrong en_tn row for ~16% of repeated-quote verses.
    let links;
    try {
      links = await loadEnglishLinks(aqLang, aqItems as Parameters<typeof loadEnglishLinks>[1]);
    } catch (e) {
      console.error("aquiferDrafts: english link fetch failed", { book, aqLang, error: e instanceof Error ? e.message : String(e) });
      return c.json({ error: "aquifer_metadata_fetch_failed", book, aqLang }, 502);
    }
    const { notes: allNotes, report } = convertAquiferBook(aqItems as Parameters<typeof convertAquiferBook>[0], enRows, links);
    // Restrict the merge to the requested chapters (no-op when scope is null).
    const notes = scope ? allNotes.filter((n) => chapterInScope(refParts(n.ref)[0], scope)) : allNotes;

    const existing = await env.DB.prepare(
      `SELECT id, ref_raw, quote, occurrence, note, translation_state FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL`,
    ).bind(book).all<{ id: string; ref_raw: string; quote: string | null; occurrence: number | null; note: string | null; translation_state: string | null }>();

    // Ids in use for this book INCLUDING soft-deleted rows: the PK is (book,id)
    // and a tombstoned row keeps its slot, so minting/pickId must avoid those ids
    // or the INSERT hits a primary-key constraint. (deleted_at-filtered `existing`
    // is only for classification.)
    const usedIds = new Set(
      ((await env.DB.prepare(`SELECT id FROM tn_rows WHERE book = ?1`).bind(book).all<{ id: string }>()).results ?? [])
        .map((r) => r.id),
    );

    // Which existing rows an Aquifer note covers or replaces is decided by the
    // pure planner (aquiferMerge.ts): by en_tn id first, falling back to
    // (ref, NFC quote, occurrence) only for notes with no live row under their id
    // (issue #584 — two rows can share a key). The script heuristic stays here,
    // passed in as a callback.
    const { approveIds, decisions } = planAquiferMerge(
      existing.results ?? [],
      notes,
      (row) => isTranslatedNote(row.note, cfg.languageCode, enNoteById.get(row.id)),
      (ref) => chapterInScope(refParts(ref)[0], scope),
    );

    const now = Math.floor(Date.now() / 1000);
    const nextSort = makeVerseSortOrder();
    const stmts: D1PreparedStatement[] = [];

    // 1. Approve existing target-language notes (state flip + publish snapshot).
    //
    // This is a BULK approve, not a per-row human review: the rows are approved
    // because a script decided they look like target-language text, not because
    // anyone read them. So they are stamped `admin_bulk_state` (migration 0071)
    // exactly like the admin bulk review-state sweep, and the few-shot selectors
    // in contextExport.ts exclude them from training gold (issue #393 — decided
    // "no, aquifer heuristic approval is not human-approved gold"). Without the
    // stamp these rows silently became validated.jsonl examples, which made the
    // "sweeps aren't gold" invariant narrower than contextExport.ts claims.
    // The guard is `translation_state IS NULL`, so COALESCE always yields
    // 'none' here — spelled out anyway to match the sweep's expression.
    for (const id of approveIds) {
      stmts.push(
        env.DB.prepare(
          `UPDATE tn_rows SET translation_state = 'validated',
             admin_bulk_state = COALESCE(translation_state, 'none'),
             pre_draft_json = json_object('note', note, 'tags', tags), updated_at = ?3
           WHERE book = ?1 AND id = ?2 AND translation_state IS NULL`,
        ).bind(book, id, now),
      );
    }

    // 2. Merge Aquifer notes.
    const insertStmt = env.DB.prepare(
      `INSERT INTO tn_rows
         (id, book, chapter, verse, ref_raw, tags, support_reference, quote, occurrence, note,
          version, updated_by, updated_at, sort_order, preserve,
          translation_state, draft_meta_json, pre_draft_json, review_kind, review_reason)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, 1,?11,?12,?13,1, 'ai_draft',?14,?15,?16,?17)`,
    );
    const auditStmt = env.DB.prepare(
      `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, payload_json, source)
       VALUES ('tn', ?1, ?2, ?3, NULL, 1, 'create', ?4, ?5)`,
    );
    const counts = { inserted: 0, replaced: 0, skippedApproved: 0 };

    for (const [i, note] of notes.entries()) {
      const decision = decisions[i];
      if (decision.action === "skip") { counts.skippedApproved++; continue; }

      const replacedId = decision.replaceId;
      if (replacedId) {
        stmts.push(env.DB.prepare(`DELETE FROM tn_rows WHERE book = ?1 AND id = ?2`).bind(book, replacedId));
        usedIds.delete(replacedId);
        counts.replaced++;
      }

      const id = pickId(note.enId, usedIds);
      const [ch, v] = refParts(note.ref);
      const draftMeta = JSON.stringify({
        source: AQUIFER_SOURCE, aqLang, aquiferContentId: note.aquiferContentId, joinMethod: note.joinMethod,
      });
      const preDraft = JSON.stringify({ note: "", tags: null });
      const reviewKind = note.reviewReason ? "aquifer_unverified" : null;
      stmts.push(
        insertStmt.bind(
          id, book, ch, v, note.ref,
          note.tags, note.supportReference, note.quote, note.occurrence, note.note,
          userId, now, nextSort(ch, v),
          draftMeta, preDraft, reviewKind, note.reviewReason,
        ),
        auditStmt.bind(id, book, userId, JSON.stringify({ ref: note.ref, source: AQUIFER_SOURCE }), AQUIFER_SOURCE),
      );
      counts.inserted++;
    }

    // 3. Mark tn provenance so the DCS reimport skips tn for this book.
    //
    // WHOLE-book pulls only. A chapter-scoped pull must NOT re-assert whole-book
    // Aquifer provenance: that would make the nightly DCS reimport skip tn for
    // chapters this run never touched, freezing them at their current state
    // instead of tracking upstream (issue #310). Scoped runs leave the existing
    // tn_source (whatever it was) unchanged.
    if (!scope) {
      stmts.push(
        env.DB.prepare(`UPDATE book_imports SET tn_source = ?2 WHERE book = ?1`).bind(book, `${AQUIFER_SOURCE}:${aqLang}`),
      );
    }

    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.DB.batch(stmts.slice(i, i + CHUNK));
    }

    return c.json({
      ok: true,
      book,
      aqLang,
      chapters: scope ? [...scope].sort((a, b) => a - b) : null,
      approved: approveIds.length,
      ...counts,
      report,
    });
  } finally {
    await env.DB.prepare(`DELETE FROM book_import_locks WHERE book = ?1`).bind(book).run();
  }
}
