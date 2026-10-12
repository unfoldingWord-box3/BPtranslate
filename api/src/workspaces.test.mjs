// Unit tests for workspaces.ts — the org-per-D1 resolution layer. The load-
// bearing property: when WORKSPACES is unset/empty/malformed, everything
// degrades to one implicit "default" workspace on the existing DB binding.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings --test src/workspaces.test.mjs

import { Hono } from "hono";
import {
  listWorkspaces,
  resolveWorkspace,
  workspaceEnv,
  sharedDb,
  WORKSPACE_COOKIE,
  parseWorkspaceCookie,
  serializeWorkspaceCookie,
  requireWorkspaceMatch,
} from "./workspaces.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

// Fake D1Database — only needs a `.prepare` function for the binding-shape
// check in workspaces.ts to accept it.
function fakeD1(tag) {
  return { prepare: () => ({ tag }), _tag: tag };
}

// ── unset / empty / malformed WORKSPACES -> implicit default ───────────────

console.log("[listWorkspaces] unset/empty/malformed -> single implicit default workspace");
{
  const db = fakeD1("DB");

  const unset = listWorkspaces({ DB: db });
  assert(unset.length === 1, "unset WORKSPACES -> exactly one workspace");
  assert(unset[0].slug === "default", "unset -> slug 'default'");
  assert(unset[0].binding === "DB", "unset -> binding 'DB'");
  assert(unset[0].org === "unfoldingWord", "unset -> org defaults to unfoldingWord");
  assert(unset[0].label === "unfoldingWord", "unset -> label defaults to unfoldingWord");

  const withViewerOrg = listWorkspaces({ DB: db, VIEWER_ORG: "SomeOrg" });
  assert(withViewerOrg[0].org === "SomeOrg", "unset WORKSPACES honors VIEWER_ORG for org");
  assert(withViewerOrg[0].label === "SomeOrg", "unset WORKSPACES honors VIEWER_ORG for label");

  const empty = listWorkspaces({ DB: db, WORKSPACES: "" });
  assert(empty.length === 1 && empty[0].slug === "default", "empty string WORKSPACES -> implicit default");

  const whitespace = listWorkspaces({ DB: db, WORKSPACES: "   " });
  assert(whitespace.length === 1 && whitespace[0].slug === "default", "whitespace-only WORKSPACES -> implicit default");

  const malformed = listWorkspaces({ DB: db, WORKSPACES: "{not json" });
  assert(malformed.length === 1 && malformed[0].slug === "default", "unparseable JSON -> implicit default");

  const notArray = listWorkspaces({ DB: db, WORKSPACES: JSON.stringify({ slug: "x" }) });
  assert(notArray.length === 1 && notArray[0].slug === "default", "JSON object (not array) -> implicit default");

  const emptyArray = listWorkspaces({ DB: db, WORKSPACES: "[]" });
  assert(emptyArray.length === 1 && emptyArray[0].slug === "default", "empty array -> implicit default");
}

// ── valid multi-entry parse ─────────────────────────────────────────────────

console.log("[listWorkspaces] valid multi-entry parse");
{
  const env = {
    DB: fakeD1("DB"),
    DB_ORG2: fakeD1("DB_ORG2"),
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "unfoldingWord", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB_ORG2", exportOwner: "OrgTwoExport" },
    ]),
  };
  const list = listWorkspaces(env);
  assert(list.length === 2, "two valid entries parsed");
  assert(list[0].slug === "uw" && list[1].slug === "org2", "order preserved");
  assert(list[1].exportOwner === "OrgTwoExport", "optional exportOwner carried through");
  assert(list[0].exportOwner === undefined, "exportOwner absent when not specified");
}

// ── invalid entries dropped without throwing ────────────────────────────────

console.log("[listWorkspaces] invalid entries dropped, never throws");
{
  const realWarn = console.warn;
  console.warn = () => {}; // silence expected warnings for this block
  try {
    const env = {
      DB: fakeD1("DB"),
      DB_GOOD: fakeD1("DB_GOOD"),
      WORKSPACES: JSON.stringify([
        { slug: "Bad Slug!", label: "x", org: "x", binding: "DB" }, // bad slug
        { slug: "goodslug", label: "x", org: "not valid org!", binding: "DB" }, // bad org
        { slug: "goodslug2", label: "", org: "x", binding: "DB" }, // empty label
        { slug: "goodslug3", label: "x".repeat(65), org: "x", binding: "DB" }, // label too long
        { slug: "goodslug4", label: "x", org: "x", binding: "NOT_A_BINDING" }, // missing binding
        { slug: "goodslug5", label: "x", org: "x", binding: "DB", exportOwner: 5 }, // bad exportOwner type
        { slug: "dup", label: "first", org: "org1", binding: "DB_GOOD" },
        { slug: "dup", label: "second", org: "org2", binding: "DB_GOOD" }, // dup slug, first wins
        null,
        "not an object",
        { slug: "ok", label: "OK", org: "OkOrg", binding: "DB_GOOD" },
      ]),
    };
    const list = listWorkspaces(env);
    assert(list.length === 2, `only the two truly valid entries survive (got ${list.length})`);
    assert(list.some((w) => w.slug === "dup" && w.label === "first"), "duplicate slug: first wins");
    assert(list.some((w) => w.slug === "ok"), "valid trailing entry kept");
    assert(!list.some((w) => w.slug === "goodslug4"), "entry with unresolvable binding dropped");
  } finally {
    console.warn = realWarn;
  }

  // Every entry invalid -> falls back to the implicit workspace (never throws,
  // never returns an empty list).
  console.warn = () => {};
  try {
    const env2 = { DB: fakeD1("DB"), WORKSPACES: JSON.stringify([{ slug: "bad slug", org: "x", label: "x", binding: "DB" }]) };
    const list2 = listWorkspaces(env2);
    assert(list2.length === 1 && list2[0].slug === "default", "all-invalid entries -> implicit default fallback");
  } finally {
    console.warn = realWarn;
  }
}

// ── memoization per env object ──────────────────────────────────────────────

console.log("[listWorkspaces] slug 'default' is reserved for the implicit workspace (#502)");
{
  // The client names its IndexedDB stores by slug, and slug "default" keeps the
  // unsuffixed legacy name (web/src/sync/workspace.ts). A real org named
  // "default" would share that database with the fallback org's legacy data
  // (#228), so an explicit entry may not take the slug.
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const env = {
      DB: fakeD1("DB"),
      DB_X: fakeD1("DB_X"),
      WORKSPACES: JSON.stringify([
        { slug: "bsoj", label: "BSOJ", org: "BSOJ", binding: "DB" },
        { slug: "default", label: "Other", org: "OtherOrg", binding: "DB_X" },
      ]),
    };
    const list = listWorkspaces(env);
    assert(list.length === 1 && list[0].slug === "bsoj", "explicit 'default' entry is dropped");
  } finally {
    console.warn = realWarn;
  }
  const implicit = listWorkspaces({ DB: fakeD1("DB") });
  assert(implicit.length === 1 && implicit[0].slug === "default", "unset WORKSPACES still yields the implicit 'default'");
}

console.log("[listWorkspaces] memoized per env object (WeakMap)");
{
  const env = { DB: fakeD1("DB"), WORKSPACES: '[{"slug":"a","label":"A","org":"a","binding":"DB"}]' };
  const first = listWorkspaces(env);
  const second = listWorkspaces(env);
  assert(first === second, "same env object -> same cached array reference");

  const otherEnv = { DB: fakeD1("DB"), WORKSPACES: env.WORKSPACES };
  const third = listWorkspaces(otherEnv);
  assert(third !== first, "different env object -> independent cache entry");
}

// ── resolveWorkspace ─────────────────────────────────────────────────────────

console.log("[resolveWorkspace] exact match, else first workspace");
{
  const env = {
    DB: fakeD1("DB"),
    DB2: fakeD1("DB2"),
    WORKSPACES: JSON.stringify([
      { slug: "uw", label: "UW", org: "unfoldingWord", binding: "DB" },
      { slug: "org2", label: "Org2", org: "OrgTwo", binding: "DB2" },
    ]),
  };
  assert(resolveWorkspace(env, "org2").slug === "org2", "exact slug match resolves that workspace");
  assert(resolveWorkspace(env, "nonexistent").slug === "uw", "unknown slug falls back to the first workspace");
  assert(resolveWorkspace(env, null).slug === "uw", "null slug falls back to the first workspace");
}

// ── workspaceEnv: DB swap, SHARED_DB resolution, VIEWER_ORG/WORKSPACE_SLUG ──

console.log("[workspaceEnv] swaps DB, resolves SHARED_DB to the ORIGINAL default DB, stamps org/slug");
{
  const originalDb = fakeD1("original-DB");
  const orgDb = fakeD1("org-DB");
  const env = { DB: originalDb, VIEWER_ORG: "ShouldBeOverridden", DCS_EXPORT_OWNER: "DefaultExportOwner" };
  const ws = { slug: "org1", label: "Org One", org: "OrgOne", binding: "ORG_DB" };
  env.ORG_DB = orgDb;

  const wsEnv = workspaceEnv(env, ws);
  assert(wsEnv.DB === orgDb, "DB swapped to the workspace's binding");
  // The easy bug this guards against: SHARED_DB must resolve to the env's
  // ORIGINAL DB (the default binding), not the just-swapped-in org DB.
  assert(wsEnv.SHARED_DB === originalDb, "SHARED_DB resolves to the ORIGINAL env.DB, not the swapped-in org DB");
  assert(wsEnv.VIEWER_ORG === "OrgOne", "VIEWER_ORG set from the workspace's org");
  assert(wsEnv.WORKSPACE_SLUG === "org1", "WORKSPACE_SLUG stamped");
  assert(wsEnv.DCS_EXPORT_OWNER === "DefaultExportOwner", "DCS_EXPORT_OWNER falls back to env's when workspace has none");

  const wsWithExportOwner = { slug: "org2", label: "Org Two", org: "OrgTwo", binding: "DB", exportOwner: "CustomOwner" };
  const wsEnv2 = workspaceEnv(env, wsWithExportOwner);
  assert(wsEnv2.DCS_EXPORT_OWNER === "CustomOwner", "workspace's own exportOwner overrides env default");

  // When env already carries a SHARED_DB (e.g. workspaceEnv called twice, or
  // a caller pre-set it), workspaceEnv must not clobber it with the current DB.
  const preSetShared = fakeD1("pre-set-shared");
  const envWithShared = { DB: orgDb, SHARED_DB: preSetShared };
  const wsEnv3 = workspaceEnv(envWithShared, ws);
  assert(wsEnv3.SHARED_DB === preSetShared, "existing SHARED_DB is preserved, not overwritten");
}

console.log("[workspaceEnv] is re-entrant: resolving a second workspace from an already-swapped env");
{
  // Regression: the workspace-switch route resolves the TARGET workspace from
  // the current request's (already-swapped) env, and the first workspace's
  // binding is literally "DB". Resolving off the swapped env handed back the
  // *currently active* database instead of the target's, so switching back to
  // the first workspace looked up roles in the wrong org's D1 and demoted the
  // user to viewer.
  const defaultDb = fakeD1("default-DB");
  const otherDb = fakeD1("other-DB");
  const env = { DB: defaultDb, DB_OTHER: otherDb };
  const first = { slug: "first", label: "First", org: "First", binding: "DB" };
  const other = { slug: "other", label: "Other", org: "Other", binding: "DB_OTHER" };

  const inOther = workspaceEnv(env, other);
  assert(inOther.DB === otherDb, "first swap lands on the other workspace's DB");

  const backToFirst = workspaceEnv(inOther, first);
  assert(backToFirst.DB === defaultDb, "re-resolving the 'DB'-bound workspace from a swapped env returns the ORIGINAL DB");
  assert(backToFirst.WORKSPACE_SLUG === "first", "slug re-stamped on the second swap");
  assert(backToFirst.SHARED_DB === defaultDb, "SHARED_DB still resolves to the original default binding");
  // And a third hop must not degrade either.
  assert(workspaceEnv(backToFirst, other).DB === otherDb, "third swap still resolves from the base env");
}

// ── sharedDb ─────────────────────────────────────────────────────────────────

console.log("[sharedDb] falls back to DB when SHARED_DB unset");
{
  const db = fakeD1("DB");
  assert(sharedDb({ DB: db }) === db, "no SHARED_DB -> falls back to DB");
  const shared = fakeD1("shared");
  assert(sharedDb({ DB: db, SHARED_DB: shared }) === shared, "SHARED_DB present -> used over DB");
}

// ── cookie parse/serialize ───────────────────────────────────────────────────

console.log("[workspace cookie] parse/serialize incl. Secure and multi-cookie headers");
{
  assert(WORKSPACE_COOKIE === "be_ws", "cookie name constant");

  const noCookieHeader = new Request("http://x/", {});
  assert(parseWorkspaceCookie(noCookieHeader) === null, "no cookie header -> null");

  const noMatch = new Request("http://x/", { headers: { cookie: "other=1; another=2" } });
  assert(parseWorkspaceCookie(noMatch) === null, "cookie header without be_ws -> null");

  const single = new Request("http://x/", { headers: { cookie: "be_ws=org2" } });
  assert(parseWorkspaceCookie(single) === "org2", "single cookie parsed");

  const multi = new Request("http://x/", { headers: { cookie: "foo=bar; be_ws=org3; baz=qux" } });
  assert(parseWorkspaceCookie(multi) === "org3", "be_ws extracted among several cookies");

  const encoded = new Request("http://x/", { headers: { cookie: "be_ws=org%2Dtwo" } });
  assert(parseWorkspaceCookie(encoded) === "org-two", "URI-encoded cookie value decoded");

  // ISSUE 5 regression: a malformed percent-escape must not throw a URIError
  // out of the fetch() wrapper (which would 500 every request from that
  // browser) — treat it the same as an absent cookie.
  const malformedPercent = new Request("http://x/", { headers: { cookie: "be_ws=%" } });
  assert(parseWorkspaceCookie(malformedPercent) === null, "undecodable percent-escape -> null, does not throw");

  const insecure = serializeWorkspaceCookie("uw", false);
  assert(insecure.includes("be_ws=uw"), "serialized cookie carries the slug");
  assert(insecure.includes("Path=/"), "Path=/ present");
  assert(insecure.includes("Max-Age=31536000"), "1-year Max-Age present");
  assert(insecure.includes("SameSite=Lax"), "SameSite=Lax present");
  assert(insecure.includes("HttpOnly"), "HttpOnly present");
  assert(!insecure.includes("Secure"), "Secure absent for an insecure (http) request");

  const secure = serializeWorkspaceCookie("uw", true);
  assert(secure.includes("Secure"), "Secure present when the request is https");
}

// ── requireWorkspaceMatch (BLOCKER 2) ───────────────────────────────────────

console.log("[requireWorkspaceMatch] header matching -> passes; mismatching -> 409; absent -> passes");
{
  function buildApp() {
    const app = new Hono();
    app.use("*", requireWorkspaceMatch);
    app.get("/api/whatever", (c) => c.json({ ok: true }));
    app.get("/api/auth/me", (c) => c.json({ ok: true }));
    app.get("/api/ws/chapter/GEN/1", (c) => c.json({ ok: true }));
    return app;
  }
  const env = { WORKSPACE_SLUG: "org2" };

  const noHeader = await buildApp().request("/api/whatever", {}, env);
  assert(noHeader.status === 200, "absent X-Workspace header -> passes");

  const matching = await buildApp().request(
    "/api/whatever",
    { headers: { "x-workspace": "org2" } },
    env,
  );
  assert(matching.status === 200, "X-Workspace matching the resolved workspace -> passes");

  const mismatching = await buildApp().request(
    "/api/whatever",
    { headers: { "x-workspace": "uw" } },
    env,
  );
  assert(mismatching.status === 409, "X-Workspace mismatching the resolved workspace -> 409");
  const body = await mismatching.json();
  assert(body.error === "workspace_mismatch", "409 body carries error: workspace_mismatch");
  assert(body.expected === "org2", "409 body's `expected` is the server-resolved slug");

  // Exempt paths pass even with a mismatching header — /api/auth/* is hit by
  // fetchAuthMe()/authLogout() (which DO send X-Workspace) during the exact
  // boot-time reconciliation window this guard must not block.
  const authExempt = await buildApp().request(
    "/api/auth/me",
    { headers: { "x-workspace": "uw" } },
    env,
  );
  assert(authExempt.status === 200, "/api/auth/* exempt from the mismatch check");

  const wsExempt = await buildApp().request(
    "/api/ws/chapter/GEN/1",
    { headers: { "x-workspace": "uw" } },
    env,
  );
  assert(wsExempt.status === 200, "/api/ws/* exempt from the mismatch check");

  // WORKSPACE_SLUG unset (WORKSPACES unset) -> resolved slug is "default".
  const defaultEnv = {};
  const defaultMatch = await buildApp().request(
    "/api/whatever",
    { headers: { "x-workspace": "default" } },
    defaultEnv,
  );
  assert(defaultMatch.status === 200, "unset WORKSPACE_SLUG resolves to 'default' for the comparison");
}

console.log("workspaces: all assertions passed");
