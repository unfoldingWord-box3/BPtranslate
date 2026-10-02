// Thin proxy + queue + tracker for the bp-assistant pipeline endpoints (see
// docs/ai-pipeline-integration.md and the partner contract). State lives in
// D1 so polling survives a tab reload.
//
// Concurrency: the fly.io bot (uw-bt-bot) can only run ONE pipeline at a time.
// We enforce that globally here — POST /start enqueues a 'queued' row and a
// single dispatcher (dispatchNext) sends one job to the bot at a time, claiming
// the slot with an atomic D1 UPDATE...WHERE NOT EXISTS(active). Follow-up /
// macro-chain steps enqueue with priority=1 so they jump the line and a macro
// completes as one unit. Translators see their queue position and can cancel a
// job that hasn't reached the front yet. See migration 0026_pipeline_queue.sql.
//
// Auth: every route requires a JWT (requireEditor). The shared BT_API_TOKEN
// (same secret used by /api/tn-quick) authorizes us upstream. The translator's
// DCS username is injected from the JWT / DB — never from the request body — so
// a caller can't attribute runs to other users.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { currentUserId, requireEditor } from "./auth.ts";
import { importJobOutput } from "./pipelineImport.ts";
import { getProjectConfig } from "./projectConfig.ts";
import { buildTranslateOptions, normalizeRowIds, normalizeTranslateRowIdsJson } from "./translateOptions.ts";
import {
  PIPELINE_COVERAGE_WHERE,
  PIPELINE_DEDUP_WHERE,
  coverageVerseRange,
  isNarrowerTranslateScope,
} from "./pipelineDedupSql.ts";
import { getAiProviderConfig, resolveDispatchAi, scrubSecret, type DispatchAi } from "./aiProvider.ts";
import { decryptApiKey } from "./aiKeyCrypto.ts";
import {
  buildTranslateWorkflowParams,
  internalProviders,
  readInternalStatus,
  translateInstanceId,
  translateRunner,
} from "./translate/dispatch.ts";
import { applyContextRef } from "./assistedContextRef.ts";
import { getLatestSuccessfulContextExport } from "./contextExportResults.ts";
import { broadcastChapter } from "./wsEvents.ts";
import { sameDcsName } from "./repoUrl.ts";
import {
  assertLaneWritable,
  type LaneKey,
} from "./scriptureLane.ts";

export const pipelines = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

const DEFAULT_BASE = "https://uw-bt-bot.fly.dev";

const PIPELINE_TYPES = ["generate", "notes", "tqs", "translate"] as const;
type PipelineType = (typeof PIPELINE_TYPES)[number];

// States that occupy the single bot slot. While any job is in one of these,
// dispatchNext refuses to send another job upstream. 'dispatching' is the
// transient "claimed the slot, upstream POST in flight" state.
const ACTIVE_STATES = [
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "dispatching",
] as const;

// States the list endpoint surfaces by default (non-terminal work plus the
// retry-able 'failed'). 'queued'/'dispatching' join the originals so the chip
// shows pending work; 'cancelled'/'done' are terminal and only surface via
// the unnotified-terminal path.
const NON_TERMINAL_STATES = new Set([
  "queued",
  "dispatching",
  "running",
  "paused_for_outage",
  "paused_for_usage_limit",
  "failed",
]);

// Mirrors the bp-assistant contract (docs/ai-pipeline-integration.md §3).
// .strict() rejects unknown keys so a typo here surfaces as a 400 rather
// than getting silently dropped on its way upstream. Mutual-exclusion of
// the align flags is checked client-side AND server-side here AND in
// bp-assistant — three layers of paranoia is appropriate for a 1h run.
const PipelineOptions = z
  .object({
    model: z.enum(["sonnet", "opus"]).optional(),
    fresh: z.boolean().optional(),
    // generate-only
    contentTypes: z.array(z.enum(["ult", "ust"])).min(1).max(2).optional(),
    noAlign: z.boolean().optional(),
    alignOnly: z.boolean().optional(),
    textOnly: z.boolean().optional(),
    // notes-only
    noIntro: z.boolean().optional(),
    pauseBeforeATs: z.boolean().optional(),
  })
  .strict()
  .refine(
    (o) => [o.noAlign, o.alignOnly, o.textOnly].filter(Boolean).length <= 1,
    { message: "align_flags_mutually_exclusive" },
  );

// One step of a cross-type follow-up chain (e.g. the "Generate everything"
// macro: generate -> notes -> tqs). Same scope as the parent; only the
// pipelineType + options differ. The chain is a linked list — each row
// stores its remainder, and on each done-transition the next step is
// enqueued with its own remainder.
const ChainStep = z
  .object({
    pipelineType: z.enum(PIPELINE_TYPES),
    options: PipelineOptions.optional(),
  })
  .strict();

// Client-supplied translate overrides (all optional — the server derives the
// full option set from the active project config; these only override defaults).
// Kept SEPARATE from PipelineOptions (which is .strict() and generate/notes-
// shaped) so the two schemas don't collide; the server transforms this into the
// bot's `options` shape (bp-bot/translate-pipeline/PLAN.md §1). Single-note /
// verse-scope selection (rowIds / verseStart / verseEnd) rides here too.
const TranslateOptions = z
  .object({
    // Which row-keyed TSV resource to translate. Defaults to 'tn' (the pilot);
    // 'tq' translates translationQuestions. The server resolves the matching
    // source org+repo (resolveSourceRef) and passes resourceType through to the bot,
    // which selects the TSV parser + target repo. Row-keyed TSV resources are
    // tn|tq; article resources (tw|ta) use articleId/articleUrl instead of a
    // book/chapter scope (bp-assistant articles envelope, INTEGRATION.md §7).
    resourceType: z.enum(["tn", "tq", "tw", "ta"]).optional(),
    // Article selector (tw|ta only) — exactly one. articleId is a name
    // ('kt/god', 'translate/figs-aside'); articleUrl is a git.door43.org URL.
    articleId: z.string().min(1).max(200).optional(),
    articleUrl: z.string().url().max(400).optional(),
    model: z.enum(["sonnet", "opus"]).optional(),
    // Default 'editor' (bot never pushes to Door43; editor pulls the result
    // files). 'branch' stays accepted as an explicit expert override for one
    // release (docs/plan, rollout §3).
    delivery: z.enum(["path", "branch", "editor"]).optional(),
    branchOnly: z.boolean().optional(),
    direction: z.enum(["ltr", "rtl"]).optional(),
    // Precise subset selection → bot switches to update-by-ID merge.
    rowIds: z.array(z.string().min(1).max(16)).min(1).max(50).optional(),
    verseStart: z.number().int().positive().optional(),
    verseEnd: z.number().int().positive().optional(),
    // Advanced overrides — normally derived from project config.
    targetLang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/).optional(),
    targetOrg: z.string().min(1).max(64).optional(),
    sourceRef: z.string().min(3).max(200).optional(),
    contextRef: z.string().min(3).max(200).optional(),
    literalRef: z.string().min(3).max(200).optional(),
    simplifiedRef: z.string().min(3).max(200).optional(),
  })
  .strict();

const StartBody = z
  .object({
    pipelineType: z.enum(PIPELINE_TYPES),
    // Required for every pipeline EXCEPT an article translate (tw|ta), which is
    // scoped by translate.articleId/articleUrl instead. Enforced in the handler.
    book: z.string().min(1).max(8).optional(),
    startChapter: z.number().int().positive().optional(),
    endChapter: z.number().int().positive().optional(),
    sessionKey: z.string().min(1).max(120).regex(/^[A-Za-z0-9_\-/]+$/),
    options: PipelineOptions.optional(),
    // Translate-pipeline overrides (only meaningful when pipelineType ===
    // 'translate'; ignored otherwise). The server builds the full option set
    // from project config and folds these in.
    translate: TranslateOptions.optional(),
    // Optional second pipeline to fire on the parent's done-transition. Used
    // to express asymmetric ULT/UST alignment (e.g. ULT aligned + UST text-
    // only) since the upstream contract can't carry asymmetric flags in one
    // call. Same scope/pipelineType — only the options differ. See
    // docs/ai-pipeline-handoff.md.
    followUpOptions: PipelineOptions.optional(),
    // Optional cross-type chain. First entry fires on the parent's done-
    // transition; subsequent entries are stored on the new row's
    // follow_up_chain and fire in turn. Used by the chapter macro to chain
    // generate -> notes -> tqs. Mutually exclusive with followUpOptions
    // (we'd otherwise need to define an ordering between them).
    followUpChain: z.array(ChainStep).min(1).max(4).optional(),
  })
  .refine((b) => !(b.followUpOptions && b.followUpChain), {
    message: "follow_up_options_and_chain_mutually_exclusive",
  });

interface StartResponse {
  jobId: string;
  scope: { book: string; startChapter: number; endChapter: number };
  status: "running" | "queued" | "already_running";
  queuePosition?: number;
}

interface StatusResponse {
  jobId: string;
  pipelineType: string;
  scope: { book: string; startChapter: number; endChapter: number };
  state: string;
  current?: {
    chapter: number;
    skill: string;
    status: string;
    startedAt: string;
    errorKind?: string;
    error?: string;
  };
  updatedAt: string;
  createdAt: string;
  interrupted?: boolean;
  output?: Array<{
    type: string;
    repo: string;
    // Door43-branch delivery fields — absent for editor-delivery entries.
    branch?: string;
    path: string;
    rawUrl?: string;
    prNumber?: number;
    mergedAt?: string;
    commitSha?: string;
    // Editor delivery (docs/plan Design 1): 'editor' entries carry `file`, the
    // retrieval key for the bot's authenticated output endpoint.
    delivery?: string;
    file?: string;
  }>;
}

function upstreamBase(env: Env): string {
  return env.PIPELINE_API_BASE || DEFAULT_BASE;
}

/** Source identity stamped onto a pipeline_jobs row at creation. */
type PipelineSourceStamp = {
  source_generation: number | null;
  source_owner: string | null;
  source_repo: string | null;
  source_ref: string | null;
};

/** Per-lane stamps for dual-lane generate (lit/sim may diverge). */
type PipelineLaneStamp = {
  generation: number;
  owner: string;
  repo: string;
  ref: string;
};
type PipelineSourceStamps = Partial<Record<LaneKey, PipelineLaneStamp>>;

type ResolvedPipelineStamp = {
  /** Legacy flat columns (first/primary lane) for older readers. */
  legacy: PipelineSourceStamp;
  /** Per-lane JSON persisted in source_stamps_json. */
  stamps: PipelineSourceStamps;
  stampsJson: string | null;
};

const EMPTY_SOURCE_STAMP: PipelineSourceStamp = {
  source_generation: null,
  source_owner: null,
  source_repo: null,
  source_ref: null,
};

const EMPTY_RESOLVED: ResolvedPipelineStamp = {
  legacy: EMPTY_SOURCE_STAMP,
  stamps: {},
  stampsJson: null,
};

function laneStampToLegacy(stamp: PipelineLaneStamp): PipelineSourceStamp {
  return {
    source_generation: stamp.generation,
    source_owner: stamp.owner,
    source_repo: stamp.repo,
    source_ref: stamp.ref,
  };
}

function parseSourceStampsJson(raw: string | null | undefined): PipelineSourceStamps {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as PipelineSourceStamps;
  } catch {
    return {};
  }
}

/**
 * For generate pipelines that target ULT/UST, assert the lane(s) are writable
 * and stamp each lane's active generation + source owner/repo/ref independently
 * (GLT/GST and AVD/NAV routinely diverge). Non-scripture pipelines leave stamps null.
 */
async function resolvePipelineSourceStamp(
  env: Env,
  pipelineType: string,
  options: z.infer<typeof PipelineOptions> | undefined | null,
): Promise<ResolvedPipelineStamp> {
  if (pipelineType !== "generate") return EMPTY_RESOLVED;
  const contentTypes = options?.contentTypes ?? ["ult", "ust"];
  const lanes: LaneKey[] = [];
  if (contentTypes.includes("ult")) lanes.push("lit");
  if (contentTypes.includes("ust")) lanes.push("sim");
  if (lanes.length === 0) return EMPTY_RESOLVED;

  const stamps: PipelineSourceStamps = {};
  for (const lane of lanes) {
    const gate = await assertLaneWritable(env, lane, "pipeline");
    if (!gate.ok) {
      throw Object.assign(new Error(gate.error), {
        status: gate.status,
        detail: gate.detail,
      });
    }
    stamps[lane] = {
      generation: gate.generation,
      owner: gate.config.source.owner,
      repo: gate.config.source.repo,
      ref: gate.config.source.ref,
    };
  }
  const primary = stamps.lit ?? stamps.sim!;
  return {
    stamps,
    stampsJson: JSON.stringify(stamps),
    legacy: laneStampToLegacy(primary),
  };
}

/** Re-check stamped generate job still matches live per-lane identity. */
async function assertPipelineStampStillValid(
  env: Env,
  resolved: ResolvedPipelineStamp,
  contentTypes: string[] | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const lanes: LaneKey[] = [];
  if ((contentTypes ?? ["ult", "ust"]).includes("ult")) lanes.push("lit");
  if ((contentTypes ?? ["ult", "ust"]).includes("ust")) lanes.push("sim");
  if (lanes.length === 0) return { ok: true };

  for (const lane of lanes) {
    const stamp = resolved.stamps[lane]
      ?? (resolved.legacy.source_generation != null
        ? {
            generation: resolved.legacy.source_generation,
            owner: resolved.legacy.source_owner!,
            repo: resolved.legacy.source_repo!,
            ref: resolved.legacy.source_ref!,
          }
        : null);
    if (!stamp) return { ok: false, error: "pipeline_source_generation_required" };
    const gate = await assertLaneWritable(env, lane, "pipeline");
    if (!gate.ok) return { ok: false, error: gate.error };
    if (
      gate.generation !== stamp.generation ||
      // owner/repo are DCS names (case-insensitive); ref stays exact.
      !sameDcsName(gate.config.source.owner, stamp.owner) ||
      !sameDcsName(gate.config.source.repo, stamp.repo) ||
      gate.config.source.ref !== stamp.ref
    ) {
      return { ok: false, error: "pipeline_source_generation_mismatch" };
    }
  }
  return { ok: true };
}

function resolvedFromJobRow(job: {
  source_generation: number | null;
  source_owner: string | null;
  source_repo: string | null;
  source_ref: string | null;
  source_stamps_json?: string | null;
}): ResolvedPipelineStamp {
  const stamps = parseSourceStampsJson(job.source_stamps_json);
  const legacy: PipelineSourceStamp = {
    source_generation: job.source_generation,
    source_owner: job.source_owner,
    source_repo: job.source_repo,
    source_ref: job.source_ref,
  };
  return {
    legacy,
    stamps,
    stampsJson: job.source_stamps_json ?? (Object.keys(stamps).length ? JSON.stringify(stamps) : null),
  };
}

// Article translate jobs carry no book/chapter; they reuse the pipeline_jobs
// scope columns via a stable per-article sentinel so dedup keys per article
// while fitting the (64-bit) integer chapter column. The full 32-bit hash keeps
// collisions between distinct articles astronomically rare (vs a small modulus,
// which birthday-collides across ~1000 articles and wrongly dedups them).
function articleScopeHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h + 1; // 1 .. 2^32 (positive; SQLite INTEGER is 64-bit)
}

async function resolveUsernameFromDb(env: Env, userId: number): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT dcs_username FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ dcs_username: string }>();
  return row?.dcs_username ?? null;
}

async function resolveUsername(c: {
  env: Env;
  get: (k: "username") => string | undefined;
}, userId: number): Promise<string | null> {
  const fromJwt = c.get("username");
  if (fromJwt) return fromJwt;
  return resolveUsernameFromDb(c.env, userId);
}

interface PolledJob {
  job_id: string;
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: string;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  follow_up_options: string | null;
  follow_up_chain: string | null;
  follow_up_job_id: string | null;
  no_output_yet: number;
  // Prior poll's error_kind. Lets us detect a *repeated* import failure so a
  // deterministically-bad apply force-fails instead of holding the slot/lock.
  error_kind: string | null;
  // Which runner is executing this job (migration 0073). 'internal' reads
  // progress from wf_status_json and output from R2; NULL (pre-0073 rows) and
  // 'proxy' both mean the Fly bot. Stamped once at dispatch, so a job keeps
  // polling and importing the way it ran even if PIPELINE_MODE flips.
  runner: string | null;
  // The internal runner's status channel — TranslateWorkflow writes a
  // bot-shaped StatusResponse here (translate/status.ts). NULL for proxy jobs.
  wf_status_json: string | null;
}

interface ChainStepValue {
  pipelineType: PipelineType;
  options?: unknown;
}

// Public summary of a single job — same shape the menu's 409 conflict dialog
// already renders, reused for "what's running ahead of you" in the queue UI.
interface PublicJobSummary {
  job_id: string;
  pipeline_type: string;
  book: string;
  start_chapter: number;
  end_chapter: number;
  state: string;
  current_skill: string | null;
  current_status: string | null;
  created_at: number;
  updated_at: number;
  started_by_username: string | null;
}

// ── Queue helpers ──────────────────────────────────────────────────────────

const ACTIVE_PLACEHOLDERS = ACTIVE_STATES.map((_, i) => `?${i + 1}`).join(",");

// Snapshot of the global queue: the single active job (if any), the ordered
// list of queued job_ids, and a per-job position map. Position is 1-based and
// counts the active job — so the first queued job behind a running one is #2.
async function queueSnapshot(env: Env): Promise<{
  activeJob: PublicJobSummary | null;
  activeCount: number;
  queuedCount: number;
  positions: Map<string, { position: number; ahead: number }>;
}> {
  const activeRs = await env.DB.prepare(
    `SELECT j.job_id, j.pipeline_type, j.book, j.start_chapter, j.end_chapter,
            j.state, j.current_skill, j.current_status, j.created_at, j.updated_at,
            u.dcs_username AS started_by_username
       FROM pipeline_jobs j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE j.state IN (${ACTIVE_PLACEHOLDERS})
      ORDER BY j.created_at ASC`,
  )
    .bind(...ACTIVE_STATES)
    .all<PublicJobSummary>();
  const active = activeRs.results ?? [];
  const activeCount = active.length;

  const queuedRs = await env.DB.prepare(
    `SELECT job_id FROM pipeline_jobs
      WHERE state = 'queued'
      ORDER BY priority DESC, created_at ASC`,
  ).all<{ job_id: string }>();
  const queued = queuedRs.results ?? [];

  const positions = new Map<string, { position: number; ahead: number }>();
  queued.forEach((row, i) => {
    positions.set(row.job_id, { position: activeCount + i + 1, ahead: activeCount + i });
  });

  return {
    activeJob: active[0] ?? null,
    activeCount,
    queuedCount: queued.length,
    positions,
  };
}

// True when this deployment can run a translate job entirely in-Worker
// (docs/translate-internal-runner.md) — PIPELINE_MODE=internal, a non-empty
// internal-provider set, and a decryptable BYO key whose provider is in that
// set. This is the "no bot token needed" capability the three legacy
// BT_API_TOKEN gates were never taught about (#467): a deployment with this
// capability must be able to start, dispatch and poll internal jobs even when
// BT_API_TOKEN is unset, because those jobs never touch the Fly bot.
async function hasInternalAiCapability(env: Env): Promise<boolean> {
  if ((env.PIPELINE_MODE ?? "").trim().toLowerCase() !== "internal") return false;
  const providers = internalProviders(env);
  if (providers.size === 0) return false;
  const row = await getAiProviderConfig(env.DB);
  const ai = resolveDispatchAi(row, env.AI_KEY_WRAPPING_KEY);
  return ai.kind === "configured" && providers.has(ai.provider.trim().toLowerCase());
}

// Whether AI pipelines are available on this deployment at all: either the Fly
// proxy is configured (BT_API_TOKEN) or the internal runner is (BYO key +
// PIPELINE_MODE=internal). Only when NEITHER holds do the capability-probe and
// status routes report `pipeline_api_disabled` (#467). The token check
// short-circuits so a normal proxy deployment never pays the D1 read.
async function deploymentAiConfigured(env: Env): Promise<boolean> {
  if (env.BT_API_TOKEN) return true;
  return hasInternalAiCapability(env);
}

// Atomically claim the single bot slot for the highest-priority oldest queued
// job, then send it upstream. Safe under concurrent invocation: the claim is
// one UPDATE...WHERE NOT EXISTS(active) statement, which D1 serializes — only
// one caller can flip a row to 'dispatching' while no other job is active.
// No-op when the queue is empty or the slot is busy. On upstream failure the
// job is marked 'failed' (freeing the slot) rather than retried, so we never
// auto-launch a second concurrent run.
//
// NOT gated on BT_API_TOKEN (#467): an internal-runner job dispatches with no
// bot token, so the per-job fork at translateRunner() below decides. A job that
// resolves to the proxy path on a token-less deployment is failed cleanly there
// rather than POSTing a `Bearer undefined`.
export async function dispatchNext(env: Env): Promise<void> {

  // Claim: promote the head queued row to 'dispatching' iff nothing is active.
  const claim = await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'dispatching', updated_at = unixepoch()
      WHERE job_id = (
              SELECT job_id FROM pipeline_jobs
               WHERE state = 'queued'
               ORDER BY priority DESC, created_at ASC
               LIMIT 1
            )
        AND NOT EXISTS (
              SELECT 1 FROM pipeline_jobs WHERE state IN (${ACTIVE_PLACEHOLDERS})
            )`,
  )
    .bind(...ACTIVE_STATES)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return; // nothing to dispatch / slot busy

  // By invariant there is now exactly one 'dispatching' row — the one we just
  // claimed (the NOT EXISTS guard above prevents a second).
  const job = await env.DB.prepare(
    `SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
            session_key, options_json,
            source_generation, source_owner, source_repo, source_ref, source_stamps_json
       FROM pipeline_jobs WHERE state = 'dispatching' LIMIT 1`,
  ).first<{
    job_id: string;
    user_id: number;
    pipeline_type: string;
    book: string;
    start_chapter: number;
    end_chapter: number;
    session_key: string;
    options_json: string | null;
    source_generation: number | null;
    source_owner: string | null;
    source_repo: string | null;
    source_ref: string | null;
    source_stamps_json: string | null;
  }>();
  if (!job) return;

  const fail = async (kind: string, message: string) => {
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET state = 'failed', error_kind = ?2, error_message = ?3,
              updated_at = unixepoch()
        WHERE job_id = ?1`,
    )
      .bind(job.job_id, kind, message.slice(0, 500))
      .run();
  };

  // Our OWN dispatch-POST timeout firing does NOT mean the upstream request
  // never landed — only that WE gave up waiting (see DISPATCH_TIMEOUT_ERROR_
  // KIND/MESSAGE's doc comment for the full reasoning). Unlike `fail`, this
  // deliberately does NOT touch `state` — the row stays 'dispatching' (still
  // in ACTIVE_STATES, so the slot stays held) and only stamps error_kind/
  // error_message so it's visible and so the dedicated grace-period sweep in
  // pollAllNonTerminal (keyed on exactly this marker) can find it. Guarded on
  // `state = 'dispatching'` so this can never resurrect a row some other
  // caller (force-fail) has already moved on from.
  const markDispatchAmbiguous = async () => {
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET error_kind = ?2, error_message = ?3, updated_at = unixepoch()
        WHERE job_id = ?1 AND state = 'dispatching'`,
    )
      .bind(job.job_id, DISPATCH_TIMEOUT_ERROR_KIND, DISPATCH_TIMEOUT_ERROR_MESSAGE)
      .run();
  };

  const username = await resolveUsernameFromDb(env, job.user_id);
  if (!username) {
    await fail("sdk_error", "username_missing");
    return;
  }

  let options: unknown;
  if (job.options_json) {
    try {
      options = JSON.parse(job.options_json);
    } catch {
      /* corrupt snapshot — dispatch without options rather than wedge */
    }
  }

  // Generate jobs that target scripture must still match the stamp captured at
  // create. A freeze / activation mid-queue → fail closed (don't POST upstream).
  if (job.pipeline_type === "generate") {
    const contentTypes =
      options && typeof options === "object" && "contentTypes" in options
        ? (options as { contentTypes?: string[] }).contentTypes
        : undefined;
    const stamp = resolvedFromJobRow(job);
    const check = await assertPipelineStampStillValid(env, stamp, contentTypes);
    if (!check.ok) {
      await fail("lane_fenced", check.error);
      return;
    }
  }

  // Article translate jobs (tw/ta) are scoped by options.articleId/articleUrl,
  // NOT book/chapter — the editor stores a sentinel book ("TW"/"TA") + hashed
  // chapter only for its own dedup/scope bookkeeping. That sentinel is an
  // editor-internal detail and must NOT leak upstream: the bot's article
  // contract takes no book/chapter, so omit them for article jobs.
  const optResourceType =
    options && typeof options === "object" && "resourceType" in options
      ? (options as { resourceType?: unknown }).resourceType
      : undefined;
  const isArticleJob =
    job.pipeline_type === "translate" && (optResourceType === "tw" || optResourceType === "ta");
  const upstreamBody: Record<string, unknown> = {
    pipelineType: job.pipeline_type,
    ...(isArticleJob
      ? {}
      : { book: job.book, startChapter: job.start_chapter, endChapter: job.end_chapter }),
    username,
    sessionKey: job.session_key,
    ...(options ? { options } : {}),
  };

  // Per-org AI provider config (migration 0066): translate jobs only. Read
  // fresh at every dispatch — never cached — so an admin's config change
  // applies to jobs that were already queued. A BYO provider that can't be
  // decrypted must fail the job, never silently fall back to the shared
  // subscription (billing correctness).
  let aiApiKey: string | undefined; // plaintext lives ONLY in this function scope
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let dispatchAi: DispatchAi = { kind: "none" };
  if (job.pipeline_type === "translate") {
    const row = await getAiProviderConfig(env.DB);
    const ai = resolveDispatchAi(row, env.AI_KEY_WRAPPING_KEY);
    if (ai.kind === "error") {
      await fail("sdk_error", `ai_provider_unavailable: ${ai.reason}`);
      return;
    }
    dispatchAi = ai;
    if (ai.kind === "configured") {
      try {
        aiApiKey = await decryptApiKey(env.AI_KEY_WRAPPING_KEY!, ai.ciphertext, ai.iv);
      } catch {
        await fail("sdk_error", "ai_provider_key_decrypt_failed");
        return;
      }
      aiProvider = ai.provider;
      // Non-null in practice: resolveDispatchAi returns kind:'error'
      // ("model_missing") before 'configured' when the row has no model.
      aiModel = ai.model ?? undefined;
      Object.assign(upstreamBody, { provider: ai.provider, model: ai.model, apiKey: aiApiKey });
    }
  }

  // Internal runner fork (docs/translate-internal-runner.md §D.1). Everything
  // above — the slot claim, the stamp check, the username, the options snapshot,
  // the per-org provider resolve — is shared; only the "who actually runs it"
  // half differs. The internal branch never touches `upstreamBody` (it was built
  // for the bot's POST and carries the plaintext key, which must not travel) and
  // never reaches the fetch block below.
  if (translateRunner(env, job, dispatchAi, options) === "internal") {
    // params.workspace is REQUIRED by the Workflow: it re-points its own env on
    // the first line of run(), because a Workflow does NOT inherit the
    // per-request env clone. "default" is the implicit single-workspace slug
    // (workspaces.ts) — the same value workspaceEnv would have stamped — so this
    // fallback resolves to the same org, and a genuinely unknown slug fails
    // closed inside the Workflow rather than silently running on another tenant.
    const workspace = env.WORKSPACE_SLUG ?? "default";
    const instanceId = translateInstanceId(workspace, job.job_id);
    try {
      // provider/model are non-undefined here: translateRunner only answers
      // 'internal' when resolveDispatchAi returned `configured`, which sets both.
      const params = buildTranslateWorkflowParams({
        job,
        options,
        workspace,
        provider: aiProvider!,
        model: aiModel!,
      });
      await env.TRANSLATE_WORKFLOW.create({ id: instanceId, params });
    } catch (e) {
      // Same failure path as an upstream reject: fail the row (freeing the slot)
      // rather than retrying, so we never risk two concurrent runs. Scrubbed on
      // the same belt-and-braces principle as the upstream body below — the key
      // is not in params, but an error message is not ours to trust.
      const raw = e instanceof Error ? e.message : String(e);
      await fail("sdk_error", `translate_workflow_create_failed: ${aiApiKey ? scrubSecret(raw, aiApiKey) : raw}`);
      return;
    }
    // Same UPDATE the proxy path ends with, plus the runner stamp: the instance
    // id takes upstream_job_id's place as "the id of the run that is executing
    // this job", and runner='internal' pins the poll + import path for this row
    // even if PIPELINE_MODE flips while it is in flight.
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET state = 'running', upstream_job_id = ?2, runner = 'internal', updated_at = unixepoch()
        WHERE job_id = ?1`,
    )
      .bind(job.job_id, instanceId)
      .run();
    return;
  }

  // Past the internal fork: this job routes to the Fly proxy. That path is the
  // ONLY one that needs the bot token (#467). Without it we cannot reach Fly, so
  // fail the job cleanly — freeing the slot — rather than POST a `Bearer
  // undefined` upstream. dispatchNext is no longer gated on the token up top, so
  // this is where a token-less proxy job stops.
  if (!env.BT_API_TOKEN) {
    await fail(
      "pipeline_api_disabled",
      "no BT_API_TOKEN: this job routes to the Fly proxy, which is not configured on this deployment",
    );
    return;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBase(env)}/api/pipeline/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BT_API_TOKEN}`,
      },
      body: JSON.stringify(upstreamBody),
      // See DISPATCH_POST_TIMEOUT_MS's doc comment — bounding this below
      // STUCK_DISPATCH_THRESHOLD_SECONDS is what stops the stale-dispatch
      // sweep from ever racing a still-live POST (upstream issue #493).
      signal: AbortSignal.timeout(DISPATCH_POST_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      // Our OWN timeout firing before we even got a Response back — still
      // ambiguous, not a connection failure: the request bytes (method +
      // headers + body) may already have reached the bot even though we
      // gave up waiting on ITS response headers. See DISPATCH_TIMEOUT_ERROR_
      // KIND/MESSAGE's doc comment: this does NOT free the slot immediately
      // (progresses, does not fully close, upstream #493 — see upstream #511
      // for what would).
      await markDispatchAmbiguous();
    } else {
      // fetch() itself rejected with NO Response at all — a genuine
      // pre-connection failure (DNS, refused, reset before any bytes came
      // back). That is the one case that is NOT ambiguous: the request
      // never reached the bot, so there is nothing to hold the slot open
      // for. Fail immediately, same as the pre-existing non-OK path below.
      await fail("transient_outage", "upstream_unreachable");
    }
    return;
  }

  let text: string;
  try {
    text = await upstream.text();
  } catch {
    // We already HAVE a Response here — headers arrived, which proves the
    // request reached the bot. But `upstream.ok`/`upstream.status` are
    // header-level metadata, already fully received regardless of whether
    // the BODY stream later fails to read — so a non-OK status line is
    // still a definitive, readable signal even when the body isn't. When
    // the bot's status line already says the dispatch was REJECTED, we
    // don't need the body to know that: fail immediately with a
    // status-only message rather than holding the global slot for up to
    // AMBIGUOUS_DISPATCH_GRACE_SECONDS over a run that never started.
    // Only an OK status (or the fetch()-phase failure above, before any
    // status line exists at all) leaves genuine ambiguity about whether
    // the bot accepted and is now running this job.
    if (!upstream.ok) {
      await fail("sdk_error", `upstream ${upstream.status} (body unreadable)`);
    } else {
      await markDispatchAmbiguous();
    }
    return;
  }
  const scrubbed = aiApiKey ? scrubSecret(text, aiApiKey) : text;
  if (!upstream.ok) {
    await fail("sdk_error", `upstream ${upstream.status}: ${scrubbed.slice(0, 200)}`);
    return;
  }
  let parsed: { jobId?: string; provider?: string } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fall through to malformed handling */
  }
  if (!parsed || typeof parsed.jobId !== "string") {
    await fail("missing_output", `upstream missing jobId: ${scrubbed.slice(0, 200)}`);
    return;
  }

  // A provider was injected but the upstream bot didn't echo it back — the
  // bot predates provider support and silently ran the job on its own
  // default (billing correctness: never let a BYO-configured org's job run
  // unaccounted for on the shared subscription).
  // Two causes, both of which must fail the job rather than proceed: the bot
  // predates provider support and silently stripped the fields, or an unrelated
  // run already holds this scope upstream (the bot answers already_running and
  // withholds the ack, because that run may be another org's on the shared
  // subscription — attaching to it would bill uW and import foreign output).
  if (aiApiKey !== undefined && parsed.provider !== aiProvider) {
    await fail(
      "sdk_error",
      "ai_provider_not_acknowledged: upstream did not confirm the provider — either the bot predates provider support (deploy bp-assistant first) or another run already holds this scope",
    );
    return;
  }

  // Slot is ours and upstream accepted — record the bot's id and go running.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'running', upstream_job_id = ?2, updated_at = unixepoch()
      WHERE job_id = ?1`,
  )
    .bind(job.job_id, parsed.jobId)
    .run();
}

// Shared "fetch upstream, run import, update DB, fire follow-up" body used
// by both the GET handler and the scheduled cron poller. Returns the raw
// upstream response so callers that need to pass it through can do so;
// scheduled callers discard.
async function pollPipelineJob(
  env: Env,
  job: PolledJob,
): Promise<
  | { kind: "unreachable" }
  | { kind: "non_ok"; text: string; status: number }
  | { kind: "malformed"; text: string }
  | { kind: "ok"; text: string; status: number; state: string }
> {
  // A job without an upstream id hasn't reached the bot yet (queued or being
  // dispatched). Nothing to poll — callers handle these via queueSnapshot.
  if (!job.upstream_job_id) {
    return { kind: "ok", text: "{}", status: 200, state: "queued" };
  }
  // The ONLY runner-dependent read in this function (design §D.2). An internal
  // job's progress lives in pipeline_jobs.wf_status_json, written by
  // TranslateWorkflow in the bot's own StatusResponse shape — so from here down,
  // every line treats both runners identically.
  let data: StatusResponse | null = null;
  let text: string;
  let httpStatus = 200;
  if (job.runner === "internal") {
    data = readInternalStatus(job);
    text = JSON.stringify(data);
  } else {
    // #469: a proxy job that reached 'running' while BT_API_TOKEN was set can
    // outlive the token (removed mid-run). Fetching now would post
    // `Bearer undefined`; treat it as a transient outage instead so the job
    // stays recoverable rather than being marched to the poll cap.
    if (!env.BT_API_TOKEN) {
      return { kind: "unreachable" };
    }
    let upstream: Response;
    try {
      upstream = await fetch(
        `${upstreamBase(env)}/api/pipeline/${encodeURIComponent(job.upstream_job_id)}`,
        { headers: { Authorization: `Bearer ${env.BT_API_TOKEN}` } },
      );
    } catch {
      return { kind: "unreachable" };
    }

    text = await upstream.text();
    if (!upstream.ok) {
      return { kind: "non_ok", text, status: upstream.status };
    }

    try {
      data = JSON.parse(text) as StatusResponse;
    } catch {
      return { kind: "malformed", text };
    }
    httpStatus = upstream.status;
  }

  const shouldImport =
    job.no_output_yet === 1 &&
    data.state === "done" &&
    Array.isArray(data.output) &&
    data.output.length > 0;
  let importFailed = false;
  let importErrMessage: string | null = null;
  // Chapters this apply actually wrote to — used below to hint open tabs once
  // the finalize commit lands. Empty unless a successful import populated it.
  let appliedChapters: number[] = [];
  if (shouldImport && data.output) {
    try {
      const cfg = await getProjectConfig(env);
      const importResult = await importJobOutput(
        env,
        {
          jobId: job.job_id,
          pipelineType: job.pipeline_type,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          cfg,
          // Editor-delivery entries are fetched from the bot's output endpoint,
          // keyed by the bot's own job id — or, for an internal run, read from
          // R2 under this job's own prefix (pipelineImport.fetchInternalOutput).
          upstreamJobId: job.upstream_job_id ?? undefined,
          runner: job.runner,
        },
        data.output,
      );
      if (importResult.claimLost) {
        // A concurrent poll (the other of cron / open-tab) owns this import and
        // may still be mid-apply. Do NOT fall through to the finalize+follow-up
        // block: writing output_json / state='done' here would mark the import
        // complete before the owning poll's apply finishes, and if that poll
        // then fails the set output_json would suppress the retry. Return the
        // upstream status unchanged; the owning poll finalizes when it's done,
        // and the next poll (or this client's next tick) sees the result.
        return { kind: "ok", text, status: httpStatus, state: data.state ?? "running" };
      }
      appliedChapters = importResult.applied?.affectedChapters ?? [];
    } catch (err) {
      importFailed = true;
      importErrMessage = err instanceof Error ? err.message : String(err);
      console.error(`[pipelineImport] job=${job.job_id} failed:`, err);
    }
  }

  // When the local apply fails, hold state at 'running' for ONE retry so the
  // */5 cron re-imports (upstream is idempotent — its 'done' state sticks, so
  // the next poll hits the same shouldImport branch). This recovers a transient
  // failure (e.g. a D1 write hiccup). But 'running' both occupies the single
  // bot dispatch slot and globally locks the chapter for writes — so a
  // *deterministically* bad apply (malformed output that throws identically
  // every time) must not ride the 8h MAX_POLL_ATTEMPTS / 48h guards. If the
  // prior poll already failed the import, give up now: force 'failed', which is
  // terminal and frees both the slot (dispatchNext below) and the chapter lock.
  // Surface the failure via error_kind either way so the UI can flag it.
  // The bot sets interrupted:true when its process died mid-run and the job
  // was not resumed (a crash during a skill). It then keeps returning the
  // frozen last-known state='running' on every poll, so without honoring this
  // flag we hold the bot slot AND the chapter write-lock until the blunt
  // MAX_POLL_ATTEMPTS backstop (~8h of polling; took ~26h in the wild). The bot
  // is telling us the run is dead — fail it now and free both. (justplainjane47
  // ISA 41 notes, 2026-06-20: bot EACCES'd writing notes.log, reported
  // interrupted:true for ~26h before the poll-count backstop caught it.) Healthy
  // jobs report interrupted:false, including on done, so this only fires on a
  // genuinely interrupted, still-non-terminal run.
  const upstreamInterrupted =
    data.interrupted === true &&
    data.state !== "done" &&
    data.state !== "failed" &&
    data.state !== "cancelled";

  const importFailedAgain = importFailed && job.error_kind === "import_failed";
  const effectiveState = importFailed
    ? importFailedAgain
      ? "failed"
      : "running"
    : upstreamInterrupted
      ? "failed"
      : (data.state ?? "running");
  const effectiveErrorKind = importFailed
    ? "import_failed"
    : upstreamInterrupted
      ? "interrupted"
      : (data.current?.errorKind ?? null);
  const effectiveErrorMessage = importFailed
    ? importErrMessage
    : upstreamInterrupted
      ? (data.current?.error ?? "upstream reported interrupted")
      : (data.current?.error ?? null);

  await env.DB.prepare(
    `UPDATE pipeline_jobs SET
       state = ?2,
       current_skill = ?3,
       current_status = ?4,
       error_kind = ?5,
       error_message = ?6,
       output_json = ?7,
       raw_status_json = ?8,
       updated_at = unixepoch(),
       last_polled_at = unixepoch()
     WHERE job_id = ?1`,
  )
    .bind(
      job.job_id,
      effectiveState,
      data.current?.skill ?? null,
      data.current?.status ?? null,
      effectiveErrorKind,
      effectiveErrorMessage,
      data.output && !importFailed ? JSON.stringify(data.output) : null,
      text,
    )
    .run();

  // The apply wrote rows outside the HTTP path, so no per-row row.upserted
  // events fired — open tabs on these chapters are now silently stale. Send one
  // coalesced hint per changed chapter (not per row) so a whole-book apply stays
  // cheap against the subrequest budget. The client shows a "save & refresh"
  // prompt rather than refetching silently, so an in-progress edit is never
  // clobbered. Best-effort: broadcastChapter swallows its own errors.
  if (!importFailed) {
    for (const ch of appliedChapters) {
      await broadcastChapter(env, job.book, ch, {
        type: "chapter.pipeline_applied",
        book: job.book,
        chapter: ch,
        pipeline_type: job.pipeline_type,
      });
    }
  }

  // Gate followups on !importFailed: the chain assumes the parent's rows
  // are in D1 (e.g. the next step's prompt builder reads them). Without
  // this, an upstream-done-but-import-failed run would still trigger
  // notes -> tqs against an unimported parent.
  if (data.state === "done" && !importFailed && !job.follow_up_job_id) {
    try {
      const username = await resolveUsernameFromDb(env, job.user_id);
      if (username && job.follow_up_chain) {
        await enqueueFollowUpFromChain(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          chainJson: job.follow_up_chain,
          userId: job.user_id,
        });
      } else if (username && job.follow_up_options) {
        await enqueueFollowUp(env, {
          parentJobId: job.job_id,
          parentSessionKey: job.session_key,
          pipelineType: job.pipeline_type as PipelineType,
          book: job.book,
          startChapter: job.start_chapter,
          endChapter: job.end_chapter,
          followUpOptionsJson: job.follow_up_options,
          userId: job.user_id,
        });
      }
    } catch (err) {
      console.error(`[pipelineFollowUp] job=${job.job_id} failed:`, err);
    }
  }

  // On any terminal transition the bot slot is now free — pull the next job
  // (the priority=1 follow-up just enqueued, if any, wins). A first import
  // failure holds the job at 'running' (one retry) so it won't free the slot
  // here; a repeated one force-fails above and falls into this branch.
  if (effectiveState === "done" || effectiveState === "failed") {
    try {
      await dispatchNext(env);
    } catch (err) {
      console.error(`[dispatchNext] after job=${job.job_id}:`, err);
    }
  }

  // If the local apply failed, the upstream JSON still says state='done'.
  // The GET handler returns this text verbatim, so without adjustment the
  // client would mark the job complete and stop polling. Rewrite the
  // response to match what we actually stored.
  let responseText = text;
  if (importFailed) {
    const adjusted = {
      ...data,
      state: effectiveState,
      current: {
        ...(data.current ?? { chapter: 0, skill: "", status: "", startedAt: "" }),
        errorKind: "import_failed",
        error: importErrMessage ?? "import failed",
      },
    };
    responseText = JSON.stringify(adjusted);
  } else if (upstreamInterrupted) {
    // Upstream still says 'running'; we stored 'failed'. Rewrite so a tab
    // polling this job by id sees terminal and stops polling.
    responseText = JSON.stringify({
      ...data,
      state: "failed",
      current: {
        ...(data.current ?? { chapter: 0, skill: "", status: "", startedAt: "" }),
        errorKind: "interrupted",
        error: data.current?.error ?? "upstream reported interrupted",
      },
    });
  }

  return { kind: "ok", text: responseText, status: httpStatus, state: effectiveState };
}

// Two days. A non-terminal job that hasn't moved in this long is almost
// certainly orphaned (bot crashed mid-run, infra wedge, etc) — auto-fail it
// so the cron stops re-polling indefinitely. Translator can still re-trigger
// from the UI; the failed row will be replaced on the next start.
const STUCK_JOB_THRESHOLD_SECONDS = 86400 * 2;

// Belt-and-suspenders for jobs that keep returning state="running" forever
// (some upstream failure modes refresh updated_at on every poll). ~100 polls
// at the */5 cron cadence ≈ 8 hours; well past any legitimate slow run.
const MAX_POLL_ATTEMPTS = 100;

// A 'dispatching' row is mid-flight on the upstream POST, which returns in
// seconds. Anything stuck THIS LONG WITH NO error_kind/error_message SET AT
// ALL is a Worker that died before it could even record a result (crashed /
// evicted between claiming the slot and reaching dispatchNext's own catch
// block) — fail it (don't auto-re-dispatch) so we never risk launching a
// second concurrent run, and free the slot for the queue. Deliberately
// EXCLUDES a row carrying DISPATCH_TIMEOUT_ERROR_KIND/MESSAGE — that marker
// means dispatchNext's own code DID run and DID record an outcome (just an
// ambiguous one); AMBIGUOUS_DISPATCH_GRACE_SECONDS below governs those
// instead, on a separate, longer clock. The two sweeps are disjoint by
// construction (see pollAllNonTerminal): this one requires the marker
// ABSENT, the other requires it PRESENT.
const STUCK_DISPATCH_THRESHOLD_SECONDS = 120;

// The dispatch POST itself (dispatchNext) used to have no timeout at all.
// That let a slow POST (cold start / slow proxy) outlive
// STUCK_DISPATCH_THRESHOLD_SECONDS: the */5 sweep would fail the row and free
// the slot while the original POST was still in flight, and that same tick's
// dispatchNext safety net could then claim and dispatch a SECOND job —
// double-occupying the single-slot bot the instant the first POST eventually
// succeeded upstream (upstream issue #493). Bounding the POST comfortably
// below the sweep's threshold means OUR OWN catch always resolves the row
// first, so the STUCK_DISPATCH_THRESHOLD_SECONDS sweep can never find a
// genuinely still-live POST to race against — it now only ever catches a
// truly dead Worker (see that constant's doc comment).
const DISPATCH_POST_TIMEOUT_MS = (STUCK_DISPATCH_THRESHOLD_SECONDS - 30) * 1000;

// The (error_kind, error_message) pair dispatchNext stamps on a 'dispatching'
// row when ITS OWN DISPATCH_POST_TIMEOUT_MS fires — a signal read back by
// pollAllNonTerminal's ambiguous-dispatch sweep below. Centralized here (not
// inlined at each of the two call sites) so the stamp and the sweep's WHERE
// clause can never drift apart into two different strings that stop matching.
const DISPATCH_TIMEOUT_ERROR_KIND = "transient_outage";
const DISPATCH_TIMEOUT_ERROR_MESSAGE = "upstream_dispatch_timeout";

// PROGRESSES upstream #493; DOES NOT FULLY CLOSE IT — see upstream issue #511
// for what would (an upstream idempotency key, a status-by-sessionKey lookup,
// or a confirmed-cancel endpoint; bp-assistant offers none of the three
// today).
//
// When dispatchNext's own DISPATCH_POST_TIMEOUT_MS fires, aborting OUR fetch
// does not cancel the bot's server-side run if the POST already landed there
// — we genuinely cannot tell. Immediately freeing the slot on our own
// ambiguous timeout would just relocate the double-dispatch race from "the
// sweep races a still-live POST" (closed above) to "our own timeout races a
// POST that might still land" — narrower (bounded to this one ~90s edge case
// instead of any arbitrarily slow request) but not actually closed.
//
// So dispatchNext does NOT fail an ambiguous timeout immediately: it stamps
// DISPATCH_TIMEOUT_ERROR_KIND/MESSAGE and leaves `state` at 'dispatching' —
// still holding the slot — and this sweep is what finally frees it, but only
// after ONE EXTRA cron cycle (the */5 cadence) beyond dispatchNext's own
// timeout has passed with nothing else having resolved the row. This is a
// documented, best-effort mitigation, not a guarantee: if the bot's run is
// BOTH genuinely accepted AND still running past this entire grace window,
// the double-dispatch the issue describes can still happen — just in a
// much narrower window than before this constant existed.
const AMBIGUOUS_DISPATCH_GRACE_SECONDS = 300;

// #456: stop a translate job's Workflow instance when the row it belongs to is
// force-failed. A Worker that dies between a successful TRANSLATE_WORKFLOW.create()
// and the `state='running'` UPDATE that follows it (dispatchNext, around the
// create() call above) leaves the row 'dispatching' while the instance runs on —
// making paid model calls for a job every surface reports as failed and whose
// output is never imported. The instance id is a pure function of the workspace
// and the job id (translateInstanceId), so the sweep can rebuild it without
// having stored it (the crash window is exactly the case where upstream_job_id
// was never written). Best-effort: create() may never have landed, in which case
// there is no instance and get()/terminate() throws — that is expected, not an
// error, so it is swallowed. A terminate failure is likewise non-fatal; the
// row is already failed and the slot already freed regardless.
async function terminateTranslateInstance(env: Env, jobId: string): Promise<void> {
  if (env.TRANSLATE_WORKFLOW == null) return;
  const workspace = env.WORKSPACE_SLUG ?? "default";
  const instanceId = translateInstanceId(workspace, jobId);
  try {
    const instance = await env.TRANSLATE_WORKFLOW.get(instanceId);
    await instance.terminate();
  } catch {
    // No such instance (create() never landed) or already terminal — nothing to stop.
  }
}

// Polls every non-terminal pipeline_job. Designed for the scheduled
// handler — runs in parallel with per-job error isolation so one stuck
// upstream call doesn't drag the batch down.
export async function pollAllNonTerminal(env: Env): Promise<void> {
  // NOT gated on BT_API_TOKEN (#467): internal jobs poll from
  // pipeline_jobs.wf_status_json inside pollPipelineJob without touching Fly, so
  // a token-less internal deployment must still advance them on the cron. The
  // proxy branch of pollPipelineJob keeps its own token dependency; a proxy job
  // cannot exist on a token-less deployment (dispatchNext fails it before it
  // ever reaches 'running'), so nothing here spins a bot fetch without a token.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: no progress for 48h',
            updated_at = unixepoch()
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
        AND updated_at < unixepoch() - ?1`,
  )
    .bind(STUCK_JOB_THRESHOLD_SECONDS)
    .run();
  // Auto-fail anything that has been polled more than MAX_POLL_ATTEMPTS times
  // without reaching a terminal state. Independent backstop from the time-
  // based one above — catches the "fresh updated_at but never done" case.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: poll attempts exhausted',
            updated_at = unixepoch()
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
        AND attempt_count > ?1`,
  )
    .bind(MAX_POLL_ATTEMPTS)
    .run();
  // Recover wedged dispatches so a dead-mid-POST Worker can't hold the slot
  // forever.
  //
  // Excludes DISPATCH_TIMEOUT_ERROR_KIND/MESSAGE (see AMBIGUOUS_DISPATCH_
  // GRACE_SECONDS's doc comment): a row carrying that marker had its own
  // dispatchNext catch block run and record an ambiguous-but-not-dead
  // outcome, governed by the separate, longer sweep just below — this one
  // is only for a row that never got that far (Worker crashed/evicted
  // before dispatchNext's own catch could run at all).
  //
  // The exclusion MUST be NULL-safe: an ordinary dispatch that never hit
  // dispatchNext's catch block has error_kind/error_message = NULL (their
  // column default), and SQL's three-valued logic makes a plain `NOT
  // (error_kind = ?2 AND error_message = ?3)` evaluate to NULL — not
  // TRUE — for a NULL/NULL row, which a WHERE clause treats as "does not
  // match." That would silently exclude EVERY ordinary dead dispatch from
  // this sweep, wedging the single global slot forever the next time a
  // Worker genuinely died mid-POST. `IS NOT` compares NULL-safely (`NULL
  // IS NOT 'x'` is TRUE, matching the "this row does not carry the
  // marker" intent), so an untouched NULL/NULL row is correctly INCLUDED
  // and only an exact-marker match is excluded.
  // #456: capture the translate jobs this sweep is about to force-fail, under
  // the SAME predicate the UPDATE uses, so their orphaned Workflow instances can
  // be terminated once the row is failed. Gated to pipeline_type='translate'
  // because the crash window has not yet written runner='internal' (that UPDATE
  // is the one that never ran); a proxy translate job simply has no instance, so
  // the deterministic-id terminate below no-ops. Read before the UPDATE, while
  // the rows are still 'dispatching'.
  const stuckTranslateDispatches = await env.DB.prepare(
    `SELECT job_id FROM pipeline_jobs
      WHERE state = 'dispatching'
        AND pipeline_type = 'translate'
        AND updated_at < unixepoch() - ?1
        AND (error_kind IS NOT ?2 OR error_message IS NOT ?3)`,
  )
    .bind(STUCK_DISPATCH_THRESHOLD_SECONDS, DISPATCH_TIMEOUT_ERROR_KIND, DISPATCH_TIMEOUT_ERROR_MESSAGE)
    .all<{ job_id: string }>();
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'interrupted',
            error_message = 'auto-failed: dispatch did not complete',
            updated_at = unixepoch()
      WHERE state = 'dispatching'
        AND updated_at < unixepoch() - ?1
        AND (error_kind IS NOT ?2 OR error_message IS NOT ?3)`,
  )
    .bind(STUCK_DISPATCH_THRESHOLD_SECONDS, DISPATCH_TIMEOUT_ERROR_KIND, DISPATCH_TIMEOUT_ERROR_MESSAGE)
    .run();
  // Terminate ONLY the rows this sweep actually force-failed. The SELECT above
  // and the UPDATE are two separate statements, so a still-live dispatchNext can
  // land its `state='running', runner='internal'` UPDATE (which carries no
  // `WHERE state='dispatching'` guard of its own) in between: the force-fail
  // then no-ops and the row is legitimately running. Terminating on the SELECT's
  // say-so would kill that live instance and leave a `running` row holding the
  // single global dispatch slot and the chapter write-lock until the 48h
  // no-progress sweep. Re-reading state after the UPDATE closes that window.
  const capturedIds = (stuckTranslateDispatches.results ?? []).map((r) => r.job_id);
  if (capturedIds.length > 0) {
    const placeholders = capturedIds.map((_, i) => `?${i + 1}`).join(", ");
    const forceFailed = await env.DB.prepare(
      `SELECT job_id FROM pipeline_jobs
        WHERE job_id IN (${placeholders})
          AND state = 'failed'
          AND error_kind = 'interrupted'`,
    )
      .bind(...capturedIds)
      .all<{ job_id: string }>();
    for (const r of forceFailed.results ?? []) {
      await terminateTranslateInstance(env, r.job_id);
    }
  }
  // Upstream #493 / #511: a dispatch that timed out on OUR side (marked
  // ambiguous by dispatchNext's own catch block, see
  // AMBIGUOUS_DISPATCH_GRACE_SECONDS's doc comment) gets one extra grace
  // period, longer than STUCK_DISPATCH_THRESHOLD_SECONDS and counted from
  // when we stamped the marker (updated_at), before we finally give up and
  // free the slot. This does not confirm whether the upstream run actually
  // happened — see upstream #511 for the upstream API support that would.
  await env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'failed',
            error_kind = 'transient_outage',
            error_message = 'auto-failed: dispatch POST timed out and never confirmed landing upstream (grace period expired)',
            updated_at = unixepoch()
      WHERE state = 'dispatching'
        AND error_kind = ?2 AND error_message = ?3
        AND updated_at < unixepoch() - ?1`,
  )
    .bind(AMBIGUOUS_DISPATCH_GRACE_SECONDS, DISPATCH_TIMEOUT_ERROR_KIND, DISPATCH_TIMEOUT_ERROR_MESSAGE)
    .run();
  const rs = await env.DB.prepare(
    `SELECT job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
            end_chapter, session_key, follow_up_options, follow_up_chain,
            follow_up_job_id, error_kind, (output_json IS NULL) AS no_output_yet,
            runner, wf_status_json
       FROM pipeline_jobs
      WHERE state IN ('running', 'paused_for_outage', 'paused_for_usage_limit')
      ORDER BY updated_at ASC
      LIMIT 50`,
  ).all<PolledJob>();
  let jobs = rs.results ?? [];
  // #469: with no BT_API_TOKEN, proxy jobs can't be polled (pollPipelineJob's
  // proxy branch would post `Bearer undefined`). Drop them BEFORE the
  // attempt_count bump so a mid-run token removal doesn't march an otherwise
  // recoverable proxy job to the poll cap and auto-fail it. Internal jobs read
  // their status from D1 with no token, so they still advance.
  if (!env.BT_API_TOKEN) {
    const before = jobs.length;
    jobs = jobs.filter((j) => j.runner === "internal");
    const skipped = before - jobs.length;
    // #496: those skipped proxy rows are in ACTIVE_STATES (running/paused_*),
    // which is the single global dispatch slot — but with no token they are
    // neither polled nor advanced toward the MAX_POLL_ATTEMPTS cap (their
    // attempt_count is not bumped below). So they HOLD the slot (and the chapter
    // write-lock), blocking every other job — internal translate jobs included —
    // until the 48h no-progress sweep frees it. That is the deliberate #469/#474
    // trade (recoverable beats auto-failed), and it self-heals if the token
    // returns, so this is not reverted here — but it was silent. Log it once per
    // tick (this cron runs every ~5 min) so the wedge is visible to an operator
    // instead of a queue that has quietly stopped dispatching for up to 48h.
    if (skipped > 0) {
      console.warn(
        `[scheduled.pipelinePoll] BT_API_TOKEN unset: skipped ${skipped} non-internal (proxy) job(s) in ACTIVE_STATES; ` +
          `they hold the single dispatch slot and will not advance until the token returns or the 48h no-progress sweep frees it`,
      );
    }
  }
  if (jobs.length > 0) {
    // Bump attempt_count for everything we're about to poll, in one batch. We
    // do this BEFORE the upstream calls so a Worker crash doesn't undo the
    // increment — the cap is the whole point of this column.
    await env.DB.prepare(
      `UPDATE pipeline_jobs
          SET attempt_count = attempt_count + 1
        WHERE job_id IN (${jobs.map((_, i) => `?${i + 1}`).join(",")})`,
    )
      .bind(...jobs.map((j) => j.job_id))
      .run();
    await Promise.allSettled(
      jobs.map((j) =>
        pollPipelineJob(env, j).catch((err) => {
          console.error(`[scheduled.pipelinePoll] job=${j.job_id}:`, err);
        }),
      ),
    );
  }

  // Safety net: if the slot is free and something is queued, dispatch it. This
  // covers a terminal transition whose inline dispatchNext was missed (e.g. a
  // Worker crash) and the first job after the bot was idle.
  try {
    await dispatchNext(env);
  } catch (err) {
    console.error("[scheduled.dispatchNext]:", err);
  }
}

// POST /api/pipelines/start
pipelines.post("/start", requireEditor, async (c) => {
  // The BT_API_TOKEN gate moved below the body parse + provider resolve (#467):
  // it must fire only for a job that would actually route to the Fly proxy, so
  // an internal-runner translate job can start on a token-less deployment. See
  // the gate just before the source-stamp resolve.
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = StartBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }

  const username = await resolveUsername(c, userId);
  if (!username) return c.json({ error: "username_missing" }, 400);

  // Article translate (tw|ta) is scoped by article, not book/chapter. It reuses
  // the pipeline_jobs scope columns via a per-article sentinel so all the
  // dispatch/poll/apply plumbing works unchanged; the real selector rides in
  // options.articleId/articleUrl.
  const t = parsed.data.translate;
  const rt = t?.resourceType;
  const isArticleResource = rt === "tw" || rt === "ta";
  const articleKey = t?.articleId ?? t?.articleUrl;
  const isArticleTranslate =
    parsed.data.pipelineType === "translate" && isArticleResource;
  if (isArticleTranslate && !articleKey) {
    return c.json(
      { error: "article_selector_required", message: "tw/ta translate requires translate.articleId or translate.articleUrl" },
      400,
    );
  }
  let book: string;
  let startChapter: number;
  let endChapter: number;
  if (isArticleTranslate) {
    book = (rt as string).toUpperCase(); // "TW" | "TA" (scope tag)
    startChapter = endChapter = articleScopeHash(articleKey!);
  } else {
    if (!parsed.data.book || !parsed.data.startChapter) {
      return c.json({ error: "book_and_start_chapter_required" }, 400);
    }
    startChapter = parsed.data.startChapter;
    endChapter = parsed.data.endChapter ?? startChapter;
    book = parsed.data.book.toUpperCase();
  }

  // De-dup against our own queue/active set before enqueueing (replaces
  // relying on the bot's same-scope 409, which can't see our queue). Same
  // user + same scope/type → focus the existing job. Different user → the
  // enriched 409 the menu renders as an "Already running / queued" dialog.
  // A translate job's identity includes its resourceType (tn|tq|tw|ta): a tN and
  // a tQ translate of the same chapter share (book, chapter, pipeline_type) but
  // are different work, so they must NOT dedup against each other. Non-translate
  // jobs ignore this (bind null → clause is vacuously true). Old translate jobs
  // predating resourceType default to 'tn' via COALESCE.
  const dedupResourceType =
    parsed.data.pipelineType === "translate" ? (rt ?? "tn") : null;
  // A translate job's identity ALSO includes its row scope (#316). A row-scoped
  // translate ("re-run AI on THIS note", translate.rowIds) must not dedup against
  // a different row's in-flight job in the same chapter — otherwise row B is
  // answered `already_running` with row A's id and never runs. The normalized
  // (sorted+deduped) rowIds set is persisted in options_json by
  // buildTranslateOptions, and `json_extract($.rowIds)` re-serializes it to the
  // same text JSON.stringify produces for these short ids, so we compare as text.
  // A chapter-wide job has no $.rowIds → COALESCE to the 'ALL' sentinel, which
  // only matches another chapter-wide request. Result: same row → dup; different
  // rows → distinct jobs; chapter-wide and row-scoped never dedup against each
  // other. Non-translate jobs bind null → clause vacuous.
  const dedupNormRowIds =
    parsed.data.pipelineType === "translate"
      ? normalizeRowIds(parsed.data.translate?.rowIds)
      : undefined;
  const dedupRowScope =
    parsed.data.pipelineType === "translate"
      ? // row-scoped → the JSON array text json_extract($.rowIds) yields;
        // chapter-wide → the bare 'ALL' sentinel COALESCE substitutes for a
        // missing $.rowIds. (Must NOT be JSON.stringify("ALL") — that is quoted.)
        dedupNormRowIds
        ? JSON.stringify(dedupNormRowIds)
        : "ALL"
      : null;
  // A translate job's identity ALSO includes its verse-range scope (#347 item 2).
  // A verse-range translate (translate.verseStart/verseEnd) carries no rowIds, so
  // its row scope resolves to the 'ALL' sentinel — meaning two verse-range
  // translates of DIFFERENT verses in one chapter would collapse (same bug shape as
  // #316, now for the verse-range scope). buildTranslateOptions persists
  // verseStart/verseEnd into options_json, so add a numeric term keyed on each,
  // COALESCE'd to a 0 sentinel (verseStart/verseEnd are .positive(), so 0 is safe
  // and never a real value). A non-verse-range translate binds 0 → matches the 0
  // sentinel vacuously, so chapter-wide and row-scoped behavior is unchanged; a
  // verse-range vs chapter-wide/row-scoped stays distinct, consistent with #316's
  // row-scoped-vs-chapter-wide choice. Non-translate jobs bind null → clause vacuous.
  // API-surface-only today: all web callers send rowIds or nothing.
  const dedupVerseStart =
    parsed.data.pipelineType === "translate" ? (parsed.data.translate?.verseStart ?? 0) : null;
  const dedupVerseEnd =
    parsed.data.pipelineType === "translate" ? (parsed.data.translate?.verseEnd ?? 0) : null;
  // The projected columns are identical for both conflict queries (exact
  // identity and coverage) — the 409 body renders the same `existing` block
  // either way.
  const conflictColumns = `j.job_id, j.user_id, j.pipeline_type, j.book, j.start_chapter,
            j.end_chapter, j.state, j.current_skill, j.current_status,
            j.created_at, j.updated_at, u.dcs_username AS started_by_username`;
  let dup = await c.env.DB.prepare(
    `SELECT ${conflictColumns}
       FROM pipeline_jobs j
       LEFT JOIN users u ON u.id = j.user_id
      WHERE ${PIPELINE_DEDUP_WHERE}
      ORDER BY j.created_at ASC
      LIMIT 1`,
  )
    .bind(
      book,
      startChapter,
      endChapter,
      parsed.data.pipelineType,
      dedupResourceType,
      dedupRowScope,
      dedupVerseStart,
      dedupVerseEnd,
    )
    .first<PublicJobSummary & { user_id: number }>();
  // #347 item 1 — "broader blocks narrower" (decided 2026-08-27). Exact identity
  // above is not enough: a row-scoped or verse-ranged translate started while a
  // CHAPTER-WIDE translate of the same book/chapter/resource is in flight would
  // redraft rows the running job already covers (duplicate upstream work,
  // serialized by the single slot, last apply wins). Same for a verse range
  // nested inside a covering verse range. When the incoming request is the
  // narrower one, look for a covering in-flight job and answer with ITS id, using
  // the same already_running / 409 shape as the exact-dup path.
  //
  // One-way by construction: this runs ONLY when the request itself is narrower,
  // so the reverse direction — a chapter-wide request while a row-scoped job runs
  // — is untouched and proceeds exactly as before. Non-translate pipelines never
  // reach it. See pipelineDedupSql.ts for the covering shapes and for the
  // deliberately-open gap (row-scoped request inside a verse-range job, which
  // would need a rowId → verse lookup this route does not do).
  const isTranslateStart = parsed.data.pipelineType === "translate";
  const coverageVerses = coverageVerseRange(
    isTranslateStart ? parsed.data.translate?.verseStart : undefined,
    isTranslateStart ? parsed.data.translate?.verseEnd : undefined,
  );
  const requestIsNarrowerScope = isNarrowerTranslateScope(
    parsed.data.pipelineType,
    dedupNormRowIds,
    coverageVerses,
  );
  if (!dup && requestIsNarrowerScope) {
    dup = await c.env.DB.prepare(
      `SELECT ${conflictColumns}
         FROM pipeline_jobs j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE ${PIPELINE_COVERAGE_WHERE}
        ORDER BY j.created_at ASC
        LIMIT 1`,
    )
      .bind(
        book,
        startChapter,
        endChapter,
        dedupResourceType,
        coverageVerses.start,
        coverageVerses.end,
      )
      .first<PublicJobSummary & { user_id: number }>();
  }
  if (dup) {
    if (dup.user_id === userId) {
      const resp: StartResponse = {
        jobId: dup.job_id,
        scope: { book, startChapter, endChapter },
        status: "already_running",
      };
      return c.json(resp);
    }
    return c.json(
      {
        error: "conflict",
        jobId: dup.job_id,
        existing: {
          job_id: dup.job_id,
          pipeline_type: dup.pipeline_type,
          book: dup.book,
          start_chapter: dup.start_chapter,
          end_chapter: dup.end_chapter,
          state: dup.state,
          current_skill: dup.current_skill,
          current_status: dup.current_status,
          created_at: dup.created_at,
          updated_at: dup.updated_at,
          started_by_username: dup.started_by_username,
        },
      },
      409,
    );
  }

  // For notes pipelines, gather any hint=1 stubs the editor has queued in
  // the chapter range and fold them into options.hints. The proxy is the
  // authoritative source (not the client) so D1 state at start time wins
  // over any stale local cache. bp-assistant echoes each hint's rowId back
  // as the TSV ID column for the expanded row, which is how the apply
  // phase correlates expansion → stub. See docs/bp-assistant-tn-hints-
  // contract.md for the full design.
  // Wider type for mergedOptions: hints is a server-added field, not part of
  // the client-validated PipelineOptions schema (clients never send it).
  let mergedOptions: Record<string, unknown> | undefined = parsed.data.options;
  if (parsed.data.pipelineType === "translate") {
    // Translate options are server-authoritative, derived from the active
    // project config (bp-bot/translate-pipeline/PLAN.md §1). The bot fetches
    // source rows by `sourceRef`, so there's nothing to gather from D1.
    const cfg = await getProjectConfig(c.env);
    let translateOptions = buildTranslateOptions(cfg, parsed.data.translate);
    if (!translateOptions) {
      // Two distinct null causes: the project has no translationSource at all
      // (not a GL project), OR it has one but the chosen resource's source repo
      // was left blank in Setup (no source to translate FROM for that resource).
      const rt = parsed.data.translate?.resourceType ?? "tn";
      return cfg.translationSource
        ? c.json(
            {
              error: "no_source_for_resource",
              message: `Translate is unavailable for ${rt}: this project's translation source has no ${rt} repo configured. Configure a source repo for ${rt} (or leave it blank and translate a different resource).`,
            },
            400,
          )
        : c.json(
            {
              error: "not_a_gl_project",
              message:
                "Translate is only available for gateway-language projects (this project has no translation source). Switch the project config to a GL preset first.",
            },
            400,
          );
    }
    // Inject the pinned contextRef from the latest successful context-pack
    // export (prefs/terminology reach the bot through that repo). Owner comes
    // from the export result (DCS_EXPORT_OWNER ?? exportOrg at export time),
    // never from cfg.exportOrg alone. No successful SHA → stay raw baseline
    // (omit; the bot's own default is allowEmpty).
    const latest = await getLatestSuccessfulContextExport(c.env);
    translateOptions = applyContextRef(translateOptions, latest);
    if (!latest) {
      console.warn("no successful context export; translate runs raw baseline (contextRef omitted)");
    }
    mergedOptions = translateOptions;
  } else if (parsed.data.pipelineType === "notes") {
    const hintRows = await c.env.DB.prepare(
      `SELECT id, verse, quote, support_reference, note
         FROM tn_rows
        WHERE book = ?1 AND chapter BETWEEN ?2 AND ?3
          AND hint = 1 AND deleted_at IS NULL
        ORDER BY chapter, verse, sort_order ASC NULLS LAST, id`,
    )
      .bind(book, startChapter, endChapter)
      .all<{
        id: string;
        verse: number;
        quote: string | null;
        support_reference: string | null;
        note: string | null;
      }>();
    const hints = (hintRows.results ?? []).map((r) => ({
      rowId: r.id,
      verse: r.verse,
      // Contract requires quote to be a string ("may be Hebrew, Greek, or
      // empty") — general-information hints have a null quote in D1, so coerce
      // to "" rather than sending null (upstream 400s on null). See
      // docs/bp-assistant-tn-hints-contract.md.
      quote: r.quote ?? "",
      supportReference: r.support_reference,
      seed: r.note,
    }));
    if (hints.length > 0) {
      mergedOptions = { ...(parsed.data.options ?? {}), hints };
    }
  }

  // Bot-token gate (#467), now scoped to jobs that need the bot. A translate
  // job that resolves to the internal runner (BYO key, PIPELINE_MODE=internal,
  // a TSV resource on a ported provider) never touches Fly, so it may start with
  // no BT_API_TOKEN. Everything else — generate/notes/tqs, a shared-subscription
  // translate, an un-ported provider, an article resource — still routes to the
  // proxy and fails closed here, before the job is ever enqueued. mergedOptions
  // carries the server-resolved resourceType translateRunner reads.
  if (!c.env.BT_API_TOKEN) {
    let runner: "proxy" | "internal" = "proxy";
    if (parsed.data.pipelineType === "translate") {
      const aiRow = await getAiProviderConfig(c.env.DB);
      const ai = resolveDispatchAi(aiRow, c.env.AI_KEY_WRAPPING_KEY);
      runner = translateRunner(c.env, { pipeline_type: "translate" }, ai, mergedOptions);
    }
    if (runner !== "internal") {
      return c.json({ error: "pipeline_api_disabled" }, 503);
    }
  }

  // Stamp lane generation + source identity at create so a mid-run replacement
  // cannot silently land applies onto a new generation.
  let sourceStamp: ResolvedPipelineStamp = EMPTY_RESOLVED;
  try {
    sourceStamp = await resolvePipelineSourceStamp(
      c.env,
      parsed.data.pipelineType,
      (mergedOptions ?? parsed.data.options) as z.infer<typeof PipelineOptions> | undefined,
    );
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = e instanceof Error ? e.message : String(e);
    if (status === 403 || status === 409 || status === 422) {
      return c.json({ error: msg, detail: (e as { detail?: unknown }).detail }, status as 403 | 409 | 422);
    }
    throw e;
  }

  // Enqueue. The job goes to the bot only when dispatchNext claims the slot.
  const jobId = crypto.randomUUID();
  const optionsJson = mergedOptions ? JSON.stringify(mergedOptions) : null;
  const followUpJson = parsed.data.followUpOptions
    ? JSON.stringify(parsed.data.followUpOptions)
    : null;
  const followUpChainJson = parsed.data.followUpChain
    ? JSON.stringify(parsed.data.followUpChain)
    : null;
  await c.env.DB.prepare(
    `INSERT INTO pipeline_jobs (
       job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
       session_key, state, priority, options_json, follow_up_options,
       follow_up_chain, source_generation, source_owner, source_repo, source_ref,
       source_stamps_json, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 0, ?8, ?9, ?10,
               ?11, ?12, ?13, ?14, ?15, unixepoch(), unixepoch())`,
  )
    .bind(
      jobId,
      userId,
      parsed.data.pipelineType,
      book,
      startChapter,
      endChapter,
      parsed.data.sessionKey,
      optionsJson,
      followUpJson,
      followUpChainJson,
      sourceStamp.legacy.source_generation,
      sourceStamp.legacy.source_owner,
      sourceStamp.legacy.source_repo,
      sourceStamp.legacy.source_ref,
      sourceStamp.stampsJson,
    )
    .run();

  // Try to dispatch immediately — the common case (empty queue) goes straight
  // to running. dispatchNext claims the head of the queue, which may be a
  // higher-priority job than this one, so re-read this job's resulting state.
  try {
    await dispatchNext(c.env);
  } catch (err) {
    console.error("[start.dispatchNext]:", err);
  }

  const after = await c.env.DB.prepare(
    `SELECT state, error_message FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ state: string; error_message: string | null }>();
  const state = after?.state ?? "queued";

  if (state === "running" || state === "dispatching") {
    const resp: StartResponse = {
      jobId,
      scope: { book, startChapter, endChapter },
      status: "running",
    };
    return c.json(resp);
  }
  if (state === "failed") {
    // This job won the slot but the upstream POST failed during its own
    // dispatch. Surface it so the menu toasts instead of pretending success.
    return c.json({ error: "upstream_error", message: after?.error_message ?? "dispatch failed" }, 502);
  }
  // Still queued — something else holds the slot or is ahead by priority.
  const snap = await queueSnapshot(c.env);
  const resp: StartResponse = {
    jobId,
    scope: { book, startChapter, endChapter },
    status: "queued",
    queuePosition: snap.positions.get(jobId)?.position,
  };
  return c.json(resp);
});

// GET /api/pipelines/:jobId
pipelines.get("/:jobId", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  // Ownership check before any upstream call — prevents jobId enumeration.
  // pollPipelineJob() handles fetch/import/update/follow-up; we just gate
  // it on the requester owning the job. Read the row first so the capability
  // gate below can consult its stamped runner (#469).
  const owned = await c.env.DB.prepare(
    `SELECT job_id, upstream_job_id, user_id, pipeline_type, book, start_chapter,
            end_chapter, session_key, follow_up_options, follow_up_chain,
            follow_up_job_id, error_kind, state, current_skill, current_status,
            created_at, updated_at, (output_json IS NULL) AS no_output_yet,
            runner, wf_status_json
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<PolledJob & {
      state: string;
      current_skill: string | null;
      current_status: string | null;
      created_at: number;
      updated_at: number;
    }>();

  // Capability gate — also the AiScreen "is AI configured?" probe: a bogus id
  // still 503s here when NEITHER the proxy NOR the internal runner is available
  // (#467) — otherwise a token-less internal deployment could neither poll a
  // running internal job nor clear the "set BT_API_TOKEN" banner. But an
  // already-dispatched internal job's status lives in D1 and needs no token, so
  // let it through even if PIPELINE_MODE / the provider allowlist flipped after
  // dispatch (#469): availability for an existing job is a function of how it
  // was dispatched (its stamped runner), not current config.
  if (owned?.runner !== "internal" && !(await deploymentAiConfigured(c.env))) {
    return c.json({ error: "pipeline_api_disabled" }, 503);
  }
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);

  // Queued / dispatching jobs aren't on the bot yet — synthesize a status
  // payload from D1 plus the live queue position, no upstream round-trip.
  if (!owned.upstream_job_id) {
    const snap = await queueSnapshot(c.env);
    const pos = snap.positions.get(owned.job_id);
    return c.json({
      jobId: owned.job_id,
      pipelineType: owned.pipeline_type,
      scope: {
        book: owned.book,
        startChapter: owned.start_chapter,
        endChapter: owned.end_chapter,
      },
      state: owned.state,
      updatedAt: new Date(owned.updated_at * 1000).toISOString(),
      createdAt: new Date(owned.created_at * 1000).toISOString(),
      queuePosition: pos?.position,
      queueAhead: pos?.ahead,
    });
  }

  // A locally-terminal job is authoritative: once it's cancelled (by the user)
  // or done, don't re-poll upstream. A stale upstream 'running' would otherwise
  // clobber the terminal state back to 'running' on every poll — an open tab
  // polling this job_id by id resurrects a just-cancelled job each tick. Return
  // the stored state so the client sees terminal and stops polling.
  if (owned.state === "cancelled" || owned.state === "done") {
    return c.json({
      jobId: owned.job_id,
      pipelineType: owned.pipeline_type,
      scope: {
        book: owned.book,
        startChapter: owned.start_chapter,
        endChapter: owned.end_chapter,
      },
      state: owned.state,
      updatedAt: new Date(owned.updated_at * 1000).toISOString(),
      createdAt: new Date(owned.created_at * 1000).toISOString(),
    });
  }

  const result = await pollPipelineJob(c.env, owned);
  if (result.kind === "unreachable") return c.json({ error: "upstream_unreachable" }, 502);
  if (result.kind === "malformed") return c.json({ error: "upstream_malformed" }, 502);
  return new Response(result.text, {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
});

interface FollowUpInput {
  parentJobId: string;
  parentSessionKey: string;
  pipelineType: PipelineType;
  book: string;
  startChapter: number;
  endChapter: number;
  followUpOptionsJson: string;
  userId: number;
}

// Enqueues the parent's queued same-type follow-up as a fresh priority=1
// pipeline_jobs row (asymmetric ULT/UST alignment). It does NOT call the bot —
// dispatchNext sends it upstream when the slot frees, which (priority=1) is
// ahead of other users' queued jobs so the pair stays together. The child's
// job_id is derived deterministically from the parent so two concurrent polls
// collapse via ON CONFLICT DO NOTHING; the parent claim guard makes the whole
// thing idempotent.
async function enqueueFollowUp(env: Env, input: FollowUpInput): Promise<void> {
  // Normalize any rowIds a translate child carries so the stored options_json
  // holds the canonical (sorted+deduped) set the dedupe key compares against (#347).
  const followUpOptions = normalizeTranslateRowIdsJson(input.pipelineType, input.followUpOptionsJson);
  // Derive a sessionKey that fits the same character class as the parent's
  // (POST validator: ^[A-Za-z0-9_\-/]+$). The "/followup" suffix avoids
  // colliding with the parent on the upstream dedup key.
  const childSessionKey = `${input.parentSessionKey}/followup`;
  const childJobId = `${input.parentJobId}:followup`;

  // Inherit the parent's source stamp so the follow-up apply fences the same
  // generation the parent was started against.
  const parentStamp = await env.DB.prepare(
    `SELECT source_generation, source_owner, source_repo, source_ref, source_stamps_json
       FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(input.parentJobId)
    .first<PipelineSourceStamp & { source_stamps_json: string | null }>();

  // Claim + insert as one atomic batch so a crash between them can't orphan
  // the child or lose the follow-up. The parent guard (follow_up_job_id IS
  // NULL) means only the first poll wins; the deterministic childJobId means a
  // racing second poll's INSERT collapses via ON CONFLICT DO NOTHING.
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(childJobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, priority, options_json,
           source_generation, source_owner, source_repo, source_ref, source_stamps_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 1, ?8,
                   ?9, ?10, ?11, ?12, ?13, unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        childJobId,
        input.userId,
        input.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
        followUpOptions,
        parentStamp?.source_generation ?? null,
        parentStamp?.source_owner ?? null,
        parentStamp?.source_repo ?? null,
        parentStamp?.source_ref ?? null,
        parentStamp?.source_stamps_json ?? null,
      ),
  ]);
}

interface FollowUpChainInput {
  parentJobId: string;
  parentSessionKey: string;
  book: string;
  startChapter: number;
  endChapter: number;
  chainJson: string;
  userId: number;
}

// Enqueues the next step of a cross-type chain (e.g. generate -> notes -> tqs)
// on a parent done-transition. Pops the first chain element, uses it as the
// child's pipelineType + options, and stores the remainder on the child row
// so the same logic fires the next step when this child completes. Same
// priority=1 + atomic-batch + deterministic-id idempotency as enqueueFollowUp.
async function enqueueFollowUpFromChain(env: Env, input: FollowUpChainInput): Promise<void> {
  let chain: ChainStepValue[];
  try {
    chain = JSON.parse(input.chainJson) as ChainStepValue[];
  } catch {
    throw new Error(`invalid follow_up_chain JSON on ${input.parentJobId}`);
  }
  if (!Array.isArray(chain) || chain.length === 0) {
    return; // nothing to fire
  }
  const [next, ...rest] = chain;
  if (!next || !next.pipelineType) {
    throw new Error(`malformed chain head on ${input.parentJobId}`);
  }

  // Each chain link gets its own sessionKey suffix. Counting the depth keeps
  // upstream's (sessionKey, pipelineType, scope) dedup buckets distinct even
  // if two adjacent links happen to share a pipelineType.
  const depth = countChainSuffixes(input.parentSessionKey);
  const childSessionKey = `${input.parentSessionKey}/chain${depth + 1}`;
  const childJobId = `${input.parentJobId}:chain${depth + 1}`;
  const childChainJson = rest.length > 0 ? JSON.stringify(rest) : null;
  // Normalize any rowIds a translate chain step carries so the stored options_json
  // holds the canonical (sorted+deduped) set the dedupe key compares against (#347).
  const childOptionsJson = normalizeTranslateRowIdsJson(
    next.pipelineType,
    next.options ? JSON.stringify(next.options) : null,
  );

  // Re-stamp when the next chain link is a generate job; otherwise inherit.
  let stamp: ResolvedPipelineStamp = EMPTY_RESOLVED;
  if (next.pipelineType === "generate") {
    stamp = await resolvePipelineSourceStamp(env, "generate", next.options ?? null);
  } else {
    const parent = await env.DB.prepare(
      `SELECT source_generation, source_owner, source_repo, source_ref, source_stamps_json
         FROM pipeline_jobs WHERE job_id = ?1`,
    )
      .bind(input.parentJobId)
      .first<PipelineSourceStamp & { source_stamps_json: string | null }>();
    if (parent) stamp = resolvedFromJobRow(parent);
  }

  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE pipeline_jobs SET follow_up_job_id = ?1
          WHERE job_id = ?2 AND follow_up_job_id IS NULL`,
      )
      .bind(childJobId, input.parentJobId),
    env.DB
      .prepare(
        `INSERT INTO pipeline_jobs (
           job_id, user_id, pipeline_type, book, start_chapter, end_chapter,
           session_key, state, priority, options_json, follow_up_chain,
           source_generation, source_owner, source_repo, source_ref, source_stamps_json,
           created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', 1, ?8, ?9,
                   ?10, ?11, ?12, ?13, ?14, unixepoch(), unixepoch())
         ON CONFLICT(job_id) DO NOTHING`,
      )
      .bind(
        childJobId,
        input.userId,
        next.pipelineType,
        input.book,
        input.startChapter,
        input.endChapter,
        childSessionKey,
        childOptionsJson,
        childChainJson,
        stamp.legacy.source_generation,
        stamp.legacy.source_owner,
        stamp.legacy.source_repo,
        stamp.legacy.source_ref,
        stamp.stampsJson,
      ),
  ]);
}

function countChainSuffixes(sessionKey: string): number {
  const m = sessionKey.match(/\/chain(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// GET /api/pipelines  — list current user's jobs from D1 (no upstream call).
// Reconciliation surface for the browser when a tab opens/reloads.
//
// Default behavior (no ?state= filter) returns:
//   - non-terminal jobs (queued, dispatching, running, paused_*, failed — the
//     failure case is listed even though terminal because the user might retry
//     it), AND
//   - terminal jobs that haven't been "notified" yet, so the browser can
//     fire a "while you were away" toast on first load after the server's
//     cron finished a job in the user's absence.
//
// Queued rows are annotated with their global queue position, and the response
// carries a `queue` summary (what's running, total queued) so the UI can show
// "what's ahead of you". An explicit ?state= filter overrides the default set.
pipelines.get("/", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  const stateFilter = c.req.query("state");
  const stateList = stateFilter
    ? stateFilter
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  let rs;
  const columns = `job_id, upstream_job_id, user_id, pipeline_type, book,
            start_chapter, end_chapter, session_key, state, priority,
            current_skill, current_status, error_kind, error_message,
            output_json, follow_up_job_id, created_at, updated_at,
            last_polled_at, notified_user_at`;

  if (stateList === null) {
    // Default: the live queue is visible to everyone (active + waiting jobs,
    // regardless of owner) so the whole team can see what's running and lined
    // up. Terminal jobs (done/failed/cancelled) stay owner-scoped — a finished
    // run only shows for the person who requested it, which also drives the
    // "completed while you were away" toast via the unnotified-terminal clause.
    // Capped 100. Columns are table-qualified (j.) because of the users JOIN.
    const jCols = columns
      .split(",")
      .map((s) => `j.${s.trim()}`)
      .join(", ");
    const nonTerminal = Array.from(NON_TERMINAL_STATES);
    const ntPlace = nonTerminal.map((_, i) => `?${i + 2}`).join(",");
    // Active + queued: the shared, everyone-can-see set.
    const queueVisible = ["queued", ...ACTIVE_STATES];
    const qvPlace = queueVisible
      .map((_, i) => `?${i + 2 + nonTerminal.length}`)
      .join(",");
    rs = await c.env.DB.prepare(
      `SELECT ${jCols}, u.dcs_username AS started_by_username
         FROM pipeline_jobs j
         LEFT JOIN users u ON u.id = j.user_id
        WHERE (j.user_id = ?1
                 AND (j.state IN (${ntPlace}) OR j.notified_user_at IS NULL))
           OR j.state IN (${qvPlace})
        ORDER BY j.updated_at DESC
        LIMIT 100`,
    )
      .bind(userId, ...nonTerminal, ...queueVisible)
      .all<PipelineRowSelect>();
  } else if (stateList.length === 0) {
    return c.json({ jobs: [], queue: { activeJob: null, queuedCount: 0 } });
  } else {
    const placeholders = stateList.map((_, i) => `?${i + 2}`).join(",");
    rs = await c.env.DB.prepare(
      `SELECT ${columns}
         FROM pipeline_jobs
        WHERE user_id = ?1 AND state IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 100`,
    )
      .bind(userId, ...stateList)
      .all<PipelineRowSelect>();
  }

  const snap = await queueSnapshot(c.env);
  const jobs = (rs.results ?? []).map((row) => {
    // Another user's row rides the shared-queue clause. Strip the internal
    // fields the UI never renders for a foreign job (session key, the bot's
    // upstream id, produced output, error detail) so the shared queue only
    // discloses display metadata — book/chapter/type/state/who — not the
    // operational innards of someone else's run.
    const sanitized =
      row.user_id !== userId
        ? {
            ...row,
            session_key: "",
            upstream_job_id: null,
            output_json: null,
            error_kind: null,
            error_message: null,
          }
        : row;
    if (sanitized.state === "queued") {
      const pos = snap.positions.get(sanitized.job_id);
      return { ...sanitized, queue_position: pos?.position ?? null, queue_ahead: pos?.ahead ?? null };
    }
    return sanitized;
  });

  return c.json({
    jobs,
    queue: { activeJob: snap.activeJob, queuedCount: snap.queuedCount },
  });
});

interface PipelineRowSelect {
  job_id: string;
  upstream_job_id: string | null;
  user_id: number;
  pipeline_type: PipelineType;
  book: string;
  start_chapter: number;
  end_chapter: number;
  session_key: string;
  state: string;
  priority: number;
  current_skill: string | null;
  current_status: string | null;
  error_kind: string | null;
  error_message: string | null;
  output_json: string | null;
  follow_up_job_id: string | null;
  created_at: number;
  updated_at: number;
  last_polled_at: number | null;
  notified_user_at: number | null;
  // Present only on the default (shared-queue) list where we JOIN users, so the
  // UI can attribute another user's run. Absent on the explicit-state branch.
  started_by_username?: string | null;
}

// POST /api/pipelines/:jobId/cancel  — withdraw a job that hasn't reached the
// front of the line yet. Only 'queued' jobs are cancellable (they never
// touched the bot); a job that's already 'dispatching'/'running' or terminal
// returns 409. Sets notified_user_at so the cancelled row doesn't resurface as
// a "while you were away" item on the next reload.
pipelines.post("/:jobId/cancel", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const owned = await c.env.DB.prepare(
    `SELECT user_id, state FROM pipeline_jobs WHERE job_id = ?1`,
  )
    .bind(jobId)
    .first<{ user_id: number; state: string }>();
  if (!owned) return c.json({ error: "not_found" }, 404);
  if (owned.user_id !== userId) return c.json({ error: "forbidden" }, 403);
  if (owned.state !== "queued") {
    return c.json({ error: "cannot_cancel", state: owned.state }, 409);
  }

  // Guard on state='queued' again in the UPDATE so a concurrent dispatch that
  // just claimed this row (queued -> dispatching) can't be cancelled out from
  // under the bot.
  const res = await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET state = 'cancelled', notified_user_at = unixepoch(), updated_at = unixepoch()
      WHERE job_id = ?1 AND state = 'queued'`,
  )
    .bind(jobId)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    const now = await c.env.DB.prepare(
      `SELECT state FROM pipeline_jobs WHERE job_id = ?1`,
    )
      .bind(jobId)
      .first<{ state: string }>();
    return c.json({ error: "cannot_cancel", state: now?.state ?? "unknown" }, 409);
  }
  return c.json({ ok: true, jobId, state: "cancelled" });
});

// POST /api/pipelines/:jobId/notified  — mark a terminal job as having
// surfaced a toast in the user's UI, so the next page load doesn't re-toast
// the same completion. Idempotent: setting notified_user_at on an already-
// notified job is a no-op (we only write where it's currently NULL).
pipelines.post("/:jobId/notified", requireEditor, async (c) => {
  const userId = currentUserId(c);
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const jobId = c.req.param("jobId");
  if (!jobId) return c.json({ error: "missing_job_id" }, 400);

  const res = await c.env.DB.prepare(
    `UPDATE pipeline_jobs
        SET notified_user_at = unixepoch()
      WHERE job_id = ?1
        AND user_id = ?2
        AND notified_user_at IS NULL`,
  )
    .bind(jobId, userId)
    .run();

  // res.meta.changes is 0 if the row didn't exist, didn't belong to this
  // user, or was already notified. None of these are errors — the client
  // doesn't care.
  return c.json({ ok: true, changed: res.meta?.changes ?? 0 });
});
