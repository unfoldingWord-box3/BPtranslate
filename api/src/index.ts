import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { chapters } from "./chapters";
import { rows } from "./rows";
import { verses } from "./verses";
import { catalogs } from "./catalogs";
import { twlSuggest } from "./twlSuggest";
import { twlFilters } from "./twlFilters";
import { noteTemplates } from "./noteTemplates";
import { lexicon } from "./lexicon";
import { align } from "./align";
import { exports as exportsRoutes } from "./exports";
import { tnQuick } from "./tnQuick";
import { pipelines, pollAllNonTerminal } from "./pipelines";
import { pendingImports } from "./pendingImports";
import { alerts } from "./alerts";
import { projectConfig } from "./projectConfigRoutes";
import { orgRoutes } from "./orgRoutes";
import { adminUsers } from "./adminUserRoutes";
import { articles } from "./articles";
import { translationMemory } from "./translationMemory";
import { aiProvider } from "./aiProvider";
import { l10n } from "./l10n";
import { books } from "./bookImport";
import { populateReferencedArticles } from "./articlePopulate";
import { templates } from "./templates";
import { syncTemplates } from "./templateSync";
import { attachAuth, requireAuth, requireCsrf, mintDevToken, startDcsAuth, callbackDcsAuth, authMe, authLogout, refreshToken, updateLastLocation, currentUserId } from "./auth";
import { workspaceRoutes } from "./workspaceRoutes";
import { blockViewerWrites } from "./viewerGuard";
import { listWorkspaces, resolveWorkspaceFresh, workspaceEnv, parseWorkspaceCookie, requireWorkspaceMatch, primeWorkspaces } from "./workspaces";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  CHAPTER_ROOM: DurableObjectNamespace;
  EXPORT_WORKFLOW: Workflow;
  // Static SPA bundle, served for any non-/api path on production (wrangler
  // builds this binding automatically when [assets] is configured). The
  // SPA's URL hash routes itself; ASSETS just serves index.html + bundle.
  ASSETS: Fetcher;
  DCS_BASE_URL: string;
  DCS_OAUTH_AUTHORIZE_URL: string;
  DCS_OAUTH_TOKEN_URL: string;
  JWT_ISSUER: string;
  JWT_TTL_SECONDS: string;
  ALLOWED_ORIGINS?: string;
  DEV_AUTH_ENABLED?: string;
  // "true" only on deployments that register the nightly export cron (prod).
  // Absent/other on the dev worker (crons = []) — the UI uses this to show the
  // 05:30 schedule vs. a manual-exports notice (#240).
  NIGHTLY_EXPORTS_ENABLED?: string;
  DCS_CLIENT_ID?: string;
  DCS_CLIENT_SECRET?: string;
  JWT_SIGNING_KEY?: string;
  DCS_SERVICE_TOKEN?: string;
  // Admin PAT (branch-delete capable) used ONLY to recover a drifted export
  // branch whose PR has conflicted (delete + recreate off current master; the
  // service token 403s on branch-delete). Set via `wrangler secret put
  // DCS_TOKEN`. Absent → the conflict recovery is inert and the PR just gets a
  // banner alert (no behavior change). See docs/export-rebase-fix.md.
  DCS_TOKEN?: string;
  // Owner of the repos nightly exports land on. The branch is no longer
  // configurable — exports go to a per-(book,resource) branch named for the
  // book + its human contributors (see export.ts:buildExportBranch).
  // Defaults to the unfoldingWord canonical owner; override per env.
  DCS_EXPORT_OWNER?: string;
  // DCS org whose members get read-only ("viewer") access when not on the
  // editor allowlist. Defaults to "unfoldingWord" when unset.
  VIEWER_ORG?: string;
  // Door43 team names, inside the configured project org, whose members are
  // granted admin / editor at sign-in (api/src/dcsTeams.ts). Default to
  // "BE-Admins" / "BE-Editors" when unset.
  DCS_TEAM_ADMIN?: string;
  DCS_TEAM_EDITOR?: string;
  // Shared service token for the uw-bt-bot AI endpoint. Set via
  // `wrangler secret put BT_API_TOKEN`. Absence disables /api/tn-quick.
  BT_API_TOKEN?: string;
  // Base64 of exactly 32 random bytes, wrapping the per-org AI provider API
  // keys held in ai_provider_config (migration 0065; api/src/aiKeyCrypto.ts).
  // Set via `wrangler secret put AI_KEY_WRAPPING_KEY`. Absence means an org
  // can't store its own key (503 on write, encryptionAvailable:false on read);
  // the shared BT_API_TOKEN path is unaffected. Rotating it orphans every
  // stored key — see aiKeyCrypto.ts.
  AI_KEY_WRAPPING_KEY?: string;
  // Override the bot URL (defaults to https://uw-bt-bot.fly.dev/api/tn-quick
  // when unset). Useful for staging / local bot dev.
  TN_QUICK_URL?: string;
  // Override the bot URL for single-unit note-template drafting (defaults to
  // https://uw-bt-bot.fly.dev/api/template-quick when unset). See
  // api/src/templates.ts POST /unit/draft.
  TEMPLATE_QUICK_URL?: string;
  // Base URL for the bp-assistant pipeline API (POST /api/pipeline/start,
  // GET /api/pipeline/:jobId). Defaults to the prod bot at uw-bt-bot.fly.dev
  // when unset.
  PIPELINE_API_BASE?: string;
  // ── Workspaces (org-per-D1) ────────────────────────────────────────────
  // JSON array of {slug,label,org,binding,exportOwner?} — see workspaces.ts.
  // Unset/empty/malformed means "one implicit workspace on the DB binding
  // above", so every existing deployment is unaffected until this is set.
  WORKSPACES?: string;
  // Second binding to the SAME database as DB — holds org-independent state
  // (accounts, sessions, lexicon, alignment frequencies, UI-string overrides)
  // so switching workspaces doesn't log a user out or blank their lexicon.
  // Falls back to DB when unset (single-workspace deployments).
  SHARED_DB?: D1Database;
  // Set per-request by the fetch() wrapper below to the resolved workspace's
  // slug ("default" when WORKSPACES is unset) — never configured directly.
  WORKSPACE_SLUG?: string;
  // The original, never-swapped env, stamped by workspaceEnv(). Bindings must
  // always be looked up here so resolving a second workspace from an already-
  // swapped env can't hand back the currently-active database.
  BASE_ENV?: Env;
  // Comma-separated DCS usernames (case-insensitive) who may switch to any
  // workspace regardless of DCS org membership.
  SUPER_ADMINS?: string;
  // "true" enables auto-claiming a spare pool slot for an un-onboarded org at
  // its first admin login (workspaceAutoClaim.ts). OFF by default and on
  // purpose: Door43 is a public Gitea, so anyone can create an org, create a
  // BE-Admins team, and sign in — with this on, that self-serves a real
  // workspace out of the operator-provisioned pool. Turn it on only where that
  // is the intent and the pool is expendable.
  WORKSPACE_AUTOCLAIM?: string;
  // Placeholder for an additional org's D1 binding — declared here AND in
  // wrangler.toml when a new workspace is provisioned (see the WORKSPACES
  // comment in wrangler.toml for the full add-an-org steps). The workspace
  // lookup itself is by string via `(env as any)[binding]`, so new bindings
  // don't need new fields here to be *usable* — this one is just so
  // wrangler-generated types have somewhere to declare a real example.
  DB_MLTEST?: D1Database;
  // Spare-pool slot binding (issue #81): a pre-provisioned, migrated, empty D1
  // declared in wrangler.toml and registered as an `available` workspace-
  // registry row, then claimed for an org at onboard. Like DB_MLTEST this is an
  // example declaration — the pool lookup resolves bindings by string, so
  // additional DB_POOL<n> slots are usable without their own field here.
  DB_POOL1?: D1Database;
}

// Cron patterns must match the [env.production.triggers] crons list in
// wrangler.toml (the default env registers no crons — see the note there).
// There's no runtime way to assert they line up (wrangler doesn't expose
// triggers to the Worker), but constants in code give grep something to find
// when the schedule changes.
const EXPORT_CRON = "30 5 * * *";
const POLL_CRON = "*/5 * * * *";
// Dormant: not yet registered in wrangler.toml [env.production.triggers].
// Branch below is unreachable until the cron entry is added there.
// Scheduled for 08:00 UTC — 2 hours after EXPORT_CRON so DCS-side merge of
// our nightly snapshot has time to land before we pull master back.
const REIMPORT_CRON = "0 8 * * *";

const app = new Hono<{ Bindings: Env; Variables: { userId?: number; username?: string } }>();

// CORS — strict allowlist sourced from the ALLOWED_ORIGINS env var (comma
// separated). The previous origin echo + credentials:true combination was a
// CSRF gift: any third-party page could call /api/* on behalf of a logged-in
// user. Now an Origin must match an entry verbatim; misses get no
// Access-Control-Allow-Origin header and the browser blocks the call. The
// dev default covers Vite (5173) and wrangler (8787) on localhost.
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

app.use("*", (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = allowed.length > 0 ? allowed : DEFAULT_DEV_ORIGINS;
  return cors({
    origin: (origin) => (origin && list.includes(origin) ? origin : null),
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "If-Match", "X-CSRF-Token", "X-Source-Generation", "X-Workspace"],
    exposeHeaders: ["ETag"],
  })(c, next);
});

app.use("*", attachAuth);
app.use("*", requireWorkspaceMatch);
app.use("*", requireCsrf);
// Viewer read-only backstop: 403 any authenticated non-editor/non-admin
// mutation under /api outside the exact self-scoped allowlist (auth/session,
// own location, workspace switch, own alert dismiss — see viewerGuard.ts).
// Scoped to /api so non-API paths keep the normal SPA/asset fallthrough.
// Per-route requireEditor/requireAdmin guards remain the primary gate — this
// catches future write routes added without one.
app.use("/api/*", blockViewerWrites);

// Defense-in-depth response headers. CSP locks the SPA to its own bundle
// (no third-party scripts/styles aside from inline styles emotion/MUI need).
// frame-src allow-lists the swunrow search tool embedded in the Resources
// column's Search tab AND in the Flexible layout's Search panel (both render
// SEARCH_IFRAME_URL from web/src/components/SearchPanel.tsx) — without it,
// frame-src falls back to default-src 'self'
// and the iframe is blocked in prod (but not local Vite, which skips these
// headers). connect-src allow-lists git.door43.org for the same reason: the TW
// article viewer fetches raw markdown directly from Door43 (see twArticle.ts).
// Referrer-Policy keeps querystrings out of cross-origin Referer
// headers. X-Content-Type-Options stops the browser from sniffing a response
// into a different MIME than what we send. Applied to every response.
app.use("*", async (c, next) => {
  await next();
  // connect-src pins WebSockets to this deployment's own host instead of the
  // bare wss:/ws: schemes (any host — which would have handed an XSS a free
  // exfiltration channel). The explicit wss://host + ws://host entries cover
  // browsers that don't extend 'self' to WebSocket upgrades; the only WS the
  // SPA opens is same-host (wsClient.ts builds it from location.host).
  const host = new URL(c.req.url).host;
  c.res.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' wss://${host} ws://${host} https://git.door43.org; frame-src 'self' https://swunrow.pythonanywhere.com`,
  );
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

// Global error handler. Without it, an unexpected throw in any handler returns
// Hono's default plain-text 500 — inconsistent with this API's JSON error
// shape and leaking the stack in some runtimes. HTTPException instances carry
// their own intended response, so honor those; everything else becomes a
// generic JSON 500 (details go to the log, not the client).
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(
    "unhandled error",
    c.req.method,
    c.req.path,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  return c.json({ error: "internal_error" }, 500);
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "bible-editor-api",
    time: new Date().toISOString(),
  }),
);

app.route("/api/books", books);

app.get("/api/auth/dcs/start", startDcsAuth);
app.get("/api/auth/dcs/callback", callbackDcsAuth);
app.get("/api/auth/me", authMe);
app.post("/api/auth/refresh", refreshToken);
// Logout intentionally NOT gated by requireAuth — we want it to clear cookies
// even if the Access cookie is missing/expired (the Refresh cookie is what
// gets us to the session row for revocation).
app.post("/api/auth/logout", authLogout);
app.put("/api/users/me/location", requireAuth, updateLastLocation);

// Dev-only: mint a JWT against a known/created users.id. Gated by
// DEV_AUTH_ENABLED so it can't be left on in prod, AND restricted to
// localhost so a plain `wrangler deploy` (which lands on the public
// `bible-editor-api-dev` *.workers.dev worker with DEV_AUTH_ENABLED=true)
// can't be used by anyone on the internet to mint an admin token. Local
// `wrangler dev` serves on 127.0.0.1/localhost and is unaffected.
app.post("/api/auth/dev", async (c) => {
  if (c.env.DEV_AUTH_ENABLED !== "true") {
    return c.json({ error: "disabled" }, 404);
  }
  const host = new URL(c.req.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    return c.json({ error: "disabled" }, 404);
  }
  let body: { username?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    /* allow empty body */
  }
  const username = (body.username ?? "").trim() || "dev";
  return mintDevToken(c, username);
});

app.route("/api/chapters", chapters);
app.route("/api/rows", rows);
app.route("/api/verses", verses);
app.route("/api/catalogs", catalogs);
app.route("/api/twl-suggestions", twlSuggest);
app.route("/api/twl-filters", twlFilters);
app.route("/api/note-templates", noteTemplates);
app.route("/api/lexicon", lexicon);
app.route("/api/align", align);
app.route("/api/exports", exportsRoutes);
app.route("/api/tn-quick", tnQuick);
app.route("/api/pipelines", pipelines);
app.route("/api/pending-imports", pendingImports);
app.route("/api/alerts", alerts);
app.route("/api/project-config", projectConfig);
app.route("/api/orgs", orgRoutes);
app.route("/api/workspaces", workspaceRoutes);
app.route("/api/admin/users", adminUsers);
app.route("/api/articles", articles);
app.route("/api/templates", templates);
app.route("/api/translation-memory", translationMemory);
app.route("/api/ai-provider", aiProvider);
app.route("/api/l10n", l10n);

// WebSocket upgrade into the ChapterRoom DO. WS handshakes are normal HTTP
// upgrades, so they carry the be_access cookie (same-origin) and attachAuth
// has already stamped userId on the context — that cookie is the only auth
// path (wsClient.ts opens the socket with no subprotocol). The earlier
// bearer.<jwt> subprotocol fallback has been removed alongside the HTTP Bearer
// fallback. Forward the raw request to the DO; it echoes any subprotocol back
// so the handshake completes.
app.get("/api/ws/chapter/:book/:chapter", async (c) => {
  if (c.req.header("upgrade") !== "websocket") {
    return c.text("expected websocket", 426);
  }
  if (currentUserId(c) === null) return c.text("unauthorized", 401);

  const book = c.req.param("book").toUpperCase();
  const chapter = parseInt(c.req.param("chapter"), 10);
  if (!Number.isFinite(chapter)) return c.text("invalid chapter", 400);

  // Workspace-scoped DO name so orgs don't share a ChapterRoom. ChapterRoom
  // holds only ephemeral presence/fanout state (no durable data), so folding
  // the slug into the name here (which changes "GEN:1" -> "default:GEN:1"
  // when WORKSPACES is unset) is safe — no data to migrate, worst case is a
  // dropped in-flight WS connection on first deploy.
  const id = c.env.CHAPTER_ROOM.idFromName(`${c.env.WORKSPACE_SLUG ?? "default"}:${book}:${chapter}`);
  return c.env.CHAPTER_ROOM.get(id).fetch(c.req.raw);
});

// /api/* misses get the JSON 404. Anything else falls through to the static
// SPA bundle (when the [assets] binding is configured for production deploy).
// In local dev the ASSETS binding may be undefined; we still return a clean
// 404 in that case so the dev experience matches.
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "not_found", path: c.req.path }, 404);
  }
  const assets = c.env.ASSETS as Fetcher | undefined;
  if (assets) return assets.fetch(c.req.raw);
  return c.json({ error: "not_found", path: c.req.path }, 404);
});

// Runs the existing per-cron body once, against a single (already
// workspace-resolved) env. Split out of the exported `scheduled()` so that
// handler can loop it once per workspace — see the loop below for why.
async function runScheduledTick(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // Two crons share this handler — wrangler.toml has the full list. The
    // 05:30 one kicks the nightly DCS-export Workflow; the 5-min one polls
    // every non-terminal pipeline_job so the auto-apply step lands even
    // when no translator has a tab open. Branching on controller.cron
    // keeps the work cheaply separated.
    if (controller.cron === EXPORT_CRON) {
      // Finalize trashed notes before exporting. Trash (trashed_at) is a
      // visible, restorable safety net; the nightly tick promotes it to a
      // permanent deleted_at tombstone — which is hidden from reads, excluded
      // from the export below, and skipped by the daily reimport so it can't
      // resurrect. Keep the original deletion time (deleted_at = trashed_at).
      // Audit first (reads pre-update state), then promote. A finalize failure
      // must not cancel the night's export — buildResource's `trashed_at IS
      // NULL` filter tolerates unfinalized trash, and the next tick retries.
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO edit_log (kind, row_key, book, user_id, prev_version, new_version, action, source)
             SELECT 'tn', id, book, NULL, version, version, 'delete', 'nightly_finalize'
               FROM tn_rows WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
          ),
          env.DB.prepare(
            `UPDATE tn_rows SET deleted_at = trashed_at, trashed_at = NULL
              WHERE trashed_at IS NOT NULL AND deleted_at IS NULL`,
          ),
        ]);
      } catch (e) {
        console.error("nightly trash finalize failed", e instanceof Error ? e.message : String(e));
      }
      // Auto-clean resolved pipeline jobs so failed/done runs don't pile up in
      // the AI-pipelines chip forever (the UI has a manual "mark as seen", this
      // is the safety net for runs nobody dismissed). Failed/cancelled get a
      // day's grace then clear; done keep a week of history. A failure here
      // must not cancel the export — wrap and log.
      //
      // pending_imports.job_id REFERENCES pipeline_jobs(job_id) with no
      // cascade, and a done (or staged-then-failed) job keeps its pending_imports
      // rows as the apply/audit ledger — so the parent can't be deleted while
      // children exist. Drop the children first, in the same batch (D1 runs
      // batch statements sequentially in one transaction), then the jobs.
      const failedCancelledCutoff = `state IN ('failed', 'cancelled') AND updated_at < unixepoch() - 86400`;
      const doneCutoff = `state = 'done' AND updated_at < unixepoch() - (7 * 86400)`;
      try {
        await env.DB.batch([
          env.DB.prepare(
            `DELETE FROM pending_imports
              WHERE job_id IN (SELECT job_id FROM pipeline_jobs WHERE ${failedCancelledCutoff})`,
          ),
          env.DB.prepare(
            `DELETE FROM pending_imports
              WHERE job_id IN (SELECT job_id FROM pipeline_jobs WHERE ${doneCutoff})`,
          ),
          env.DB.prepare(`DELETE FROM pipeline_jobs WHERE ${failedCancelledCutoff}`),
          env.DB.prepare(`DELETE FROM pipeline_jobs WHERE ${doneCutoff}`),
        ]);
      } catch (e) {
        console.error("nightly pipeline_jobs cleanup failed", e instanceof Error ? e.message : String(e));
      }
      // Scheduled run opts into validate-and-merge — the whole point of the
      // 05:30 UTC tick is to land the snapshot on DCS and let the validator
      // merge it. Manual /api/exports/run leaves validateAndMerge unset so
      // tests don't accidentally trigger the auto-merge.
      //
      // Deterministic per-day-per-workspace instance id: a double-fire of the
      // cron (or a retried scheduled event) rejects on the duplicate id
      // instead of running two overlapping nightly exports for the same org;
      // the workspace slug keeps two orgs' same-day runs from colliding.
      const day = new Date(controller.scheduledTime).toISOString().slice(0, 10);
      const wsSlug = env.WORKSPACE_SLUG ?? "default";
      try {
        await env.EXPORT_WORKFLOW.create({
          id: `nightly-${wsSlug}-${day}`,
          params: { validateAndMerge: true, workspace: env.WORKSPACE_SLUG },
        });
      } catch (e) {
        console.log("nightly export already created for", day, e instanceof Error ? e.message : String(e));
      }
      return;
    }
    if (controller.cron === POLL_CRON) {
      await pollAllNonTerminal(env);
      // Article-population backstop: auto-import schedules population via
      // waitUntil, but a crashed isolate or a book imported before this feature
      // shipped can leave referenced tW/tA articles unpopulated. Drain one
      // bounded chunk per tick — a cheap no-op once everything is populated.
      // ISOLATED from pipeline polling: neither cron subsystem may starve or
      // abort the other, so this gets its own try/catch.
      try {
        await populateReferencedArticles(env, { maxFetches: 200 });
      } catch (e) {
        console.error("cron populateReferencedArticles failed", e instanceof Error ? e.message : String(e));
      }
      // Note-template sync backstop: refresh template_units from the Google
      // Sheet at most every 6 hours. Isolated from both the pipeline poll and
      // article population above — a sync failure (sheet down, etc.) must not
      // break either.
      try {
        const state = await env.DB.prepare(
          `SELECT last_synced_at FROM template_sync_state WHERE id = 1`,
        ).first<{ last_synced_at: number | null }>();
        const staleSeconds = 6 * 60 * 60;
        if (state?.last_synced_at == null || Math.floor(Date.now() / 1000) - state.last_synced_at > staleSeconds) {
          await syncTemplates(env);
        }
      } catch (e) {
        console.error("cron syncTemplates failed", e instanceof Error ? e.message : String(e));
      }
      // Stale-lock sweep for book_import_locks. Imports take 5-60s in
      // practice; anything past 10 minutes is a Worker that died mid-import
      // (OOM, isolate eviction) and left the row behind. The next POST for
      // that book would otherwise see the dangling lock and 409 forever.
      await env.DB.prepare(
        `DELETE FROM book_import_locks WHERE started_at < unixepoch() - 600`,
      ).run();
      // Once-per-hour edit_log retention sweep. 180 days is defensive — we
      // don't have a real policy yet, but the table grows without bound
      // otherwise (every keystroke that lands a PATCH writes a row). Gated
      // on minute-of-hour so it fires ~once/hour instead of every 5 min.
      const minuteOfHour = Math.floor(Date.now() / 60_000) % 60;
      if (minuteOfHour < 5) {
        await env.DB.prepare(
          `DELETE FROM edit_log WHERE created_at < unixepoch() - (180 * 86400)`,
        ).run();
      }
      return;
    }
    if (controller.cron === REIMPORT_CRON) {
      // Dormant until wrangler.toml lists "0 8 * * *". Self-heal: pull fresh DCS
      // content into D1 for every imported book. Dispatched as the export
      // Workflow in reimportOnly mode — scheduled() has no WorkflowStep context,
      // and the Workflow path chunks by chapter (so a large book can't blow the
      // 10-min step limit) and SHA-skips unchanged files. See exportWorkflow.ts.
      await env.EXPORT_WORKFLOW.create({ params: { reimportOnly: true, workspace: env.WORKSPACE_SLUG } });
      return;
    }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // The only place the workspace swap happens: resolve which org this
    // request belongs to (be_ws cookie, else the first/default workspace),
    // then hand the Hono app a clone of env with DB/VIEWER_ORG/etc. pointed
    // at that workspace. Every route file still just reads c.env.DB.
    //
    // primeWorkspaces() loads the roster from the shared-DB registry table once
    // per isolate (fails soft to the WORKSPACES env var, then the implicit
    // default) so the resolve below reads it. It's a no-op after the first
    // request in this isolate.
    //
    // resolveWorkspaceFresh, not resolveWorkspace: a per-isolate roster loaded
    // once and never expired can't see a workspace another isolate claimed, and
    // an unknown slug otherwise resolves to list[0] — another tenant's D1, with
    // the caller's already-minted admin role. It rechecks the registry (rate
    // limited) only when the cookie names a workspace this isolate lacks.
    await primeWorkspaces(env);
    const ws = await resolveWorkspaceFresh(env, parseWorkspaceCookie(request));
    return app.fetch(request, workspaceEnv(env, ws), ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Run the nightly export / job-poll body once per workspace. One org's
    // failure (a bad D1 binding, an export error) must not skip the others,
    // so each iteration gets its own try/catch and logs rather than throws.
    // With WORKSPACES unset this is exactly one iteration against DB, same
    // as before workspaces existed.
    await primeWorkspaces(env);
    for (const ws of listWorkspaces(env)) {
      try {
        await runScheduledTick(controller, workspaceEnv(env, ws), ctx);
      } catch (e) {
        console.error("scheduled tick failed for workspace", {
          slug: ws.slug,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  },
} satisfies ExportedHandler<Env>;

export { ChapterRoom } from "./chapterRoom";
export { ExportWorkflow } from "./exportWorkflow";
