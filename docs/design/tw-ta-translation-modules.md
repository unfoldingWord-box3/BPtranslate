# tW / tA Translation Modules — Design

**Date:** 2026-07-10 · **Status:** Draft for review · **Scope:** FEASIBILITY.md Phase 4 ("Markdown article translation editors — new tables + editors + export", est. 3–4 wks)

Adds translatable translationWords (tW) and translationAcademy (tA) markdown articles to the multilingual Bible Editor: source articles imported from `unfoldingWord/en_tw` / `en_ta`, side-by-side source|target editing, AI drafting via the `translate` pipeline's `articles` envelope (PIPELINE-SPEC §2.1), and export toward `{lang}_tw` / `{lang}_ta` Door43 repos.

**Evidence discipline.** Claims are **[VERIFIED file:line]** (read in this checkout, 2026-07-10, or checked live against Door43) or **[PROPOSED]**. Manifest/publishing details are deliberately deferred to `docs/design/gl-publisher.md` (in parallel authorship; does not exist in this checkout yet).

---

## 0. Context and fixed points

- Article *content* editing was explicitly out of scope for the original tool: "TW article content (definitions) is not editable in this UI — that's gatewayEdit's territory" **[VERIFIED docs/plan.md:199]**. This design reverses that scoping decision per FEASIBILITY Phase 4.
- What exists today for tW is a **catalog cache, not content**: `tw_articles` stores id/category/title/tw_link per article, rebuilt destructively by the importer ("Re-runnable cache: scripts/import-tw.mjs begins with DELETE FROM") **[VERIFIED api/migrations/0032_tw_articles.sql:12-23]**. It feeds the picker/matcher via `GET /api/catalogs` **[VERIFIED api/src/catalogs.ts:60-70]**. It stays as-is; content lives in a new table (§1).
- Article *viewing* exists: `TwArticleDialog` fetches raw markdown client-side from the hardcoded `unfoldingWord/en_tw` repo and renders it read-only with react-markdown, with a deliberate no-`rehype-raw` XSS constraint **[VERIFIED web/src/components/TwArticleDialog.tsx:148-153, 141-147; web/src/lib/twArticle.ts:7,35-38]**. tA has no viewer — only a curated list of valid `rc://*/ta/man/translate/*` support references **[VERIFIED api/src/taSupportReferences.ts:1-11]**.
- **en_ta repo shape** (checked live via Door43 API, 2026-07-10): four manuals (`translate`, `checking`, `process`, `intro`) plus root `manifest.yaml`/`media.yaml`; each article is a directory of small files — e.g. `translate/figs-metaphor/{01.md, sub-title.md, …}`, with `01.md` at 17,516 bytes **[VERIFIED — Door43 contents API]**. `title.md` per article and per-manual `toc.yaml`/`config.yaml` are the documented RC convention, assumed present; confirm against the archive during import implementation **[PROPOSED/ASSUMED]**.
- **en_tw repo shape**: flat `bible/{kt,names,other}/{slug}.md`, one file per article **[VERIFIED scripts/import-tw.mjs:46-48,108-131]**.

---

## 1. Data model **[PROPOSED]**

One new table for both resources (they are structurally identical: a markdown file at a path), keyed by file path so the pipeline id round-trip (§4) and export (§5) are trivial:

```sql
-- 0036_article_units.sql
CREATE TABLE article_units (
  resource TEXT NOT NULL,            -- 'tw' | 'ta'
  path TEXT NOT NULL,                -- repo-relative: 'bible/kt/god.md', 'translate/figs-metaphor/01.md'
  article_id TEXT NOT NULL,          -- grouping key: 'kt/god', 'translate/figs-metaphor'
  part TEXT NOT NULL DEFAULT 'body', -- 'body' | 'title' | 'sub-title' (tA); tw is always 'body'
  source_md TEXT NOT NULL,           -- English markdown, refreshed on reimport
  source_sha TEXT,                   -- DCS blob sha of source_md at import time
  target_md TEXT,                    -- the translation (NULL = not started)
  translation_state TEXT,            -- NULL | 'ai_draft' | 'edited' | 'validated'  (PIPELINE-SPEC §4.1)
  draft_meta_json TEXT,              -- translate-report entry: confidence, violations (PIPELINE-SPEC §2.3/§4.1)
  version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  PRIMARY KEY (resource, path)
);
CREATE INDEX article_units_article ON article_units(resource, article_id);
CREATE INDEX article_units_state ON article_units(resource, translation_state);
```

Rationale:

- **File-per-row, not article-per-row.** A tA article is up to three markdown files; modeling each file as a unit makes export a direct `path → target_md` write and makes the pipeline envelope's path-keyed id round-trip exact (§4). The editor groups a tA article's units into one surface via `article_id` (§3).
- **Versioning mirrors `tn_rows` exactly.** PATCH with mandatory `If-Match`, version predicate enforced *inside* the UPDATE ("a SELECT-then-UPDATE would race two writers…") **[VERIFIED api/src/rows.ts:494-497]**, bare-integer If-Match parsing **[VERIFIED rows.ts:103-114]**, `UPDATE … WHERE … AND version = ?` **[VERIFIED rows.ts:634]**, and 409 `version_mismatch` returning the fresh row **[VERIFIED rows.ts:648-650]**. The version covers `target_md` edits only; source refresh (§2) is a server-side operation that does not consume user versions but bumps `version` so open editors 409-refresh — same monotonic-version property the outbox relies on.
- **`translation_state`** aligns with the PIPELINE-SPEC §4.1 state machine verbatim (NULL | `ai_draft` | `edited` | `validated`): pipeline apply sets `ai_draft`, human PATCH sets `edited`, explicit `POST /api/articles/:resource/validate?path=…` sets `validated` — modeled on the existing `/preserve` bit-toggle endpoint **[VERIFIED rows.ts — preserve/hint toggles audited as non-versioning, rows.ts:377-381; migration 0013_tn_preserve_hint.sql exists]**.
- **`source_sha`** is the stale-detection hook: reimport compares the incoming blob sha; on change it updates `source_md`/`source_sha` and, if `translation_state='validated'`, demotes to `edited` with a `stale_source` flag in `draft_meta_json` so review UI can surface "source changed since validation." (Equivalent role to `source_row_hash` in PIPELINE-SPEC §4.1.)
- **Audit**: writes log to the existing `edit_log` with `kind='tw'|'ta'` and `row_key=path`, reusing the `edit_log.source` provenance convention that drives the AI chip **[VERIFIED docs/plan.md edit_log schema; rows.ts:68-101 latest_source pattern]**. An article write records one of three sources: `'ai_pipeline'` for a translate-pipeline apply (the AI chip keys on it), NULL for a person in the web app, and `'chat'` for the chat assistant's write tools (#670 part d, PR #772). Article PATCH and validate both stamp `editSource(c)`, which returns `'chat'` for a chat principal and NULL otherwise **[VERIFIED 2026-11-02 api/src/articles.ts:124, 225; api/src/auth.ts:372-374; api/src/pipelineImport.ts:578, 1409]**. NULL and `'chat'` both count as a person's touch, so a translate apply skips an article that either one changed after the job was queued **[VERIFIED 2026-11-02 api/src/pipelineDedupSql.ts:242 `HUMAN_TOUCH_SOURCES`; api/src/pipelineImport.ts:759-775, 1508]**.

Not chosen: separate `tw_article_rows`/`ta_article_rows` tables (duplicate handlers for identical shapes) and folding content into catalog `tw_articles` (its importer is destructive by design — 0032:12-13 — and must stay so).

## 2. Import **[PROPOSED]**

New `scripts/import-articles.mjs` mirroring `import-tw.mjs`: one archive zip download per repo (`…/en_tw/archive/master.zip`, `…/en_ta/archive/master.zip`), OS-shell extraction, walk, emit SQL **[VERIFIED pattern — scripts/import-tw.mjs:41-84 downloadAndExtract, 52-63 extractZip]**. Differences from the tw-catalog importer, which are the whole point:

1. **Never `DELETE FROM`.** The catalog importer's destructive rebuild (import-tw.mjs:137-141) would destroy translations here. Emit `INSERT INTO article_units (…) ON CONFLICT(resource, path) DO UPDATE SET source_md=excluded.source_md, source_sha=excluded.source_sha, version=version+1 WHERE source_sha IS NOT excluded.source_sha` — target columns untouched.
2. **tA walk**: for each manual dir, each article subdir contributes up to three units (`01.md`→`body`, `title.md`→`title`, `sub-title.md`→`sub-title`); `toc.yaml`/`config.yaml`/`media.yaml`/`manifest.yaml` are **not** imported as translatable units (v1 passes them through at export or defers them to the publisher — §5).
3. **tw walk**: `bible/{kt,names,other}/*.md` → one `body` unit each, `article_id` = `{category}/{slug}` matching the catalog id convention **[VERIFIED 0032:16]**.
4. Batch INSERTs at 100 rows (import-tw.mjs:139) but expect much larger output (~1,000 tW articles × ~2 KB + ~200 tA articles × up to 17 KB); if a single `wrangler d1 execute --file` chokes, split output files — the book importer already splits for the same subrequest-budget reason **[VERIFIED CLAUDE.md — reimport batching note]**.

Ongoing source refresh reuses the same script (idempotent by design); wiring it into the nightly reimport machinery is deferred until source-churn actually bites (en_tw/en_ta change far slower than en_tn).

Multilingual note: the source org/repo must come from the Phase-1 project-config object, not new hardcoding — today's equivalents are hardcoded to `unfoldingWord/en_*` **[VERIFIED api/src/dcsSources.ts:53-59; web/src/lib/twArticle.ts:7]**. This design consumes that config; it does not build it.

## 3. Editor UX **[PROPOSED]**

**What exists to reuse:** `TwArticleDialog` proves the read-only render path — react-markdown + remarkGfm, MUI typography mapping, relative-link resolution against DCS, and the XSS constraint comment that must travel with any copy of that render **[VERIFIED TwArticleDialog.tsx:16-17, 34-60, 130-153]**. There is no markdown *editor* anywhere in `web/src` today; notes are edited as plain multiline text fields.

**Surface:** a new full-height "Articles" workspace, not a dialog — articles are not verse-scoped, so the three-column book shell doesn't apply. Routing extends the hash scheme (`#/{book}/{chapter}/{verse}` today, `parseHash` in App.tsx) with a new namespace: `#/articles/{resource}/{article_id}`. Layout:

- **Left rail:** article tree with state chips (draft/edited/validated counts). tW groups by category (from `tw_articles` catalog); tA groups by manual, ordered by `toc.yaml` when available, alphabetical fallback.
- **Main pane, side-by-side:** left = English source rendered read-only (extract TwArticleDialog's markdown body into a shared `MarkdownView` component — the dialog then consumes it too, and the source pane reads `source_md` from D1 instead of a client-side Door43 fetch); right = target editor. For a tA article, the title / sub-title units render as two single-line fields above the body editor.
- **Target editor v1 is a plain multiline text field with a rendered-preview toggle** — matching the notes-editing precedent, not a WYSIWYG/CodeMirror dependency. These articles are heading-and-list markdown; translators translate prose, they don't restructure. Revisit only on user demand.
- **Save path:** through the existing outbox → `PATCH /api/articles/{resource}?path=…` with `If-Match`, drained by `web/src/sync/api.ts` — the fetch client whose If-Match/409/401 handling "is what makes the outbox correct" **[VERIFIED CLAUDE.md save-protocol section]**. New op kind in `web/src/sync/outbox.ts`; no bypass.
- **Review affordances:** AI chip from `edit_log.source`, Validate button (state machine §1), a "stale source" banner when `draft_meta_json.stale_source` is set, and per-unit deterministic-check chips (§4).

No chapter-lock equivalent: articles aren't chapter-scoped, and the If-Match 409 already prevents silent clobbering between an editing human and an applying pipeline; the apply path skips units whose state is `edited`/`validated` (§4).

## 4. AI translation — the `articles` envelope **[PROPOSED]**

Rides the existing pipeline plumbing unchanged: D1 queue, single-slot dispatch, `options_json` snapshotted at queue time, dual polling, auto-apply **[VERIFIED api/src/pipelines.ts:32 PIPELINE_TYPES, 94-116 StartBody Zod, 852-875 options_json insert; CLAUDE.md — `*/5` pipeline cron]**. Per PIPELINE-SPEC §2.1, the `translate` pipelineType with `resourceType: "tw" | "ta"` replaces `rows` with an `articles` array; **the id round-trip becomes path-keyed**:

```json
"options": {
  "resourceType": "ta",
  "sourceLang": "en", "targetLang": "ar", "targetOrg": "ar_gl",
  "contextRef": "ar_gl/translation-context@<sha>",
  "articles": [
    { "articleId": "translate/figs-metaphor", "path": "translate/figs-metaphor/01.md",
      "sourceMarkdown": "…", "existingTarget": null }
  ]
}
```

- **Unit of work = one `article_units` row**; `path` is the round-trip id (echoed back exactly), the analogue of the proven 4-char `rowId` echo **[VERIFIED docs/bp-assistant-tn-hints-contract.md per PIPELINE-SPEC §1]**. Output lands as markdown files at those paths in `{targetOrg}/{targetLang}_{resource}` via the bot's existing repo-insert channel; `output[].rawUrl` is fetched by a new branch in `pipelineImport.ts` that UPDATEs `target_md` by `(resource, path)`, sets `translation_state='ai_draft'`, and stamps `edit_log.source='ai_pipeline'` — the `applyTnHintExpansion` pattern generalized (PIPELINE-SPEC §8 increment 1).
- **Batching by bytes, not count.** tN sends ~1 KB rows; a single tA body is 17 KB **[VERIFIED — figs-metaphor size, Door43 API]**. The start-request assembler caps a job at ~300 KB of `sourceMarkdown` (inside the ~500 KB envelope PIPELINE-SPEC §2.1 sized) and enqueues multiple jobs for larger selections; the queue serializes them through the single slot.
- **Skip-if-touched:** assembly excludes units in `edited`/`validated` state unless the user explicitly requests retranslation (`existingTarget` non-null = "revise").
- **Deterministic checks on apply**, markdown-specific subset of PIPELINE-SPEC §5: rc:// links preserved verbatim (error), heading-count/level parity (warning), non-empty and not byte-identical to source (error), balanced `**`/`*` and brackets (warning), no stray HTML introduced (error — protects the no-rehype-raw render, TwArticleDialog.tsx:141-147). Violations go in `draft_meta_json`; errors block Validate, not apply.
- **Content-interlock note:** tW/tA translation feeds the tN terminology/context loop (PIPELINE-SPEC §2.2) but is not gated on it, and vice versa — FEASIBILITY §3's corrected ordering ("ordering is a preference, not a data dependency"). Evidence update while researching this design: the Google-Sheet note-template mechanism PIPELINE-SPEC §0 could not find in code **now exists** — `api/src/noteTemplates.ts` proxies the sheet CSV, keyed by short support reference **[VERIFIED noteTemplates.ts:4-16]** — closing that spec's open action item.

## 5. Export **[PROPOSED — boundaries only; manifests belong to gl-publisher]**

Rendering is nearly the identity function, which is why file-per-row pays off: for each unit with non-null `target_md`, write it at `path` in the target repo — `{lang}_tw` (RC subject "Translation Words", `checking_level ≥ 2`) and `{lang}_ta` (subject "Translation Academy") per the consumption contract **[VERIFIED FEASIBILITY.md §1 table]**.

- **Mechanism:** new steps in (or a sibling of) `ExportWorkflow`, keeping its per-step retry granularity — today one step per book × resource **[VERIFIED api/src/exportWorkflow.ts:1-15]**; articles export as one step per resource × top-level directory (tw: 3 categories; ta: 4 manuals) to stay under commit-size and subrequest budgets.
- **Completeness policy is a product decision the publisher owns:** tC3's contract is all-or-nothing per resource, so exporting a half-translated tA is publishable-but-not-consumable until complete. v1 exports whatever exists (work-in-progress visibility on a branch, matching the contributor-branch snapshot model), and the *publisher* gates release-tagging on completeness + `checking_level` + `tc-ready` topic — all deferred to `docs/design/gl-publisher.md` along with `manifest.yaml` projects lists, `toc.yaml`/`config.yaml` handling, and `dublin_core` fields.
- **Safety rails carried over:** shrink-guard analogue (an export that would delete previously-exported article files is rejected) and the stale-D1 freshness gate, both existing export invariants **[VERIFIED CLAUDE.md — ExportWorkflow invariants (a)/(b)]**.

## 6. Effort, risks, non-goals

**Effort (AI-paced, consistent with FEASIBILITY Phase 4's 3–4 wks):** migration + PATCH/validate endpoints + outbox kind: 3–4 days. Importer: 2–3 days. Editor surface (rail, side-by-side, preview, state chips): 1.5–2 wks — the bulk. Pipeline envelope assembly + apply branch + checks: 3–5 days (bp-assistant side excluded — contract ask, not our code). Export steps: 2–3 days. **[PROPOSED — informed judgment, not measurement.]**

**Risks:** (1) bp-assistant `articles`-envelope support is a dependency on another team, same schedule risk PIPELINE-SPEC §8 names for tN; (2) tA long-article quality — 17 KB technical prose is a different translation problem than 1 KB notes; budget a golden-set eval extension before trusting batch drafts; (3) markdown-structure drift from AI output is only warned, not blocked — review burden lands on humans; (4) `title.md`/`toc.yaml` assumptions in §0 need one verification pass against the real archive; (5) single-slot pipeline contention: article jobs queue behind tN jobs.

**Non-goals:** publisher/manifest/release mechanics (gl-publisher.md); OBS and any other markdown resources; translating `toc.yaml`/`config.yaml`/`media.yaml`; WYSIWYG editing; UI i18n/RTL chrome (FEASIBILITY Phase 5); changes to the `tw_articles` catalog, matcher, or TWL suggestions; per-paragraph segmentation of articles (whole-file is the unit until evidence demands finer grain).

---

**Honesty ledger.** Verified by reading in this checkout: all `[VERIFIED file:line]` citations above (rows.ts, catalogs.ts, TwArticleDialog.tsx, twArticle.ts, import-tw.mjs, 0032 migration, taSupportReferences.ts, noteTemplates.ts, exportWorkflow.ts head, dcsSources.ts, pipelines.ts, plan.md, CLAUDE.md, FEASIBILITY.md, PIPELINE-SPEC.md). Verified live: en_ta repo structure and figs-metaphor file sizes (Door43 API, 2026-07-10). Not verified: `title.md` presence per tA article and per-manual `toc.yaml` (assumed RC convention); bp-assistant's willingness/shape for the `articles` envelope (contract ask); all effort figures. `docs/design/gl-publisher.md` does not exist yet in this checkout — references to it are forward references.
