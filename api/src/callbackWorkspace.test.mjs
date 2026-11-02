// Integration regression for the OAuth callback's login-time workspace
// resolution (callbackDcsAuth in auth.ts), exercising the EXACT scenario the
// Codex review flagged: a manually-allowlisted user whose row lives in a
// NON-DEFAULT workspace, signing in for the FIRST time — no be_ws cookie, no
// last_workspace_slug history — and who is NOT a Door43 member of any org.
// Before the would-deny fan-out, resolution fell back to list[0], read the
// wrong database's user_roles, and redirected to the denied screen; first-time
// manual allowlists were unusable outside the default workspace.
//
// The whole callback runs for real: real Hono route, real (node:sqlite) D1s
// built from the real user_roles migrations, real index.ts-style env swap —
// only globalThis.fetch (DCS) is stubbed.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/callbackWorkspace.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { callbackDcsAuth } from "./auth.ts";
import { resolveWorkspace, workspaceEnv, parseWorkspaceCookie } from "./workspaces.ts";

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

// ── D1 adapter over node:sqlite (same shape as workspaceRoutes.test.mjs) ────

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

const MIGRATION_0016 = readFileSync(new URL("../migrations/0016_user_roles.sql", import.meta.url), "utf8");
const MIGRATION_0055 = readFileSync(new URL("../migrations/0055_user_roles_source.sql", import.meta.url), "utf8");
const MIGRATION_0057 = readFileSync(new URL("../migrations/0057_user_roles_manual_stash.sql", import.meta.url), "utf8");

// Shared/default-workspace database: users + sessions (shared-DB data) plus
// an EMPTY user_roles — the wrong-DB read the old code performed.
function sharedDbSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL,
      dcs_full_name TEXT,
      dcs_access_token TEXT,
      last_workspace_slug TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      csrf_token TEXT,
      expires_at INTEGER NOT NULL,
      user_agent TEXT,
      ip TEXT,
      last_seen_at INTEGER
    );
  `);
  db.exec(MIGRATION_0016);
  db.exec(MIGRATION_0055);
  db.exec(MIGRATION_0057);
  db.exec("DELETE FROM user_roles;");
  return db;
}

// Non-default workspace database: mirrored users table + user_roles holding
// mallory's manual editor grant.
function org2DbSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL,
      dcs_full_name TEXT
    );
  `);
  db.exec(MIGRATION_0016);
  db.exec(MIGRATION_0055);
  db.exec(MIGRATION_0057);
  db.exec("DELETE FROM user_roles;");
  db.exec("INSERT INTO user_roles (dcs_username, role, source) VALUES ('mallory', 'editor', 'manual');");
  return db;
}

console.log("[callback] first-time manual allowlistee in a NON-DEFAULT workspace, no cookie/history/org membership");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const org2Sql = org2DbSqlite();

    const baseEnv = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DCS_CLIENT_ID: "client-id",
      DCS_CLIENT_SECRET: "client-secret",
      DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
      DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
      SUPER_ADMINS: "",
      DB: makeD1(sharedSql),
      DB2: makeD1(org2Sql),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
    };

    // DCS stubs: token exchange succeeds, profile is mallory, and she is in
    // NO orgs and on NO teams (empty first pages).
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const json = (body) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/login/oauth/access_token")) {
        assert(init?.method === "POST", "token exchange is a POST");
        return json({ access_token: "mallory-token" });
      }
      if (u.includes("/api/v1/user/orgs")) return json([]);
      if (u.includes("/api/v1/user/teams")) return json([]);
      if (u.endsWith("/api/v1/user")) return json({ id: 42, login: "mallory", full_name: "Mallory" });
      throw new Error(`unexpected DCS call: ${u}`);
    };

    // Real route + the same env swap index.ts's fetch() wrapper performs: the
    // request has NO be_ws cookie, so the request env is pinned to list[0]
    // ("uw") — exactly the pre-conditions of the bug.
    const app = new Hono();
    app.get("/api/auth/dcs/callback", callbackDcsAuth);

    const state = "state123";
    const stateCookie = await new SignJWT({ state })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(KEY);

    const request = new Request(
      `https://editor.example.org/api/auth/dcs/callback?code=abc&state=${state}`,
      { headers: { cookie: `dcs_auth_state=${stateCookie}` } },
    );
    const ws = resolveWorkspace(baseEnv, parseWorkspaceCookie(request));
    assert(ws.slug === "uw", "precondition: no be_ws cookie pins the request env to list[0]");
    const res = await app.fetch(request, workspaceEnv(baseEnv, ws));

    assert(res.status === 302, `callback redirects (302), got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert(
      !location.includes("_auth_denied"),
      "NOT the denied redirect — the would-deny fan-out found her role row",
    );
    assert(location === "https://editor.example.org/", "single role row -> plain redirect, no picker prompt");

    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    assert(
      setCookies.some((h) => /^be_ws=org2/.test(h)),
      "be_ws cookie lands her in org2 — the workspace holding her allowlist row",
    );
    const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
    assert(!!accessCookie, "an access cookie was minted");
    const token = accessCookie.match(/^be_access=([^;]+)/)[1];
    const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"], issuer: ISSUER });
    assert(payload.role === "editor", `JWT carries her manual editor role, got ${payload.role}`);
    assert(payload.username === "mallory", "JWT is for mallory");
    // #680: bound to the workspace login resolved to (org2), not the request's
    // list[0] env (uw), or her first request after sign-in would 401.
    assert(payload.ws === "org2", `JWT is bound to org2, got ${payload.ws}`);

    const userRow = sharedSql
      .prepare("SELECT id, last_workspace_slug FROM users WHERE dcs_username = 'mallory'")
      .get();
    assert(!!userRow, "shared users row upserted");
    assert(
      userRow.last_workspace_slug === "org2",
      "single_match resolution persists org2 as her last-used workspace",
    );
    const mirrored = org2Sql.prepare("SELECT id FROM users WHERE dcs_username = 'mallory'").get();
    assert(mirrored && mirrored.id === userRow.id, "user mirrored into org2's local users table (FK safety)");
    const role = org2Sql
      .prepare("SELECT role, source FROM user_roles WHERE dcs_username = 'mallory'")
      .get();
    assert(
      role.role === "editor" && role.source === "manual",
      "her manual row is untouched by the no-team-signal sync",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Denied redirect names the rejecting workspace (issue #288) ──────────────
// A user with no role anywhere and no org membership hits the denied screen.
// The redirect must carry `org=<workspace label>` so a user with access to
// several orgs can tell WHERE the mismatch is.
console.log("[callback] denied redirect carries the rejecting workspace label (#288)");
{
  const realFetch = globalThis.fetch;
  try {
    // Both workspaces' user_roles are empty → nobody has a role anywhere.
    const sharedSql = sharedDbSqlite();
    const org2Sql = org2DbSqlite();
    org2Sql.exec("DELETE FROM user_roles;");

    const baseEnv = {
      JWT_SIGNING_KEY: SIGNING,
      JWT_ISSUER: ISSUER,
      DCS_BASE_URL: "https://git.door43.org",
      DCS_CLIENT_ID: "client-id",
      DCS_CLIENT_SECRET: "client-secret",
      DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
      DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
      SUPER_ADMINS: "",
      DB: makeD1(sharedSql),
      DB2: makeD1(org2Sql),
      WORKSPACES: JSON.stringify([
        { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
        { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB2" },
      ]),
    };

    // nobody: in NO orgs, on NO teams — a genuine deny.
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const json = (body) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (u.includes("/login/oauth/access_token")) {
        assert(init?.method === "POST", "token exchange is a POST");
        return json({ access_token: "nobody-token" });
      }
      if (u.includes("/api/v1/user/orgs")) return json([]);
      if (u.includes("/api/v1/user/teams")) return json([]);
      if (u.endsWith("/api/v1/user")) return json({ id: 99, login: "nobody", full_name: "No Body" });
      throw new Error(`unexpected DCS call: ${u}`);
    };

    const app = new Hono();
    app.get("/api/auth/dcs/callback", callbackDcsAuth);

    const state = "state-deny";
    const stateCookie = await new SignJWT({ state })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("10m")
      .sign(KEY);

    const request = new Request(
      `https://editor.example.org/api/auth/dcs/callback?code=abc&state=${state}`,
      { headers: { cookie: `dcs_auth_state=${stateCookie}` } },
    );
    const ws = resolveWorkspace(baseEnv, parseWorkspaceCookie(request));
    const res = await app.fetch(request, workspaceEnv(baseEnv, ws));

    assert(res.status === 302, `denied callback redirects (302), got ${res.status}`);
    const location = res.headers.get("location") ?? "";
    assert(location.includes("_auth_denied=1"), "it IS the denied redirect");
    assert(location.includes("u=nobody"), "redirect carries the rejected username");
    assert(
      location.includes(`org=${encodeURIComponent(ws.label)}`),
      `redirect names the rejecting workspace (org=${ws.label}), got ${location}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("callbackWorkspace: all assertions passed");
