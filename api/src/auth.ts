// Cookie-based session auth for the editor API.
//
// Cookies set on every successful sign-in (OAuth callback or dev mint):
//   be_access  — HttpOnly, SameSite=Lax, Path=/, short JWT (1h). attachAuth
//                middleware reads this and stamps userId/role on the request.
//   be_refresh — HttpOnly, SameSite=Strict, Path=/api/auth/refresh, 14d.
//                Value is sessions.id; refresh endpoint validates the row,
//                mints a new Access JWT, rotates the cookie.
//   be_csrf    — NOT HttpOnly, SameSite=Lax, Path=/, 14d. Double-submit value
//                the SPA mirrors into X-CSRF-Token on writes.
//
// Bearer-Authorization is still honored as a fallback (non-browser callers
// and the cutover window for any cached localStorage tokens). Plan is to
// drop it a few weeks after this lands.
//
// Writes (POST/PATCH/DELETE) require a valid token AND a matching csrf token.
// Reads are unauthenticated for now because the same content is destined for
// public DCS export. If/when reads need locking down, apply requireAuth too.
//
// Dev-only mint endpoint: POST /api/auth/dev (gated by DEV_AUTH_ENABLED=true).
// DCS OAuth: GET /api/auth/dcs/start → GET /api/auth/dcs/callback.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./index";
import {
  fetchMemberOrgs,
  syncTeamRoleForUser,
  RESYNC_AFTER_SECONDS,
} from "./dcsTeams.ts";
import {
  sharedDb,
  listWorkspaces,
  refreshWorkspaceRegistry,
  resolveLoginWorkspace,
  serializeWorkspaceCookie,
  workspaceEnv,
  WORKSPACE_COOKIE,
} from "./workspaces.ts";
import { autoClaimWorkspaceForAdmin } from "./workspaceAutoClaim.ts";
import { presetForOrg, seedProjectConfigIfAbsent } from "./projectConfig.ts";
import { z } from "zod";
import { parseJson } from "./httpJson.ts";
import { DcsOrgsResponse } from "./dcsSchemas.ts";

// Schemas for the DCS OAuth boundary (#484). These replace the unchecked
// `(await res.json()) as T` casts in the callback below: a token or profile
// response whose shape doesn't match is rejected at parse and mapped to the
// same 502 the non-2xx path already returns, instead of flowing inward as
// undefined/garbage (e.g. a numeric access_token that reads as truthy).
const DcsTokenResponse = z.object({ access_token: z.string().optional() });
const DcsUserResponse = z.object({
  id: z.number(),
  login: z.string(),
  full_name: z.string().optional(),
});

// Isolate-level memoization for ensureWorkspaceUser (below), keyed
// `${WORKSPACE_SLUG}:${userId}` — once mirrored this isolate, never repeat
// the INSERT OR IGNORE for that pair. A cold isolate just re-populates this
// lazily; the only cost of a cache miss is one harmless extra
// INSERT OR IGNORE, never a correctness problem.
const mirroredWorkspaceUsers = new Set<string>();

// Per-org D1 databases each keep their own `users` table — tn_rows,
// tq_rows, twl_rows, verses, edit_log, user_roles, etc. all have FKs
// pointing at the LOCAL users(id) (see api/migrations/0001_init.sql and
// friends) — but sign-in now writes the canonical row to SHARED_DB only.
// A user whose first write in a session lands in a non-default workspace
// has no matching local row, so those foreign keys fail:
// `D1_ERROR: FOREIGN KEY constraint failed`. Mirror the row (same explicit
// id, so the FK actually resolves) into the workspace's local `users`
// table. Never copy dcs_access_token — that's shared-DB-only and must
// never be duplicated into a per-org database.
export async function ensureWorkspaceUser(env: Env, userId: number): Promise<void> {
  // Default/single-workspace case: SHARED_DB and DB are the same database,
  // so the row is already there. Checked first — this is the overwhelmingly
  // common case and must be free.
  if (sharedDb(env) === env.DB) return;

  const cacheKey = `${env.WORKSPACE_SLUG ?? "default"}:${userId}`;
  if (mirroredWorkspaceUsers.has(cacheKey)) return;

  // Must never throw into the request path — a failure here should not
  // 500 an otherwise-fine read/write.
  try {
    const row = await sharedDb(env)
      .prepare(`SELECT id, dcs_user_id, dcs_username, dcs_full_name FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ id: number; dcs_user_id: number; dcs_username: string; dcs_full_name: string | null }>();
    if (!row) return;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, dcs_user_id, dcs_username, dcs_full_name) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(row.id, row.dcs_user_id, row.dcs_username, row.dcs_full_name)
      .run();
    mirroredWorkspaceUsers.add(cacheKey);
  } catch (e) {
    console.error("ensureWorkspaceUser failed", {
      workspace: env.WORKSPACE_SLUG,
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

const ACCESS_COOKIE = "be_access";
const REFRESH_COOKIE = "be_refresh";
const CSRF_COOKIE = "be_csrf";

// Refresh-cookie path. We use `/` (not the narrower `/api/auth/refresh`) so
// `authLogout` — which has no good way to identify the session otherwise —
// can read the cookie and revoke the row. SameSite=Strict + HttpOnly keeps
// the cookie hidden from cross-site attackers and JS, so the broader path
// doesn't change the threat model meaningfully.
const REFRESH_COOKIE_PATH = "/";

// Access cookie lifetime. Short by design: anyone holding the cookie gets
// an hour of authority before they need a refresh. Refresh is gated on the
// DB session row, so revocation lands within this window.
const ACCESS_COOKIE_TTL_SECONDS = 3600;

// Session lifetime — also the lifetime of the Refresh + CSRF cookies. Past
// this, the user has to re-auth.
const SESSION_TTL_SECONDS = 14 * 86400;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// `secure` is gated on the request URL — localhost in dev is HTTP, so
// Secure cookies would never be set. In any other scheme we set Secure.
function isSecureRequest(c: AppContext): boolean {
  return !c.req.url.startsWith("http://");
}

export type Role = "admin" | "editor" | "viewer";

export interface AuthClaims {
  userId: number;
  username?: string;
  role?: Role;
}

// Org granted read-only access via DCS membership. Lookup is case-insensitive;
// can be overridden per-env via VIEWER_ORG (defaults to "unfoldingWord").
function viewerOrgName(env: Env): string {
  return (env.VIEWER_ORG ?? "unfoldingWord").trim() || "unfoldingWord";
}

// Calls the Gitea API to check whether `dcsUsername` is a member of the
// viewer-eligible org. `accessToken` (the user's OAuth token, when present)
// picks up private memberships; otherwise the unauthenticated call only sees
// public memberships. Returns false on any network/parse failure — we'd
// rather deny ambiguously than mint a token by accident.
async function isViewerOrgMember(
  env: Env,
  dcsUsername: string,
  accessToken: string | null,
): Promise<boolean> {
  const orgName = viewerOrgName(env).toLowerCase();
  try {
    if (accessToken) {
      // Authenticated: lists current user's orgs including private memberships.
      const res = await fetch(`${env.DCS_BASE_URL}/api/v1/user/orgs`, {
        headers: { Authorization: `token ${accessToken}` },
      });
      if (!res.ok) return false;
      const orgs = await parseJson(res, DcsOrgsResponse, "DCS user orgs (authenticated)");
      return orgs.some((o) => (o.username ?? "").toLowerCase() === orgName);
    }
    // Unauthenticated path (refresh): only sees public memberships, but the
    // uW org membership is public so this is sufficient in practice. If the
    // DCS_SERVICE_TOKEN is configured, use it to also catch private members.
    const headers: Record<string, string> = {};
    if (env.DCS_SERVICE_TOKEN) headers.Authorization = `token ${env.DCS_SERVICE_TOKEN}`;
    const res = await fetch(
      `${env.DCS_BASE_URL}/api/v1/users/${encodeURIComponent(dcsUsername)}/orgs`,
      { headers },
    );
    if (!res.ok) return false;
    const orgs = await parseJson(res, DcsOrgsResponse, "DCS user orgs (unauthenticated)");
    return orgs.some((o) => (o.username ?? "").toLowerCase() === orgName);
  } catch {
    return false;
  }
}

type AppContext = Context<{
  Bindings: Env;
  Variables: { userId?: number; username?: string; role?: Role };
}>;

// COLLATE NOCASE on user_roles.dcs_username means the WHERE compare is case-
// insensitive without us having to lowercase anywhere. Returns null when the
// user isn't on the allowlist — callers translate that to a denial.
export async function lookupUserRole(env: Env, dcsUsername: string): Promise<Role | null> {
  const row = await env.DB.prepare(
    `SELECT role FROM user_roles WHERE dcs_username = ?1`,
  )
    .bind(dcsUsername)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

// Team-role sync itself (org resolution + DCS teams fetch + user_roles cache
// write) lives in dcsTeams.ts as syncTeamRoleForUser — it's shared with the
// workspace-switch route, which must run it against the TARGET workspace's
// env, not this request's.

// Re-check a cached team role on refresh, at most once per RESYNC_AFTER_SECONDS.
//
// Without this, the documented way to revoke access (remove the user from the
// Door43 team) wouldn't take effect until their next *full* OAuth sign-in —
// refresh only re-reads user_roles — so a departed account could keep renewing
// its session for the whole 14-day refresh window.
//
// BEST-EFFORT, and deliberately so. It reuses the DCS access token stored on
// the users row for logout revocation, and we do NOT persist the OAuth
// refresh_token, so once that access token expires (Gitea's default OAuth2
// access-token lifetime is short) /user/teams answers 401, listUserTeams
// reports "unknown", and the cached row is left alone — revocation then falls
// back to taking effect at the user's next full sign-in. That is strictly
// better than no re-check, but it is NOT an hourly revocation guarantee; do
// not describe it as one. Closing the gap means persisting refresh_token and
// exchanging it here — written up in docs/deferred.md.
//
// Failing CLOSED instead (dropping a team role we can't re-verify) was
// considered and rejected: we can't distinguish "token expired" from "the
// teams lookup is structurally broken here" (e.g. an OAuth grant without
// org-read scope), and in the latter case failing closed would turn a feature
// that silently does nothing into a project-wide lockout.
async function maybeResyncTeamRole(env: Env, dcsUsername: string): Promise<void> {
  try {
    // Two databases, so two statements: user_roles is per-org (env.DB), while
    // the OAuth token lives ONLY in the shared users table — ensureWorkspaceUser
    // deliberately never copies dcs_access_token into a per-org users row. The
    // original single LEFT JOIN against env.DB therefore read the mirrored row
    // and always saw token = NULL in any non-default workspace, which silently
    // disabled this whole re-check there: a user removed from a Door43 team kept
    // renewing an editor/admin session in that org for the full refresh window.
    const row = await env.DB.prepare(
      `SELECT synced_at AS syncedAt FROM user_roles
        WHERE dcs_username = ?1 AND source = 'dcs_team'`,
    )
      .bind(dcsUsername)
      .first<{ syncedAt: number | null }>();
    if (!row) return;
    const age = Math.floor(Date.now() / 1000) - (row.syncedAt ?? 0);
    if (age < RESYNC_AFTER_SECONDS) return;
    const tokenRow = await sharedDb(env)
      .prepare(`SELECT dcs_access_token AS token FROM users WHERE dcs_username = ?1`)
      .bind(dcsUsername)
      .first<{ token: string | null }>();
    if (!tokenRow?.token) return;
    await syncTeamRoleForUser(env, dcsUsername, tokenRow.token);
  } catch (err) {
    console.warn(`[auth] team role re-sync failed for ${dcsUsername}: ${String(err)}`);
  }
}

// SUPER_ADMINS (api/wrangler.toml vars) is comma-separated DCS usernames,
// case-insensitive, whitespace trimmed, empty entries ignored. Empty/unset
// var = nobody.
export function isSuperAdmin(env: Env, dcsUsername: string): boolean {
  const list = (env.SUPER_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(dcsUsername.toLowerCase());
}

// A super admin resolves to 'admin' in every workspace — this is what makes
// bootstrapping a brand-new org possible: a fresh workspace's user_roles
// table only has whatever migration 0016 seeds, so without this the first
// person to switch into it would land as a plain viewer org member and be
// unable to run the Setup wizard. Deliberately NOT folded into
// lookupUserRole: adminUserRoutes.ts's last-admin guard asks specifically
// about the user_roles row, not effective access, and must keep meaning
// that.
export async function effectiveRole(env: Env, dcsUsername: string): Promise<Role | null> {
  if (isSuperAdmin(env, dcsUsername)) return "admin";
  return lookupUserRole(env, dcsUsername);
}

function signingKey(env: Env): Uint8Array | null {
  if (!env.JWT_SIGNING_KEY) return null;
  return new TextEncoder().encode(env.JWT_SIGNING_KEY);
}

export async function verifyToken(token: string, env: Env): Promise<AuthClaims | null> {
  const key = signingKey(env);
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
    });
    const sub = payload.sub;
    if (!sub) return null;
    const userId = parseInt(String(sub), 10);
    if (!Number.isFinite(userId)) return null;
    const rawRole = payload.role;
    const role: Role | undefined =
      rawRole === "admin" || rawRole === "editor" || rawRole === "viewer"
        ? rawRole
        : undefined;
    return {
      userId,
      username: typeof payload.username === "string" ? payload.username : undefined,
      role,
    };
  } catch {
    return null;
  }
}

// Pulls an Access JWT off the request from the be_access cookie and stamps the
// claims on the context. The web client (web/src/sync/api.ts) is cookie-only,
// so the earlier Authorization: Bearer fallback — kept during the localStorage
// cutover — has been removed; there are no non-browser callers of this API.
// Doesn't reject on missing/invalid token; that's requireAuth's job. Running
// on every request lets reads become user-aware later without re-plumbing.
export const attachAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE);
  if (token) {
    const claims = await verifyToken(token, c.env as Env);
    if (claims) {
      (c as AppContext).set("userId", claims.userId);
      if (claims.username) (c as AppContext).set("username", claims.username);
      if (claims.role) (c as AppContext).set("role", claims.role);
      // Covers every authenticated route, including sessions that predate a
      // workspace switch — not just the switch route itself (see
      // workspaceRoutes.ts for the switch-time call against the TARGET env).
      await ensureWorkspaceUser(c.env as Env, claims.userId);
    }
  }
  await next();
};

// Double-submit CSRF on writes: client mirrors the non-HttpOnly be_csrf
// cookie into an X-CSRF-Token header. A cross-origin attacker can't read
// the cookie (different origin), so they can't fake the header. Apply this
// middleware AFTER attachAuth so we still get userId stamping on the
// pre-403 request (helpful for logs).
//
// Exempt routes: GET/HEAD/OPTIONS (no state change), OAuth callback (the
// user is being redirected from DCS and doesn't have our cookie yet), and
// /api/auth/dev (dev silent-mint also has no cookie on first call). Refresh
// + logout could in principle CSRF-attack, but Refresh is SameSite=Strict
// (browser refuses to send cross-site anyway) and logout is low-impact.
const CSRF_EXEMPT_PATHS = new Set<string>([
  "/api/auth/dcs/start",
  "/api/auth/dcs/callback",
  "/api/auth/refresh",
  "/api/auth/logout",
  "/api/auth/dev",
]);

export const requireCsrf: MiddlewareHandler = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  if (CSRF_EXEMPT_PATHS.has(c.req.path)) {
    return next();
  }
  const cookieValue = getCookie(c, CSRF_COOKIE);
  const headerValue = c.req.header("x-csrf-token");
  if (!cookieValue || !headerValue || cookieValue !== headerValue) {
    return c.json({ error: "csrf_mismatch" }, 403);
  }
  await next();
};

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

// requireEditor: any role allowed on the user_roles table can write.
// requireAdmin: role must be 'admin' (exports + future destructive ops).
// Both still require a valid JWT (401 first), then role (403).
export const requireEditor: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const role = (c as AppContext).get("role");
  if (role !== "admin" && role !== "editor") {
    return c.json({ error: "forbidden", reason: "not_an_editor" }, 403);
  }
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const role = (c as AppContext).get("role");
  if (role !== "admin") {
    return c.json({ error: "forbidden", reason: "not_an_admin" }, 403);
  }
  await next();
};

export function currentUserId(c: Context): number | null {
  const v = (c as AppContext).get("userId");
  return typeof v === "number" ? v : null;
}

export function currentUserRole(c: Context): Role | null {
  const v = (c as AppContext).get("role");
  return v === "admin" || v === "editor" || v === "viewer" ? v : null;
}

// The signed-in caller's stored DCS OAuth access token, read from the SHARED
// `users` table (stashed at OAuth callback for logout revocation; cleared at
// logout). Lets an authenticated route act against DCS *as the caller* —
// e.g. reading an org roster the shared DCS_SERVICE_TOKEN's account can't see,
// but the caller (an org member) can.
//
// BEST-EFFORT by design, so callers can treat it as one strategy among
// several: returns null when there's no caller, no stored token (dev-minted
// sessions never carry one, and logout nulls it), or the read fails (the
// column/table unavailable mid-migration). A STALE/EXPIRED token is returned
// as-is — this can't tell live from expired; that's discovered at the DCS
// fetch (401/403), where the caller falls through to its next strategy.
export async function currentUserDcsToken(c: Context): Promise<string | null> {
  const userId = currentUserId(c);
  if (userId == null) return null;
  try {
    const row = await sharedDb((c as AppContext).env)
      .prepare(`SELECT dcs_access_token AS token FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ token: string | null }>();
    return row?.token ?? null;
  } catch {
    return null;
  }
}

// ── DCS OAuth ────────────────────────────────────────────────────────────────

const STATE_COOKIE = "dcs_auth_state";

function callbackUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.origin}/api/auth/dcs/callback`;
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signStateCookie(state: string, key: Uint8Array): Promise<string> {
  return new SignJWT({ state })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(key);
}

async function verifyStateCookie(token: string, key: Uint8Array): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return typeof payload.state === "string" ? payload.state : null;
  } catch {
    return null;
  }
}

// Mints a short-lived (1h) Access JWT for the cookie session. The refresh
// path mints a new one each hour via the be_refresh cookie; revocation lands
// within that hour even though the JWT itself is stateless.
//
// Exported so workspaceRoutes.ts's POST /api/workspaces/:slug can re-mint the
// Access cookie with a role re-resolved against the TARGET workspace's DB
// after a switch — reusing this rather than re-implementing the signing.
export async function mintToken(
  c: AppContext,
  userId: number,
  username: string,
  role: Role,
): Promise<string> {
  const key = signingKey(c.env)!;
  return new SignJWT({ username, role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(userId))
    .setIssuer(c.env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_COOKIE_TTL_SECONDS}s`)
    .sign(key);
}

interface SessionMintResult {
  sessionId: string;
  csrfToken: string;
}

// Inserts a fresh sessions row + returns its id + csrf token. The Refresh
// cookie value is sessionId; the CSRF cookie value is csrfToken. Caller is
// responsible for setting all three cookies (see setSessionCookies).
async function startSession(c: AppContext, userId: number): Promise<SessionMintResult> {
  const sessionId = randomHex(32);
  const csrfToken = randomHex(32);
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 255) || null;
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await sharedDb(c.env).prepare(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, user_agent, ip, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch())`,
  )
    .bind(sessionId, userId, csrfToken, expiresAt, userAgent, ip)
    .run();
  return { sessionId, csrfToken };
}

// Sets all three session cookies in one shot. Call after mintToken +
// startSession. Cookie attributes are tuned per cookie — see file header.
function setSessionCookies(
  c: AppContext,
  accessJwt: string,
  sessionId: string,
  csrfToken: string,
) {
  const secure = isSecureRequest(c);
  setCookie(c, ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ACCESS_COOKIE_TTL_SECONDS,
    secure,
  });
  setCookie(c, REFRESH_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "Strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
  setCookie(c, CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure,
  });
}

// Only rotates the Access cookie (called by refreshToken, and by
// workspaceRoutes.ts's workspace-switch role re-mint). The Refresh + CSRF
// cookies stay bound to the same session row.
export function rotateAccessCookie(c: AppContext, accessJwt: string) {
  setCookie(c, ACCESS_COOKIE, accessJwt, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ACCESS_COOKIE_TTL_SECONDS,
    secure: isSecureRequest(c),
  });
}

// Clears ONLY the Access cookie. Used when a workspace switch can't cleanly
// re-mint a role-correct token (see workspaceRoutes.ts) — forces the client
// through /api/auth/refresh, which re-resolves the role against the
// per-request (by-then target-workspace) DB, rather than leaving a stale,
// wrong-org role live for the rest of the old token's TTL.
export function clearAccessCookie(c: AppContext) {
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
}

function clearSessionCookies(c: AppContext) {
  // Path on each delete must match the path the cookie was set on, or the
  // browser leaves the original in place.
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
}

// GET /api/auth/dcs/start — redirects to DCS authorization page.
export async function startDcsAuth(c: AppContext): Promise<Response> {
  if (!c.env.DCS_CLIENT_ID) return c.json({ error: "dcs_not_configured" }, 503);
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const state = generateState();
  const stateCookie = await signStateCookie(state, key);
  const isLocalhost = c.req.url.startsWith("http://localhost") || c.req.url.startsWith("http://127.0.0.1");
  setCookie(c, STATE_COOKIE, stateCookie, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/api/auth/dcs",
    maxAge: 600,
    secure: !isLocalhost,
  });

  const authUrl = new URL(c.env.DCS_OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", c.env.DCS_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("state", state);
  return c.redirect(authUrl.toString(), 302);
}

// GET /api/auth/dcs/callback — exchanges code, upserts user, mints JWT.
export async function callbackDcsAuth(c: AppContext): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const stateCookie = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth/dcs" });
  if (!stateCookie) return c.json({ error: "missing_state_cookie" }, 400);

  const expectedState = await verifyStateCookie(stateCookie, key);
  const receivedState = c.req.query("state");
  if (!expectedState || expectedState !== receivedState) {
    return c.json({ error: "state_mismatch" }, 400);
  }

  const code = c.req.query("code");
  if (!code) return c.json({ error: "missing_code" }, 400);

  // Exchange authorization code for DCS access token.
  const tokenRes = await fetch(c.env.DCS_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      client_id: c.env.DCS_CLIENT_ID,
      client_secret: c.env.DCS_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(c.req.url),
    }),
  });
  if (!tokenRes.ok) return c.json({ error: "token_exchange_failed" }, 502);
  let tokenData: z.infer<typeof DcsTokenResponse>;
  try {
    tokenData = await parseJson(tokenRes, DcsTokenResponse, "DCS OAuth token");
  } catch (e) {
    console.warn(`[auth] DCS token response failed validation: ${e instanceof Error ? e.message : e}`);
    return c.json({ error: "token_exchange_failed" }, 502);
  }
  const accessToken = tokenData.access_token;
  if (!accessToken) return c.json({ error: "no_access_token" }, 502);

  // Fetch the DCS user profile.
  const userRes = await fetch(`${c.env.DCS_BASE_URL}/api/v1/user`, {
    headers: { Authorization: `token ${accessToken}` },
  });
  if (!userRes.ok) return c.json({ error: "user_fetch_failed" }, 502);
  let dcsUser: z.infer<typeof DcsUserResponse>;
  try {
    dcsUser = await parseJson(userRes, DcsUserResponse, "DCS user profile");
  } catch (e) {
    console.warn(`[auth] DCS user profile failed validation: ${e instanceof Error ? e.message : e}`);
    return c.json({ error: "user_fetch_failed" }, 502);
  }

  // ── Login-time workspace resolution ────────────────────────────────────
  // index.ts's fetch() wrapper picked this request's workspace from the be_ws
  // cookie BEFORE anyone knew who the user is, so a first-time user with no
  // cookie landed in list[0] — and every org comparison below (team sync,
  // viewer membership) then ran against the wrong org. Observed in the wild:
  // a DCS user in BibleEditorMLTest's BE-Editors team hit the denied screen
  // because everything was checked against BSOJ (list[0]). Now that the
  // profile is in hand, re-resolve from the user's actual Door43 orgs and run
  // EVERYTHING downstream against the derived wsEnv. Shared-DB writes
  // (users, sessions) are workspace-agnostic — sharedDb() resolves the same
  // database from either env.
  let workspaces = listWorkspaces(c.env);
  const cookieSlug = getCookie(c, WORKSPACE_COOKIE) ?? null;
  let lastUsedSlug: string | null = null;
  try {
    const lw = await sharedDb(c.env)
      .prepare(`SELECT last_workspace_slug AS slug FROM users WHERE dcs_user_id = ?1`)
      .bind(dcsUser.id)
      .first<{ slug: string | null }>();
    lastUsedSlug = lw?.slug ?? null;
  } catch {
    // Pre-migration-0056 deploy window (code ships before migrations) —
    // resolution simply proceeds without last-used history.
  }
  // Super admins are allowed in every workspace (mirrors the switch route) —
  // no DCS round-trip needed to know that.
  const memberOrgs = isSuperAdmin(c.env, dcsUser.login)
    ? new Set(workspaces.map((w) => w.org.toLowerCase()))
    : await fetchMemberOrgs(c.env, accessToken);

  // Auto-claim at first admin login (issue #81), OFF unless a deployment sets
  // WORKSPACE_AUTOCLAIM=true and has an explicit roster. If this user administers a
  // Door43 org (its BE-Admins team) that has NO workspace in the registry yet,
  // flip one pre-provisioned `available` pool slot to `claimed` for that org —
  // so a new org onboards itself instead of waiting on a super admin to call
  // POST /api/workspaces/pool/claim. Must run BEFORE resolveLoginWorkspace so
  // the freshly claimed workspace is a candidate for THIS login; a successful
  // claim re-primes the isolate's registry cache, so re-reading the roster
  // below is what makes it visible. Never throws (see workspaceAutoClaim.ts):
  // an exhausted pool or a DCS hiccup leaves resolution exactly as it was.
  //
  // Super admins skip this by construction — their memberOrgs is synthesized
  // from the existing roster, so it can never contain an unregistered org.
  // They onboard orgs through the explicit pool routes.
  const autoClaim = await autoClaimWorkspaceForAdmin(c.env, {
    memberOrgs,
    accessToken,
    dcsUsername: dcsUser.login,
  });
  if (autoClaim.outcome === "claimed" || autoClaim.outcome === "already_claimed") {
    // claimWorkspace already reprimed this isolate's registry cache; just re-read.
    workspaces = listWorkspaces(c.env);
  } else if (autoClaim.examinedUnregisteredCandidate) {
    // This isolate believed the user's org unregistered and did NOT itself claim
    // it, but another isolate may have (issue #81). A warm isolate's registry
    // cache never expires on its own, so without this re-read a newly-onboarded
    // org's members keep resolving to no_match — the denied page — here until the
    // isolate recycles. Re-read the shared registry once, then resolve against
    // it. Cost: one registry read on the login of any user with a not-yet-
    // onboarded org, and only while WORKSPACE_AUTOCLAIM is on (auto-claim returns
    // "disabled" otherwise, which never sets this flag).
    await refreshWorkspaceRegistry(c.env);
    workspaces = listWorkspaces(c.env);
  }

  // A user_roles row grants access to its workspace even without Door43 org
  // membership — a manually allowlisted outsider must not be evicted from
  // their org at login just because the org check can't see them. Only the
  // CANDIDATE workspaces (cookie + last-used) are queried; no fan-out across
  // every configured database. Best-effort per workspace: an unreachable DB
  // (or the table missing mid-migration) just means "no row seen here".
  const roleSlugs = new Set<string>();
  for (const slug of new Set([cookieSlug, lastUsedSlug])) {
    const ws = slug ? workspaces.find((w) => w.slug === slug) : undefined;
    if (!ws) continue;
    try {
      const row = await workspaceEnv(c.env, ws)
        .DB.prepare(`SELECT 1 AS present FROM user_roles WHERE dcs_username = ?1`)
        .bind(dcsUser.login)
        .first<{ present: number }>();
      if (row) roleSlugs.add(ws.slug);
    } catch {
      /* treat as no row — org membership can still allow the workspace */
    }
  }
  let resolution = resolveLoginWorkspace({
    workspaces,
    cookieSlug,
    lastUsedSlug,
    memberOrgs,
    roleSlugs,
  });
  // Would-deny rescue: "no_match" means org membership matched nothing and the
  // cookie/last-used candidates held no role row — the resolution is headed
  // for the list[0] fallback, where effectiveRole reads the WRONG database and
  // a manually-allowlisted first-time user (no cookie, no history, not a
  // Door43 org member) gets the denied screen even though their workspace has
  // a row for them. ONLY on this rare path, fan the user_roles lookup out
  // across every configured workspace (the registry is small) and re-resolve:
  // exactly one row → that workspace (single_match); several → first + the
  // picker prompt (multi_match — not persisted as last-used, same rule as any
  // multi match); none → today's deny stands. The common paths above stay
  // cheap: no fan-out unless we were about to deny.
  if (resolution.reason === "no_match") {
    for (const ws of workspaces) {
      if (roleSlugs.has(ws.slug)) continue;
      try {
        const row = await workspaceEnv(c.env, ws)
          .DB.prepare(`SELECT 1 AS present FROM user_roles WHERE dcs_username = ?1`)
          .bind(dcsUser.login)
          .first<{ present: number }>();
        if (row) roleSlugs.add(ws.slug);
      } catch {
        /* unreachable workspace DB — treat as no row */
      }
    }
    if (roleSlugs.size > 0) {
      resolution = resolveLoginWorkspace({
        workspaces,
        cookieSlug,
        lastUsedSlug,
        memberOrgs,
        roleSlugs,
      });
    }
  }
  const wsEnv = workspaceEnv(c.env, resolution.workspace);

  // Door43 teams as role source (read-side). Membership of the resolved
  // workspace org's BE-Admins / BE-Editors teams grants admin / editor, and is
  // cached into user_roles so /api/auth/refresh needs no DCS round-trip.
  // `teams` is reused when auto-claim above already fetched the user's team
  // listing — it is user-global, not org-scoped, so it is valid for whichever
  // workspace we resolved to, and reusing it keeps the login path at one
  // paginated /user/teams listing instead of two.
  await syncTeamRoleForUser(wsEnv, dcsUser.login, accessToken, { teams: autoClaim.teams });

  // Allowlist gate. user_roles is the source of truth for edit access; an
  // account missing from it falls through to a DCS org-membership check so
  // members of the viewer org (stamped from the resolved workspace's org, or
  // VIEWER_ORG in a single-org deployment) get read-only access. Anything
  // else hits the denied screen — which by construction only happens when we
  // POSITIVELY know the user matches no workspace org AND no cached/manual/
  // super-admin role grants access; an orgs-fetch failure fails soft into the
  // cookie/first workspace where cached roles still work.
  const origin = new URL(c.req.url).origin;
  let role: Role | null = await effectiveRole(wsEnv, dcsUser.login);
  if (!role) {
    // Reuse the org set already fetched above instead of a second DCS call;
    // fall back to the direct check only when that fetch failed.
    const isMember = memberOrgs
      ? memberOrgs.has(viewerOrgName(wsEnv).toLowerCase())
      : await isViewerOrgMember(wsEnv, dcsUser.login, accessToken);
    if (isMember) {
      role = "viewer";
    } else {
      // Name the workspace that rejected them so a user with access to several
      // orgs can tell WHERE the mismatch is (issue #288). `resolution.workspace`
      // is the org login just resolved against; its `label` is the same
      // human-facing name the workspace switcher shows.
      const org = resolution.workspace.label;
      return c.redirect(
        `${origin}/?_auth_denied=1&u=${encodeURIComponent(dcsUser.login)}&org=${encodeURIComponent(org)}`,
        302,
      );
    }
  }

  // Upsert users row keyed by dcs_user_id. We stash the DCS access_token so
  // /api/auth/logout can revoke it server-side (RFC 7009) — without it, the
  // next sign-in silently re-auths against a live DCS cookie session.
  await sharedDb(c.env).prepare(
    `INSERT INTO users (dcs_user_id, dcs_username, dcs_full_name, dcs_access_token)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(dcs_user_id) DO UPDATE SET
       dcs_username = ?2, dcs_full_name = ?3, dcs_access_token = ?4`,
  )
    .bind(dcsUser.id, dcsUser.login, dcsUser.full_name ?? dcsUser.login, accessToken)
    .run();

  const userRow = await sharedDb(c.env).prepare(
    `SELECT id FROM users WHERE dcs_user_id = ?1`,
  )
    .bind(dcsUser.id)
    .first<{ id: number }>();
  if (!userRow) return c.json({ error: "user_create_failed" }, 500);

  // Mirror the user into the resolved workspace's local users table now, so
  // the very first post-login write (which will carry the be_ws cookie set
  // below) can't race attachAuth's lazy mirror and trip an FK.
  await ensureWorkspaceUser(wsEnv, userRow.id);

  // Persist where they landed — the (b) "last-used workspace" input for their
  // next login. Only for a POSITIVE, user-attributable resolution (cookie /
  // last-used / single match): recording the fail-soft fallback would turn one
  // DCS hiccup into sticky wrong-workspace history, and recording the
  // multi_match FIRST match would make that arbitrary pick sticky "last_used"
  // on every device if the one-shot ?_choose_ws prompt is ever lost — by NOT
  // persisting, a lost prompt self-heals: the next login re-prompts. The
  // picker's explicit switch call is what persists a multi-match choice.
  if (resolution.matched && resolution.reason !== "multi_match") {
    try {
      await sharedDb(c.env)
        .prepare(`UPDATE users SET last_workspace_slug = ?1 WHERE id = ?2`)
        .bind(resolution.workspace.slug, userRow.id)
        .run();
    } catch {
      // Pre-migration-0056 deploy window — best-effort by design.
    }
  }

  // Init-on-admin-login: a fresh org's first admin (via their Door43 team)
  // must land ready to run Setup, so seed the workspace's project_config from
  // its org preset when the database has no row yet. Same idempotent
  // best-effort call the workspace-switch route makes.
  if (role === "admin") {
    try {
      const preset = presetForOrg(resolution.workspace.org);
      if (preset) await seedProjectConfigIfAbsent(wsEnv, preset);
    } catch {
      // Non-fatal: getProjectConfig's read-path fallback covers this.
    }
  }

  const token = await mintToken(c, userRow.id, dcsUser.login, role);
  const { sessionId, csrfToken } = await startSession(c, userRow.id);
  setSessionCookies(c, token, sessionId, csrfToken);

  // Land the browser in the workspace we just resolved everything against.
  // append: true — this must ride ALONGSIDE the session cookies above, and
  // c.header()'s default Headers.set would clobber them.
  c.header(
    "Set-Cookie",
    serializeWorkspaceCookie(resolution.workspace.slug, isSecureRequest(c)),
    { append: true },
  );

  // Plain redirect to /. Cookies travel with the response automatically.
  // The earlier `#_auth=<jwt>` fragment shape leaked the bearer into
  // history.state + Referer in some edge cases; cookies eliminate the leak
  // surface entirely (HttpOnly = JS can't even read the Access value).
  // ?_choose_ws=1 (case (d): several org matches, no usable history) tells
  // the SPA to offer a one-time workspace picker — see App.tsx.
  return c.redirect(
    resolution.promptChoice ? `${origin}/?_choose_ws=1` : `${origin}/`,
    302,
  );
}

// GET /api/auth/me — returns identity from the bearer token plus the user's
// last-visited location (used by the SPA to restore where they left off when
// the URL hash is missing — e.g. after the OAuth callback round-trip).
export async function authMe(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  const username = (c as AppContext).get("username");
  const role = (c as AppContext).get("role");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const row = await sharedDb(c.env).prepare(
    `SELECT last_book, last_chapter, last_verse FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ last_book: string | null; last_chapter: number | null; last_verse: number | null }>();
  const currentWsSlug = c.env.WORKSPACE_SLUG ?? "default";
  // The FALLBACK workspace (first entry in WORKSPACES, or the sole implicit
  // "default" one) is the one whose outbox keeps the legacy unsuffixed
  // IndexedDB name — see web/src/sync/outbox.ts's outboxDbName(). The client
  // persists this alongside the slug so it can pick the right outbox name
  // without depending on the slug literally being "default".
  const workspaceIsFallback = currentWsSlug === (listWorkspaces(c.env)[0]?.slug ?? "default");
  return c.json({
    userId,
    username: username ?? null,
    role: role ?? null,
    // Super-admin is otherwise invisible to the client: effectiveRole collapses
    // a super-admin down to "admin", indistinguishable from a plain workspace
    // admin. The Observe screen needs this flag so it can skip the super-admin-
    // only /api/workspaces/pool call (a guaranteed 403 for everyone else) and
    // hide the pool controls that non-super-admins can't use — see issue #241.
    superAdmin: !!username && isSuperAdmin(c.env, username),
    lastBook: row?.last_book ?? null,
    lastChapter: row?.last_chapter ?? null,
    lastVerse: row?.last_verse ?? null,
    workspace: currentWsSlug,
    workspaceIsFallback,
    // Deployment-level: does this worker register the nightly export cron?
    // Prod does; the public dev worker does not (crons = []). Lets the UI show
    // the 05:30 schedule vs. a "use Run export now" notice (#240).
    nightlyExportsEnabled: c.env.NIGHTLY_EXPORTS_ENABLED === "true",
  });
}

// POST /api/auth/refresh — rotates the Access cookie. Driven by the
// be_refresh cookie (SameSite=Strict, path=/api/auth/refresh) holding the
// sessions.id; we look up the row, verify it hasn't been revoked or aged
// out, and mint a fresh 1h JWT. No JWT clockTolerance needed — the DB row
// IS the gate, not the JWT's exp.
export async function refreshToken(c: AppContext): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) return c.json({ error: "jwt_signing_key_not_configured" }, 500);

  const sessionId = getCookie(c, REFRESH_COOKIE);
  if (!sessionId) return c.json({ error: "unauthorized" }, 401);

  const session = await sharedDb(c.env).prepare(
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at, u.dcs_username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1`,
  )
    .bind(sessionId)
    .first<{ id: string; user_id: number; expires_at: number; revoked_at: number | null; dcs_username: string }>();
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (session.revoked_at !== null) return c.json({ error: "unauthorized" }, 401);
  if (session.expires_at < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Re-check the allowlist on refresh — yanking a user from user_roles takes
  // effect by the next refresh, not via the old JWT's natural expiration.
  // Viewers (org-only access) re-verify org membership via the service token
  // (or public org listing) each refresh so removal from the org also revokes.
  const lookupName = session.dcs_username ?? "";
  // Re-check Door43 team membership if the cached row has gone stale, so that
  // removing someone from a team revokes within the hour rather than at their
  // next full sign-in (which may never come). Runs BEFORE the role read so the
  // read sees the fresh row; effectiveRole then short-circuits super admins,
  // who stay admin in every workspace regardless of team membership.
  await maybeResyncTeamRole(c.env, lookupName);
  let role: Role | null = await effectiveRole(c.env, lookupName);
  if (!role) {
    const isMember = await isViewerOrgMember(c.env, lookupName, null);
    if (isMember) role = "viewer";
  }
  if (!role) {
    return c.json({ error: "forbidden", reason: "not_an_editor" }, 403);
  }

  const newToken = await mintToken(c, session.user_id, lookupName, role);
  rotateAccessCookie(c, newToken);
  await sharedDb(c.env).prepare(
    `UPDATE sessions SET last_seen_at = unixepoch() WHERE id = ?1`,
  )
    .bind(sessionId)
    .run();
  return c.json({ ok: true, role, expiresIn: ACCESS_COOKIE_TTL_SECONDS });
}

// ── Dev-only token mint ───────────────────────────────────────────────────────

// Looks up (or inserts) a user row by dcs_username and returns a signed JWT.
// Production paths use /api/auth/dcs; this exists so local dev isn't blocked
// on having a DCS OAuth app registered. Dev users that aren't in user_roles
// are auto-granted 'admin' so the local dev experience exercises all role
// paths without needing a manual seed step.
export async function mintDevToken(c: AppContext, username: string): Promise<Response> {
  const key = signingKey(c.env);
  if (!key) {
    return c.json({ error: "jwt_signing_key_not_configured" }, 500);
  }

  let role = await effectiveRole(c.env, username);
  if (!role) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_roles (dcs_username, role) VALUES (?1, 'admin')`,
    )
      .bind(username)
      .run();
    role = "admin";
  }

  const existing = await sharedDb(c.env).prepare(
    `SELECT id FROM users WHERE dcs_username = ?1`,
  )
    .bind(username)
    .first<{ id: number }>();
  let userId = existing?.id;
  if (!userId) {
    // dcs_user_id is NOT NULL UNIQUE; for dev users we synthesize a random
    // negative integer so it never collides with a real DCS account. Random
    // (rather than a hash of `username`) avoids 32-bit collisions between
    // two dev usernames — the lookup above is by `dcs_username` anyway, so
    // stability across runs isn't required.
    const fakeDcsId = -(Math.floor(Math.random() * 0x7fffffff) + 1);
    await sharedDb(c.env).prepare(
      `INSERT INTO users (dcs_user_id, dcs_username, dcs_full_name) VALUES (?1, ?2, ?2)`,
    )
      .bind(fakeDcsId, username)
      .run();
    const row = await sharedDb(c.env).prepare(
      `SELECT id FROM users WHERE dcs_username = ?1`,
    )
      .bind(username)
      .first<{ id: number }>();
    if (!row) return c.json({ error: "user_create_failed" }, 500);
    userId = row.id;
  }
  const token = await mintToken(c, userId, username, role);
  const { sessionId, csrfToken } = await startSession(c, userId);
  setSessionCookies(c, token, sessionId, csrfToken);
  // Return MeResponse shape — same as /api/auth/me — so the client can take
  // a single round-trip path through devSignIn() without a separate /me
  // follow-up. lastBook/lastChapter/lastVerse are NULL for fresh dev users.
  const loc = await sharedDb(c.env).prepare(
    `SELECT last_book, last_chapter, last_verse FROM users WHERE id = ?1`,
  )
    .bind(userId)
    .first<{ last_book: string | null; last_chapter: number | null; last_verse: number | null }>();
  const currentWsSlug = c.env.WORKSPACE_SLUG ?? "default";
  const workspaceIsFallback = currentWsSlug === (listWorkspaces(c.env)[0]?.slug ?? "default");
  return c.json({
    userId,
    username,
    role,
    // Same MeResponse shape as authMe — local DEV uses this body via
    // devSignIn() without a follow-up /me, so superAdmin must be here too
    // or Observe shows the locked-out pool UI for allowlisted users (#241).
    superAdmin: !!username && isSuperAdmin(c.env, username),
    lastBook: loc?.last_book ?? null,
    lastChapter: loc?.last_chapter ?? null,
    lastVerse: loc?.last_verse ?? null,
    workspace: currentWsSlug,
    workspaceIsFallback,
  });
}

// ── Logout ────────────────────────────────────────────────────────────────

// POST /api/auth/logout — revokes the current session row server-side,
// clears all three session cookies, best-effort revokes the DCS access
// token via RFC 7009, and clears the stored DCS token so we don't keep
// sensitive material around.
//
// Note: RFC 7009 revoke only kills the API token; the user's DCS browser
// session cookie remains, so /login/oauth/authorize will silently re-issue
// a NEW token against that session. To switch DCS accounts, the user has
// to sign out of DCS separately (or use an incognito window). We don't
// auto-drive the user through DCS's /user/logout because that would kick
// them out of every other DCS tab they have open — too invasive.
export async function authLogout(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  // Even without userId, clearing cookies is safe + helpful — a client that
  // calls logout with a broken Access cookie still wants the cookies gone.
  // We still try to revoke the session if we can identify it.
  const sessionId = getCookie(c, REFRESH_COOKIE);
  if (sessionId) {
    await sharedDb(c.env).prepare(
      `UPDATE sessions SET revoked_at = unixepoch() WHERE id = ?1 AND revoked_at IS NULL`,
    )
      .bind(sessionId)
      .run();
  }

  if (userId) {
    const row = await sharedDb(c.env).prepare(
      `SELECT dcs_access_token FROM users WHERE id = ?1`,
    )
      .bind(userId)
      .first<{ dcs_access_token: string | null }>();

    if (row?.dcs_access_token && c.env.DCS_CLIENT_ID && c.env.DCS_CLIENT_SECRET) {
      // RFC 7009 token revocation. Gitea/DCS expects the same client creds as
      // the token exchange. Fire-and-forget — a non-2xx here just means the DCS
      // session may persist; the local session is gone either way.
      try {
        await fetch(`${c.env.DCS_BASE_URL}/login/oauth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            token: row.dcs_access_token,
            client_id: c.env.DCS_CLIENT_ID,
            client_secret: c.env.DCS_CLIENT_SECRET,
          }).toString(),
        });
      } catch {
        /* best-effort */
      }
    }

    // Clear stored token regardless of revoke outcome — keeping a stale
    // token around would do nothing but accumulate sensitive material.
    await sharedDb(c.env).prepare(
      `UPDATE users SET dcs_access_token = NULL WHERE id = ?1`,
    )
      .bind(userId)
      .run();
  }

  clearSessionCookies(c);
  return c.json({ ok: true });
}

// ── Last-position memory ───────────────────────────────────────────────────

// PUT /api/users/me/location — persist where the translator is reading. The
// SPA pushes this on hash change (debounced) so /api/auth/me can hydrate the
// view after sign-in. Stored on the users row directly (1 row per user;
// no history; cheap).
export async function updateLastLocation(c: AppContext): Promise<Response> {
  const userId = (c as AppContext).get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  let body: { book?: unknown; chapter?: unknown; verse?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const book = typeof body.book === "string" ? body.book.toUpperCase() : null;
  const chapter = typeof body.chapter === "number" && Number.isInteger(body.chapter) ? body.chapter : null;
  const verse = typeof body.verse === "number" && Number.isInteger(body.verse) ? body.verse : null;

  if (!book || !/^[A-Z0-9]{1,5}$/.test(book) || chapter === null || chapter < 0 || verse === null || verse < 0) {
    return c.json({ error: "invalid_location" }, 400);
  }

  await sharedDb(c.env).prepare(
    `UPDATE users SET last_book = ?1, last_chapter = ?2, last_verse = ?3 WHERE id = ?4`,
  )
    .bind(book, chapter, verse, userId)
    .run();

  return c.json({ ok: true });
}
