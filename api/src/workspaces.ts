// Workspace resolution — the org-per-D1 layer that lets one deployed Worker
// serve multiple Door43 orgs, each backed by its own D1 database, while a
// signed-in user switches which one their requests talk to via a cookie.
//
// Overriding constraint: when WORKSPACES is unset/empty/malformed, behavior
// must be byte-for-byte identical to today — a single implicit "default"
// workspace pointed at the existing DB binding. Every function here degrades
// to that shape rather than throwing, so a bad env var can never 500 the API.
//
// The actual DB swap happens in ONE place: index.ts's `fetch` wrapper calls
// workspaceEnv() before handing the request to the Hono app. Every route file
// still just reads `c.env.DB` — it has no idea a swap happened.

import type { MiddlewareHandler } from "hono";
import type { Env } from "./index";
import { isIdent } from "./repoUrl.ts";

export interface Workspace {
  slug: string; // url/cookie-safe id
  label: string; // human label for the switcher
  org: string; // Door43 org name — also the viewer-membership org
  binding: string; // name of the D1 binding on Env holding this org's content
  exportOwner?: string; // optional per-workspace DCS_EXPORT_OWNER override
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function implicitWorkspace(env: Env): Workspace {
  const org = (env.VIEWER_ORG ?? "unfoldingWord").trim() || "unfoldingWord";
  return { slug: "default", label: org, org, binding: "DB" };
}

// Validates one raw WORKSPACES entry, logging (not throwing) on rejection —
// a malformed entry must never 500 the whole API, it just doesn't get a
// workspace.
function parseEntry(env: Env, entry: unknown): Workspace | null {
  if (!entry || typeof entry !== "object") {
    console.warn("workspaces: dropping non-object entry", entry);
    return null;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.slug !== "string" || !SLUG_RE.test(e.slug)) {
    console.warn("workspaces: dropping entry with invalid slug", e.slug);
    return null;
  }
  if (typeof e.org !== "string" || !isIdent(e.org)) {
    console.warn("workspaces: dropping entry with invalid org", e.slug, e.org);
    return null;
  }
  if (typeof e.label !== "string" || e.label.length === 0 || e.label.length > 64) {
    console.warn("workspaces: dropping entry with invalid label", e.slug);
    return null;
  }
  if (typeof e.binding !== "string") {
    console.warn("workspaces: dropping entry with invalid binding", e.slug);
    return null;
  }
  const bound = (env as unknown as Record<string, unknown>)[e.binding] as
    | { prepare?: unknown }
    | undefined;
  if (typeof bound?.prepare !== "function") {
    console.warn("workspaces: dropping entry whose binding isn't a D1Database", e.slug, e.binding);
    return null;
  }
  if (e.exportOwner !== undefined && typeof e.exportOwner !== "string") {
    console.warn("workspaces: dropping entry with invalid exportOwner", e.slug);
    return null;
  }
  const ws: Workspace = { slug: e.slug, label: e.label, org: e.org, binding: e.binding };
  if (typeof e.exportOwner === "string") ws.exportOwner = e.exportOwner;
  return ws;
}

// Parses ONLY the entries the WORKSPACES env var yields — no implicit-default
// fallback. Returns [] when the var is unset/empty/malformed or every entry is
// invalid. This is the seed set copied into the registry table on first boot,
// so it must NOT include the synthetic implicit default (that stays dynamic —
// see parseWorkspacesFromEnv).
function parseEnvEntries(env: Env): Workspace[] {
  const result: Workspace[] = [];
  const raw = (env.WORKSPACES ?? "").trim();
  if (!raw) return result;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const seen = new Set<string>();
      for (const entry of parsed) {
        const ws = parseEntry(env, entry);
        if (!ws) continue;
        if (seen.has(ws.slug)) {
          console.warn("workspaces: dropping duplicate slug", ws.slug);
          continue;
        }
        seen.add(ws.slug);
        result.push(ws);
      }
    } else {
      console.warn("workspaces: WORKSPACES var is not a JSON array");
    }
  } catch (e) {
    console.warn("workspaces: failed to parse WORKSPACES var", e instanceof Error ? e.message : String(e));
  }
  return result;
}

// Memoized per `env` object — this runs on every request, and re-parsing the
// same JSON string per-request would be wasteful.
const cache = new WeakMap<object, Workspace[]>();

// The env-var-and-implicit-default roster, exactly as before the registry
// existed. This is the FALLBACK the synchronous list/resolve functions return
// whenever the registry hasn't been (or couldn't be) primed for this isolate,
// which is what keeps the WORKSPACES-unset path byte-for-byte identical to
// today (a single dynamic implicit default that still honors VIEWER_ORG).
function parseWorkspacesFromEnv(env: Env): Workspace[] {
  const cached = cache.get(env as object);
  if (cached) return cached;

  let result = parseEnvEntries(env);
  if (result.length === 0) result = [implicitWorkspace(env)];

  cache.set(env as object, result);
  return result;
}

// ── Registry (shared-DB table) ───────────────────────────────────────────────
//
// The roster's source of truth is the `workspaces` table on the SHARED DB
// (migration 0058). It is loaded ONCE per isolate by primeWorkspaces() — an
// async step the fetch/scheduled/Workflow entry points await before calling the
// synchronous list/resolve functions below. The load result is memoized per
// shared-DB binding (stable for an isolate's lifetime) so subsequent requests
// pay nothing.
//
// HARD INVARIANT (unchanged from the env-var era): a bad/missing/empty registry
// read must NEVER throw or 500. It fails soft to the WORKSPACES env var and then
// the implicit default. That ordering — registry → env var → default — is why
// primeWorkspaces swallows every error and why the sync functions fall through
// to parseWorkspacesFromEnv whenever the registry yielded nothing.

interface RegistryLoad {
  // Non-null only when the registry produced ≥1 valid `claimed` workspace.
  // null means "primed, but the registry was empty/unavailable" → use the
  // env-var fallback (recomputed fresh so VIEWER_ORG stays dynamic).
  workspaces: Workspace[] | null;
}

// Keyed on the shared-DB binding object, which is stable across requests within
// one isolate — so the D1 read happens at most once per isolate, not per env
// clone (workspaceEnv() hands out a fresh env object per request).
const registryState = new WeakMap<object, RegistryLoad>();

// Shape of a row from the `workspaces` table (claimed rows only; see readRegistry).
interface WorkspaceRow {
  slug: string;
  label: string | null;
  org: string | null;
  binding: string;
  exportOwner: string | null;
}

async function readRegistry(db: D1Database): Promise<WorkspaceRow[]> {
  const res = await db
    .prepare(
      `SELECT slug, label, org, binding, export_owner AS exportOwner
         FROM workspaces
        WHERE status = 'claimed'
        ORDER BY id`,
    )
    .all<WorkspaceRow>();
  return res.results ?? [];
}

// Best-effort copy of the env-var roster into an empty registry, as `claimed`
// rows. INSERT OR IGNORE so a race between two cold isolates (or the UNIQUE
// slug/org constraints) can't throw. Failure here is non-fatal: the caller
// still uses `entries` for this isolate, and the next boot retries the seed.
async function seedRegistry(db: D1Database, entries: Workspace[]): Promise<void> {
  const stmts = entries.map((w) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO workspaces (slug, label, org, binding, export_owner, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'claimed')`,
      )
      .bind(w.slug, w.label, w.org, w.binding, w.exportOwner ?? null),
  );
  if (stmts.length) await db.batch(stmts);
}

// Loads the registry into the per-isolate cache. Idempotent (once per shared-DB
// binding), async, and NEVER throws — any failure leaves the cache marking the
// fallback path. Awaited by the entry points (index.ts fetch/scheduled,
// exportWorkflow) before any synchronous resolveWorkspace/listWorkspaces call.
export async function primeWorkspaces(env: Env, opts?: { force?: boolean }): Promise<void> {
  const db = sharedDb(env);
  if (!db) return;
  // `force` (used by invalidateAndReprime) re-reads even when the cache is warm.
  // The fresh roster is only stored at the END of this function, overwriting the
  // previous value in place, so a forced reprime never leaves registryState
  // absent mid-flight — a concurrent reader sees the OLD roster until the NEW one
  // is ready, never the synthetic implicit default.
  if (!opts?.force && registryState.has(db as object)) return;

  let workspaces: Workspace[] | null = null;
  try {
    const rows = await readRegistry(db);
    if (rows.length > 0) {
      // D1 returns NULLs; parseEntry wants missing optionals as `undefined`
      // (a null exportOwner would otherwise be rejected as the wrong type).
      const parsed: Workspace[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const ws = parseEntry(env, {
          slug: r.slug,
          label: r.label,
          org: r.org,
          binding: r.binding,
          exportOwner: r.exportOwner ?? undefined,
        });
        if (!ws || seen.has(ws.slug)) continue;
        seen.add(ws.slug);
        parsed.push(ws);
      }
      workspaces = parsed.length > 0 ? parsed : null;
    } else {
      // Empty registry: seed it from the WORKSPACES env var (never the implicit
      // default — that must stay dynamic). Nothing to seed → stay on fallback.
      const seed = parseEnvEntries(env);
      if (seed.length > 0) {
        await seedRegistry(db, seed);
        workspaces = seed;
      }
    }
  } catch (e) {
    console.warn(
      "workspaces: registry prime failed, falling back to WORKSPACES env var",
      e instanceof Error ? e.message : String(e),
    );
    workspaces = null;
  }
  registryState.set(db as object, { workspaces });
}

// The EXPLICITLY configured roster: registry rows when the registry has been
// primed and holds any, else the WORKSPACES env entries — and an empty array
// when neither exists, i.e. when listWorkspaces is serving the synthetic
// implicit default.
//
// That distinction is load-bearing for anything that WRITES a workspace row.
// The implicit default is not a registry row: it materializes only while the
// registry yields nothing, so the first row ever written to an empty registry
// REPLACES it as the whole roster — the deployment's live database silently
// stops being a workspace. Callers that could create a row must refuse while
// this is empty (see workspaceAutoClaim.ts); an operator seeds WORKSPACES with
// the existing workspace first, which primeWorkspaces persists as a claimed row.
export function explicitWorkspaces(env: Env): Workspace[] {
  const db = sharedDb(env);
  const state = db ? registryState.get(db as object) : undefined;
  if (state?.workspaces && state.workspaces.length > 0) return state.workspaces;
  return parseEnvEntries(env);
}

// The org of the workspace this env is scoped to, but ONLY when the roster is
// EXPLICITLY configured — registry rows, or a non-empty WORKSPACES var. Returns
// null for the synthetic implicit default, whose org is VIEWER_ORG: in a
// single-org deployment that is a separate viewer-access setting and need not
// equal the project's own org, so callers must fall back to project_config
// there rather than trusting it (see orgForTeamSync in dcsTeams.ts).
//
// Exists because the WORKSPACES env var stopped being the roster's source of
// truth when it moved into the registry table (PR-1 of #81): a workspace
// claimed from the spare pool exists only as a registry row, so a caller gated
// on the env var sees no org for it — production runs WORKSPACES = "".
export function activeWorkspaceOrg(env: Env): string | null {
  const explicit = explicitWorkspaces(env);
  if (explicit.length === 0) return null;
  const slug = env.WORKSPACE_SLUG;
  const active = slug ? explicit.find((w) => w.slug === slug) : undefined;
  return active?.org ?? null;
}

export function listWorkspaces(env: Env): Workspace[] {
  const db = sharedDb(env);
  const state = db ? registryState.get(db as object) : undefined;
  if (state?.workspaces && state.workspaces.length > 0) return state.workspaces;
  return parseWorkspacesFromEnv(env);
}

// ── Spare-pool claiming (issue #81, PR-2) ────────────────────────────────────
//
// The spare-pool model: an operator pre-provisions empty, migrated D1 databases
// and declares each as a native binding in wrangler.toml (DB_POOL1, …). Each is
// registered as an `available` registry row (registerPoolSlot). When a new org
// onboards, claimWorkspace flips one `available` row to `claimed`, stamping the
// org/label — the roster grows WITHOUT a redeploy, while the hot path stays on
// native bindings (the reason spare-pool was chosen over create-live-over-HTTP).
//
// PR-2 delivers the mechanism + a super-admin API. Auto-claiming at first admin
// login (wiring into the OAuth callback) is PR-3.

// Is `binding` a live D1Database on this env? The same check parseEntry makes —
// the pool-slot validity gate. Bindings are resolved off BASE_ENV so this holds
// whether `env` is the raw Worker env or an already-swapped per-request clone
// (workspaceEnv spreads every binding from base, but reading base is canonical).
function bindingIsLiveD1(env: Env, binding: string): boolean {
  const base = (env.BASE_ENV ?? env) as unknown as Record<string, unknown>;
  const bound = base[binding] as { prepare?: unknown } | undefined;
  return typeof bound?.prepare === "function";
}

// Reload the per-isolate registry cache, so a claim made mid-request is visible
// to listWorkspaces/resolveWorkspace in that same isolate. Re-reads even when the
// cache is warm and overwrites it IN PLACE — no delete gap. Deleting first (as
// this used to) left registryState absent while the read was in flight, so a
// concurrent resolveWorkspaceFresh during a reprime briefly saw the synthetic
// implicit default (list[0]) — another tenant's D1 — instead of the real roster.
// Keeping the old roster visible until the fresh one lands closes that gap. Fails
// soft like any prime.
async function invalidateAndReprime(env: Env): Promise<void> {
  await primeWorkspaces(env, { force: true });
}

// Force this isolate to re-read the shared workspace registry, dropping its
// per-isolate cache. The registry loads once per isolate and never expires on
// its own, so a workspace a DIFFERENT isolate claimed (auto-claim at another
// admin's login, or a super admin's manual pool claim) is otherwise invisible
// here until this isolate recycles. The login path calls this when auto-claim
// examined an org it believed unregistered but did not itself claim (issue #81),
// so a newly-onboarded org's members stop landing on the denied page. Fails
// soft like any prime. This is the same operation `claimWorkspace` runs
// internally after a successful claim; it is exported for the examined-but-
// not-claimed case, where no claim happened on this isolate to trigger it.
export async function refreshWorkspaceRegistry(env: Env): Promise<void> {
  await invalidateAndReprime(env);
}

async function findClaimedByOrg(env: Env, db: D1Database, org: string): Promise<Workspace | null> {
  const row = await db
    .prepare(
      // COLLATE NOCASE: Door43 org names are case-insensitive, so a lookup for
      // "BSOJ" must find an existing "bsoj" row — otherwise a second workspace
      // gets claimed for the same org (duplicate-claim hole). This is also what
      // lets the idempotency check AND the claimWorkspace catch-block recovery
      // find a pre-existing claim regardless of the case the admin typed,
      // matching the NOCASE UNIQUE index on workspaces.org (migration 0068).
      //
      // The ORDER BY predates 0068, when `org` was UNIQUE under BINARY
      // collation and a case-variant pair could already exist (the pre-fix code
      // is what would have created it). Prefer the exact-case row and then the
      // oldest slot, so the org always resolves to ONE deterministic binding
      // rather than an arbitrary one — resolving to the wrong binding would
      // serve another tenant's database. Kept as a belt-and-braces guard for
      // any pre-0068 deploy window.
      `SELECT slug, label, org, binding, export_owner AS exportOwner
         FROM workspaces WHERE org = ?1 COLLATE NOCASE AND status = 'claimed'
         ORDER BY (org = ?1) DESC, slug ASC LIMIT 1`,
    )
    .bind(org)
    .first<WorkspaceRow>();
  if (!row) return null;
  return parseEntry(env, {
    slug: row.slug,
    label: row.label,
    org: row.org,
    binding: row.binding,
    exportOwner: row.exportOwner ?? undefined,
  });
}

export interface ClaimResult {
  workspace: Workspace;
  // true = `org` already owned a claimed slot; no new slot was consumed
  // (idempotent re-onboard, or recovery from a concurrent-claim race).
  alreadyClaimed: boolean;
}

// A claim couldn't proceed because a row that is NOT a resolvable claimed slot
// already holds this org: a `retired`/`failed`/`provisioning` row, or a
// `claimed` row whose binding is no longer a live D1 on this deployment (so
// findClaimedByOrg couldn't parse it). The `UNIQUE(org) COLLATE NOCASE` index
// (migration 0068) spans EVERY status, so claiming a spare slot for the org
// would trip it — the pre-fix behaviour was a 500 and a permanently unclaimable
// org (issue #382). Distinct from pool exhaustion (null); the route maps this to
// a 409 rather than silently reusing the held row.
export interface ClaimBlocked {
  blocked: "org_held";
  // status of the row already holding the org (retired/failed/provisioning, or
  // claimed-but-unresolvable-here), for a clearer operator-facing error.
  status: string;
}

export function isClaimBlocked(r: ClaimResult | ClaimBlocked | null): r is ClaimBlocked {
  return r !== null && "blocked" in r;
}

// Claims one `available` pool slot for `org`, flipping it to `claimed` and
// stamping org/label/export_owner. Returns null ONLY when the pool is exhausted
// (no `available` row whose binding is a live, deployed D1). Idempotent: if
// `org` already owns a claimed slot it's returned untouched.
//
// Concurrency: the flip is a conditional UPDATE guarded by `status='available'`,
// so two isolates racing for the SAME slot => exactly one sees changes===1; the
// loser tries the next slot. Two isolates racing to claim for the SAME org land
// on different slots, and the second trips UNIQUE(org) — caught and recovered by
// returning the winner's now-claimed slot. Callers must validate org/label
// first (throws on bad input rather than persisting a corrupt row).
export async function claimWorkspace(
  env: Env,
  opts: { org: string; label: string; exportOwner?: string },
): Promise<ClaimResult | ClaimBlocked | null> {
  const db = sharedDb(env);
  // Callers pass an already-canonicalized org: the sole production caller (the
  // POST /api/workspaces/pool/claim route) resolves DCS canonical casing before
  // calling in, keeping this function free of network I/O. claimWorkspace stays
  // defensive regardless — findClaimedByOrg below is COLLATE NOCASE, so a
  // pre-existing claim under different casing (e.g. a fail-open where DCS was
  // unreachable) is still found rather than duplicated.
  const org = opts.org.trim();
  const label = opts.label.trim();
  if (!isIdent(org)) throw new Error(`claimWorkspace: invalid org ${JSON.stringify(opts.org)}`);
  if (label.length === 0 || label.length > 64) throw new Error("claimWorkspace: label must be 1..64 chars");

  const existing = await findClaimedByOrg(env, db, org);
  if (existing) {
    // Re-prime this isolate's cache even on the idempotent path: the org may
    // have been claimed by another isolate since we primed, so our cached
    // roster could be missing this row (which subsequent requests here must
    // resolve). Cheap, and claims are rare.
    await invalidateAndReprime(env);
    return { workspace: existing, alreadyClaimed: true };
  }

  // findClaimedByOrg only sees RESOLVABLE claimed rows. But the UNIQUE(org)
  // index (0068, and the BINARY UNIQUE from 0058 before it) spans every status,
  // so a row holding this org in ANY other state — retired/failed/provisioning,
  // or a claimed row whose binding isn't a live D1 here (parseEntry returned
  // null above) — would make the `UPDATE ... SET org = ?1` below trip
  // UNIQUE(org). The pre-fix path then re-ran findClaimedByOrg (still null) and
  // rethrew: a 500 and a permanently unclaimable org (issue #382). Refuse
  // cleanly instead, and never silently reuse a retired slot.
  const held = await db
    .prepare(`SELECT status FROM workspaces WHERE org = ?1 COLLATE NOCASE LIMIT 1`)
    .bind(org)
    .first<{ status: string }>();
  if (held) return { blocked: "org_held", status: held.status };

  const candidates = await db
    .prepare(`SELECT id, slug, binding FROM workspaces WHERE status = 'available' ORDER BY id`)
    .all<{ id: number; slug: string; binding: string }>();

  for (const cand of candidates.results ?? []) {
    if (!SLUG_RE.test(cand.slug)) continue; // corrupt slot row; never claim into it
    if (!bindingIsLiveD1(env, cand.binding)) continue; // binding not deployed yet
    // Never assign two orgs to the same physical database: skip an available
    // slot whose binding is already held by a claimed row. registerPoolSlot
    // rejects duplicate-binding registration, but this closes the residual
    // window where two available rows briefly share a binding.
    const inUse = await db
      .prepare(`SELECT 1 AS x FROM workspaces WHERE binding = ?1 AND status = 'claimed' LIMIT 1`)
      .bind(cand.binding)
      .first<{ x: number }>();
    if (inUse) continue;

    let claimed = false;
    try {
      const res = await db
        .prepare(
          `UPDATE workspaces
              SET status = 'claimed', org = ?1, label = ?2, export_owner = ?3, updated_at = unixepoch()
            WHERE id = ?4 AND status = 'available'`,
        )
        .bind(org, label, opts.exportOwner ?? null, cand.id)
        .run();
      claimed = (res.meta?.changes ?? 0) === 1;
    } catch (e) {
      // UNIQUE(org): a concurrent login already claimed a slot for this org
      // between the findClaimedByOrg check above and this UPDATE. Recover by
      // handing back that claim instead of erroring — repriming first so this
      // isolate's roster includes the winner's row (otherwise a later request
      // here would fail to resolve the slug and fall back to list[0]).
      const raced = await findClaimedByOrg(env, db, org);
      if (raced) {
        await invalidateAndReprime(env);
        return { workspace: raced, alreadyClaimed: true };
      }
      throw e; // any other constraint failure is genuinely unexpected
    }
    if (!claimed) continue; // lost the race for THIS slot; try the next

    const ws = parseEntry(env, { slug: cand.slug, label, org, binding: cand.binding, exportOwner: opts.exportOwner });
    await invalidateAndReprime(env);
    if (!ws) {
      // Pre-validated slug + live binding, so this shouldn't happen — but never
      // return a half-valid workspace. The row is claimed; surface as a failure.
      console.warn("workspaces: claimed slot failed post-claim validation", cand.slug);
      return null;
    }
    return { workspace: ws, alreadyClaimed: false };
  }
  return null; // pool exhausted
}

export interface PoolSlot {
  slug: string;
  label: string | null;
  org: string | null;
  binding: string;
  databaseUuid: string | null;
  exportOwner: string | null;
  status: string;
  bindingLive: boolean; // is `binding` a live D1 on this deployment right now?
  createdAt: number;
  updatedAt: number;
}

export interface PoolStatus {
  counts: Record<string, number>; // rows per status value
  slots: PoolSlot[]; // every registry row, oldest first
}

// Full registry snapshot for the super-admin pool view — every row regardless
// of status, plus a live-binding flag so an operator can see which `available`
// slots are actually claimable vs. declared-but-not-yet-deployed.
export async function getPoolStatus(env: Env): Promise<PoolStatus> {
  const db = sharedDb(env);
  const res = await db
    .prepare(
      `SELECT slug, label, org, binding,
              database_uuid AS databaseUuid, export_owner AS exportOwner,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM workspaces ORDER BY id`,
    )
    .all<Omit<PoolSlot, "bindingLive">>();
  const counts: Record<string, number> = {};
  const slots: PoolSlot[] = (res.results ?? []).map((r) => {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    return { ...r, bindingLive: bindingIsLiveD1(env, r.binding) };
  });
  return { counts, slots };
}

export type RegisterPoolError = "invalid_binding" | "binding_not_live" | "invalid_slug" | "slug_taken" | "binding_taken";

export interface RegisterPoolResult {
  ok: boolean;
  error?: RegisterPoolError;
  slot?: PoolSlot;
}

// Derive a slug from a binding name: "DB_POOL1" -> "pool1", "DB_MLTEST" ->
// "mltest". Callers may override; a derivation that doesn't satisfy SLUG_RE is
// rejected (invalid_slug) so the operator supplies one explicitly.
function defaultSlugForBinding(binding: string): string {
  return binding.replace(/^DB_?/i, "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// Registers a pre-provisioned, migrated D1 binding as an `available` pool slot.
// The binding must already be declared in wrangler.toml and deployed (live on
// env) — this only writes the registry row; it neither creates a database nor
// runs migrations (that's the operator runbook / a later PR).
export async function registerPoolSlot(
  env: Env,
  opts: { binding: string; slug?: string; databaseUuid?: string },
): Promise<RegisterPoolResult> {
  const binding = (opts.binding ?? "").trim();
  if (!binding) return { ok: false, error: "invalid_binding" };
  if (!bindingIsLiveD1(env, binding)) return { ok: false, error: "binding_not_live" };
  const slug = (opts.slug ?? defaultSlugForBinding(binding)).trim();
  if (!SLUG_RE.test(slug)) return { ok: false, error: "invalid_slug" };

  const db = sharedDb(env);
  // One binding = one physical database = at most one workspace. Registering
  // the same binding under a second slug would let two orgs be claimed onto the
  // same D1 and corrupt each other's data, so reject a binding already present
  // in ANY row (available, claimed, or a WORKSPACES-seeded one).
  const clash = await db
    .prepare(`SELECT slug FROM workspaces WHERE binding = ?1 LIMIT 1`)
    .bind(binding)
    .first<{ slug: string }>();
  if (clash) return { ok: false, error: "binding_taken" };
  try {
    await db
      .prepare(`INSERT INTO workspaces (slug, binding, database_uuid, status) VALUES (?1, ?2, ?3, 'available')`)
      .bind(slug, binding, opts.databaseUuid ?? null)
      .run();
  } catch {
    // UNIQUE(slug): a slot with this slug is already registered.
    return { ok: false, error: "slug_taken" };
  }
  const slot = await db
    .prepare(
      `SELECT slug, label, org, binding,
              database_uuid AS databaseUuid, export_owner AS exportOwner,
              status, created_at AS createdAt, updated_at AS updatedAt
         FROM workspaces WHERE slug = ?1`,
    )
    .bind(slug)
    .first<Omit<PoolSlot, "bindingLive">>();
  // `available` rows aren't in the claimed roster, so no reprime is needed here.
  return { ok: true, slot: slot ? { ...slot, bindingLive: true } : undefined };
}

// ── Login-time workspace resolution ─────────────────────────────────────────

// Why this exists: index.ts's fetch() wrapper resolves the workspace from the
// be_ws cookie BEFORE anyone knows who the user is, so a first-time user with
// no cookie lands in list[0] — and the OAuth callback then ran every org
// comparison (team sync, viewer membership) against the wrong org. Once the
// callback holds the user's profile + org memberships, it re-resolves with
// this function and re-derives its env via workspaceEnv().
//
// Pure and synchronous so the resolution ORDER is unit-testable on its own
// (see workspaceLogin.test.mjs); the callback supplies the inputs.
export type LoginWorkspaceReason =
  | "cookie" // (a) valid be_ws cookie for a workspace the user is allowed in
  | "last_used" // (b) persisted users.last_workspace_slug, still allowed
  | "single_match" // (c) exactly one configured workspace matches their orgs
  | "multi_match" // (d) several match, no usable history — first match + prompt
  | "no_match" // (e) memberships known, nothing matches — fallback; callback may deny
  | "unknown"; // orgs fetch failed — fail soft to cookie/first (cached roles still work)

export interface LoginWorkspaceResolution {
  workspace: Workspace;
  reason: LoginWorkspaceReason;
  // (d) only: tell the SPA to prompt the user to pick (callback appends
  // ?_choose_ws=1 to its redirect). Derived from `reason`.
  promptChoice: boolean;
  // True when the user is POSITIVELY allowed in `workspace` (cases a–d).
  // False for "unknown"/"no_match", where `workspace` is only the fail-soft
  // fallback. Derived from `reason`.
  matched: boolean;
}

// Single construction point: promptChoice/matched are pure functions of
// `reason`, so deriving them here (instead of hand-writing booleans at each
// return site) means the fields can never drift out of sync with the reason.
function loginResolution(workspace: Workspace, reason: LoginWorkspaceReason): LoginWorkspaceResolution {
  return {
    workspace,
    reason,
    promptChoice: reason === "multi_match",
    matched: reason !== "unknown" && reason !== "no_match",
  };
}

export function resolveLoginWorkspace(opts: {
  workspaces: Workspace[]; // from listWorkspaces() — never empty
  cookieSlug: string | null; // raw be_ws cookie value, if any
  lastUsedSlug: string | null; // users.last_workspace_slug, if any
  // Lowercased Door43 org names the user belongs to; null = fetch failed
  // ("unknown", NOT "no orgs"). Callers pass every workspace org for a super
  // admin — they're allowed everywhere without a DCS round-trip.
  memberOrgs: Set<string> | null;
  // Slugs of workspaces where the user already holds a user_roles row (manual
  // allowlist grant or cached team role). A role row grants access to that
  // workspace even without Door43 org membership — otherwise a manually
  // allowlisted outsider would be evicted from their org at every login. On
  // the fast path the caller only queries the CANDIDATE workspaces (cookie +
  // last-used); when the first resolution comes back "no_match" — the
  // would-deny path — it fans the lookup out across ALL configured workspaces
  // and re-resolves with the expanded set, so entries here can then drive
  // single_match/multi_match selection too.
  roleSlugs?: Set<string>;
}): LoginWorkspaceResolution {
  const { workspaces, memberOrgs } = opts;
  const roleSlugs = opts.roleSlugs ?? new Set<string>();
  const bySlug = (slug: string | null): Workspace | undefined =>
    slug ? workspaces.find((w) => w.slug === slug) : undefined;
  // The pre-this-feature behavior, kept as the fail-soft/no-match landing:
  // cookie's workspace when the slug is at least real, else list[0].
  const fallback = bySlug(opts.cookieSlug) ?? workspaces[0];

  if (memberOrgs === null) {
    return loginResolution(fallback, "unknown");
  }

  const isAllowed = (ws: Workspace | undefined): ws is Workspace =>
    !!ws && (memberOrgs.has(ws.org.toLowerCase()) || roleSlugs.has(ws.slug));

  const cookieWs = bySlug(opts.cookieSlug);
  if (isAllowed(cookieWs)) {
    return loginResolution(cookieWs, "cookie");
  }
  const lastWs = bySlug(opts.lastUsedSlug);
  if (isAllowed(lastWs)) {
    return loginResolution(lastWs, "last_used");
  }
  const allowed = workspaces.filter((w) => isAllowed(w));
  if (allowed.length === 1) {
    return loginResolution(allowed[0], "single_match");
  }
  if (allowed.length > 1) {
    return loginResolution(allowed[0], "multi_match");
  }
  return loginResolution(fallback, "no_match");
}

// Exact slug match; unknown/null slug falls back to the first workspace
// (the implicit default when WORKSPACES is unset).
export function resolveWorkspace(env: Env, slug: string | null): Workspace {
  const list = listWorkspaces(env);
  if (slug) {
    const found = list.find((w) => w.slug === slug);
    if (found) return found;
  }
  return list[0];
}

// Rate-limit bookkeeping for the unknown-slug registry recheck below, keyed on
// the shared-DB object (stable for the isolate's lifetime, the same key
// primeWorkspaces/registryState use). Two bounds work together (issue #428, the
// O2 refinement of #418/#419):
//
//   • PER-SLUG window — an individual unknown slug triggers at most one recheck
//     per window. Keying the limit on the slug (not just the shared-DB object,
//     as #419 did) is the whole point: a genuinely-dead cookie's recheck no
//     longer suppresses the recheck a DIFFERENT, freshly-claimed slug needs
//     within the same window, so that slug resolves to its own binding instead
//     of falling through to list[0] — another tenant's D1. A repeatedly-arriving
//     dead slug still reprimes only once per window.
//   • GLOBAL per-window budget — at most MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW
//     distinct rechecks per window regardless of how many distinct unknown slugs
//     arrive. This preserves the DoS bound the per-isolate limit gave: an
//     attacker spraying many distinct unknown slugs still forces only bounded
//     work per window, not one reprime per slug.
//
// Reprimes are SERIALIZED per shared-DB object: at most one runs at a time,
// regardless of slug. A reprime is delete-then-reprime on the shared
// registryState, and primeWorkspaces does not dedupe in-flight loads, so two
// reprimes running at once issue independent registry reads and whichever
// settles LAST wins unconditionally — a stale or failed read finishing last
// would clobber a good roster with the fallback (workspaces: null). Because the
// slugs are stamped below, a freshly-claimed slug would then fall through to
// list[0] (another tenant's D1) for the rest of the window: the exact hole this
// resolver exists to close. So a caller waits out any reprime already in flight
// (re-checking after each whether it answered this slug) before starting its
// own; concurrent callers — same slug or not — collapse onto the running read.
// The budget is charged when a reprime is STARTED, so shared callers count once.
const UNKNOWN_SLUG_RECHECK_MS = 10_000;
export const MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW = 8;

interface RecheckState {
  windowStart: number; // start of the current global window (ms)
  count: number; // rechecks charged against this window's budget
  perSlug: Map<string, number>; // slug -> ms timestamp of its recheck this window
  inflight: Promise<void> | null; // the ONE reprime in flight for this DB (any slug), or null
}

const unknownSlugRecheck = new WeakMap<object, RecheckState>();

function recheckState(db: object): RecheckState {
  let s = unknownSlugRecheck.get(db);
  if (!s) {
    s = { windowStart: 0, count: 0, perSlug: new Map(), inflight: null };
    unknownSlugRecheck.set(db, s);
  }
  return s;
}

// Recheck the shared registry for an unknown slug, subject to the per-slug and
// global-budget limits above, and serializing reprimes so a stale/failed read
// can never clobber a good roster (see the block comment above). Never throws
// (invalidateAndReprime fails soft), so the caller can always fall through to the
// current cache afterward.
async function maybeRecheckUnknownSlug(env: Env, db: object, slug: string): Promise<void> {
  const state = recheckState(db);
  const now = Date.now();

  // Roll the window if it has elapsed: fresh budget and per-slug history. (An
  // in-flight reprime from the previous window clears itself on settle, so
  // `inflight` needs no reset here.)
  if (now - state.windowStart >= UNKNOWN_SLUG_RECHECK_MS) {
    state.windowStart = now;
    state.count = 0;
    state.perSlug.clear();
  }

  // Single-flight: wait out any reprime already running for this DB before
  // touching the registry ourselves — never read concurrently with another
  // reprime (that races the shared registryState, and a stale/failed read
  // settling last would win). After each in-flight reprime settles, its fresh
  // roster may already answer us, so re-check and return; only when no reprime is
  // running (loop exits with inflight === null) do we consider our own.
  while (state.inflight) {
    await state.inflight;
    if (listWorkspaces(env).some((w) => w.slug === slug)) return;
  }

  // Per-slug rate-limit: this exact slug already rechecked this window.
  const lastForSlug = state.perSlug.get(slug);
  if (lastForSlug !== undefined && now - lastForSlug < UNKNOWN_SLUG_RECHECK_MS) return;

  // Global DoS bound: the window's recheck budget is spent.
  if (state.count >= MAX_UNKNOWN_SLUG_RECHECKS_PER_WINDOW) return;

  // Charge the budget and stamp the slug BEFORE awaiting, so a repeat of THIS
  // slug within the window is suppressed and the single-flight guard above holds
  // for callers that arrive while this reprime runs.
  state.count += 1;
  state.perSlug.set(slug, now);
  const p = invalidateAndReprime(env).finally(() => {
    state.inflight = null;
  });
  state.inflight = p;
  await p;
}

// Request-path resolver that closes the warm-stale cross-tenant hole (issue
// #418, hardened per-slug in #428). resolveWorkspace() answers a slug this
// isolate's registry cache lacks by returning list[0] — a DIFFERENT tenant's
// D1. But the registry is primed once per isolate and never expires, so a
// workspace claimed on a sibling isolate (manual pool claim, or auto-claim at
// another admin's login) is invisible to an already-warm isolate until it
// recycles. When the request names a slug we don't have, re-read the registry
// (per-slug, budget-limited — see maybeRecheckUnknownSlug) and re-resolve
// before falling back. A genuinely-dead slug still lands on list[0] exactly as
// today (no behavior change for legitimately-retired cookies); only the
// reachable warm-stale case is repaired.
//
// The top-level fetch handler (index.ts) uses this instead of resolveWorkspace.
export async function resolveWorkspaceFresh(env: Env, slug: string | null): Promise<Workspace> {
  const list = listWorkspaces(env);
  if (!slug) return list[0];

  const found = list.find((w) => w.slug === slug);
  if (found) return found;

  // Unknown slug. The registry may have grown on another isolate since we
  // primed; recheck rather than immediately serving list[0].
  const db = sharedDb(env);
  if (db) {
    await maybeRecheckUnknownSlug(env, db as object, slug);
    const fresh = listWorkspaces(env).find((w) => w.slug === slug);
    if (fresh) return fresh;
  }
  // Still unknown (dead slug, or the recheck was rate-limited/budget-capped this
  // window): fall back to the first workspace, unchanged from resolveWorkspace().
  return listWorkspaces(env)[0];
}

// Swaps in the workspace's D1 binding as DB, resolves SHARED_DB to the
// ORIGINAL default DB binding (must be read before DB is overwritten below),
// and stamps VIEWER_ORG / WORKSPACE_SLUG / DCS_EXPORT_OWNER for this request.
export function workspaceEnv(env: Env, ws: Workspace): Env {
  // Bindings are always resolved from the ORIGINAL (never-swapped) env, kept on
  // BASE_ENV. This function can legitimately be called on an already-swapped
  // env — the workspace-switch route resolves the *target* workspace's DB from
  // the current request's env — and the first workspace's binding is literally
  // named "DB". Reading `env[ws.binding]` off a swapped env would then hand
  // back whichever database is currently active instead of the target's, which
  // silently reads the wrong org (it looked up roles in the wrong workspace).
  const base = env.BASE_ENV ?? env;
  return {
    ...base,
    BASE_ENV: base,
    DB: (base as unknown as Record<string, unknown>)[ws.binding] as D1Database,
    SHARED_DB: base.SHARED_DB ?? base.DB,
    VIEWER_ORG: ws.org,
    DCS_EXPORT_OWNER: ws.exportOwner ?? base.DCS_EXPORT_OWNER,
    WORKSPACE_SLUG: ws.slug,
  };
}

// Accounts, sessions, the lexicon, alignment frequencies, and UI-string
// overrides are not org-scoped — they must read the shared DB regardless of
// which workspace the request is in, or switching orgs would log a user out
// / force a lexicon re-import per org. Falls back to DB when SHARED_DB was
// never set (WORKSPACES unset — DB and SHARED_DB are the same database).
export function sharedDb(env: Env): D1Database {
  return env.SHARED_DB ?? env.DB;
}

// ── Workspace cookie ─────────────────────────────────────────────────────────

export const WORKSPACE_COOKIE = "be_ws";

// Reads be_ws directly off the raw Cookie header — no dependency, this runs
// before the Hono context exists (the fetch wrapper in index.ts, ahead of
// app.fetch).
export function parseWorkspaceCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === WORKSPACE_COOKIE) {
      // A malformed percent-escape (e.g. a stray "%" from a hand-edited or
      // corrupted cookie) throws a URIError out of decodeURIComponent — left
      // uncaught, that turns into an uncaught throw inside the fetch()
      // wrapper (this runs before Hono's onError handler exists), 500ing
      // every request from that browser. Treat an undecodable value the same
      // as an absent cookie — resolveWorkspace() already handles null by
      // falling back to the first/default workspace.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function serializeWorkspaceCookie(slug: string, secure: boolean): string {
  const attrs = [`${WORKSPACE_COOKIE}=${slug}`, "Path=/", "Max-Age=31536000", "SameSite=Lax", "HttpOnly"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// ── Cross-tab workspace-mismatch guard ──────────────────────────────────────

// Paths exempt from the check below regardless of the header's value:
// /api/auth/* is hit by raw fetch() calls that never set X-Workspace (the
// refresh/dev-mint/OAuth-callback flows in web/src/sync/api.ts) AND by
// fetchAuthMe()/authLogout(), which DO go through the shared request() helper
// and so DO carry the client's (possibly stale, pre-reconciliation) slug —
// rejecting those would break the exact boot-time reconciliation this guard
// is meant to support. /api/ws/* is the WebSocket upgrade route; browsers
// don't allow custom headers on a WS handshake, so this is defensive rather
// than load-bearing.
function isWorkspaceMismatchExempt(path: string): boolean {
  return path.startsWith("/api/auth/") || path.startsWith("/api/ws/");
}

// Detects a stale tab: web/src/sync/api.ts stamps every request with an
// X-Workspace header holding its client-side notion of the active org
// (getWorkspaceSlug()). If a SIBLING tab switches orgs, THIS tab's requests
// still carry the old slug — which won't match the workspace this request
// resolved to (index.ts's fetch() wrapper already picked the D1 binding from
// the be_ws cookie before Hono ever saw the request). Reject so api.ts can
// force this tab to reconcile instead of silently reading/writing the wrong
// org's data — see outbox.ts's dispatch() for why a queued edit must survive
// this (it stays queued; it belongs to the OTHER workspace's outbox and drains
// fine once the user is back there).
//
// Absent header ALWAYS passes — older clients, curl, and the exempt paths
// above never send it. This is detection of a known-stale claim, not
// enforcement that the header be present.
export const requireWorkspaceMatch: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const claimed = c.req.header("x-workspace");
  const resolved = c.env.WORKSPACE_SLUG ?? "default";
  if (claimed && claimed !== resolved && !isWorkspaceMismatchExempt(c.req.path)) {
    return c.json({ error: "workspace_mismatch", expected: resolved }, 409);
  }
  await next();
};
