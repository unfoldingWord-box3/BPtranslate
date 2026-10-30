// Nightly export — Cloudflare Workflow.
//
// Each (book × resource) is its own step. step.do persists results, so a
// transient DCS rate-limit retries that one step instead of restarting the
// whole run. A failed step that exhausts retries fails *the instance*; the
// next cron tick (or a manual /api/exports/run) starts a fresh instance and
// the unaffected resources land normally.
//
// What it produces per (book, resource):
//   1. Renders the file (TSV or USFM) from D1.
//   2. Stores it under R2 at exports/<instanceId>/<book>/<filename> for
//      inspection and as a local-only backup.
//   3. If DCS_SERVICE_TOKEN is set, commits the file to the conventional
//      unfoldingWord repo on the configured branch.
//   4. Records the outcome in export_snapshots so /api/exports can list it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import {
  ALL_RESOURCES,
  buildChapterExportBranch,
  buildExportBranch,
  buildTnTsv,
  buildTqTsv,
  buildTwlTsv,
  buildUsfm,
  closeDcsPr,
  commitToDcs,
  commitFilesToDcs,
  dcsBranchExists,
  deleteDcsBranch,
  ensureDcsPr,
  exportTsvShrinkRefused,
  findDcsOpenPr,
  masterFetchGate,
  recreateExportBranchFromMaster,
  updateDcsPrBranch,
  usfmAlignmentShrinkRefused,
  resourceTargetsFor,
  type DcsCommitResult,
  type Resource,
} from "./export";
import {
  articleStepUnits,
  articleStepLabel,
  renderArticleFiles,
  shrinkRefused,
  type ArticleResource,
} from "./articleExport.ts";

// Banner target for export PR failures — same maintainer the post-export
// validator alerts (see postExport.ts ValidatorConfig.alertTargetUsername).
const EXPORT_ALERT_USERNAME = "deferredreward";

// DCS web URL of the org exports land on — for alert links.
async function exportOwnerUrl(env: Env): Promise<string> {
  const cfg = await getProjectConfig(env);
  return `${env.DCS_BASE_URL}/${exportOwnerFor(env, cfg)}`;
}

// Legacy export branch, superseded by per-(book,resource) contributor branches.
// Pruned best-effort on each export so it doesn't linger; safe to delete since
// the live-snapshot flow is no longer used (its post-export path is dormant).
const LEGACY_EXPORT_BRANCH = "live-snapshot";
import { applyTwlSortOrderUpdates } from "./twlSortOrderApply";
import { runPostExport, VALIDATORS } from "./postExport";
import { runChunkedReimport, storedResourceSha, resourceSourceRef, ALL_RESOURCES as REIMPORT_RESOURCES } from "./bookReimport";
import { dcsRawUrl, dcsResourceFile, fetchDcsFileWithSha, fetchDcsMasterText, fetchText, fileCommitSha, heldOutNoteResources, type ReimportResource } from "./dcsSources";
import { getProjectConfig, exportOwnerFor } from "./projectConfig.ts";
import { sameDcsName } from "./repoUrl.ts";
import { heldOutChapters, type HeldOut, type BookSourceResource } from "./bookSource.ts";
import {
  laneForBibleVersion,
  assertLaneWritable,
  getLaneState,
  activeLaneConfig,
  activeGenerationForBibleVersion,
  configHash,
  type LaneKey,
} from "./scriptureLane";
import { nonAlignmentUsfmEqual } from "./alignmentCanonical";
import {
  acquireExportLease,
  renewExportLease,
  releaseExportLease,
  verifyExportFencingToken,
} from "./scriptureLaneReplacement";
import type { TnRow, TqRow, TwlRow, VerseRow } from "./types";
import { gateTsvRowForPublish } from "./publishGate.ts";
import { lintUsfmVerses } from "./lint";
import {
  renderContextPack,
  contextRepoOwner,
  contextRepoName,
  VALIDATED_TN_EXAMPLES_SQL,
  VALIDATED_TQ_EXAMPLES_SQL,
  type TranslationPrefsForRender,
  type ValidatedTnRow,
  type ValidatedTqRow,
  type TemplateForRender,
} from "./contextExport.ts";
import { contextShrinkRefused, shrinkDetailCode, hasSemanticContent } from "./contextExportLib.ts";
import { fetchEnSourceMaps } from "./contextSourceFetch.ts";
import { commitContextPackToMaster, getBranchTipSha, repoExists } from "./contextExportDcs.ts";
import {
  insertContextExportQueued,
  finalizeContextExport,
  getLatestContextExportStats,
} from "./contextExportResults.ts";
import type { TermImport } from "./translationMemoryLib.ts";
import { workspaceEnv, resolveWorkspace, primeWorkspaces } from "./workspaces.ts";
import { chapterShrinkRefused, formatChapterRange, mergeTsvChapterRange, missingOutOfRangeIds, type ChapterRange } from "./exportChapterMerge.ts";
import { activePipelineForChapter } from "./chapterLock";

export interface ExportParams {
  // Workspace slug this run belongs to. Workflows don't inherit the
  // per-request env clone (see run() below), so this is how a queued run
  // knows which org's D1 binding to use. Absent = the default workspace
  // (pre-workspaces behavior).
  workspace?: string;
  // Restrict the run to one book. Useful for manual /api/exports/run.
  book?: string;
  // Restrict the run to one resource family.
  resource?: Resource;
  // Force-skip the DCS commit even if a service token is configured. Lets
  // us test the rendering pipeline against R2 without pushing anything live.
  dryDcs?: boolean;
  // Run the post-export validate-and-merge orchestrator (dispatches a Gitea
  // Actions workflow that auto-merges the live-snapshot PR on DCS). The
  // 05:30 UTC cron sets this true; manual /api/exports/run leaves it false
  // so a single-book test export doesn't accidentally trigger a real merge.
  validateAndMerge?: boolean;
  // Self-heal mode: run only the chunked DCS→D1 reimport for every book, then
  // stop before rendering/committing. Used by the 08:00 REIMPORT_CRON (which
  // has no WorkflowStep context of its own). Runs the reimport even without a
  // service token (reads public raw files) — unlike the pre-export sync, which
  // is gated on dcsAllowed.
  reimportOnly?: boolean;
  // Skip verse + article phases; run only the translation-context pack export
  // (same durable workflow bindings / auth / retries as a full export).
  contextOnly?: boolean;
  // Admin override for the context-pack semantic shrink guard.
  shrinkOverride?: boolean;
  // Chapter-scoped export ("MRK 13-14 tn"): restrict the render to this
  // inclusive chapter range and MERGE it into master's whole-book file
  // instead of replacing the whole file (exportChapterMerge.ts). Set only
  // alongside `book` + `resource` (tn/tq/twl only) — enforced by the route
  // (exports.ts), not re-validated here.
  chapters?: ChapterRange;
  // Explicit Door43 write mode for a chapter-scoped run: true = "overwrite"
  // (skip the pre-export DCS→D1 sync, and bypass exportOne's freshness gate
  // for this (book, resource) so the range render replaces whatever Door43
  // holds for those chapters, including hand edits made there since the last
  // sync); false/absent = "merge", today's behaviour. Only ever true
  // alongside `chapters` — enforced by the route (exports.ts), not
  // re-validated here except for the defensive throw in exportOne.
  overwrite?: boolean;
}

export interface StepResult {
  book: string;
  resource: Resource;
  rowCount: number;
  bytes: number;
  r2Key: string | null;
  // The per-(book,resource) DCS branch this resource was committed to, named
  // for the book + its human contributors. null only when nothing was rendered.
  branch: string | null;
  dcsCommitSha: string | null;
  dcsChanged: boolean;
  dcsSkippedReason: string | null;
  // The open PR ensured for this branch (so the DCS validate-and-merge workflow
  // can act on it). null when nothing was pushed, the run was dry, or PR
  // creation failed (see prReason).
  prNumber: number | null;
  prReason: string | null;
  // tn/tq only: rows OMITTED from the render by the provenance-aware publish
  // gate (foreign-sourced, not validated, no usable snapshot — publishGate.ts).
  // Absent/0 for other resources. When ALL rows were held, the commit is
  // skipped with dcsSkippedReason `held_for_review:<count>`.
  heldForReview?: number;
}

const isResource = (s: string): s is Resource => (ALL_RESOURCES as string[]).includes(s);

// One (resource × top-level dir) article export step's outcome. The article
// analogue of StepResult — keyed by a `label` (e.g. 'tw-bible-kt') rather than
// a book, and carrying a file count instead of a row count.
export interface ArticleStepResult {
  label: string;
  resource: ArticleResource;
  topDir: string;
  fileCount: number;
  committedCount: number;
  branch: string | null;
  dcsCommitSha: string | null;
  dcsSkippedReason: string | null;
  prNumber: number | null;
}

export interface ContextPackStepResult {
  status: string;
  commitSha: string | null;
  contentFiles: number;
  terms: number;
  examplesTn: number;
  examplesTq: number;
  failureReason: string | null;
}

export class ExportWorkflow extends WorkflowEntrypoint<Env, ExportParams> {
  async run(event: WorkflowEvent<ExportParams>, step: WorkflowStep): Promise<{
    instanceId: string;
    totalSteps: number;
    results: StepResult[];
    articleResults: ArticleStepResult[];
    contextResult: ContextPackStepResult | null;
  }> {
    const params = event.payload ?? {};

    // Workflows don't inherit the per-request env clone that index.ts's fetch
    // wrapper builds, so this.env is the RAW Worker env — this.env.DB would be
    // the default binding regardless of which org queued the run. Re-point it
    // once, here, so the ~60 `this.env` reads below are all workspace-correct.
    // With WORKSPACES unset this resolves to the same default binding as before.
    // Prime the shared-DB workspace registry first so `params.workspace` can be
    // resolved to a registry-only slug (fails soft to the WORKSPACES env var).
    await primeWorkspaces(this.env);
    (this as unknown as { env: Env }).env = workspaceEnv(this.env, resolveWorkspace(this.env, params.workspace ?? null));

    // Folds the resolved workspace slug in so two orgs starting in the same
    // millisecond can't share an R2 staging prefix — instanceId is used as the
    // key prefix for both export snapshots (exports/<instanceId>/...) and
    // reimport staging (reimport-stage/<instanceId>/...), and the latter is
    // read back and applied to D1, so a collision would let one org import
    // another org's staged content. This is NOT the Workflow instance id
    // passed to EXPORT_WORKFLOW.create() (that's `nightly-${slug}-${day}` in
    // index.ts, already workspace-scoped for its own dedup purpose) — just the
    // R2 key prefix, which had no such scoping before.
    const instanceId = `export-${this.env.WORKSPACE_SLUG ?? "default"}-${new Date(event.timestamp).toISOString().replace(/[:.]/g, "-")}`;

    const dcsAllowed = !params.dryDcs && !!this.env.DCS_SERVICE_TOKEN;

    // contextOnly: first-class ExportWorkflow mode — skip verse/article/reimport;
    // same durable step retries + admin trigger as a full export.
    if (params.contextOnly) {
      const contextResult = await step.do(
        "export-context-pack",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => this.exportContextPack(instanceId, dcsAllowed, !!params.shrinkOverride),
      );
      return {
        instanceId,
        totalSteps: 1,
        results: [],
        articleResults: [],
        contextResult,
      };
    }

    // 1. Resolve the books list.
    const books = await step.do("list-books", async () => {
      const stmt = params.book
        ? this.env.DB.prepare(`SELECT book FROM book_imports WHERE book = ?1 ORDER BY book`).bind(params.book)
        : this.env.DB.prepare(`SELECT book FROM book_imports ORDER BY book`);
      const rs = await stmt.all<{ book: string }>();
      return rs.results.map((r) => r.book);
    });

    const resources: Resource[] = params.resource && isResource(params.resource)
      ? [params.resource]
      : ALL_RESOURCES;

    // Books whose ult/ust/twl did NOT come from the configured org/lane repo
    // (imported from the English translationSource) are held out of that
    // resource's EXPORT as a whole (book, resource) pair: scripture/twl have no
    // review state, so there is no row-level "approved" signal to publish on —
    // the whole-book provenance marker stays the skip (issue #142, and #104 for
    // the future review concept).
    //
    // tn/tq are NOT pair-skipped any more (docs/ux-simplification.md §1.4, the
    // durable #236 fix): their foreign provenance — the whole-book book_imports
    // marker AND the #103 chapter-range overrides — is enforced PER ROW inside
    // buildResource via gateTsvRowForPublish (publishGate.ts): validated rows
    // publish live content, snapshot-backed drafts publish the snapshot, and
    // everything else on a foreign chapter is omitted from the render. A
    // partial book therefore publishes its owned + approved chapters instead
    // of being withheld wholesale.
    const heldOutNotes = new Set(
      await step.do("list-held-out-note-books", async () => {
        const rs = await this.env.DB.prepare(
          `SELECT book, ult_source, ust_source, twl_source FROM book_imports
            WHERE ult_source IS NOT NULL OR ust_source IS NOT NULL OR twl_source IS NOT NULL`,
        ).all<{
          book: string;
          ult_source: string | null;
          ust_source: string | null;
          twl_source: string | null;
        }>();
        // step.do must return a JSON-serializable value → "BOOK:resource" strings.
        // The rows carry no tn_source/tq_source, so heldOutNoteResources can only
        // yield ult/ust/twl keys here.
        return rs.results.flatMap((r) =>
          [...heldOutNoteResources(r)].map((res) => `${r.book}:${res}`),
        );
      }),
    );

    // 1b. Sync D1 from current master before rendering. Pulls out-of-band master
    //     edits (other tooling, manual USFM cleanup, the bp-assistant bot) into
    //     D1's *pristine* rows so the export doesn't silently revert them on the
    //     branch; translator-edited rows are skipped by the reimport's pristine
    //     predicate (see bookReimport.ts). Without this, Part 2's reset-onto-
    //     master would make the export look like it's reverting master's edits.
    //
    //     One step.do per book (retries that book alone on a flaky DCS fetch),
    //     wrapped in try/catch so a single book's failure can't abort the whole
    //     export instance — same shape as the post-export reimport loop. Gated
    //     on dcsAllowed: a dry run / no-token run shouldn't mutate D1.
    //
    //     Chapter-scoped "overwrite" mode skips this sync entirely (by admin
    //     choice): the whole point is that the editor's rows for the range
    //     win over whatever Door43 holds, including out-of-band edits made
    //     there since the last sync — pulling those edits into D1 first would
    //     just have exportOne's chapter merge carry them back in.
    if (params.overwrite) {
      console.log("export pre-export sync skipped by admin choice (overwrite mode)", {
        book: params.book, resource: params.resource, chapters: params.chapters,
      });
    } else if (dcsAllowed || params.reimportOnly) {
      for (const book of books) {
        try {
          // Chunked + SHA-gated + diff-aware reimport — steps through chapters so
          // a large book can't blow the 10-min step limit, and skips files whose
          // DCS commit SHA is unchanged. See bookReimport.ts:runChunkedReimport.
          await runChunkedReimport(this.env, step, book, instanceId, [...REIMPORT_RESOURCES], {});
        } catch (e) {
          // Lock contention / transient DCS failure / Cloudflare subrequest cap:
          // this book's D1 is now possibly stale relative to master. The
          // freshness gate in exportOne (masterSha vs watermark) refuses to
          // commit a stale render, so a failed sync no longer reverts master —
          // it just skips this book's export until a later sync succeeds. Alert
          // so the failure is visible rather than silently swallowed.
          const msg = e instanceof Error ? e.message : String(e);
          console.error("export pre-reimport failed", { book, error: msg });
          try {
            await step.do(`reimport-fail-alert-${book}`, async () =>
              this.recordSyncFailureAlert(book, msg),
            );
          } catch {
            /* alert is best-effort; never let it abort the export run */
          }
        }
      }
    }

    // Self-heal mode (08:00 REIMPORT_CRON): D1 is now synced from DCS; there's
    // nothing to render or commit, so stop before the export steps below.
    if (params.reimportOnly) {
      return { instanceId, totalSteps: 0, results: [], articleResults: [], contextResult: null };
    }

    // 2. One step per (book, resource). step.do persists, so a single flaky
    //    step retries without re-rendering the entire run.
    //
    //    Resource-major ordering: finish all books for one resource, then
    //    run the post-export validator (if one is configured) before moving
    //    on. Without this, a transient failure on TQ/TWL/ULT/UST would block
    //    TN validation from ever firing even after TN successfully pushed.
    const results: StepResult[] = [];
    for (const resource of resources) {
      for (const book of books) {
        // English-source-sourced ult/ust/twl: not exported (see above, issue
        // #142; tn/tq are row-gated in buildResource instead). Emit a skipped
        // StepResult + snapshot instead of a bare `continue` so admins can see
        // WHY a (book, resource) is absent from the run rather than it silently
        // vanishing (indistinguishable from "never attempted") — issue #236.
        // This only adds observability; nothing is committed to DCS for a
        // held-out pair.
        if (heldOutNotes.has(`${book}:${resource}`)) {
          const heldReason = `held_out:${resource}`;
          try {
            await step.do(`export-${book}-${resource}-held-out`, async () =>
              this.recordSnapshot(book, resource, null, null, 0, heldReason),
            );
          } catch {
            /* recording the skip is best-effort; never let it abort the run */
          }
          results.push({
            book,
            resource,
            rowCount: 0,
            bytes: 0,
            r2Key: null,
            branch: null,
            dcsCommitSha: null,
            dcsChanged: false,
            dcsSkippedReason: heldReason,
            prNumber: null,
            prReason: null,
          });
          continue;
        }
        const stepName = `export-${book}-${resource}`;
        try {
          const result = await step.do(
            stepName,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            async () => this.exportOne(book, resource, instanceId, dcsAllowed, params.chapters, !!params.shrinkOverride, !!params.overwrite),
          );
          results.push(result);
        } catch (e) {
          // A single (book, resource) failure — most commonly a corrupt/dangling
          // DCS branch ref that ensureBranchVisible can't heal — must not abort
          // the whole instance and starve every other book (the resource-major
          // loop means one bad branch on the first book would otherwise block
          // all later books AND all later resources). Log, record the failure as
          // a snapshot for observability, and continue. Same isolation shape as
          // the pre-export reimport loop above.
          const reason = e instanceof Error ? e.message : String(e);
          console.error("export step failed", { book, resource, error: reason });
          try {
            await step.do(`${stepName}-record-fail`, async () =>
              this.recordSnapshot(book, resource, null, null, 0, `error:${reason.slice(0, 180)}`),
            );
          } catch {
            /* recording the failure is best-effort; never let it abort the run */
          }
          results.push({
            book,
            resource,
            rowCount: 0,
            bytes: 0,
            r2Key: null,
            branch: null,
            dcsCommitSha: null,
            dcsChanged: false,
            dcsSkippedReason: `error:${reason.slice(0, 180)}`,
            prNumber: null,
            prReason: null,
          });
        }
      }
      // Post-export validate-and-merge is opt-in via params.validateAndMerge.
      // The nightly cron sets it true; manual /api/exports/run defaults to
      // false so a one-off "render and push my single book" test doesn't
      // also kick off the auto-merge workflow on DCS.
      const validatorCfg = VALIDATORS.find((v) => v.resource === resource);
      if (validatorCfg && params.validateAndMerge === true) {
        await runPostExport(this.env, step, validatorCfg, dcsAllowed);
      }
    }

    // 2b. tW/tA article export. One step per (resource × top-level dir) —
    //     tw: bible/{kt,names,other}; ta: {translate,checking,process,intro} —
    //     mirroring the per-(book × resource) granularity above so a flaky
    //     commit retries a small slice. Only for TRANSLATION projects: the
    //     English root translates no articles (all target_md NULL), so there is
    //     nothing to export and we skip the DCS round-trips entirely. Also
    //     skipped for any NARROWED manual run: articles are book-independent, so
    //     a run scoped to one book (params.book — "re-export JON") or one verse
    //     resource (params.resource) didn't ask for the global tW/tA article
    //     export and must not fire it. Articles run only on a full-scope run
    //     (the nightly cron, or a manual run with neither book nor resource).
    const articleResults: ArticleStepResult[] = [];
    const projectCfgForArticles = await getProjectConfig(this.env);
    if (projectCfgForArticles.translationSource && !params.resource && !params.book) {
      for (const unit of articleStepUnits()) {
        const stepName = `export-article-${unit.resource}-${unit.topDir.replace(/\//g, "-")}`;
        try {
          const result = await step.do(
            stepName,
            { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
            async () => this.exportArticleDir(unit.resource, unit.topDir, instanceId, dcsAllowed),
          );
          articleResults.push(result);
        } catch (e) {
          // Same isolation shape as the verse loop: a single (resource, dir)
          // failure must not abort the instance or starve the other dirs.
          const reason = e instanceof Error ? e.message : String(e);
          const label = articleStepLabel(unit.resource, unit.topDir);
          console.error("export article step failed", { label, error: reason });
          try {
            await step.do(`${stepName}-record-fail`, async () =>
              this.recordSnapshot(label, unit.resource, null, null, 0, `error:${reason.slice(0, 180)}`),
            );
          } catch {
            /* recording the failure is best-effort; never let it abort the run */
          }
          articleResults.push({
            label,
            resource: unit.resource,
            topDir: unit.topDir,
            fileCount: 0,
            committedCount: 0,
            branch: null,
            dcsCommitSha: null,
            dcsSkippedReason: `error:${reason.slice(0, 180)}`,
            prNumber: null,
          });
        }
      }
    }

    // 2c. translation-context pack export. Full-scope GL runs only (nightly or
    //     manual with neither book nor resource). Writes {owner}/translation-context
    //     on master with CAS + shrink guard. See docs/CONTEXT-REPO-CONTRACT.md.
    let contextResult: ContextPackStepResult | null = null;
    const projectCfgForContext = await getProjectConfig(this.env);
    if (projectCfgForContext.translationSource && !params.resource && !params.book) {
      try {
        contextResult = await step.do(
          "export-context-pack",
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => this.exportContextPack(instanceId, dcsAllowed, !!params.shrinkOverride),
        );
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error("export context-pack step failed", { error: reason });
        contextResult = {
          status: "failed",
          commitSha: null,
          contentFiles: 0,
          terms: 0,
          examplesTn: 0,
          examplesTq: 0,
          failureReason: reason.slice(0, 180),
        };
      }
    }

    // 3. Best-effort escalation of integrity issues the export can't auto-fix.
    //    Footnote (\f/\f*) imbalance is real data corruption a translator must
    //    resolve; surface it as an admin banner. Human-decision content issues
    //    (square brackets, Alternate-translation labels) are NOT nagged here —
    //    they're surfaced in-app via the per-book lint indicator
    //    (GET /api/books/:book/lint). Never aborts the run.
    try {
      await step.do("lint-escalate", async () => this.escalateIntegrityIssues(books));
    } catch (e) {
      console.error("export lint-escalate failed", { error: e instanceof Error ? e.message : String(e) });
    }

    return {
      instanceId,
      totalSteps: results.length + articleResults.length + (contextResult ? 1 : 0),
      results,
      articleResults,
      contextResult,
    };
  }

  // Render D1 translation memory → {owner}/translation-context@master with
  // expected-parent CAS, semantic shrink guard, and full result persistence.
  // A SHA is only recorded as success after CAS lands (or dry_run with stats).
  private async exportContextPack(
    instanceId: string,
    dcsAllowed: boolean,
    shrinkOverride: boolean,
  ): Promise<ContextPackStepResult> {
    const cfg = await getProjectConfig(this.env);
    const owner = contextRepoOwner(this.env, cfg);
    const resultId = await insertContextExportQueued(this.env, { instanceId, owner });

    const empty = (status: string, reason: string | null): ContextPackStepResult => ({
      status,
      commitSha: null,
      contentFiles: 0,
      terms: 0,
      examplesTn: 0,
      examplesTq: 0,
      failureReason: reason,
    });

    if (!cfg.translationSource) {
      await finalizeContextExport(this.env, resultId, {
        status: "failed",
        failureReason: "not_a_gl_project",
      });
      return empty("failed", "not_a_gl_project");
    }

    // Load prefs / terms / validated rows from D1.
    const prefsRow = await this.env.DB.prepare(
      `SELECT audience, purpose, register, script_notes, instructions_md, common_issues_md
         FROM translation_prefs WHERE id = 1`,
    ).first<TranslationPrefsForRender>();
    const prefs: TranslationPrefsForRender = prefsRow ?? {
      audience: null,
      purpose: null,
      register: "default",
      script_notes: null,
      instructions_md: null,
      common_issues_md: null,
    };

    const termRs = await this.env.DB.prepare(
      `SELECT concept_id, source_term, target_term, status, replacement, comment, tw_link
         FROM terminology WHERE deleted_at IS NULL
         ORDER BY concept_id, source_term, status`,
    ).all<TermImport>();
    const terms = termRs.results ?? [];

    // Selectors live in contextExport.ts — they carry the `admin_bulk_state IS
    // NULL` rule that keeps bulk-approved rows out of the few-shot gold.
    const tnRs = await this.env.DB.prepare(VALIDATED_TN_EXAMPLES_SQL).all<ValidatedTnRow>();
    const tqRs = await this.env.DB.prepare(VALIDATED_TQ_EXAMPLES_SQL).all<ValidatedTqRow>();
    const tnRows = tnRs.results ?? [];
    const tqRows = tqRs.results ?? [];

    const templateRs = await this.env.DB.prepare(
      `SELECT template_id, support_ref, sheet_order, type, target_md
         FROM template_units
        WHERE translation_state = 'validated'
          AND deleted_at IS NULL
          AND origin = 'sheet'
          AND target_md IS NOT NULL AND TRIM(target_md) <> ''
        ORDER BY support_ref, sheet_order, template_id`,
    ).all<TemplateForRender>();
    const templates = templateRs.results ?? [];

    const sourceFetch = await fetchEnSourceMaps(this.env, cfg, tnRows, tqRows);
    // A resource whose translationSource repo was left blank in Setup has NO
    // upstream source: fetchEnSourceMaps SKIPS it (empty map) and still fetches
    // the sourced resources, returning ok with `skipped`. That must NOT fail the
    // whole context export — prefs, terms, and the resources that DO have a
    // source still publish. Only genuine fetch failures (en_fetch_failed /
    // truncation / network) land in the !ok branch and hard-fail as before.
    if (!sourceFetch.ok) {
      await finalizeContextExport(this.env, resultId, {
        status: "failed",
        failureReason: sourceFetch.reason,
      });
          await this.recordSnapshot("CONTEXT", "ctx", null, null, 0, sourceFetch.reason);
      return empty("failed", sourceFetch.reason);
    }
    if (sourceFetch.skipped.length > 0) {
      console.log(
        `context export: no upstream source for [${sourceFetch.skipped.join(", ")}] — exporting without those examples`,
      );
    }

    const dcsCfgCtx = {
      baseUrl: this.env.DCS_BASE_URL,
      token: this.env.DCS_SERVICE_TOKEN!,
      owner,
      repo: contextRepoName(),
    };

    // CAS retry loop: re-render from D1 on parent conflict (max 3).
    // Repo existence is invariant across retries — probe at most once.
    let repoChecked = false;
    const maxAttempts = 3;
    let lastReason: string | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rendered = renderContextPack({
        cfg,
        prefs,
        terms,
        tnRows,
        tqRows,
        sources: sourceFetch.sources,
        templates,
        skipped: sourceFetch.skipped,
      });
      if (!rendered.ok) {
        await finalizeContextExport(this.env, resultId, {
          status: "failed",
          failureReason: rendered.reason,
        });
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, 0, rendered.reason);
        return empty("failed", rendered.reason);
      }

      const { files, stats } = rendered;
      const prevStats = await getLatestContextExportStats(this.env);
      const semantic = hasSemanticContent({
        prefs,
        terms: stats.terms,
        examplesTn: stats.examplesTn,
        examplesTq: stats.examplesTq,
        templates: stats.templates,
      });
      // Scaffold-only (brief.md alone — + Register: default) with NO prior
      // successful export is a genuine first-time-empty pack: nothing to
      // publish and no repo to create. But scaffold-only AFTER a prior export
      // is an intentional CLEAR — it must flow through the commit below so the
      // stale instructions.md/terms.csv are deleted from master AND a new SHA
      // is recorded, otherwise getLatestSuccessfulContextExport keeps returning
      // the old SHA and the bot keeps injecting the content the user cleared.
      // (A large clear still trips the shrink guard → admin confirms via
      // shrinkOverride; a small clear commits straight through.)
      if (!semantic && !prevStats) {
        await finalizeContextExport(this.env, resultId, {
          status: "no_content",
          stats,
          failureReason: "scaffold_only",
        });
        await this.recordSnapshot("CONTEXT", "ctx", null, null, 0, "scaffold_only");
        return empty("no_content", "scaffold_only");
      }

      const shrink = contextShrinkRefused(stats, prevStats);
      if (shrink && !shrinkOverride) {
        const code = shrinkDetailCode(shrink);
        await finalizeContextExport(this.env, resultId, {
          status: "shrink_refused",
          stats,
          failureReason: code,
        });
        await this.recordContextShrinkAlert(owner, code);
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, stats.contentFiles, code);
        return {
          status: "shrink_refused",
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: code,
        };
      }

      const r2Key = `exports/${instanceId}/context-pack.json`;
      await this.env.BLOBS.put(
        r2Key,
        JSON.stringify({ files, stats, owner, renderedAt: new Date().toISOString() }),
        { httpMetadata: { contentType: "application/json" } },
      );

      if (!dcsAllowed) {
        const status = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "dry_run";
        await finalizeContextExport(this.env, resultId, {
          status: "dry_run",
          stats,
          r2Key,
          failureReason: this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        });
        await this.recordSnapshot(
          "CONTEXT",
          "ctx" ,
          "master",
          null,
          stats.contentFiles,
          this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        );
        return {
          status,
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token",
        };
      }

      try {
        if (!repoChecked) {
          repoChecked = true;
          if (!(await repoExists(dcsCfgCtx))) {
            const reason = "context_repo_not_provisioned";
            await finalizeContextExport(this.env, resultId, {
              status: "failed",
              stats,
              failureReason: reason,
              r2Key,
            });
            await this.recordSnapshot("CONTEXT", "ctx", null, null, stats.contentFiles, reason);
            await this.invalidateStaleContextExport();
            return {
              status: "failed",
              commitSha: null,
              contentFiles: stats.contentFiles,
              terms: stats.terms,
              examplesTn: stats.examplesTn,
              examplesTq: stats.examplesTq,
              failureReason: reason,
            };
          }
        }

        const tip = await getBranchTipSha(dcsCfgCtx, "master");

        if (tip === null) {
          const reason = "context_repo_uninitialized";
          await finalizeContextExport(this.env, resultId, {
            status: "failed",
            stats,
            failureReason: reason,
            r2Key,
          });
          await this.recordSnapshot("CONTEXT", "ctx", null, null, stats.contentFiles, reason);
          return {
            status: "failed",
            commitSha: null,
            contentFiles: stats.contentFiles,
            terms: stats.terms,
            examplesTn: stats.examplesTn,
            examplesTq: stats.examplesTq,
            failureReason: reason,
          };
        }

        const commit = await commitContextPackToMaster(
          dcsCfgCtx,
          files,
          `bible-editor context-pack export (${stats.contentFiles} files, ${stats.terms} terms) → master (${instanceId})`,
          tip,
        );
        await finalizeContextExport(this.env, resultId, {
          status: "success",
          commitSha: commit.commitSha,
          parentSha: commit.parentSha,
          stats,
          r2Key,
        });
        await this.recordSnapshot(
          "CONTEXT",
          "ctx" ,
          "master",
          commit.commitSha,
          stats.contentFiles,
          commit.changed ? null : "unchanged",
        );
        return {
          status: "success",
          commitSha: commit.commitSha,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: null,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastReason = msg;
        if (msg.startsWith("context_cas_conflict") && attempt + 1 < maxAttempts) {
          console.warn("context pack CAS conflict; re-rendering", { attempt, msg });
          continue;
        }
        await finalizeContextExport(this.env, resultId, {
          status: "failed",
          stats,
          failureReason: msg.slice(0, 400),
          r2Key,
        });
        await this.recordSnapshot("CONTEXT", "ctx" , null, null, stats.contentFiles, `error:${msg.slice(0, 160)}`);
        return {
          status: "failed",
          commitSha: null,
          contentFiles: stats.contentFiles,
          terms: stats.terms,
          examplesTn: stats.examplesTn,
          examplesTq: stats.examplesTq,
          failureReason: msg.slice(0, 180),
        };
      }
    }

    await finalizeContextExport(this.env, resultId, {
      status: "failed",
      failureReason: lastReason ?? "cas_retries_exhausted",
    });
    return empty("failed", lastReason ?? "cas_retries_exhausted");
  }

  private async invalidateStaleContextExport(): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE context_export_results
          SET status = 'failed',
              failure_reason = 'context_repo_deleted'
        WHERE id = (
          SELECT id FROM context_export_results
           WHERE status = 'success' AND commit_sha IS NOT NULL
           ORDER BY completed_at DESC, id DESC LIMIT 1
        )`,
    ).run();
  }

  private async recordContextShrinkAlert(owner: string, detail: string): Promise<void> {
    const source = "export_context_guard";
    const message =
      `Benjamin — context-pack export BLOCKED for ${owner}/translation-context: ${detail}. ` +
      `Re-check translation prefs/terms/examples, then re-export with shrinkOverride if intentional.`;
    await this.writeAlert(source, message, `${this.env.DCS_BASE_URL}/${owner}/translation-context`);
  }

  // Lint each book's rendered scripture for footnote imbalance and raise/clear an
  // admin banner accordingly. Per-book source so a fixed book's alert clears on
  // the next run. Returns a small summary for step observability.
  private async escalateIntegrityIssues(books: string[]): Promise<{ flagged: string[] }> {
    const flagged: string[] = [];
    // Lint only the active generation of each lane. A lane mid-replacement
    // (replacement_required → null) is blocked; skip it rather than lint stale
    // or quarantined rows.
    const laneGen: Record<string, number | null> = {
      ULT: await activeGenerationForBibleVersion(this.env, "ULT"),
      UST: await activeGenerationForBibleVersion(this.env, "UST"),
    };
    // Raise a per-book admin banner when `offenders` is non-empty, else clear any
    // stale undismissed alert for that source (the issue was fixed). One source
    // per issue category so they raise/clear independently.
    const raiseOrClear = async (source: string, offenders: string[], makeMsg: (n: number, sample: string) => string): Promise<boolean> => {
      if (offenders.length === 0) {
        await this.env.DB.prepare(
          `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
        )
          .bind(EXPORT_ALERT_USERNAME, source)
          .run();
        return false;
      }
      const more = offenders.length > 6 ? `, +${offenders.length - 6} more` : "";
      await this.writeAlert(source, makeMsg(offenders.length, offenders.slice(0, 6).join(", ") + more), await exportOwnerUrl(this.env));
      return true;
    };
    for (const book of books) {
      try {
        const footnoteOffenders: string[] = [];
        const gluedOffenders: string[] = [];
        for (const bv of ["ULT", "UST"]) {
          const gen = laneGen[bv];
          if (gen == null) continue;
          const rs = await this.env.DB.prepare(
            `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3 ORDER BY chapter, verse`,
          )
            .bind(book, bv, gen)
            .all<VerseRow>();
          for (const issue of lintUsfmVerses(rs.results ?? [])) {
            if (issue.bucket !== "escalate") continue;
            if (issue.check === "Glued alignment") gluedOffenders.push(`${bv} ${issue.ref}`);
            else footnoteOffenders.push(`${bv} ${issue.ref}`);
          }
        }
        const f = await raiseOrClear(
          `export_lint:${book}`,
          footnoteOffenders,
          (n, s) => `Benjamin — ${book}: ${n} footnote integrity issue(s) the export can't auto-fix (${s}). Fix the \\f/\\f* pairing in these verses.`,
        );
        const g = await raiseOrClear(
          `export_glued:${book}`,
          gluedOffenders,
          (n, s) => `Benjamin — ${book}: ${n} alignment milestone(s) with maqqef/minus-glued source words (${s}). An AI run glued two OL words into one token; open the verse in the aligner (it re-anchors off the UHB) and save, or run the backfill.`,
        );
        if (f || g) flagged.push(book);
      } catch (e) {
        console.error("escalateIntegrityIssues book failed", { book, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { flagged };
  }

  private async exportOne(
    book: string,
    resource: Resource,
    instanceId: string,
    dcsAllowed: boolean,
    chapters?: ChapterRange,
    // Admin override for the chapter-scoped shrink guard (chapterShrinkRefused)
    // — explicit acknowledgement that this range render deleting rows,
    // including every row in the range, is intended. Unused outside chapter
    // mode; every whole-book call site leaves it at the default.
    shrinkOverride = false,
    // Chapter-scoped "overwrite" write mode: bypass the freshness gate below
    // for this (book, resource) so the range render replaces whatever Door43
    // holds for those chapters, including hand edits made there since the
    // last sync. Distinct from shrinkOverride — overwrite does NOT imply
    // shrinkOverride; the range/whole-file shrink guards still apply. Only
    // ever true alongside `chapters` (enforced by the route); every other
    // call site leaves it at the default.
    overwrite = false,
  ): Promise<StepResult> {
    // Chapter-scoped export: tn/tq/twl only. The route (exports.ts) already
    // rejects ult/ust with a chapter range at request time; this is a
    // defensive backstop so a bad caller (or a future route bug) can't reach
    // the merge path for a resource it was never designed for.
    if (chapters && resource !== "tn" && resource !== "tq" && resource !== "twl") {
      throw new Error("chapter_scope_unsupported_resource");
    }
    // overwrite is meaningless (and dangerous) outside chapter scope — a
    // whole-book overwrite would mean "skip the freshness gate entirely",
    // which is not what this mode is for. Defensive backstop; the route
    // (exports.ts) already rejects `mode: "overwrite"` without a chapter
    // range at request time.
    if (overwrite && !chapters) {
      throw new Error("overwrite_requires_chapter_scope");
    }
    // Chapter label ("13" or "13-14") threaded into every recordSnapshot call
    // below so a chapter-scoped run's snapshots are distinguishable from a
    // whole-book run's; null (the default column value) for a whole-book run.
    const chapterLabel = chapters ? formatChapterRange(chapters) : null;
    // Lane fencing for scripture resources (ULT/UST): check writability from
    // live D1 state (not cached project config) before doing anything.
    const lane = (resource === "ult" || resource === "ust") ? laneForBibleVersion(resource.toUpperCase()) : null;
    // Active generation to render from. ULT/UST render their own lane's active
    // generation; TWL reads ULT verses for sort ordering, so it uses ULT's.
    // tn/tq don't touch generation-scoped rows (1 is an unused sentinel).
    let scriptureGen = 1;
    // Lane export destination from live active_config_json — not projectCfg.
    let laneExport: { owner: string; repo: string; baseRef: string } | null | undefined;
    let leaseId: string | null = null;
    let fencingToken: string | null = null;
    let expectedConfigHash: string | null = null;

    if (lane) {
      const gate = await assertLaneWritable(this.env, lane, "export_lease");
      if (!gate.ok) {
        const reason = `lane_blocked:${gate.error}`;
        await this.recordSnapshot(book, resource, null, null, 0, reason);
        return {
          book, resource, rowCount: 0, bytes: 0, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      // Acquire the lease BEFORE capture/render so a replacement cannot activate
      // mid-render and leave us holding old-generation bytes for a new destination.
      if (dcsAllowed) {
        const lease = await acquireExportLease(this.env, lane, `export:${instanceId}:${book}`);
        if ("error" in lease) {
          const reason = `lease_blocked:${lease.error}`;
          await this.recordSnapshot(book, resource, null, null, 0, reason);
          return {
            book, resource, rowCount: 0, bytes: 0, r2Key: null,
            branch: null, dcsCommitSha: null, dcsChanged: false,
            dcsSkippedReason: reason, prNumber: null, prReason: null,
          };
        }
        leaseId = lease.leaseId;
        fencingToken = lease.fencingToken;
      }
      // Re-bind generation/export under the lease (or after the gate if local-only).
      const bound = await assertLaneWritable(this.env, lane, "export_lease");
      if (!bound.ok) {
        if (leaseId) await releaseExportLease(this.env, leaseId).catch(() => {});
        const reason = `lane_blocked:${bound.error}`;
        await this.recordSnapshot(book, resource, null, null, 0, reason);
        return {
          book, resource, rowCount: 0, bytes: 0, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      scriptureGen = bound.generation;
      laneExport = bound.config.export;
      expectedConfigHash = configHash(bound.config);
    } else if (resource === "twl") {
      scriptureGen = await this.activeGenerationFor("ULT");
    }

    // AI-locked chapters: the pre-export sync (runChunkedReimport, in run()
    // above) SKIPS any (book, chapter) currently locked by a non-terminal
    // pipeline_jobs row, yet still advances that book's freshness watermark
    // regardless. So a chapter export that includes a locked chapter would
    // publish D1 content for that chapter that never received whatever
    // Door43 holds for it as of this sync — the exact stale-content hazard
    // the freshness gate exists to prevent, just reachable one step earlier
    // because the gate only compares the whole book's master SHA against the
    // watermark and has no per-chapter granularity. Check every chapter in
    // the range and terminal-skip before any render/DCS work if any is
    // locked; this is routine (a translator queued an AI run) rather than an
    // error, so a console.log is enough — no admin alert.
    if (chapters) {
      const lockedChapters: number[] = [];
      for (let ch = chapters.start; ch <= chapters.end; ch++) {
        if (await activePipelineForChapter(this.env, book, ch)) lockedChapters.push(ch);
      }
      if (lockedChapters.length > 0) {
        const reason = `chapter_locked:${lockedChapters.join(",")}`;
        console.log("chapter export: skipped — AI pipeline lock covers chapter(s) in range", {
          book, resource, chapters: chapterLabel, lockedChapters,
        });
        await this.recordSnapshot(book, resource, null, null, 0, reason, null, null, chapterLabel);
        return {
          book, resource, rowCount: 0, bytes: 0, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
    }

    try {
    const built = await this.buildResource(book, resource, scriptureGen, chapters);

    // After render: lease + generation/config must still match what we rendered.
    if (lane && leaseId) {
      await this.assertFencingOrThrow(lane, fencingToken);
      const still = await assertLaneWritable(this.env, lane, "export_lease");
      if (
        !still.ok ||
        still.generation !== scriptureGen ||
        configHash(still.config) !== expectedConfigHash
      ) {
        const reason = "lease_stale_after_render";
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      await renewExportLease(this.env, leaseId);
    }

    // Chapter mode: ANY held-for-review row inside the range — not only the
    // all-held case whole-book handles below — must fail closed. A chapter
    // export can only push a range as a single merged unit; it has no
    // row-level partial-publish path the way buildResource's per-row gate
    // does, so a range that mixes publishable rows with foreign-sourced,
    // not-yet-validated ones can't be represented at all: either the whole
    // range publishes (silently dropping the held rows from the merged
    // file, which the base_missing_master_rows guard would then treat as an
    // unexplained deletion) or nothing does. Terminal-skip BEFORE any
    // render-adjacent DCS work (branch resolution, merge, commit) so the
    // admin sees this before wasting a branch/PR on a range they need to
    // narrow instead.
    if (chapters && built.heldForReview > 0) {
      const reason = `held_for_review:${built.heldForReview}`;
      console.log("chapter export: skipped — range contains foreign-sourced chapter(s) the chapter export can't represent (holds are per-row, not partially mergeable); narrow the chapter range to exclude them", {
        book, resource, chapters: chapterLabel, heldForReview: built.heldForReview,
      });
      await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: built.content.length,
        r2Key: null,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: reason,
        prNumber: null,
        prReason: null,
        heldForReview: built.heldForReview,
      };
    }

    // Every row of this (book, resource) was omitted by the provenance-aware
    // publish gate — nothing is publishable yet. Skip the commit exactly like
    // the old pair-level held-out path, but record the omitted count so admins
    // can see why the resource is absent (#236's visibility ask, repurposed).
    // (Chapter mode never reaches here with heldForReview > 0 — the check
    // above already returned — so this stays the whole-book, all-held-only
    // behaviour it always was.)
    if (built.rowCount === 0 && built.heldForReview > 0) {
      const reason = `held_for_review:${built.heldForReview}`;
      await this.recordSnapshot(book, resource, null, null, 0, reason, null, null, chapterLabel);
      return {
        book,
        resource,
        rowCount: 0,
        bytes: 0,
        r2Key: null,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: reason,
        prNumber: null,
        prReason: null,
        heldForReview: built.heldForReview,
      };
    }

    if (built.content === "") {
      await this.recordSnapshot(book, resource, null, null, built.rowCount, "no_rows", null, null, chapterLabel);
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: 0,
        r2Key: null,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: "no_rows",
        prNumber: null,
        prReason: null,
      };
    }

    // Apply TWL sort order updates computed during export. Persist the sequence
    // so future operations use the optimal ordering from the ULT alignment.
    if (built.sortOrderUpdates.length > 0) {
      await this.applyTwlSortOrderUpdates(book, built.sortOrderUpdates);
    }

    // Book-specific branch named for this resource's human contributors.
    // Chapter-scoped exports use a DISTINCT `-bec-` branch family (never a
    // substring of `-be-`) so they can never be reset, pruned, or auto-merged
    // as if they were the nightly whole-book branch — see
    // buildChapterExportBranch's doc comment in export.ts.
    const contributors = await this.contributorsFor(book, resource);
    let branch = chapters
      ? buildChapterExportBranch(book, contributors)
      : buildExportBranch(book, contributors);

    const projectCfg = await getProjectConfig(this.env);
    const projectTarget = resourceTargetsFor(projectCfg)[resource];
    // Scripture lanes use active_config.export when set; export:null means
    // D1-only (R2 snapshot still written, no DCS commit). Non-scripture keeps
    // the project-config target.
    const filename = projectTarget.path(book);
    // Computed here (before the R2 write) rather than after it, so the
    // chapter-merge step below — which needs to know where to fetch master
    // from — can run before R2 gets its backup copy. Values are identical to
    // what this used to compute post-R2-write; moving it earlier changes
    // nothing for any existing (non-chapter) path.
    const dcsOwner = lane && laneExport
      ? laneExport.owner
      : exportOwnerFor(this.env, projectCfg);
    const dcsRepo = lane && laneExport ? laneExport.repo : projectTarget.repo;

    // Chapter mode: reuse a still-live chapter branch instead of the
    // contributor-derived name. Without this, exporting ch14 while ch13's
    // branch is still unmerged could land on a different branch (a
    // new/different contributor changes buildChapterExportBranch's suffix)
    // and merge ch14 against MASTER — which doesn't have ch13's unmerged
    // rows — silently dropping ch13 from the new branch. Reusing the prior
    // chapter branch means the merge below reads FROM that branch and
    // carries ch13's rows forward. Whole-book exports never do this lookup;
    // also see F1c below (chapter mode skips pruneSupersededBranches so a
    // sibling branch from an earlier chapter run is never deleted out from
    // under unmerged work).
    if (chapters && dcsAllowed) {
      try {
        branch = await this.reuseChapterBranch(book, resource, dcsOwner, dcsRepo, branch);
      } catch (e) {
        const reason = e instanceof Error && e.message.startsWith("chapter_merge:")
          ? e.message
          : "chapter_merge:branch_lookup_failed";
        await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, reason);
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
        return {
          book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
    }

    // Shared PR title/body builders for THIS (book, resource, chapters,
    // overwrite) — used both by the update-first step below (F3, run before
    // the merge base is read) and by the post-commit ensureDcsPr call further
    // down, so both PR-open attempts always agree on the same title/body.
    const buildExportPrTitle = (): string =>
      `bible-editor: ${book} ${resource}${chapterLabel ? ` ch${chapterLabel}` : ""}${overwrite ? " (overwrite)" : ""} → master`;
    // Chapter-scoped PRs are NOT part of the DCS validate-and-merge (`-be-`)
    // auto-merge family (see buildChapterExportBranch's `-bec-` naming and the
    // reuseChapterBranch/pruneSupersededBranches comments) — saying the
    // validate-and-merge workflow will process them would be actively wrong,
    // since nothing auto-merges a `-bec-` branch. Whole-book wording
    // (chapterLabel null) is unchanged.
    const buildExportPrBody = (forBranch: string): string => {
      const base = chapterLabel
        ? `Opened by a bible-editor chapter export of ${book} ${resource.toUpperCase()} chapters ${chapterLabel}. Holds the editor's rows for those chapters merged into the current book file. Intended for human review and merge on Door43, and deliberately outside the \`-be-\` auto-merge family.`
        : `Auto-opened by the bible-editor nightly export so the DCS validate-and-merge workflow can process \`${forBranch}\`. Holds the latest ${resource.toUpperCase()} edits for ${book}.`;
      return base + (overwrite
        ? ` This run used overwrite mode: any Door43 edits inside chapters ${chapterLabel} made since the last sync were intentionally replaced by the editor's rows.`
        : "");
    };

    // Chapter mode, update-first (Finding 3): before reading the merge base,
    // if the branch already exists on DCS, ensure it has an open PR and merge
    // MASTER INTO the branch (the Door43-compatible rebase) FIRST. Without
    // this, mergeAndGuardChapterRange could read a base that is already
    // behind master (an out-of-band edit landed there since the branch was
    // last updated), silently drop that edit from the merged content, and
    // only discover the drift after committing — the F2 whole-file guard
    // catches a discrepancy CAUGHT AFTER THE FACT, but updating first avoids
    // creating one to begin with whenever Door43 can auto-merge cleanly. A
    // real conflict here (the branch's chapter-scoped rows genuinely diverge
    // from master, e.g. the same rows edited on Door43 by a human) is left
    // for a human exactly like the existing post-commit 409 handling — see
    // recordChapterConflictAlert's comment: chapter branches are never
    // auto-rebuilt, only whole-book branches are. Any OTHER failure to
    // confirm the merge (a thrown error, or a non-ok updateDcsPrBranch result
    // that isn't the 409 above) fails CLOSED with reason
    // chapter_merge:update_first_failed rather than proceeding — see the
    // catch/status handling below for why "best-effort, fall through" is
    // unsafe here.
    if (chapters && dcsAllowed) {
      let branchLive: boolean;
      try {
        branchLive = await dcsBranchExists(
          { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner: dcsOwner, repo: dcsRepo },
          branch,
        );
      } catch (e) {
        // Same fail-closed reasoning as mergeChapterAgainstBase's check
        // below: guessing "not live" here risks silently skipping the
        // update-master-into-branch step for a branch that IS live and
        // carrying earlier unmerged chapter work, which is exactly the drift
        // this update-first step exists to catch before it's baked into a
        // commit. Terminal-skip instead.
        console.error("chapter export: pre-merge branch-exists check failed; refusing to guess whether it's live", {
          book, resource, branch, error: e instanceof Error ? e.message : String(e),
        });
        const reason = "chapter_merge:branch_check_failed";
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
        await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, reason);
        return {
          book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: reason, prNumber: null, prReason: null,
        };
      }
      if (branchLive) {
        // Chapter mode is tn/tq/twl-only (enforced at the top of this
        // method), so `lane` is always null here — no fencing/lease token to
        // thread through these calls.
        const dcsCfgEarly = {
          baseUrl: this.env.DCS_BASE_URL,
          token: this.env.DCS_SERVICE_TOKEN!,
          owner: dcsOwner,
          repo: dcsRepo,
          branch,
          baseRef: laneExport?.baseRef ?? "master",
        };
        try {
          const pr = await ensureDcsPr(dcsCfgEarly, buildExportPrTitle(), buildExportPrBody(branch));
          // pr.number is null on "head_equals_base" (branch is the base ref —
          // never true here) or "no_diff" (branch has no diff against master
          // yet, e.g. brand new): nothing to merge master into, continue.
          if (pr.number != null) {
            const upd = await updateDcsPrBranch(
              { baseUrl: dcsCfgEarly.baseUrl, token: dcsCfgEarly.token, owner: dcsOwner, repo: dcsRepo },
              pr.number,
            );
            if (!upd.ok) {
              if (upd.status === 409) {
                // Merge conflict merging master INTO the branch — the same
                // manual-resolution posture as the post-commit 409 handling
                // below (chapter branches are never auto-rebuilt). Terminal
                // skip: nothing was committed.
                const reason = "chapter_merge:branch_conflict";
                await this.recordChapterConflictAlert(book, resource, dcsRepo, branch, chapterLabel);
                await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
                return {
                  book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
                  branch: null, dcsCommitSha: null, dcsChanged: false,
                  dcsSkippedReason: reason, prNumber: null, prReason: null,
                };
              }
              // Any OTHER non-ok status (rate limit, 5xx, auth hiccup, ...):
              // fail closed rather than "proceed to merge-and-commit" as
              // before. Without a confirmed merge of master INTO the branch,
              // the branch may be behind master by more than just this
              // range's rows, and the F2 out-of-range-ID check below reads
              // its base FROM THIS BRANCH — it would compare against stale
              // cell text and could pass even though the branch is missing a
              // master row, silently letting a merge onto a stale base
              // through. Terminal-skip instead of committing against an
              // unproven base.
              console.error("chapter export: update-first merge-master-into-branch failed (non-409); refusing to commit against an unproven base", {
                book, resource, branch, status: upd.status, detail: upd.detail,
              });
              const reason = "chapter_merge:update_first_failed";
              await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
              await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, reason);
              return {
                book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
                branch: null, dcsCommitSha: null, dcsChanged: false,
                dcsSkippedReason: reason, prNumber: null, prReason: null,
              };
            }
          }
        } catch (e) {
          // A thrown error here (unlike a clean non-ok response, handled
          // above) leaves us with no confirmation either way that master was
          // merged into the branch — same "unproven base" hazard as the
          // non-409 branch above, so fail closed the same way rather than
          // silently falling through to merge-and-commit.
          const msg = e instanceof Error ? e.message : String(e);
          console.error("chapter export: update-first ensure-PR/merge-master threw; refusing to commit against an unproven base", {
            book, resource, branch, error: msg,
          });
          const reason = "chapter_merge:update_first_failed";
          await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
          await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, reason);
          return {
            book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
            branch: null, dcsCommitSha: null, dcsChanged: false,
            dcsSkippedReason: reason, prNumber: null, prReason: null,
          };
        }
      }
    }

    // Chapter-scoped export: MERGE the chapter range's render into the
    // existing whole-book file — read from the EXPORT BRANCH when one is
    // already live (carrying forward an earlier chapter run's rows, which
    // are outside this range so the merge keeps them verbatim) and falling
    // back to master otherwise — instead of pushing the range alone (which
    // would replace the whole file with just these chapters). Only reachable
    // for tn/tq/twl (checked at the top of this method); replaces the
    // whole-file shrink guard below for this path with a scoped one — see
    // exportChapterMerge.ts. `contentToCommit` is what gets written to R2,
    // committed to DCS, and re-committed on conflict recovery; it stays
    // `built.content` (the range-only render) for a dry run / no-token run,
    // since nothing is actually pushed to compare against a base.
    // `chapterExpectedSha` is the base file's blob sha the merge was computed
    // against — commitToDcs's CAS check (see mergeChapterAgainstBase and
    // commitChapterRange below) refuses to overwrite the branch if it moved
    // since this read, and the caller re-merges against the new base instead
    // of silently clobbering whatever landed there (issue: sequential
    // chapter exports racing each other or an out-of-band edit).
    let contentToCommit = built.content;
    let chapterExpectedSha: string | null = null;
    if (chapters && dcsAllowed) {
      const merged = await this.mergeAndGuardChapterRange(
        book, resource, built, chapters, chapterLabel, dcsOwner, dcsRepo, branch, shrinkOverride,
      );
      if (!merged.ok) {
        await this.recordSnapshot(book, resource, null, null, built.rowCount, merged.reason, null, null, chapterLabel);
        await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, merged.reason);
        return {
          book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
          branch: null, dcsCommitSha: null, dcsChanged: false,
          dcsSkippedReason: merged.reason, prNumber: null, prReason: null,
        };
      }
      contentToCommit = merged.content;
      chapterExpectedSha = merged.expectedSha;
    }

    // R2 is the local-only backup. Writing here first means a failed DCS
    // commit still leaves a recoverable artifact. For a chapter-scoped export
    // this stores the MERGED whole-book content — what was actually pushed —
    // not the range-only render.
    const r2Key = `exports/${instanceId}/${book}/${resource}/${filename}`;
    await this.env.BLOBS.put(r2Key, contentToCommit, {
      httpMetadata: { contentType: filename.endsWith(".usfm") ? "text/plain" : "text/tab-separated-values" },
    });

    let dcsCommitSha: string | null = null;
    let dcsChanged = false;
    let dcsSkippedReason: string | null = null;
    let prNumber: number | null = null;
    let prReason: string | null = null;
    let prError: string | null = null;

    // Lane with export:null → local-only; never push to a project-default repo.
    // (chapters is always null on this branch — lane resources are ult/ust,
    // which never carry a chapter range; see the guard at the top.)
    if (lane && laneExport === null) {
      await this.recordSnapshot(book, resource, null, null, built.rowCount, "lane_export_disabled");
      return {
        book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key,
        branch: null, dcsCommitSha: null, dcsChanged: false,
        dcsSkippedReason: "lane_export_disabled", prNumber: null, prReason: null,
      };
    }

    // Freshness gate — the single guard against clobbering master. The export
    // renders from D1; if master moved past what D1 last synced (the
    // book_resource_syncs watermark), committing this render would REVERT
    // master's out-of-band edits (the exact LAM 2:17 regression: a gatewayEdit
    // alignment landed on master, the pre-export sync failed on the Cloudflare
    // subrequest cap, and the export silently reverted it). So unless we can
    // POSITIVELY confirm master == watermark, skip the commit and alert. Fail
    // CLOSED on uncertainty (can't fetch master SHA) — a one-night skip beats a
    // silent revert. A fresh book with no watermark has nothing to clobber.
    // Only meaningful when we'd actually commit (dcsAllowed); a dry run renders
    // to R2 only and can't clobber anything.
    //
    // Chapter-scoped "overwrite" mode bypasses this gate by admin choice: the
    // whole point of overwrite is that the editor's rows for the range should
    // replace whatever Door43 holds for those chapters, including hand edits
    // made there since the last sync — the exact case this gate exists to
    // block in merge mode. (chapters is tn/tq/twl-only, so this can never
    // race the lane-fencing/generation logic above.)
    let fresh: { ok: boolean; detail: string; masterSha: string | null; watermark: string | null };
    if (overwrite) {
      console.log("chapter export: freshness gate bypassed (overwrite mode)", {
        book, resource, chapters: chapterLabel,
      });
      fresh = { ok: true, detail: "overwrite", masterSha: null, watermark: null };
    } else if (dcsAllowed) {
      fresh = await this.checkMasterFreshness(book, resource, {
        owner: dcsOwner,
        repo: dcsRepo,
        baseRef: laneExport?.baseRef ?? "master",
        lane,
      });
    } else {
      fresh = { ok: true, detail: "dry", masterSha: null, watermark: null };
    }
    if (!fresh.ok) {
      await this.recordStaleSkipAlert(book, resource, fresh.masterSha, fresh.watermark);
      const reason = `stale_master:${fresh.detail}`;
      await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
      return {
        book,
        resource,
        rowCount: built.rowCount,
        bytes: built.content.length,
        r2Key,
        branch: null,
        dcsCommitSha: null,
        dcsChanged: false,
        dcsSkippedReason: reason,
        prNumber: null,
        prReason: null,
      };
    }

    // Shrink guard — refuse to commit a TSV render that would delete a large
    // fraction of master's rows (truncation backstop; see exportTsvShrinkRefused).
    // Only when we'd actually commit (dcsAllowed) and only for TSV resources,
    // whose row==line model makes the count exact. This is what would have
    // stopped the twl_PSA clobber (4880 rows shipped over master's 7776).
    // A chapter-scoped export already ran its own scoped version of this guard
    // above (comparing the range's rendered/master row counts, not the whole
    // file) — skip the whole-file comparison here for that path.
    if (dcsAllowed && !chapters && (resource === "tn" || resource === "tq" || resource === "twl")) {
      const guard = await this.checkTsvShrink(
        book, resource, built.rowCount, dcsOwner, dcsRepo, "master",
      );
      if (!guard.ok) {
        await this.recordShrinkSkipAlert(book, resource, built.rowCount, guard.masterRows, guard.detail);
        const reason = `shrink_guard:${guard.detail}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // Alignment-shrink backstop for the scripture (verse) resources. The TSV
    // shrink guard above protects row counts; this protects \zaln word
    // alignment. A verse that lost \zaln milestones on UNTOUCHED words (the
    // 1CH 4:21 / NUM 24 signature) has the same row count but fewer aligned
    // words — invisible to the TSV guard. The interactive guard now catches
    // this at write time, but a verse already regressed in D1 (landed before
    // the guard, or via an ingress path it doesn't cover) would still ship.
    // Conservative: only blocks a verse whose aligned-word count shrank while
    // its plain text is unchanged — a real text rewrite is always allowed.
    if (dcsAllowed && (resource === "ult" || resource === "ust")) {
      const guard = await this.checkUsfmAlignmentShrink(
        book, resource, built.content, dcsOwner, dcsRepo, laneExport?.baseRef ?? "master",
      );
      if (!guard.ok) {
        await this.recordAlignmentShrinkSkipAlert(book, resource, guard.detail);
        const reason = `align_shrink_guard:${guard.detail}`;
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
        return {
          book,
          resource,
          rowCount: built.rowCount,
          bytes: built.content.length,
          r2Key,
          branch: null,
          dcsCommitSha: null,
          dcsChanged: false,
          dcsSkippedReason: reason,
          prNumber: null,
          prReason: null,
        };
      }
    }

    // textReadOnly lanes (AVD/NAV): refuse to export if non-alignment body text
    // diverged from the destination tip. Alignment-only changes are allowed.
    if (dcsAllowed && lane && (resource === "ult" || resource === "ust")) {
      const laneRow = await getLaneState(this.env, lane);
      const laneCfg = laneRow ? activeLaneConfig(laneRow) : null;
      if (laneCfg?.textReadOnly) {
        const baseRef = laneExport?.baseRef ?? "master";
        const eq = await this.checkLockedTextEquality(
          book, resource, built.content, dcsOwner, dcsRepo, baseRef,
        );
        if (!eq.ok) {
          await this.recordLockedTextDriftAlert(book, resource, eq.detail);
          const reason = `locked_text_drift:${eq.detail}`;
          await this.recordSnapshot(book, resource, null, null, built.rowCount, reason);
          return {
            book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key,
            branch: null, dcsCommitSha: null, dcsChanged: false,
            dcsSkippedReason: reason, prNumber: null, prReason: null,
          };
        }
      }
    }

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
    } else {
      const owner = dcsOwner;
      const dcsCfg = {
        baseUrl: this.env.DCS_BASE_URL,
        token: this.env.DCS_SERVICE_TOKEN!,
        owner,
        repo: dcsRepo,
        branch,
        baseRef: laneExport?.baseRef ?? "master",
        beforeMutation: fencingToken
          ? () => this.assertFencingOrThrow(lane, fencingToken)
          : undefined,
      };
      const message = `bible-editor export: ${book} ${resource}${chapterLabel ? ` ch${chapterLabel}` : ""}${overwrite ? " (overwrite)" : ""} → ${branch} (${instanceId})`;

      // Fencing token must still hold before the file commit — the one mutation
      // we must never do with a stale token (it would push over a just-activated
      // replacement generation). Throws → the run() step catch records the skip;
      // nothing was committed.
      await this.assertFencingOrThrow(lane, fencingToken);

      let commit: DcsCommitResult;
      if (chapters) {
        // Chapter mode: read-base → merge → shrink-guard → commit, retried up
        // to 3 times against a fresh base whenever commitToDcs reports
        // staleBase (something else — a sibling chapter run, an out-of-band
        // edit — landed on the branch between our read and this write).
        const settled = await this.commitChapterRange(
          book, resource, chapters, chapterLabel, built, dcsOwner, dcsRepo, branch,
          dcsCfg, filename, message, contentToCommit, chapterExpectedSha, shrinkOverride,
        );
        if ("terminal" in settled) return settled.terminal;
        commit = settled.commit;
        contentToCommit = settled.content;
      } else {
        commit = await commitToDcs(dcsCfg, filename, contentToCommit, message);
      }
      if (!commit.branchTouched) {
        // Rendered content matches master — nothing to merge. Close any open PR
        // lingering from an earlier night so empty (0-diff) PRs don't pile up.
        // The whole lookup+close is opportunistic hygiene: a transient door43
        // 429/500/502 (or an HTML gateway page) during findDcsOpenPr must not
        // fail the export step on the routine unchanged-book path, so the
        // lookup lives INSIDE the try alongside the close.
        try {
          const lingering = await findDcsOpenPr(dcsCfg);
          if (lingering != null) {
            // Closing a stale PR mutates DCS — re-verify ownership first.
            await this.assertFencingOrThrow(lane, fencingToken);
            await closeDcsPr(dcsCfg, lingering);
          }
        } catch (e) {
          console.error("export close-stale-PR failed", {
            book, resource, repo: dcsRepo,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      dcsCommitSha = commit.commitSha || null;
      dcsChanged = commit.changed;

      // Remember the destination tip we exported against so divergent
      // source≠export freshness checks don't re-validate the wrong repo.
      if (lane && laneExport && fresh.masterSha) {
        await this.recordExportBaseline(
          lane,
          dcsOwner,
          dcsRepo,
          laneExport.baseRef,
          book,
          fresh.masterSha,
        );
      }

      if (!commit.branchTouched) {
        dcsSkippedReason = "unchanged";
      } else {
        try {
          // Pruning superseded branches deletes refs on DCS for OLDER exports
          // of this (book, resource) — correct for a whole-book run (which
          // always fully replaces the file) but wrong for chapter mode, where
          // a "superseded" branch may be a SIBLING chapter export still
          // carrying its own open PR (see the branch-reuse comment above);
          // deleting it would destroy that unmerged work. Chapter mode skips
          // this entirely (F1c).
          if (!chapters) {
            // Pruning superseded branches deletes refs on DCS — re-verify ownership.
            await this.assertFencingOrThrow(lane, fencingToken);
            await this.pruneSupersededBranches(
              book, resource, owner, dcsRepo, branch, lane, fencingToken,
            );
          }

          // Renew around the (potentially long) PR operations; a failed renew
          // means another Worker took the lane — treat it as lost ownership and
          // abort the remaining mutations rather than racing them.
          if (leaseId && !(await renewExportLease(this.env, leaseId))) {
            throw new Error("fencing_token_superseded");
          }
          await this.assertFencingOrThrow(lane, fencingToken);

          const pr = await ensureDcsPr(dcsCfg, buildExportPrTitle(), buildExportPrBody(branch));
          prNumber = pr.number;
          prReason = pr.reason;
          if (pr.number != null) {
            try {
              // Renew + re-verify before update-branch (another mutating call).
              if (leaseId && !(await renewExportLease(this.env, leaseId))) {
                throw new Error("fencing_token_superseded");
              }
              await this.assertFencingOrThrow(lane, fencingToken);
              const upd = await updateDcsPrBranch(
                { baseUrl: dcsCfg.baseUrl, token: dcsCfg.token, owner, repo: dcsRepo },
                pr.number,
              );
              if (!upd.ok) {
                console.log("export PR update-branch skipped", {
                  book, resource, repo: dcsRepo, pr: pr.number, status: upd.status, detail: upd.detail,
                });
                if (upd.status === 409) {
                  if (chapters) {
                    // Chapter mode (F1): never call recoverConflictedBranch — it
                    // deletes and recreates the branch from master, which would
                    // discard every EARLIER chapter run's rows already merged
                    // onto it (this branch may be carrying forward ch13's rows
                    // while ch14 is what just conflicted). Leave the branch and
                    // its PR exactly as they are; a human resolves the conflict
                    // (or merges/closes the PR) on Door43, then a later export
                    // continues from whatever that leaves behind.
                    prError = "conflict:manual_resolution_required";
                    await this.recordChapterConflictAlert(book, resource, dcsRepo, branch, chapterLabel);
                  } else {
                    // Recovery deletes + recommits the branch — renew + re-verify.
                    if (leaseId && !(await renewExportLease(this.env, leaseId))) {
                      throw new Error("fencing_token_superseded");
                    }
                    await this.assertFencingOrThrow(lane, fencingToken);
                    const recovered = await this.recoverConflictedBranch(
                      book, resource, owner, dcsRepo, branch, dcsCfg, filename, contentToCommit, message,
                      lane, fencingToken,
                    );
                    if (recovered) {
                      prNumber = recovered.prNumber;
                      prReason = recovered.prReason;
                      if (recovered.commitSha) dcsCommitSha = recovered.commitSha;
                    }
                  }
                }
              }
            } catch (e) {
              console.error("export PR update-branch failed", {
                book, resource, repo: dcsRepo, pr: pr.number,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        } catch (e) {
          prReason = "error";
          prError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
          console.error("export ensure-PR failed", {
            book,
            resource,
            repo: dcsRepo,
            branch,
            error: prError,
          });
          await this.recordPrFailureAlert(book, resource, dcsRepo, branch, prError);
        }
      }
    }

    await this.recordSnapshot(book, resource, branch, dcsCommitSha, built.rowCount, dcsSkippedReason, prNumber, prError, chapterLabel);

    return {
      book,
      resource,
      rowCount: built.rowCount,
      bytes: built.content.length,
      r2Key,
      branch,
      dcsCommitSha,
      dcsChanged,
      dcsSkippedReason,
      prNumber,
      prReason,
      heldForReview: built.heldForReview,
    };
    } finally {
      if (leaseId) await releaseExportLease(this.env, leaseId).catch(() => {});
    }
  }

  // Export one (resource × top-level dir) of tW/tA articles. The article
  // analogue of exportOne: render target_md files from D1 → R2 backup →
  // safety-rail guards → single batch commit → PR → snapshot. See
  // docs/design/tw-ta-translation-modules.md §5.
  private async exportArticleDir(
    resource: ArticleResource,
    topDir: string,
    instanceId: string,
    dcsAllowed: boolean,
  ): Promise<ArticleStepResult> {
    const label = articleStepLabel(resource, topDir);
    const { files, count } = await renderArticleFiles(this.env, resource, topDir);

    if (count === 0) {
      await this.recordSnapshot(label, resource, null, null, 0, "no_units");
      return {
        label, resource, topDir,
        fileCount: 0, committedCount: 0,
        branch: null, dcsCommitSha: null, dcsSkippedReason: "no_units", prNumber: null,
      };
    }

    const cfg = await getProjectConfig(this.env);
    const repo = resource === "tw" ? cfg.repos.tw : cfg.repos.ta;
    const owner = exportOwnerFor(this.env, cfg);
    const branch = buildExportBranch(label, []);

    // R2 backup: one JSON bundle of {path: content} for the whole dir (not one
    // object per file — that would be hundreds of R2 puts). Recoverable if the
    // DCS commit later fails, same role as the verse path's per-file R2 write.
    const r2Key = `exports/${instanceId}/articles/${label}.json`;
    await this.env.BLOBS.put(
      r2Key,
      JSON.stringify({ resource, topDir, files }),
      { httpMetadata: { contentType: "application/json" } },
    );

    let dcsCommitSha: string | null = null;
    let dcsSkippedReason: string | null = null;
    let committedCount = 0;
    let prNumber: number | null = null;
    let prError: string | null = null;
    // The branch reported in the result: null until we either commit to it or
    // do a dry run (which reports the would-be branch, for parity with the verse
    // exportOne). A guard skip leaves it null — nothing was committed there.
    let resultBranch: string | null = null;

    const done = (): ArticleStepResult => ({
      label, resource, topDir,
      fileCount: count, committedCount,
      branch: resultBranch,
      dcsCommitSha, dcsSkippedReason, prNumber,
    });

    if (!dcsAllowed) {
      dcsSkippedReason = this.env.DCS_SERVICE_TOKEN ? "dry_run" : "no_service_token";
      resultBranch = branch; // report the would-be branch (matches exportOne's dry return)
      await this.recordSnapshot(label, resource, branch, null, count, dcsSkippedReason, null, null);
      return done();
    }

    // Safety rail — the article carry-over of the verse export's shrink guard:
    // the backstop against a truncated / partial D1 read shipping a destructive
    // shrink (the twl_PSA clobber signature). Baseline = the file count THIS
    // export system last successfully committed for this (label, resource),
    // from export_snapshots — NOT the target repo's current .md count. Two
    // reasons this is the right baseline: (1) the intent is "don't drop
    // PREVIOUSLY-EXPORTED files," which our own last export count measures
    // exactly; (2) a GL target repo may be provisioned by seeding the full
    // English article set, so its live .md count is NOT what we exported —
    // comparing against it would false-block every early export (a handful
    // translated vs ~1,000 English files). The verse path's SHA-watermark
    // freshness gate has no article analogue: there is no article DCS→D1
    // reimport loop (import-articles.mjs only seeds source_md) and the target
    // has no out-of-band writer (only this export writes it, via a PR). First
    // export (no prior successful snapshot) → nothing to protect → allowed.
    const prevExported = await this.lastArticleExportCount(label, resource);
    if (prevExported != null && shrinkRefused(count, prevExported)) {
      const detail = `shrink_${prevExported - count}_of_${prevExported}`;
      await this.recordArticleGuardAlert(label, resource, repo, detail);
      dcsSkippedReason = `shrink_guard:${detail}`;
      await this.recordSnapshot(label, resource, null, null, count, dcsSkippedReason);
      return done();
    }

    const dcsCfg = { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner, repo, branch };
    resultBranch = branch; // committing to it now
    const message = `bible-editor export: ${label} (${count} files) → ${branch} (${instanceId})`;
    const commit = await commitFilesToDcs(dcsCfg, files, message);
    dcsCommitSha = commit.commitSha || null;
    committedCount = commit.committedCount;
    if (!commit.changed) dcsSkippedReason = "unchanged"; // render already on the branch

    // PR maintenance — runs whether or not THIS run changed the branch. Since
    // count > 0 here, `commitFilesToDcs` always reset/created the branch
    // (branchTouched), and the branch carries unmerged article translations
    // either way. door43's frozen-merge-base bug means resetExportBranchToMaster
    // can't actually re-base a long-lived branch (it 409s and only confirms the
    // ref exists), so a PR that isn't periodically "update-branch"ed drifts to
    // mergeable:false — hence we ensure + update on unchanged runs too, not just
    // when the content changed. Unlike the verse path we do NOT close on
    // unchanged: an article "unchanged" PR is NOT empty — it still holds the
    // translations awaiting the publisher (only merging it lands them on master).
    // No auto-merge: articles have no post-export validator; release-gating on
    // completeness belongs to the future gl-publisher (design §5). Best-effort —
    // the commit already landed, so a PR failure must not fail the step.
    if (commit.branchTouched) {
      try {
        const pr = await ensureDcsPr(
          dcsCfg,
          `bible-editor: ${resource.toUpperCase()} ${topDir} → master`,
          `Auto-opened by the bible-editor nightly export. Holds the latest ${resource.toUpperCase()} ` +
            `article translations under \`${topDir}\`. Release-gating on completeness / checking level ` +
            `is left to the publisher.`,
        );
        prNumber = pr.number;
        if (pr.number != null) {
          try {
            const upd = await updateDcsPrBranch(dcsCfg, pr.number);
            if (!upd.ok) {
              console.log("export article PR update-branch skipped", {
                label, repo, pr: pr.number, status: upd.status, detail: upd.detail,
              });
            }
          } catch (e) {
            console.error("export article PR update-branch failed", {
              label, repo, pr: pr.number, error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      } catch (e) {
        prError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        console.error("export article ensure-PR failed", { label, repo, branch, error: prError });
        await this.recordPrFailureAlert(label, resource, repo, branch, prError);
      }
    }

    await this.recordSnapshot(label, resource, branch, dcsCommitSha, count, dcsSkippedReason, prNumber, prError);
    return done();
  }

  // The file count THIS export system last SUCCESSFULLY committed for a
  // (label, resource) — the shrink guard's baseline. `commit_sha IS NOT NULL`
  // is the success predicate (same one contributorsFor uses). null when there's
  // no prior successful export (first run → nothing to protect). Using our own
  // export history, not the target repo's live file count, is what keeps the
  // guard from false-blocking when the target was seeded with English articles.
  private async lastArticleExportCount(
    label: string,
    resource: ArticleResource,
  ): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT rows_exported FROM export_snapshots
        WHERE book = ?1 AND resource = ?2 AND commit_sha IS NOT NULL
        ORDER BY committed_at DESC LIMIT 1`,
    )
      .bind(label, resource)
      .first<{ rows_exported: number | null }>();
    return row?.rows_exported ?? null;
  }

  // Banner alert when an article export step is blocked by the shrink guard (a
  // render that would drop a large fraction of the files we last exported — the
  // truncated/partial-D1 signature). Same replace-undismissed shape as
  // recordShrinkSkipAlert.
  private async recordArticleGuardAlert(
    label: string,
    resource: ArticleResource,
    repo: string,
    detail: string,
  ): Promise<void> {
    const source = `export_article_guard:${label}`;
    const message =
      `Benjamin — nightly export BLOCKED ${resource.toUpperCase()} articles (\`${label}\` → ${repo}): ${detail}. ` +
      `The render has far fewer files than the last successful export of this set (truncated/partial D1 read) — ` +
      `refusing to shrink it. Re-check the article_units data, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Live active generation for a bible version (lit→ULT, sim→UST); 1 for OL /
  // unknown. Reads uncached D1 lane state — never the project-config isolate
  // cache — so a concurrent replacement activation is seen immediately.
  private async activeGenerationFor(bibleVersion: string): Promise<number> {
    const lane = laneForBibleVersion(bibleVersion);
    if (!lane) return 1;
    const st = await getLaneState(this.env, lane);
    return st?.active_generation ?? 1;
  }

  // Re-check the export fencing token before a mutating DCS call and throw if it
  // no longer holds (lease released/expired/abandoned, superseding lease, or the
  // lane became exports_blocked by a replacement). Non-scripture resources have
  // no lane/lease, so they short-circuit as always-valid.
  private async assertFencingOrThrow(lane: LaneKey | null, token: string | null): Promise<void> {
    if (!lane || !token) return;
    const valid = await verifyExportFencingToken(this.env, lane, token);
    if (!valid) throw new Error("fencing_token_superseded");
  }

  // The foreign chapter set for a (book, tn|tq): chapters whose rows were
  // sourced off the org's own repo — the whole-book book_imports marker
  // (aquifer:… / source:…) plus the #103 range overrides, resolved by the same
  // helpers the old pair-level skip used (heldOutChapters, bookSource.ts).
  // Drives the per-row publish gate in buildResource. null = nothing foreign.
  private async foreignNoteChapters(
    book: string,
    resource: BookSourceResource,
  ): Promise<HeldOut | null> {
    const cfg = await getProjectConfig(this.env);
    const prov = await this.env.DB.prepare(
      `SELECT tn_source, tq_source FROM book_imports WHERE book = ?1`,
    )
      .bind(book)
      .first<{ tn_source: string | null; tq_source: string | null }>();
    const marker = resource === "tn" ? prov?.tn_source ?? null : prov?.tq_source ?? null;
    const held = await heldOutChapters(this.env, cfg, book, resource, marker);
    return held.all || held.ranges.length > 0 ? held : null;
  }

  private async buildResource(
    book: string,
    resource: Resource,
    scriptureGen: number,
    // Chapter-scoped export: restrict the render to this inclusive chapter
    // range (tn/tq/twl only — ult/ust never pass this). `chapter` is stored
    // as 0 for the "front" pseudo-reference (see importParsers.ts refParts),
    // so a range starting at 1 or above naturally excludes front:* rows —
    // consistent with exportChapterMerge.ts's chapterOfReference.
    chapters?: ChapterRange,
  ): Promise<{ content: string; rowCount: number; heldForReview: number; sortOrderUpdates: Array<{ id: string; sort_order: number }> }> {
    const db = this.env.DB;
    if (resource === "tn" || resource === "tq") {
      const chapterClause = chapters ? " AND chapter BETWEEN ?2 AND ?3" : "";
      const bindArgs: unknown[] = chapters ? [book, chapters.start, chapters.end] : [book];
      // trashed_at IS NULL (tn only) excludes notes pending deletion. The
      // nightly cron promotes trash -> deleted_at before this Workflow's steps
      // read, but this guard also covers anything trashed mid-run (after
      // finalize, before this book's export step).
      const rs = resource === "tn"
        ? await db
            .prepare(
              `SELECT * FROM tn_rows WHERE book = ?1 AND deleted_at IS NULL AND trashed_at IS NULL${chapterClause}
               ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
            )
            .bind(...bindArgs)
            .all<TnRow>()
        : await db
            .prepare(
              `SELECT * FROM tq_rows WHERE book = ?1 AND deleted_at IS NULL${chapterClause}
               ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
            )
            .bind(...bindArgs)
            .all<TqRow>();
      const fields = resource === "tn" ? (["note", "tags"] as const) : (["question", "response"] as const);
      // Provenance-aware export gate (publishGate.ts, ux-simplification §1.4):
      // own-provenance rows keep the migration-0049 review-state gate (a
      // non-validated AI draft ships its pre-draft snapshot, never DCS-bound
      // draft content); rows on FOREIGN-sourced chapters additionally require
      // either 'validated' (live content) or a usable snapshot — anything else
      // is OMITTED from the render and counted as held-for-review. Omission
      // shrinks the render; over a populated master that is the shrink guard's
      // territory, by design.
      const foreign = await this.foreignNoteChapters(book, resource);
      let heldForReview = 0;
      const gated: Array<TnRow | TqRow> = [];
      for (const r of rs.results) {
        const { row, legacy } = gateTsvRowForPublish(r, fields, foreign);
        if (row == null) {
          heldForReview++;
          continue;
        }
        if (legacy) {
          console.log(`export gate: ${resource} ${book}/${r.id} is ${r.translation_state} with no pre-draft snapshot (legacy) — exporting current content`);
        }
        gated.push(row);
      }
      if (heldForReview > 0) {
        console.log(`export gate: ${resource} ${book} held ${heldForReview} foreign-sourced row(s) for review (not validated, no snapshot) — omitted from render`);
      }
      // Zero gated rows: a whole-book render returns "" (unchanged — exportOne
      // reads that as no_rows and skips the commit entirely). A CHAPTER render
      // must not collapse to "" the same way — a chapter whose rows were all
      // deleted needs a header-only render so the merge (exportChapterMerge.ts)
      // can remove master's in-range rows, subject to the range shrink guard
      // (chapterShrinkRefused) rather than silently no-op'ing the deletion.
      const content = gated.length === 0
        ? chapters
          ? (resource === "tn" ? buildTnTsv([]) : buildTqTsv([]))
          : ""
        : resource === "tn"
          ? buildTnTsv(gated as TnRow[])
          : buildTqTsv(gated as TqRow[]);
      return { content, rowCount: gated.length, heldForReview, sortOrderUpdates: [] };
    }
    if (resource === "twl") {
      const chapterClause = chapters ? " AND chapter BETWEEN ?2 AND ?3" : "";
      const bindArgs: unknown[] = chapters ? [book, chapters.start, chapters.end] : [book];
      const rs = await db
        .prepare(
          `SELECT * FROM twl_rows WHERE book = ?1 AND deleted_at IS NULL${chapterClause}
           ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
        )
        .bind(...bindArgs)
        .all<TwlRow>();
      // Restrict the ULT verses used for ordering to the same chapter range —
      // twl_rows outside the range aren't rendered, so ordering context from
      // other chapters would be unused anyway, but scoping the query keeps
      // sortOrderUpdates (derived below from these same rows) naturally
      // confined to the range too.
      const ultChapterClause = chapters ? " AND chapter BETWEEN ?4 AND ?5" : "";
      const ultBindArgs: unknown[] = chapters
        ? [book, "ULT", scriptureGen, chapters.start, chapters.end]
        : [book, "ULT", scriptureGen];
      const ultVerses = await db
        .prepare(
          `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3${ultChapterClause}
           ORDER BY chapter, verse`,
        )
        .bind(...ultBindArgs)
        .all<VerseRow>();
      if (rs.results.length === 0) {
        // See the tn/tq comment above: a whole-book render stays "" (no_rows,
        // skip), a chapter render needs a header-only TSV so the merge can
        // remove master's in-range rows.
        const content = chapters ? buildTwlTsv([]).tsv : "";
        return { content, rowCount: 0, heldForReview: 0, sortOrderUpdates: [] };
      }
      const result = buildTwlTsv(rs.results, {
        book,
        bibleVersion: "ULT",
        headers: null,
        verses: ultVerses.results,
      });
      return {
        content: result.tsv,
        rowCount: rs.results.length,
        heldForReview: 0,
        sortOrderUpdates: result.sortOrderUpdates,
      };
    }
    // ult / ust
    const bibleVersion = resource.toUpperCase();
    const rs = await db
      .prepare(
        `SELECT * FROM verses WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3
         ORDER BY chapter, verse`,
      )
      .bind(book, bibleVersion, scriptureGen)
      .all<VerseRow>();
    if (rs.results.length === 0) return { content: "", rowCount: 0, heldForReview: 0, sortOrderUpdates: [] };
    const headersRow = await db
      .prepare(`SELECT headers_json FROM book_usfm_meta WHERE book = ?1 AND bible_version = ?2 AND source_generation = ?3`)
      .bind(book, bibleVersion, scriptureGen)
      .first<{ headers_json: string }>();
    let headers: unknown[] | null = null;
    if (headersRow) {
      try {
        const parsed = JSON.parse(headersRow.headers_json);
        if (Array.isArray(parsed)) headers = parsed;
      } catch {
        headers = null;
      }
    }
    return {
      content: buildUsfm({ book, bibleVersion, headers, verses: rs.results }),
      rowCount: rs.results.length,
      heldForReview: 0,
      sortOrderUpdates: [],
    };
  }

  // Human contributors to one resource of one book, in first-edit order.
  // Drives the export branch name. The source filter keeps human edits: NULL
  // (web app) and 'chat' (a chat reviewer, mcpTools.ts), and drops AI-pipeline
  // and reimport writes (see migration 0010).
  //
  //   tn/tq/twl → edit_log.kind matches the resource directly.
  //   ult/ust   → kind='verse'; the bible version lives in the last segment of
  //               row_key ('{book}/{ch}/{v}/{VERSION}'), so match by suffix.
  private async contributorsFor(book: string, resource: Resource): Promise<string[]> {
    const isBible = resource === "ult" || resource === "ust";
    // Only include editors who touched this resource since the last successful
    // export (commit_sha IS NOT NULL). Using COALESCE(..., 0) means "include
    // all edits" when no successful export exists yet.
    const sql = isBible
      ? `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = 'verse' AND e.book = ?1 AND (e.source IS NULL OR e.source = 'chat')
            AND e.row_key LIKE ?2
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?1 AND resource = ?3 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`
      : `SELECT u.dcs_username AS username, MIN(e.created_at) AS first_at
           FROM edit_log e JOIN users u ON u.id = e.user_id
          WHERE e.kind = ?1 AND e.book = ?2 AND (e.source IS NULL OR e.source = 'chat')
            AND e.created_at > COALESCE(
              (SELECT committed_at FROM export_snapshots
                WHERE book = ?2 AND resource = ?1 AND commit_sha IS NOT NULL
                ORDER BY committed_at DESC LIMIT 1),
              0
            )
          GROUP BY u.id
          ORDER BY first_at ASC, u.dcs_username ASC`;
    const stmt = isBible
      ? this.env.DB.prepare(sql).bind(book, `${book}/%/${resource.toUpperCase()}`, resource)
      : this.env.DB.prepare(sql).bind(resource, book);
    const rs = await stmt.all<{ username: string; first_at: number }>();
    return rs.results.map((r) => r.username);
  }

  // Apply TWL sort order updates computed during export. Updates only rows in
  // verses where reordering happened, preserving the alignment-based sequence
  // in the database for future operations. This is idempotent: multiple calls
  // with the same updates produce the same result.
  private async applyTwlSortOrderUpdates(
    book: string,
    updates: Array<{ id: string; sort_order: number }>,
  ): Promise<void> {
    // Delegates to the shared helper (twlSortOrderApply.ts) so the export and the
    // reimport canonical post-pass write sort_order identically.
    await applyTwlSortOrderUpdates(this.env.DB, book, updates);
  }

  // Delete branches this export's branch replaces. Sources:
  //   1. export_snapshots history — any prior branch we recorded for this
  //      (book, resource) that differs from the current one (a contributor
  //      joined/left and the name changed).
  //   2. The legacy live-snapshot branch.
  // Best-effort: per-branch errors are logged and swallowed so a prune failure
  // never fails the export step (which would also retry the commit).
  private async pruneSupersededBranches(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    keepBranch: string,
    lane: LaneKey | null = null,
    fencingToken: string | null = null,
  ): Promise<void> {
    // Steady-state short-circuit: when the most recent snapshot already
    // recorded this same branch, any superseded branches were already pruned
    // (or 403ed — the service token lacks branch-delete) on a previous night.
    // Skipping stops the per-step DELETE calls that fail forever.
    try {
      const last = await this.env.DB.prepare(
        `SELECT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL
          ORDER BY id DESC LIMIT 1`,
      )
        .bind(book, resource)
        .first<{ branch: string }>();
      if (last?.branch === keepBranch) return;
    } catch (e) {
      console.error("prune: last-snapshot query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    let stale: string[] = [];
    try {
      const rs = await this.env.DB.prepare(
        `SELECT DISTINCT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch IS NOT NULL AND branch <> ?3`,
      )
        .bind(book, resource, keepBranch)
        .all<{ branch: string }>();
      stale = rs.results.map((r) => r.branch);
    } catch (e) {
      console.error("prune: history query failed", { book, resource, error: e instanceof Error ? e.message : String(e) });
    }
    const targets = [...new Set([...stale, LEGACY_EXPORT_BRANCH])].filter((b) => b && b !== keepBranch);
    for (const b of targets) {
      try {
        // F4 (revised): a whole-book (nightly) prune is keyed only by
        // (book, resource), so without this check it would delete a SIBLING
        // branch a manual chapter-scoped export is still accumulating
        // chapters on — orphaning that unmerged work. PR state (open vs
        // merged/closed) is deliberately NOT part of this check anymore: a
        // chapter branch's PR merging or closing on Door43 doesn't mean the
        // branch is done being reused by reuseChapterBranch (a later chapter
        // run can still find it via export_snapshots and build on it), and a
        // chapter branch must never be auto-deleted by the nightly at all —
        // only a human, on Door43, retires one. Any failure to determine
        // this fails toward SKIPPING the delete (safe — a stale branch left
        // one more night is harmless; deleting a live chapter export is not).
        if (await this.isChapterExportBranch(book, resource, b)) {
          console.log("prune: skipping branch — chapter export branch", { book, resource, branch: b });
          continue;
        }
        // Re-verify fencing before every branch DELETE — a mid-loop activation
        // must not let us keep mutating DCS under a superseded token.
        await this.assertFencingOrThrow(lane, fencingToken);
        await deleteDcsBranch(
          { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner, repo },
          b,
        );
      } catch (e) {
        if (e instanceof Error && e.message === "fencing_token_superseded") throw e;
        console.error("prune: branch delete failed", { repo, branch: b, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // F4 helper (revised): true when `branch` is a chapter export branch for
  // this (book, resource) — regardless of PR state. A branch is off-limits to
  // the nightly prune when EITHER export_snapshots recorded it with a chapter
  // label for this (book, resource), OR its name carries the `-bec-`
  // chapter-export infix (buildChapterExportBranch) — the second check
  // catches a chapter branch that was created but never made it into
  // export_snapshots (a crash between branch-creation and the snapshot
  // write). PR state is deliberately not consulted: a chapter branch's PR
  // merging or closing on Door43 does not make the branch fair game for
  // automatic deletion — only a human retires one, on Door43. Fails toward
  // true (protect the branch from deletion) on any lookup error — the safe
  // direction, since keeping a possibly-stale branch one more night is
  // harmless but deleting a live chapter export is not.
  private async isChapterExportBranch(
    book: string,
    resource: Resource,
    branch: string,
  ): Promise<boolean> {
    if (branch.includes("-bec-")) return true;
    try {
      const row = await this.env.DB.prepare(
        `SELECT 1 FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND branch = ?3 AND chapters IS NOT NULL
          LIMIT 1`,
      )
        .bind(book, resource, branch)
        .first();
      return !!row;
    } catch (e) {
      console.error("prune: chapter-branch check failed; not deleting", {
        book, resource, branch, error: e instanceof Error ? e.message : String(e),
      });
      return true;
    }
  }

  // Recover a conflicted export PR (updateDcsPrBranch 409). D1 is authoritative,
  // so rebuild the drifted branch as a clean child of CURRENT master carrying
  // the same already-rendered file, then re-open the PR. Reuses `content`
  // (already past the freshness + shrink gates in exportOne — never re-renders),
  // so this can't smuggle a stale/partial render past those guards. Gated on the
  // admin token (DCS_TOKEN); without it we can't delete the branch, so we just
  // alert and leave the conflicted PR for a human (today's behavior). Best-effort
  // throughout: any failure alerts rather than failing the export step (the
  // commit + snapshot already succeeded). Returns the new PR info to record, or
  // null when nothing changed. See docs/export-rebase-fix.md.
  //
  // Whole-book only (F1): chapter-mode exports never call this. Deleting and
  // recreating the branch from master would discard every earlier chapter
  // run's rows already merged onto it, keeping only the range that just
  // conflicted — see exportOne's updateDcsPrBranch 409 handling, which alerts
  // and leaves the branch/PR untouched for a human instead.
  private async recoverConflictedBranch(
    book: string,
    resource: Resource,
    owner: string,
    repo: string,
    branch: string,
    dcsCfg: { baseUrl: string; token: string; owner: string; repo: string; branch: string; baseRef?: string },
    filename: string,
    content: string,
    message: string,
    lane: LaneKey | null = null,
    fencingToken: string | null = null,
  ): Promise<{ prNumber: number | null; prReason: string; commitSha: string | null } | null> {
    const adminToken = this.env.DCS_TOKEN;
    if (!adminToken) {
      await this.recordPrConflictAlert(book, resource, repo, branch, "no_admin_token");
      return null;
    }
    try {
      await this.assertFencingOrThrow(lane, fencingToken);
      const res = await recreateExportBranchFromMaster({
        baseUrl: dcsCfg.baseUrl,
        token: adminToken,
        owner,
        repo,
        branch,
        baseRef: dcsCfg.baseRef,
        beforeMutation: fencingToken
          ? () => this.assertFencingOrThrow(lane, fencingToken)
          : undefined,
      });
      if (!res.rebuilt) {
        await this.recordPrConflictAlert(book, resource, repo, branch, res.detail);
        return null;
      }
      // Branch is now master HEAD. Re-commit the rendered D1 file (forceBranch:
      // we know it differs from master — that's what conflicted) → one commit,
      // child of master. The delete auto-closed the old PR, so ensureDcsPr mints
      // a fresh one whose diff is exactly the D1 delta.
      await this.assertFencingOrThrow(lane, fencingToken);
      const recommit = await commitToDcs(
        {
          ...dcsCfg,
          beforeMutation: fencingToken
            ? () => this.assertFencingOrThrow(lane, fencingToken)
            : undefined,
        },
        filename,
        content,
        message,
        { forceBranch: true },
      );
      await this.assertFencingOrThrow(lane, fencingToken);
      const pr = await ensureDcsPr(
        dcsCfg,
        `bible-editor: ${book} ${resource} → master`,
        `Rebuilt by the bible-editor nightly export: \`${branch}\` had drifted into a merge ` +
          `conflict with master, so it was recreated as a clean child of current master carrying ` +
          `the authoritative D1 render of ${book} ${resource.toUpperCase()}. Any rows present only on ` +
          `master (not in D1) are intentionally dropped — D1 is authoritative.`,
      );
      await this.recordBranchRebuiltAlert(book, resource, repo, branch, pr.number);
      return { prNumber: pr.number, prReason: `rebuilt:${pr.reason}`, commitSha: recommit.commitSha || null };
    } catch (e) {
      if (e instanceof Error && e.message === "fencing_token_superseded") throw e;
      const detail = e instanceof Error ? e.message : String(e);
      console.error("export conflict-recovery failed", { book, resource, repo, branch, error: detail });
      await this.recordPrConflictAlert(book, resource, repo, branch, detail.slice(0, 120));
      return null;
    }
  }

  private async recordSnapshot(
    book: string,
    resource: string,
    branch: string | null,
    commitSha: string | null,
    rowsExported: number,
    skippedReason: string | null,
    prNumber: number | null = null,
    prError: string | null = null,
    // Chapter label ("13" or "13-14") for a chapter-scoped export; null (the
    // default) for a whole-book export — every existing call site is
    // unaffected.
    chapters: string | null = null,
  ): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO export_snapshots (book, resource, branch, commit_sha, rows_exported, error, pr_number, pr_error, chapters)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(book, resource, branch, commitSha, rowsExported, skippedReason, prNumber, prError, chapters)
      .run();
  }

  // Banner alert when the freshness gate skips an export to avoid clobbering
  // master. Same replace-undismissed shape as recordPrFailureAlert.
  private async recordStaleSkipAlert(
    book: string,
    resource: Resource,
    masterSha: string | null,
    watermark: string | null,
  ): Promise<void> {
    const source = `export_stale:${book}:${resource}`;
    const message =
      `Benjamin — nightly export skipped ${book} ${resource.toUpperCase()} to avoid reverting master ` +
      `(D1 is behind: master ${(masterSha ?? "unknown").slice(0, 8)} vs synced ${(watermark ?? "none").slice(0, 8)}). ` +
      `The pre-export sync didn't catch up; re-run the sync for ${book}, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Fetch destination master's current TSV row count and decide whether this
  // render would shrink it dangerously (see export.ts exportTsvShrinkRefused).
  // Always reads the SAME owner/repo the commit will target. The read goes
  // through fetchDcsMasterText, which verifies completeness independently of
  // Content-Length (cross-checking the Gitea contents API's own size for the
  // file; see issue #494 — relying on Content-Length alone left a
  // no-Content-Length truncated fetch reading as a legitimately smaller
  // master, which a D1 partial from the SAME correlated truncation could then
  // wave through as "no shrink"), so a short read lands on the fail-closed
  // "unreadable" branch below instead of being compared as content.
  // Shared fetch+gate for the whole-file TSV shrink guard: resolve the
  // resource's DCS file path for this project config, then fetch and
  // classify the destination master read (masterFetchGate). The chapter-
  // scoped merge path uses fetchResourceBaseWithSha instead (below) — it
  // needs the file's blob sha too, for the merge's compare-and-swap guard.
  private async fetchResourceMasterGate(
    book: string,
    resource: Resource,
    destOwner: string,
    destRepo: string,
    baseRef: string,
  ): Promise<
    | { kind: "no_file" }
    | { kind: "bootstrap" }
    | { kind: "unreadable" }
    | { kind: "content"; text: string }
  > {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { kind: "no_file" };
    return masterFetchGate(await fetchDcsMasterText(this.env, destOwner, destRepo, file.path, baseRef));
  }

  // Sibling of fetchResourceMasterGate that also returns the file's blob sha
  // at the given ref — the chapter-scoped merge (mergeChapterAgainstBase)
  // needs it as the compare-and-swap token for commitToDcs's expectedSha
  // guard (F2). `bootstrap` (no file at this ref yet) carries no sha; the
  // caller reads that as "merge against nothing" (expectedSha: null).
  private async fetchResourceBaseWithSha(
    book: string,
    resource: Resource,
    destOwner: string,
    destRepo: string,
    baseRef: string,
  ): Promise<
    | { kind: "no_file" }
    | { kind: "bootstrap" }
    | { kind: "unreadable" }
    | { kind: "content"; text: string; sha: string | null }
  > {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { kind: "no_file" };
    const res = await fetchDcsFileWithSha(this.env, destOwner, destRepo, file.path, baseRef);
    const gate = masterFetchGate(res);
    return gate.kind === "content" ? { kind: "content", text: gate.text, sha: res.sha } : gate;
  }

  // Reuse a still-live CHAPTER export branch instead of the freshly-computed
  // contributor-derived `-bec-` name (F1a/F5, revised). Looks at the most
  // recent export_snapshots row for this (book, resource) that is ITSELF a
  // chapter-scoped export (chapters IS NOT NULL) and recorded both a branch
  // and a commit. PR state is deliberately NOT part of this decision anymore
  // (that's step 3's job, not this one's) — this only answers "is there a
  // prior chapter branch, and does it still exist on DCS": if it does, reuse
  // it so an earlier chapter run's rows (outside this range) are carried
  // forward by the merge; if it doesn't (deleted, or never existed), fall
  // back to `defaultBranch`. Restricting the lookup to `chapters IS NOT NULL`
  // means a whole-book `-be-` branch can never be picked up here even if it
  // happens to be the most recent snapshot for this (book, resource) — chapter
  // and whole-book exports now live in disjoint branch families (`-bec-` vs
  // `-be-`), and reuse must never cross that boundary. The `branch LIKE
  // '%-bec-%'` clause is a belt-and-suspenders check on the branch NAME
  // itself: an export_snapshots row from before the `-be-` → `-bec-` chapter
  // rename can still have `chapters IS NOT NULL` (chapter-scoped) while its
  // `branch` column holds a pre-rename `-be-`-family name, and adopting that
  // legacy branch here would merge this run onto the SAME branch family the
  // nightly whole-book export (and its pruneSupersededBranches/auto-merge)
  // treats as its own — exactly the cross-family collision the rename was
  // meant to prevent. Falls back to `defaultBranch` on any lookup failure —
  // a lookup failure must never block the export, it just means this run
  // gets a fresh branch like before.
  private async reuseChapterBranch(
    book: string,
    resource: Resource,
    dcsOwner: string,
    dcsRepo: string,
    defaultBranch: string,
  ): Promise<string> {
    try {
      const prior = await this.env.DB.prepare(
        `SELECT branch FROM export_snapshots
          WHERE book = ?1 AND resource = ?2 AND chapters IS NOT NULL
            AND branch IS NOT NULL AND commit_sha IS NOT NULL
            AND branch LIKE '%-bec-%'
          ORDER BY committed_at DESC, id DESC LIMIT 1`,
      )
        .bind(book, resource)
        .first<{ branch: string }>();
      if (!prior?.branch || prior.branch === defaultBranch) return defaultBranch;
      if (!(await dcsBranchExists(
        { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner: dcsOwner, repo: dcsRepo },
        prior.branch,
      ))) {
        console.log("chapter export: prior branch no longer exists on DCS; using the contributor-derived branch", {
          book, resource, priorBranch: prior.branch, branch: defaultBranch,
        });
        return defaultBranch;
      }
      console.log("chapter export: reusing prior chapter branch", {
        book, resource, branch: prior.branch,
      });
      return prior.branch;
    } catch (e) {
      // Fail closed, like the branch-exists checks in the merge and
      // update-first steps: falling back to the contributor-derived name here
      // could start a fresh branch from master while a live -bec- branch still
      // holds unmerged sibling chapters, stranding them. The caller turns this
      // into a terminal chapter_merge:branch_lookup_failed skip.
      console.error("chapter export: branch-reuse lookup failed; refusing to guess a branch", {
        book, resource, error: e instanceof Error ? e.message : String(e),
      });
      throw new Error("chapter_merge:branch_lookup_failed");
    }
  }

  // Read-base + merge for the chapter-scoped export (F1b/F2). Reads the MERGE
  // BASE from the export branch itself when it already exists on DCS (so an
  // earlier chapter run's rows, outside this range, are carried forward by
  // the merge) and falls back to master otherwise. Returns the merged
  // whole-file content plus the base file's blob sha (null = merged against
  // no file — bootstrap) for commitToDcs's compare-and-swap guard, and the
  // raw ChapterMergeResult so the caller can apply the range shrink guard
  // (F4). Reusable by both exportOne's initial attempt/retries and
  // recoverConflictedBranch's post-rebuild remerge.
  private async mergeChapterAgainstBase(
    book: string,
    resource: Resource,
    built: { content: string },
    chapters: ChapterRange,
    dcsOwner: string,
    dcsRepo: string,
    branch: string,
  ): Promise<
    | {
        ok: true;
        content: string;
        expectedSha: string | null;
        merge: ReturnType<typeof mergeTsvChapterRange>;
        // Where the merge base was read from — "master" or the export branch
        // name. F2's whole-file sanity guard only runs when this is the
        // branch: a base read from master by definition can't be behind
        // master, so there is nothing that guard could catch there.
        baseRef: string;
      }
    | { ok: false; reason: string }
  > {
    let branchIsLive: boolean;
    try {
      branchIsLive = await dcsBranchExists(
        { baseUrl: this.env.DCS_BASE_URL, token: this.env.DCS_SERVICE_TOKEN!, owner: dcsOwner, repo: dcsRepo },
        branch,
      );
    } catch (e) {
      // Assuming "not live" on a failed check is unsafe: if the branch IS
      // actually live and carrying an earlier chapter run's rows, merging
      // against master instead would silently drop those rows from this
      // run's push (the exact hazard the branch-reuse/merge-from-branch
      // logic above exists to avoid) — and we'd never notice, because a
      // wrongly-assumed bootstrap/master base looks perfectly clean to every
      // guard below. Fail closed instead: terminal-skip so a human sees the
      // transient failure rather than risking a silent data loss.
      console.error("chapter export: branch-exists check failed; refusing to guess whether it's live", {
        book, resource, branch, error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, reason: "chapter_merge:branch_check_failed" };
    }
    const primaryRef = branchIsLive ? branch : "master";
    const baseGate = await this.fetchResourceBaseWithSha(book, resource, dcsOwner, dcsRepo, primaryRef);
    if (baseGate.kind === "unreadable" || baseGate.kind === "no_file") {
      // no_file = dcsResourceFile has no path for this resource, so we can't
      // know what the base holds; a chapter render must never be pushed as if
      // it were the whole book, so fail closed (the whole-file path allows
      // no_file because it replaces the file regardless).
      return {
        ok: false,
        reason: baseGate.kind === "no_file" ? "chapter_merge:no_master_path" : "shrink_guard:master_unreadable",
      };
    }
    let baseOrigin = primaryRef;
    let baseText = baseGate.kind === "content" ? baseGate.text : null;
    let expectedSha = baseGate.kind === "content" ? baseGate.sha : null;

    // F3: a LIVE branch missing the file (404 ON THE BRANCH) must not be read
    // as a genuine bootstrap — master may already carry a whole-book file the
    // branch simply hasn't picked up yet (e.g. this resource's first-ever
    // commit landed on master out of band, or a prior recovery rebuilt the
    // branch before this resource existed there). Re-read from master for the
    // merge base text; `expectedSha` stays null either way — the branch
    // itself holds no file at this path, so commitToDcs's CAS check still
    // expects none there and POSTs (a genuine race — something else creating
    // the file on the branch between this read and the write — is still
    // caught as staleBase). Only a 404 on BOTH branch and master is a real
    // bootstrap.
    if (branchIsLive && baseGate.kind === "bootstrap") {
      const masterGate = await this.fetchResourceBaseWithSha(book, resource, dcsOwner, dcsRepo, "master");
      if (masterGate.kind === "unreadable" || masterGate.kind === "no_file") {
        return {
          ok: false,
          reason: masterGate.kind === "no_file" ? "chapter_merge:no_master_path" : "shrink_guard:master_unreadable",
        };
      }
      if (masterGate.kind === "content") {
        baseText = masterGate.text;
        baseOrigin = "master";
      }
      // else masterGate.kind === "bootstrap": neither branch nor master has
      // the file — baseText/expectedSha stay null (real bootstrap).
      expectedSha = null;
    }

    try {
      const merge = mergeTsvChapterRange(baseText, built.content, chapters);
      return { ok: true, content: merge.content, expectedSha, merge, baseRef: baseOrigin };
    } catch (e) {
      // A merge failure (header mismatch, an out-of-range rendered row, a
      // duplicate ID) means either the base or the range render is in a
      // state we must not push over — a terminal skip for this step, not a
      // thrown/retried error (retrying would just fail identically).
      const msg = e instanceof Error ? e.message : String(e);
      console.error("export chapter-merge failed", { book, resource, chapters, baseRef: baseOrigin, error: msg });
      return { ok: false, reason: `chapter_merge:${msg}` };
    }
  }

  // mergeChapterAgainstBase + the range shrink guard (chapterShrinkRefused),
  // as ONE step (Finding 2). Every chapter-scoped merge must apply the guard
  // before its content is handed to a commit — this used to be duplicated
  // inline at three call sites (exportOne's initial merge, commitChapterRange's
  // staleBase retry, and recoverConflictedBranch's post-rebuild remerge), and
  // the third copy was missing entirely: a conflict-recovery rebuild could
  // recommit a shrunk range even with shrinkOverride false. All three now call
  // this instead.
  private async mergeAndGuardChapterRange(
    book: string,
    resource: Resource,
    built: { content: string },
    chapters: ChapterRange,
    chapterLabel: string | null,
    dcsOwner: string,
    dcsRepo: string,
    branch: string,
    shrinkOverride: boolean,
  ): Promise<
    | { ok: true; content: string; expectedSha: string | null; merge: ReturnType<typeof mergeTsvChapterRange>; baseRef: string }
    | { ok: false; reason: string }
  > {
    const merged = await this.mergeChapterAgainstBase(book, resource, built, chapters, dcsOwner, dcsRepo, branch);
    if (!merged.ok) return merged;
    const refused = chapterShrinkRefused(merged.merge.renderedRows, merged.merge.masterRowsInRange);
    if (refused && !shrinkOverride) {
      const detail = `chapter_shrink_${merged.merge.masterRowsInRange - merged.merge.renderedRows}_of_${merged.merge.masterRowsInRange}`;
      await this.recordChapterShrinkSkipAlert(book, resource, chapters, merged.merge.renderedRows, merged.merge.masterRowsInRange);
      return { ok: false, reason: `shrink_guard:${detail}` };
    }
    if (refused && shrinkOverride) {
      console.log("chapter export: range shrink guard overridden by admin (shrinkOverride)", {
        book, resource, chapters: chapterLabel,
      });
    }

    // F2 (strict, revised): the range guard above only compares in-range
    // counts against whatever base the merge read (the branch, when one is
    // already live — see mergeChapterAgainstBase). That leaves a gap: if the
    // branch's file is itself behind or sparse relative to master (missing
    // rows master has — an out-of-band edit landed on master, or an earlier
    // recovery rebuilt the branch incompletely), the range guard alone would
    // never notice, because it never looks at rows outside the range. The
    // OLD version of this check compared whole-file ROW COUNTS, which is too
    // loose: a branch that dropped N out-of-range rows while this run's merge
    // happened to also ADD N-or-more in-range rows would net to no shrink at
    // all and sail through. So when the base came from the BRANCH (not
    // master), compare IDENTITY, not count: every one of master's
    // OUT-OF-RANGE row IDs must still be present somewhere in the merged
    // file. This is NOT bypassed by shrinkOverride — shrinkOverride is an
    // admit-a-real-deletion knob for THIS range's own rows (chapterShrinkRefused,
    // above); a master row outside the range going missing is never something
    // this export's range/overwrite intent covers, so there is no legitimate
    // reason to override it.
    if (merged.baseRef !== "master") {
      const masterGate = await this.fetchResourceMasterGate(book, resource, dcsOwner, dcsRepo, "master");
      if (masterGate.kind === "bootstrap" || masterGate.kind === "no_file") {
        // Nothing on master to be behind — skip (e.g. a brand-new book/org).
      } else if (masterGate.kind === "unreadable") {
        return { ok: false, reason: "shrink_guard:master_unreadable" };
      } else {
        const missing = missingOutOfRangeIds(masterGate.text, merged.content, chapters);
        if (missing.length > 0) {
          const reason = `chapter_merge:base_missing_master_rows:${missing.length}`;
          await this.recordChapterBaseMissingRowsAlert(book, resource, chapters, missing);
          return { ok: false, reason };
        }
      }
    }

    return merged;
  }

  // Data-row count of a TSV blob: non-empty lines minus the header, mirroring
  // checkTsvShrink's / parseTsv's model. Shared by the whole-file chapter-mode
  // sanity guard (F2) and (indirectly, via checkTsvShrink) the whole-book path.
  private countTsvDataRows(raw: string): number {
    return Math.max(0, raw.split(/\r?\n/).filter((l) => l.length > 0).length - 1);
  }

  // Commit a chapter-scoped merge with staleBase retry (F2c). Attempts up to
  // 3 times: commit with the current content/expectedSha; if commitToDcs
  // reports staleBase (the base moved since we read it), re-read the base
  // (branch if it exists, else master), re-merge, re-check the range shrink
  // guard, and retry. Exhausting all attempts is a terminal skip, not a
  // thrown error — a persistent racer means this run should quietly stand
  // down, not retry the whole step and alert on every scheduler tick.
  private async commitChapterRange(
    book: string,
    resource: Resource,
    chapters: ChapterRange,
    chapterLabel: string | null,
    built: { rowCount: number; content: string },
    dcsOwner: string,
    dcsRepo: string,
    branch: string,
    dcsCfg: Parameters<typeof commitToDcs>[0],
    filename: string,
    message: string,
    initialContent: string,
    initialExpectedSha: string | null,
    shrinkOverride: boolean,
  ): Promise<{ commit: DcsCommitResult; content: string } | { terminal: StepResult }> {
    const maxAttempts = 3;
    let content = initialContent;
    let expectedSha = initialExpectedSha;
    const terminal = (reason: string): { terminal: StepResult } => ({
      terminal: {
        book, resource, rowCount: built.rowCount, bytes: built.content.length, r2Key: null,
        branch: null, dcsCommitSha: null, dcsChanged: false,
        dcsSkippedReason: reason, prNumber: null, prReason: null,
      },
    });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // preserveBranch: this branch may already carry an earlier chapter
      // run's rows outside this range (see reuseChapterBranch) — never reset
      // it onto master here (Finding 1); commitToDcs still creates it from
      // master if it's genuinely missing.
      const commit = await commitToDcs(dcsCfg, filename, content, message, { expectedSha, preserveBranch: true });
      if (!commit.staleBase) return { commit, content };
      if (attempt >= maxAttempts) {
        const reason = "chapter_merge:base_moved";
        console.error("chapter export: base kept moving; giving up after retries", {
          book, resource, chapters: chapterLabel, attempts: maxAttempts,
        });
        await this.recordSnapshot(book, resource, null, null, built.rowCount, reason, null, null, chapterLabel);
        await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, reason);
        return terminal(reason);
      }
      console.warn("chapter export: base moved (staleBase); re-reading and re-merging", {
        book, resource, chapters: chapterLabel, attempt,
      });
      const remerged = await this.mergeAndGuardChapterRange(
        book, resource, built, chapters, chapterLabel, dcsOwner, dcsRepo, branch, shrinkOverride,
      );
      if (!remerged.ok) {
        await this.recordSnapshot(book, resource, null, null, built.rowCount, remerged.reason, null, null, chapterLabel);
        await this.alertChapterMergeSkipIfNeeded(book, resource, chapterLabel, remerged.reason);
        return terminal(remerged.reason);
      }
      content = remerged.content;
      expectedSha = remerged.expectedSha;
    }
    // Unreachable: the loop always returns by attempt === maxAttempts.
    throw new Error("chapter_merge:retry_loop_exhausted");
  }

  private async checkTsvShrink(
    book: string,
    resource: Resource,
    renderedRows: number,
    destOwner: string,
    destRepo: string,
    baseRef = "master",
  ): Promise<{ ok: boolean; detail: string; masterRows: number | null }> {
    const gate = await this.fetchResourceMasterGate(book, resource, destOwner, destRepo, baseRef);
    if (gate.kind === "no_file") return { ok: true, detail: "no_file", masterRows: null };
    // First export of a new org/book: master has no file yet, so there is
    // nothing to shrink — allow the commit (#235). Any non-404 failure stays
    // fail-closed below.
    if (gate.kind === "bootstrap") {
      // Callers only read `detail` on refusal, so log the pass — it's the only
      // trace that this commit skipped the shrink comparison legitimately.
      console.log("shrink guard: bootstrap (no master file yet)", { book, resource, destOwner, destRepo });
      return { ok: true, detail: "bootstrap_new_file", masterRows: null };
    }
    if (gate.kind === "unreadable") return { ok: false, detail: "master_unreadable", masterRows: null };
    const masterRows = this.countTsvDataRows(gate.text);
    if (exportTsvShrinkRefused(renderedRows, masterRows)) {
      return { ok: false, detail: `shrink_${masterRows - renderedRows}_of_${masterRows}`, masterRows };
    }
    return { ok: true, detail: "ok", masterRows };
  }

  // Fetch destination master's current USFM and decide whether this ULT/UST
  // render would silently drop \zaln word alignment. Always reads the SAME
  // owner/repo/ref the commit will target. Fail closed when master can't be
  // read — the fetch is verified independently of Content-Length the same way
  // checkTsvShrink's is (see issue #494 and fetchDcsMasterText in
  // dcsSources.ts), and an unverifiable master must block rather than let an
  // unchecked render through.
  private async checkUsfmAlignmentShrink(
    book: string,
    resource: Resource,
    renderedUsfm: string,
    destOwner: string,
    destRepo: string,
    baseRef = "master",
  ): Promise<{ ok: boolean; detail: string }> {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file" };
    const gate = masterFetchGate(
      await fetchDcsMasterText(this.env, destOwner, destRepo, file.path, baseRef),
    );
    // First export of a new org/book: no master file, no alignments to lose (#235).
    if (gate.kind === "bootstrap") {
      console.log("alignment guard: bootstrap (no master file yet)", { book, resource, destOwner, destRepo });
      return { ok: true, detail: "bootstrap_new_file" };
    }
    if (gate.kind === "unreadable") return { ok: false, detail: "master_unreadable" };
    const masterUsfm = gate.text;
    const result = usfmAlignmentShrinkRefused(renderedUsfm, masterUsfm);
    if (result.refused) {
      const sample = result.offenders
        .slice(0, 5)
        .map((o) => {
          const shown = o.lostWords.slice(0, 3).map((w) => `"${w}"`).join(",");
          const extra = o.lostWords.length - 3;
          const more = extra > 0 ? ` (+${extra} more)` : "";
          return `${o.ref}: lost alignment on ${shown}${more}`;
        })
        .join("; ");
      return { ok: false, detail: `align_loss_${result.offenders.length}:${sample}` };
    }
    // Master fetched but did not parse: nothing was compared, so this must
    // not surface as detail:"ok" — an absent measurement must never read as
    // "measured clean". Ship decision unchanged (ok:true, as designed for an
    // unprovable loss); only the clean-measurement claim goes.
    if (result.masterUnparseable) {
      return { ok: true, detail: "master_unparseable" };
    }
    return { ok: true, detail: "ok" };
  }

  /** Non-alignment body must match destination for textReadOnly lanes. */
  private async checkLockedTextEquality(
    book: string,
    resource: Resource,
    renderedUsfm: string,
    destOwner: string,
    destRepo: string,
    baseRef: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const cfg = await getProjectConfig(this.env);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file" };
    const destUsfm = await fetchText(dcsRawUrl(this.env, destOwner, destRepo, file.path, baseRef));
    if (destUsfm == null) {
      // Fail closed: without a readable destination we cannot prove body equality.
      return { ok: false, detail: "dest_unreadable" };
    }
    return nonAlignmentUsfmEqual(renderedUsfm, destUsfm);
  }

  private async recordLockedTextDriftAlert(
    book: string,
    resource: Resource,
    detail: string,
  ): Promise<void> {
    const source = `export_locked_text:${book}:${resource}`;
    const message =
      `Benjamin — nightly export blocked ${book} ${resource.toUpperCase()}: textReadOnly lane ` +
      `body drifted from destination (${detail}). Alignment-only changes are fine; text rewrites are not.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Freshness against the repo we will commit to. When source == export, use
  // book_resource_syncs watermarks. When they diverge, use
  // scripture_export_baselines for the export destination tip.
  private async checkMasterFreshness(
    book: string,
    resource: Resource,
    dest?: {
      owner: string;
      repo: string;
      baseRef?: string;
      lane?: LaneKey | null;
    },
  ): Promise<{ ok: boolean; detail: string; masterSha: string | null; watermark: string | null }> {
    const cfg = await getProjectConfig(this.env);
    const src = await resourceSourceRef(this.env, resource as ReimportResource, cfg);
    const file = dcsResourceFile(cfg, book, resource as ReimportResource);
    if (!file) return { ok: true, detail: "no_file", masterSha: null, watermark: null };
    const path = `${file.path}`;
    const destOwner = dest?.owner ?? src.owner;
    const destRepo = dest?.repo ?? src.repo;
    const baseRef = dest?.baseRef ?? src.ref;
    // Owner/repo names are case-insensitive on DCS; baseRef vs src.ref stays
    // an exact git-ref comparison.
    const sameIdentity =
      sameDcsName(destOwner, src.owner) && sameDcsName(destRepo, src.repo) && baseRef === src.ref;

    if (sameIdentity) {
      const watermark = await storedResourceSha(this.env, book, resource, src);
      if (!watermark) return { ok: true, detail: "no_watermark", masterSha: null, watermark: null };
      const masterSha = await fileCommitSha(this.env, src.owner, src.repo, path, src.ref);
      if (!masterSha) return { ok: false, detail: "master_sha_unknown", masterSha: null, watermark };
      if (masterSha === watermark) return { ok: true, detail: "current", masterSha, watermark };
      return { ok: false, detail: "master_ahead", masterSha, watermark };
    }

    // Export destination differs from source: fence on export baselines, not
    // the source watermark (which describes a different repo).
    const lane = dest?.lane ?? null;
    if (!lane) {
      // Non-scripture shouldn't hit diverge via laneExport; fail closed if it does.
      return { ok: false, detail: "export_dest_without_lane", masterSha: null, watermark: null };
    }
    const tipSha = await fileCommitSha(this.env, destOwner, destRepo, path, baseRef);
    const baseline = await this.env.DB.prepare(
      // owner/repo are DCS names (case-insensitive); lane/base_ref/book are not.
      // Migration 0069 made scripture_export_baselines.owner (part of the PK)
      // COLLATE NOCASE, so the bare `owner = ?2` in the ORDER BY tiebreak below
      // is now case-insensitive too, same as the explicit `COLLATE NOCASE` in
      // the WHERE clause — it no longer distinguishes rows by exact casing the
      // way it did when the column was BINARY. That's fine: 0069's preflight
      // aborts the migration if any two rows already differ only by owner
      // casing, so no case-variant duplicate PK can survive into a NOCASE
      // column, and this ORDER BY is left in place only as defense in depth.
      `SELECT base_sha FROM scripture_export_baselines
        WHERE lane = ?1 AND owner = ?2 COLLATE NOCASE AND repo = ?3 COLLATE NOCASE AND base_ref = ?4 AND book = ?5
        ORDER BY (owner = ?2 AND repo = ?3) DESC
        LIMIT 1`,
    )
      .bind(lane, destOwner, destRepo, baseRef, book)
      .first<{ base_sha: string | null }>();
    const watermark = baseline?.base_sha ?? null;
    if (!watermark) {
      // First export: only safe when the destination file is absent. If tipSha
      // is set, the dest already has content we could clobber — refuse until a
      // baseline is explicitly recorded (or tip matches after a sync).
      if (tipSha) {
        return { ok: false, detail: "export_baseline_required", masterSha: tipSha, watermark: null };
      }
      return { ok: true, detail: "no_export_baseline", masterSha: tipSha, watermark: null };
    }
    if (!tipSha) return { ok: false, detail: "export_tip_unknown", masterSha: null, watermark };
    if (tipSha === watermark) return { ok: true, detail: "current", masterSha: tipSha, watermark };
    return { ok: false, detail: "export_ahead", masterSha: tipSha, watermark };
  }

  private async recordExportBaseline(
    lane: LaneKey,
    owner: string,
    repo: string,
    baseRef: string,
    book: string,
    baseSha: string | null,
  ): Promise<void> {
    if (!baseSha) return;
    await this.env.DB.prepare(
      `INSERT INTO scripture_export_baselines (lane, owner, repo, base_ref, book, base_sha, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())
       ON CONFLICT(lane, owner, repo, base_ref, book) DO UPDATE SET
         base_sha = excluded.base_sha,
         updated_at = excluded.updated_at`,
    )
      .bind(lane, owner, repo, baseRef, book, baseSha)
      .run();
  }

  // Banner alert when the alignment-shrink backstop blocks an ULT/UST export to
  // avoid shipping a silent de-alignment to master. Same replace-undismissed
  // shape as recordShrinkSkipAlert.
  private async recordAlignmentShrinkSkipAlert(
    book: string,
    resource: Resource,
    detail: string,
  ): Promise<void> {
    const source = `export_align_shrink:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render would drop \\zaln ` +
      `word alignment on verses whose text is UNCHANGED (${detail}). This is the 1CH 4:21 / NUM 24 collateral ` +
      `de-alignment signature — refusing to ship it to master. Re-align the affected verse(s) in the editor, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Banner alert when the shrink guard blocks an export to avoid mass-deleting
  // rows on master (the twl_PSA clobber signature). Same replace-undismissed
  // shape as recordStaleSkipAlert.
  private async recordShrinkSkipAlert(
    book: string,
    resource: Resource,
    renderedRows: number,
    masterRows: number | null,
    detail: string,
  ): Promise<void> {
    const source = `export_shrink:${book}:${resource}`;
    const message =
      `Benjamin — nightly export BLOCKED ${book} ${resource.toUpperCase()}: the render has ${renderedRows} rows ` +
      `but master has ${masterRows ?? "?"} (${detail}). This looks like an incomplete D1 load (truncated fetch), ` +
      `not a real deletion — refusing to shrink master. Re-sync ${book} ${resource.toUpperCase()} from master, ` +
      `verify the row count, then re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Chapter-scoped analogue of recordShrinkSkipAlert: the range's rendered row
  // count vs. master's row count IN THAT RANGE (not the whole book), for a
  // chapter-scoped manual export (exportChapterMerge.ts mergeTsvChapterRange).
  private async recordChapterShrinkSkipAlert(
    book: string,
    resource: Resource,
    chapters: ChapterRange,
    renderedRows: number,
    masterRowsInRange: number,
  ): Promise<void> {
    const range = formatChapterRange(chapters);
    const source = `export_shrink:${book}:${resource}:ch${range}`;
    const message =
      `Benjamin — chapter export BLOCKED ${book} ${resource.toUpperCase()} ch${range}: the range render has ` +
      `${renderedRows} rows but the base has ${masterRowsInRange} in that range. This looks like an incomplete ` +
      `D1 load (truncated fetch), not a real deletion — refusing to shrink it. Re-sync ${book} ` +
      `${resource.toUpperCase()}, verify the row count, then re-export ch${range}. If the deletion IS intentional ` +
      `(including removing every row in this range), re-run the chapter export with the shrink override.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // F2 (strict, revised): the chapter merge's base (read from the export
  // branch) is missing rows master has OUTSIDE the requested range — the base
  // is behind or sparse relative to master for reasons this chapter export
  // never touched. Unlike recordChapterShrinkSkipAlert, this is never
  // overridable (see mergeAndGuardChapterRange's comment) — a human must
  // reconcile the branch with master before this (book, resource) can be
  // re-exported.
  private async recordChapterBaseMissingRowsAlert(
    book: string,
    resource: Resource,
    chapters: ChapterRange,
    missingIds: string[],
  ): Promise<void> {
    const range = formatChapterRange(chapters);
    const source = `export_base_missing:${book}:${resource}:ch${range}`;
    const sample = missingIds.slice(0, 10).join(", ");
    const more = missingIds.length > 10 ? ` (+${missingIds.length - 10} more)` : "";
    const message =
      `Benjamin fix this — chapter export BLOCKED ${book} ${resource.toUpperCase()} ch${range}: the export ` +
      `branch is missing ${missingIds.length} row(s) master has OUTSIDE chapters ${range} (IDs: ${sample}${more}). ` +
      `This looks like the branch drifted behind master (an out-of-band edit, or an earlier conflict-recovery ` +
      `rebuilt it incompletely) rather than an intentional deletion — refusing to push a merge that would drop ` +
      `rows this chapter export never touched. This guard cannot be overridden; reconcile the branch with master ` +
      `on Door43 (or let a fresh chapter export rebuild it), then re-export ch${range}.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Gate for recordChapterMergeSkipAlert (G): fires for every chapter-mode
  // terminal skip whose reason starts with "chapter_merge:", EXCEPT the two
  // categories that already write their own, more specific banner —
  // branch_conflict (recordChapterConflictAlert) and base_missing_master_rows
  // (recordChapterBaseMissingRowsAlert) — so those aren't double-alerted.
  // Called at every chapter_merge: terminal-skip site in exportOne /
  // commitChapterRange; a no-op for any other reason (shrink_guard:,
  // stale_master:, held_for_review:, etc. — those already have their own
  // alert or none by design).
  private async alertChapterMergeSkipIfNeeded(
    book: string,
    resource: Resource,
    chapterLabel: string | null,
    reason: string,
  ): Promise<void> {
    if (!reason.startsWith("chapter_merge:")) return;
    if (reason.startsWith("chapter_merge:branch_conflict")) return;
    if (reason.startsWith("chapter_merge:base_missing_master_rows")) return;
    await this.recordChapterMergeSkipAlert(book, resource, chapterLabel, reason);
  }

  // Catch-all banner for a chapter-mode chapter_merge: skip that has no
  // dedicated alert of its own (base_moved, header_mismatch/duplicate_id/
  // rendered_row_out_of_range parse failures from mergeTsvChapterRange,
  // branch_check_failed, no_master_path, and any future chapter_merge:
  // reason) — without this, those categories failed with only a recordSnapshot
  // row and a console.error, silent to anyone not actively watching the
  // export history. branch_conflict and base_missing_master_rows are excluded
  // by alertChapterMergeSkipIfNeeded (their own alerts are more specific).
  private async recordChapterMergeSkipAlert(
    book: string,
    resource: Resource,
    chapterLabel: string | null,
    reason: string,
  ): Promise<void> {
    const range = chapterLabel ?? "?";
    const source = `export_chapter_skip:${book}:${resource}:ch${range}`;
    const message =
      `Benjamin fix this — chapter export for ${book} ${resource.toUpperCase()} ch${range} was skipped: ` +
      `${reason}. See the export history (GET /api/exports, or the admin exports page) for this ` +
      `(book, resource, chapters) for detail, then re-export ch${range} once resolved.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Banner alert when the pre-export sync for a book failed outright (e.g. the
  // Cloudflare subrequest cap). The export will skip any book left stale, so
  // this is the heads-up that a manual re-sync is needed.
  private async recordSyncFailureAlert(book: string, detail: string): Promise<void> {
    const source = `export_sync_fail:${book}`;
    const message =
      `Benjamin — nightly pre-export sync failed for ${book}: ${detail.slice(0, 160)}. ` +
      `Any book left behind master is skipped by the freshness gate (not reverted); re-sync ${book} and re-export.`;
    await this.writeAlert(source, message, await exportOwnerUrl(this.env));
  }

  // Replace-undismissed alert writer shared by the export-side alerts. Best
  // effort: an alert-write failure must never fail or retry the export.
  private async writeAlert(
    source: string,
    message: string,
    linkUrl: string,
    severity: "error" | "warning" | "info" = "error",
  ): Promise<void> {
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, ?5, ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl, severity)
        .run();
    } catch (e) {
      console.error("export alert write failed", { source, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Surface a PR-ensure failure as a banner alert (the SPA polls
  // GET /api/alerts/me). Same shape as postExport.recordFailureAlert: replace
  // any undismissed alert for the same source so consecutive failures don't
  // pile up. Best-effort — an alert-write failure must not fail the step.
  private async recordPrFailureAlert(
    book: string,
    resource: Resource | ArticleResource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_pr:${repo}`;
    const message = `Benjamin fix this — nightly export couldn't ensure a PR for ${book} ${resource} (\`${branch}\` on ${repo}): ${detail.slice(0, 160)}`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    try {
      await this.env.DB.prepare(
        `DELETE FROM system_alerts
          WHERE username = ?1 AND source = ?2 AND dismissed_at IS NULL`,
      )
        .bind(EXPORT_ALERT_USERNAME, source)
        .run();
      await this.env.DB.prepare(
        `INSERT INTO system_alerts (username, severity, source, message, link_url)
         VALUES (?1, 'error', ?2, ?3, ?4)`,
      )
        .bind(EXPORT_ALERT_USERNAME, source, message, linkUrl)
        .run();
    } catch (e) {
      console.error("export PR alert write failed", {
        book, resource, repo, error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Error banner when an export PR conflicted but we could NOT auto-recover —
  // no admin token, the delete was forbidden, or the rebuild threw. The PR is
  // left mergeable:false for a human to reconcile (today's behavior).
  private async recordPrConflictAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    detail: string,
  ): Promise<void> {
    const source = `export_conflict:${repo}:${book}:${resource}`;
    const message =
      `Benjamin fix this — nightly export PR for ${book} ${resource.toUpperCase()} (\`${branch}\` on ${repo}) ` +
      `is in merge conflict with master and could NOT be auto-rebuilt (${detail}). Reconcile by hand ` +
      `(merge master, \`git checkout --ours\` the file = D1's render, push), or provision DCS_TOKEN so the ` +
      `export can rebuild the branch automatically.`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "error");
  }

  // Chapter-mode analogue of recordPrConflictAlert (F1): a chapter export's PR
  // conflicted with master, and — unlike whole-book — we deliberately do NOT
  // auto-rebuild the branch (that would drop every earlier chapter run's rows
  // still unmerged on it). The branch and PR are left exactly as they are; a
  // human must resolve the conflict or merge/close the PR on Door43 before
  // this (book, resource) can be re-exported.
  private async recordChapterConflictAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    chapterLabel: string | null,
  ): Promise<void> {
    const range = chapterLabel ?? "?";
    const source = `export_conflict:${book}:${resource}:ch${range}`;
    const message =
      `Benjamin fix this — chapter export PR for ${book} ${resource.toUpperCase()} ch${range} ` +
      `(\`${branch}\` on ${repo}) is in merge conflict with master. The branch and its PR were left ` +
      `untouched (NOT auto-rebuilt) to preserve other pending chapters accumulated on the same branch. ` +
      `Because chapter exports for ${book} ${resource.toUpperCase()} reuse this shared branch ` +
      `(reuseChapterBranch), the conflict blocks EVERY further chapter export for ${book} ` +
      `${resource.toUpperCase()} — not just ch${range} — until a human resolves the conflict by hand or ` +
      `merges/closes the PR on Door43. After that, the next chapter export starts a fresh branch from master.`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "error");
  }

  // Informational banner when an export PR conflict WAS auto-recovered by
  // rebuilding the branch off master. Surfaces (rather than silently swallows)
  // the D1-authoritative resolution so Benjamin can eyeball the rebuilt PR diff
  // and confirm any master-only rows that got dropped were meant to go.
  private async recordBranchRebuiltAlert(
    book: string,
    resource: Resource,
    repo: string,
    branch: string,
    prNumber: number | null,
  ): Promise<void> {
    const source = `export_rebuilt:${repo}:${book}:${resource}`;
    const prRef = prNumber != null ? `#${prNumber}` : "(PR pending)";
    const message =
      `Heads up — nightly export rebuilt \`${branch}\` (${book} ${resource.toUpperCase()} on ${repo}) onto ` +
      `current master to clear a merge conflict; D1's render is authoritative. Eyeball PR ${prRef} to confirm ` +
      `any master-only rows dropped were intended.`;
    const linkUrl = `${await exportOwnerUrl(this.env)}/${repo}/pulls`;
    await this.writeAlert(source, message, linkUrl, "warning");
  }
}
