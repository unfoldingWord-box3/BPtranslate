# Translate pipeline: internal runner design (issue #445)

Status: design accepted 2026-09-15. Implementation lands as the PR series in §F.
Decision record: run the bp-assistant `translate` pipeline inside this Worker on
Cloudflare Workflows, BYO key only, editor-delivery only. bp-assistant is copied
from, never changed. The Fly proxy path stays behind a flag during rollout.

## Conclusions

1. ~2,900 LOC of TypeScript, of which ~1,300 is a near-verbatim copy of pure
   functions (`translate-checks.js`, `tsv-resource.js`, `translate-core.js`,
   `context-pack.js`, `scripture-verses.js`, `article-resolver.js`). The bot's only
   impurities are `fs` and `require('../api-runner/provider-config')`.
2. The fs seam is exactly three functions: `core.writeBatchFiles`
   (`translate-core.js:276-303`), `translateLlm.runOne` writing `files.outputFile`
   (`translate-llm.js:579`), `core.readBatchOutput` (`:343-363`). Replace with
   in-memory `{sourceTsv, packMarkdown, taskJson}` → `outputText` →
   `validateBatchOutput(text, rows)`; persistence becomes R2 puts in the Workflow step.
3. Storage: R2 for content, one D1 column for status. Batch inputs/outputs and the
   merged book go to `BLOBS` under a job-scoped prefix (same pattern as
   `exportWorkflow.ts:725,1432`); the Workflow owns a new
   `pipeline_jobs.wf_status_json` column holding a bot-shaped `StatusResponse`.
4. `PIPELINE_MODE` branches in exactly two functions, `dispatchNext` and
   `pollPipelineJob`, plus the import byte source. Routes `/start`, `GET /:jobId`,
   list, cancel, notified are unchanged. `web/` is unchanged.
5. The plaintext key is never persisted: Workflow params carry `provider` and
   `model` only; each LLM step re-reads `ai_provider_config` and decrypts inside
   `step.do`.
6. Mode gate: internal runner only when `PIPELINE_MODE=internal` AND the org has a
   BYO key (`resolveDispatchAi` → `configured`) AND the provider has an in-Worker
   adapter (`PIPELINE_INTERNAL_PROVIDERS`, default `claude`). Everything else proxies
   to Fly as today.

## A. Module map (bot → `api/src/translate/`)

| Bot source | Target | LOC | Dropped |
|---|---|---|---|
| `lib/tsv-resource.js` + `lib/tn-tsv.js` | `tsvCodec.ts` | 90 | nothing. Do NOT reuse `importParsers.ts parseTsv`; the strict codec's byte round-trip (`tsv-resource.js:29-57`) is the invariant |
| `lib/resource-types.js` | `resourceTypes.ts` | 60 | `ROUTE_*` Zulip maps, `pushType`, `defaultRepo`, `configRepoKey` (editor resolves repos in `translateOptions.ts:100-141`) |
| `lib/translate-checks.js` | `checks.ts` | 250 | nothing |
| `lib/context-pack.js` | `contextPack.ts` | 300 | local-directory branch (`:295-304`); `Buffer.byteLength` → `TextEncoder` |
| `lib/translate-core.js` | `core.ts` | 380 | `translateSessionSuffix`; `writeBatchFiles`/`writeArticleFiles`/`readBatchOutput`/`readArticleOutput` replaced by pure `buildBatchArtifacts()` / `validateBatchOutput()` / `validateArticleOutput()` (pass-through copy-back at `:352-360` kept) |
| `lib/scripture-verses.js` + `api-runner/verse-data.js:118-141,180-197` | `scripture.ts` | 140 | rest of verse-data |
| `lib/article-resolver.js` | `articleResolver.ts` | 200 | `fetchExistingArticle`. Phase 2 (tw/ta) |
| `lib/translate-llm.js` | `llm.ts` | 320 (220 claude-only) | `fs`, `skillsRoot`/`readSkillBody`, `_setTestHooks` (inject `transport`), the in-process sleep retry loop (`:486-522`) replaced by Workflow step retries; `redact()` → port `SECRET_PATTERNS` (`run-logs.js:100-117`) |
| `api-runner/provider-config.js` (slice) | `providerCatalog.ts` | 60 | everything except ids/aliases/prices for models already allowed in `aiProvider.ts:31-36` |
| `translate-pipeline.js:61-68, 83-217` (`LANG_NAMES`, `RTL_LANGS`, `resolveParams`) | `params.ts` | 120 | Zulip regexes, `translate-targets.json`, `delivery`, `branchOnly`, `writeContextBack` |
| `translate-pipeline.js:323-376, 382-497, 503-638` (batch loop, `translateChapters`, `translateArticles`) | `api/src/translateWorkflow.ts` | 450 | `runClaude`, `setCheckpoint`, `door43Push`, Zulip, `finalizeContextWriteBack`, `publishAdminStatus`, workDir cache |
| `bp-assistant-skills/.claude/skills/translate-{tn,tq,article}/SKILL.md` | `prompts/translateTn.ts` etc. (frontmatter stripped) + `API_MODE_OVERRIDE` (`translate-llm.js:93-115`) | 350 | nothing; optional `scripts/sync-translate-prompts.mjs` regenerates from the skills checkout |
| new | `status.ts` (wf_status_json), `storage.ts` (R2 keys) | 140 | |

Out entirely: `claude-runner.js`, `door43-push.js`, `zulip-client.js`,
`pipeline-checkpoints.js`, `context-write.js`, `translate-suggestions.js`,
`router.js`, `api/pipeline.js`.

Prompt fidelity: the bot inlines the task JSON including absolute
`batchFile`/`outputFile` paths. In-Worker use logical names (`batch-01.tsv`); the
override section already tells the model there is no filesystem
(`translate-llm.js:99-101`). Minor prompt-byte drift, output contract unchanged.

## B. `TranslateWorkflow`

Params (persisted by Cloudflare, so nothing secret):

```ts
{ jobId, workspace /* REQUIRED, from env.WORKSPACE_SLUG at dispatch */, userId,
  resourceType, book, startChapter, endChapter, verseStart?, verseEnd?, rowIds?,
  articleId?, articleUrl?, targetLang, direction, sourceRef, contextRef?,
  literalRef?, simplifiedRef?, sourceLiteralRef, sourceSimplifiedRef,
  targetOrg, repoName, provider, model, thinking: 'medium' }
```

All of this is already in `options_json` (`translateOptions.ts:93-147`) or on the
row. Instance id `translate-${workspace}-${jobId}`.

First line of `run()`: `await primeWorkspaces(this.env); this.env =
workspaceEnv(this.env, resolveWorkspace(this.env, params.workspace))` exactly as
`exportWorkflow.ts:228-229`; `NonRetryableError` if `params.workspace` is absent.
Workflows do not inherit the per-request env clone (STATE.md lesson).

Nothing may touch a tenant binding before that resolve has verified the slug —
not even the failure record. `wf_status_json` is written by an UPDATE keyed by
`job_id` alone, and job ids are unique only WITHIN a tenant database, so a
refusal recorded against the still-raw default binding overwrites whatever org
owns that id there. A run whose workspace cannot be resolved therefore writes
NOTHING and fails loudly as an errored instance; its `pipeline_jobs` row is left
to the sweeps that already own abandoned rows (`pipelines.ts` MAX_POLL_ATTEMPTS
~8h, STUCK_JOB_THRESHOLD_SECONDS 48h).

Key handling: inside each `batch-NN` step, `getAiProviderConfig(this.env.DB)` →
`resolveDispatchAi` → `decryptApiKey` (same trio as `pipelines.ts:637-649`). Verify
`row.provider === params.provider`, else fail `ai_provider_changed`. Key is a local
const, never returned from `step.do`, never in `wf_status_json`; every thrown
message passes `scrubSecrets(msg, [apiKey])`.

Steps:

1. `guard-and-source`: assert `pipeline_jobs.state IN ('running','dispatching')`;
   `fetchResourceFile` → parse → `sliceChapterRows` → `selectRows` → `buildBatches`
   (15 rows / 7000 chars). Put `work/batch-NN.tsv` per batch. Return
   `{batchCount, rowCount}`. A whole-chapter job (no rowIds, no verse range)
   leaves the rows approved in D1 out of the batches (#895); the merge's shrink
   guard counts them as kept, and the apply lists them as kept because approved.
   A fully approved chapter runs zero batches and finishes done.
2. `context`: `loadContextPack(contextRef, {allowEmpty: !explicit})` +
   `buildScripturePack`; render every `renderBatchPack` and task JSON; put
   `work/batch-NN-pack.md`, `work/batch-NN-task.json`. Return
   `{contextSha, perBatch:[{slugs, templateFallbacks}]}`. Never return pack bodies.
3. `batch-NN` × N, `{retries:{limit:2, delay:'30 seconds', backoff:'exponential'},
   timeout:'25 minutes'}`: if `work/batch-NN-out.tsv` exists and validates, skip
   (mirrors `translate-pipeline.js:449-454`). Else get source+pack+task from R2,
   decrypt key, run the MAX_BATCH_ATTEMPTS=2 draft+repair loop (`:328-376`
   verbatim), UPDATE `current_status` + `wf_status_json` (running), and RETURN
   the validated output. It is then written by a second step per batch,
   `batch-NN-persist` (`INFRA_RETRY`), which does nothing but put
   `work/batch-NN-out.tsv`.

   The split is the cost control, and it is the one place this design
   deliberately does not keep a step return tiny. A provider call is money and
   `batch-NN` is retryable, so an R2 failure after a billed call used to have
   only bad options: retry the step and pay again, or fail the batch. Cloudflare
   persists a step's return value before the next step runs, so returning the
   output makes it durable in the engine's own storage the moment `batch-NN`
   commits; `batch-NN-persist` then retries off that replayed value and never
   off the provider. Sizes are documented, not assumed — Workflows "Limits" caps
   a non-stream step result at 1 MiB and per-instance persisted state at 100 MB
   (Free) / 1 GB (Paid), against ~8-70 KB per batch output and ~1.5 MB for a
   22-batch run. Step count is 2N+3 (25 for OBA's 11 batches), against 1,024
   (Free) / 10,000 (Paid). The decrypted key is still never in a step return.

   The 1 MiB cap is enforced, not assumed: batches are bounded by rows and
   source characters, and the deterministic checks tolerate arbitrary length
   growth in a translated column, so a valid output CAN exceed it (demonstrated
   at 1.2 MB from the recorded 15-row batch-01). `batch-NN` measures its
   serialized return and, at or over 768 KiB (25% headroom, because the measured
   JSON is a proxy for the engine's own encoding plus its envelope), writes the
   output itself under the in-step retries below and returns the same
   "already in R2" marker a reused output returns. An oversized batch therefore
   degrades to the pre-split behaviour instead of failing to commit — which
   would have retried the step and re-bought the batch.

   The mid-loop write stays in `batch-NN` because it happens while that step is
   running: a draft whose checks failed is persisted to `work/batch-NN-draft.json`
   BEFORE the repair call — text and billed calls in ONE object, because R2 is
   atomic per object and atomic across none — and resumed from on the next
   attempt. The retry buys the repair pass, not the draft again, and the resumed
   batch still reports the draft's tokens and cost, which the org was billed for
   whether or not the isolate that spent them survived. A `.tsv` plus a `.json`
   sidecar could land the draft and lose its price, and the resume then billed
   the repair pass alone. That put keeps the in-step retry and the non-retryable
   `output_persist_failed` failure.

   The window that stays open — and no arrangement of steps closes it — is an
   isolate dying after the provider's reply arrives and before `batch-NN`'s
   return is committed. Nothing durable exists at that instant, so the retry
   pays again.
   Return `{nn, rowCount, attempts, usage, costUsd, outputText}`. Error mapping: `invalid_key`,
   `model_not_found`, `context_too_long`, `output_too_long`, `empty_output`,
   checks-still-failing → `NonRetryableError`; `rate_limited`,
   `provider_overloaded`, `timeout`, `network_error` → plain throw (step retries,
   instance hibernates).
4. `merge-report`: read all outputs, whole-range `runChecks` (`:468-472`), fetch
   existing target book from `${targetOrg}/${repoName}@master` (`:477-479`),
   `mergeChapterIntoBook` or `updateRowsById`, `buildTranslateReport`
   (`generatedBy:'bible-editor/translate'`), put `out/<file>` and
   `out/translate-report-S-E.json`, write `wf_status_json` `{state:'done',
   output:[manifest]}` with the manifest shape of `translate-pipeline.js:831-840`.
5. `record-failure` (catch-all, like `exportWorkflow.ts:423`): `wf_status_json =
   {state:'failed', current:{errorKind, error}}`, scrubbed.

The Workflow writes only `current_skill`, `current_status`, `updated_at`,
`wf_status_json`. It must NOT write `state` or `output_json`: `output_json IS NULL`
is the not-yet-imported flag (`pipelines.ts:1590`, `:795-799`) and
`pollAllNonTerminal` polls `state='running'` only (`:1160-1165`). State transitions
stay owned by `pollPipelineJob`.

Cancel: route unchanged (queued-only, `:1978-2018`). Running jobs: step 1 and every
batch step re-check the row and `NonRetryableError` out if `state` is
`cancelled`/`failed`. Follow-up: `TRANSLATE_WORKFLOW.get(id).terminate()` on cancel.

Articles (tw/ta): same skeleton with `resolve-article` and `article-NN` steps; phase 2.

## C. Storage and import

R2 layout mirrors the bot's `work/` so the dry-run compare is a directory diff:

```
pipeline-output/<workspaceSlug>/<jobId>/work/batch-NN{.tsv,-pack.md,-task.json,-out.tsv}
pipeline-output/<workspaceSlug>/<jobId>/work/batch-NN-draft.json  # only when a billed draft failed checks: {output, calls}
pipeline-output/<workspaceSlug>/<jobId>/out/<tn_OBA.tsv | bible/kt/god.md …>
pipeline-output/<workspaceSlug>/<jobId>/out/translate-report-<S>-<E>.json
```

Why R2 over D1: outputs are 8–70 KB blobs, the repo already stages export/reimport
bytes in R2, keys give put-overwrite idempotency, cleanup is a prefix delete
alongside `index.ts:396-409`.

Migration `0073_pipeline_jobs_internal_runner.sql`: `ALTER TABLE pipeline_jobs ADD
COLUMN runner TEXT` (`proxy`|`internal`, stamped at dispatch so a job imports via
the runner it ran on even if the flag flips) and `ADD COLUMN wf_status_json TEXT`.

`pipelineImport.ts`: `ImportContext` (`:52-61`) gains `runner?`; the
`upstreamJobId` requirement (`:233-235`) applies to proxy only; `:236` becomes
`raw = ctx.runner==='internal' ? await fetchInternalOutput(env, ctx.jobId,
entry.file!) : await fetchBotOutput(...)`, where `fetchInternalOutput` is
`env.BLOBS.get(outKey(...))` with the path-safety guard from
`article-resolver.js:86-95`. `classify()` (`:87-105`) unchanged. Provenance
untouched: `edit_log.source='ai_pipeline'`, `pending_imports.job_id`, source stamps,
`import_claimed_at` CAS all key on the editor `job_id`.

## D. Contract preservation

1. `dispatchNext` (`pipelines.ts:503-743`): after `resolveDispatchAi`/`decryptApiKey`
   (`:634-651`) add `const runner = translateRunner(env, job, ai)`; if `internal`:
   `await env.TRANSLATE_WORKFLOW.create({id, params})`, same UPDATE as `:736-742`
   with `upstream_job_id = id, runner='internal'`, skip the fetch block `:655-735`.
   Failure of `create()` → existing `fail('sdk_error', …)`.
2. `pollPipelineJob` (`:760-1060`): replace `:772-793` with `const data =
   job.runner==='internal' ? readInternalStatus(job) : await
   fetchUpstreamStatus(env, job)`; pass `runner` into `importJobOutput`
   (`:806-818`). `PolledJob` SELECTs (`:1160-1164`, `:1600-1605`) add `runner,
   wf_status_json`. Lines `:795-1060` unchanged.
3. `Env` gains `TRANSLATE_WORKFLOW`, `PIPELINE_MODE?`, `PIPELINE_INTERNAL_PROVIDERS?`;
   `wrangler.toml` gains a `[[workflows]]` block per env (dev-suffixed).

Unchanged: state machine `:56-72`, `/start` `:1201`, `GET /:jobId` `:1581`, list
`:1852`, cancel `:1978`, notified `:2020`, `pollAllNonTerminal` `:1081`,
`BT_API_TOKEN` gates (stay during rollout; follow-up to relax). `web/src` reads only
`StatusResponse`/list rows (`web/src/sync/api.ts:1430-1490`, `:2187-2205`).

## E. Test plan

Port fixtures (`tn_OBA.tsv`, `tq_OBA.tsv`, `tw_kt_god.md`, `ta_figs-aside/*`) to
`api/test-fixtures/translate/`; `.test.mjs` assert style as `botOutput.test.mjs`.

- `translate-checks.test.js` (all 13, incl. Aquilla Quote corruption, NFC-only diff,
  row order), `translate-tq.test.js`, `translate-article.test.js`,
  `translate-select.test.js` minus Zulip `resolveParams` cases,
  `translate-core.test.js` minus suggestion/context-write cases,
  `scripture-verses.test.js`, `translate-llm.test.js` prompt/extract/classify/scrub/
  truncation/`estimateCost` cases; retry cases re-shaped to classification →
  retryable flag.
- Key invariant (no LLM): replay `dry-run-ar-OBA/work/batch-NN-out.tsv` as the model
  reply into `validateBatchOutput` against `batch-NN.tsv` for all 11 batches →
  `checks.ok`, pass-through columns byte-identical; merge all → byte-identical to
  `dry-run-ar-OBA/tn_OBA.tsv`.
- New: workspace re-point test (clone `exportWorkflowWorkspace.test.mjs`),
  `readInternalStatus` synthesis, R2 key/path-guard test, `dispatchNext` internal
  branch (pattern: `pipelineDispatchTimeout.test.mjs`), "no key in params/status/
  error strings" test.

- Engine-level: `translate/workflowEngine.test.mjs`, on the harness in
  `translate/workflowHarness.mjs` + `translate/workflowHarnessWorker.ts`. Runs the REAL
  `TranslateWorkflow` class under a real Workflows engine — workerd via miniflare, with
  D1 (every migration applied) and R2 — and serves every outbound fetch in-process:
  the DCS raw endpoints, and the Anthropic Messages API as SSE into the real
  `@anthropic-ai/sdk` inside the Worker, so there is no network and no stubbed
  adapter. Covers what no step-body test can reach: the whole recorded OBA run
  through `step.do`; the workspace re-point with a second, differently-keyed tenant
  present (which key reaches the provider identifies which D1 was read); a missing /
  unknown slug refusing before either tenant is touched; `NonRetryableError` fatality
  (one billed call for `invalid_key`, two for the in-step repair loop) against real
  step retries for a transient; R2 output reuse costing zero calls; and the decrypted
  key's absence from step returns, instance output/error, D1, R2 and the engine's own
  on-disk state.

  Two runtime facts it measured, both load-bearing:
  (a) the engine honours retry `delay` in real time, so the suite spends ~45 s
  sleeping inside the retry cases — the reason the transient proofs use one-batch
  jobs and the batch-step case retries once rather than twice;
  (b) a step's error reaches `run()`'s catch rebuilt as `${name}: ${message}`, which is
  why `classifyStepError` strips an error-name prefix before reading the `[kind] ` tag.
  Before that, every failure the catch-all recorded was filed as a retryable
  `internal_error` instead of its real kind.

  Still needs a deployed worker: Cloudflare's own limits (step return / params size,
  step and instance timeouts, subrequests per step), instance `terminate()` on cancel,
  and whether production's engine rebuilds step errors the same way miniflare does.

Live dry run: dev worker, workspace `bsoj`, admin stores an Anthropic key via
`/api/ai-provider`, `PIPELINE_MODE=internal` in `.dev.vars`, start OBA 1 tn from the
UI. Compare `pipeline-output/bsoj/<jobId>/` to `dry-run-ar-OBA/`: 153 rows, 11
batches with identical boundaries (bot ran `en_tn@master` unpinned; re-slice if
drifted), `checks.ok`, Quote byte-identical 153/153, all Notes Arabic, report
`llm.calls` = 11. Then confirm `pending_imports` and `edit_log source='ai_pipeline'`.

## F. PR series and estimate (~9.5 dev days, Anthropic-only through step 6)

1. Pure ports (`tsvCodec`, `resourceTypes`, `checks`, `core`, `contextPack`,
   `scripture`, `providerCatalog`, prompts) + ported tests + replay invariant.
   Verify: `npm test` green, replay byte-identical. ~2.5 d.
2. `llm.ts` Anthropic adapter via `@anthropic-ai/sdk` (`messages.stream` +
   `finalMessage`, adaptive thinking, effort), same as `translate-llm.js:329-350`.
   Verify: stubbed-transport tests; one real call from `wrangler dev`. ~1 d.
3. Migration 0073 + `storage.ts` + `status.ts`. ~0.5 d.
4. `translateWorkflow.ts` + wrangler bindings (dev only). Verify: manual `create()`
   from a dev-only admin route, inspect R2. ~2 d.
5. `dispatchNext`/`pollPipelineJob`/`pipelineImport` branches + flag, default
   `proxy`. Verify: existing pipeline tests unchanged; proxy regression on dev. ~1 d.
6. Live OBA→Arabic dry run + compare report; fix drift. ~1 d.
7. tq (near-free), then tw/ta (`articleResolver`, article steps). ~1.5 d.

Risks: (1) Workflow limits (step return/params size, step timeout, subrequests per
step): content in R2 and small returns, with the one measured exception of
`batch-NN`'s output (§B step 3); verify limits in `wrangler dev` before step 4.
(2) Wrong-tenant env: mandatory `params.workspace`, first-line re-point,
slug-prefixed R2 keys, cloned test. (3) Key exposure: step-local decrypt, scrub on
every throw, serialized-artifact test, never log params. (4) Double LLM spend on
step retry: R2 output-reuse check at step start; `NonRetryableError` for
deterministic failures; the billed output leaves the paying step as its return
value so the R2 write can retry without re-buying it. (5) Prompt/behavior drift
from the bot: sync script +
checksum test against the skills checkout; dry-run comparison in step 6. Claude and
Gemini have in-Worker adapters; OpenAI/xAI stay proxied until each adapter is
smoke-tested. The Gemini adapter is plain fetch rather than @google/genai: the
SDK measured +112 KiB gzip (+26% of the Worker) and 94 transitive packages for
one non-streaming POST, and bundling for workerd is not evidence of running
there. Its cost as fetch is +0.68 KiB. The one REST-vs-SDK trap —
`thinkingConfig` nests inside `generationConfig` on the wire, and Gemini
ignores it silently at the top level — is pinned by a test on the serialized
body. Two places where the port deliberately does NOT follow the bot: Gemini
bills thinking tokens as output but reports them in a separate
thoughtsTokenCount, which the bot never reads, so a thinking run there
under-reports its own cost; and a content-filter block is surfaced with its
blockReason rather than reaching runOne as a bare empty_output. Still open: the
adapter has never made a live call, so the accepted thinkingLevel values for
Gemini 3 are unconfirmed — a rejected level fails a batch non-retryably, which
is the first thing the live dry run settles.
