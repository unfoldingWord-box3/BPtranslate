// Integration regression for auto-claiming a spare-pool workspace at first
// admin login (issue #81, PR-3) — workspaceAutoClaim.ts wired into
// callbackDcsAuth.
//
// The whole callback runs for real: real Hono route, real (node:sqlite) D1s
// built from the real migrations (user_roles 0016/0055/0057 + the workspace
// registry 0058/0068), real index.ts-style env swap and primeWorkspaces —
// only globalThis.fetch (DCS) is stubbed.
//
// WORKSPACES is deliberately "" in most cases here: the roster then comes from
// the registry table alone, which is the configuration where a claimed pool
// slot exists ONLY as a registry row. Note that this is NOT the same as a
// single-org production deployment, whose registry is also EMPTY — that shape
// has its own case below ("no explicit roster"), and it must never claim.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaceAutoClaim.test.mjs

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { callbackDcsAuth } from "./auth.ts";
import {
  primeWorkspaces,
  resolveWorkspace,
  workspaceEnv,
  parseWorkspaceCookie,
  listWorkspaces,
} from "./workspaces.ts";

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

// ── D1 adapter over node:sqlite (same shape as callbackWorkspace.test.mjs) ──

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
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

const mig = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const MIGRATION_0016 = mig("0016_user_roles.sql");
const MIGRATION_0055 = mig("0055_user_roles_source.sql");
const MIGRATION_0057 = mig("0057_user_roles_manual_stash.sql");
const MIGRATION_0058 = mig("0058_workspaces_registry.sql");
const MIGRATION_0068 = mig("0068_workspaces_org_collate_nocase.sql");

function userTables(db) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dcs_user_id INTEGER NOT NULL UNIQUE,
      dcs_username TEXT NOT NULL,
      dcs_full_name TEXT,
      dcs_access_token TEXT,
      last_workspace_slug TEXT
    );
  `);
  db.exec(MIGRATION_0016);
  db.exec(MIGRATION_0055);
  db.exec(MIGRATION_0057);
  db.exec("DELETE FROM user_roles;");
}

// Shared / default-workspace database: accounts, sessions, the workspace
// registry, and an EMPTY user_roles.
function sharedDbSqlite({ seedDefaultWorkspace = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  userTables(db);
  db.exec(`
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
  db.exec(MIGRATION_0058);
  db.exec(MIGRATION_0068);
  // The org that is already onboarded, on the default binding. Omitting it
  // models a single-org deployment, where the live workspace is the SYNTHETIC
  // implicit default and no registry row exists at all.
  if (seedDefaultWorkspace) {
    db.exec(
      "INSERT INTO workspaces (slug, label, org, binding, status) " +
        "VALUES ('uw', 'unfoldingWord', 'unfoldingWord', 'DB', 'claimed');",
    );
  }
  return db;
}

// A pre-provisioned, migrated but EMPTY pool database: users + user_roles, no
// project_config row (nothing has ever onboarded here).
function poolDbSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  userTables(db);
  return db;
}

function registerPoolRows(sharedSql, ...slugs) {
  for (const slug of slugs) {
    sharedSql.exec(
      `INSERT INTO workspaces (slug, binding, status) VALUES ('${slug}', 'DB_${slug.toUpperCase()}', 'available');`,
    );
  }
}

function makeEnv(sharedSql, pools, extra = {}) {
  const shared = makeD1(sharedSql);
  const env = {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DCS_CLIENT_ID: "client-id",
    DCS_CLIENT_SECRET: "client-secret",
    DCS_OAUTH_TOKEN_URL: "https://git.door43.org/login/oauth/access_token",
    DCS_OAUTH_AUTHORIZE_URL: "https://git.door43.org/login/oauth/authorize",
    SUPER_ADMINS: "",
    // The roster lives in the registry, not this var.
    WORKSPACES: "",
    // Opt-in switch; off by default in a real deployment.
    WORKSPACE_AUTOCLAIM: "true",
    VIEWER_ORG: "unfoldingWord",
    DB: shared,
    SHARED_DB: shared,
    ...extra,
  };
  for (const [binding, sql] of Object.entries(pools)) env[binding] = makeD1(sql);
  return env;
}

// DCS stub: token exchange, profile, org list, team list.
function stubDcs({ id, login, orgs, teams }) {
  return async (url, init) => {
    const u = String(url);
    const json = (body) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/login/oauth/access_token")) {
      assert(init?.method === "POST", "token exchange is a POST");
      return json({ access_token: `${login}-token` });
    }
    // Paginated listings terminate on an EMPTY page (see fetchPagedList).
    if (u.includes("/api/v1/user/orgs")) return json(u.includes("page=1") ? orgs : []);
    if (u.includes("/api/v1/user/teams")) {
      if (teams === "error") return new Response("nope", { status: 500 });
      return json(u.includes("page=1") ? teams : []);
    }
    if (u.endsWith("/api/v1/user")) return json({ id, login, full_name: login });
    throw new Error(`unexpected DCS call: ${u}`);
  };
}

const team = (org, name) => ({ name, organization: { username: org } });

// Drives the real callback route through the same env swap index.ts performs.
async function signIn(baseEnv, stateName) {
  await primeWorkspaces(baseEnv);
  const app = new Hono();
  app.get("/api/auth/dcs/callback", callbackDcsAuth);
  const stateCookie = await new SignJWT({ state: stateName })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(KEY);
  const request = new Request(
    `https://editor.example.org/api/auth/dcs/callback?code=abc&state=${stateName}`,
    { headers: { cookie: `dcs_auth_state=${stateCookie}` } },
  );
  const ws = resolveWorkspace(baseEnv, parseWorkspaceCookie(request));
  const res = await app.fetch(request, workspaceEnv(baseEnv, ws));
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  return { res, location: res.headers.get("location") ?? "", setCookies };
}

async function roleFromCookies(setCookies) {
  const accessCookie = setCookies.find((h) => /^be_access=/.test(h));
  if (!accessCookie) return null;
  const token = accessCookie.match(/^be_access=([^;]+)/)[1];
  const { payload } = await jwtVerify(token, KEY, { algorithms: ["HS256"], issuer: ISSUER });
  return payload.role;
}

const rows = (sql, q) => sql.prepare(q).all();

// ── 1. First admin login claims a slot ──────────────────────────────────────

console.log("[autoClaim] first login by an admin of an un-onboarded org claims a pool slot");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    const pool2Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1", "pool2");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql, DB_POOL2: pool2Sql });

    // alice belongs ONLY to NewOrg (no workspace yet) and is on its BE-Admins
    // team. DCS reports the org as "NewOrg"; /user/orgs is lowercased by
    // fetchMemberOrgs, so the canonical casing must come from the teams payload.
    globalThis.fetch = stubDcs({
      id: 7,
      login: "alice",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "Owners"), team("NewOrg", "BE-Admins")],
    });

    const { res, location, setCookies } = await signIn(baseEnv, "state-alice-1");

    assert(res.status === 302, `callback redirects (302), got ${res.status}`);
    assert(!location.includes("_auth_denied"), "NOT the denied redirect — she landed in the claimed workspace");

    const claimed = rows(sharedSql, "SELECT slug, org, label, binding, status FROM workspaces WHERE status = 'claimed'");
    assert(claimed.length === 2, `one new claimed row alongside 'uw', got ${claimed.length}`);
    const slot = claimed.find((r) => r.slug === "pool1");
    assert(!!slot, "the OLDEST available slot (pool1) was claimed");
    assert(slot.org === "NewOrg", `org stored with DCS casing, got ${slot.org}`);
    assert(slot.label === "NewOrg", `label defaults to the org name, got ${slot.label}`);
    assert(slot.binding === "DB_POOL1", "the claimed row keeps its pre-provisioned binding");

    assert(
      setCookies.some((h) => /^be_ws=pool1/.test(h)),
      "be_ws lands her in the freshly claimed workspace",
    );
    assert((await roleFromCookies(setCookies)) === "admin", "her JWT carries admin in the new workspace");

    const roleRow = pool1Sql.prepare("SELECT role, source FROM user_roles WHERE dcs_username = 'alice'").get();
    assert(
      roleRow && roleRow.role === "admin" && roleRow.source === "dcs_team",
      "team-derived admin cached into the NEW workspace's user_roles (orgForTeamSync resolves the registry org)",
    );
    const mirrored = pool1Sql.prepare("SELECT id FROM users WHERE dcs_username = 'alice'").get();
    assert(!!mirrored, "her user row is mirrored into the claimed workspace (FK safety)");
    assert(
      pool2Sql.prepare("SELECT COUNT(*) AS n FROM user_roles").get().n === 0 &&
        pool2Sql.prepare("SELECT COUNT(*) AS n FROM users").get().n === 0,
      "the second spare slot's database was never touched",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 2. Second login is idempotent ───────────────────────────────────────────

console.log("[autoClaim] a repeat login by the same admin claims nothing further");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    const pool2Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1", "pool2");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql, DB_POOL2: pool2Sql });

    globalThis.fetch = stubDcs({
      id: 7,
      login: "alice",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Admins")],
    });

    await signIn(baseEnv, "state-alice-a");
    const afterFirst = rows(sharedSql, "SELECT slug, org, status FROM workspaces ORDER BY id");

    // Second sign-in, same everything. A fresh env object (new isolate) so the
    // registry is re-primed from the table rather than a warm cache.
    const baseEnv2 = makeEnv(sharedSql, { DB_POOL1: pool1Sql, DB_POOL2: pool2Sql });
    const { res, setCookies } = await signIn(baseEnv2, "state-alice-b");

    assert(res.status === 302, "second login still succeeds");
    const afterSecond = rows(sharedSql, "SELECT slug, org, status FROM workspaces ORDER BY id");
    assert(
      JSON.stringify(afterFirst) === JSON.stringify(afterSecond),
      `registry unchanged by the second login, got ${JSON.stringify(afterSecond)}`,
    );
    assert(
      afterSecond.filter((r) => r.status === "available").length === 1,
      "the remaining spare slot is still available — no second slot consumed",
    );
    assert((await roleFromCookies(setCookies)) === "admin", "she is still admin on the repeat login");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 3. Non-admins never claim ───────────────────────────────────────────────

console.log("[autoClaim] a non-admin of an un-onboarded org never claims a slot (Owners/editor are not admin)");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    // bob owns the Door43 org and is a BE-Editor — neither grants app admin.
    globalThis.fetch = stubDcs({
      id: 8,
      login: "bob",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "Owners"), team("NewOrg", "BE-Editors")],
    });

    const { res, location } = await signIn(baseEnv, "state-bob");

    assert(res.status === 302, `login still completes (302), got ${res.status}`);
    const registry = rows(sharedSql, "SELECT slug, org, status FROM workspaces ORDER BY id");
    assert(
      registry.filter((r) => r.status === "available").length === 1,
      "the spare slot is untouched — Owners/BE-Editors did not trigger a claim",
    );
    assert(!registry.some((r) => (r.org ?? "").toLowerCase() === "neworg"), "no workspace was created for his org");
    // Today's no-workspace behavior is unchanged: no workspace matches him.
    assert(location.includes("_auth_denied=1"), "he gets the pre-existing denied redirect, not a claim");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 4. An empty pool must not break login ───────────────────────────────────

console.log("[autoClaim] an exhausted pool fails soft — the admin still signs in");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite(); // no available rows registered at all
    const baseEnv = makeEnv(sharedSql, {});

    globalThis.fetch = stubDcs({
      id: 9,
      login: "carol",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Admins")],
    });

    const { res, location } = await signIn(baseEnv, "state-carol");

    assert(res.status === 302, `no 500 — the callback still redirects, got ${res.status}`);
    assert(location.includes("_auth_denied=1"), "she falls through to today's no-workspace behavior");
    const registry = rows(sharedSql, "SELECT slug, org, status FROM workspaces ORDER BY id");
    assert(registry.length === 1 && registry[0].slug === "uw", "nothing was written to the registry");
    const userRow = sharedSql.prepare("SELECT id FROM users WHERE dcs_username = 'carol'").get();
    assert(!userRow, "the denied path is unchanged (no account upsert), i.e. login logic was not disturbed");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 5. A DCS teams outage is "unknown", never "not an admin" ────────────────

console.log("[autoClaim] a failed DCS teams call claims nothing and does not break login");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    globalThis.fetch = stubDcs({
      id: 10,
      login: "dave",
      orgs: [{ username: "NewOrg" }],
      teams: "error",
    });

    const { res } = await signIn(baseEnv, "state-dave");

    assert(res.status === 302, `login still completes (302), got ${res.status}`);
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'available'").length === 1,
      "no slot claimed on an unknown teams answer",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 6. A single-org deployment must never claim (roster-eviction guard) ─────
//
// Regression for the review finding: in a deployment with an EMPTY registry and
// WORKSPACES = "" — which is what a single-org production deployment looks like
// — the live workspace is the SYNTHETIC implicit default, not a row. The first
// claimed row written there would become the entire roster and evict it, so
// every existing user's be_ws=default cookie would resolve to the newly claimed
// (empty) database. Auto-claim must refuse until an operator makes the existing
// workspace explicit.

console.log("[autoClaim] refuses to claim when the roster is only the implicit default (eviction guard)");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite({ seedDefaultWorkspace: false });
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    await primeWorkspaces(baseEnv);
    const before = resolveWorkspace(baseEnv, null);
    assert(
      before.slug === "default" && before.org === "unfoldingWord" && before.binding === "DB",
      "precondition: the live workspace is the synthetic implicit default, not a registry row",
    );

    globalThis.fetch = stubDcs({
      id: 11,
      login: "mallory",
      orgs: [{ username: "EvilOrg" }],
      teams: [team("EvilOrg", "BE-Admins")],
    });

    const { res } = await signIn(baseEnv, "state-mallory");

    assert(res.status === 302, `login still completes (302), got ${res.status}`);
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'claimed'").length === 0,
      "nothing was claimed — the default workspace cannot be evicted by a stranger's login",
    );
    const after = resolveWorkspace(makeEnv(sharedSql, { DB_POOL1: pool1Sql }), null);
    assert(
      after.slug === "default" && after.binding === "DB",
      `the deployment's own database is still the roster, got ${after.slug}/${after.binding}`,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 7. Off by default ───────────────────────────────────────────────────────

console.log("[autoClaim] does nothing unless WORKSPACE_AUTOCLAIM is 'true'");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql }, { WORKSPACE_AUTOCLAIM: "" });

    globalThis.fetch = stubDcs({
      id: 12,
      login: "erin",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Admins")],
    });

    const { res } = await signIn(baseEnv, "state-erin");

    assert(res.status === 302, `login still completes (302), got ${res.status}`);
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'available'").length === 1,
      "the switch is off, so an admin of an un-onboarded org claims nothing",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 8. At most one slot per login ───────────────────────────────────────────

console.log("[autoClaim] an admin of TWO un-onboarded orgs consumes only one slot per login");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    const pool2Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1", "pool2");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql, DB_POOL2: pool2Sql });

    globalThis.fetch = stubDcs({
      id: 13,
      login: "frank",
      orgs: [{ username: "AlphaOrg" }, { username: "BetaOrg" }],
      teams: [team("AlphaOrg", "BE-Admins"), team("BetaOrg", "BE-Admins")],
    });

    await signIn(baseEnv, "state-frank-1");

    const claimed = rows(sharedSql, "SELECT slug, org FROM workspaces WHERE status = 'claimed' AND slug != 'uw'");
    assert(claimed.length === 1, `exactly one slot consumed by the first login, got ${claimed.length}`);
    assert(claimed[0].org === "AlphaOrg", `candidates are tried in sorted order, got ${claimed[0].org}`);

    // The second org onboards on his NEXT login — self-healing, no operator.
    const baseEnv2 = makeEnv(sharedSql, { DB_POOL1: pool1Sql, DB_POOL2: pool2Sql });
    await signIn(baseEnv2, "state-frank-2");
    const claimed2 = rows(sharedSql, "SELECT slug, org FROM workspaces WHERE status = 'claimed' AND slug != 'uw'");
    assert(claimed2.length === 2, `the second login onboards the second org, got ${claimed2.length}`);
    assert(
      claimed2.some((r) => r.org === "BetaOrg"),
      "the remaining un-onboarded org is the one claimed second",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 9. A retired/failed row already holding the org blocks the claim ────────
//
// Regression for the #382 collision, whose fix landed on main in #396 and
// widened claimWorkspace's return type. The roster is `status = 'claimed'` rows
// only (readRegistry), so a `retired`/`failed` row holding the org is INVISIBLE
// to listWorkspaces — the org still looks un-onboarded and is a candidate. But
// UNIQUE(org) COLLATE NOCASE (0068) spans every status, so claiming a spare
// slot for it would trip the index. claimWorkspace returns ClaimBlocked instead
// of throwing; auto-claim must recognize that shape, consume no slot, and let
// the login proceed. Before this was handled, ClaimBlocked fell into the
// success branch and threw a TypeError on `result.workspace` — caught by the
// module's outer try/catch, so it merely LOOKED fine while logging "[autoClaim]
// failed … TypeError". The suite strips types, so only this case guards it.

for (const heldStatus of ["retired", "failed"]) {
  console.log(`[autoClaim] an org held by a '${heldStatus}' row blocks the claim without consuming a slot`);
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    // A previously-onboarded-then-retired slot still holding NewOrg. Its
    // binding is deliberately not a live D1 here, matching a decommissioned
    // slot; what matters is that the org is held under a non-claimed status.
    sharedSql.exec(
      `INSERT INTO workspaces (slug, label, org, binding, status) ` +
        `VALUES ('old', 'NewOrg', 'NewOrg', 'DB_OLD', '${heldStatus}');`,
    );
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    await primeWorkspaces(baseEnv);
    assert(
      !listWorkspaces(baseEnv).some((w) => w.org.toLowerCase() === "neworg"),
      `precondition: the '${heldStatus}' row is not in the roster, so the org still looks un-onboarded`,
    );

    // Case-variant on purpose: the UNIQUE index is COLLATE NOCASE, so "neworg"
    // must collide with the stored "NewOrg" exactly as a same-case claim would.
    globalThis.fetch = stubDcs({
      id: 14,
      login: "grace",
      orgs: [{ username: "neworg" }],
      teams: [team("neworg", "BE-Admins")],
    });

    // The registry assertions below hold on the BROKEN path too: an unhandled
    // ClaimBlocked threw a TypeError that the module's own try/catch swallowed,
    // so nothing was written either way. The warn log is what actually
    // separates "recognized and refused" from "blew up and got caught", so
    // capture it — this is the assertion that fails if the branch is removed.
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let res;
    try {
      ({ res } = await signIn(baseEnv, `state-grace-${heldStatus}`));
    } finally {
      console.warn = realWarn;
    }

    assert(res.status === 302, `login still completes (302), got ${res.status}`);
    assert(
      warnings.some((w) => w.includes(`is held by a ${heldStatus} row`)),
      `the blocked claim is recognized and logged, got ${JSON.stringify(warnings)}`,
    );
    assert(
      !warnings.some((w) => w.includes("[autoClaim] failed")),
      `ClaimBlocked is handled, not thrown into the catch-all, got ${JSON.stringify(warnings)}`,
    );
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'available'").length === 1,
      "the spare slot was NOT consumed for an org another row already holds",
    );
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'claimed'").length === 1,
      "no new claimed row was written (only the pre-existing 'uw' remains)",
    );
    const held = sharedSql.prepare("SELECT status FROM workspaces WHERE slug = 'old'").get();
    assert(held.status === heldStatus, `the held row was never silently reused, still '${held.status}'`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 10. A warm-stale isolate reprimes when it examines an org it believed ────
//        unregistered but did not itself claim (issue #81, the held P1 / O2).
//
// The registry is loaded ONCE per isolate and never expires on its own — only a
// claim on THAT isolate reprimes it (invalidateAndReprime inside claimWorkspace).
// So when org X is claimed on isolate A, an already-warm isolate B still holds a
// roster without X. If a NON-ADMIN member of X then logs in through B, auto-claim
// sees X as a candidate (B's cache is stale), returns not_admin (B doesn't win a
// claim), and — before O2 — B never refreshed, so resolveLoginWorkspace found no
// workspace for X and the member landed on the denied page for the whole isolate
// lifetime. O2: auto-claim now reports examinedUnregisteredCandidate, and the
// callback reprimes on it, so B re-reads the roster A already wrote and the
// member lands in X.
//
// Two isolates are modeled the way index.ts's per-isolate registry cache keys
// them: the SAME underlying node:sqlite data (one sharedSql) wrapped in two
// distinct makeD1 objects (two makeEnv calls), which are two distinct
// registryState WeakMap keys — exactly two warm isolates over one shared DB.
console.log("[autoClaim] a warm-stale isolate reprimes for a non-admin member of an org claimed elsewhere (O2)");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");

    // Isolate A and isolate B, two independent registry caches over one DB.
    const envA = makeEnv(sharedSql, { DB_POOL1: pool1Sql });
    const envB = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    // Warm isolate B BEFORE any claim, so its cache holds only the default 'uw'
    // and will be stale the moment A claims. primeWorkspaces early-returns while
    // the key is present, so B stays stale through the later signIn's own prime.
    await primeWorkspaces(envB);
    assert(
      !listWorkspaces(envB).some((w) => w.org.toLowerCase() === "neworg"),
      "isolate B starts warm and stale — its roster does not yet contain NewOrg",
    );

    // alice, an admin of NewOrg, signs in on isolate A and claims the slot.
    globalThis.fetch = stubDcs({
      id: 20,
      login: "alice",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Admins")],
    });
    const aliceRes = await signIn(envA, "state-o2-alice");
    assert(
      aliceRes.setCookies.some((h) => /^be_ws=pool1/.test(h)),
      "alice claimed and landed in the new workspace on isolate A",
    );
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'claimed' AND org = 'NewOrg'").length === 1,
      "NewOrg is now a claimed row in the shared registry",
    );

    // bob, a NON-ADMIN member (BE-Editor) of NewOrg, now signs in on the still-
    // stale isolate B. Without O2 this is the denied page; with O2 B reprimes on
    // the not_admin-with-a-candidate outcome and bob lands in NewOrg.
    globalThis.fetch = stubDcs({
      id: 21,
      login: "bob",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Editors")],
    });
    const { res, location, setCookies } = await signIn(envB, "state-o2-bob");

    assert(res.status === 302, `bob's login completes (302), got ${res.status}`);
    assert(
      !location.includes("_auth_denied"),
      "bob is NOT denied — the stale isolate reprimed and found NewOrg (fails without O2)",
    );
    assert(
      setCookies.some((h) => /^be_ws=pool1/.test(h)),
      "bob lands in the workspace claimed on the other isolate (fails without O2)",
    );
    assert(
      listWorkspaces(envB).some((w) => w.org.toLowerCase() === "neworg"),
      "isolate B's registry cache now includes NewOrg — it was reprimed, not left stale",
    );
    assert(
      rows(sharedSql, "SELECT slug FROM workspaces WHERE status = 'claimed' AND slug != 'uw'").length === 1,
      "bob consumed no slot — the reprime is a read, not a second claim",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 11. An auto-claimed workspace exports to its OWN org, not the deployment's
//        shared DCS service account (issue #381). ──────────────────────────────
//
// A pool slot claimed for an org with no matching preset carried no
// export_owner, so workspaceEnv fell back to the deployment's DCS_EXPORT_OWNER
// (the shared BibleEditorService account) and the nightly export rendered that
// org's D1 into the service account's own repos. The fix stamps
// export_owner = <org> on the auto-claimed row, so DCS_EXPORT_OWNER for that
// workspace resolves to the org's own DCS (fails closed if no push rights)
// rather than the deployment's. Without the fix, the two assertions below flip:
// export_owner is NULL and workspaceEnv hands back "DeploymentServiceOrg".
console.log("[autoClaim] a claimed slot exports to its own org, never the deployment's service account (#381)");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    // The deployment's shared export owner — the value the bug leaked into a
    // fresh org's export destination.
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql }, { DCS_EXPORT_OWNER: "DeploymentServiceOrg" });

    // NewOrg has no preset (presetForOrg returns null), so nothing seeds
    // project_config and the export owner is decided entirely by the workspace
    // row / env fallback — the exact shape #381 describes.
    globalThis.fetch = stubDcs({
      id: 30,
      login: "heidi",
      orgs: [{ username: "NewOrg" }],
      teams: [team("NewOrg", "BE-Admins")],
    });

    const { res, setCookies } = await signIn(baseEnv, "state-heidi");
    assert(res.status === 302, `login completes (302), got ${res.status}`);
    assert(setCookies.some((h) => /^be_ws=pool1/.test(h)), "heidi landed in the freshly claimed workspace");

    const slot = sharedSql.prepare("SELECT org, export_owner FROM workspaces WHERE slug = 'pool1'").get();
    assert(slot.org === "NewOrg", `precondition: the slot was claimed for NewOrg, got ${slot.org}`);
    assert(
      slot.export_owner === "NewOrg",
      `the auto-claimed row stamps export_owner = the org, got ${JSON.stringify(slot.export_owner)}`,
    );

    // Resolve the claimed workspace on a fresh isolate and stamp its export env,
    // exactly as the nightly ExportWorkflow does (workspaceEnv over the raw env).
    const env2 = makeEnv(sharedSql, { DB_POOL1: pool1Sql }, { DCS_EXPORT_OWNER: "DeploymentServiceOrg" });
    await primeWorkspaces(env2);
    const ws = resolveWorkspace(env2, "pool1");
    const exportEnv = workspaceEnv(env2, ws);
    assert(
      exportEnv.DCS_EXPORT_OWNER === "NewOrg",
      `export env targets the org's own DCS, got ${exportEnv.DCS_EXPORT_OWNER}`,
    );
    assert(
      exportEnv.DCS_EXPORT_OWNER !== "DeploymentServiceOrg",
      "export env does NOT inherit the deployment's shared service account (the #381 bug)",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("[autoClaim] org objects carrying only `name` (Door43 deprecates `username`, #581)");
{
  const realFetch = globalThis.fetch;
  try {
    const sharedSql = sharedDbSqlite();
    const pool1Sql = poolDbSqlite();
    registerPoolRows(sharedSql, "pool1");
    const baseEnv = makeEnv(sharedSql, { DB_POOL1: pool1Sql });

    globalThis.fetch = stubDcs({
      id: 17,
      login: "nina",
      orgs: [{ name: "NewOrg" }],
      teams: [{ name: "BE-Admins", organization: { name: "NewOrg" } }],
    });

    await signIn(baseEnv, "state-nina-1");

    const slot = rows(sharedSql, "SELECT slug, org FROM workspaces WHERE slug = 'pool1'")[0];
    assert(slot && slot.org === "NewOrg", `name-only teams still claim, with Door43's casing; got ${JSON.stringify(slot)}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("workspaceAutoClaim: all assertions passed");
