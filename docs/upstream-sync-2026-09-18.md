# Upstream sync 2026-09-18

Triage of upstream `unfoldingWord/bible-editor` `main`, window
`2aacd9a..5ab2b5f` (2026-09-10 – 2026-09-16, **45 non-merge commits**). Reads
together with [`upstream-sync-2026-09-11.md`](upstream-sync-2026-09-11.md) (and
the -08-28 / -08-21 docs it chains to).

Task focus was backend fixes (Door43/DCS sync, API/router, USFM/data-handling,
wrangler config). **3 ported**; the rest touch subsystems this fork never took,
are frontend/docs/test-infra, or are unverifiable in the sync environment.

The dominant structural finding: **the fork has diverged hard from upstream on
the sync/merge backend.** These modules are entirely absent here —
`verseMerge.ts`, `verseMergeConflicts.ts`, `masterLineage.ts`,
`rowProvenance.ts`, `tsvMerge.ts`, `ownPublish.ts`, `syncRunLog.ts` (the durable
sync-run ledger is a **new** upstream stack), `reviewAlerts.ts`,
`dcsCommits.ts`, `editLogSweep.ts`, `openingPunct.ts`, plus the reused-token /
quote-repair lint surface (`hasReusedSourceToken`, `QUOTE_GAP`, `refVerseList`,
`hoistOpeningPunctuation`). Migration numbering has also diverged (the fork's
`0063`–`0073` are unrelated files), so every upstream sync/ledger commit that
adds a `0063`+ migration would collide by number, not merely be missing.

## Ported (this PR)

- **`fea828a` (#766) — fix(wrangler): pin `account_id` on `[env.production]`.**
  wrangler aborts non-interactively when the deploying OAuth token belongs to
  more than one Cloudflare account (the exact failure CLAUDE.md's Deploy section
  documents, worked around by exporting `CLOUDFLARE_ACCOUNT_ID` by hand). Pinned
  `account_id = "5a3ffd86280d3ed086be76d955829242"` (unfoldingWord — owns the
  `bptranslate` worker and all three D1 DBs) on `[env.production]` only; the
  default (dev) env deliberately stays unset. Comment adapted to this fork's
  `bptranslate` naming; upstream's CLAUDE.md hunk not ported (different paths).

- **`5933078` (#776) — fix(pipelineImport): CAS-guard `applyTqUpsert`.** The
  `tq_rows` UPDATE read `existing.version` but never bound it into the WHERE
  clause, and its accept + audit were unconditional — so an AI pipeline
  auto-apply could silently overwrite a translator's concurrent edit to a
  question/response and then mark the proposal accepted. Ported the guard,
  **mirroring this fork's own `applyVerseUpdate`** (the verse half was already
  CAS-safe here) rather than upstream's `last_change_source` gate — this fork
  has no `rowProvenance` / `last_change_source` column. Added `AND version = ?`
  to the UPDATE; kept the whole write in one D1 batch with the accept
  self-gating on `changes() > 0` and the audit on an EXISTS fingerprint
  (`version = newVersion AND updated_by = <pipeline user> AND updated_at = now`,
  which a racing human CAS from the same base version can't satisfy because
  `updated_by` differs); on a lost CAS the row is skipped, counted in a new
  `tqSkippedConflict`, left **unaccepted** for review, and **not** auto-retried.
  Regression test added to `pipelineImport.test.mjs` (7 assertions; the fake D1
  now honours the version CAS and gates accept/audit the way real SQLite would).

- **`e6858fd` (#785, backend subset) — fix(chapters,laneReopen): audit
  verse_status / lane writes and lane-reopen deletes.** `chapters.ts`'s three
  `edit_log` INSERTs (verse_status toggle, single + bulk lane check) omitted
  `book`, so book-scoped audit queries missed them though `edit_log.book` has
  existed since migration 0017 — all three now stamp it. `laneReopen.ts`'s
  reopen DELETE dropped a checkoff with **no** audit trail; it's now paired in
  one batch with a conditional `edit_log` INSERT (`kind='verse_lane'`,
  `source='lane_reopen'`, `user_id` NULL, gated on `WHERE changes() > 0`).
  `laneReopen.test.mjs` extended with node:sqlite behavioural tests + a
  chapters.ts source-text check.
  - **Not ported (nothing to apply to):** upstream's `reopenLaneChecksBulk`
    changes and the `REOPEN_WRITE_BATCH 90 → 45` batch-cap fix — this fork's
    `laneReopen.ts` has neither a bulk variant nor `REOPEN_WRITE_BATCH`; its
    single DELETE clears all checkers for a `(verse, lane)` in one statement.

## Deferred — relevant but unverifiable here

- **`19aa4d1` (#799) — add `figs-exmetaphor` to the Support Reference picker.**
  A one-line, alphabetically-correct addition to `TA_SUPPORT_REFERENCE_IDS`, and
  a genuine gap (the id is absent here). Held back because the gating check
  `npm --workspace api run check:ta-refs` — which asserts every id resolves to a
  live `translate/<id>/01.md` article in `unfoldingWord/en_ta` — **cannot run in
  the sync environment**: `git.door43.org` is blocked by the egress proxy (HTTP
  403 / EGRESS_BLOCKED). Upstream's CI ran that check at merge, so it's very
  likely valid; port it in a follow-up once the ta-refs check can be run.

## Not applicable — subsystem absent from this fork (would also collide on migration numbering)

Sync/merge/ledger/lineage/provenance stack (verified against the working tree,
consistent with the 09-11 / 08-28 / 08-21 rulings):

- **Durable sync-run ledger (new upstream feature stack):** `5728b62`
  (add ledger), `13c7ede`, `035ca39`, `30716e8` — `syncRunLog.ts` / admin
  `/sync-runs` / exportWorkflow ledger accounting absent; migrations `0067`/`0068`
  collide.
- **verseMergeConflicts / verseMerge:** `bc19afb`, `0520db6`, `576a78e`,
  `93d7720`, `cadd673`, `2b7a015`, `05fc911` — `verseMerge.ts` /
  `verseMergeConflicts.ts` / `reviewAlerts.ts` absent (migrations `0063`/`0066`
  collide).
- **masterLineage / ancestor / dcsCommits:** `ae38388`, `378a4ca`, `7002626`,
  `4057e77`, `ef9b76e`, `a138deb` — `masterLineage.ts` / `dcsCommits.ts` /
  `visibleAdoptionChange.ts` / `reimportJourney` absent (migrations `0064`/`0065`
  collide).
- **restore-master-verses / verse-repair scripts:** `b9949df`, `4959df5` —
  `restore-master-verses.mjs` + the `verseMerge` probe it targets absent.
- **rowProvenance / repair-script provenance:** `9f50166`, `cd790e6` —
  `rowProvenance.ts` + `rollback-tn-quotes.mjs` / `scan-tn-quotes.mjs` absent.
- **reused-source-token / quote lint + openingPunct:** `ba90108`, `b031c6f`,
  `6cc11b4`, `5bc886a`, `5ab2b5f` — `hasReusedSourceToken` / `refVerseList` /
  `QUOTE_GAP` / `hoistOpeningPunctuation` / `scan-reused-token-visibility.mjs`
  absent; this fork's `lint.ts` has `lintUsfmVerses` only.
- **editLogSweep / stalled-boundary alarm:** `b10a072`, `c603540` —
  `editLogSweep.ts` / `raiseEditLogSweepBoundaryAlerts` absent.
- **reimport chapter-lock scoping:** `f0ec3be` — `resourcesLockedByJob` /
  `PIPELINE_WRITES` / `resourcesWrittenBy` absent; `chapterLock.ts` has only
  `activePipelineForChapter`.

## Not applicable — frontend / docs / test-infra (out of a backend sync)

- **Frontend:** `8d04426` (comments index — absent), `6955860` / `456cebe`
  (chip heights/borders), `793fa45` (useBookLint), `55af96a` (draftSnapshot —
  absent), `d856ea8` (editor jumping; its api-side lint half depends on absent
  lint fns), `e8fb508` (quote picker), `29dbb5e` (Find overlay focus).
- **`c00a182` (#777) — replace.ts hoist opening quote.** `openingPunct.ts`
  absent, and `replace.ts` is the CLAUDE.md-flagged brittle alignment surface
  explicitly out of a backend sync.
- **Tooling / docs:** `5aefcc2` (verify-bible-editor cursor skill), `707bb43` /
  `ec7082c` (docs).
