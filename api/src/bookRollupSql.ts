// The two SQL statements behind GET /api/chapters/:book (the book summary).
//
// They live in their own dependency-free module for one reason: chapters.ts
// imports `./types` and `./index`, which node's type-stripping loader cannot
// resolve (extensionless specifiers), so a node:sqlite test can never import
// it. Here the queries are directly executable against node:sqlite, which is
// what bookRollup.test.mjs does — it asserts the real statements, not a copy
// of them.
//
// ── Response shape of GET /api/chapters/:book ────────────────────────────────
//
//   { book: string, chapters: Array<{
//       chapter: number,
//       // content counts (pre-existing)
//       verses: number, tn: number, tq: number, twl: number,
//       // review rollup (docs/ux-simplification.md A2, widened for issue #104)
//       tnValidated: number, tnAiDraft: number, tnEdited: number, tnNoState: number,
//       tqValidated: number, tqAiDraft: number, tqEdited: number, tqNoState: number,
//       versesDone: number,
//   }> }
//
// `tnNoState` / `tqNoState` mean translation_state IS NULL — a row the
// translate pipeline never touched. The bucket expression is a closed CASE, so
// an unrecognised state (no code path writes one) also lands there: the four
// state buckets ALWAYS sum to that chapter's `tn` / `tq` total.
//
// Denominator rules are shared with the count query on purpose (#238): tn
// excludes deleted AND trashed rows, tq excludes deleted (tq_rows has no
// trashed_at column), verse_statuses excludes the phantom verse 0. That shared
// filter set is what makes "buckets sum to the total" exact rather than
// approximate — the test asserts it.
//
// Cost: one book-scoped scan per resource, no per-chapter fan-out. The rollup
// no longer selects on translation_state='validated' (so the 0037/0038 partial
// indexes no longer serve it), but the count query in the same batch already
// scans every live tn/tq row of the book, so the cost class is unchanged.

/** Count arm. Binds ?1 = book, ?2 = active lit-lane source generation. */
export const BOOK_SUMMARY_COUNTS_SQL = `SELECT chapter,
        SUM(CASE WHEN kind='verse' THEN 1 ELSE 0 END) AS verses,
        SUM(CASE WHEN kind='tn' THEN 1 ELSE 0 END) AS tn,
        SUM(CASE WHEN kind='tq' THEN 1 ELSE 0 END) AS tq,
        SUM(CASE WHEN kind='twl' THEN 1 ELSE 0 END) AS twl
 FROM (
   SELECT chapter, 'verse' AS kind FROM verses WHERE book = ?1 AND bible_version = 'ULT' AND source_generation = ?2 AND verse > 0
   UNION ALL
   SELECT chapter, 'tn' FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
   UNION ALL
   SELECT chapter, 'tq' FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
   UNION ALL
   SELECT chapter, 'twl' FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL
 )
 GROUP BY chapter ORDER BY chapter`;

/** Review-rollup arm. Binds ?1 = book. */
export const BOOK_REVIEW_ROLLUP_SQL = `SELECT chapter,
        SUM(CASE WHEN kind='tn' AND state='validated' THEN 1 ELSE 0 END) AS tnValidated,
        SUM(CASE WHEN kind='tn' AND state='ai_draft' THEN 1 ELSE 0 END) AS tnAiDraft,
        SUM(CASE WHEN kind='tn' AND state='edited' THEN 1 ELSE 0 END) AS tnEdited,
        SUM(CASE WHEN kind='tn' AND state='none' THEN 1 ELSE 0 END) AS tnNoState,
        SUM(CASE WHEN kind='tq' AND state='validated' THEN 1 ELSE 0 END) AS tqValidated,
        SUM(CASE WHEN kind='tq' AND state='ai_draft' THEN 1 ELSE 0 END) AS tqAiDraft,
        SUM(CASE WHEN kind='tq' AND state='edited' THEN 1 ELSE 0 END) AS tqEdited,
        SUM(CASE WHEN kind='tq' AND state='none' THEN 1 ELSE 0 END) AS tqNoState,
        SUM(CASE WHEN kind='verse_done' THEN 1 ELSE 0 END) AS versesDone
 FROM (
   SELECT chapter, 'tn' AS kind,
          CASE WHEN translation_state IN ('validated','ai_draft','edited') THEN translation_state ELSE 'none' END AS state
     FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL
   UNION ALL
   SELECT chapter, 'tq',
          CASE WHEN translation_state IN ('validated','ai_draft','edited') THEN translation_state ELSE 'none' END
     FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL
   UNION ALL
   SELECT chapter, 'verse_done', '' FROM verse_statuses WHERE book = ?1 AND done = 1 AND verse > 0
 )
 GROUP BY chapter`;
