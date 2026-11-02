// Unit tests for auth.ts — the JWT verifier, the middleware chain
// (attachAuth → requireCsrf → role gates), session refresh/revocation, and
// the last-location validator. These are the guards in front of every write
// route, previously exercised only by the (not-CI-gated) Playwright suite.
//
// auth.ts imports ./index for types only, so it loads standalone under the
// strip-types runner. Hono's app.request() runs middleware against standard
// Request/Response objects — no Workers runtime needed. D1 is faked with a
// dispatch-by-SQL-substring stub (fakeDb below).
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/auth.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT, decodeJwt } from "jose";
import {
  attachAuth,
  requireCsrf,
  requireAuth,
  requireEditor,
  requireAdmin,
  verifyToken,
  refreshToken,
  updateLastLocation,
  authMe,
  ensureWorkspaceUser,
  effectiveRole,
  lookupUserRole,
} from "./auth.ts";
import { syncTeamRole, RESYNC_AFTER_SECONDS } from "./dcsTeams.ts";
import { chatLinkRoutes } from "./chatLinkRoutes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const OTHER_KEY = new TextEncoder().encode("a-different-key-also-32-bytes-long!!!");
const ISSUER = "bible-editor";

// Minimal Env. DB is per-test via fakeDb; routes under test touch nothing else.
function baseEnv(db) {
  return { JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: ISSUER, DCS_BASE_URL: "https://git.door43.org", DB: db };
}

// D1 stub: the test hands in (sql, args, op) → result. run() defaults to
// one-changed so UPDATE call sites succeed unless the test says otherwise.
function fakeDb(handler = () => null) {
  const stmt = (sql, args) => ({
    first: async () => handler({ sql, args, op: "first" }),
    run: async () => handler({ sql, args, op: "run" }) ?? { meta: { changes: 1 } },
    all: async () => handler({ sql, args, op: "all" }) ?? { results: [] },
  });
  return {
    prepare(sql) {
      return { bind: (...args) => stmt(sql, args), ...stmt(sql, []) };
    },
  };
}

async function makeToken({
  sub = "1",
  role = "editor",
  username = "alice",
  issuer = ISSUER,
  key = KEY,
  expiresIn = 3600,
  // Workspace the token is bound to (#680). baseEnv sets no WORKSPACE_SLUG,
  // which resolves to "default"; pass null to mint a claim-less token.
  ws = "default",
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(ws === null ? { username, role } : { username, role, ws })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(key);
}

// ── verifyToken ─────────────────────────────────────────────────────────────

console.log("[verifyToken] accepts a well-formed token, rejects every tamper axis");
{
  const env = baseEnv(fakeDb());
  const good = await verifyToken(await makeToken({}), env);
  assert(good && good.userId === 1 && good.username === "alice" && good.role === "editor", "valid token → claims");

  assert((await verifyToken(await makeToken({ issuer: "someone-else" }), env)) === null, "wrong issuer rejected");
  assert((await verifyToken(await makeToken({ key: OTHER_KEY }), env)) === null, "wrong signing key rejected");
  assert((await verifyToken(await makeToken({ expiresIn: -60 }), env)) === null, "expired token rejected");
  assert((await verifyToken("not.a.jwt", env)) === null, "garbage rejected");
  assert((await verifyToken(await makeToken({ sub: "abc" }), env)) === null, "non-numeric sub rejected");

  const weirdRole = await verifyToken(await makeToken({ role: "superadmin" }), env);
  assert(weirdRole && weirdRole.role === undefined, "unknown role claim → role undefined, not trusted");

  const noKeyEnv = { ...env, JWT_SIGNING_KEY: undefined };
  assert((await verifyToken(await makeToken({}), noKeyEnv)) === null, "missing signing key → fail closed");
}

// ── middleware chain ────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.get("/open", (c) => c.json({ ok: true }));
  app.post("/write", (c) => c.json({ ok: true }));
  app.get("/authed", requireAuth, (c) => c.json({ ok: true }));
  app.get("/editor-only", requireEditor, (c) => c.json({ ok: true }));
  app.get("/admin-only", requireAdmin, (c) => c.json({ ok: true }));
  app.post("/api/auth/refresh", refreshToken);
  app.get("/api/auth/me", authMe);
  app.put("/loc", requireAuth, updateLastLocation);
  return app;
}

console.log("[requireCsrf] double-submit on writes; reads and exempt paths pass");
{
  const app = buildApp();
  const env = baseEnv(fakeDb());

  assert((await app.request("/open", {}, env)).status === 200, "GET needs no CSRF");
  assert((await app.request("/write", { method: "POST" }, env)).status === 403, "POST without CSRF → 403");

  const mismatch = await app.request(
    "/write",
    { method: "POST", headers: { cookie: "be_csrf=aaa", "x-csrf-token": "bbb" } },
    env,
  );
  assert(mismatch.status === 403, "cookie/header mismatch → 403");

  const okRes = await app.request(
    "/write",
    { method: "POST", headers: { cookie: "be_csrf=tok123", "x-csrf-token": "tok123" } },
    env,
  );
  assert(okRes.status === 200, "matching cookie+header passes");

  const headerOnly = await app.request(
    "/write",
    { method: "POST", headers: { "x-csrf-token": "tok123" } },
    env,
  );
  assert(headerOnly.status === 403, "header without cookie → 403");

  // Exempt path: refresh must reach the handler (401 for missing session
  // cookie), NOT die at the CSRF gate (403).
  const refresh = await app.request("/api/auth/refresh", { method: "POST" }, env);
  assert(refresh.status === 401, "refresh is CSRF-exempt (401 from handler, not 403)");
}

console.log("[attachAuth + role gates] cookie-only auth, role escalation blocked");
{
  const app = buildApp();
  const env = baseEnv(fakeDb());
  const editorTok = await makeToken({ role: "editor" });
  const viewerTok = await makeToken({ role: "viewer", sub: "2", username: "vera" });
  const adminTok = await makeToken({ role: "admin", sub: "3", username: "ada" });

  assert((await app.request("/authed", {}, env)).status === 401, "no token → 401");
  assert(
    (await app.request("/authed", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 200,
    "access cookie accepted",
  );
  // The Authorization: Bearer fallback was removed (cookie-only auth); a valid
  // JWT presented only as a bearer header must no longer authenticate.
  assert(
    (await app.request("/authed", { headers: { authorization: `Bearer ${editorTok}` } }, env)).status === 401,
    "bearer header no longer accepted (cookie-only)",
  );
  assert(
    (await app.request("/authed", { headers: { cookie: "be_access=tampered.jwt.value" } }, env)).status === 401,
    "tampered cookie token → 401",
  );

  assert(
    (await app.request("/editor-only", { headers: { cookie: `be_access=${viewerTok}` } }, env)).status === 403,
    "viewer blocked from editor route",
  );
  assert(
    (await app.request("/editor-only", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 200,
    "editor passes editor route",
  );
  assert(
    (await app.request("/admin-only", { headers: { cookie: `be_access=${editorTok}` } }, env)).status === 403,
    "editor blocked from admin route",
  );
  assert(
    (await app.request("/admin-only", { headers: { cookie: `be_access=${adminTok}` } }, env)).status === 200,
    "admin passes admin route",
  );
}

// ── refreshToken: the session row IS the revocation gate ───────────────────

console.log("[refreshToken] session-row gating: missing, revoked, expired, healthy");
{
  // Stub the network: the de-allowlisted case falls through to the DCS
  // org-membership check (isViewerOrgMember), which must not hit the real
  // git.door43.org from a test — and must deny when the lookup fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });

  const app = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const session = (over = {}) => ({
    id: "sess1",
    user_id: 7,
    expires_at: now + 1000,
    revoked_at: null,
    dcs_username: "alice",
    ...over,
  });

  const runCase = async (sessionRow, roleRow) => {
    const db = fakeDb(({ sql }) => {
      if (sql.includes("FROM sessions")) return sessionRow;
      if (sql.includes("FROM user_roles")) return roleRow;
      return null;
    });
    return app.request(
      "/api/auth/refresh",
      { method: "POST", headers: { cookie: "be_refresh=sess1" } },
      baseEnv(db),
    );
  };

  assert((await runCase(null, null)).status === 401, "unknown session id → 401");
  assert((await runCase(session({ revoked_at: now - 5 }), { role: "editor" })).status === 401, "revoked session → 401");
  assert((await runCase(session({ expires_at: now - 5 }), { role: "editor" })).status === 401, "expired session → 401");

  // De-allowlisted user: session is healthy but the role row is gone and the
  // org-membership fallback fails (DCS_BASE_URL fetch will error in tests —
  // isViewerOrgMember catches and denies). Must be 403, not a fresh token.
  const dropped = await runCase(session(), null);
  assert(dropped.status === 403, "healthy session but de-allowlisted user → 403");

  const healthy = await runCase(session(), { role: "editor" });
  assert(healthy.status === 200, "healthy session + allowlisted role → 200");
  const setCookie = healthy.headers.get("set-cookie") ?? "";
  assert(/be_access=/.test(setCookie), "healthy refresh rotates the access cookie");
  assert(/HttpOnly/i.test(setCookie), "rotated access cookie stays HttpOnly");
  const body = await healthy.json();
  assert(body.ok === true && body.role === "editor", "refresh reports the re-checked role");

  // Org-member fallback: no user_roles row, but DCS says the user is in the
  // viewer org → refresh succeeds with the viewer role.
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ username: "unfoldingWord" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const viewer = await runCase(session(), null);
  assert(viewer.status === 200, "org member without role row → 200");
  assert((await viewer.json()).role === "viewer", "org membership grants exactly viewer");

  globalThis.fetch = realFetch;
}

// ── refreshToken → maybeResyncTeamRole: token must be read from SHARED_DB in
// a non-default workspace, not the per-org `users` mirror ──────────────────
//
// Regression for the bug where the resync's single `LEFT JOIN` ran entirely
// inside `env.DB` (the per-org database). ensureWorkspaceUser deliberately
// mirrors a user's `users` row into every per-org DB WITHOUT its
// `dcs_access_token` (that column is shared-DB-only — see auth.ts's comment
// on ensureWorkspaceUser). So in any non-default workspace, the old join
// always saw token = NULL and returned early: the re-check was silently
// disabled there, and a user removed from their Door43 team kept renewing an
// editor/admin session for the whole 14-day refresh window. The fix splits
// it into two statements — `synced_at` from env.DB's `user_roles`, then
// `dcs_access_token` from sharedDb(env)'s `users` — so the resync actually
// fires. Uses real node:sqlite for both DB and SHARED_DB (same adapter shape
// as the ensureWorkspaceUser and effectiveRole tests above) because the bug
// is about which DATABASE a column lives in, which a single string-matching
// fake can't distinguish.
//
// Driven through refreshToken (the actual caller), not by exporting
// maybeResyncTeamRole — per the task's instruction not to export it just to
// test it.

console.log("[refreshToken → maybeResyncTeamRole] re-check reads the OAuth token from SHARED_DB, not the per-org mirror");
{
  function sqliteD1(db) {
    function bound(sql, args) {
      return {
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        all: async () => ({ results: db.prepare(sql).all(...args) }),
      };
    }
    return {
      prepare(sql) {
        return { bind: (...args) => bound(sql, args), ...bound(sql, []) };
      },
    };
  }

  // Per-org DB: user_roles (real schema, so source/synced_at semantics are
  // real) plus a `users` row mirrored EXACTLY the way ensureWorkspaceUser
  // produces it — same id, profile fields copied, token left NULL.
  function makeOrgDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE user_roles (
        dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        added_by INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        synced_at INTEGER,
        manual_role TEXT
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        dcs_user_id INTEGER UNIQUE,
        dcs_username TEXT,
        dcs_full_name TEXT,
        dcs_access_token TEXT
      );
    `);
    return db;
  }

  // Shared DB: the canonical `users` row (WITH the token) plus `sessions`,
  // which is what refreshToken's own session lookup reads via sharedDb().
  function makeSharedDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        dcs_user_id INTEGER UNIQUE,
        dcs_username TEXT,
        dcs_full_name TEXT,
        dcs_access_token TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_seen_at INTEGER
      );
    `);
    return db;
  }

  const now = Math.floor(Date.now() / 1000);

  // WORKSPACES makes orgForTeamSync resolve 'org2' straight from the
  // registry (its documented fast path) instead of needing a project_config
  // row in env.DB — isolates the test to the token-lookup bug only.
  const WORKSPACE_ENTRY = { slug: "org2", label: "Org Two", org: "org2", binding: "DB" };

  function buildEnv(syncedAt) {
    const orgRaw = makeOrgDb();
    orgRaw
      .prepare(
        `INSERT INTO user_roles (dcs_username, role, source, synced_at) VALUES ('alice', 'editor', 'dcs_team', ?)`,
      )
      .run(syncedAt);
    orgRaw
      .prepare(
        `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_full_name, dcs_access_token)
         VALUES (7, 100, 'alice', 'Alice A', NULL)`,
      )
      .run();

    const sharedRaw = makeSharedDb();
    sharedRaw
      .prepare(
        `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_full_name, dcs_access_token)
         VALUES (7, 100, 'alice', 'Alice A', 'real-dcs-token')`,
      )
      .run();
    sharedRaw
      .prepare(`INSERT INTO sessions (id, user_id, expires_at, revoked_at) VALUES ('sess1', 7, ?, NULL)`)
      .run(now + 1000);

    return {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: sqliteD1(orgRaw),
      SHARED_DB: sqliteD1(sharedRaw),
      WORKSPACES: JSON.stringify([WORKSPACE_ENTRY]),
      WORKSPACE_SLUG: "org2",
    };
  }

  const app = buildApp();
  const realFetch = globalThis.fetch;
  let teamsFetchCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/v1/user/teams")) {
      teamsFetchCalled = true;
      return new Response(
        JSON.stringify([{ name: "BE-Editors", organization: { username: "org2" } }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    // Stale synced_at (older than RESYNC_AFTER_SECONDS) → the resync fires,
    // and with the fix, the token resolves from SHARED_DB so the DCS call
    // actually happens.
    teamsFetchCalled = false;
    const staleRes = await app.request(
      "/api/auth/refresh",
      { method: "POST", headers: { cookie: "be_refresh=sess1" } },
      buildEnv(now - RESYNC_AFTER_SECONDS - 10),
    );
    assert(staleRes.status === 200, "refresh succeeds for a stale team role in a non-default workspace");
    assert(teamsFetchCalled === true, "stale synced_at → /user/teams WAS called (token found via SHARED_DB)");

    // Fresh synced_at (within the window) → maybeResyncTeamRole returns
    // before ever touching the token, regardless of which DB it'd read from.
    teamsFetchCalled = false;
    const freshRes = await app.request(
      "/api/auth/refresh",
      { method: "POST", headers: { cookie: "be_refresh=sess1" } },
      buildEnv(now - 10),
    );
    assert(freshRes.status === 200, "refresh succeeds for a freshly-synced team role");
    assert(teamsFetchCalled === false, "fresh synced_at → /user/teams NOT called (within RESYNC_AFTER_SECONDS)");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── access token bound to its workspace (#680) ──────────────────────────────
// The workspace comes from the be_ws cookie, which the server never checks
// against the token. A token minted for workspace A must not carry A's role
// into a request that resolved to workspace B: it counts as no sign-in there
// (401), so the browser's silent refresh re-derives the role for B.

console.log("[attachAuth] access token only authenticates in the workspace it was minted for (#680)");
{
  const app = buildApp();
  const linkApp = new Hono();
  linkApp.use("*", attachAuth);
  linkApp.use("*", requireCsrf);
  linkApp.route("/api/chat-links", chatLinkRoutes);
  const envA = { ...baseEnv(fakeDb()), WORKSPACE_SLUG: "a" };
  const envB = { ...baseEnv(fakeDb()), WORKSPACE_SLUG: "b" };
  const editorA = await makeToken({ role: "editor", ws: "a" });
  const claimless = await makeToken({ role: "editor", ws: null });
  const req = (path, tok, env) => app.request(path, { headers: { cookie: `be_access=${tok}` } }, env);

  assert((await req("/editor-only", editorA, envA)).status === 200, "editor token for A passes the editor gate in A");
  assert((await req("/editor-only", editorA, envB)).status === 401, "editor token for A gets 401 in B (no role carried over)");
  assert((await req("/authed", editorA, envB)).status === 401, "token for A is not a sign-in in B at all");
  assert((await req("/api/auth/me", editorA, envB)).status === 401, "/me in B with A's token → 401, so the client refreshes");
  assert((await req("/editor-only", claimless, envA)).status === 401, "claim-less (pre-#680) token → 401, fail closed");
  assert((await verifyToken(editorA, envA))?.workspace === "a", "verifyToken exposes the workspace claim");

  const csrf = { cookie: `be_access=${editorA}; be_csrf=t1`, "x-csrf-token": "t1" };
  const linkB = await linkApp.request("/api/chat-links/code", { method: "POST", headers: csrf }, envB);
  assert(linkB.status === 401, "chat link code cannot be issued in B with A's token");
  const linkA = await linkApp.request("/api/chat-links/code", { method: "POST", headers: csrf }, envA);
  assert(linkA.status === 200 && (await linkA.json()).workspace === "a", "chat link code still issues in A");
}

console.log("[refreshToken] mints for the request's workspace and re-derives the role there (#680)");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });
  const app = buildApp();
  const now = Math.floor(Date.now() / 1000);
  const sessionRow = { id: "sess1", user_id: 7, expires_at: now + 1000, revoked_at: null, dcs_username: "alice" };
  // alice is an editor in A and a viewer in B (user_roles is per-org).
  const envFor = (slug, role) => ({
    ...baseEnv(
      fakeDb(({ sql }) => {
        if (sql.includes("FROM sessions")) return sessionRow;
        if (sql.includes("FROM user_roles")) return role ? { role } : null;
        return null;
      }),
    ),
    WORKSPACE_SLUG: slug,
  });
  const refreshIn = (env) =>
    app.request("/api/auth/refresh", { method: "POST", headers: { cookie: "be_refresh=sess1" } }, env);
  const accessFrom = (res) => /be_access=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  const resB = await refreshIn(envFor("b", "viewer"));
  assert(resB.status === 200, "refresh in B succeeds");
  const tokB = accessFrom(resB);
  const claimsB = tokB ? decodeJwt(tokB) : {};
  assert(claimsB.ws === "b", "refreshed token is bound to B");
  assert(claimsB.role === "viewer", "refreshed token carries B's role, not A's");
  const envB = envFor("b", "viewer");
  const withTok = { headers: { cookie: `be_access=${tokB}` } };
  assert((await app.request("/authed", withTok, envB)).status === 200, "refreshed token authenticates in B");
  assert((await app.request("/editor-only", withTok, envB)).status === 403, "and is only a viewer there");
  assert(
    (await app.request("/authed", withTok, envFor("a", "editor"))).status === 401,
    "B's refreshed token does not authenticate in A",
  );

  // No role in B and not a viewer-org member: refresh denies rather than minting.
  assert((await refreshIn(envFor("b", null))).status === 403, "refresh in B with no access there → 403");
  globalThis.fetch = realFetch;
}

// ── updateLastLocation input validation ─────────────────────────────────────

console.log("[updateLastLocation] strict shape check before the DB write");
{
  const app = buildApp();
  const writes = [];
  const db = fakeDb(({ sql, args, op }) => {
    if (op === "run" && sql.includes("UPDATE users")) writes.push(args);
    return null;
  });
  const env = baseEnv(db);
  const tok = await makeToken({});
  const put = (body) =>
    app.request(
      "/loc",
      {
        method: "PUT",
        headers: {
          cookie: `be_access=${tok}; be_csrf=t`,
          "x-csrf-token": "t",
          "content-type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );

  assert((await put("{not json")).status === 400, "malformed JSON → 400");
  assert((await put({ book: "way-too-long", chapter: 1, verse: 1 })).status === 400, "non-slug book → 400");
  assert((await put({ book: "GEN", chapter: -1, verse: 1 })).status === 400, "negative chapter → 400");
  assert((await put({ book: "GEN", chapter: 1.5, verse: 1 })).status === 400, "fractional chapter → 400");
  assert((await put({ book: "GEN", chapter: 1 })).status === 400, "missing verse → 400");
  assert(writes.length === 0, "no DB write happened for any rejected body");

  const ok = await put({ book: "gen", chapter: 1, verse: 3 });
  assert(ok.status === 200, "valid location accepted");
  assert(writes.length === 1 && writes[0][0] === "GEN", "book uppercased on write");
}

// ── authMe ──────────────────────────────────────────────────────────────────

console.log("[authMe] identity echo, 401 without a token");
{
  const app = buildApp();
  const db = fakeDb(({ sql }) =>
    sql.includes("FROM users") ? { last_book: "ZEC", last_chapter: 4, last_verse: 6 } : null,
  );
  const env = baseEnv(db);

  assert((await app.request("/api/auth/me", {}, env)).status === 401, "anonymous /me → 401");

  const res = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({})}` } },
    env,
  );
  assert(res.status === 200, "authed /me → 200");
  const body = await res.json();
  assert(
    body.userId === 1 && body.username === "alice" && body.role === "editor" && body.lastBook === "ZEC",
    "/me echoes claims + stored location",
  );
  assert(body.superAdmin === false, "/me superAdmin false when username not in SUPER_ADMINS");

  const adminEnv = { ...env, SUPER_ADMINS: "alice,bob" };
  const adminRes = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({})}` } },
    adminEnv,
  );
  assert(adminRes.status === 200, "authed /me with SUPER_ADMINS -> 200");
  const adminBody = await adminRes.json();
  assert(adminBody.superAdmin === true, "/me superAdmin true when username is allowlisted");

  const otherRes = await app.request(
    "/api/auth/me",
    { headers: { cookie: `be_access=${await makeToken({ username: "carol" })}` } },
    adminEnv,
  );
  assert((await otherRes.json()).superAdmin === false, "/me superAdmin false for non-allowlisted username");

}

// ── ensureWorkspaceUser: mirrors the shared user row into a workspace's
// local `users` table (real node:sqlite, two separate databases) so per-org
// FKs — tn_rows.updated_by, edit_log.user_id, etc. — resolve after a switch.

console.log("[ensureWorkspaceUser] mirrors id+profile (never the token), repeat call is a no-op, skipped when shared===local");
{
  // Real D1 adapter over node:sqlite (same shape as workspaceRoutes.test.mjs).
  function sqliteD1(db) {
    function bound(sql, args) {
      return {
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        all: async () => ({ results: db.prepare(sql).all(...args) }),
      };
    }
    return {
      prepare(sql) {
        return { bind: (...args) => bound(sql, args), ...bound(sql, []) };
      },
    };
  }

  function usersDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        dcs_user_id INTEGER UNIQUE,
        dcs_username TEXT,
        dcs_full_name TEXT,
        dcs_access_token TEXT
      );
    `);
    return db;
  }

  // Shared DB holds user id 1 (with a token that must never leak into a
  // per-org DB); the workspace DB starts empty.
  const sharedRaw = usersDb();
  sharedRaw
    .prepare(
      `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_full_name, dcs_access_token)
       VALUES (1, 100, 'alice', 'Alice A', 'secret-token')`,
    )
    .run();
  const workspaceRaw = usersDb();
  const env = {
    SHARED_DB: sqliteD1(sharedRaw),
    DB: sqliteD1(workspaceRaw),
    WORKSPACE_SLUG: "org2",
  };

  await ensureWorkspaceUser(env, 1);
  const mirrored = workspaceRaw.prepare(`SELECT * FROM users WHERE id = 1`).get();
  assert(!!mirrored, "local users row created with the same id");
  assert(mirrored.dcs_username === "alice" && mirrored.dcs_full_name === "Alice A", "profile fields mirrored");
  assert(mirrored.dcs_access_token === null, "dcs_access_token is never copied into the per-org DB");

  // Second call: no-op. Change the shared row first so a non-no-op second
  // call would be observable.
  sharedRaw.prepare(`UPDATE users SET dcs_username = 'alice2' WHERE id = 1`).run();
  await ensureWorkspaceUser(env, 1);
  const mirroredAgain = workspaceRaw.prepare(`SELECT * FROM users WHERE id = 1`).get();
  assert(mirroredAgain.dcs_username === "alice", "second call is a no-op — local row left as-is");

  // SHARED_DB === DB (the default/single-workspace case): skipped entirely.
  const soloRaw = usersDb();
  soloRaw.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username) VALUES (1, 200, 'solo')`).run();
  const solo = sqliteD1(soloRaw);
  const soloEnv = { SHARED_DB: solo, DB: solo, WORKSPACE_SLUG: "default" };
  await ensureWorkspaceUser(soloEnv, 1); // must not throw, must not touch the row
  const soloCount = soloRaw.prepare(`SELECT COUNT(*) as n FROM users`).get().n;
  assert(soloCount === 1, "shared === workspace DB -> no-op (no duplicate row, no extra work)");
}

// ── Super-admin invariants ───────────────────────────────────────────────────
//
// The project owner's explicit requirement: he must be able to (a) act as
// admin of ANY org, including one he's never joined on Door43, and (b) help
// orgs bootstrap without joining every one. effectiveRole's SUPER_ADMINS
// short-circuit is what makes both possible; lookupUserRole is the raw
// user_roles read that adminUserRoutes.ts's last-admin guard depends on, and
// must stay meaningful (i.e. NOT be affected by SUPER_ADMINS) or that guard's
// semantics silently change.
//
// Real node:sqlite (same user_roles shape as dcsTeams.test.mjs's freshDb) so
// syncTeamRole's real SQL runs, not a string-matched stub.

console.log("[effectiveRole / lookupUserRole] super-admin invariants");
{
  function rolesDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE user_roles (
        dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        added_by INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        synced_at INTEGER,
        manual_role TEXT
      );
    `);
    return db;
  }
  function sqliteD1(db) {
    function bound(sql, args) {
      return {
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => {
          const r = db.prepare(sql).run(...args);
          return { meta: { changes: Number(r.changes) } };
        },
        all: async () => ({ results: db.prepare(sql).all(...args) }),
      };
    }
    return {
      prepare(sql) {
        return { bind: (...args) => bound(sql, args), ...bound(sql, []) };
      },
    };
  }

  const db = rolesDb();
  const env = { DB: sqliteD1(db), SUPER_ADMINS: "ada" };

  assert(
    (await lookupUserRole(env, "ada")) === null,
    "lookupUserRole: no row for the super admin -> null (raw read, unaffected by SUPER_ADMINS)",
  );
  assert(
    (await effectiveRole(env, "ada")) === "admin",
    "effectiveRole: super admin with NO user_roles row at all -> 'admin'",
  );

  // Team sync finds them on no team (role: null — the same shape as the real
  // "no team role" call in auth.ts's syncTeamRoleForUser). Must not demote.
  await syncTeamRole(env, "ada", null);
  assert(
    (await effectiveRole(env, "ada")) === "admin",
    "effectiveRole: still 'admin' after a team sync that found the super admin on no team",
  );
  assert(
    (await lookupUserRole(env, "ada")) === null,
    "lookupUserRole: still null after that sync — the raw row was never created for this super admin",
  );

  // A non-super-admin's raw row is read normally either way.
  db.prepare(
    `INSERT INTO user_roles (dcs_username, role, source) VALUES ('bob', 'editor', 'manual')`,
  ).run();
  assert(
    (await lookupUserRole(env, "bob")) === "editor",
    "lookupUserRole: reflects the actual row for a non-super-admin",
  );
  assert(
    (await effectiveRole(env, "bob")) === "editor",
    "effectiveRole: non-super-admin resolves via the raw row",
  );
}

console.log("auth: all assertions passed");
