// Unit tests for workspaceRoutes.ts — the GET/POST /api/workspaces switcher
// API. Real D1 via node:sqlite (same shape as adminUsers.test.mjs), a real
// Hono app wired the way index.ts wires it (attachAuth -> requireCsrf), and a
// stubbed globalThis.fetch for the DCS /user/orgs membership check.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceRoutes.test.mjs

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { attachAuth, requireCsrf, isSuperAdmin } from "./auth.ts";
import { workspaceRoutes } from "./workspaceRoutes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const SIGNING = "test-signing-key-that-is-at-least-32-bytes-long";
const KEY = new TextEncoder().encode(SIGNING);
const ISSUER = "bible-editor";

// ── D1 adapter over node:sqlite (same shape as adminUsers.test.mjs) ─────────

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER UNIQUE,
      dcs_username TEXT,
      dcs_access_token TEXT
    );
  `);
  return db;
}

function makeD1(db) {
  function bound(sql, params) {
    return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    prepare(sql) {
      return { bind: (...params) => bound(sql, params), ...bound(sql, []) };
    },
  };
}

function seedUser(db, { id, username, token = null }) {
  db.prepare(
    `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_access_token) VALUES (?, ?, ?, ?)`,
  ).run(id, id, username, token);
  return db;
}

// Two workspaces: "uw" (org unfoldingWord, the "current" one for these
// tests) and "org2" (org OrgTwo). Both point at the same underlying sqlite
// db (these routes never touch DB/SHARED_DB content directly, only users).
function baseEnv(db, overrides = {}) {
  const d1 = makeD1(db);
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DB: d1,
    DB2: d1,
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
    ]),
    WORKSPACE_SLUG: "uw",
    SUPER_ADMINS: "",
    ...overrides,
  };
}

async function makeToken({ sub = "1", role = "editor", username = "alice" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role, ws: "uw" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.route("/api/workspaces", workspaceRoutes);
  return app;
}

function jsonRes(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// DCS list fetches paginate until an EMPTY page (fetchPagedList in
// dcsTeams.ts), so a stub must serve its body on page 1 and [] afterwards —
// returning the same non-empty body forever would read as "truncated at the
// page cap" (null / membership unknown).
function firstPageOnly(url, body) {
  return new URL(String(url)).searchParams.get("page") === "1" ? body : [];
}

function req(app, env, method, path, { token, body, skipCsrf } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET" && !skipCsrf) {
    cookies.push("be_csrf=tok123");
    headers["x-csrf-token"] = "tok123";
  }
  if (cookies.length) headers.cookie = cookies.join("; ");
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, env);
}

// ── unauthenticated ──────────────────────────────────────────────────────────

console.log("[auth gating] GET/POST require an authenticated user");
{
  const app = buildApp();
  const env = baseEnv(freshDb());
  assert((await req(app, env, "GET", "/api/workspaces")).status === 401, "GET no cookie -> 401");
  assert((await req(app, env, "POST", "/api/workspaces/org2")).status === 401, "POST no cookie -> 401");
}

// ── super-admin sees every workspace allowed, no DCS call needed ───────────

console.log("[GET] super-admin: every workspace allowed, DCS never called");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("DCS should not be called for a super-admin");
  };
  try {
    const db = freshDb();
    seedUser(db, { id: 1, username: "ada" });
    const app = buildApp();
    const env = baseEnv(db, { SUPER_ADMINS: "Ada, someone-else" });
    const tok = await makeToken({ sub: "1", username: "ada" });
    const res = await req(app, env, "GET", "/api/workspaces", { token: tok });
    assert(res.status === 200, "super-admin GET -> 200");
    const body = await res.json();
    assert(body.current === "uw", "current workspace echoed from WORKSPACE_SLUG");
    assert(body.workspaces.length === 2, "both workspaces listed");
    assert(body.workspaces.every((w) => w.allowed === true), "super-admin: every workspace allowed=true");
    assert(body.membershipUnknown === undefined, "super-admin response has no membershipUnknown flag");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── membership filtering from a stubbed /api/v1/user/orgs ──────────────────

console.log("[GET] non-super-admin: non-member orgs are OMITTED (not disabled), names never leaked (issue #93)");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 2, username: "bob", token: "bob-dcs-token" });
    globalThis.fetch = async (url, init) => {
      assert(String(url).includes("/api/v1/user/orgs"), "membership check hits /api/v1/user/orgs");
      assert(init.headers.Authorization === "token bob-dcs-token", "membership check uses the user's stored access token");
      return jsonRes(firstPageOnly(url, [{ username: "unfoldingWord" }]));
    };
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "2", username: "bob" });
    const res = await req(app, env, "GET", "/api/workspaces", { token: tok });
    assert(res.status === 200, "member GET -> 200");
    const body = await res.json();
    const uw = body.workspaces.find((w) => w.slug === "uw");
    const org2 = body.workspaces.find((w) => w.slug === "org2");
    assert(uw && uw.allowed === true, "member of unfoldingWord -> uw present + allowed");
    assert(org2 === undefined, "not a member of OrgTwo -> org2 OMITTED from the list entirely");
    assert(
      !JSON.stringify(body).includes("OrgTwo") && !JSON.stringify(body).includes("Org Two"),
      "non-member org's name/label never appears anywhere in the response",
    );
    assert(body.workspaces.length === 1, "only the one allowed workspace is surfaced");
    assert(body.membershipUnknown === undefined, "successful lookup has no membershipUnknown flag");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── role-row grant surfaces an outsider's workspace even without org membership ─

console.log("[GET] non-super-admin: a user_roles grant surfaces a workspace whose org the user isn't in");
{
  const realFetch = globalThis.fetch;
  try {
    // org2's DB has a role row for the user; uw's does not. The user is a DCS
    // member of neither org; uw is merely their (cookie-derived) current
    // workspace. Membership IS known here (empty set), so uw must NOT be
    // surfaced — a forged/stale be_ws naming a non-member org can't leak that
    // org's name (issue #93). Only the role-granted org2 shows.
    const dbUw = freshDb();
    seedUser(dbUw, { id: 22, username: "grace", token: "grace-token" });
    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT COLLATE NOCASE, role TEXT);`);
    dbOrg2.exec(`INSERT INTO user_roles (dcs_username, role) VALUES ('grace', 'editor');`);
    globalThis.fetch = async (url) => jsonRes(firstPageOnly(url, [])); // member of no orgs
    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "",
    };
    const tok = await makeToken({ sub: "22", username: "grace" });
    const res = await req(app, env, "GET", "/api/workspaces", { token: tok });
    assert(res.status === 200, "role-grant GET -> 200");
    const body = await res.json();
    const slugs = body.workspaces.map((w) => w.slug).sort();
    assert(slugs.length === 1 && slugs[0] === "org2", "known non-member: only role-granted org2 surfaced; cookie-current uw omitted");
    assert(!body.workspaces.some((w) => w.slug === "uw"), "known non-member: current (uw) name not leaked");
    assert(body.workspaces.every((w) => w.allowed === true), "every surfaced entry is allowed");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── failed membership lookup: fail closed to current-only, never stranded ──

console.log("[GET] failed/absent membership lookup -> only current workspace surfaced + membershipUnknown");
{
  const realFetch = globalThis.fetch;
  try {
    // Case 1: no stored access token at all.
    const dbNoToken = freshDb();
    seedUser(dbNoToken, { id: 3, username: "carol", token: null });
    globalThis.fetch = async () => {
      throw new Error("should not be called when there is no access token");
    };
    const app = buildApp();
    const envNoToken = baseEnv(dbNoToken);
    const tokNoToken = await makeToken({ sub: "3", username: "carol" });
    const resNoToken = await req(app, envNoToken, "GET", "/api/workspaces", { token: tokNoToken });
    assert(resNoToken.status === 200, "no access token -> still 200 (never strand the user)");
    const bodyNoToken = await resNoToken.json();
    assert(bodyNoToken.membershipUnknown === true, "no access token -> membershipUnknown:true");
    const uwNoToken = bodyNoToken.workspaces.find((w) => w.slug === "uw");
    assert(uwNoToken && uwNoToken.allowed === true, "no access token -> current workspace (uw) still present + allowed");
    assert(
      bodyNoToken.workspaces.find((w) => w.slug === "org2") === undefined,
      "no access token -> non-current workspace OMITTED (name not leaked)",
    );
    assert(bodyNoToken.workspaces.length === 1, "no access token -> only current workspace surfaced");

    // Case 2: access token present but the DCS call fails.
    const dbFailedFetch = freshDb();
    seedUser(dbFailedFetch, { id: 4, username: "dave", token: "dave-token" });
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const envFailedFetch = baseEnv(dbFailedFetch);
    const tokFailedFetch = await makeToken({ sub: "4", username: "dave" });
    const resFailedFetch = await req(app, envFailedFetch, "GET", "/api/workspaces", { token: tokFailedFetch });
    assert(resFailedFetch.status === 200, "DCS fetch throws -> still 200");
    const bodyFailedFetch = await resFailedFetch.json();
    assert(bodyFailedFetch.membershipUnknown === true, "DCS fetch throws -> membershipUnknown:true");
    const uwFailed = bodyFailedFetch.workspaces.find((w) => w.slug === "uw");
    assert(uwFailed && uwFailed.allowed === true, "DCS fetch throws -> current workspace still present + allowed");
    assert(
      bodyFailedFetch.workspaces.find((w) => w.slug === "org2") === undefined,
      "DCS fetch throws -> non-current workspace OMITTED",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── POST /api/workspaces/:slug ──────────────────────────────────────────────

console.log("[POST] unknown slug -> 404 unknown_workspace");
{
  const app = buildApp();
  const db = freshDb();
  seedUser(db, { id: 5, username: "erin" });
  const env = baseEnv(db, { SUPER_ADMINS: "erin" });
  const tok = await makeToken({ sub: "5", username: "erin" });
  const res = await req(app, env, "POST", "/api/workspaces/nonexistent", { token: tok });
  assert(res.status === 404, "unknown slug -> 404");
  assert((await res.json()).error === "unknown_workspace", "404 body is unknown_workspace");
}

console.log("[POST] disallowed workspace -> 403 workspace_forbidden");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 6, username: "frank", token: "frank-token" });
    globalThis.fetch = async (url) => jsonRes(firstPageOnly(url, [{ username: "unfoldingWord" }]));
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "6", username: "frank" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 403, "not a member of org2's org -> 403");
    assert((await res.json()).error === "workspace_forbidden", "403 body is workspace_forbidden");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST] allowed workspace -> 200 + Set-Cookie carrying the slug");
{
  const realFetch = globalThis.fetch;
  try {
    const db = freshDb();
    seedUser(db, { id: 7, username: "gina", token: "gina-token" });
    globalThis.fetch = async (url) => jsonRes(firstPageOnly(url, [{ username: "OrgTwo" }]));
    const app = buildApp();
    const env = baseEnv(db);
    const tok = await makeToken({ sub: "7", username: "gina" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "member of org2's org -> 200");
    const body = await res.json();
    assert(body.ok === true && body.slug === "org2", "200 body echoes ok + slug");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(/be_ws=org2/.test(setCookie), "Set-Cookie carries the new slug");
    assert(/HttpOnly/i.test(setCookie), "workspace cookie is HttpOnly");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST] missing CSRF token -> 403 (same global gate as every other write)");
{
  const app = buildApp();
  const db = freshDb();
  seedUser(db, { id: 8, username: "henry" });
  const env = baseEnv(db, { SUPER_ADMINS: "henry" });
  const tok = await makeToken({ sub: "8", username: "henry" });
  const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok, skipCsrf: true });
  assert(res.status === 403, "POST without CSRF header/cookie -> 403");
  assert((await res.json()).error === "csrf_mismatch", "403 body is csrf_mismatch");
}

// ── BLOCKER 1 regression: role re-resolved against the TARGET workspace ────

console.log("[POST] switching workspace re-mints the access cookie's role from the TARGET workspace's DB");
{
  const realFetch = globalThis.fetch;
  try {
    // Two independent D1s: "uw" (binding DB) has the user as admin; "org2"
    // (binding DB2) has no user_roles row for them at all — a plain member.
    const dbUw = freshDb();
    dbUw.exec(`CREATE TABLE user_roles (dcs_username TEXT COLLATE NOCASE, role TEXT);`);
    dbUw.exec(`INSERT INTO user_roles (dcs_username, role) VALUES ('ivy', 'admin');`);
    seedUser(dbUw, { id: 9, username: "ivy", token: "ivy-token" });

    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT COLLATE NOCASE, role TEXT);`);
    // deliberately no user_roles row for ivy — she's never been granted a
    // role in org2, only a plain DCS member.

    globalThis.fetch = async (url) =>
      jsonRes(firstPageOnly(url, [{ username: "unfoldingWord" }, { username: "OrgTwo" }]));

    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "",
    };
    // The JWT itself carries role: admin (as minted while in "uw") — the
    // whole point of this test is that the re-mint must NOT trust this claim
    // for the target workspace.
    const tok = await makeToken({ sub: "9", role: "admin", username: "ivy" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "switch to org2 -> 200");

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    assert(
      setCookies.some((h) => /^be_ws=org2/.test(h)),
      "workspace cookie carries org2",
    );
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    assert(!!accessCookie, "a new be_access cookie was minted alongside the workspace cookie");

    const newToken = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(newToken, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(
      payload.role === "viewer",
      `re-minted token's role is 'viewer' (org2 has no role row for ivy), got ${payload.role}`,
    );
    assert(payload.role !== "admin", "re-minted token must NOT carry the stale org-A admin role");
    // #680: the token is bound to the TARGET workspace, not the one this
    // request resolved to (uw), or the first request after the switch 401s.
    assert(payload.ws === "org2", `re-minted token is bound to org2, got ${payload.ws}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── switch-time team resync: first entry into a workspace grants team role ──

console.log("[POST] switching runs a team-role sync against the TARGET workspace before re-minting");
{
  const realFetch = globalThis.fetch;
  try {
    // hana is a Door43 member of OrgTwo and on its BE-Editors team, but has
    // NO user_roles row in org2's database yet (first time entering it).
    // Without the switch-time resync she'd be re-minted as viewer until her
    // next full OAuth sign-in.
    const dbUw = freshDb();
    dbUw.exec(`CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY COLLATE NOCASE, role TEXT, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER, manual_role TEXT);`);
    seedUser(dbUw, { id: 11, username: "hana", token: "hana-token" });

    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY COLLATE NOCASE, role TEXT, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER, manual_role TEXT);`);

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/api/v1/user/orgs")) {
        return jsonRes(firstPageOnly(url, [{ username: "OrgTwo" }]));
      }
      if (u.includes("/api/v1/user/teams")) {
        return jsonRes(
          firstPageOnly(url, [{ name: "BE-Editors", organization: { username: "OrgTwo" } }]),
        );
      }
      throw new Error(`unexpected DCS call: ${u}`);
    };

    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "",
    };
    const tok = await makeToken({ sub: "11", role: "viewer", username: "hana" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "switch to org2 -> 200");

    const row = dbOrg2
      .prepare("SELECT role, source FROM user_roles WHERE dcs_username = 'hana'")
      .get();
    assert(
      !!row && row.role === "editor" && row.source === "dcs_team",
      "the TARGET workspace's user_roles now has hana's team-derived editor row",
    );
    const uwRow = dbUw
      .prepare("SELECT role FROM user_roles WHERE dcs_username = 'hana'")
      .get();
    assert(uwRow === undefined || uwRow === null, "the SOURCE workspace's user_roles was not written");

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    assert(!!accessCookie, "a new be_access cookie was minted");
    const newToken = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(newToken, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(
      payload.role === "editor",
      `re-minted token carries the freshly-synced editor role, got ${payload.role}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── FINDING 1 regression: a manual role row allows entry without org membership ──

console.log("[POST] a user_roles row in the TARGET workspace allows the switch — no Door43 org membership needed");
{
  const realFetch = globalThis.fetch;
  try {
    // mia is manually allowlisted in org2 but is NOT a Door43 member of
    // OrgTwo. The pure org-membership gate used to 403 her forever.
    const dbUw = freshDb();
    seedUser(dbUw, { id: 12, username: "mia", token: "mia-token" });

    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY COLLATE NOCASE, role TEXT, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER, manual_role TEXT);`);
    dbOrg2.exec(`INSERT INTO user_roles (dcs_username, role, source) VALUES ('mia','editor','manual');`);

    const dcsCalls = [];
    globalThis.fetch = async (url) => {
      dcsCalls.push(String(url));
      // She's in NO orgs and on NO teams — every list is empty.
      return jsonRes([]);
    };

    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "",
    };
    const tok = await makeToken({ sub: "12", role: "viewer", username: "mia" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "manual allowlist row in the target DB -> switch allowed (200)");
    assert(
      !dcsCalls.some((u) => u.includes("/user/orgs")),
      "the role-row check short-circuits the gate — no DCS org round-trip needed",
    );

    const row = dbOrg2
      .prepare("SELECT role, source FROM user_roles WHERE dcs_username = 'mia'")
      .get();
    assert(
      !!row && row.role === "editor" && row.source === "manual",
      "the no-team-signal sync leaves the manual row untouched (fallback grant survives)",
    );

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    const newToken = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(newToken, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(payload.role === "editor", `re-minted token carries her manual editor role, got ${payload.role}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── switch-time resync throttle: a fresh dcs_team row skips the DCS round-trip ──

console.log("[POST] a freshly-synced dcs_team row in the target workspace skips the switch-time DCS resync");
{
  const realFetch = globalThis.fetch;
  try {
    const dbUw = freshDb();
    seedUser(dbUw, { id: 13, username: "nick", token: "nick-token" });

    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT PRIMARY KEY COLLATE NOCASE, role TEXT, source TEXT NOT NULL DEFAULT 'manual', synced_at INTEGER, manual_role TEXT);`);
    dbOrg2.exec(`INSERT INTO user_roles (dcs_username, role, source, synced_at) VALUES ('nick','editor','dcs_team', unixepoch());`);

    let dcsCalled = false;
    globalThis.fetch = async () => {
      dcsCalled = true;
      return jsonRes([]);
    };

    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "",
    };
    const tok = await makeToken({ sub: "13", role: "viewer", username: "nick" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "switch with a fresh team row -> 200");
    assert(dcsCalled === false, "fresh synced_at (< RESYNC_AFTER_SECONDS) -> no DCS call at all");

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    const newToken = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(newToken, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(payload.role === "editor", "the cached team role is used for the re-mint");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── super admin bootstraps a brand-new workspace as admin ──────────────────

console.log("[POST] super-admin switching into a workspace with no user_roles row -> re-minted as admin");
{
  const realFetch = globalThis.fetch;
  try {
    // Fresh workspace: no user_roles row for the super admin at all — this
    // is the chicken-and-egg case (a just-created org's user_roles table
    // only has whatever migration 0016 seeds).
    const dbUw = freshDb();
    dbUw.exec(`CREATE TABLE user_roles (dcs_username TEXT COLLATE NOCASE, role TEXT);`);
    seedUser(dbUw, { id: 10, username: "kim", token: "kim-token" });

    const dbOrg2 = freshDb();
    dbOrg2.exec(`CREATE TABLE user_roles (dcs_username TEXT COLLATE NOCASE, role TEXT);`);
    // deliberately no user_roles row for kim in org2 either.

    globalThis.fetch = async () => {
      throw new Error("DCS should not be called for a super-admin");
    };

    const app = buildApp();
    const env = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DB: makeD1(dbUw),
      DB2: makeD1(dbOrg2),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
      WORKSPACE_SLUG: "uw",
      SUPER_ADMINS: "kim",
    };
    const tok = await makeToken({ sub: "10", role: "viewer", username: "kim" });
    const res = await req(app, env, "POST", "/api/workspaces/org2", { token: tok });
    assert(res.status === 200, "super-admin switch to org2 -> 200");

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    assert(!!accessCookie, "a new be_access cookie was minted alongside the workspace cookie");

    const newToken = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(newToken, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(
      payload.role === "admin",
      `super-admin with no user_roles row in the target workspace still comes out 'admin', got ${payload.role}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── isSuperAdmin parsing ─────────────────────────────────────────────────

console.log("[isSuperAdmin] parsing: empty, whitespace, case-insensitivity, non-listed user");
{
  assert(isSuperAdmin({ SUPER_ADMINS: "" }, "anyone") === false, "empty string -> nobody is super admin");
  assert(isSuperAdmin({ SUPER_ADMINS: "  Ada , bob  ,, carol " }, "ada") === true, "whitespace-padded entry matches");
  assert(isSuperAdmin({ SUPER_ADMINS: "Ada" }, "ADA") === true, "case-insensitive match");
  assert(isSuperAdmin({ SUPER_ADMINS: "Ada" }, "ada") === true, "case-insensitive match (lowercase input)");
  assert(isSuperAdmin({ SUPER_ADMINS: "Ada, bob" }, "dave") === false, "non-listed user -> false");
}

console.log("workspaceRoutes: all assertions passed");
