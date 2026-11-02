// Unit tests for adminUserRoutes.ts — the admin-only user_roles CRUD API.
// Mirrors auth.test.mjs's harness for the HTTP/auth/CSRF layer (a real Hono
// app wired the same way the real app wires it, a jose-signed JWT cookie to
// simulate callers of each role, a stubbed globalThis.fetch for the DCS
// existence check restored in a finally so it never leaks between tests).
//
// Unlike the original version of this file, the D1 layer is REAL SQLite
// (node:sqlite DatabaseSync, same adapter shape as projectConfigApply.test.mjs)
// rather than a hand-rolled string-matching stub. This matters here because
// the last-admin guard is implemented as a single atomic UPSERT/DELETE
// statement whose WHERE clause embeds a COUNT(*) subquery (see
// adminUserRoutes.ts) — the whole point of that design is the atomicity
// SQLite provides, which a fake statement dispatcher can't actually exercise.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/adminUsers.test.mjs

import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { adminUsers } from "./adminUserRoutes.ts";

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

// ── D1 adapter over node:sqlite (same shape as projectConfigApply.test.mjs) ─

function freshDb() {
  const db = new DatabaseSync(":memory:");
  // D1 does not enforce foreign keys by default; node:sqlite does unless told
  // otherwise. Match production so tests aren't stricter than reality.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER UNIQUE,
      dcs_username TEXT,
      dcs_access_token TEXT
    );
    CREATE TABLE user_roles (
      dcs_username TEXT PRIMARY KEY COLLATE NOCASE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
      added_at INTEGER NOT NULL DEFAULT (unixepoch()),
      added_by INTEGER REFERENCES users(id),
      source TEXT NOT NULL DEFAULT 'manual',
      manual_role TEXT
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

// Seeds user_roles rows: [{username, role, addedBy?}]. addedBy (a users.id)
// defaults to null. Returns the db for chaining into makeD1().
function seed(db, rows) {
  db.prepare(
    `INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?, ?, ?)`,
  );
  for (const r of rows) {
    db.prepare(`INSERT INTO user_roles (dcs_username, role, added_by) VALUES (?, ?, ?)`).run(
      r.username,
      r.role,
      r.addedBy ?? null,
    );
  }
  return db;
}

function baseEnv(db, dcsServiceToken) {
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DCS_SERVICE_TOKEN: dcsServiceToken,
    DB: makeD1(db),
  };
}

async function makeToken({ sub = "1", role = "admin", username = "ada" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role, ws: "default" })
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
  app.route("/api/admin/users", adminUsers);
  return app;
}

// Helper to fire requests with the auth + (for writes) CSRF cookies wired.
function req(app, env, method, path, { token, body } = {}) {
  const cookies = [];
  const headers = {};
  if (token) cookies.push(`be_access=${token}`);
  if (method !== "GET") {
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

// A DCS fetch stub that succeeds and echoes back the path-param username as
// the canonical login (same casing) unless the test overrides globalThis.fetch.
function stubDcsOk() {
  globalThis.fetch = async (url) => {
    const m = /\/api\/v1\/users\/([^/?]+)/.exec(String(url));
    const login = m ? decodeURIComponent(m[1]) : "unknown";
    return new Response(JSON.stringify({ login }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// ── Auth gating: 401 no cookie, 403 editor, 200 admin ──────────────────────

console.log("[auth gating] GET/PUT/DELETE all require an authenticated admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const editorTok = await makeToken({ role: "editor", sub: "2", username: "eddie" });
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    const listEnv = baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    assert((await req(app, listEnv, "GET", "/api/admin/users")).status === 401, "GET no cookie → 401");
    assert(
      (await req(app, listEnv, "GET", "/api/admin/users", { token: editorTok })).status === 403,
      "GET editor → 403",
    );
    assert(
      (await req(app, listEnv, "GET", "/api/admin/users", { token: adminTok })).status === 200,
      "GET admin → 200",
    );

    // PUT: adding a brand-new editor, count irrelevant.
    const putEnv = () => baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { body: { role: "editor" } })).status === 401,
      "PUT no cookie → 401",
    );
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { token: editorTok, body: { role: "editor" } }))
        .status === 403,
      "PUT editor → 403",
    );
    assert(
      (await req(app, putEnv(), "PUT", "/api/admin/users/newbie", { token: adminTok, body: { role: "editor" } }))
        .status === 200,
      "PUT admin → 200",
    );

    // DELETE: existing editor row, count irrelevant (not admin).
    const delEnv = () => baseEnv(seed(freshDb(), [{ username: "newbie", role: "editor" }]));
    assert((await req(app, delEnv(), "DELETE", "/api/admin/users/newbie")).status === 401, "DELETE no cookie → 401");
    assert(
      (await req(app, delEnv(), "DELETE", "/api/admin/users/newbie", { token: editorTok })).status === 403,
      "DELETE editor → 403",
    );
    assert(
      (await req(app, delEnv(), "DELETE", "/api/admin/users/newbie", { token: adminTok })).status === 200,
      "DELETE admin → 200",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Last-admin guard (atomic — real SQLite executes the guarded UPSERT/DELETE) ─

console.log("[last-admin guard] refuse to demote/remove the sole remaining admin");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });

    // Sole admin ("target") — demote must be blocked.
    const soleAdminEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const blocked = await req(app, soleAdminEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(blocked.status === 409, "demote sole admin (count=1) → 409");
    assert((await blocked.json()).error === "last_admin", "409 body is last_admin");

    // Two admins — demoting one must succeed.
    const twoAdminsEnv = baseEnv(
      seed(freshDb(), [
        { username: "target", role: "admin" },
        { username: "other", role: "admin" },
      ]),
    );
    const allowed = await req(app, twoAdminsEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(allowed.status === 200, "demote when another admin exists (count=2) → 200");

    // DELETE mirrors the same guard.
    const delSoleAdminEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const delBlocked = await req(app, delSoleAdminEnv, "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delBlocked.status === 409, "DELETE sole admin (count=1) → 409");
    assert((await delBlocked.json()).error === "last_admin", "DELETE 409 body is last_admin");

    const delTwoAdminsEnv = baseEnv(
      seed(freshDb(), [
        { username: "target", role: "admin" },
        { username: "other", role: "admin" },
      ]),
    );
    const delAllowed = await req(app, delTwoAdminsEnv, "DELETE", "/api/admin/users/target", { token: adminTok });
    assert(delAllowed.status === 200, "DELETE admin when another admin exists (count=2) → 200");

    // Not a demotion (admin→admin) — guard must not trigger even at count=1.
    const sameRoleEnv = baseEnv(seed(freshDb(), [{ username: "target", role: "admin" }]));
    const sameRole = await req(app, sameRoleEnv, "PUT", "/api/admin/users/target", {
      token: adminTok,
      body: { role: "admin" },
    });
    assert(sameRole.status === 200, "admin→admin at count=1 is not a demotion → 200");

    // Brand-new user (no current row) being added as editor must not trigger
    // the guard even when the DB's only row is a lone admin (count=1) — the
    // INSERT has no conflict to fire the DO UPDATE guard clause at all.
    const newUserEnv = baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]));
    const newUser = await req(app, newUserEnv, "PUT", "/api/admin/users/brandnew", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(newUser.status === 200, "new user added as editor never trips the last-admin guard → 200");

    // Concurrency: two "simultaneous" demote requests against the same sole
    // admin. Fired back-to-back against the SAME db (no seed reset between
    // them) — this is the actual race the atomic guard exists to close: if
    // the count-check and the write were still two separate statements, both
    // requests could observe count=1... no wait, count=2 (two admins) and
    // both succeed, leaving zero admins. Assert exactly one succeeds.
    const raceEnv = baseEnv(
      seed(freshDb(), [
        { username: "raceA", role: "admin" },
        { username: "raceB", role: "admin" },
      ]),
    );
    const [raceRes1, raceRes2] = await Promise.all([
      req(app, raceEnv, "PUT", "/api/admin/users/raceA", { token: adminTok, body: { role: "editor" } }),
      req(app, raceEnv, "PUT", "/api/admin/users/raceB", { token: adminTok, body: { role: "editor" } }),
    ]);
    const raceStatuses = [raceRes1.status, raceRes2.status].sort();
    assert(
      JSON.stringify(raceStatuses) === JSON.stringify([200, 409]),
      `concurrent demote of both remaining admins: exactly one succeeds, one gets last_admin (got ${raceStatuses})`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── PUT validation ordering ─────────────────────────────────────────────────

console.log("[PUT validation] body shape → username shape → DCS existence → canonical casing");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const dbThrowsIfTouched = () => ({
      prepare() {
        throw new Error("DB should not be touched for a request rejected before the DB step");
      },
    });

    // Invalid body: must 400 before the username regex, DCS fetch, or DB.
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 500 });
    };
    const untouchedEnv = { ...baseEnv(freshDb()), DB: dbThrowsIfTouched() };
    const badBody = await req(app, untouchedEnv, "PUT", "/api/admin/users/valid-name", {
      token: adminTok,
      body: { role: "viewer" },
    });
    assert(badBody.status === 400, "role:viewer → 400");
    assert((await badBody.json()).error === "invalid_body", "400 body is invalid_body");
    assert(fetchCalled === false, "DCS fetch never called for invalid_body");

    // Invalid username (contains a space) — valid role, so body passes; must
    // 400 before the DCS call.
    fetchCalled = false;
    const badUsername = await req(app, untouchedEnv, "PUT", "/api/admin/users/bad%20name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername.status === 400, "username with space → 400");
    assert((await badUsername.json()).error === "invalid_username", "400 body is invalid_username");
    assert(fetchCalled === false, "DCS fetch never called for invalid_username");

    // Invalid username (contains @).
    const badUsername2 = await req(app, untouchedEnv, "PUT", "/api/admin/users/bad@name", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(badUsername2.status === 400, "username with @ → 400");
    assert((await badUsername2.json()).error === "invalid_username", "@ username → invalid_username");

    // DCS 404.
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    const notFound = await req(app, untouchedEnv, "PUT", "/api/admin/users/ghostuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(notFound.status === 404, "DCS 404 → 404");
    assert((await notFound.json()).error === "dcs_user_not_found", "404 body is dcs_user_not_found");

    // Happy path: DCS returns a different casing than the URL path; the
    // stored/returned row must use DCS's canonical casing, and added_by must
    // be stamped from the caller's userId on first insert.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ login: "BCameron93" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const casingDb = freshDb();
    const casingEnv = baseEnv(casingDb);
    const casingRes = await req(app, casingEnv, "PUT", "/api/admin/users/bcameron93", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(casingRes.status === 200, "happy-path PUT with casing mismatch → 200");
    const casingBody = await casingRes.json();
    assert(casingBody.user.username === "BCameron93", "response uses DCS-canonical casing, not URL casing");
    assert(casingBody.dcsVerified === true, "dcsVerified true when DCS responded 200");
    const stored = casingDb.prepare("SELECT dcs_username, added_by FROM user_roles").get();
    assert(stored.dcs_username === "BCameron93", "row stored under the DCS-canonical login, not the URL param");
    assert(stored.added_by === 1, "added_by stamped from the caller's userId (sub=1) on first insert");

    // ── Team-derived rows: the panel must be able to tell the admin that an
    // edit or a removal here does NOT actually stick. Both signals travel in
    // the response body, so a dropped field silently disables the warning.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ login: "teamuser" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const teamDb = freshDb();
    const teamEnv = baseEnv(teamDb);
    // manual_role seeded to prove the PUT clears the stash — the admin's new
    // edit IS the manual baseline now, superseding whatever was stashed.
    teamDb.exec(
      "INSERT INTO user_roles (dcs_username, role, source, manual_role) VALUES ('teamuser','editor','dcs_team','editor'), ('keeper','admin','manual',NULL)",
    );

    const teamPut = await req(app, teamEnv, "PUT", "/api/admin/users/teamuser", {
      token: adminTok,
      body: { role: "admin" },
    });
    assert(teamPut.status === 200, "PUT on a team-derived row → 200");
    const teamPutBody = await teamPut.json();
    assert(
      teamPutBody.wasTeamManaged === true,
      "PUT response flags wasTeamManaged so the UI can warn the edit will be re-synced away",
    );
    const teamRow = teamDb
      .prepare("SELECT role, source, manual_role FROM user_roles WHERE dcs_username='teamuser'")
      .get();
    assert(
      teamRow.source === "manual" && teamRow.role === "admin",
      "an admin edit takes MANUAL ownership of the row (teams-win re-takes it at the next sync)",
    );
    assert(teamRow.manual_role === null, "the stashed manual_role is cleared — this edit is the new baseline");
    assert(
      teamPutBody.user.source === "manual",
      "PUT response reflects the post-edit manual ownership",
    );

    // Reset team ownership (the PUT above just took manual ownership) so the
    // DELETE below exercises the team-derived-row warning path.
    teamDb.exec("UPDATE user_roles SET source='dcs_team' WHERE dcs_username='teamuser'");
    const teamDel = await req(app, teamEnv, "DELETE", "/api/admin/users/teamuser", {
      token: adminTok,
    });
    assert(teamDel.status === 200, "DELETE on a team-derived row → 200");
    assert(
      (await teamDel.json()).wasTeamDerived === true,
      "DELETE response flags that removal is temporary until they leave the Door43 team",
    );

    const manualDb = freshDb();
    const manualEnv = baseEnv(manualDb);
    manualDb.exec(
      "INSERT INTO user_roles (dcs_username, role, source) VALUES ('manualuser','editor','manual'), ('keeper','admin','manual')",
    );
    const manualDel = await req(app, manualEnv, "DELETE", "/api/admin/users/manualuser", {
      token: adminTok,
    });
    assert(
      (await manualDel.json()).wasTeamDerived === false,
      "a manual row's removal is permanent, and is not flagged",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── Fail-open on DCS network error ──────────────────────────────────────────

console.log("[PUT DCS fail-open] network error still writes, using the path-param username");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const env = baseEnv(freshDb());
    const res = await req(app, env, "PUT", "/api/admin/users/offlineuser", {
      token: adminTok,
      body: { role: "editor" },
    });
    assert(res.status === 200, "DCS fetch throws → still 200 (fail open)");
    const body = await res.json();
    assert(body.dcsVerified === false, "dcsVerified false when DCS fetch failed");
    assert(body.user.username === "offlineuser", "row stored under the path-param username when DCS is unreachable");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── DELETE not_found ─────────────────────────────────────────────────────────

console.log("[DELETE] missing row → 404");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const env = baseEnv(freshDb());
    const res = await req(app, env, "DELETE", "/api/admin/users/nobody", { token: adminTok });
    assert(res.status === 404, "DELETE unknown username → 404");
    assert((await res.json()).error === "not_found", "404 body is not_found");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── GET /org-members public-members fallback (issue #78) ───────────────────
// When the service account can see the org but isn't itself a member,
// `/orgs/{org}/members` 401s/403s even though the org is real. Rather than
// going straight to an empty "unreachable" panel, the route should retry
// against `/orgs/{org}/public_members` and flag the result `partial`.

console.log("[GET org-members] 403 on /members falls back to /public_members, flagged partial");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("/public_members")) {
        return new Response(JSON.stringify([{ login: "publicuser", full_name: "Public User" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("forbidden", { status: 403 });
    };
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 even though /members 403'd");
    const body = await res.json();
    assert(body.partial === true, "flagged partial");
    assert(body.error === "dcs_403_public_only", `error is dcs_403_public_only (got ${body.error})`);
    assert(body.members.length === 1 && body.members[0].login === "publicuser", "public_members roster returned");
    assert(
      calls.some((u) => u.includes("/members?")) && calls.some((u) => u.includes("/public_members?")),
      "tried /members then fell back to /public_members",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] 403 on both /members and /public_members → empty, non-partial error");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async () => new Response("forbidden", { status: 403 });
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "still 200 (fail-soft)");
    const body = await res.json();
    assert(!body.partial, "not flagged partial when the fallback also fails");
    assert(body.error === "dcs_403", `error is dcs_403 (got ${body.error})`);
    assert(body.members.length === 0, "empty roster");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── GET /org-members admin-token primary path (issue #78 follow-up) ─────────
// The signed-in admin is themselves a member of the org (that's how they got
// admin, via a Door43 team in it), so THEIR stored personal DCS token can read
// the full roster — including private members — that the shared service token
// often cannot. The fetch chain is now: (1) admin's own token, (2) shared
// DCS_SERVICE_TOKEN, (3) public_members (partial). (1) and (2) return the full
// roster plainly; only (3) is `partial`.

// Seeds a users row so currentUserDcsToken() can read the caller's stored DCS
// token. `id` must match the JWT `sub` used for the request.
function seedUser(db, { id = 1, username = "ada", token = null } = {}) {
  db.prepare(
    `INSERT INTO users (id, dcs_user_id, dcs_username, dcs_access_token) VALUES (?, ?, ?, ?)`,
  ).run(id, -id, username, token);
  return db;
}

// Reads the Authorization header off a fetch() call's init arg (fetchOrgMembers
// passes { headers }), so a stub can tell which token a request used.
function authOf(init) {
  return init?.headers?.Authorization ?? null;
}

console.log("[GET org-members] admin's own token returns the FULL roster (not partial), service token untouched");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: authOf(init) });
      if (authOf(init) === "token admin-personal-tok") {
        return new Response(JSON.stringify([{ login: "privateuser", full_name: "Private User" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Any other token (e.g. the service token) must NOT be reached here.
      return new Response("forbidden", { status: 403 });
    };
    const db = seedUser(freshDb(), { id: 1, username: "ada", token: "admin-personal-tok" });
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 via the admin's own token");
    const body = await res.json();
    assert(!body.partial, "full roster is NOT flagged partial");
    assert(body.error === undefined, `no error on the full-roster path (got ${body.error})`);
    assert(
      body.members.length === 1 && body.members[0].login === "privateuser",
      "roster came from the admin-token /members call (incl. private members)",
    );
    assert(
      calls.every((call) => call.auth === "token admin-personal-tok"),
      "only the admin token was used — the service token was never tried",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] expired admin token (401) falls through to the service token's full roster");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: authOf(init) });
      if (authOf(init) === "token expired-admin-tok") {
        return new Response("unauthorized", { status: 401 });
      }
      if (authOf(init) === "token svc-token") {
        return new Response(JSON.stringify([{ login: "svcuser", full_name: "Service User" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("forbidden", { status: 403 });
    };
    const db = seedUser(freshDb(), { id: 1, username: "ada", token: "expired-admin-tok" });
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 via the service token after the admin token 401'd");
    const body = await res.json();
    assert(!body.partial, "service-token full roster is NOT flagged partial");
    assert(
      body.members.length === 1 && body.members[0].login === "svcuser",
      "roster came from the service-token /members call",
    );
    assert(
      calls.some((call) => call.auth === "token expired-admin-tok") &&
        calls.some((call) => call.auth === "token svc-token"),
      "tried the admin token first, then fell through to the service token",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] missing admin token falls through to the service token's full roster");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: authOf(init) });
      if (authOf(init) === "token svc-token") {
        return new Response(JSON.stringify([{ login: "svcuser" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("forbidden", { status: 403 });
    };
    // No users row for sub=1 → currentUserDcsToken() returns null → straight to
    // the service token, no /members call ever made with an admin token.
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 via the service token when the admin has no stored token");
    const body = await res.json();
    assert(!body.partial, "service-token roster is NOT flagged partial");
    assert(body.members.length === 1 && body.members[0].login === "svcuser", "service-token roster returned");
    assert(
      calls.every((call) => call.auth === "token svc-token"),
      "no stored admin token → only the service token was used",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] public_members fallback carries NO auth (an invalid service token must not 401 the public endpoint)");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const auth = authOf(init);
      calls.push({ url: String(url), auth });
      if (String(url).includes("/public_members")) {
        // Door43 behavior: the public endpoint needs no auth (200), but an
        // invalid token 401s it. If the bad service-token header leaks here,
        // this returns 401 and the fallback collapses to an empty roster.
        if (auth) return new Response("unauthorized", { status: 401 });
        return new Response(JSON.stringify([{ login: "publicuser" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // /members with the (invalid) service token 401s. No admin token stored.
      return new Response("unauthorized", { status: 401 });
    };
    // No users row for sub=1 → no admin token; service token is invalid.
    const env = baseEnv(freshDb(), "bad-svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 (fail-soft) at the public_members last resort");
    const body = await res.json();
    assert(body.partial === true, "flagged partial via public_members despite the bad service token");
    assert(body.members.length === 1 && body.members[0].login === "publicuser", "public roster returned, not empty");
    const pubCall = calls.find((call) => call.url.includes("/public_members?"));
    assert(pubCall && pubCall.auth === null, "public_members was called WITHOUT an Authorization header");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] expired admin token + service 403 → public_members partial (full chain to last resort)");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), auth: authOf(init) });
      if (String(url).includes("/public_members")) {
        return new Response(JSON.stringify([{ login: "publicuser" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Both the admin token and the service token 403 on /members.
      return new Response("forbidden", { status: 403 });
    };
    const db = seedUser(freshDb(), { id: 1, username: "ada", token: "expired-admin-tok" });
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 (fail-soft) at the public_members last resort");
    const body = await res.json();
    assert(body.partial === true, "flagged partial at the public_members fallback");
    assert(body.error === "dcs_403_public_only", `error is dcs_403_public_only (got ${body.error})`);
    assert(body.members.length === 1 && body.members[0].login === "publicuser", "public_members roster returned");
    assert(
      calls.some((call) => call.auth === "token expired-admin-tok") &&
        calls.some((call) => call.auth === "token svc-token") &&
        calls.some((call) => call.url.includes("/public_members?")),
      "exercised the full chain: admin token → service token → public_members",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── GET /org-members attaches LIVE team roles (issue: team admins with no
// login yet). The roster's APP ROLE must reflect Door43 team membership
// (BE-Admins → admin, BE-Editors → editor) even for members who have never
// signed in and therefore have no user_roles row. Resolved by listing the
// org's role-teams + their members, admin winning over editor. ─────────────

function jsonRes(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

console.log("[GET org-members] attaches teamRole from live Door43 team membership (admin wins)");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/public_members")) return jsonRes([]);
      if (u.includes("/teams/1/members")) return jsonRes([{ login: "Haneenf" }, { login: "bothuser" }]);
      if (u.includes("/teams/2/members")) return jsonRes([{ login: "eddie" }, { login: "bothuser" }]);
      if (/\/orgs\/[^/]+\/teams\?/.test(u))
        return jsonRes([
          { id: 1, name: "BE-Admins" },
          { id: 2, name: "BE-Editors" },
          { id: 3, name: "Owners" },
        ]);
      if (u.includes("/members"))
        return jsonRes([
          { login: "Haneenf", full_name: "Haneen F" },
          { login: "eddie" },
          { login: "bothuser" },
          { login: "norole" },
        ]);
      return new Response("nope", { status: 404 });
    };
    // No seeded user_roles rows at all — proves teamRole comes from LIVE team
    // membership, not the allowlist.
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200");
    const body = await res.json();
    const byLogin = Object.fromEntries(body.members.map((m) => [m.login, m.teamRole]));
    assert(byLogin.Haneenf === "admin", "BE-Admins member (never logged in) resolves to admin");
    assert(byLogin.eddie === "editor", "BE-Editors member resolves to editor");
    assert(byLogin.bothuser === "admin", "member in both teams: admin wins over editor");
    assert(byLogin.norole === undefined, "member on no role-team has no teamRole");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] team-listing failure degrades gracefully — roster returned without teamRole");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async (url) => {
      const u = String(url);
      // The org-member list succeeds, but every team read 500s.
      if (u.includes("/teams")) return new Response("boom", { status: 500 });
      if (u.includes("/members")) return jsonRes([{ login: "Haneenf" }, { login: "eddie" }]);
      return new Response("nope", { status: 404 });
    };
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    assert(res.status === 200, "200 (roster still returned)");
    const body = await res.json();
    assert(body.members.length === 2, "both members present despite team-read failure");
    assert(
      body.members.every((m) => m.teamRole === undefined),
      "no teamRole attached when the team listing couldn't be read (degrade, not break)",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[GET org-members] public_members fallback carries no team roles (teams need org membership)");
{
  const realFetch = globalThis.fetch;
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("/public_members")) return jsonRes([{ login: "publicuser" }]);
      // /members 403s (service account not a member), teams would too.
      return new Response("forbidden", { status: 403 });
    };
    const env = baseEnv(freshDb(), "svc-token");
    const res = await req(app, env, "GET", "/api/admin/users/org-members", { token: adminTok });
    const body = await res.json();
    assert(body.partial === true, "partial public roster");
    assert(
      body.members.every((m) => m.teamRole === undefined),
      "public_members members have no teamRole (team endpoints require membership)",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── POST /purge-manual — bulk-clear manual grants (issue #2) ────────────────
// Removes every source='manual' row so roles come from Door43 teams. dcs_team
// rows are untouched. At least one admin is always preserved (the caller when
// every admin is manual), mirroring the last-admin guard.

console.log("[POST purge-manual] clears all manual rows, leaves dcs_team rows, when a team admin survives");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const db = freshDb();
    db.exec(
      `INSERT INTO user_roles (dcs_username, role, source) VALUES
         ('ada','admin','manual'),
         ('bob','editor','manual'),
         ('teamadmin','admin','dcs_team'),
         ('teameditor','editor','dcs_team')`,
    );
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "POST", "/api/admin/users/purge-manual", { token: adminTok });
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(body.kept.length === 0, "nothing kept — a dcs_team admin already guarantees a non-empty admin set");
    assert(body.removed.sort().join(",") === "ada,bob", `both manual rows removed (got ${body.removed})`);
    const remaining = db.prepare("SELECT dcs_username FROM user_roles ORDER BY dcs_username").all();
    assert(
      remaining.map((r) => r.dcs_username).join(",") === "teamadmin,teameditor",
      "only dcs_team rows survive the purge",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST purge-manual] keeps the caller as the last admin when every admin is manual");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const db = freshDb();
    db.exec(
      `INSERT INTO user_roles (dcs_username, role, source) VALUES
         ('ada','admin','manual'),
         ('carol','admin','manual'),
         ('bob','editor','manual')`,
    );
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "POST", "/api/admin/users/purge-manual", { token: adminTok });
    const body = await res.json();
    assert(body.kept.join(",") === "ada", `caller (ada) kept as the last admin (got ${body.kept})`);
    assert(body.removed.sort().join(",") === "bob,carol", `everyone else removed (got ${body.removed})`);
    const remaining = db.prepare("SELECT dcs_username FROM user_roles").all();
    assert(remaining.length === 1 && remaining[0].dcs_username === "ada", "only the kept admin remains");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST purge-manual] clears stashed manual_role on team rows so a purged grant can't resurface");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const db = freshDb();
    // bob: had a manual editor grant, then joined BE-Editors and signed in, so
    // syncTeamRole took the row over (source='dcs_team') and STASHED the prior
    // manual grant in manual_role. A purge must clear that stash — otherwise
    // when bob later leaves the team, syncTeamRole restores it and bob keeps
    // access the purge was meant to revoke.
    db.exec(
      `INSERT INTO user_roles (dcs_username, role, source, manual_role) VALUES
         ('teamadmin','admin','dcs_team',NULL),
         ('bob','editor','dcs_team','editor'),
         ('carol','editor','manual',NULL)`,
    );
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "POST", "/api/admin/users/purge-manual", { token: adminTok });
    assert(res.status === 200, "200");
    const body = await res.json();
    assert(body.removed.join(",") === "carol", `visible manual row removed (got ${body.removed})`);
    const bob = db.prepare("SELECT role, source, manual_role FROM user_roles WHERE dcs_username='bob'").get();
    assert(bob.role === "editor" && bob.source === "dcs_team", "bob's live team role is untouched");
    assert(bob.manual_role === null, "bob's stashed manual grant is cleared — it can't resurface on team departure");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST purge-manual] no manual rows → empty result, nothing changed");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const adminTok = await makeToken({ role: "admin", sub: "1", username: "ada" });
    const db = freshDb();
    db.exec(`INSERT INTO user_roles (dcs_username, role, source) VALUES ('teamadmin','admin','dcs_team')`);
    const env = baseEnv(db, "svc-token");
    const res = await req(app, env, "POST", "/api/admin/users/purge-manual", { token: adminTok });
    const body = await res.json();
    assert(body.removed.length === 0 && body.kept.length === 0, "no-op result");
    assert(db.prepare("SELECT COUNT(*) AS n FROM user_roles").get().n === 1, "dcs_team row untouched");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[POST purge-manual] auth-gated: no cookie → 401, editor → 403");
{
  const realFetch = globalThis.fetch;
  stubDcsOk();
  try {
    const app = buildApp();
    const editorTok = await makeToken({ role: "editor", sub: "2", username: "eddie" });
    const env = () => baseEnv(seed(freshDb(), [{ username: "ada", role: "admin" }]), "svc-token");
    assert(
      (await req(app, env(), "POST", "/api/admin/users/purge-manual")).status === 401,
      "POST no cookie → 401",
    );
    assert(
      (await req(app, env(), "POST", "/api/admin/users/purge-manual", { token: editorTok })).status === 403,
      "POST editor → 403",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("adminUsers: all assertions passed");
