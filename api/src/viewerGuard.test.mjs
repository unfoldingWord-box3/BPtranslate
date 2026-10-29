// Viewer read-only enforcement tests — the global blockViewerWrites backstop
// (viewerGuard.ts) plus the per-route guards it backs up, exercised against
// REAL route modules mounted the same way index.ts mounts them.
//
// Chain mirrors index.ts: attachAuth → requireCsrf → blockViewerWrites on
// /api/* → routes. (requireWorkspaceMatch is skipped — workspace pinning is
// orthogonal to role enforcement and has its own suite in workspaces.test.mjs.)
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/viewerGuard.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import { Hono } from "hono";
import { SignJWT } from "jose";
import { attachAuth, requireCsrf, requireAuth, refreshToken, updateLastLocation } from "./auth.ts";
import { blockViewerWrites, isViewerWritable } from "./viewerGuard.ts";
import { alerts } from "./alerts.ts";
import { rows } from "./rows.ts";
import { verses } from "./verses.ts";
import { l10n } from "./l10n.ts";
import { projectConfig } from "./projectConfigRoutes.ts";
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
const ISSUER = "bible-editor";

// D1 stub: handler(sql, args, op) → result; run() defaults to one-changed.
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

function baseEnv(db) {
  return { JWT_SIGNING_KEY: SIGNING, JWT_ISSUER: ISSUER, DCS_BASE_URL: "https://git.door43.org", DB: db };
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

// Build an app with the index.ts middleware order and real route modules.
const NOT_FOUND_SENTINEL = "TEST_NOT_FOUND";
function buildApp() {
  const app = new Hono();
  app.use("*", attachAuth);
  app.use("*", requireCsrf);
  app.use("/api/*", blockViewerWrites);
  app.route("/api/alerts", alerts);
  app.route("/api/rows", rows);
  app.route("/api/verses", verses);
  app.route("/api/l10n", l10n);
  app.route("/api/project-config", projectConfig);
  app.route("/api/chat-links", chatLinkRoutes);
  app.post("/api/auth/refresh", refreshToken);
  app.put("/api/users/me/location", requireAuth, updateLastLocation);
  // Deliberately UNGUARDED write route — stands in for a future route someone
  // forgets to add requireEditor to. The backstop must still 403 viewers.
  app.post("/api/future-unguarded", (c) => c.json({ ok: true }));
  // Workspace switch stand-in (the real workspaceRoutes handler needs live
  // cookie/session plumbing; the guard only cares about the method + path).
  app.post("/api/workspaces/other", (c) => c.json({ ok: true }));
  app.get("/api/read-anything", (c) => c.json({ ok: true }));
  // Distinguishable 404 so route-existence assertions can tell "guard passed
  // but no route matched" apart from a handler-level JSON 404.
  app.notFound((c) => c.text(NOT_FOUND_SENTINEL, 404));
  return app;
}

// Every write below sends the CSRF pair; auth via be_access cookie.
function writeReq(method, token, body) {
  return {
    method,
    headers: {
      cookie: `be_access=${token}; be_csrf=tok123`,
      "x-csrf-token": "tok123",
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

async function isRouteMatched(res) {
  // Any non-404 proves the route matched; a 404 only counts as "matched" when
  // it came from a handler (JSON body), not the sentinel notFound.
  if (res.status !== 404) return true;
  return (await res.text()) !== NOT_FOUND_SENTINEL;
}

const app = buildApp();
const viewerTok = await makeToken({ role: "viewer", sub: "2", username: "vera" });
const editorTok = await makeToken({ role: "editor", sub: "1", username: "alice" });
const adminTok = await makeToken({ role: "admin", sub: "3", username: "ada" });

// ── allowlist unit checks ───────────────────────────────────────────────────

console.log("[isViewerWritable] exact method+path matches for self-scoped writes");
{
  assert(isViewerWritable("POST", "/api/auth/refresh"), "auth endpoints self-scoped (prefix)");
  assert(isViewerWritable("PUT", "/api/users/me/location"), "own location self-scoped");
  assert(isViewerWritable("POST", "/api/workspaces/mltest"), "workspace switch self-scoped");
  assert(isViewerWritable("POST", "/api/alerts/7/dismiss"), "alert dismiss self-scoped");
  assert(isViewerWritable("POST", "/api/chat-links/code"), "own chat link code self-scoped");
  assert(isViewerWritable("DELETE", "/api/chat-links/12"), "revoking own chat link self-scoped");
  // Exact-match policy: same prefixes, different endpoints must fail CLOSED.
  assert(!isViewerWritable("POST", "/api/users/me/location"), "wrong method on location blocked");
  assert(!isViewerWritable("DELETE", "/api/users/me/everything"), "future /users/me route blocked");
  assert(!isViewerWritable("POST", "/api/workspaces/mltest/nuke"), "future /workspaces subroute blocked");
  assert(!isViewerWritable("POST", "/api/alerts/7/escalate"), "future /alerts subroute blocked");
  assert(!isViewerWritable("POST", "/api/alerts/abc/dismiss"), "non-numeric alert id blocked");
  assert(!isViewerWritable("POST", "/api/chat-links/12"), "wrong method on a chat link blocked");
  assert(!isViewerWritable("DELETE", "/api/chat-links/code"), "non-numeric chat link id blocked");
  assert(!isViewerWritable("POST", "/api/chat-links/code/extra"), "future /chat-links subroute blocked");
  assert(!isViewerWritable("POST", "/api/rows/tn"), "rows are content");
  assert(!isViewerWritable("PATCH", "/api/verses/ZEC/1/1/ULT"), "verses are content");
  assert(!isViewerWritable("POST", "/api/books/ZEC/import"), "imports are content");
  assert(!isViewerWritable("POST", "/api/project-config/lanes/lit/validate"), "lane config is content");
}

// ── viewer blocked on content writes ────────────────────────────────────────

console.log("[viewer] 403 on representative content-write routes (which must also exist)");
{
  const env = baseEnv(fakeDb());
  // [method, path, body, privileged token proving the route matches]
  const cases = [
    ["POST", "/api/rows/tn", { book: "ZEC" }, editorTok],
    ["PATCH", "/api/rows/tn/abc123", { note: "x" }, editorTok],
    ["DELETE", "/api/rows/tn/abc123", undefined, editorTok],
    ["PATCH", "/api/verses/ZEC/1/1/ULT", { contentJson: {} }, editorTok],
    ["PUT", "/api/l10n/overrides/en", { overrides: {} }, adminTok],
    ["POST", "/api/project-config/lanes/lit/validate", { url: "x" }, adminTok],
    ["POST", "/api/future-unguarded", {}, editorTok],
  ];
  for (const [method, path, body, privTok] of cases) {
    const res = await app.request(path, writeReq(method, viewerTok, body), env);
    assert(res.status === 403, `viewer ${method} ${path} → 403 (got ${res.status})`);
    // The backstop 403s BEFORE route matching, so a typo'd path would also
    // "pass" — prove the same method+path actually resolves to a route by
    // sending it with a privileged token.
    const priv = await app.request(path, writeReq(method, privTok, body), env);
    assert(
      priv.status !== 403 && (await isRouteMatched(priv)),
      `${method} ${path} exists and admits privileged role (got ${priv.status})`,
    );
  }
  // The backstop (not just per-route guards) is what catches the unguarded
  // route — prove the response is the guard's own shape.
  const res = await app.request("/api/future-unguarded", writeReq("POST", viewerTok, {}), env);
  const bodyJson = await res.json();
  assert(bodyJson.reason === "viewer_read_only", "unguarded route rejected by backstop");
}

console.log("[unknown role] fails closed like a viewer");
{
  const env = baseEnv(fakeDb());
  // attachAuth drops unknown role claims to undefined — an authenticated
  // request with no recognized role must NOT slip past the backstop.
  const weirdTok = await makeToken({ role: "superuser", sub: "9", username: "mallory" });
  const res = await app.request("/api/future-unguarded", writeReq("POST", weirdTok, {}), env);
  assert(res.status === 403, `unknown-role write → 403 (got ${res.status})`);
  const bodyJson = await res.json();
  assert(bodyJson.reason === "viewer_read_only", "unknown role rejected by backstop");
}

console.log("[viewer] reads stay open; non-API paths untouched");
{
  const env = baseEnv(fakeDb());
  const res = await app.request(
    "/api/read-anything",
    { headers: { cookie: `be_access=${viewerTok}` } },
    env,
  );
  assert(res.status === 200, "viewer GET passes untouched");
  const anon = await app.request("/api/read-anything", {}, env);
  assert(anon.status === 200, "anonymous GET passes untouched");

  // Guard is scoped to /api/* — a viewer write to a non-API path must get the
  // same fallthrough (sentinel 404 here; SPA assets in prod) as everyone else,
  // not a role-leaking viewer_read_only 403.
  const nonApi = await app.request(
    "/spa/anything",
    { method: "POST", headers: { cookie: `be_access=${viewerTok}; be_csrf=tok123`, "x-csrf-token": "tok123" } },
    env,
  );
  assert(
    nonApi.status === 404 && (await nonApi.text()) === NOT_FOUND_SENTINEL,
    "viewer write outside /api falls through like any other caller",
  );
}

// ── viewer allowed on self-scoped writes ────────────────────────────────────

console.log("[viewer] self-scoped writes still work");
{
  const env = baseEnv(fakeDb());
  const dismiss = await app.request("/api/alerts/7/dismiss", writeReq("POST", viewerTok), env);
  assert(dismiss.status === 200, `viewer can dismiss own alert (got ${dismiss.status})`);
  const dismissed = await dismiss.json();
  assert(dismissed.ok === true && dismissed.changed === true, "dismiss reached the handler");

  const loc = await app.request(
    "/api/users/me/location",
    writeReq("PUT", viewerTok, { book: "ZEC", chapter: 1, verse: 1 }),
    env,
  );
  assert(loc.status === 200, `viewer can save own reading position (got ${loc.status})`);

  const ws = await app.request("/api/workspaces/other", writeReq("POST", viewerTok, {}), env);
  assert(ws.status === 200, `viewer can hit workspace-switch path (got ${ws.status})`);

  const code = await app.request("/api/chat-links/code", writeReq("POST", viewerTok), env);
  assert(code.status === 200, `viewer can get a chat link code (got ${code.status})`);
  assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test((await code.json()).code), "the code reached the handler");
  const revoke = await app.request("/api/chat-links/5", writeReq("DELETE", viewerTok), env);
  assert(revoke.status === 200, `viewer can revoke own chat link (got ${revoke.status})`);
  const otherPost = await app.request("/api/future-unguarded", writeReq("POST", viewerTok, {}), env);
  assert(otherPost.status === 403, "a viewer POST elsewhere is still blocked");

  // CSRF-exempt auth route: the guard must not intercept; the handler's own
  // 401 (no refresh cookie) proves the request reached it.
  const refresh = await app.request("/api/auth/refresh", { method: "POST" }, env);
  assert(refresh.status === 401, "auth refresh reaches handler (401 from handler, not 403 from guard)");
}

// ── editors and admins unaffected by the backstop ───────────────────────────

console.log("[editor/admin] backstop does not block privileged roles");
{
  const env = baseEnv(fakeDb());
  const unguarded = await app.request("/api/future-unguarded", writeReq("POST", editorTok, {}), env);
  assert(unguarded.status === 200, "editor passes the backstop");

  // Editor on the admin-gated lane validate → 403 from requireAdmin.
  const laneEditor = await app.request(
    "/api/project-config/lanes/lit/validate",
    writeReq("POST", editorTok, { url: "garbage" }),
    env,
  );
  assert(laneEditor.status === 403, `editor blocked from lane validate (got ${laneEditor.status})`);

  // Admin reaches the handler (400 invalid URL — proves the guard passed
  // before any DB access).
  const laneAdmin = await app.request(
    "/api/project-config/lanes/lit/validate",
    writeReq("POST", adminTok, { url: "garbage" }),
    env,
  );
  assert(laneAdmin.status === 400, `admin reaches lane validate handler (got ${laneAdmin.status})`);
}

// ── unauthenticated writes: guard defers to per-route auth ─────────────────

console.log("[anonymous] backstop passes through; per-route guards still decide");
{
  const env = baseEnv(fakeDb());
  const res = await app.request(
    "/api/rows/tn",
    {
      method: "POST",
      headers: { cookie: "be_csrf=tok123", "x-csrf-token": "tok123", "content-type": "application/json" },
      body: JSON.stringify({}),
    },
    env,
  );
  assert(res.status === 401, `anonymous content write → 401 from requireEditor (got ${res.status})`);
  // requireEditor (not the viewer backstop) must be the rejecting layer.
  const bodyJson = await res.json();
  assert(bodyJson.error === "unauthorized", "rejected by per-route auth, not the viewer backstop");
}

console.log("viewerGuard tests passed");
