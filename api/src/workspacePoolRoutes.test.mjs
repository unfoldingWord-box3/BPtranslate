// Route tests for the spare-pool admin endpoints (issue #81, PR-2):
//   GET  /api/workspaces/pool         (super-admin) — registry snapshot
//   POST /api/workspaces/pool         (super-admin) — register an available slot
//   POST /api/workspaces/pool/claim   (super-admin) — claim a slot for an org
//
// Same harness shape as workspaceRoutes.test.mjs (node:sqlite D1 + real Hono
// wiring + JWT). Focus: super-admin gating, the register/claim happy paths, and
// that the literal "pool" path isn't swallowed by POST /:slug.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspacePoolRoutes.test.mjs

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf } from "./auth.ts";
import { blockViewerWrites } from "./viewerGuard.ts";
import { workspaceRoutes } from "./workspaceRoutes.ts";

// The POST /pool/claim route canonicalizes org via DCS GET /api/v1/orgs/{org}
// (orgCanonical.ts). Stub fetch to a non-200 so canonicalOrgName fails open to
// the org as typed — keeps these route tests hermetic and network-free; the
// claim assertions below expect the org echoed back unchanged.
globalThis.fetch = async () => ({ ok: false, status: 404 });

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
const MIGRATION = readFileSync(new URL("../migrations/0058_workspaces_registry.sql", import.meta.url), "utf8");

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
  db.exec(MIGRATION);
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
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function seedUser(db, { id, username }) {
  db.prepare(`INSERT INTO users (id, dcs_user_id, dcs_username, dcs_access_token) VALUES (?, ?, ?, ?)`).run(id, id, username, null);
}

function baseEnv(db, overrides = {}) {
  const d1 = makeD1(db);
  return {
    JWT_SIGNING_KEY: SIGNING,
    JWT_ISSUER: ISSUER,
    DCS_BASE_URL: "https://git.door43.org",
    DB: d1,
    SHARED_DB: d1,
    DB_POOL1: { prepare: () => ({}) }, // a live pool binding
    WORKSPACES: "",
    WORKSPACE_SLUG: "default",
    SUPER_ADMINS: "ada",
    ...overrides,
  };
}

async function makeToken({ sub = "1", role = "editor", username = "alice" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ username, role, ws: "default" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

// Mirrors index.ts's production middleware order: blockViewerWrites runs on
// /api/* BEFORE the workspace router, so this app regresses the interaction
// (a super-admin with a stale viewer-role token must still reach /pool/claim).
function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/workspaces", workspaceRoutes);
  return app;
}

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

// ── super-admin gating ───────────────────────────────────────────────────────

console.log("[gating] pool endpoints require a super-admin");
{
  const db = freshDb();
  seedUser(db, { id: 1, username: "bob" });
  const app = buildApp();
  const env = baseEnv(db); // SUPER_ADMINS = "ada"; bob is not one
  const tok = await makeToken({ sub: "1", username: "bob", role: "admin" }); // even a workspace-admin

  assert((await req(app, env, "GET", "/api/workspaces/pool", { token: tok })).status === 403, "non-super-admin GET /pool -> 403");
  assert(
    (await req(app, env, "POST", "/api/workspaces/pool", { token: tok, body: { binding: "DB_POOL1" } })).status === 403,
    "non-super-admin POST /pool -> 403",
  );
  assert(
    (await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "X", label: "X" } })).status === 403,
    "non-super-admin POST /pool/claim -> 403",
  );
  // Unauthenticated too.
  assert((await req(app, env, "GET", "/api/workspaces/pool")).status === 401, "unauthenticated GET /pool -> 401");

  // A plain viewer (not super-admin) is stopped by blockViewerWrites BEFORE the
  // route even runs — the multi-segment /pool/claim path isn't in the viewer
  // write allowlist, so the guard returns viewer_read_only.
  seedUser(db, { id: 9, username: "vic" });
  const viewerTok = await makeToken({ sub: "9", username: "vic", role: "viewer" });
  const blocked = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: viewerTok, body: { org: "X", label: "X" } });
  assert(blocked.status === 403 && (await blocked.json()).reason === "viewer_read_only", "viewer non-super-admin blocked by viewer guard");

  // Registering must not have happened.
  assert(db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n === 0, "no pool rows written by forbidden requests");
}

// ── register + claim happy path (super-admin) ───────────────────────────────

console.log("[super-admin] register a slot, claim it, see it in the snapshot");
{
  const db = freshDb();
  seedUser(db, { id: 2, username: "ada" });
  const app = buildApp();
  const env = baseEnv(db, { DB_POOL1: { prepare: () => ({}) }, DB_POOL2: { prepare: () => ({}) } });
  // role=viewer on purpose: a super-admin must reach these routes even with a
  // stale viewer-role token — blockViewerWrites (wired into buildApp above) lets
  // super-admins through ahead of the route's isSuperAdmin gate (finding #3).
  const tok = await makeToken({ sub: "2", username: "ada", role: "viewer" });

  const reg1 = await req(app, env, "POST", "/api/workspaces/pool", { token: tok, body: { binding: "DB_POOL1" } });
  assert(reg1.status === 201, "register DB_POOL1 -> 201");
  const reg2 = await req(app, env, "POST", "/api/workspaces/pool", { token: tok, body: { binding: "DB_POOL2" } });
  assert(reg2.status === 201, "register DB_POOL2 -> 201");

  // Registering a non-live binding is a 400.
  const bad = await req(app, env, "POST", "/api/workspaces/pool", { token: tok, body: { binding: "DB_NOPE" } });
  assert(bad.status === 400, "register non-live binding -> 400");

  const snap = await (await req(app, env, "GET", "/api/workspaces/pool", { token: tok })).json();
  assert(snap.counts.available === 2, "snapshot shows two available slots");

  const claim = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "NewOrg", label: "New Org", exportOwner: "NewExport" } });
  assert(claim.status === 201, "claim for NewOrg -> 201");
  const claimBody = await claim.json();
  assert(claimBody.slug === "pool1" && claimBody.org === "NewOrg" && claimBody.alreadyClaimed === false, "claim body: oldest slot, org echoed, not alreadyClaimed");

  const snap2 = await (await req(app, env, "GET", "/api/workspaces/pool", { token: tok })).json();
  assert(snap2.counts.claimed === 1 && snap2.counts.available === 1, "snapshot now 1 claimed / 1 available");

  // Idempotent re-claim.
  const again = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "NewOrg", label: "New Org" } });
  assert(again.status === 200, "re-claim same org -> 200 (not 201)");
  assert((await again.json()).alreadyClaimed === true, "re-claim flagged alreadyClaimed");
}

// ── validation + exhaustion ──────────────────────────────────────────────────

console.log("[super-admin] claim validation and pool exhaustion");
{
  const db = freshDb();
  seedUser(db, { id: 3, username: "ada" });
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken({ sub: "3", username: "ada" });

  const badOrg = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "bad org!", label: "L" } });
  assert(badOrg.status === 400, "invalid org -> 400");

  const badLabel = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "OkOrg", label: "" } });
  assert(badLabel.status === 400, "empty label -> 400");

  // No slots registered -> exhausted.
  const exhausted = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "OkOrg", label: "Ok" } });
  assert(exhausted.status === 503, "no available slots -> 503 pool_exhausted");
  assert((await exhausted.json()).error === "pool_exhausted", "503 body error is pool_exhausted");
}

// ── org canonicalization on claim (issue #306) ──────────────────────────────

console.log("[super-admin] a claim persists DCS canonical org casing, not as-typed");
{
  const db = freshDb();
  seedUser(db, { id: 4, username: "ada" });
  const app = buildApp();
  const env = baseEnv(db);
  const tok = await makeToken({ sub: "4", username: "ada" });

  await req(app, env, "POST", "/api/workspaces/pool", { token: tok, body: { binding: "DB_POOL1" } });

  // DCS resolves the mis-cased "bsoj" to canonical "BSOJ".
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/v1/orgs/")) return { ok: true, json: async () => ({ username: "BSOJ" }) };
    return prevFetch(url);
  };
  try {
    const claim = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "bsoj", label: "BSOJ" } });
    assert(claim.status === 201, "claim for 'bsoj' -> 201");
    assert((await claim.json()).org === "BSOJ", "claim body echoes canonical 'BSOJ', not the typed 'bsoj'");
    assert(db.prepare("SELECT org FROM workspaces WHERE slug='pool1'").get().org === "BSOJ", "persisted workspaces.org is canonical 'BSOJ'");

    // A second claim typed as 'BSOJ' short-circuits to the same slot (idempotent).
    const again = await req(app, env, "POST", "/api/workspaces/pool/claim", { token: tok, body: { org: "BSOJ", label: "BSOJ" } });
    assert(again.status === 200 && (await again.json()).alreadyClaimed === true, "re-claim as 'BSOJ' -> 200 alreadyClaimed (NOCASE lookup)");
  } finally {
    globalThis.fetch = prevFetch;
  }
}

console.log("workspacePoolRoutes: all assertions passed");
